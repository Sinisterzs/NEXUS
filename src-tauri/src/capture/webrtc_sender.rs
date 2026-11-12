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
    pc: Arc<RTCPeerConnection>,
    remote_desc_set: bool,
    pending_remote_ice: Vec<RTCIceCandidateInit>,
}

struct SessionShared {
    video_track: Arc<TrackLocalStaticSample>,
    audio_track: Option<Arc<TrackLocalStaticSample>>,
    include_app_audio: bool,
    force_software: bool,
    stop_flag: Arc<AtomicBool>,
    force_keyframe: Arc<AtomicBool>,
    cursor_flag: Arc<AtomicBool>,
    bitrate_target: Arc<AtomicU32>,
    pending_preset: Mutex<Option<ScreenQualityPreset>>,
    pli_count: Arc<AtomicU64>,
    peers: tokio::sync::Mutex<HashMap<String, PeerEntry>>,
    peer_count_atomic: Arc<AtomicU64>,
    default_ice_servers: Mutex<Vec<RTCIceServer>>,
    capture_thread_alive: Arc<AtomicBool>,
    capture_join: Mutex<Option<std::thread::JoinHandle<()>>>,
}

pub struct NativeScreenManager {
    active: Arc<Mutex<Option<Arc<SessionShared>>>>,
}

impl NativeScreenManager {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(None)),
        }
    }

    pub fn shutdown_sync(&self) {
        let session_opt = { self.active.lock().unwrap().take() };
        if let Some(session) = session_opt {
            session.stop_flag.store(true, Ordering::SeqCst);
            let join_opt = { session.capture_join.lock().unwrap().take() };
            if let Some(j) = join_opt {
                let _ = j.join();
            }
            if let Ok(mut peers) = session.peers.try_lock() {
                let drained: Vec<_> = peers.drain().map(|(_, e)| e.pc).collect();
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
                sdp_fmtp_line: "".to_owned(),
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
            video_track,
            audio_track,
            include_app_audio: options.include_app_audio,
            force_software: options.force_software,
            stop_flag: Arc::new(AtomicBool::new(false)),
            force_keyframe: Arc::new(AtomicBool::new(false)),
            cursor_flag: Arc::new(AtomicBool::new(options.cursor_enabled)),
            bitrate_target: Arc::new(AtomicU32::new(spec.initial_bitrate_bps)),
            pending_preset: Mutex::new(None),
            pli_count: Arc::new(AtomicU64::new(0)),
            peers: tokio::sync::Mutex::new(HashMap::new()),
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
                session.stop_flag.store(true, Ordering::SeqCst);
                if let Some(j) = session.capture_join.lock().unwrap().take() {
                    let _ = j.join();
                }
                Err(e)
            }
            Err(_) => {
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
            session.stop_flag.store(true, Ordering::SeqCst);

            let pcs: Vec<Arc<RTCPeerConnection>> = {
                let mut peers = session.peers.lock().await;
                let list = peers.drain().map(|(_, e)| e.pc).collect();
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
        let old_pc = {
            let mut peers = session.peers.lock().await;
            peers.remove(&peer_id).map(|e| e.pc)
        };
        if let Some(pc) = old_pc {
            let _ = pc.close().await;
        }

        let rtc_ice = match ice_servers {
            Some(list) if !list.is_empty() => convert_ice_servers(&list),
            _ => session.default_ice_servers.lock().unwrap().clone(),
        };

        let api = build_webrtc_api(session.include_app_audio)
            .map_err(|e| format!("build_webrtc_api: {e}"))?;
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration {
                ice_servers: rtc_ice,
                ..Default::default()
            })
            .await
            .map_err(|e| format!("new_peer_connection: {e}"))?,
        );

        let video_sender = pc
            .add_track(Arc::clone(&session.video_track) as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .map_err(|e| format!("add video track: {e}"))?;

        let force_kf = Arc::clone(&session.force_keyframe);
        let pli_cnt = Arc::clone(&session.pli_count);
        tokio::spawn(async move {
            while let Ok((pkts, _)) = video_sender.read_rtcp().await {
                for pkt in pkts {
                    if pkt.as_any().downcast_ref::<PictureLossIndication>().is_some()
                        || pkt.as_any().downcast_ref::<FullIntraRequest>().is_some()
                    {
                        pli_cnt.fetch_add(1, Ordering::SeqCst);
                        force_kf.store(true, Ordering::SeqCst);
                    }
                }
            }
        });

        if let Some(ref audio_track) = session.audio_track {
            let _ = pc
                .add_track(Arc::clone(audio_track) as Arc<dyn TrackLocal + Send + Sync>)
                .await
                .map_err(|e| format!("add audio track: {e}"))?;
        }

        let app_ice = app.clone();
        let pid_ice = peer_id.clone();
        pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
            let app_c = app_ice.clone();
            let pid_c = pid_ice.clone();
            Box::pin(async move {
                if let Some(cand) = c {
                    if let Ok(init) = cand.to_json() {
                        let _ = app_c.emit(
                            "native-screen-ice",
                            NativeScreenIceEvent {
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
        pc.on_peer_connection_state_change(Box::new(move |s: RTCPeerConnectionState| {
            if s == RTCPeerConnectionState::Connected {
                force_kf_conn.store(true, Ordering::SeqCst);
            }
            Box::pin(async {})
        }));

        let offer = pc
            .create_offer(None)
            .await
            .map_err(|e| format!("create_offer: {e}"))?;
        pc.set_local_description(offer.clone())
            .await
            .map_err(|e| format!("set_local_description: {e}"))?;

        {
            let mut peers = session.peers.lock().await;
            peers.insert(
                peer_id.clone(),
                PeerEntry {
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
        let _ = app.emit("native-screen-offer", &offer_ev);
        Ok(offer_ev)
    }

    pub async fn remove_peer(&self, peer_id: &str) {
        let session_opt = { self.active.lock().unwrap().clone() };
        if let Some(session) = session_opt {
            let old_pc = {
                let mut peers = session.peers.lock().await;
                let removed = peers.remove(peer_id).map(|e| e.pc);
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

    pub async fn handle_answer(&self, peer_id: &str, sdp: String) -> Result<(), String> {
        let session = {
            self.active
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "No active native screen share".to_string())?
        };
        let ans = RTCSessionDescription::answer(sdp).map_err(|e| format!("bad answer sdp: {e}"))?;

        let (pc, queued_ice) = {
            let mut peers = session.peers.lock().await;
            let entry = peers
                .get_mut(peer_id)
                .ok_or_else(|| format!("Unknown screen peer: {peer_id}"))?;
            entry.remote_desc_set = true;
            let ice: Vec<RTCIceCandidateInit> = entry.pending_remote_ice.drain(..).collect();
            (Arc::clone(&entry.pc), ice)
        };

        pc.set_remote_description(ans)
            .await
            .map_err(|e| format!("set_remote_description: {e}"))?;
        for cand in queued_ice {
            let _ = pc.add_ice_candidate(cand).await;
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
    ) -> Result<(), String> {
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
            if entry.remote_desc_set {
                Some(Arc::clone(&entry.pc))
            } else {
                entry.pending_remote_ice.push(init.clone());
                None
            }
        };

        if let Some(pc) = pc_opt {
            pc.add_ice_candidate(init)
                .await
                .map_err(|e| format!("add_ice_candidate: {e}"))?;
        }
        Ok(())
    }
}

fn convert_ice_servers(configs: &[IceServerConfig]) -> Vec<RTCIceServer> {
    configs
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
        .collect()
}

fn build_webrtc_api(include_audio: bool) -> webrtc::error::Result<webrtc::api::API> {
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

    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET) {
            let _ = ready_tx.send(Err(format!("MFStartup failed: {e:?}")));
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
        Ok(d) => d,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("D3D11CreateDevice failed: {e:?}")));
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
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("Capture open failed: {e:?}")));
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

    let mut converter = match GpuBgraToNv12::new(&device, &context, src_w, src_h, dst_w, dst_h) {
        Ok(c) => c,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("GpuBgraToNv12 failed: {e:?}")));
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
        Ok(enc) => enc,
        Err(e) => {
            let _ = ready_tx.send(Err(format!("MfH264Encoder failed: {e:?}")));
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
                    eprintln!("[Capture] App audio disabled: {e}");
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
    let run_start = Instant::now();
    let mut next_tick = run_start;
    let mut last_stats_emit = run_start;
    let mut ended_reason: Option<&'static str> = None;

    while !session.stop_flag.load(Ordering::Relaxed) {
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
            spec = preset.spec();
            let (cur_sw, cur_sh) = capturer.src_size();
            let (ndw, ndh) = fit_even_resolution(cur_sw, cur_sh, spec.width, spec.height);
            dst_w = ndw;
            dst_h = ndh;
            let _ = converter.ensure_sizes(cur_sw, cur_sh, dst_w, dst_h);
            if let Err(e) = encoder.reconfigure(
                &device,
                dst_w,
                dst_h,
                spec.fps,
                spec.initial_bitrate_bps,
                session.force_software,
            ) {
                let _ = app.emit(
                    "native-screen-error",
                    NativeScreenErrorEvent {
                        code: "ENCODER_RECONFIGURE_FAILED".to_string(),
                        message: format!("{e:?}"),
                        recoverable: true,
                    },
                );
            } else {
                frame_period = Duration::from_secs_f64(1.0 / (spec.fps.max(1) as f64));
                ts_step = (10_000_000i64) / (spec.fps.max(1) as i64);
            }
        }

        // Dynamic cursor toggle
        let desired_cursor = session.cursor_flag.load(Ordering::Relaxed);
        if desired_cursor != last_cursor {
            capturer.set_cursor_enabled(desired_cursor);
            last_cursor = desired_cursor;
        }

        // Dynamic adaptive bitrate (ICodecAPI or transparent MFT flush+reinit for AMD)
        let desired_bitrate = preset.clamp_bitrate(session.bitrate_target.load(Ordering::Relaxed));
        if desired_bitrate != encoder.current_bitrate_bps {
            let _ = encoder.set_bitrate(&device, desired_bitrate, false);
        }

        if session.force_keyframe.swap(false, Ordering::SeqCst) {
            let _ = encoder.force_keyframe();
        }

        let (tex_opt, _is_new) = match capturer.acquire_into_texture(&device, &context, 15) {
            Ok(res) => res,
            Err(e) => {
                eprintln!("[Capture] acquire_into_texture error: {e:?}");
                continue;
            }
        };

        let Some(bgra_tex) = tex_opt else {
            continue;
        };
        frames_captured += 1;

        let (cur_sw, cur_sh) = capturer.src_size();
        let (target_w, target_h) = fit_even_resolution(cur_sw, cur_sh, spec.width, spec.height);
        if target_w != dst_w || target_h != dst_h {
            dst_w = target_w;
            dst_h = target_h;
            let _ = converter.ensure_sizes(cur_sw, cur_sh, dst_w, dst_h);
            let _ = encoder.reconfigure(
                &device,
                dst_w,
                dst_h,
                spec.fps,
                encoder.current_bitrate_bps,
                session.force_software,
            );
        }

        if let Err(e) = converter.convert(&bgra_tex) {
            eprintln!("[Capture] GPU BGRA->NV12 convert failed: {e:?}");
            continue;
        }

        let t_enc = Instant::now();
        let encoded = match encoder.encode_nv12_texture(&mut converter, ts_100ns) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[Capture] H.264 encode failed: {e:?}");
                ts_100ns += ts_step;
                continue;
            }
        };
        encode_ms_sum += t_enc.elapsed().as_secs_f64() * 1000.0;
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
        }

        if last_stats_emit.elapsed() >= Duration::from_secs(1) {
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
                target_bitrate_bps: encoder.current_bitrate_bps,
                send_fps: (frames_sent as f64) / elapsed,
                send_bitrate_kbps: ((total_bytes_sent as f64) * 8.0) / elapsed / 1000.0,
                frames_captured,
                frames_encoded,
                frames_sent,
                idr_count: encoder.idr_count,
                pli_received: session.pli_count.load(Ordering::Relaxed),
                peer_count: session.peer_count_atomic.load(Ordering::Relaxed) as usize,
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

    session.stop_flag.store(true, Ordering::SeqCst);
    if let Some(j) = audio_thread {
        let _ = j.join();
    }

    encoder.shutdown();
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

    #[test]
    fn test_webrtc_loopback_opus_audio_and_h264_video_transport_and_lifecycle() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");

        rt.block_on(async {
            let sender_api = build_webrtc_api(true).expect("sender build_webrtc_api");
            let receiver_api = build_webrtc_api(true).expect("receiver build_webrtc_api");

            let sender_pc = Arc::new(
                sender_api
                    .new_peer_connection(RTCConfiguration::default())
                    .await
                    .expect("sender pc"),
            );
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

            receiver_pc.on_track(Box::new(move |track: Arc<TrackRemote>, _, _| {
                let a_cnt = Arc::clone(&a_cnt);
                let a_dec_cnt = Arc::clone(&a_dec_cnt);
                let v_cnt = Arc::clone(&v_cnt);
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
                            while let Ok((_rtp_pkt, _)) = track.read_rtp().await {
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
