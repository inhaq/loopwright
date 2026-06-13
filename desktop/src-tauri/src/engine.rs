//! Engine sidecar lifecycle (Task 25.2).
//!
//! The headless engine ships as a compiled Node binary (see
//! `scripts/build-sidecar.mjs`) and runs as a Tauri sidecar. This module spawns
//! it on a loopback ephemeral port, reads the single JSON readiness line it
//! prints to discover that port, and exposes the resulting base URL to the
//! frontend. Stored secrets are injected into the sidecar's environment so the
//! engine's runner profiles can reference API keys by env-var name without any
//! secret crossing into the webview or onto disk in plaintext.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::secrets;

/// Sidecar program name; must match `bundle.externalBin` in tauri.conf.json
/// and the scoped name in capabilities/default.json.
const SIDECAR: &str = "binaries/loopwright-engine";

/// How long to wait for the engine to announce its port before giving up.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

pub struct EngineManager {
    app: AppHandle,
    url: Mutex<Option<String>>,
    token: Mutex<Option<String>>,
    child: Mutex<Option<CommandChild>>,
}

impl EngineManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            url: Mutex::new(None),
            token: Mutex::new(None),
            child: Mutex::new(None),
        }
    }

    /// The engine base URL once started (e.g. "http://127.0.0.1:53187").
    pub fn url(&self) -> Option<String> {
        self.url.lock().unwrap().clone()
    }

    /// The per-process bearer token the engine requires on its API.
    pub fn token(&self) -> Option<String> {
        self.token.lock().unwrap().clone()
    }

    /// Spawns the sidecar and blocks until it reports its listening port.
    pub fn start(&self) -> Result<String, String> {
        let data_dir = self.app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let db_path = data_dir.join("sessions.json");

        let mut envs: HashMap<String, String> = HashMap::new();
        envs.insert("LOOPWRIGHT_HOST".into(), "127.0.0.1".into());
        envs.insert("LOOPWRIGHT_PORT".into(), "0".into()); // ephemeral
        envs.insert(
            "LOOPWRIGHT_DB_PATH".into(),
            db_path.to_string_lossy().to_string(),
        );
        // Inject stored API keys so runner `apiKeyEnv` bindings resolve.
        for (k, v) in secrets::all(&self.app)? {
            envs.insert(k, v);
        }

        let (mut rx, child) = self
            .app
            .shell()
            .sidecar(SIDECAR)
            .map_err(|e| e.to_string())?
            .envs(envs)
            .spawn()
            .map_err(|e| e.to_string())?;

        let ready = match tauri::async_runtime::block_on(read_ready(&mut rx)) {
            Ok(ready) => ready,
            Err(e) => {
                // Readiness failed (bad output or timeout): don't leak the
                // spawned process — kill it before surfacing the error.
                let _ = child.kill();
                return Err(e);
            }
        };

        // Keep draining events so a full stdout/stderr pipe can't stall the
        // engine during a long run.
        tauri::async_runtime::spawn(async move { while rx.recv().await.is_some() {} });

        *self.url.lock().unwrap() = Some(ready.url.clone());
        *self.token.lock().unwrap() = ready.token;
        *self.child.lock().unwrap() = Some(child);
        Ok(ready.url)
    }

    /// Kills the running sidecar (if any) and starts a fresh one. Used after
    /// secrets change so the new values are picked up.
    pub fn restart(&self) -> Result<String, String> {
        self.shutdown();
        self.start()
    }

    /// Stops the running sidecar gracefully: asks the engine to shut itself
    /// down over HTTP first — so it can cancel in-flight runs and kill their
    /// detached subprocess trees — and only then force-kills as a fallback.
    /// A direct `child.kill()` would orphan those detached descendants.
    pub fn shutdown(&self) {
        let child = self.child.lock().unwrap().take();
        let url = self.url.lock().unwrap().clone();
        let token = self.token.lock().unwrap().clone();

        if let Some(url) = url.as_deref() {
            request_shutdown(url, token.as_deref());
        }
        // Give the engine a brief moment to act on the request and exit on its
        // own before we force-kill.
        if child.is_some() {
            std::thread::sleep(Duration::from_millis(400));
        }
        if let Some(child) = child {
            // Best-effort fallback: a no-op if the engine already exited.
            let _ = child.kill();
        }

        *self.url.lock().unwrap() = None;
        *self.token.lock().unwrap() = None;
    }
}

/// Sends a best-effort `POST /api/shutdown` to the engine over loopback so it
/// can tear itself down gracefully. Uses a raw, short-lived TCP request to
/// avoid pulling in an HTTP client dependency for a single local call; all
/// errors are ignored because `shutdown()` force-kills as a fallback.
fn request_shutdown(url: &str, token: Option<&str>) {
    // url looks like "http://127.0.0.1:53187"; reduce it to "host:port".
    let authority = match url.strip_prefix("http://") {
        Some(rest) => rest.split('/').next().unwrap_or(rest),
        None => return,
    };

    let mut stream = match TcpStream::connect(authority) {
        Ok(s) => s,
        Err(_) => return,
    };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));

    let auth_line = match token {
        Some(t) => format!("Authorization: Bearer {t}\r\n"),
        None => String::new(),
    };
    let req = format!(
        "POST /api/shutdown HTTP/1.1\r\nHost: {authority}\r\n{auth_line}\
Content-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(req.as_bytes());
    let _ = stream.flush();
    // Read (and discard) the response so we wait for the server to acknowledge
    // before returning; the connection closing also signals it has begun.
    let mut buf = [0u8; 256];
    let _ = stream.read(&mut buf);
}

/// The engine's startup handshake: where to reach it and the token to use.
struct Ready {
    url: String,
    token: Option<String>,
}

/// Reads sidecar output until the readiness line is seen, then returns it.
async fn read_ready(rx: &mut Receiver<CommandEvent>) -> Result<Ready, String> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let mut buf = String::new();

    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| "engine did not report a listening port in time".to_string())?;

        let event = match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(ev) => ev,
            Err(_) => return Err("timed out waiting for engine to start".to_string()),
        };

        match event {
            Some(CommandEvent::Stdout(bytes)) | Some(CommandEvent::Stderr(bytes)) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if let Some(ready) = parse_ready(&buf) {
                    return Ok(ready);
                }
            }
            Some(CommandEvent::Error(e)) => return Err(format!("engine error: {e}")),
            Some(CommandEvent::Terminated(_)) => {
                return Err("engine exited before reporting a port".to_string())
            }
            None => return Err("engine output closed before reporting a port".to_string()),
            _ => {}
        }
    }
}

/// Scans accumulated output for the `{"loopwright":"listening",...}` line.
fn parse_ready(buf: &str) -> Option<Ready> {
    for line in buf.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v.get("loopwright").and_then(|x| x.as_str()) == Some("listening") {
                let host = v
                    .get("host")
                    .and_then(|x| x.as_str())
                    .unwrap_or("127.0.0.1");
                let port = v.get("port").and_then(|x| x.as_u64())?;
                let token = v.get("token").and_then(|x| x.as_str()).map(str::to_string);
                return Some(Ready {
                    url: format!("http://{host}:{port}"),
                    token,
                });
            }
        }
    }
    None
}
