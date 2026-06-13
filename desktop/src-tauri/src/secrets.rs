//! Secure secret storage (Task 26).
//!
//! Runner API keys are kept in the OS keychain via the `keyring` crate, never
//! written to disk in plaintext. Because keychains do not offer portable
//! enumeration, the *names* of stored keys are tracked in a small index file in
//! the app config directory; the secret values themselves only ever live in the
//! keychain. Keys are surfaced to the engine by injecting them into the
//! sidecar's environment (see `engine.rs`), so a runner profile's `apiKeyEnv`
//! reference resolves at run time.

use std::fs;
use std::path::PathBuf;

use keyring::Entry;
use tauri::{AppHandle, Manager};

/// Keychain service namespace for all Loopwright secrets.
const SERVICE: &str = "dev.loopwright.desktop";

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets-index.json"))
}

fn read_index(app: &AppHandle) -> Result<Vec<String>, String> {
    match fs::read_to_string(index_path(app)?) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        // A missing index is the normal "no secrets yet" case; any other error
        // (permissions, I/O) must surface rather than masquerade as an empty
        // list, which would silently drop tracked keys on the next write.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Rejects empty/reserved/invalid secret names. Keys become environment
/// variables in the engine sidecar, so they must be valid env-var identifiers
/// and must not shadow Loopwright's own `LOOPWRIGHT_*` wiring (port, db path).
fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("secret key cannot be empty".to_string());
    }
    if key.starts_with("LOOPWRIGHT_") {
        return Err("secret key cannot use the reserved LOOPWRIGHT_ prefix".to_string());
    }
    let mut chars = key.chars();
    let first_ok = chars
        .next()
        .map(|c| c == '_' || c.is_ascii_alphabetic())
        .unwrap_or(false);
    let rest_ok = key.chars().all(|c| c == '_' || c.is_ascii_alphanumeric());
    if !first_ok || !rest_ok {
        return Err(format!(
            "secret key \"{key}\" is not a valid environment variable name"
        ));
    }
    Ok(())
}

fn write_index(app: &AppHandle, keys: &[String]) -> Result<(), String> {
    let json = serde_json::to_string(keys).map_err(|e| e.to_string())?;
    fs::write(index_path(app)?, json).map_err(|e| e.to_string())
}

/// Names of every stored secret (no values).
pub fn list_keys(app: &AppHandle) -> Result<Vec<String>, String> {
    read_index(app)
}

/// Stores (or replaces) a secret in the keychain and records its name.
pub fn set(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    validate_key(key)?;
    let entry = Entry::new(SERVICE, key).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())?;
    let mut keys = read_index(app)?;
    if !keys.iter().any(|k| k == key) {
        keys.push(key.to_string());
        write_index(app, &keys)?;
    }
    Ok(())
}

/// Removes a secret from the keychain and the index. Idempotent.
pub fn delete(app: &AppHandle, key: &str) -> Result<(), String> {
    if let Ok(entry) = Entry::new(SERVICE, key) {
        // Ignore "no such entry" so repeated deletes don't error.
        let _ = entry.delete_credential();
    }
    let mut keys = read_index(app)?;
    keys.retain(|k| k != key);
    write_index(app, &keys)
}

/// Resolves all stored secrets to (name, value) pairs for env injection.
/// Names whose keychain value has gone missing are silently skipped.
pub fn all(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for key in read_index(app)? {
        if let Ok(entry) = Entry::new(SERVICE, &key) {
            if let Ok(value) = entry.get_password() {
                out.push((key, value));
            }
        }
    }
    Ok(out)
}
