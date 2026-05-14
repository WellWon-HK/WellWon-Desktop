// Token storage for WellWon Desktop.
//
// Dev builds (unsigned) store the bearer token in a plain file inside
// the app's data directory (`~/Library/Application Support/
// hk.wellwon.desktop/auth.dat` on macOS). chmod 0600 so only the
// current user can read it. We DO NOT use the macOS Keychain in dev
// because unsigned apps trigger a system consent prompt on every
// access — declining the prompt then makes the token unreachable and
// the user appears "signed out" even though the credential is still
// in the Keychain. File storage avoids the prompt entirely.
//
// Once we ship a code-signed `.app` (Phase 6 polish) we can switch
// the backend to `keyring` again — signed apps get a persistent ACL
// and never re-prompt after the first save.

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const TOKEN_FILE: &str = "auth.dat";

fn token_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {dir:?}: {e}"))?;
    Ok(dir.join(TOKEN_FILE))
}

#[cfg(unix)]
fn lock_perms(path: &PathBuf) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn lock_perms(_path: &PathBuf) -> std::io::Result<()> {
    // Windows: NTFS ACLs default to "current user only" inside
    // %APPDATA%, no extra step needed for the dev MVP.
    Ok(())
}

#[tauri::command]
pub fn save_desktop_token(app: AppHandle, token: String) -> Result<(), String> {
    let path = token_path(&app)?;
    fs::write(&path, token.as_bytes()).map_err(|e| format!("write {path:?}: {e}"))?;
    lock_perms(&path).map_err(|e| format!("chmod {path:?}: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn get_desktop_token(app: AppHandle) -> Result<Option<String>, String> {
    let path = token_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(s) => {
            let t = s.trim().to_string();
            if t.is_empty() {
                Ok(None)
            } else {
                Ok(Some(t))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {path:?}: {e}")),
    }
}

#[tauri::command]
pub fn delete_desktop_token(app: AppHandle) -> Result<(), String> {
    let path = token_path(&app)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {path:?}: {e}")),
    }
}
