//! Repository selection + local environment checks (desktop only).
//!
//! These commands back the Start screen's "select a repo" flow and the provider
//! onboarding panel: a native folder picker, a fast "is this a git repo?" probe,
//! and detection of which coding/CLI tools are installed. They run in the
//! trusted Rust shell (not the webview) so they can touch the filesystem and
//! PATH directly; the engine still re-validates a selected repo server-side
//! before a run starts.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Opens the native folder picker and returns the chosen absolute path (or
/// `None` if the user cancelled). Blocking is fine here: Tauri runs command
/// handlers off the main thread, and the picker is modal by design.
#[tauri::command]
pub fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

/// True when `path` is inside a git working tree. Mirrors the engine's
/// `isGitRepo` so the UI can validate a selection before a run is started.
#[tauri::command]
pub fn check_git_repo(path: String) -> bool {
    Command::new("git")
        .args(["-C", &path, "rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// For each requested tool name, reports whether it is found on PATH. Used by
/// the provider-onboarding panel to show "installed / missing" for tools like
/// `codex`, `kiro`, and `gh`.
#[tauri::command]
pub fn which_commands(names: Vec<String>) -> HashMap<String, bool> {
    names
        .into_iter()
        .map(|n| {
            let found = is_on_path(&n);
            (n, found)
        })
        .collect()
}

/// Resolves whether `name` exists as an executable on PATH, without running it.
/// On Windows it also tries the usual executable extensions (PATHEXT).
fn is_on_path(name: &str) -> bool {
    // An explicit path (contains a separator) is checked directly.
    if name.contains('/') || name.contains('\\') {
        return is_executable(Path::new(name));
    }
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string())
            .split(';')
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&paths) {
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if is_executable(&candidate) {
                return true;
            }
        }
    }
    false
}

/// True when `path` is a regular file that is actually executable. On Unix a
/// plain readable file on PATH is not runnable, so we check the exec bits;
/// elsewhere (Windows) file existence plus a PATHEXT extension is sufficient.
fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.is_file() && (m.permissions().mode() & 0o111) != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}
