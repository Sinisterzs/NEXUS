#[cfg(target_os = "windows")]
pub mod dxgi_wgc;
#[cfg(target_os = "windows")]
pub mod mf_encoder;
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
pub struct StartScreenShareOptions {
    pub source_id: String,
    #[serde(default = "default_preset_str")]
    pub preset: String,
    #[serde(default = "default_true")]
    pub cursor_enabled: bool,
    #[serde(default)]
    pub include_app_audio: bool,
    #[serde(default)]
    pub force_software: bool,
    #[serde(default)]
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
    pub target_bitrate_bps: u32,
    pub send_fps: f64,
    pub send_bitrate_kbps: f64,
    pub frames_captured: u64,
    pub frames_encoded: u64,
    pub frames_sent: u64,
    pub idr_count: u64,
    pub pli_received: u64,
    pub peer_count: usize,
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

#[tauri::command]
pub fn native_list_capture_sources() -> Result<CaptureSources, String> {
    #[cfg(target_os = "windows")]
    {
        selector::enumerate_all_sources().map_err(|e| format!("enumerate_all_sources failed: {e:?}"))
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
    #[cfg(target_os = "windows")]
    {
        state.inner.start_capture(app, options).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state, options);
        Err("Native Windows capture is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub async fn native_stop_screen_share(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeCaptureState>,
) -> Result<(), String> {
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
pub async fn native_add_screen_peer(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeCaptureState>,
    peer_id: String,
    ice_servers: Option<Vec<crate::commands::IceServerConfig>>,
) -> Result<NativeScreenOfferEvent, String> {
    #[cfg(target_os = "windows")]
    {
        state.inner.add_peer(app, peer_id, ice_servers).await
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
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        state.inner.handle_answer(&peer_id, sdp).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, peer_id, sdp);
        Err("Native Windows capture is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub async fn native_handle_screen_ice(
    state: tauri::State<'_, NativeCaptureState>,
    peer_id: String,
    candidate: String,
    sdp_mid: Option<String>,
    sdp_mline_index: Option<u16>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        state
            .inner
            .handle_ice(&peer_id, candidate, sdp_mid, sdp_mline_index)
            .await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, peer_id, candidate, sdp_mid, sdp_mline_index);
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
}
