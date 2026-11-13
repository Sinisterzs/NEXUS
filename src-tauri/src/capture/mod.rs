#[cfg(target_os = "windows")]
pub mod dxgi_wgc;
pub mod health;
pub mod recovery;
#[cfg(target_os = "windows")]
pub mod p2p;
#[cfg(target_os = "windows")]
pub mod quality;
#[cfg(all(test, target_os = "windows"))]
mod encoder_experiment;
#[cfg(target_os = "windows")]
pub mod mf_encoder;
#[cfg(target_os = "windows")]
pub mod preview;
#[cfg(target_os = "windows")]
pub mod selector;
#[cfg(target_os = "windows")]
pub mod wasapi_loopback;
#[cfg(target_os = "windows")]
pub mod webrtc_sender;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CaptureSourceKind {
    DxgiMonitor,
    WgcMonitor,
    WgcWindow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureSourceInfo {
    pub id: String,
    pub kind: CaptureSourceKind,
    pub title: String,
    pub process_name: String,
    pub pid: u32,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
    pub is_hdr: bool,
    pub is_minimized: bool,
    pub left: i32,
    pub top: i32,
    pub scale_factor: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_index: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CaptureSources {
    pub monitors: Vec<CaptureSourceInfo>,
    pub windows: Vec<CaptureSourceInfo>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ScreenQualityPreset {
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "720p30")]
    P720F30,
    #[serde(rename = "720p60")]
    P720F60,
    #[serde(rename = "1080p30")]
    P1080F30,
    #[serde(rename = "1080p60")]
    P1080F60,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresetSpec {
    pub name: &'static str,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub initial_bitrate_bps: u32,
    pub min_bitrate_bps: u32,
    pub max_bitrate_bps: u32,
}

impl ScreenQualityPreset {
    pub fn from_str_lossy(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "720p30" => Self::P720F30,
            "720p60" => Self::P720F60,
            "1080p30" => Self::P1080F30,
            "1080p60" => Self::P1080F60,
            _ => Self::Auto,
        }
    }

    pub fn spec(self) -> PresetSpec {
        match self {
            Self::Auto => PresetSpec {
                name: "auto",
                width: 1920,
                height: 1080,
                fps: 30,
                initial_bitrate_bps: 2_000_000,
                min_bitrate_bps: 1_200_000,
                max_bitrate_bps: 3_000_000,
            },
            Self::P720F30 => PresetSpec {
                name: "720p30",
                width: 1280,
                height: 720,
                fps: 30,
                initial_bitrate_bps: 1_500_000,
                min_bitrate_bps: 900_000,
                max_bitrate_bps: 2_200_000,
            },
            Self::P720F60 => PresetSpec {
                name: "720p60",
                width: 1280,
                height: 720,
                fps: 60,
                initial_bitrate_bps: 2_500_000,
                min_bitrate_bps: 1_200_000,
                max_bitrate_bps: 3_500_000,
            },
            Self::P1080F30 => PresetSpec {
                name: "1080p30",
                width: 1920,
                height: 1080,
                fps: 30,
                initial_bitrate_bps: 2_400_000,
                min_bitrate_bps: 1_500_000,
                max_bitrate_bps: 3_500_000,
            },
            Self::P1080F60 => PresetSpec {
                name: "1080p60",
                width: 1920,
                height: 1080,
                fps: 60,
                initial_bitrate_bps: 3_500_000,
                min_bitrate_bps: 2_200_000,
                max_bitrate_bps: 5_000_000,
            },
        }
    }

    pub fn clamp_bitrate(self, requested_bps: u32) -> u32 {
        let s = self.spec();
        requested_bps.clamp(s.min_bitrate_bps, s.max_bitrate_bps)
    }
}

/// Computes an aspect-preserving even-aligned target resolution that fits inside `max_w x max_h`.
pub fn fit_even_resolution(src_w: u32, src_h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let sw = src_w.max(2);
    let sh = src_h.max(2);
    let mw = max_w.max(2) & !1;
    let mh = max_h.max(2) & !1;

    if sw <= mw && sh <= mh {
        return ((sw & !1).max(2), (sh & !1).max(2));
    }

    let scale_w = (mw as f64) / (sw as f64);
    let scale_h = (mh as f64) / (sh as f64);
    let scale = scale_w.min(scale_h);

    let dst_w = (((sw as f64) * scale).round() as u32).clamp(2, mw) & !1;
    let dst_h = (((sh as f64) * scale).round() as u32).clamp(2, mh) & !1;
    (dst_w.max(2), dst_h.max(2))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartScreenShareOptions {
    #[serde(alias = "source_id")]
    pub source_id: String,
    #[serde(default = "default_preset_str")]
    pub preset: String,
    #[serde(default = "default_true", alias = "cursor_enabled")]
    pub cursor_enabled: bool,
    #[serde(default, alias = "include_app_audio")]
    pub include_app_audio: bool,
    #[serde(default, alias = "force_software")]
    pub force_software: bool,
    #[serde(default, alias = "ice_servers")]
    pub ice_servers: Option<Vec<crate::commands::IceServerConfig>>,
}

fn default_preset_str() -> String {
    "auto".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeCaptureStatus {
    pub preview_session_id: u32,
    pub active: bool,
    pub source_id: String,
    pub backend_used: String,
    pub encoder_name: String,
    pub is_hardware: bool,
    pub d3d_zero_copy: bool,
    pub borderless_ok: bool,
    pub app_audio_active: bool,
    pub app_audio_mode: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_bps: u32,
    pub profile_level_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeScreenStats {
    pub encoder_name: String,
    pub is_hardware: bool,
    pub d3d_zero_copy: bool,
    pub backend_used: String,
    pub borderless_ok: bool,
    pub app_audio_active: bool,
    pub preset: String,
    pub src_width: u32,
    pub src_height: u32,
    pub dst_width: u32,
    pub dst_height: u32,
    pub target_fps: u32,
    pub requested_bitrate_bps: u32,
    pub encoder_readback_bitrate_bps: Option<u32>,
    pub encoded_payload_bitrate_kbps: f64,
    pub target_bitrate_bps: u32,
    pub send_fps: f64,
    pub send_bitrate_kbps: f64,
    pub frames_captured: u64,
    pub frames_encoded: u64,
    pub frames_sent: u64,
    pub idr_count: u64,
    pub pli_received: u64,
    pub peer_count: usize,
    pub bitrate_experiment_bps: u32,
    pub bitrate_reinit_count: u64,
    pub encode_avg_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeScreenOfferEvent {
    pub peer_id: String,
    pub sdp: String,
    pub sdp_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeScreenIceEvent {
    pub sdp_session_id: Option<String>,
    pub peer_id: String,
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_mline_index: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeScreenErrorEvent {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeScreenEndedEvent {
    pub reason: String,
}

pub struct NativeCaptureState {
    #[cfg(target_os = "windows")]
    pub inner: webrtc_sender::NativeScreenManager,
}

impl NativeCaptureState {
    pub fn new() -> Self {
        Self {
            #[cfg(target_os = "windows")]
            inner: webrtc_sender::NativeScreenManager::new(),
        }
    }

    pub fn shutdown_sync(&self) {
        #[cfg(target_os = "windows")]
        self.inner.shutdown_sync();
    }
}

impl Default for NativeCaptureState {
    fn default() -> Self {
        Self::new()
    }
}

const CAPTURE_LOG_MAX_BYTES: u64 = 1_048_576;

/// Formats a Unix timestamp (ms) as `YYYY-MM-DD HH:MM:SS.mmm` (UTC) without extra dependencies.
fn format_utc_timestamp(unix_ms: u128) -> String {
    let secs = (unix_ms / 1000) as i64;
    let ms = (unix_ms % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Howard Hinnant's civil-from-days algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}.{ms:03}Z")
}

/// Location of the persistent capture diagnostics log:
/// `%APPDATA%\com.nexus.desktop\capture.log` (or `$NEXUS_APP_DATA_DIR\capture.log` in the lab).
pub fn capture_log_path(app: Option<&tauri::AppHandle>) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    if let Ok(custom) = std::env::var("NEXUS_APP_DATA_DIR") {
        let custom = custom.trim();
        if !custom.is_empty() {
            return Some(std::path::PathBuf::from(custom).join("capture.log"));
        }
    }
    if let Some(app) = app {
        if let Ok(dir) = app.path().app_data_dir() {
            return Some(dir.join("capture.log"));
        }
    }
    std::env::var("APPDATA")
        .ok()
        .map(|a| std::path::PathBuf::from(a).join("com.nexus.desktop").join("capture.log"))
}

fn append_capture_log(path: &std::path::Path, line: &str) {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Keep a single previous generation so the log never grows without bound.
    if std::fs::metadata(path).map(|m| m.len() > CAPTURE_LOG_MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// Diagnostic logging for the native capture pipeline. Never receives tokens or credentials:
/// callers pass only step names, HRESULTs, source handles and encoder/backend names.
pub fn log_capture_diag(app: Option<&tauri::AppHandle>, msg: &str) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let line = format!("[{}] [CAPTURE] {msg}", format_utc_timestamp(now_ms));
    eprintln!("{line}");
    if let Some(path) = capture_log_path(app) {
        append_capture_log(&path, &line);
    }
}
#[tauri::command]
pub fn native_list_capture_sources() -> Result<CaptureSources, String> {
    #[cfg(target_os = "windows")]
    {
        match selector::enumerate_all_sources() {
            Ok(sources) => {
                log_capture_diag(None, &format!("enumerate_all_sources ok: {} monitors, {} windows", sources.monitors.len(), sources.windows.len()));
                Ok(sources)
            }
            Err(e) => {
                log_capture_diag(None, &format!("enumerate_all_sources FAILED: {e:?}"));
                Err(format!("enumerate_all_sources failed: {e:?}"))
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(CaptureSources::default())
    }
}

#[tauri::command]
pub async fn native_start_screen_share(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeCaptureState>,
    options: StartScreenShareOptions,
) -> Result<NativeCaptureStatus, String> {
    log_capture_diag(Some(&app), &format!(
        "native_start_screen_share requested: source_id={}, preset={}, cursor={}, app_audio={}, force_sw={}",
        options.source_id, options.preset, options.cursor_enabled, options.include_app_audio, options.force_software
    ));
    #[cfg(target_os = "windows")]
    {
        match state.inner.start_capture(app.clone(), options).await {
            Ok(status) => {
                log_capture_diag(Some(&app), &format!(
                    "native_start_screen_share SUCCESS: backend={}, encoder={}, hw={}, dim={}x{}@{}fps",
                    status.backend_used, status.encoder_name, status.is_hardware, status.width, status.height, status.fps
                ));
                Ok(status)
            }
            Err(e) => {
                log_capture_diag(Some(&app), &format!("native_start_screen_share FAILED: {e}"));
                Err(e)
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state, options);
        Err("Native Windows capture is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub fn native_set_screen_preview_visibility(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NativeCaptureState>,
    session_id: u32,
    enabled: bool,
) -> Result<u32, String> {
    let url = window.url().map_err(|_| "Preview unavailable")?;
    let local = url.scheme() == "tauri" && url.host_str() == Some("localhost")
        || url.scheme() == "http" && url.host_str() == Some("tauri.localhost")
        || cfg!(debug_assertions) && url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(1420);
    if window.label() != "main" || !local { return Err("Preview unavailable".into()); }
    #[cfg(target_os = "windows")]
    { Ok(state.inner.preview_visibility(session_id, enabled)) }
    #[cfg(not(target_os = "windows"))]
    { let _ = (state, session_id, enabled); Ok(0) }
}

/// Pull at most one reduced frame. No JSON/base64, files, broadcast or HTTP endpoint.
#[tauri::command]
pub async fn native_take_screen_preview(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NativeCaptureState>,
    session_id: u32,
    generation: Option<u32>,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<u32>,
) -> Result<tauri::ipc::Response, String> {
    let url = window.url().map_err(|_| "Preview unavailable")?;
    let local = url.scheme() == "tauri" && url.host_str() == Some("localhost")
        || url.scheme() == "http" && url.host_str() == Some("tauri.localhost")
        || cfg!(debug_assertions) && url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(1420);
    if window.label() != "main" || !local { return Err("Preview unavailable".into()); }
    let started = std::time::Instant::now();
    #[cfg(target_os = "windows")]
    let mut bytes = state.inner.take_preview(session_id, preview::PreviewConfig::bounded(width.unwrap_or(480), height.unwrap_or(270), fps.unwrap_or(30)), generation.unwrap_or(0)).await;
    #[cfg(not(target_os = "windows"))]
    let mut bytes = { let _ = (state, session_id, generation, width, height, fps); Vec::<u8>::new() };
    if bytes.len() >= 32 {
        bytes[16..20].copy_from_slice(&(started.elapsed().as_micros().min(u32::MAX as u128) as u32).to_le_bytes());
        let emitted = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_micros() as u64;
        bytes[24..32].copy_from_slice(&emitted.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn native_stop_screen_share(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeCaptureState>,
) -> Result<(), String> {
    log_capture_diag(Some(&app), "native_stop_screen_share requested by user");
    #[cfg(target_os = "windows")]
    {
        state.inner.stop_capture(Some(&app), "user_stopped").await;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state);
        Ok(())
    }
}

#[tauri::command]
pub async fn native_set_screen_quality(
    state: tauri::State<'_, NativeCaptureState>,
    preset: String,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        state.inner.set_quality_preset(&preset).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, preset);
        Err("Native Windows capture is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub async fn native_set_adaptive_bitrate(
    state: tauri::State<'_, NativeCaptureState>,
    bitrate_bps: u32,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        state.inner.set_adaptive_bitrate(bitrate_bps).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, bitrate_bps);
        Err("Native Windows capture is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub async fn native_set_screen_bitrate_experiment(state: tauri::State<'_, NativeCaptureState>, profile: String) -> Result<u32, String> {
    #[cfg(target_os = "windows")] { state.inner.set_bitrate_experiment(&profile).await }
    #[cfg(not(target_os = "windows"))] { let _ = (state, profile); Err("Windows only".into()) }
}

#[tauri::command]
pub async fn native_add_screen_peer(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeCaptureState>,
    peer_id: String,
    ice_servers: Option<Vec<crate::commands::IceServerConfig>>,
) -> Result<NativeScreenOfferEvent, String> {
    log_capture_diag(Some(&app), &format!("native_add_screen_peer requested: peer_id={}", peer_id));
    #[cfg(target_os = "windows")]
    {
        match state.inner.add_peer(app.clone(), peer_id.clone(), ice_servers).await {
            Ok(offer) => {
                log_capture_diag(Some(&app), &format!("native_add_screen_peer SUCCESS: peer_id={}, sdp_len={}", peer_id, offer.sdp.len()));
                Ok(offer)
            }
            Err(e) => {
                log_capture_diag(Some(&app), &format!("native_add_screen_peer FAILED: peer_id={}, error={}", peer_id, e));
                Err(e)
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state, peer_id, ice_servers);
        Err("Native Windows capture is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub async fn native_remove_screen_peer(
    state: tauri::State<'_, NativeCaptureState>,
    peer_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        state.inner.remove_peer(&peer_id).await;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, peer_id);
        Ok(())
    }
}

#[tauri::command]
pub async fn native_handle_screen_answer(
    state: tauri::State<'_, NativeCaptureState>,
    peer_id: String,
    sdp: String,
    screen_session_id: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        state.inner.handle_answer(&peer_id, sdp, screen_session_id).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, peer_id, sdp, screen_session_id);
        Err("Native Windows capture is only supported on Windows".to_string())
    }
}

// Only whitelisted counters/states may cross from the WebView into capture.log.
// Never accept arbitrary diagnostic messages, SDP, addresses or credentials.
fn safe_receiver_snapshot(snapshot: &serde_json::Value) -> serde_json::Value {
    let mut safe = serde_json::Map::new();
    for key in ["packetsReceived", "bytesReceived", "framesReceived", "framesDecoded",
        "keyFramesDecoded", "framesDropped", "playerReadyState", "playerWidth",
        "playerHeight", "playerCurrentTime", "local_host", "local_srflx", "local_relay",
        "remote_host", "remote_srflx", "remote_relay", "receiverId",
        "icePairs", "icePairsWaiting", "icePairsInProgress", "icePairsSucceeded", "icePairsFailed",
        "iceRequestsSentTotal", "iceRequestsReceivedTotal", "iceResponsesSentTotal", "iceResponsesReceivedTotal", "iceConsentRequestsSentTotal",
        "pairRequestsSent", "pairRequestsReceived", "pairResponsesSent", "pairResponsesReceived", "pairConsentRequestsSent", "pairBytesSent", "pairBytesReceived", "iceConnectedObservedMs", "dtlsConnectingObservedMs",
        "receiverGeneration", "roomGeneration", "offersApplied", "answersSent", "iceQueued", "iceApplied", "iceRejected", "iceStale",
        "roundTripTime", "availableIncomingBitrate", "packetsLost", "jitter", "nackCount", "pliCount", "firCount", "qpSum", "totalDecodeTime",
        "audioPacketsReceived", "audioBytesReceived", "audioPacketsLost", "audioJitter", "audioTotalSamplesReceived", "audioConcealedSamples", "audioTrackCount", "playerVolume"] {
        if let Some(value) = snapshot.get(key) {
            if value.is_null() || value.as_f64().map(|n| n.is_finite() && n >= 0.0).unwrap_or(false) {
                safe.insert(key.to_string(), value.clone());
            }
        }
    }
    for key in ["diagnosticRun", "senderToken", "peerToken", "transportToken", "offerToken"] {
        if let Some(value) = snapshot.get(key).and_then(|v| v.as_str()) {
            let expected = if key == "diagnosticRun" { 32 } else { 64 };
            if value.len() == expected && value.bytes().all(|b| b.is_ascii_hexdigit()) {
                safe.insert(key.to_string(), serde_json::Value::String(value.to_owned()));
            }
        }
    }
    for key in ["pairNominated", "setupCompatible", "localSdpPresent", "remoteSdpPresent", "localIceCredentialsPresent", "remoteIceCredentialsPresent", "localFingerprintPresent", "remoteFingerprintPresent", "localFingerprintMatchesCertificate", "remoteFingerprintMatchesCertificate", "trackMuted", "playerBound", "playerPaused", "playerMuted", "audioTrackMuted"] {
        if let Some(value) = snapshot.get(key) {
            if value.is_null() || value.is_boolean() { safe.insert(key.to_string(), value.clone()); }
        }
    }
    for (key, allowed) in [
        ("connectionState", & ["new", "connecting", "connected", "disconnected", "failed", "closed"][..]),
        ("iceConnectionState", & ["new", "checking", "connected", "completed", "disconnected", "failed", "closed"][..]),
        ("signalingState", & ["stable", "have-local-offer", "have-remote-offer", "have-local-pranswer", "have-remote-pranswer", "closed"][..]),
        ("localSetup", & ["active", "passive", "actpass"][..]),
        ("remoteSetup", & ["active", "passive", "actpass"][..]),
        ("pairState", & ["frozen", "waiting", "in-progress", "failed", "succeeded"][..]),
        ("dtlsState", & ["new", "connecting", "connected", "closed", "failed"][..]),
        ("localCandidateType", & ["host", "srflx", "prflx", "relay"][..]),
        ("remoteCandidateType", & ["host", "srflx", "prflx", "relay"][..]),
        ("trackState", & ["live", "ended"][..]),
        ("audioTrackState", & ["live", "ended"][..]),
    ] {
        if let Some(value) = snapshot.get(key) {
            if value.is_null() || value.as_str().map(|s| allowed.contains(&s)).unwrap_or(false) {
                safe.insert(key.to_string(), value.clone());
            }
        }
    }
    serde_json::Value::Object(safe)
}

#[tauri::command]
pub fn native_log_screen_receiver(app: tauri::AppHandle, snapshot: serde_json::Value) {
    log_capture_diag(Some(&app), &format!("screen_receiver {}", safe_receiver_snapshot(&snapshot)));
}

#[tauri::command]
pub async fn native_handle_screen_ice(
    state: tauri::State<'_, NativeCaptureState>,
    peer_id: String,
    candidate: String,
    sdp_mid: Option<String>,
    sdp_mline_index: Option<u16>,
    screen_session_id: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        state
            .inner
            .handle_ice(&peer_id, candidate, sdp_mid, sdp_mline_index, screen_session_id)
            .await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, peer_id, candidate, sdp_mid, sdp_mline_index, screen_session_id);
        Err("Native Windows capture is only supported on Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_preset_parsing_and_specs() {
        assert_eq!(ScreenQualityPreset::from_str_lossy("720p30"), ScreenQualityPreset::P720F30);
        assert_eq!(ScreenQualityPreset::from_str_lossy("720p60"), ScreenQualityPreset::P720F60);
        assert_eq!(ScreenQualityPreset::from_str_lossy("1080p30"), ScreenQualityPreset::P1080F30);
        assert_eq!(ScreenQualityPreset::from_str_lossy("1080p60"), ScreenQualityPreset::P1080F60);
        assert_eq!(ScreenQualityPreset::from_str_lossy("auto"), ScreenQualityPreset::Auto);
        assert_eq!(ScreenQualityPreset::from_str_lossy("unknown"), ScreenQualityPreset::Auto);

        let p1080_60 = ScreenQualityPreset::P1080F60.spec();
        assert_eq!(p1080_60.width, 1920);
        assert_eq!(p1080_60.height, 1080);
        assert_eq!(p1080_60.fps, 60);
        assert_eq!(p1080_60.max_bitrate_bps, 5_000_000);

        let p720_60 = ScreenQualityPreset::P720F60.spec();
        assert_eq!(p720_60.width, 1280);
        assert_eq!(p720_60.height, 720);
        assert_eq!(p720_60.fps, 60);
    }

    #[test]
    fn test_bitrate_clamping() {
        assert_eq!(ScreenQualityPreset::P720F30.clamp_bitrate(100_000), 900_000);
        assert_eq!(ScreenQualityPreset::P720F30.clamp_bitrate(1_500_000), 1_500_000);
        assert_eq!(ScreenQualityPreset::P720F30.clamp_bitrate(10_000_000), 2_200_000);

        assert_eq!(ScreenQualityPreset::P1080F60.clamp_bitrate(500_000), 2_200_000);
        assert_eq!(ScreenQualityPreset::P1080F60.clamp_bitrate(4_000_000), 4_000_000);
        assert_eq!(ScreenQualityPreset::P1080F60.clamp_bitrate(9_000_000), 5_000_000);
    }

    #[test]
    fn test_fit_even_resolution() {
        assert_eq!(fit_even_resolution(1920, 1080, 1920, 1080), (1920, 1080));
        assert_eq!(fit_even_resolution(2560, 1440, 1920, 1080), (1920, 1080));
        assert_eq!(fit_even_resolution(2560, 1440, 1280, 720), (1280, 720));
        assert_eq!(fit_even_resolution(1279, 719, 1920, 1080), (1278, 718));
        assert_eq!(fit_even_resolution(3440, 1440, 1920, 1080), (1920, 804));
    }

    #[test]
    fn test_start_options_accept_camel_case_and_legacy_snake_case() {
        // Payload sent by the Nightly.2 frontend (Tauri 2 camelCase convention).
        let camel: StartScreenShareOptions = serde_json::from_value(serde_json::json!({
            "sourceId": "monitor:0x10001",
            "preset": "720p60",
            "cursorEnabled": false,
            "includeAppAudio": true,
            "forceSoftware": true,
            "iceServers": [{ "urls": ["stun:stun.example.org:3478"] }]
        }))
        .expect("camelCase options must deserialize");
        assert_eq!(camel.source_id, "monitor:0x10001");
        assert_eq!(camel.preset, "720p60");
        assert!(!camel.cursor_enabled);
        assert!(camel.include_app_audio);
        assert!(camel.force_software);
        assert_eq!(camel.ice_servers.as_ref().map(|v| v.len()), Some(1));

        // Legacy Nightly.1 payload must keep working.
        let snake: StartScreenShareOptions = serde_json::from_value(serde_json::json!({
            "source_id": "window:0xABCD",
            "cursor_enabled": true,
            "include_app_audio": false,
            "force_software": false
        }))
        .expect("legacy snake_case options must deserialize");
        assert_eq!(snake.source_id, "window:0xABCD");
        assert_eq!(snake.preset, "auto");
        assert!(snake.cursor_enabled);
        assert!(snake.ice_servers.is_none());

        // Defaults when only the source is provided.
        let minimal: StartScreenShareOptions =
            serde_json::from_value(serde_json::json!({ "sourceId": "monitor:0x1" })).unwrap();
        assert!(minimal.cursor_enabled);
        assert!(!minimal.include_app_audio);
    }

    #[test]
    fn test_capture_log_timestamp_format() {
        assert_eq!(format_utc_timestamp(0), "1970-01-01 00:00:00.000Z");
        assert_eq!(format_utc_timestamp(1_794_244_036_461), "2026-11-09 17:07:16.461Z");
        assert_eq!(format_utc_timestamp(951_782_400_000), "2000-02-29 00:00:00.000Z");
    }

    #[test]
    fn test_screen_receiver_log_rejects_sensitive_or_invalid_fields() {
        let safe = safe_receiver_snapshot(&serde_json::json!({
            "connectionState": "connected", "bytesReceived": 42,
            "framesDecoded": null, "playerBound": true, "localCandidateType": "relay",
            "sdp": "PRIVATE_SDP", "credential": "PRIVATE_SECRET", "address": "PRIVATE_IP",
            "trackState": "PRIVATE_STATE", "framesDropped": -1, "playerWidth": "PRIVATE_WIDTH",
            "senderToken": "PRIVATE_ID", "peerToken": "ab".repeat(32), "receiverGeneration": 2,
            "localSetup": "PRIVATE_ROLE", "remoteSetup": "active", "setupCompatible": true,
            "pairRequestsSent": 9, "pairResponsesReceived": -1, "localFingerprintMatchesCertificate": false
        }));
        assert_eq!(safe["bytesReceived"], 42);
        assert_eq!(safe["connectionState"], "connected");
        assert_eq!(safe["localCandidateType"], "relay");
        assert!(safe.get("framesDecoded").unwrap().is_null());
        assert_eq!(safe["playerBound"], true);
        assert!(!safe.to_string().contains("PRIVATE_"));
        assert!(safe.get("framesDropped").is_none());
        assert_eq!(safe["peerToken"], "ab".repeat(32));
        assert_eq!(safe["receiverGeneration"], 2);
        assert_eq!(safe["pairRequestsSent"], 9); assert!(safe.get("pairResponsesReceived").is_none());
        assert_eq!(safe["remoteSetup"], "active"); assert!(safe.get("localSetup").is_none());
        assert_eq!(safe["localFingerprintMatchesCertificate"], false);
    }

    #[test]
    fn test_capture_log_is_persisted_and_rotated() {
        let dir = std::env::temp_dir().join(format!("nexus_capture_log_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("capture.log");

        append_capture_log(&path, "[t] [CAPTURE] step=d3d11 hresult=0x80070005");
        append_capture_log(&path, "[t] [CAPTURE] step=wgc ok");
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("hresult=0x80070005"));
        assert_eq!(content.lines().count(), 2);

        // Oversized log is rotated to capture.log.1 and a fresh file is started.
        std::fs::write(&path, vec![b'x'; (CAPTURE_LOG_MAX_BYTES + 1) as usize]).unwrap();
        append_capture_log(&path, "[t] [CAPTURE] after rotation");
        assert!(dir.join("capture.log.1").exists());
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), "[t] [CAPTURE] after rotation");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_capture_log_default_location() {
        // Without an override the log lives in %APPDATA%\com.nexus.desktop\capture.log.
        if std::env::var("NEXUS_APP_DATA_DIR").map(|v| !v.trim().is_empty()).unwrap_or(false) {
            return;
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            let p = capture_log_path(None).expect("path");
            assert_eq!(
                p,
                std::path::PathBuf::from(appdata).join("com.nexus.desktop").join("capture.log")
            );
        }
    }

    #[test]
    fn test_diagnose_native_capture_on_host() {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
            use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
            use windows::Win32::Media::MediaFoundation::{MFStartup, MFShutdown, MF_VERSION, MFSTARTUP_NOSOCKET};

            unsafe {
                let _ = RoInitialize(RO_INIT_MULTITHREADED);
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) {
                    println!("[DIAG] MFStartup failed: {:?}", e);
                } else {
                    println!("[DIAG] MFStartup ok");
                }
            }

            println!("[DIAG] 1. Enumerating sources...");
            match selector::enumerate_all_sources() {
                Ok(sources) => {
                    println!("[DIAG] Found {} monitors, {} windows", sources.monitors.len(), sources.windows.len());
                    for (i, m) in sources.monitors.iter().enumerate() {
                        println!("[DIAG] Monitor[{}]: id={}, title={}, adapter={:?}, output={:?}, dim={}x{}",
                            i, m.id, m.title, m.adapter_index, m.output_index, m.width, m.height);
                    }
                    if let Some(first_mon) = sources.monitors.first() {
                        let parsed = selector::parse_source_handle(&first_mon.id);
                        println!("[DIAG] parse_source_handle({}): {:?}", first_mon.id, parsed);

                        let adapter_idx = first_mon.adapter_index.unwrap_or(0);
                        println!("[DIAG] 2. Testing create_d3d11_on_adapter({})...", adapter_idx);
                        match dxgi_wgc::create_d3d11_on_adapter(adapter_idx) {
                            Ok((dev, ctx)) => {
                                println!("[DIAG] D3D11 device and context created successfully!");

                                let (_kind, handle_raw) = parsed.unwrap();
                                let target = dxgi_wgc::CaptureTarget::DxgiMonitor {
                                    hmonitor: handle_raw,
                                    adapter_index: adapter_idx,
                                    output_index: first_mon.output_index.unwrap_or(0),
                                };

                                println!("[DIAG] 3. Testing HybridCapturer::open with DxgiMonitor...");
                                match dxgi_wgc::HybridCapturer::open(&dev, &target, true) {
                                    Ok(mut capturer) => {
                                        println!("[DIAG] HybridCapturer::open succeeded with backend: {}", capturer.backend_used());
                                        let (w, h) = capturer.src_size();
                                        println!("[DIAG] Captured size: {}x{}", w, h);

                                        println!("[DIAG] 4. Testing GpuBgraToNv12::new...");
                                        match mf_encoder::GpuBgraToNv12::new(&dev, &ctx, w, h, 1920, 1080) {
                                            Ok(_) => println!("[DIAG] GpuBgraToNv12 initialized successfully!"),
                                            Err(e) => println!("[DIAG] GpuBgraToNv12 failed: {:?}", e),
                                        }

                                        println!("[DIAG] 5. Testing MfH264Encoder::new (HW/SW)...");
                                        match mf_encoder::MfH264Encoder::new(&dev, 1920, 1080, 30, 2_000_000, false) {
                                            Ok(enc) => println!("[DIAG] MfH264Encoder initialized: {}", enc.encoder_name),
                                            Err(e) => println!("[DIAG] MfH264Encoder failed: {:?}", e),
                                        }

                                        println!("[DIAG] 6. Testing frame acquisition...");
                                        match capturer.acquire_into_texture(&dev, &ctx, 200) {
                                            Ok((tex, captured)) => {
                                                println!("[DIAG] Frame acquisition ok: has_texture={}, captured_new={}", tex.is_some(), captured);
                                            }
                                            Err(e) => {
                                                println!("[DIAG] Frame acquisition failed: {:?}", e);
                                            }
                                        }

                                        println!("[DIAG] 7. Testing WebRTC API build & PC creation...");
                                        match webrtc_sender::build_webrtc_api(false) {
                                            Ok(api) => {
                                                println!("[DIAG] WebRTC API built successfully!");
                                                let rt = tokio::runtime::Runtime::new().unwrap();
                                                rt.block_on(async {
                                                    match api.new_peer_connection(webrtc::peer_connection::configuration::RTCConfiguration::default()).await {
                                                        Ok(pc) => {
                                                            println!("[DIAG] RTCPeerConnection created ok!");
                                                            let track = std::sync::Arc::new(webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample::new(
                                                                webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability {
                                                                    mime_type: "video/H264".to_string(),
                                                                    clock_rate: 90000,
                                                                    channels: 0,
                                                                    sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f".to_string(),
                                                                    rtcp_feedback: vec![],
                                                                },
                                                                "test-video".to_string(),
                                                                "test-stream".to_string(),
                                                            ));
                                                            match pc.add_track(track).await {
                                                                Ok(_) => {
                                                                    println!("[DIAG] Video track added to PC ok!");
                                                                    match pc.create_offer(None).await {
                                                                        Ok(offer) => {
                                                                            println!("[DIAG] WebRTC Offer generated successfully! (sdp length: {})", offer.sdp.len());
                                                                        }
                                                                        Err(e) => println!("[DIAG] create_offer failed: {:?}", e),
                                                                    }
                                                                }
                                                                Err(e) => println!("[DIAG] add_track failed: {:?}", e),
                                                            }
                                                        }
                                                        Err(e) => println!("[DIAG] new_peer_connection failed: {:?}", e),
                                                    }
                                                });
                                            }
                                            Err(e) => println!("[DIAG] build_webrtc_api failed: {:?}", e),
                                        }

                                        capturer.close();
                                    }
                                    Err(e) => {
                                        println!("[DIAG] HybridCapturer::open failed: {:?}", e);
                                    }
                                }
                            }
                            Err(e) => {
                                println!("[DIAG] create_d3d11_on_adapter failed: {:?}", e);
                            }
                        }
                    }
                }
                Err(e) => {
                    println!("[DIAG] enumerate_all_sources failed: {:?}", e);
                }
            }

            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
                RoUninitialize();
            }
        }
    }
}
