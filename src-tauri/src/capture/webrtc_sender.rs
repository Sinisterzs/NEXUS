use bytes::Bytes;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264, MIME_TYPE_OPUS};
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::rtp_transceiver::rtp_codec::{
    RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType,
};
use webrtc::rtp_transceiver::RTCPFeedback;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;
use windows::Win32::Media::MediaFoundation::{MFShutdown, MFStartup, MFSTARTUP_NOSOCKET, MF_VERSION};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

use super::dxgi_wgc::{create_d3d11_on_adapter, CaptureTarget, HybridCapturer};
use super::mf_encoder::{GpuBgraToNv12, MfH264Encoder};
use super::selector::{enumerate_all_sources, parse_source_handle};
use super::wasapi_loopback::{spawn_app_audio_thread, LoopbackMode};
use super::{
    fit_even_resolution, CaptureSourceKind, NativeCaptureStatus, NativeScreenEndedEvent,
    NativeScreenErrorEvent, NativeScreenIceEvent, NativeScreenOfferEvent, NativeScreenStats,
    ScreenQualityPreset, StartScreenShareOptions,
};
use crate::commands::IceServerConfig;

struct PeerEntry {
    screen_session_id: Option<String>,
    pc: Arc<RTCPeerConnection>,
    remote_desc_set: bool,
    pending_remote_ice: Vec<RTCIceCandidateInit>,
    diagnostics: tokio::task::JoinHandle<()>,
    gate: Arc<super::p2p::Gate>,
    quality: Arc<Mutex<super::quality::NetworkEvidence>>,
}

impl Drop for PeerEntry {
    fn drop(&mut self) { self.gate.close(); self.diagnostics.abort(); }
}

// Resolve after acquiring the map: a command may have waited in IPC while a PC was replaced.
async fn screen_peer_for_session(
    peers: &tokio::sync::Mutex<HashMap<String, PeerEntry>>, peer_id: &str,
    expected: &Option<String>,
) -> Result<Option<Arc<RTCPeerConnection>>, String> {
    let peers = peers.lock().await;
    let entry = peers.get(peer_id).ok_or_else(|| "Unknown screen peer".to_string())?;
    if expected.is_some() && &entry.screen_session_id != expected { return Ok(None); }
    Ok(Some(entry.pc.clone()))
}

async fn commit_screen_answer(
    peers: &tokio::sync::Mutex<HashMap<String, PeerEntry>>, peer_id: &str, pc: &Arc<RTCPeerConnection>,
) -> Result<Vec<RTCIceCandidateInit>, String> {
    let mut peers = peers.lock().await;
    let entry = peers.get_mut(peer_id).filter(|entry| Arc::ptr_eq(&entry.pc, pc))
        .ok_or_else(|| "Screen peer closed or replaced while applying answer".to_string())?;
    entry.remote_desc_set = true;
    Ok(entry.pending_remote_ice.drain(..).collect())
}

fn negotiation_flags(sdp: &str) -> serde_json::Value {
    let mut setup = None; let mut setup_invalid = false;
    let mut ufrag = false; let mut pwd = false; let mut fingerprint = false;
    for line in sdp.lines().map(str::trim) {
        if let Some(value) = line.strip_prefix("a=setup:") {
            if ["active", "passive", "actpass"].contains(&value) && setup.is_none_or(|s| s == value) { setup = Some(value); }
            else { setup_invalid = true; }
        }
        ufrag |= line.strip_prefix("a=ice-ufrag:").is_some_and(|v| !v.is_empty());
        pwd |= line.strip_prefix("a=ice-pwd:").is_some_and(|v| !v.is_empty());
        fingerprint |= line.strip_prefix("a=fingerprint:").is_some_and(|v| !v.is_empty());
    }
    serde_json::json!({ "sdpPresent": !sdp.is_empty(), "setup": if setup_invalid { None } else { setup },
        "iceCredentialsPresent": ufrag && pwd, "fingerprintPresent": fingerprint })
}

// This task never touches the capture thread. Dropping a peer cancels it.
fn monitor_screen_peer(pc: &Arc<RTCPeerConnection>, app: AppHandle, peer_id: String, offer_id: Option<String>, gate: Arc<super::p2p::Gate>, quality: Arc<Mutex<super::quality::NetworkEvidence>>, experiment: Arc<AtomicU32>) -> tokio::task::JoinHandle<()> {
    use sha2::{Digest, Sha256};
    let peer_token = format!("{:x}", Sha256::digest(format!("nexus-screen:user:{peer_id}").as_bytes()));
    let offer_token = format!("{:x}", Sha256::digest(format!("nexus-screen:offer:{}", offer_id.unwrap_or_default()).as_bytes()));
    let weak = Arc::downgrade(pc);
    tokio::spawn(async move {
        let mut prior = (Instant::now(), 0u64, 0u64);
        let mut waiting_since = Some(Instant::now());
        let mut ice_connected_since = None::<Instant>;
        let mut dtls_connecting_since = None::<Instant>;
        loop {
            let Some(pc) = weak.upgrade() else { break };
            if experiment.load(Ordering::Relaxed) == 10_000_000 && !quality.lock().unwrap().permits_10m(Instant::now()) {
                if experiment.compare_exchange(10_000_000,0,Ordering::SeqCst,Ordering::SeqCst).is_ok() {
                    crate::capture::log_capture_diag(Some(&app), "screen_quality experiment_suspended_stale_evidence");
                    let _ = app.emit("native-screen-error", NativeScreenErrorEvent { code:"BITRATE_EXPERIMENT_SUSPENDED".into(),message:"Perfil de 10 Mbps suspenso: evidência de rede expirou. Perfil oficial restaurado.".into(),recoverable:true });
                }
            }
            let sample = async {
                let pair = pc.dtls_transport().ice_transport().get_selected_candidate_pair().await;
                let direct = pair.as_ref().is_some_and(|p| super::p2p::direct(&p.local.typ.to_string()) && super::p2p::direct(&p.remote.typ.to_string()));
                if pc.connection_state() == RTCPeerConnectionState::Connected && direct { waiting_since = None; }
                else {
                    let since = waiting_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= Duration::from_secs(30) {
                        crate::capture::log_capture_diag(Some(&app), &format!("screen_transport {}", serde_json::json!({
                            "peerToken": peer_token, "offerToken": offer_token,
                            "timeoutPhase": if direct { "secure_transport" } else { "ice_pair" },
                            "dtlsState": pc.dtls_transport().state().to_string(),
                            "iceState": pc.ice_connection_state().to_string()
                        })));
                        let _ = app.emit("native-screen-error", NativeScreenErrorEvent { code: "SCREEN_P2P_ONLY".into(), message: super::p2p::ERROR.into(), recoverable: true });
                        let _ = pc.close().await;
                        return;
                    }
                }
                let report = pc.get_stats().await;
                let mut pairs = 0u64; let mut nominated = 0u64;
                for stat in report.reports.values() {
                    if let webrtc::stats::StatsReportType::CandidatePair(p) = stat {
                        pairs += 1; nominated += u64::from(p.nominated);
                    }
                }
                let ice_ready = matches!(pc.ice_connection_state(), webrtc::ice_transport::ice_connection_state::RTCIceConnectionState::Connected | webrtc::ice_transport::ice_connection_state::RTCIceConnectionState::Completed);
                if ice_ready { ice_connected_since.get_or_insert_with(Instant::now); } else { ice_connected_since = None; }
                let dtls_state = pc.dtls_transport().state().to_string();
                if dtls_state == "connecting" { dtls_connecting_since.get_or_insert_with(Instant::now); } else { dtls_connecting_since = None; }
                let local_flags = negotiation_flags(&pc.local_description().await.map(|d| d.sdp).unwrap_or_default());
                let remote_flags = negotiation_flags(&pc.remote_description().await.map(|d| d.sdp).unwrap_or_default());
                crate::capture::log_capture_diag(Some(&app), &format!("screen_transport {}", serde_json::json!({
                    "localNegotiation": local_flags, "remoteNegotiation": remote_flags,
                    "peerToken": peer_token, "offerToken": offer_token,
                    "iceState": pc.ice_connection_state().to_string(), "dtlsState": dtls_state,
                    "iceConnectedObservedMs": ice_connected_since.map(|t| t.elapsed().as_millis() as u64),
                    "dtlsConnectingObservedMs": dtls_connecting_since.map(|t| t.elapsed().as_millis() as u64),
                    "icePairs": pairs, "iceNominatedPairs": nominated,
                    // webrtc-ice 0.17.3 fills only IDs/state/nominated; request counters are default zeros.
                    // Do not misrepresent unavailable measurements as no connectivity checks.
                    "iceCheckCountersAvailable": false,
                    "iceRequestsSent": serde_json::Value::Null, "iceResponsesReceived": serde_json::Value::Null,
                    "iceRequestsReceived": serde_json::Value::Null, "iceResponsesSent": serde_json::Value::Null,
                    "traffic": gate.traffic_snapshot()
                })));

                let (mut packets, mut bytes, mut audio_packets, mut audio_bytes) = (0u64, 0u64, 0u64, 0u64);
                let (mut lost, mut fraction_lost, mut rtt): (Option<i64>, Option<f64>, Option<f64>) = (None, None, None);
                for stat in report.reports.values() {
                    if let webrtc::stats::StatsReportType::OutboundRTP(stat) = stat {
                        if stat.kind == "video" { packets += stat.packets_sent; bytes += stat.bytes_sent; }
                        if stat.kind == "audio" { audio_packets += stat.packets_sent; audio_bytes += stat.bytes_sent; }
                    }
                    if let webrtc::stats::StatsReportType::RemoteInboundRTP(stat) = stat {
                        if stat.kind == "video" { lost = Some(lost.unwrap_or(0) + stat.packets_lost); fraction_lost = Some(fraction_lost.unwrap_or(0.0).max(stat.fraction_lost)); rtt = stat.round_trip_time.or(rtt); }
                    }
                }
                let rtt_ms = super::quality::native_rtt_ms(rtt);
                let unsafe_experiment = {
                    let mut q = quality.lock().unwrap();
                    q.sample(rtt_ms, fraction_lost, Instant::now());
                    (experiment.load(Ordering::Relaxed) == 10_000_000 && !q.permits_10m(Instant::now())) || q.bad_samples >= 2
                };
                if unsafe_experiment && experiment.swap(0, Ordering::SeqCst) != 0 {
                    crate::capture::log_capture_diag(Some(&app), "screen_quality experiment_suspended_network_evidence");
                    let _ = app.emit("native-screen-error", NativeScreenErrorEvent { code: "BITRATE_EXPERIMENT_SUSPENDED".into(), message: "Perfil local de bitrate suspenso por métricas de rede insuficientes. Perfil oficial restaurado; resolução e FPS preservados.".into(), recoverable: true });
                }
                crate::capture::log_capture_diag(Some(&app), &format!("screen_sender_feedback audio_rtp_packets={} audio_rtp_bytes={} video_packets_lost={:?} video_fraction_lost={:?} video_rtt_ms={:?} video_rtt_seconds={:?} rtt_source=interceptor017_milliseconds", audio_packets, audio_bytes, lost, fraction_lost, rtt_ms, rtt_ms.map(|v|v/1000.0)));
                let seconds = prior.0.elapsed().as_secs_f64().max(0.001);
                crate::capture::log_capture_diag(Some(&app), &format!("screen_sender_rate video_rtp_kbps_interval={:.1} audio_rtp_kbps_interval={:.1}", bytes.saturating_sub(prior.1) as f64 * 0.008 / seconds, audio_bytes.saturating_sub(prior.2) as f64 * 0.008 / seconds));
                let over_budget = {
                    let q=quality.lock().unwrap();
                    q.remb_bps.is_some_and(|limit| bytes.saturating_sub(prior.1) as f64 * 8.0 / seconds > limit*0.8)
                };
                if seconds >= 4.0 && over_budget && experiment.compare_exchange(10_000_000,0,Ordering::SeqCst,Ordering::SeqCst).is_ok() {
                    crate::capture::log_capture_diag(Some(&app), "screen_quality d10_suspended_rtp_above_safety_budget");
                    let _=app.emit("native-screen-error",NativeScreenErrorEvent{code:"BITRATE_EXPERIMENT_SUSPENDED".into(),message:"Perfil de 10 Mbps suspenso: taxa RTP observada excedeu a margem de segurança. Perfil oficial restaurado.".into(),recoverable:true});
                }
                prior = (Instant::now(), bytes, audio_bytes);
                let dtls = pc.dtls_transport();
                let pair = dtls.ice_transport().get_selected_candidate_pair().await;
                crate::capture::log_capture_diag(Some(&app), &format!(
                    "screen_sender peer={} connection={} ice={} signaling={} dtls={} local_type={} remote_type={} video_rtp_packets={} video_rtp_bytes={}",
                    peer_id, pc.connection_state(), pc.ice_connection_state(), pc.signaling_state(), dtls.state(),
                    pair.as_ref().map(|p| p.local.typ.to_string()).unwrap_or_else(|| "none".into()),
                    pair.as_ref().map(|p| p.remote.typ.to_string()).unwrap_or_else(|| "none".into()), packets, bytes));
            };
            if tokio::time::timeout(Duration::from_secs(1), sample).await.is_err() {
                crate::capture::log_capture_diag(Some(&app), "screen_sender stats_timeout");
            }
            if pc.connection_state() == RTCPeerConnectionState::Closed { break; }
            drop(pc);
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    })
}

struct SessionShared {
    preview: super::preview::PreviewSlot,
    video_track: Arc<TrackLocalStaticSample>,
    audio_track: Option<Arc<TrackLocalStaticSample>>,
    include_app_audio: bool,
    force_software: bool,
    stop_flag: Arc<AtomicBool>,
    force_keyframe: Arc<AtomicBool>,
    cursor_flag: Arc<AtomicBool>,
    bitrate_target: Arc<AtomicU32>,
    experiment_bitrate: Arc<AtomicU32>,
    pending_preset: Mutex<Option<ScreenQualityPreset>>,
    pli_count: Arc<AtomicU64>,
    peers: tokio::sync::Mutex<HashMap<String, PeerEntry>>,
    peer_operations: tokio::sync::Mutex<HashMap<String, u64>>,
    peer_count_atomic: Arc<AtomicU64>,
    default_ice_servers: Mutex<Vec<RTCIceServer>>,
    capture_thread_alive: Arc<AtomicBool>,
    capture_join: Mutex<Option<std::thread::JoinHandle<()>>>,
}

pub struct NativeScreenManager {
    active: Arc<Mutex<Option<Arc<SessionShared>>>>,
}

impl NativeScreenManager {
    pub fn preview_visibility(&self, session_id: u32, enabled: bool) -> u32 {
        let active = self.active.lock().unwrap();
        active.as_ref().filter(|s| s.preview.id == session_id).map(|s| s.preview.visibility(enabled)).unwrap_or(0)
    }
    pub async fn take_preview(&self, session_id: u32, config: super::preview::PreviewConfig, generation: u32) -> Vec<u8> {
        let session = { self.active.lock().unwrap().clone() };
        match session {
            Some(session) if session.preview.id == session_id
                && !session.stop_flag.load(Ordering::Relaxed)
                && session.capture_thread_alive.load(Ordering::Relaxed) => session.preview.take(config, generation).await,
            _ => Vec::new(),
        }
    }

    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(None)),
        }
    }

    pub fn shutdown_sync(&self) {
        let session_opt = { self.active.lock().unwrap().take() };
        if let Some(session) = session_opt {
            session.preview.close();
            session.stop_flag.store(true, Ordering::SeqCst);
            let join_opt = { session.capture_join.lock().unwrap().take() };
            if let Some(j) = join_opt {
                let _ = j.join();
            }
            if let Ok(mut peers) = session.peers.try_lock() {
                let drained: Vec<_> = peers.drain().map(|(_, e)| Arc::clone(&e.pc)).collect();
                drop(peers);
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    handle.spawn(async move {
                        for pc in drained {
                            let _ = pc.close().await;
                        }
                    });
                }
            }
        }
    }

    pub async fn start_capture(
        &self,
        app: AppHandle,
        options: StartScreenShareOptions,
    ) -> Result<NativeCaptureStatus, String> {
        // Stop any existing session first
        self.stop_capture(None, "restarted").await;

        let (kind, handle_raw) = parse_source_handle(&options.source_id)
            .ok_or_else(|| format!("Invalid source_id: {}", options.source_id))?;

        let sources = enumerate_all_sources()
            .map_err(|e| format!("enumerate_all_sources failed: {e:?}"))?;

        let (target, target_pid) = match kind {
            CaptureSourceKind::DxgiMonitor => {
                let mon = sources
                    .monitors
                    .iter()
                    .find(|m| m.id == options.source_id)
                    .cloned();
                let adapter_index = mon.as_ref().and_then(|m| m.adapter_index).unwrap_or(0);
                let output_index = mon.as_ref().and_then(|m| m.output_index).unwrap_or(0);
                (
                    CaptureTarget::DxgiMonitor {
                        hmonitor: handle_raw,
                        adapter_index,
                        output_index,
                    },
                    0u32,
                )
            }
            CaptureSourceKind::WgcMonitor => {
                (CaptureTarget::WgcMonitor { hmonitor: handle_raw }, 0u32)
            }
            CaptureSourceKind::WgcWindow => {
                let win_pid = sources
                    .windows
                    .iter()
                    .find(|w| w.id == options.source_id)
                    .map(|w| w.pid)
                    .unwrap_or(0);
                (CaptureTarget::WgcWindow { hwnd: handle_raw }, win_pid)
            }
        };

        let preset = ScreenQualityPreset::from_str_lossy(&options.preset);
        let spec = preset.spec();

        let ice_cfg = match options.ice_servers {
            Some(list) if !list.is_empty() => list,
            _ => crate::commands::webrtc_get_ice_servers()
                .await
                .unwrap_or_default(),
        };
        let rtc_ice_servers = convert_ice_servers(&ice_cfg);

        let video_track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line:
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"
                        .to_owned(),
                rtcp_feedback: vec![],
            },
            "nexus-screen-video".to_owned(),
            "nexus-screen-stream".to_owned(),
        ));

        let audio_track = if options.include_app_audio {
            Some(Arc::new(TrackLocalStaticSample::new(
                RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_owned(),
                    clock_rate: 48000,
                    channels: 2,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                    rtcp_feedback: vec![],
                },
                "nexus-screen-audio".to_owned(),
                "nexus-screen-stream".to_owned(),
            )))
        } else {
            None
        };

        let session = Arc::new(SessionShared {
            preview: super::preview::PreviewSlot::new(),
            video_track,
            audio_track,
            include_app_audio: options.include_app_audio,
            force_software: options.force_software,
            stop_flag: Arc::new(AtomicBool::new(false)),
            force_keyframe: Arc::new(AtomicBool::new(false)),
            cursor_flag: Arc::new(AtomicBool::new(options.cursor_enabled)),
            bitrate_target: Arc::new(AtomicU32::new(spec.initial_bitrate_bps)),
            experiment_bitrate: Arc::new(AtomicU32::new(0)),
            pending_preset: Mutex::new(None),
            pli_count: Arc::new(AtomicU64::new(0)),
            peers: tokio::sync::Mutex::new(HashMap::new()),
            peer_operations: tokio::sync::Mutex::new(HashMap::new()),
            peer_count_atomic: Arc::new(AtomicU64::new(0)),
            default_ice_servers: Mutex::new(rtc_ice_servers),
            capture_thread_alive: Arc::new(AtomicBool::new(false)),
            capture_join: Mutex::new(None),
        });

        let (ready_tx, ready_rx) =
            tokio::sync::oneshot::channel::<Result<NativeCaptureStatus, String>>();

        let session_loop = Arc::clone(&session);
        let rt_handle = tokio::runtime::Handle::current();
        let source_id_clone = options.source_id.clone();
        let app_clone = app.clone();

        let join = std::thread::Builder::new()
            .name("nexus-native-capture".to_string())
            .spawn(move || {
                run_capture_encode_loop(
                    app_clone,
                    session_loop,
                    target,
                    target_pid,
                    source_id_clone,
                    preset,
                    options.cursor_enabled,
                    options.include_app_audio,
                    options.force_software,
                    rt_handle,
                    ready_tx,
                );
            })
            .map_err(|e| format!("Failed to spawn capture thread: {e}"))?;

        *session.capture_join.lock().unwrap() = Some(join);

        match ready_rx.await {
            Ok(Ok(status)) => {
                *self.active.lock().unwrap() = Some(session);
                Ok(status)
            }
            Ok(Err(e)) => {
                session.preview.close();
                session.stop_flag.store(true, Ordering::SeqCst);
                if let Some(j) = session.capture_join.lock().unwrap().take() {
                    let _ = j.join();
                }
                Err(e)
            }
            Err(_) => {
                session.preview.close();
                session.stop_flag.store(true, Ordering::SeqCst);
                if let Some(j) = session.capture_join.lock().unwrap().take() {
                    let _ = j.join();
                }
                Err("Capture thread exited before initialization".to_string())
            }
        }
    }

    pub async fn stop_capture(&self, app: Option<&AppHandle>, reason: &str) {
        let session_opt = { self.active.lock().unwrap().take() };
        if let Some(session) = session_opt {
            session.preview.close();
            session.stop_flag.store(true, Ordering::SeqCst);

            let pcs: Vec<Arc<RTCPeerConnection>> = {
                let mut peers = session.peers.lock().await;
                let list = peers.drain().map(|(_, e)| Arc::clone(&e.pc)).collect();
                session.peer_count_atomic.store(0, Ordering::SeqCst);
                list
            };
            for pc in pcs {
                let _ = pc.close().await;
            }

            let join_opt = { session.capture_join.lock().unwrap().take() };
            if let Some(j) = join_opt {
                let _ = tokio::task::spawn_blocking(move || {
                    let _ = j.join();
                })
                .await;
            }

            if let Some(app_handle) = app {
                let _ = app_handle.emit(
                    "native-screen-ended",
                    NativeScreenEndedEvent {
                        reason: reason.to_string(),
                    },
                );
            }
        }
    }

    pub async fn set_quality_preset(&self, preset_str: &str) -> Result<(), String> {
        let session = {
            self.active
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "No active native screen share".to_string())?
        };
        let preset = ScreenQualityPreset::from_str_lossy(preset_str);
        *session.pending_preset.lock().unwrap() = Some(preset);
        session
            .bitrate_target
            .store(preset.spec().initial_bitrate_bps, Ordering::SeqCst);
        Ok(())
    }

    pub async fn set_adaptive_bitrate(&self, bitrate_bps: u32) -> Result<(), String> {
        let session = {
            self.active
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "No active native screen share".to_string())?
        };
        let clamped = bitrate_bps.clamp(300_000, 8_000_000);
        session.bitrate_target.store(clamped, Ordering::SeqCst);
        Ok(())
    }

    pub async fn set_bitrate_experiment(&self, profile: &str) -> Result<u32, String> {
        let session = self.active.lock().unwrap().clone().ok_or("Nenhum compartilhamento ativo")?;
        let bitrate = super::quality::experiment_bitrate(profile)?;
        if bitrate == 10_000_000 {
            let peers = session.peers.lock().await;
            if peers.is_empty() || !peers.values().all(|p| p.quality.lock().unwrap().permits_10m(Instant::now())) {
                return Err("10 Mbps bloqueado: exige múltiplas amostras recentes, RTT/perda saudáveis e REMB com margem de 20% em todos os espectadores. REMB não garante banda.".into());
            }
        }
        session.experiment_bitrate.store(bitrate, Ordering::SeqCst);
        crate::capture::log_capture_diag(None, &format!("screen_quality experiment_requested_bps={} session_only=true", bitrate));
        Ok(bitrate)
    }

    pub async fn add_peer(
        &self,
        app: AppHandle,
        peer_id: String,
        ice_servers: Option<Vec<IceServerConfig>>,
    ) -> Result<NativeScreenOfferEvent, String> {
        let session = {
            self.active
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "No active native screen share".to_string())?
        };

        // Close previous PC for this peer_id if any
        let (operation, old_pc) = {
            let mut operations = session.peer_operations.lock().await;
            let version = operations.entry(peer_id.clone()).or_default();
            *version += 1;
            let mut peers = session.peers.lock().await;
            let previous = peers.remove(&peer_id).map(|e| Arc::clone(&e.pc));
            session.peer_count_atomic.store(peers.len() as u64, Ordering::SeqCst);
            (*version, previous)
        };
        if let Some(pc) = old_pc {
            let _ = pc.close().await;
        }

        let rtc_ice = match ice_servers {
            Some(list) if !list.is_empty() => convert_ice_servers(&list),
            _ => session.default_ice_servers.lock().unwrap().clone(),
        };

        let rtc_ice = super::p2p::servers(rtc_ice);
        let gate = super::p2p::Gate::new();
        let reject_app = app.clone();
        gate.on_reject(Arc::new(move || {
            crate::capture::log_capture_diag(Some(&reject_app), "screen_p2p rejected_relay");
            let _ = reject_app.emit("native-screen-error", NativeScreenErrorEvent { code: "SCREEN_P2P_ONLY".into(), message: super::p2p::ERROR.into(), recoverable: true });
        }));
        let turn_entries = rtc_ice.iter().filter(|s| s.urls.iter().any(|u| u.starts_with("turn:") || u.starts_with("turns:"))).count();
        let turn_with_credentials = rtc_ice.iter().filter(|s| s.urls.iter().any(|u| u.starts_with("turn:") || u.starts_with("turns:")) && !s.username.is_empty() && !s.credential.is_empty()).count();
        crate::capture::log_capture_diag(Some(&app), &format!("screen_ice_config entries={} turn_entries={} turn_with_credentials={}", rtc_ice.len(), turn_entries, turn_with_credentials));
        let api = build_screen_webrtc_api(session.include_app_audio, Some(gate.clone()))
            .map_err(|e| format!("build_webrtc_api: {e}"))?;
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration {
                ice_servers: rtc_ice,
                ..Default::default()
            })
            .await
            .map_err(|e| format!("new_peer_connection: {e}"))?,
        );

        gate.attach(&pc);
        let gate_pair = gate.clone();
        let pair_app = app.clone();
        pc.dtls_transport().ice_transport().on_selected_candidate_pair_change(Box::new(move |pair| {
            let local = pair.local.typ.to_string(); let remote = pair.remote.typ.to_string();
            crate::capture::log_capture_diag(Some(&pair_app), &format!("screen_p2p selected local={} remote={}", local, remote));
            if !super::p2p::direct(&local) || !super::p2p::direct(&remote) { gate_pair.reject(); }
            Box::pin(async {})
        }));
        let video_sender = pc
            .add_track(Arc::clone(&session.video_track) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| format!("add video track: {e}"))?;

        let quality = Arc::new(Mutex::new(super::quality::NetworkEvidence::default()));
        let feedback_quality = quality.clone();
        let force_kf = Arc::clone(&session.force_keyframe);
        let pli_cnt = Arc::clone(&session.pli_count);
        let feedback_app = app.clone();
        tokio::spawn(async move {
            let mut last_log = Instant::now() - Duration::from_secs(5);
            let (mut receiver_reports, mut reported_loss, mut remb, mut nack_reports) = (0u64, None, None, 0u64);
            while let Ok((pkts, _)) = video_sender.read_rtcp().await {
                for pkt in pkts {
                    if pkt.as_any().downcast_ref::<webrtc::rtcp::transport_feedbacks::transport_layer_nack::TransportLayerNack>().is_some() {nack_reports += 1;}
                    if let Some(rr) = pkt.as_any().downcast_ref::<webrtc::rtcp::receiver_report::ReceiverReport>() {
                        receiver_reports += 1;
                        feedback_quality.lock().unwrap().receiver_report_at=Some(Instant::now());
                        reported_loss = rr.reports.iter().map(|r| r.fraction_lost).max();
                    }
                    if let Some(estimate) = pkt.as_any().downcast_ref::<webrtc::rtcp::payload_feedbacks::receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate>() {
                        if estimate.bitrate.is_finite() && estimate.bitrate >= 0.0 { remb = Some(estimate.bitrate); let mut q=feedback_quality.lock().unwrap(); q.remb_bps=Some(estimate.bitrate as f64); q.remb_at=Some(Instant::now()); }
                    }
                    if pkt.as_any().downcast_ref::<PictureLossIndication>().is_some()
                        || pkt.as_any().downcast_ref::<FullIntraRequest>().is_some()
                    {
                        pli_cnt.fetch_add(1, Ordering::SeqCst);
                        force_kf.store(true, Ordering::SeqCst);
                    }
                }
                if last_log.elapsed() >= Duration::from_secs(5) {
                    crate::capture::log_capture_diag(Some(&feedback_app), &format!("screen_rtcp receiver_reports={} fraction_lost_u8={:?} remb_bps={:?} pli_fir={} nack_reports={}", receiver_reports, reported_loss, remb, pli_cnt.load(Ordering::Relaxed), nack_reports));
                    last_log = Instant::now();
                }
            }
        });

        if let Some(ref audio_track) = session.audio_track {
            let audio_sender = pc
                .add_track(Arc::clone(audio_track) as Arc<dyn TrackLocal + Send + Sync>)
                .await
                .map_err(|e| format!("add audio track: {e}"))?;
            tokio::spawn(async move { while audio_sender.read_rtcp().await.is_ok() {} });
        }

        let ice_session_id = Arc::new(Mutex::new(None::<String>));
        let callback_session_id = ice_session_id.clone();
        let local_gate = gate.clone();
        let app_ice = app.clone();
        let pid_ice = peer_id.clone();
        pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
            let session_id = callback_session_id.clone();
            let gate = local_gate.clone();
            let app_c = app_ice.clone();
            let pid_c = pid_ice.clone();
            Box::pin(async move {
                if let Some(cand) = c {
                    if !super::p2p::direct(&cand.typ.to_string()) { gate.reject(); return; }
                    crate::capture::log_capture_diag(Some(&app_c), &format!("screen_sender local_candidate type={}", cand.typ));
                    if let Ok(init) = cand.to_json() {
                        let _ = app_c.emit(
                            "native-screen-ice",
                            NativeScreenIceEvent {
                                sdp_session_id: session_id.lock().unwrap().clone(),
                                peer_id: pid_c,
                                candidate: init.candidate,
                                sdp_mid: init.sdp_mid,
                                sdp_mline_index: init.sdp_mline_index,
                            },
                        );
                    }
                }
            })
        }));

        let force_kf_conn = Arc::clone(&session.force_keyframe);
        let state_gate = gate.clone();
        let app_state = app.clone();
        let pid_state = peer_id.clone();
        pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
            crate::capture::log_capture_diag(Some(&app_state), &format!("screen_sender peer={} connection={}", pid_state, s));
            let gate = state_gate.clone(); let force = force_kf_conn.clone();
            Box::pin(async move {
                if s == RTCPeerConnectionState::Connected && gate.allowed().await { force.store(true, Ordering::SeqCst); }
            })
        }));

        let offer = pc
            .create_offer(None)
            .await
            .map_err(|e| format!("create_offer: {e}"))?;
        *ice_session_id.lock().unwrap() = offer.sdp.lines().find_map(|line| {
            let mut fields = line.strip_prefix("o=")?.split_whitespace();
            fields.next()?;
            let id = fields.next()?;
            (id.len() <= 64 && !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then(|| id.to_string())
        });
        pc.set_local_description(offer.clone())
            .await
            .map_err(|e| format!("set_local_description: {e}"))?;

        {
            let diagnostics = monitor_screen_peer(&pc, app.clone(), peer_id.clone(), ice_session_id.lock().unwrap().clone(), gate.clone(), quality.clone(), session.experiment_bitrate.clone());
            let operations = session.peer_operations.lock().await;
            let mut peers = session.peers.lock().await;
            if session.stop_flag.load(Ordering::SeqCst) || operations.get(&peer_id) != Some(&operation) {
                diagnostics.abort();
                drop(peers);
                drop(operations);
                let _ = pc.close().await;
                return Err("Native screen share stopped while adding peer".into());
            }
            peers.insert(
                peer_id.clone(),
                PeerEntry {
                    screen_session_id: ice_session_id.lock().unwrap().clone(),
                    diagnostics,
                    gate,
                    quality,
                    pc,
                    remote_desc_set: false,
                    pending_remote_ice: Vec::new(),
                },
            );
            session
                .peer_count_atomic
                .store(peers.len() as u64, Ordering::SeqCst);
        }

        let offer_ev = NativeScreenOfferEvent {
            peer_id,
            sdp: offer.sdp,
            sdp_type: "offer".to_string(),
        };
        Ok(offer_ev)
    }

    pub async fn remove_peer(&self, peer_id: &str) {
        let session_opt = { self.active.lock().unwrap().clone() };
        if let Some(session) = session_opt {
            let old_pc = {
                let mut operations = session.peer_operations.lock().await;
                *operations.entry(peer_id.to_owned()).or_default() += 1;
                let mut peers = session.peers.lock().await;
                let removed = peers.remove(peer_id).map(|e| Arc::clone(&e.pc));
                session
                    .peer_count_atomic
                    .store(peers.len() as u64, Ordering::SeqCst);
                removed
            };
            if let Some(pc) = old_pc {
                let _ = pc.close().await;
            }
        }
    }

    pub async fn handle_answer(&self, peer_id: &str, sdp: String, screen_session_id: Option<String>) -> Result<(), String> {
        crate::capture::log_capture_diag(None, &format!("screen_sender peer={} answer_received", peer_id));
        let session = {
            self.active
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "No active native screen share".to_string())?
        };
        if super::p2p::sdp(&sdp).is_err() {
            self.remove_peer(peer_id).await;
            return Err(super::p2p::ERROR.into());
        }
        let ans = RTCSessionDescription::answer(sdp).map_err(|e| format!("bad answer sdp: {e}"))?;

        let Some(pc) = screen_peer_for_session(&session.peers, peer_id, &screen_session_id).await? else {
            crate::capture::log_capture_diag(None, "screen_sender stale_answer_ignored");
            return Ok(());
        };

        if let Err(e) = pc.set_remote_description(ans).await {
            crate::capture::log_capture_diag(None, "screen_sender answer_rejected");
            return Err(format!("set_remote_description: {e}"));
        }
        let queued_ice = commit_screen_answer(&session.peers, peer_id, &pc).await?;
        crate::capture::log_capture_diag(None, &format!("screen_sender peer={} answer_applied", peer_id));
        crate::capture::log_capture_diag(None, &format!("screen_sender answer_queued_ice count={}", queued_ice.len()));
        for cand in queued_ice {
            if pc.add_ice_candidate(cand).await.is_err() {
                crate::capture::log_capture_diag(None, "screen_sender queued_ice_rejected");
            }
        }
        session.force_keyframe.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub async fn handle_ice(
        &self,
        peer_id: &str,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_mline_index: Option<u16>,
        screen_session_id: Option<String>,
    ) -> Result<(), String> {
        if super::p2p::candidate(&candidate).is_err() {
            self.remove_peer(peer_id).await;
            return Err(super::p2p::ERROR.into());
        }
        let candidate_type = candidate.split_whitespace().skip_while(|token| *token != "typ").nth(1)
            .filter(|kind| ["host", "srflx", "prflx", "relay"].contains(kind)).unwrap_or("unknown");
        crate::capture::log_capture_diag(None, &format!("screen_sender remote_candidate type={} mdns={}",
            candidate_type, candidate.contains(".local")));
        let session = {
            self.active
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "No active native screen share".to_string())?
        };
        let init = RTCIceCandidateInit {
            candidate,
            sdp_mid,
            sdp_mline_index,
            username_fragment: None,
        };

        let pc_opt = {
            let mut peers = session.peers.lock().await;
            let entry = peers
                .get_mut(peer_id)
                .ok_or_else(|| format!("Unknown screen peer: {peer_id}"))?;
            if screen_session_id.is_some() && entry.screen_session_id != screen_session_id {
                crate::capture::log_capture_diag(None, "screen_sender stale_ice_ignored");
                return Ok(());
            }
            if entry.remote_desc_set {
                Some(Arc::clone(&entry.pc))
            } else {
                if entry.pending_remote_ice.len() >= 256 {
                    crate::capture::log_capture_diag(None, "screen_sender remote_ice_queue_full");
                    return Err("Screen ICE queue full".into());
                }
                entry.pending_remote_ice.push(init.clone());
                crate::capture::log_capture_diag(None, &format!("screen_sender remote_ice_queued count={}", entry.pending_remote_ice.len()));
                None
            }
        };

        if let Some(pc) = pc_opt {
            if let Err(e) = pc.add_ice_candidate(init).await {
                crate::capture::log_capture_diag(None, "screen_sender remote_ice_rejected");
                return Err(format!("add_ice_candidate: {e}"));
            }
        }
        Ok(())
    }
}

fn convert_ice_servers(configs: &[IceServerConfig]) -> Vec<RTCIceServer> {
    let servers = configs
        .iter()
        .filter_map(|cfg| {
            let urls: Vec<String> = match &cfg.urls {
                serde_json::Value::String(s) => vec![s.clone()],
                serde_json::Value::Array(arr) => arr
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect(),
                _ => Vec::new(),
            };
            if urls.is_empty() {
                return None;
            }
            Some(RTCIceServer {
                urls,
                username: cfg.username.clone().unwrap_or_default(),
                credential: cfg.credential.clone().unwrap_or_default(),
                ..Default::default()
            })
        })
        .collect();
    super::p2p::servers(servers)
}

pub(crate) fn build_webrtc_api(include_audio: bool) -> webrtc::error::Result<webrtc::api::API> {
    build_screen_webrtc_api(include_audio, None)
}
fn build_screen_webrtc_api(include_audio: bool, gate: Option<Arc<super::p2p::Gate>>) -> webrtc::error::Result<webrtc::api::API> {
    let mut m = MediaEngine::default();
    let video_rtcp_feedback = vec![
        RTCPFeedback {
            typ: "goog-remb".to_owned(),
            parameter: "".to_owned(),
        },
        RTCPFeedback {
            typ: "ccm".to_owned(),
            parameter: "fir".to_owned(),
        },
        RTCPFeedback {
            typ: "nack".to_owned(),
            parameter: "".to_owned(),
        },
        RTCPFeedback {
            typ: "nack".to_owned(),
            parameter: "pli".to_owned(),
        },
    ];

    for (pt, fmtp) in [
        (
            102u8,
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
        ),
        (
            125u8,
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        ),
        (
            106u8,
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f",
        ),
        (
            118u8,
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640028",
        ),
        (
            123u8,
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032",
        ),
    ] {
        m.register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_H264.to_owned(),
                    clock_rate: 90000,
                    channels: 0,
                    sdp_fmtp_line: fmtp.to_owned(),
                    rtcp_feedback: video_rtcp_feedback.clone(),
                },
                payload_type: pt,
                ..Default::default()
            },
            RTPCodecType::Video,
        )?;
    }

    if include_audio {
        m.register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_owned(),
                    clock_rate: 48000,
                    channels: 2,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                    rtcp_feedback: vec![],
                },
                payload_type: 111,
                ..Default::default()
            },
            RTPCodecType::Audio,
        )?;
    }

    let mut registry = Registry::new();
    // Nearest the transport: NACK/report writers must also go through the gate.
    if let Some(gate) = gate { registry.add(Box::new(super::p2p::Builder(gate))); }
    registry = register_default_interceptors(registry, &mut m)?;

    Ok(APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(registry)
        .build())
}

#[allow(clippy::too_many_arguments)]
fn run_capture_encode_loop(
    app: AppHandle,
    session: Arc<SessionShared>,
    target: CaptureTarget,
    target_pid: u32,
    source_id: String,
    mut preset: ScreenQualityPreset,
    cursor_enabled: bool,
    include_app_audio: bool,
    force_software: bool,
    rt_handle: tokio::runtime::Handle,
    ready_tx: tokio::sync::oneshot::Sender<Result<NativeCaptureStatus, String>>,
) {
    session.capture_thread_alive.store(true, Ordering::SeqCst);

    crate::capture::log_capture_diag(
        Some(&app),
        &format!(
            "Starting capture loop: source_id={}, preset={:?}, cursor={}, app_audio={}, force_sw={}",
            source_id, preset, cursor_enabled, include_app_audio, force_software
        ),
    );

    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) {
            let err_msg = format!("MFStartup failed: {e:?}");
            crate::capture::log_capture_diag(Some(&app), &err_msg);
            let _ = ready_tx.send(Err(err_msg));
            session.capture_thread_alive.store(false, Ordering::SeqCst);
            CoUninitialize();
            RoUninitialize();
            return;
        }
    }

    let adapter_idx = match &target {
        CaptureTarget::DxgiMonitor { adapter_index, .. } => *adapter_index,
        _ => 0,
    };

    let (device, context) = match create_d3d11_on_adapter(adapter_idx) {
        Ok(d) => {
            crate::capture::log_capture_diag(Some(&app), &format!("D3D11CreateDevice succeeded on adapter {}", adapter_idx));
            d
        }
        Err(e) => {
            let err_msg = format!("D3D11CreateDevice failed on adapter {}: {e:?}", adapter_idx);
            crate::capture::log_capture_diag(Some(&app), &err_msg);
            let _ = ready_tx.send(Err(err_msg));
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
                RoUninitialize();
            }
            session.capture_thread_alive.store(false, Ordering::SeqCst);
            return;
        }
    };

    let mut capturer = match HybridCapturer::open(&device, &target, cursor_enabled) {
        Ok(c) => {
            crate::capture::log_capture_diag(Some(&app), &format!("HybridCapturer::open succeeded: backend={}", c.backend_used()));
            c
        }
        Err(e) => {
            let err_msg = format!("Capture open failed: {e:?}");
            crate::capture::log_capture_diag(Some(&app), &err_msg);
            let _ = ready_tx.send(Err(err_msg));
            drop(context);
            drop(device);
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
                RoUninitialize();
            }
            session.capture_thread_alive.store(false, Ordering::SeqCst);
            return;
        }
    };

    let mut spec = preset.spec();
    let (src_w, src_h) = capturer.src_size();
    let (mut dst_w, mut dst_h) = fit_even_resolution(src_w, src_h, spec.width, spec.height);

    if let Err(message) = super::health::validate_encoder_dimensions(dst_w, dst_h) {
        crate::capture::log_capture_diag(Some(&app), &format!("screen_capture rejected_dimensions={}x{}", dst_w, dst_h));
        let _ = ready_tx.send(Err(message));
        capturer.close();
        drop(context); drop(device);
        unsafe { let _ = MFShutdown(); CoUninitialize(); RoUninitialize(); }
        session.capture_thread_alive.store(false, Ordering::SeqCst);
        return;
    }
    let mut converter = match GpuBgraToNv12::new(&device, &context, src_w, src_h, dst_w, dst_h) {
        Ok(c) => {
            crate::capture::log_capture_diag(Some(&app), &format!("GpuBgraToNv12 initialized: {}x{} -> {}x{}", src_w, src_h, dst_w, dst_h));
            c
        }
        Err(e) => {
            let err_msg = format!("GpuBgraToNv12 failed: {e:?}");
            crate::capture::log_capture_diag(Some(&app), &err_msg);
            let _ = ready_tx.send(Err(err_msg));
            capturer.close();
            drop(context);
            drop(device);
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
                RoUninitialize();
            }
            session.capture_thread_alive.store(false, Ordering::SeqCst);
            return;
        }
    };

    let mut encoder = match MfH264Encoder::new(
        &device,
        dst_w,
        dst_h,
        spec.fps,
        spec.initial_bitrate_bps,
        force_software,
    ) {
        Ok(enc) => {
            crate::capture::log_capture_diag(Some(&app), &format!("MfH264Encoder initialized: {} (hw={}, d3d_zc={})", enc.encoder_name, enc.is_hardware, enc.uses_d3d_zero_copy()));
            enc
        }
        Err(e) => {
            let err_msg = format!("MfH264Encoder failed: {e:?}");
            crate::capture::log_capture_diag(Some(&app), &err_msg);
            let _ = ready_tx.send(Err(err_msg));
            drop(converter);
            capturer.close();
            drop(context);
            drop(device);
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
                RoUninitialize();
            }
            session.capture_thread_alive.store(false, Ordering::SeqCst);
            return;
        }
    };

    let stream_epoch = std::time::SystemTime::now();
    let mut audio_thread: Option<std::thread::JoinHandle<()>> = None;
    let mut app_audio_active = false;
    let mut app_audio_mode = "disabled".to_string();

    if include_app_audio {
        if let Some(ref audio_track) = session.audio_track {
            let mode = match &target {
                CaptureTarget::WgcWindow { .. } if target_pid > 0 => {
                    LoopbackMode::IncludeProcessTree { pid: target_pid }
                }
                _ => LoopbackMode::ExcludeSelfProcessTree {
                    self_pid: std::process::id(),
                },
            };
            match spawn_app_audio_thread(
                app.clone(),
                mode,
                Arc::clone(audio_track),
                Arc::clone(&session.stop_flag),
                rt_handle.clone(),
                stream_epoch,
            ) {
                Ok((handle, label)) => {
                    audio_thread = Some(handle);
                    app_audio_active = true;
                    app_audio_mode = label;
                }
                Err(e) => {
                    crate::capture::log_capture_diag(Some(&app), &format!("screen_audio active=false startup_failed={e}"));
                    let _ = app.emit(
                        "native-screen-error",
                        NativeScreenErrorEvent {
                            code: "WASAPI_LOOPBACK_UNAVAILABLE".to_string(),
                            message: e,
                            recoverable: true,
                        },
                    );
                }
            }
        }
    }

    let backend_used = capturer.backend_used().to_string();
    let borderless_ok = capturer.borderless_ok();

    let _ = ready_tx.send(Ok(NativeCaptureStatus {
        preview_session_id: session.preview.id,
        active: true,
        source_id,
        backend_used: backend_used.clone(),
        encoder_name: encoder.encoder_name.clone(),
        is_hardware: encoder.is_hardware,
        d3d_zero_copy: encoder.uses_d3d_zero_copy(),
        borderless_ok,
        app_audio_active,
        app_audio_mode,
        width: dst_w,
        height: dst_h,
        fps: spec.fps,
        bitrate_bps: spec.initial_bitrate_bps,
        profile_level_id: encoder.profile_level_id.clone(),
    }));

    let mut preview = super::preview::PreviewSampler::new();
    let mut frame_period = Duration::from_secs_f64(1.0 / (spec.fps.max(1) as f64));
    let mut ts_step = (10_000_000i64) / (spec.fps.max(1) as i64);
    let mut ts_100ns = 0i64;
    let mut last_cursor = cursor_enabled;
    let mut frames_captured = 0u64;
    let mut frames_encoded = 0u64;
    let mut frames_sent = 0u64;
    let mut total_bytes_sent = 0u64;
    let mut encode_ms_sum = 0.0f64;
    let mut encode_ms_count = 0u64;
    let mut recent_encode_ms = 0.0f64;
    let run_start = Instant::now();
    let mut next_tick = run_start;
    let mut last_stats_emit = run_start;
    let mut stats_payload_bytes = 0u64;
    let mut last_diag_emit = run_start;
    let (mut capture_errors, mut convert_errors, mut encode_errors, mut send_errors) = (0u64, 0u64, 0u64, 0u64);
    let mut ended_reason: Option<&'static str> = None;
    let mut last_capture_texture = Instant::now();
    let mut texture_generation = capturer.texture_generation();
    let mut capture_gap_since: Option<Instant> = None;
    let mut last_capture_hresult = 0i32;
    let mut previous_experiment = 0u32;

    while !session.stop_flag.load(Ordering::Relaxed) {
        // Before all stage-specific early returns: failures must not hide diagnostics.
        if last_diag_emit.elapsed() >= Duration::from_secs(5) {
            last_diag_emit = Instant::now();
            crate::capture::log_capture_diag(Some(&app), &format!(
                "screen_pipeline backend={} captured={} encoded={} sample_writes_ok={} sample_bytes_ok={} idr={} capture_errors={} convert_errors={} encode_errors={} send_errors={}",
                backend_used, frames_captured, frames_encoded, frames_sent, total_bytes_sent, encoder.idr_count,
                capture_errors, convert_errors, encode_errors, send_errors));
            crate::capture::log_capture_diag(Some(&app), &preview.diagnostics());
        }
        if last_capture_texture.elapsed()>=Duration::from_secs(5) && !capturer.recovering() && !capturer.recovery_failed() {
            if capturer.recover_monitor_stall() {
                preview.invalidate_source(&session.preview);
                crate::capture::log_capture_diag(Some(&app),"screen_capture recovery_started_by_watchdog");
            }
        }
        if capturer.recovery_failed() || (super::health::capture_stalled(last_capture_texture.elapsed()) && !capturer.recovering()) {
            crate::capture::log_capture_diag(Some(&app), &format!(
                "screen_capture stalled backend={} no_texture_ms={} capture_errors={} last_hresult=0x{:08X}",
                backend_used, last_capture_texture.elapsed().as_millis(), capture_errors, last_capture_hresult as u32));
            let _ = app.emit("native-screen-error", NativeScreenErrorEvent {
                code: "CAPTURE_STALLED".into(),
                message: "A captura não se recuperou após tentativas limitadas. Reinicie o compartilhamento; a conexão de rede pode continuar ativa.".into(),
                recoverable: false,
            });
            ended_reason = Some("capture_stalled");
            break;
        }
        if capturer.is_closed() {
            ended_reason = Some("target_closed");
            break;
        }

        let now = Instant::now();
        if now < next_tick {
            let sleep_dur = next_tick - now;
            if sleep_dur > Duration::from_millis(1) {
                std::thread::sleep(sleep_dur - Duration::from_millis(1));
            }
            while Instant::now() < next_tick {
                std::hint::spin_loop();
            }
        }
        next_tick += frame_period;
        if Instant::now() > next_tick + frame_period {
            next_tick = Instant::now() + frame_period;
        }

        // Dynamic quality preset change
        if let Some(new_preset) = session.pending_preset.lock().unwrap().take() {
            preset = new_preset;
            recent_encode_ms = 0.0;
            spec = preset.spec();
            let (cur_sw, cur_sh) = capturer.src_size();
            let (ndw, ndh) = fit_even_resolution(cur_sw, cur_sh, spec.width, spec.height);
            if let Err(e)=converter.ensure_sizes(cur_sw,cur_sh,ndw,ndh) {
                crate::capture::log_capture_diag(Some(&app),&format!("screen_capture preset_converter_failed hresult=0x{:08X}",e.code().0 as u32));
                let _=app.emit("native-screen-error",NativeScreenErrorEvent{code:"CONVERTER_RECONFIGURE_FAILED".into(),message:"Não foi possível aplicar a resolução solicitada.".into(),recoverable:false});
                ended_reason=Some("converter_reconfigure_failed");break;
            }
            let rate=session.experiment_bitrate.load(Ordering::Relaxed);
            let rate=if rate>0 {rate} else {spec.initial_bitrate_bps};
            if let Err(e)=encoder.reconfigure(&device,ndw,ndh,spec.fps,rate,session.force_software) {
                crate::capture::log_capture_diag(Some(&app),&format!("screen_capture preset_encoder_failed hresult=0x{:08X}",e.code().0 as u32));
                let _=app.emit("native-screen-error",NativeScreenErrorEvent{code:"ENCODER_RECONFIGURE_FAILED".into(),message:"Não foi possível aplicar o preset solicitado.".into(),recoverable:false});
                ended_reason=Some("encoder_reconfigure_failed");break;
            }
            dst_w=ndw;dst_h=ndh;
            frame_period=Duration::from_secs_f64(1.0/spec.fps.max(1) as f64);
            ts_step=10_000_000i64/spec.fps.max(1) as i64;
        }

        // Dynamic cursor toggle
        let desired_cursor = session.cursor_flag.load(Ordering::Relaxed);
        if desired_cursor != last_cursor {
            capturer.set_cursor_enabled(desired_cursor);
            last_cursor = desired_cursor;
        }

        // Dynamic adaptive bitrate (ICodecAPI or transparent MFT flush+reinit for AMD)
        let experiment = session.experiment_bitrate.load(Ordering::Relaxed);
        let explicit_transition = experiment != previous_experiment;
        previous_experiment = experiment;
        let desired_bitrate = if experiment > 0 { experiment } else { preset.clamp_bitrate(session.bitrate_target.load(Ordering::Relaxed)) };
        if desired_bitrate != encoder.current_bitrate_bps {
            if let Err(e) = encoder.set_bitrate(&device, desired_bitrate, explicit_transition) {
                crate::capture::log_capture_diag(Some(&app), &format!("screen_encoder bitrate_update_failed requested={} current={} hresult=0x{:08X}", desired_bitrate, encoder.current_bitrate_bps, e.code().0 as u32));
                let _=app.emit("native-screen-error",NativeScreenErrorEvent{code:"ENCODER_BITRATE_RECONFIGURE_FAILED".into(),message:"O encoder não conseguiu aplicar o perfil de bitrate. Reinicie o compartilhamento com o perfil oficial.".into(),recoverable:false});
                ended_reason=Some("encoder_reconfigure_failed");
                break;
            }
        }

        if session.force_keyframe.swap(false, Ordering::SeqCst) {
            let _ = encoder.force_keyframe();
        }

        let (tex_opt, _is_new) = match capturer.acquire_into_texture(&device, &context, 15) {
            Ok(res) => res,
            Err(e) => {
                eprintln!("[Capture] acquire_into_texture error: {e:?}");
                capture_errors += 1;
                capture_gap_since.get_or_insert_with(Instant::now);
                last_capture_hresult = e.code().0;
                if capture_errors.is_power_of_two() {
                    crate::capture::log_capture_diag(Some(&app), &format!("screen_capture error backend={} count={} hresult=0x{:08X}", backend_used, capture_errors, last_capture_hresult as u32));
                }
                continue;
            }
        };

        let generation = capturer.texture_generation();
        if generation != texture_generation {
            preview.invalidate_source(&session.preview);
            session.force_keyframe.store(true,Ordering::SeqCst);
            let accepted=encoder.force_keyframe();
            crate::capture::log_capture_diag(Some(&app),&format!("screen_capture recovery_keyframe_requested accepted={}",accepted));
            texture_generation=generation;
            crate::capture::log_capture_diag(Some(&app),&format!("screen_capture generation={} output={}x{} peer_preserved=true audio_preserved=true",generation,dst_w,dst_h));
        }
        let Some(bgra_tex) = tex_opt else {
            capture_gap_since.get_or_insert_with(Instant::now);
            continue;
        };
        if let Some(since)=capture_gap_since.take() {
            let gap=since.elapsed();
            ts_100ns=ts_100ns.saturating_add((gap.as_nanos()/100).min(i64::MAX as u128) as i64);
            // H264Payloader emits no packet for an empty payload, but the
            // packetizer advances its clock. Do not invent missing sequences.
            let track=Arc::clone(&session.video_track);
            let _=rt_handle.block_on(async move {track.write_sample(&Sample{data:Bytes::new(),duration:gap,..Default::default()}).await});
            crate::capture::log_capture_diag(Some(&app),&format!("screen_capture resumed_clock_gap_ms={}",gap.as_millis()));
        }
        last_capture_texture = Instant::now();
        frames_captured += 1;
        preview.tick(&device, &context, &bgra_tex, &session.preview, frame_period,
            Instant::now() > next_tick || recent_encode_ms > frame_period.as_secs_f64() * 650.0);

        let (cur_sw, cur_sh) = capturer.src_size();
        // Monitor mode changes affect only the converter input. Preserve the
        // negotiated output raster, FPS, bitrate, peer and audio session.
        let (target_w,target_h)=if capturer.is_monitor() {(dst_w,dst_h)} else {fit_even_resolution(cur_sw,cur_sh,spec.width,spec.height)};
        if super::health::validate_encoder_dimensions(target_w, target_h).is_err() {
            let _ = app.emit("native-screen-error", NativeScreenErrorEvent {
                code: "SOURCE_TOO_SMALL".into(),
                message: format!("A janela passou a {}x{}. Aumente a janela e reinicie o compartilhamento (mínimo 64x64).", cur_sw, cur_sh),
                recoverable: false,
            });
            ended_reason = Some("source_too_small");
            break;
        }
        if let Err(e)=converter.ensure_sizes(cur_sw,cur_sh,target_w,target_h) {
            crate::capture::log_capture_diag(Some(&app),&format!("screen_capture converter_reconfigure_failed hresult=0x{:08X}",e.code().0 as u32));
            let _=app.emit("native-screen-error",NativeScreenErrorEvent{code:"CONVERTER_RECONFIGURE_FAILED".into(),message:"Não foi possível adaptar o conversor à nova imagem da captura.".into(),recoverable:false});
            ended_reason=Some("converter_reconfigure_failed");break;
        }
        if target_w!=dst_w || target_h!=dst_h {
            recent_encode_ms=0.0;
            if let Err(e)=encoder.reconfigure(&device,target_w,target_h,spec.fps,encoder.current_bitrate_bps,session.force_software) {
                crate::capture::log_capture_diag(Some(&app),&format!("screen_capture encoder_resize_failed hresult=0x{:08X}",e.code().0 as u32));
                let _=app.emit("native-screen-error",NativeScreenErrorEvent{code:"ENCODER_RECONFIGURE_FAILED".into(),message:"Não foi possível adaptar o encoder à nova imagem da janela.".into(),recoverable:false});
                ended_reason=Some("encoder_reconfigure_failed");break;
            }
            dst_w=target_w;dst_h=target_h;
        }

        if let Err(e) = converter.convert(&bgra_tex) {
            convert_errors += 1;
            eprintln!("[Capture] GPU BGRA->NV12 convert failed: {e:?}");
            continue;
        }

        let t_enc = Instant::now();
        let encoded = match encoder.encode_nv12_texture(&mut converter, ts_100ns) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[Capture] H.264 encode failed: {e:?}");
                encode_errors += 1;
                ts_100ns += ts_step;
                continue;
            }
        };
        let encode_ms = t_enc.elapsed().as_secs_f64() * 1000.0;
        recent_encode_ms = recent_encode_ms * 0.8 + encode_ms * 0.2;
        encode_ms_sum += encode_ms;
        encode_ms_count += 1;
        ts_100ns += ts_step;

        if encoded.annex_b.is_empty() {
            continue;
        }
        frames_encoded += 1;

        let sample_len = encoded.annex_b.len();
        let sample_ts =
            stream_epoch + Duration::from_nanos((ts_100ns.saturating_sub(ts_step).max(0) as u64) * 100);
        let sample = Sample {
            data: Bytes::from(encoded.annex_b),
            timestamp: sample_ts,
            duration: frame_period,
            ..Default::default()
        };

        // Encode Once -> TrackLocalStaticSample fans out to all 1..N connected peers
        let track_ref = Arc::clone(&session.video_track);
        let write_res = rt_handle.block_on(async move { track_ref.write_sample(&sample).await });
        if write_res.is_ok() {
            frames_sent += 1;
            total_bytes_sent += sample_len as u64;
        } else {
            send_errors += 1;
        }

        if last_stats_emit.elapsed() >= Duration::from_secs(1) {
            let encoded_interval_kbps = total_bytes_sent.saturating_sub(stats_payload_bytes) as f64 * 0.008 / last_stats_emit.elapsed().as_secs_f64().max(0.001);
            stats_payload_bytes = total_bytes_sent;
            last_stats_emit = Instant::now();
            let elapsed = run_start.elapsed().as_secs_f64().max(0.001);
            let stats = NativeScreenStats {
                encoder_name: encoder.encoder_name.clone(),
                is_hardware: encoder.is_hardware,
                d3d_zero_copy: encoder.uses_d3d_zero_copy(),
                backend_used: backend_used.clone(),
                borderless_ok,
                app_audio_active,
                preset: spec.name.to_string(),
                src_width: cur_sw,
                src_height: cur_sh,
                dst_width: dst_w,
                dst_height: dst_h,
                target_fps: spec.fps,
                requested_bitrate_bps: desired_bitrate,
                encoder_readback_bitrate_bps: encoder.property_readback["mean_bitrate"]["readback"].as_u64().and_then(|v|u32::try_from(v).ok()),
                encoded_payload_bitrate_kbps: encoded_interval_kbps,
                target_bitrate_bps: encoder.current_bitrate_bps,
                send_fps: (frames_sent as f64) / elapsed,
                send_bitrate_kbps: ((total_bytes_sent as f64) * 8.0) / elapsed / 1000.0,
                frames_captured,
                frames_encoded,
                frames_sent,
                idr_count: encoder.idr_count,
                pli_received: session.pli_count.load(Ordering::Relaxed),
                peer_count: session.peer_count_atomic.load(Ordering::Relaxed) as usize,
                bitrate_experiment_bps: session.experiment_bitrate.load(Ordering::Relaxed),
                bitrate_reinit_count: encoder.reinit_count,
                encode_avg_ms: if encode_ms_count > 0 {
                    encode_ms_sum / (encode_ms_count as f64)
                } else {
                    0.0
                },
            };
            let _ = app.emit("native-screen-stats", &stats);
        }
    }

    session.preview.close();
    session.stop_flag.store(true, Ordering::SeqCst);
    if let Some(j) = audio_thread {
        let _ = j.join();
    }

    encoder.shutdown();
    crate::capture::log_capture_diag(Some(&app), &preview.diagnostics());
    drop(preview);
    drop(encoder);
    drop(converter);
    capturer.close();
    drop(context);
    drop(device);
    unsafe {
        let _ = MFShutdown();
        CoUninitialize();
        RoUninitialize();
    }
    session.capture_thread_alive.store(false, Ordering::SeqCst);

    if let Some(reason) = ended_reason {
        let _ = app.emit(
            "native-screen-ended",
            NativeScreenEndedEvent {
                reason: reason.to_string(),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::wasapi_loopback::{
        LibOpusEncoder, OPUS_DEFAULT_BITRATE_BPS, OPUS_FRAME_SAMPLES_PER_CH,
        OPUS_FRAME_SAMPLES_TOTAL,
    };
    use opus_codec::{Channels, Decoder, SampleRate};
    use webrtc::track::track_remote::TrackRemote;

    #[tokio::test]
    async fn p2p_backend_override_cannot_configure_turn_on_screen_pc() {
        let input = vec![IceServerConfig { urls: serde_json::json!(["turn:invalid.example", "stun:invalid.example", "turns:invalid.example"]), username: Some("private".into()), credential: Some("private".into()) }];
        let servers = convert_ice_servers(&input);
        let gate = super::super::p2p::Gate::new();
        let api = build_screen_webrtc_api(true, Some(gate.clone())).unwrap();
        let pc = Arc::new(api.new_peer_connection(RTCConfiguration { ice_servers: servers, ..Default::default() }).await.unwrap());
        gate.attach(&pc);
        let config = pc.get_configuration().await;
        assert_eq!(config.ice_servers.len(), 1);
        assert_eq!(config.ice_servers[0].urls, ["stun:invalid.example"]);
        assert!(config.ice_servers[0].credential.is_empty());
        assert!(!gate.allowed().await);
        pc.close().await.unwrap();
    }

    #[test]
    fn test_negotiation_flags_never_copy_sensitive_sdp() {
        let flags = negotiation_flags("v=0\r\na=setup:active\r\na=ice-ufrag:PRIVATE\r\na=ice-pwd:PRIVATE\r\na=fingerprint:sha-256 PRIVATE\r\n");
        assert_eq!(flags["setup"], "active"); assert_eq!(flags["iceCredentialsPresent"], true);
        assert_eq!(flags["fingerprintPresent"], true); assert!(!flags.to_string().contains("PRIVATE"));
        assert!(negotiation_flags("a=setup:PRIVATE")["setup"].is_null());
        assert!(negotiation_flags("a=setup:active\r\na=setup:passive")["setup"].is_null());
    }

    #[test]
    fn test_screen_pending_ipc_and_answer_commit_never_retarget_replacement_pc() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let api = build_webrtc_api(true).unwrap();
            let old = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await.unwrap());
            let new = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await.unwrap());
            let entry = |pc: Arc<RTCPeerConnection>, id: &str| PeerEntry {
                pc, screen_session_id: Some(id.into()), remote_desc_set: false,
                pending_remote_ice: vec![RTCIceCandidateInit::default()],
                diagnostics: tokio::spawn(async {}), gate: super::super::p2p::Gate::new(),
                quality: Arc::new(Mutex::new(super::super::quality::NetworkEvidence::default())),
            };
            let peers = Arc::new(tokio::sync::Mutex::new(HashMap::from([("viewer".into(), entry(old.clone(), "1"))])));
            let mut held = peers.lock().await;
            let pending = {
                let peers = peers.clone();
                tokio::spawn(async move { screen_peer_for_session(&peers, "viewer", &Some("1".into())).await })
            };
            tokio::task::yield_now().await;
            held.insert("viewer".into(), entry(new.clone(), "2")); drop(held);
            assert!(pending.await.unwrap().unwrap().is_none(), "queued old IPC must not obtain the new PC");
            assert!(commit_screen_answer(&peers, "viewer", &old).await.is_err(), "in-flight old answer must not drain replacement ICE");
            let entries = peers.lock().await;
            assert!(!entries["viewer"].remote_desc_set);
            assert_eq!(entries["viewer"].pending_remote_ice.len(), 1); drop(entries);
            let current = screen_peer_for_session(&peers, "viewer", &Some("2".into())).await.unwrap().unwrap();
            assert!(Arc::ptr_eq(&current, &new));
            assert_eq!(commit_screen_answer(&peers, "viewer", &new).await.unwrap().len(), 1);
            old.close().await.unwrap(); new.close().await.unwrap();
        });
    }

    #[test]
    fn test_webrtc_loopback_opus_audio_and_h264_video_transport_and_lifecycle() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");

        rt.block_on(async {
            let sender_gate = super::super::p2p::Gate::new();
            let sender_api = build_screen_webrtc_api(true, Some(sender_gate.clone())).expect("sender P2P API");
            let receiver_api = build_webrtc_api(true).expect("receiver build_webrtc_api");

            let sender_pc = Arc::new(
                sender_api
                    .new_peer_connection(RTCConfiguration::default())
                    .await
                    .expect("sender pc"),
            );
            sender_gate.attach(&sender_pc);
            let receiver_pc = Arc::new(
                receiver_api
                    .new_peer_connection(RTCConfiguration::default())
                    .await
                    .expect("receiver pc"),
            );

            let video_track = Arc::new(TrackLocalStaticSample::new(
                RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_H264.to_owned(),
                    clock_rate: 90000,
                    channels: 0,
                    sdp_fmtp_line: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f".to_owned(),
                    rtcp_feedback: vec![],
                },
                "nexus-screen-video".to_owned(),
                "nexus-screen-stream".to_owned(),
            ));

            let audio_track = Arc::new(TrackLocalStaticSample::new(
                RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_owned(),
                    clock_rate: 48000,
                    channels: 2,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                    rtcp_feedback: vec![],
                },
                "nexus-screen-audio".to_owned(),
                "nexus-screen-stream".to_owned(),
            ));

            sender_pc
                .add_track(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)
                .await
                .expect("add video track");
            sender_pc
                .add_track(Arc::clone(&audio_track) as Arc<dyn TrackLocal + Send + Sync>)
                .await
                .expect("add audio track");

            let (s_ice_tx, mut s_ice_rx) = tokio::sync::mpsc::unbounded_channel();
            let (r_ice_tx, mut r_ice_rx) = tokio::sync::mpsc::unbounded_channel();

            sender_pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
                let tx = s_ice_tx.clone();
                Box::pin(async move {
                    if let Some(cand) = c {
                        if let Ok(init) = cand.to_json() {
                            let _ = tx.send(init);
                        }
                    }
                })
            }));

            receiver_pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
                let tx = r_ice_tx.clone();
                Box::pin(async move {
                    if let Some(cand) = c {
                        if let Ok(init) = cand.to_json() {
                            let _ = tx.send(init);
                        }
                    }
                })
            }));

            let audio_rtp_rx = Arc::new(AtomicU64::new(0));
            let audio_decoded_frames = Arc::new(AtomicU64::new(0));
            let video_rtp_rx = Arc::new(AtomicU64::new(0));

            let a_cnt = Arc::clone(&audio_rtp_rx);
            let a_dec_cnt = Arc::clone(&audio_decoded_frames);
            let v_cnt = Arc::clone(&video_rtp_rx);
            let video_timing=Arc::new(Mutex::new(Vec::<(u32,u16)>::new()));
            let received_timing=video_timing.clone();

            receiver_pc.on_track(Box::new(move |track: Arc<TrackRemote>, _, _| {
                let a_cnt = Arc::clone(&a_cnt);
                let a_dec_cnt = Arc::clone(&a_dec_cnt);
                let v_cnt = Arc::clone(&v_cnt);
                let received_timing=received_timing.clone();
                Box::pin(async move {
                    let mime = track.codec().capability.mime_type.to_ascii_lowercase();
                    if mime.contains("opus") {
                        tokio::spawn(async move {
                            let mut dec = Decoder::new(SampleRate::Hz48000, Channels::Stereo)
                                .expect("receiver Opus Decoder::new");
                            let mut pcm_out = vec![0.0f32; OPUS_FRAME_SAMPLES_TOTAL];
                            while let Ok((rtp_pkt, _)) = track.read_rtp().await {
                                a_cnt.fetch_add(1, Ordering::SeqCst);
                                if !rtp_pkt.payload.is_empty() {
                                    if let Ok(samples) =
                                        dec.decode_float(&rtp_pkt.payload, &mut pcm_out, false)
                                    {
                                        if samples == OPUS_FRAME_SAMPLES_PER_CH {
                                            a_dec_cnt.fetch_add(1, Ordering::SeqCst);
                                        }
                                    }
                                }
                            }
                        });
                    } else if mime.contains("h264") {
                        tokio::spawn(async move {
                            while let Ok((rtp_pkt, _)) = track.read_rtp().await {
                                received_timing.lock().unwrap().push((rtp_pkt.header.timestamp,rtp_pkt.header.sequence_number));
                                v_cnt.fetch_add(1, Ordering::SeqCst);
                            }
                        });
                    }
                })
            }));

            let (conn_tx, conn_rx) = tokio::sync::oneshot::channel::<()>();
            let conn_tx = Arc::new(Mutex::new(Some(conn_tx)));
            sender_pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
                if s == RTCPeerConnectionState::Connected {
                    if let Some(tx) = conn_tx.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                }
                Box::pin(async {})
            }));

            let offer = sender_pc.create_offer(None).await.expect("create_offer");
            sender_pc
                .set_local_description(offer.clone())
                .await
                .expect("sender set_local_description");
            receiver_pc
                .set_remote_description(offer)
                .await
                .expect("receiver set_remote_description");

            let answer = receiver_pc.create_answer(None).await.expect("create_answer");
            receiver_pc
                .set_local_description(answer.clone())
                .await
                .expect("receiver set_local_description");
            sender_pc
                .set_remote_description(answer)
                .await
                .expect("sender set_remote_description");

            let r_pc_for_ice = Arc::clone(&receiver_pc);
            let ice_fwd_1 = tokio::spawn(async move {
                while let Some(cand) = s_ice_rx.recv().await {
                    let _ = r_pc_for_ice.add_ice_candidate(cand).await;
                }
            });
            let s_pc_for_ice = Arc::clone(&sender_pc);
            let ice_fwd_2 = tokio::spawn(async move {
                while let Some(cand) = r_ice_rx.recv().await {
                    let _ = s_pc_for_ice.add_ice_candidate(cand).await;
                }
            });

            tokio::time::timeout(Duration::from_secs(5), conn_rx)
                .await
                .expect("WebRTC loopback connection timed out")
                .expect("conn_rx closed");

            let mut opus_enc =
                LibOpusEncoder::new(OPUS_DEFAULT_BITRATE_BPS).expect("LibOpusEncoder::new");
            let stream_epoch = std::time::SystemTime::now();

            // Minimal valid H.264 Annex-B SPS + PPS + IDR slice
            let h264_idr: Vec<u8> = vec![
                0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f, 0xe9, 0x01, 0x40, 0x7b, 0x20,
                0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80,
                0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21, 0xa0,
            ];

            for frame_idx in 0u64..15 {
                let mut pcm = Vec::with_capacity(OPUS_FRAME_SAMPLES_TOTAL);
                for i in 0..OPUS_FRAME_SAMPLES_PER_CH {
                    let t = ((frame_idx as usize * OPUS_FRAME_SAMPLES_PER_CH + i) as f32) / 48_000.0;
                    let s = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.35;
                    pcm.push(s);
                    pcm.push(s);
                }
                let opus_pkt = opus_enc.encode_frame_f32(&pcm).expect("encode_frame_f32");
                let ts = stream_epoch + Duration::from_millis(frame_idx * 20);
                audio_track
                    .write_sample(&Sample {
                        data: Bytes::from(opus_pkt),
                        timestamp: ts,
                        duration: Duration::from_millis(20),
                        ..Default::default()
                    })
                    .await
                    .expect("write audio sample");

                if frame_idx < 10 {
                    if frame_idx==7 {
                        video_track.write_sample(&Sample{data:Bytes::new(),duration:Duration::from_secs(2),..Default::default()}).await.expect("advance capture-gap clock without RTP");
                    }
                    video_track
                        .write_sample(&Sample {
                            data: Bytes::from(h264_idr.clone()),
                            timestamp: stream_epoch + Duration::from_millis(frame_idx * 33),
                            duration: Duration::from_millis(33),
                            ..Default::default()
                        })
                        .await
                        .expect("write video sample");
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }

            let wait_deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < wait_deadline {
                if audio_rtp_rx.load(Ordering::SeqCst) >= 10
                    && audio_decoded_frames.load(Ordering::SeqCst) >= 10
                    && video_rtp_rx.load(Ordering::SeqCst) >= 5
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }

            let a_rx = audio_rtp_rx.load(Ordering::SeqCst);
            let a_dec = audio_decoded_frames.load(Ordering::SeqCst);
            let v_rx = video_rtp_rx.load(Ordering::SeqCst);

            assert!(a_rx >= 10, "expected >= 10 Opus RTP packets, got {a_rx}");
            assert!(
                a_dec >= 10,
                "expected >= 10 decoded Opus frames, got {a_dec}"
            );
            assert!(v_rx >= 5, "expected >= 5 H.264 RTP packets, got {v_rx}");

            let timing=video_timing.lock().unwrap().clone();
            assert!(timing.windows(2).any(|w|w[1].0.wrapping_sub(w[0].0)>=180_000),"2s video gap must advance the RTP clock");
            assert!(timing.windows(2).all(|w|w[1].1.wrapping_sub(w[0].1)==1),"clock gap must not invent missing RTP sequence numbers");
            assert_eq!(sender_pc.connection_state(),RTCPeerConnectionState::Connected);
            assert_eq!(receiver_pc.connection_state(),RTCPeerConnectionState::Connected);
            println!("CAPTURE_GAP_LOOPBACK audio_frames={} video_packets={} peers_preserved=true rtp_clock_gap_ms=2000 artificial_sequence_gaps=0",a_dec,v_rx);
            // Lifecycle: clean stop and release
            sender_pc.close().await.expect("sender_pc.close");
            receiver_pc.close().await.expect("receiver_pc.close");
            ice_fwd_1.abort();
            ice_fwd_2.abort();

            assert_eq!(sender_pc.connection_state(), RTCPeerConnectionState::Closed);
            assert_eq!(
                receiver_pc.connection_state(),
                RTCPeerConnectionState::Closed
            );
        });
    }
}
