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
    child: Mutex<Option<CommandChild>>,
}

impl EngineManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            url: Mutex::new(None),
            child: Mutex::new(None),
        }
    }

    /// The engine base URL once started (e.g. "http://127.0.0.1:53187").
    pub fn url(&self) -> Option<String> {
        self.url.lock().unwrap().clone()
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

        let url = tauri::async_runtime::block_on(read_listening_url(&mut rx))?;

        // Keep draining events so a full stdout/stderr pipe can't stall the
        // engine during a long run.
        tauri::async_runtime::spawn(async move { while rx.recv().await.is_some() {} });

        *self.url.lock().unwrap() = Some(url.clone());
        *self.child.lock().unwrap() = Some(child);
        Ok(url)
    }

    /// Kills the running sidecar (if any) and starts a fresh one. Used after
    /// secrets change so the new values are picked up.
    pub fn restart(&self) -> Result<String, String> {
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        *self.url.lock().unwrap() = None;
        self.start()
    }
}

/// Reads sidecar output until the readiness line is seen, then returns the URL.
async fn read_listening_url(rx: &mut Receiver<CommandEvent>) -> Result<String, String> {
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
                if let Some(url) = parse_listening(&buf) {
                    return Ok(url);
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
fn parse_listening(buf: &str) -> Option<String> {
    for line in buf.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v.get("loopwright").and_then(|x| x.as_str()) == Some("listening") {
                let host = v.get("host").and_then(|x| x.as_str()).unwrap_or("127.0.0.1");
                let port = v.get("port").and_then(|x| x.as_u64())?;
                return Some(format!("http://{host}:{port}"));
            }
        }
    }
    None
}
