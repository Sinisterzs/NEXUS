//! Desktop `nexus://` deep-link registration and single-instance handoff for password recovery.
//!
//! Security rules:
//! - Recovery tokens are single-use secrets: they are NEVER logged to stdout/stderr or persisted
//!   to SQLite/disk.
//! - Only `nexus://` URLs targeting `reset-password` with a well-formed token are accepted.
//! - When NEXUS is already open, a newly spawned `nexus.exe "nexus://reset-password?token=..."`
//!   forwards the token over authenticated `127.0.0.1` loopback IPC to the running instance,
//!   which focuses the main window and emits `"nexus://password-reset-token"` to the UI.

use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const DEEP_LINK_RESET_EVENT: &str = "nexus://password-reset-token";
const MAX_TOKEN_LEN: usize = 256;
const MIN_TOKEN_LEN: usize = 6;

static PENDING_RESET_TOKEN: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn is_valid_token_format(s: &str) -> bool {
    let len = s.len();
    (MIN_TOKEN_LEN..=MAX_TOKEN_LEN).contains(&len)
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'+' | b'-'))
}

/// Extracts and validates a password reset token from a `nexus://` deep-link argument.
/// Accepts `nexus://reset-password?token=...` and `nexus://reset-password#token=...`
/// (including Windows shell-quoted `"nexus://..."` arguments).
/// Never logs the input or the token.
pub fn extract_deep_link_reset_token(raw_arg: &str) -> Option<String> {
    let trimmed = raw_arg
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim();
    if trimmed.len() > 1024 {
        return None;
    }
    if !trimmed.to_ascii_lowercase().starts_with("nexus://") {
        return None;
    }

    let parsed = url::Url::parse(trimmed).ok()?;
    if !parsed.scheme().eq_ignore_ascii_case("nexus") {
        return None;
    }

    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let path = parsed.path().trim_matches('/').to_ascii_lowercase();
    let is_reset_target = host == "reset-password"
        || host == "password-reset"
        || path == "reset-password"
        || path == "password-reset"
        || (host == "auth" && (path == "reset-password" || path == "password/reset"));

    if !is_reset_target {
        return None;
    }

    let from_query = parsed
        .query_pairs()
        .find(|(k, _)| k.eq_ignore_ascii_case("token"))
        .map(|(_, v)| v.into_owned());

    let from_fragment = parsed.fragment().and_then(|frag| {
        url::form_urlencoded::parse(frag.as_bytes())
            .find(|(k, _)| k.eq_ignore_ascii_case("token"))
            .map(|(_, v)| v.into_owned())
    });

    let candidate = from_query.or(from_fragment)?;
    let clean = candidate.trim().to_string();
    if is_valid_token_format(&clean) {
        Some(clean)
    } else {
        None
    }
}

/// Scans command-line arguments for a `nexus://reset-password?token=...` deep link.
pub fn capture_startup_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for arg in args {
        if let Some(tok) = extract_deep_link_reset_token(arg.as_ref()) {
            return Some(tok);
        }
    }
    None
}

/// Stores a pending reset token in volatile memory (never written to disk).
pub fn set_pending_reset_token(token: Option<String>) {
    let clean = token
        .map(|t| t.trim().to_string())
        .filter(|t| is_valid_token_format(t));
    let lock = PENDING_RESET_TOKEN.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = lock.lock() {
        *guard = clean;
    }
}

/// Atomically takes and clears the pending reset token in memory.
pub fn take_pending_reset_token() -> Option<String> {
    let lock = PENDING_RESET_TOKEN.get_or_init(|| Mutex::new(None));
    lock.lock().ok().and_then(|mut guard| guard.take())
}

#[derive(Serialize, Deserialize)]
struct DeepLinkIpcConfig {
    port: u16,
    secret: String,
}

#[derive(Serialize, Deserialize)]
struct DeepLinkIpcPayload {
    secret: String,
    token: String,
}

fn ipc_config_path() -> Option<PathBuf> {
    if crate::is_test_environment() || crate::lab::enabled() {
        return None;
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::temp_dir().parent().map(|p| p.to_path_buf()))?;
    Some(base.join("com.nexus.desktop").join("deeplink-ipc.json"))
}

/// Attempts to forward a deep-link reset token to an already-running NEXUS instance over loopback.
/// Returns `true` if the running instance accepted the token and focused its window.
pub fn try_forward_to_running_instance(token: &str) -> bool {
    if crate::is_test_environment() || crate::lab::enabled() {
        return false;
    }
    if !is_valid_token_format(token) {
        return false;
    }
    let path = match ipc_config_path() {
        Some(p) => p,
        None => return false,
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let cfg: DeepLinkIpcConfig = match serde_json::from_str::<DeepLinkIpcConfig>(&raw) {
        Ok(c) if c.port > 0 && c.secret.len() == 64 => c,
        _ => return false,
    };

    let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(450)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(450)));
    let _ = stream.set_read_timeout(Some(Duration::from_millis(450)));

    let payload = DeepLinkIpcPayload {
        secret: cfg.secret,
        token: token.to_string(),
    };
    let line = match serde_json::to_string(&payload) {
        Ok(s) => format!("{}\n", s),
        Err(_) => return false,
    };
    if stream.write_all(line.as_bytes()).is_err() || stream.flush().is_err() {
        return false;
    }

    let mut reader = BufReader::new(stream);
    let mut resp = String::new();
    if reader.read_line(&mut resp).is_ok() && resp.trim() == "OK" {
        return true;
    }
    false
}

/// Starts the loopback IPC listener so that deep links clicked while NEXUS is already open
/// focus the existing window and deliver the token directly to the UI.
pub fn start_ipc_listener<R: Runtime>(app: AppHandle<R>) {
    if crate::is_test_environment() || crate::lab::enabled() {
        return;
    }
    let path = match ipc_config_path() {
        Some(p) => p,
        None => return,
    };
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(_) => return,
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(_) => return,
    };

    let mut secret_bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut secret_bytes);
    let secret = hex::encode(secret_bytes);

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let cfg = DeepLinkIpcConfig {
        port,
        secret: secret.clone(),
    };
    if let Ok(json) = serde_json::to_string(&cfg) {
        let _ = std::fs::write(&path, json);
    }

    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            let mut stream = match incoming {
                Ok(s) => s,
                Err(_) => continue,
            };
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

            let mut line = String::new();
            {
                let mut reader = BufReader::new(&mut stream);
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
            }
            let payload: DeepLinkIpcPayload = match serde_json::from_str(line.trim()) {
                Ok(p) => p,
                Err(_) => continue,
            };
            if payload.secret != secret || !is_valid_token_format(payload.token.trim()) {
                continue;
            }

            let clean_token = payload.token.trim().to_string();
            set_pending_reset_token(Some(clean_token.clone()));

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
            let _ = app.emit(DEEP_LINK_RESET_EVENT, clean_token);
            let _ = stream.write_all(b"OK\n");
            let _ = stream.flush();
        }
    });
}

/// Registers the `nexus://` custom URI protocol under `HKCU\Software\Classes\nexus` on Windows.
/// - Never touches `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\nexus`.
/// - Skipped completely in unit tests and lab mode.
pub fn ensure_windows_protocol_registered() {
    if crate::is_test_environment() || crate::lab::enabled() {
        return;
    }

    #[cfg(target_os = "windows")]
    {
        std::thread::spawn(|| {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;

            let exe_path = match std::env::current_exe() {
                Ok(p) => p,
                Err(_) => return,
            };
            let exe_str = exe_path.to_string_lossy();
            if exe_str.is_empty() {
                return;
            }

            let icon_val = format!("\"{}\",0", exe_str);
            let cmd_val = format!("\"{}\" \"%1\"", exe_str);

            let commands: &[(&str, Option<&str>, &str)] = &[
                (r"HKCU\Software\Classes\nexus", None, "URL:NEXUS Protocol"),
                (r"HKCU\Software\Classes\nexus", Some("URL Protocol"), ""),
                (r"HKCU\Software\Classes\nexus\DefaultIcon", None, &icon_val),
                (
                    r"HKCU\Software\Classes\nexus\shell\open\command",
                    None,
                    &cmd_val,
                ),
            ];

            for (key, value_name, data) in commands {
                let mut cmd = std::process::Command::new("reg.exe");
                cmd.arg("add").arg(key);
                match value_name {
                    Some(vn) => {
                        cmd.arg("/v").arg(vn);
                    }
                    None => {
                        cmd.arg("/ve");
                    }
                }
                cmd.arg("/t")
                    .arg("REG_SZ")
                    .arg("/d")
                    .arg(data)
                    .arg("/f")
                    .creation_flags(CREATE_NO_WINDOW);
                let _ = cmd.output();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_deep_link_reset_token_accepts_valid_nexus_links() {
        let hex64 = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

        assert_eq!(
            extract_deep_link_reset_token(&format!("nexus://reset-password?token={}", hex64)),
            Some(hex64.to_string())
        );
        assert_eq!(
            extract_deep_link_reset_token(&format!("nexus://reset-password/#token={}", hex64)),
            Some(hex64.to_string())
        );
        assert_eq!(
            extract_deep_link_reset_token(&format!("\"nexus://reset-password?token={}\"", hex64)),
            Some(hex64.to_string())
        );
        assert_eq!(
            extract_deep_link_reset_token(&format!(
                "nexus://auth/reset-password?utm=mail&token={}",
                hex64
            )),
            Some(hex64.to_string())
        );
    }

    #[test]
    fn test_extract_deep_link_reset_token_rejects_invalid_or_adversarial_links() {
        let hex64 = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

        // Non-nexus schemes rejected by deep-link CLI parser
        assert_eq!(
            extract_deep_link_reset_token(&format!(
                "https://nexus-api.dynv6.net/reset-password?token={}",
                hex64
            )),
            None
        );
        assert_eq!(
            extract_deep_link_reset_token("javascript:alert(1)"),
            None
        );
        // Unrelated nexus:// route rejected
        assert_eq!(
            extract_deep_link_reset_token(&format!("nexus://settings?token={}", hex64)),
            None
        );
        // Missing or too short token
        assert_eq!(extract_deep_link_reset_token("nexus://reset-password"), None);
        assert_eq!(
            extract_deep_link_reset_token("nexus://reset-password?token=123"),
            None
        );
        // Injection characters rejected
        assert_eq!(
            extract_deep_link_reset_token(
                "nexus://reset-password?token=abc123<script>alert(1)</script>"
            ),
            None
        );
    }

    #[test]
    fn test_capture_startup_args_and_pending_token_single_consumption() {
        let hex64 = "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f";
        let args = vec![
            "C:\\Users\\user\\AppData\\Local\\nexus\\nexus.exe".to_string(),
            "--flag".to_string(),
            format!("nexus://reset-password?token={}", hex64),
        ];

        let captured = capture_startup_args(&args);
        assert_eq!(captured.as_deref(), Some(hex64));

        set_pending_reset_token(captured);
        assert_eq!(take_pending_reset_token().as_deref(), Some(hex64));
        // Second call returns None (single consumption)
        assert_eq!(take_pending_reset_token(), None);
    }
}
