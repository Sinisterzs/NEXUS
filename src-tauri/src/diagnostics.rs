//! Opt-in transport. Session credentials never leave Rust or enter diagnostic payloads.
use serde_json::{json, Value};
use std::{sync::Mutex, time::Instant};
use tauri::Emitter;
use tauri::Manager;
#[path = "../../shared/diagnostics.rs"]
pub mod wire;
pub struct Permit {
    owner: String,
    revision: uuid::Uuid,
    permissions: wire::Consent,
    until: Instant,
}
static CONSENT_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static PERMIT: Mutex<Option<Permit>> = Mutex::new(None);
static CONSENT_REQUEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub fn reset() {
    CONSENT_EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    *PERMIT.lock().unwrap() = None;
}
pub fn enabled(kind: wire::Kind) -> bool {
    if !env!("CARGO_PKG_VERSION").contains("-nightly.") {
        return false;
    }
    let permit = PERMIT.lock().unwrap();
    permit.as_ref().is_some_and(|p| {
        p.until > Instant::now()
            && Some(p.owner.clone()) == crate::auth::get_active_user_id()
            && match kind {
                wire::Kind::P2p => p.permissions.p2p,
                wire::Kind::Color => p.permissions.color,
                wire::Kind::Synthetic => p.permissions.synthetic,
            }
    })
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "diagnostics_client_unavailable".into())
}
async fn request(
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    let base = crate::auth::get_api_base();
    let url = url::Url::parse(&base).map_err(|_| "diagnostics_tls_required")?;
    let loopback =
        cfg!(debug_assertions) && [Some("127.0.0.1"), Some("localhost")].contains(&url.host_str());
    if url.scheme() != "https" && !loopback {
        return Err("diagnostics_tls_required".into());
    }
    let token = crate::auth::get_secure_token().ok_or("diagnostics_auth_required")?;
    let mut req = client()?
        .request(method, format!("{base}/v1/diagnostics{path}"))
        .bearer_auth(token);
    if let Some(body) = body {
        req = req.json(body);
    }
    let response = req
        .send()
        .await
        .map_err(|_| "diagnostics_network_unavailable")?;
    if !response.status().is_success() {
        return Err(format!("diagnostics_http_{}", response.status().as_u16()));
    }
    response
        .json()
        .await
        .map_err(|_| "diagnostics_invalid_response".into())
}
#[tauri::command]
pub async fn diagnostics_consent(permissions: wire::Consent) -> Result<Value, String> {
    // Revoke synchronously before any network operation, including failed requests.
    reset();
    if !env!("CARGO_PKG_VERSION").contains("-nightly.") {
        return Err("diagnostics_nightly_required".into());
    }
    let epoch = CONSENT_EPOCH.load(std::sync::atomic::Ordering::SeqCst);
    let owner = crate::auth::get_active_user_id().ok_or("diagnostics_auth_required")?;
    let _serial = CONSENT_REQUEST.lock().await;
    if epoch != CONSENT_EPOCH.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("diagnostics_consent_changed".into());
    }
    let receipt = request(
        reqwest::Method::PUT,
        "/consent",
        Some(&serde_json::to_value(&permissions).unwrap()),
    )
    .await?;
    if crate::auth::get_active_user_id().as_ref() != Some(&owner) {
        return Err("diagnostics_account_changed".into());
    }
    let revision = receipt["revision"]
        .as_str()
        .and_then(|v| v.parse().ok())
        .ok_or("diagnostics_invalid_receipt")?;
    let mut permit = PERMIT.lock().unwrap();
    if epoch != CONSENT_EPOCH.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("diagnostics_consent_changed".into());
    }
    *permit = Some(Permit {
        owner,
        revision,
        permissions,
        until: Instant::now() + std::time::Duration::from_secs(13 * 60),
    });
    Ok(receipt)
}
#[tauri::command]
pub fn diagnostics_stop(app: tauri::AppHandle, purge: bool) {
    reset();
    if purge {
        if let Ok(path) = queue_path(&app) {
            let _ = std::fs::remove_file(path);
        }
    }
}
fn queue_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use sha2::{Digest, Sha256};
    let owner = crate::auth::get_active_user_id().ok_or("diagnostics_auth_required")?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "diagnostics_storage_unavailable")?
        .join("diagnostics-outbox");
    std::fs::create_dir_all(&directory).map_err(|_| "diagnostics_storage_unavailable")?;
    let key = format!(
        "{:x}",
        Sha256::digest(format!("{}:{owner}", crate::auth::get_api_base()).as_bytes())
    );
    Ok(directory.join(format!("{key}.json")))
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Outbox {
    created: u64,
    events: Vec<wire::Event>,
}
#[tauri::command]
pub fn diagnostics_save_queue(
    app: tauri::AppHandle,
    events: Vec<wire::Event>,
) -> Result<(), String> {
    let epoch = CONSENT_EPOCH.load(std::sync::atomic::Ordering::SeqCst);
    if events.len() > 96 || events.iter().any(|e| !e.validate() || !enabled(e.kind)) {
        return Err("diagnostics_invalid_queue".into());
    }
    let path = queue_path(&app)?;
    if events.is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    let created = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let bytes =
        serde_json::to_vec(&Outbox { created, events }).map_err(|_| "diagnostics_invalid_queue")?;
    let permit = PERMIT.lock().unwrap();
    if epoch != CONSENT_EPOCH.load(std::sync::atomic::Ordering::SeqCst)
        || permit.as_ref().is_none_or(|p| {
            p.until <= Instant::now() || Some(p.owner.clone()) != crate::auth::get_active_user_id()
        })
    {
        return Err("diagnostics_disabled".into());
    }
    let temporary = path.with_extension("pending");
    std::fs::write(&temporary, bytes)
        .and_then(|_| std::fs::rename(temporary, path))
        .map_err(|_| "diagnostics_storage_unavailable".into())
}
#[tauri::command]
pub fn diagnostics_load_queue(app: tauri::AppHandle) -> Result<Vec<wire::Event>, String> {
    if ![wire::Kind::P2p, wire::Kind::Color, wire::Kind::Synthetic]
        .iter()
        .any(|k| enabled(*k))
    {
        return Err("diagnostics_disabled".into());
    }
    let path = queue_path(&app)?;
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(Vec::new());
    };
    if bytes.len() > 800000 {
        let _ = std::fs::remove_file(&path);
        return Ok(Vec::new());
    }
    let Ok(outbox) = serde_json::from_slice::<Outbox>(&bytes) else {
        return Ok(Vec::new());
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if now.saturating_sub(outbox.created) > 900 {
        let _ = std::fs::remove_file(&path);
        return Ok(Vec::new());
    }
    Ok(outbox
        .events
        .into_iter()
        .take(96)
        .filter(|e| e.validate() && enabled(e.kind))
        .collect())
}
#[tauri::command]
pub async fn diagnostics_context() -> Result<Value, String> {
    if ![wire::Kind::P2p, wire::Kind::Color, wire::Kind::Synthetic]
        .iter()
        .any(|k| enabled(*k))
    {
        return Err("diagnostics_disabled".into());
    }
    request(reqwest::Method::POST, "/context", None).await
}
#[tauri::command]
pub async fn diagnostics_send(batch: wire::Batch) -> Result<Value, String> {
    {
        let permit = PERMIT.lock().unwrap();
        let p = permit.as_ref().ok_or("diagnostics_disabled")?;
        if p.revision != batch.consent_revision {
            return Err("diagnostics_consent_changed".into());
        }
    }
    if batch.events.is_empty()
        || batch.events.len() > 24
        || batch
            .events
            .iter()
            .any(|e| !e.validate() || !enabled(e.kind))
    {
        return Err("diagnostics_invalid_batch".into());
    }
    request(
        reqwest::Method::POST,
        "/events",
        Some(&serde_json::to_value(batch).unwrap()),
    )
    .await
}
pub fn color_failure(app: &tauri::AppHandle, stage: &str, code: Option<u32>) {
    if !enabled(wire::Kind::P2p) && !enabled(wire::Kind::Color) {
        return;
    }
    use sha2::{Digest, Sha256};
    let token = format!("{:x}", Sha256::digest(uuid::Uuid::new_v4().as_bytes()));
    let snapshot = json!({"offerToken":token,"stage":stage,"result":"failed","errorCode":code,"gpu":"unavailable","pixelFormat":"unavailable","physicalDisplayMeasured":false});
    observe(app, wire::Kind::P2p, "local", snapshot.clone());
    observe(app, wire::Kind::Color, "local", snapshot);
}
pub fn observe(app: &tauri::AppHandle, kind: wire::Kind, role: &str, snapshot: Value) {
    if kind == wire::Kind::P2p && role != "local" && enabled(wire::Kind::Color) {
        let mut color = snapshot.clone();
        if role == "receiver" {
            for (key, value) in [
                ("decoderInput", "unavailable"),
                ("decoderOutput", "unavailable"),
                ("range", "unavailable"),
                ("matrixName", "unavailable"),
                ("renderer", "webview_video"),
                ("stage", "decoding"),
            ] {
                color[key] = json!(value);
            }
        }
        observe(app, wire::Kind::Color, role, color);
    }
    if !enabled(kind) {
        return;
    }
    let mut safe = serde_json::to_value(wire::safe_for_kind(kind, &snapshot)).unwrap();
    // Existing correlation hashes are in-memory routing metadata only; frontend replaces
    // them with random server aliases before upload.
    for key in ["peerToken", "senderToken", "offerToken"] {
        if let Some(v) = snapshot
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            safe[key] = json!(v);
        }
    }
    for key in ["receiverGeneration", "roomGeneration"] {
        if let Some(v) = snapshot
            .get(key)
            .and_then(Value::as_u64)
            .filter(|v| *v <= u32::MAX as u64)
        {
            safe[key] = json!(v);
        }
    }
    if let Some(traffic) = snapshot.get("traffic") {
        for (k, v) in wire::safe_for_kind(kind, traffic) {
            safe[&k] = v;
        }
    }
    if safe.as_object().is_some_and(|m| !m.is_empty()) {
        let _ = app.emit(
            "diagnostics-snapshot",
            json!({"kind":kind,"role":role,"snapshot":safe}),
        );
    }
}

static SYNTHETIC_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[tauri::command]
pub async fn diagnostics_synthetic(app: tauri::AppHandle, vendor: String) -> Result<Value, String> {
    use std::sync::atomic::Ordering;
    if !enabled(wire::Kind::Synthetic) {
        return Err("diagnostics_synthetic_consent_required".into());
    }
    if SYNTHETIC_BUSY.swap(true, Ordering::SeqCst) {
        return Err("diagnostics_synthetic_busy".into());
    }
    let started = Instant::now();
    let mut result: Result<Value, String> = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(all(target_os = "windows", feature = "color-diagnostics"))]
        {
            crate::capture::diagnostic_synthetic::run(&app, &vendor)
        }
        #[cfg(not(all(target_os = "windows", feature = "color-diagnostics")))]
        {
            let _ = (app, vendor);
            Err("diagnostics_synthetic_not_in_build".into())
        }
    })
    .await
    .map_err(|_| "diagnostics_synthetic_failed".to_string())
    .and_then(|v| v);
    SYNTHETIC_BUSY.store(false, Ordering::SeqCst);
    if !enabled(wire::Kind::Synthetic) {
        return Err("diagnostics_synthetic_cancelled".into());
    }
    if let Ok(ref mut value) = result {
        value["metrics"]["durationMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    }
    result
}
