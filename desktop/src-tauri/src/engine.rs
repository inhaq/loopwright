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
    /// All mutable sidecar state lives behind one lock so the lifecycle calls
    /// (start / restart / shutdown) are serialized end-to-end. Guarding url,
    /// token, and the child handle separately let a concurrent `restart_engine`
    /// — or a restart racing app exit — interleave: spawning a second sidecar,
    /// overwriting the stored child handle, or clearing the URL/token of a
    /// freshly-started process. A single mutex held across each operation makes
    /// them mutually exclusive.
    lifecycle: Mutex<Lifecycle>,
}

/// The mutable engine state, guarded as one unit by `EngineManager::lifecycle`.
struct Lifecycle {
    /// The engine base URL once started (e.g. "http://127.0.0.1:53187").
    url: Option<String>,
    /// The per-process bearer token the engine requires on its API.
    token: Option<String>,
    /// Handle to the spawned sidecar, used to force-kill as a last resort.
    child: Option<CommandChild>,
}

impl EngineManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            lifecycle: Mutex::new(Lifecycle {
                url: None,
                token: None,
                child: None,
            }),
        }
    }

    /// The engine base URL once started (e.g. "http://127.0.0.1:53187").
    pub fn url(&self) -> Option<String> {
        self.lifecycle.lock().unwrap().url.clone()
    }

    /// The per-process bearer token the engine requires on its API.
    pub fn token(&self) -> Option<String> {
        self.lifecycle.lock().unwrap().token.clone()
    }

    /// Spawns the sidecar and blocks until it reports its listening port.
    /// Holds the lifecycle lock for the whole operation so it cannot race
    /// another start/restart/shutdown.
    pub fn start(&self) -> Result<String, String> {
        let mut state = self.lifecycle.lock().unwrap();
        self.start_locked(&mut state)
    }

    /// Kills the running sidecar (if any) and starts a fresh one. Used after
    /// secrets change so the new values are picked up. The shutdown and the
    /// subsequent start run under a single held lock, so a second restart (or
    /// app exit) can't slip in between and spawn an extra sidecar.
    pub fn restart(&self) -> Result<String, String> {
        let mut state = self.lifecycle.lock().unwrap();
        self.shutdown_locked(&mut state);
        self.start_locked(&mut state)
    }

    /// Stops the running sidecar gracefully (see `shutdown_locked`). Holds the
    /// lifecycle lock so it serializes with any in-flight start/restart.
    pub fn shutdown(&self) {
        let mut state = self.lifecycle.lock().unwrap();
        self.shutdown_locked(&mut state);
    }

    /// Spawns the sidecar and records its URL/token/child into `state`. The
    /// caller must hold the lifecycle lock.
    fn start_locked(&self, state: &mut Lifecycle) -> Result<String, String> {
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

        state.url = Some(ready.url.clone());
        state.token = ready.token;
        state.child = Some(child);
        Ok(ready.url)
    }

    /// Stops the running sidecar gracefully: asks the engine to shut itself
    /// down over HTTP first — so it can cancel in-flight runs and kill their
    /// detached subprocess trees — and only then force-kills as a fallback.
    /// A direct `child.kill()` would orphan those detached descendants. The
    /// caller must hold the lifecycle lock.
    fn shutdown_locked(&self, state: &mut Lifecycle) {
        let child = state.child.take();
        let url = state.url.clone();
        let token = state.token.clone();

        if let Some(url) = url.as_deref() {
            request_shutdown(url, token.as_deref());
            // Wait for the engine to actually stop serving before force-killing,
            // so its graceful path (cancel runs, persist failures, clean up
            // worktrees) can finish. Bounded well above the server's grace
            // window so a wedged engine is still killed rather than hanging quit.
            wait_for_listener_close(url, Duration::from_secs(6));
        }
        if let Some(child) = child {
            // Best-effort fallback: a no-op if the engine already exited.
            let _ = child.kill();
        }

        state.url = None;
        state.token = None;
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

/// Polls the engine's loopback port until it stops accepting connections (i.e.
/// the graceful shutdown has closed the listener and the process is exiting),
/// or `timeout` elapses. On loopback a closed port refuses instantly, so this
/// returns as soon as the engine is done — typically well under the timeout.
fn wait_for_listener_close(url: &str, timeout: Duration) {
    let authority = match url.strip_prefix("http://") {
        Some(rest) => rest.split('/').next().unwrap_or(rest),
        None => return,
    };
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match TcpStream::connect(authority) {
            // Still listening: the engine hasn't finished shutting down yet.
            Ok(stream) => {
                drop(stream);
                std::thread::sleep(Duration::from_millis(100));
            }
            // Connection refused: the listener is gone and the engine is exiting.
            Err(_) => return,
        }
    }
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


#[cfg(test)]
mod tests {
    use super::{request_shutdown, wait_for_listener_close};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::{Duration, Instant};

    /// request_shutdown posts to /api/shutdown with the bearer token.
    #[test]
    fn request_shutdown_sends_authorized_post() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let url = format!("http://{addr}");

        let server = thread::spawn(move || {
            let (mut sock, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 1024];
            let n = sock.read(&mut buf).expect("read");
            // Respond so the client's read() returns promptly.
            let _ = sock.write_all(
                b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });

        request_shutdown(&url, Some("secret-token"));

        let req = server.join().expect("join");
        assert!(
            req.starts_with("POST /api/shutdown HTTP/1.1"),
            "unexpected request line: {req}"
        );
        assert!(
            req.contains("Authorization: Bearer secret-token"),
            "missing/incorrect auth header: {req}"
        );
    }

    /// request_shutdown omits the auth header when no token is known, and a bad
    /// (non-http) url is a no-op rather than a panic.
    #[test]
    fn request_shutdown_handles_no_token_and_bad_url() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let url = format!("http://{addr}");

        let server = thread::spawn(move || {
            let (mut sock, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 1024];
            let n = sock.read(&mut buf).expect("read");
            let _ = sock.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n");
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });

        request_shutdown(&url, None);
        let req = server.join().expect("join");
        assert!(!req.contains("Authorization:"), "should not send auth: {req}");

        // Non-http url must not panic or hang.
        request_shutdown("ftp://example.com", Some("t"));
    }

    /// Returns on connection refusal (does not wait out the timeout) when
    /// nothing is listening.
    #[test]
    fn wait_for_listener_close_returns_when_refused() {
        // Bind then drop to obtain a port that is no longer accepting.
        let addr = {
            let l = TcpListener::bind("127.0.0.1:0").expect("bind");
            l.local_addr().expect("addr")
        };
        let url = format!("http://{addr}");

        let start = Instant::now();
        wait_for_listener_close(&url, Duration::from_secs(5));
        // It must return on refusal rather than hang to the timeout. Windows
        // loopback refusal can take ~1s, so allow a generous margin while still
        // proving it returned well before the 5s timeout.
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "should return on connection refused, not wait out the timeout (elapsed {:?})",
            start.elapsed()
        );
    }

    /// Returns once the listener actually closes, not before.
    #[test]
    fn wait_for_listener_close_waits_for_close() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let url = format!("http://{addr}");

        let closer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            drop(listener); // stop accepting
        });

        let start = Instant::now();
        wait_for_listener_close(&url, Duration::from_secs(5));
        let elapsed = start.elapsed();
        closer.join().expect("join");

        assert!(
            elapsed >= Duration::from_millis(250),
            "should not return before the listener closes (elapsed {elapsed:?})"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "should return shortly after close, not at the timeout (elapsed {elapsed:?})"
        );
    }

    /// Respects the timeout when the listener never closes (a wedged engine).
    #[test]
    fn wait_for_listener_close_respects_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let url = format!("http://{addr}");

        let start = Instant::now();
        wait_for_listener_close(&url, Duration::from_millis(300));
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(250),
            "should wait out the timeout while still listening (elapsed {elapsed:?})"
        );
        drop(listener);
    }
}
