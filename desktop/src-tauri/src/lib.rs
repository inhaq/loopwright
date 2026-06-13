//! Loopwright desktop shell (Milestone 6).
//!
//! A thin Tauri wrapper around the headless engine: it runs the engine as a
//! sidecar process and hosts the web frontend. All loop orchestration stays in
//! the engine (Req 13.3); this layer only manages the sidecar's lifecycle and
//! the OS-keychain secret storage the engine consumes via its environment.

mod engine;
mod secrets;

use engine::EngineManager;
use tauri::Manager;

/// Returns the running engine's base URL for the frontend to call.
#[tauri::command]
fn engine_url(state: tauri::State<EngineManager>) -> Result<String, String> {
    state.url().ok_or_else(|| "engine not started".to_string())
}

/// Returns the per-process bearer token the engine API requires.
#[tauri::command]
fn engine_token(state: tauri::State<EngineManager>) -> Result<String, String> {
    state
        .token()
        .ok_or_else(|| "engine not started".to_string())
}

/// Restarts the engine sidecar (e.g. after secrets change) and returns its URL.
#[tauri::command]
fn restart_engine(state: tauri::State<EngineManager>) -> Result<String, String> {
    state.restart()
}

#[tauri::command]
fn set_secret(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    secrets::set(&app, &key, &value)
}

#[tauri::command]
fn delete_secret(app: tauri::AppHandle, key: String) -> Result<(), String> {
    secrets::delete(&app, &key)
}

#[tauri::command]
fn list_secret_keys(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    secrets::list_keys(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Start the engine sidecar up front so the UI has an endpoint as
            // soon as it loads. A startup failure aborts the app with a clear
            // error rather than leaving a dead UI.
            let manager = EngineManager::new(app.handle().clone());
            manager
                .start()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            app.manage(manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_url,
            engine_token,
            restart_engine,
            set_secret,
            delete_secret,
            list_secret_keys
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    // Gracefully stop the engine sidecar when the app is exiting so it can
    // cancel in-flight runs and kill their detached subprocess trees, instead
    // of being orphaned by an abrupt process teardown.
    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
            if let Some(manager) = app_handle.try_state::<EngineManager>() {
                manager.shutdown();
            }
        }
    });
}
