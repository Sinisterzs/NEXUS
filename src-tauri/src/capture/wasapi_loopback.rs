use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

pub const OPUS_SAMPLE_RATE: u32 = 48_000;
pub const OPUS_CHANNELS: u16 = 2;
pub const OPUS_FRAME_DURATION_MS: u64 = 20;
pub const OPUS_FRAME_SAMPLES_PER_CH: usize = 960; // 20 ms at 48 kHz
pub const OPUS_FRAME_SAMPLES_TOTAL: usize = OPUS_FRAME_SAMPLES_PER_CH * (OPUS_CHANNELS as usize);
pub const OPUS_DEFAULT_BITRATE_BPS: i32 = 128_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopbackMode {
    IncludeProcessTree { pid: u32 },
    ExcludeSelfProcessTree { self_pid: u32 },
}

impl LoopbackMode {
    pub fn as_label(&self) -> String {
        match self {
            Self::IncludeProcessTree { pid } => format!("include_pid:{pid}"),
            Self::ExcludeSelfProcessTree { self_pid } => format!("exclude_self:{self_pid}"),
        }
    }
}

/// Converts interleaved `f32` PCM from `(src_rate, src_channels)` into 48 kHz stereo `f32`.
pub fn resample_to_48k_stereo_f32(input: &[f32], src_rate: u32, src_channels: u16) -> Vec<f32> {
    if input.is_empty() || src_rate == 0 || src_channels == 0 {
        return Vec::new();
    }

    let ch = src_channels as usize;
    let src_frames = input.len() / ch;
    if src_frames == 0 {
        return Vec::new();
    }

    if src_rate == OPUS_SAMPLE_RATE && src_channels == OPUS_CHANNELS {
        return input[..src_frames * 2].to_vec();
    }

    // Step 1: Mix/map to stereo frames at src_rate
    let mut stereo_src = Vec::with_capacity(src_frames * 2);
    for frame in input.chunks_exact(ch) {
        let l = frame[0];
        let r = if ch >= 2 { frame[1] } else { frame[0] };
        stereo_src.push(l);
        stereo_src.push(r);
    }

    if src_rate == OPUS_SAMPLE_RATE {
        return stereo_src;
    }

    // Step 2: Linear interpolation resampling to 48 kHz
    let dst_frames = (((src_frames as u64) * (OPUS_SAMPLE_RATE as u64)) / (src_rate as u64)).max(1)
        as usize;
    let mut out = Vec::with_capacity(dst_frames * 2);
    let step = (src_frames as f64) / (dst_frames as f64);

    for i in 0..dst_frames {
        let pos = (i as f64) * step;
        let idx0 = (pos.floor() as usize).min(src_frames - 1);
        let idx1 = (idx0 + 1).min(src_frames - 1);
        let frac = (pos - (idx0 as f64)) as f32;

        let l0 = stereo_src[idx0 * 2];
        let r0 = stereo_src[idx0 * 2 + 1];
        let l1 = stereo_src[idx1 * 2];
        let r1 = stereo_src[idx1 * 2 + 1];

        out.push(l0 + (l1 - l0) * frac);
        out.push(r0 + (r1 - r0) * frac);
    }

    out
}

#[cfg(target_os = "windows")]
mod win_impl {
    use super::*;
    use bytes::Bytes;
    use opus_codec::{Application, Bitrate, Channels, Encoder, SampleRate};
    use std::mem::ManuallyDrop;
    use std::sync::{Condvar, Mutex};
    use std::time::Instant;
    use webrtc::media::Sample;
    use windows::core::{implement, Interface, Result, HRESULT};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, S_FALSE, S_OK};
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
        IAudioCaptureClient, IAudioClient, AUDIOCLIENT_ACTIVATION_PARAMS,
        AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        WAVEFORMATEX,
    };
    use windows::Win32::Media::Multimedia::WAVE_FORMAT_IEEE_FLOAT;
    use windows::Win32::System::Com::StructuredStorage::{
        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemAlloc, CoTaskMemFree, CoUninitialize, BLOB, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{CreateEventW, ResetEvent, WaitForSingleObject};
    use windows::Win32::System::Variant::VT_BLOB;

    const AUDCLNT_BUFFERFLAGS_SILENT: u32 = 0x2;
    const MAX_OPUS_PACKET_BYTES: usize = 4000;

    struct ComInitGuard(bool);

    impl ComInitGuard {
        fn new_multithreaded() -> Self {
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            Self(hr == S_OK || hr == S_FALSE)
        }
    }

    impl Drop for ComInitGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    struct EventHandleGuard(HANDLE);

    impl Drop for EventHandleGuard {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    #[allow(dead_code)]
    struct CoTaskMemGuard(*mut std::ffi::c_void);

    impl Drop for CoTaskMemGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CoTaskMemFree(Some(self.0));
                }
            }
        }
    }

    pub struct LibOpusEncoder {
        encoder: Encoder,
        scratch: Vec<u8>,
    }

    impl LibOpusEncoder {
        pub fn new(bitrate_bps: i32) -> std::result::Result<Self, String> {
            let mut encoder =
                Encoder::new(SampleRate::Hz48000, Channels::Stereo, Application::Audio)
                    .map_err(|e| format!("opus Encoder::new failed: {e:?}"))?;
            encoder
                .set_bitrate(Bitrate::Custom(bitrate_bps))
                .map_err(|e| format!("opus set_bitrate failed: {e:?}"))?;
            encoder
                .set_inband_fec(true)
                .map_err(|e| format!("opus set_inband_fec failed: {e:?}"))?;
            Ok(Self {
                encoder,
                scratch: vec![0u8; MAX_OPUS_PACKET_BYTES],
            })
        }

        pub fn encode_frame_f32(
            &mut self,
            pcm_960_stereo: &[f32],
        ) -> std::result::Result<Vec<u8>, String> {
            if pcm_960_stereo.len() != OPUS_FRAME_SAMPLES_TOTAL {
                return Err(format!(
                    "expected {} f32 samples for 20ms stereo Opus frame, got {}",
                    OPUS_FRAME_SAMPLES_TOTAL,
                    pcm_960_stereo.len()
                ));
            }
            let len = self
                .encoder
                .encode_float(pcm_960_stereo, &mut self.scratch)
                .map_err(|e| format!("opus encode_float failed: {e:?}"))?;
            Ok(self.scratch[..len].to_vec())
        }
    }

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct ActivationHandler {
        done: Arc<(Mutex<bool>, Condvar)>,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
        fn ActivateCompleted(
            &self,
            _activateoperation: windows_core::Ref<IActivateAudioInterfaceAsyncOperation>,
        ) -> Result<()> {
            let (lock, cvar) = &*self.done;
            let mut guard = lock.lock().unwrap();
            *guard = true;
            cvar.notify_all();
            Ok(())
        }
    }

    pub fn activate_process_loopback_client(
        target_pid: u32,
        include_tree: bool,
    ) -> Result<IAudioClient> {
        unsafe {
            let mode = if include_tree {
                PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
            } else {
                PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
            };

            let activation_params = AUDIOCLIENT_ACTIVATION_PARAMS {
                ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                    ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                        TargetProcessId: target_pid,
                        ProcessLoopbackMode: mode,
                    },
                },
            };

            let params_ptr = CoTaskMemAlloc(std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>())
                as *mut AUDIOCLIENT_ACTIVATION_PARAMS;
            if params_ptr.is_null() {
                return Err(windows::core::Error::from_hresult(HRESULT(-2147024882))); // E_OUTOFMEMORY
            }
            std::ptr::write(params_ptr, activation_params);
            // Ownership of `params_ptr` transfers to `propvar` (VT_BLOB);
            // `PROPVARIANT::drop` calls `PropVariantClear`, which frees `pBlobData` via `CoTaskMemFree`.

            let propvar = PROPVARIANT {
                Anonymous: PROPVARIANT_0 {
                    Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                        vt: VT_BLOB,
                        wReserved1: 0,
                        wReserved2: 0,
                        wReserved3: 0,
                        Anonymous: PROPVARIANT_0_0_0 {
                            blob: BLOB {
                                cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                                pBlobData: params_ptr.cast(),
                            },
                        },
                    }),
                },
            };

            let done = Arc::new((Mutex::new(false), Condvar::new()));
            let handler: IActivateAudioInterfaceCompletionHandler = ActivationHandler {
                done: Arc::clone(&done),
            }
            .into();

            let op = ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(&propvar),
                &handler,
            )?;

            {
                let (lock, cvar) = &*done;
                let mut guard = lock.lock().unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                while !*guard {
                    let rem = deadline.saturating_duration_since(Instant::now());
                    if rem.is_zero() {
                        return Err(windows::core::Error::from_hresult(HRESULT(-2147023436)));
                    }
                    let (g, _) = cvar.wait_timeout(guard, rem).unwrap();
                    guard = g;
                }
            }
            let mut activate_hr = HRESULT(0);
            let mut activated_unk = None;
            op.GetActivateResult(&mut activate_hr, &mut activated_unk)?;
            activate_hr.ok()?;
            let unk =
                activated_unk.ok_or_else(|| windows::core::Error::from_hresult(HRESULT(-1)))?;
            let client: IAudioClient = unk.cast()?;
            Ok(client)
        }
    }

    pub fn spawn_app_audio_thread(
        app: tauri::AppHandle,
        mode: LoopbackMode,
        audio_track: Arc<TrackLocalStaticSample>,
        stop_flag: Arc<AtomicBool>,
        rt_handle: tokio::runtime::Handle,
        stream_epoch: SystemTime,
    ) -> std::result::Result<(std::thread::JoinHandle<()>, String), String> {
        let mode_label = mode.as_label();
        let (ready_tx, ready_rx) =
            std::sync::mpsc::sync_channel::<std::result::Result<(), String>>(1);
        let stop_flag_thread = Arc::clone(&stop_flag);

        let handle = std::thread::Builder::new()
            .name("nexus-wasapi-loopback".to_string())
            .spawn(move || {
                let _com_guard = ComInitGuard::new_multithreaded();

                let (target_pid, include_tree) = match mode {
                    LoopbackMode::IncludeProcessTree { pid } => (pid, true),
                    LoopbackMode::ExcludeSelfProcessTree { self_pid } => (self_pid, false),
                };

                let audio_client = match activate_process_loopback_client(target_pid, include_tree) {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!(
                            "WASAPI Process Loopback activation failed: {e:?}"
                        )));
                        return;
                    }
                };

                let mut opus_enc = match LibOpusEncoder::new(OPUS_DEFAULT_BITRATE_BPS) {
                    Ok(enc) => enc,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("libopus encoder init failed: {e}")));
                        return;
                    }
                };

                unsafe {
                    let bits_per_sample = 32u16;
                    let block_align = OPUS_CHANNELS * (bits_per_sample / 8);
                    let avg_bytes_per_sec = OPUS_SAMPLE_RATE * (block_align as u32);
                    let wfx = WAVEFORMATEX {
                        wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
                        nChannels: OPUS_CHANNELS,
                        nSamplesPerSec: OPUS_SAMPLE_RATE,
                        nAvgBytesPerSec: avg_bytes_per_sec,
                        nBlockAlign: block_align,
                        wBitsPerSample: bits_per_sample,
                        cbSize: 0,
                    };

                    let Ok(h_event) = CreateEventW(None, true, false, None) else {
                        let _ = ready_tx.send(Err("CreateEventW failed".to_string()));
                        return;
                    };
                    let _event_guard = EventHandleGuard(h_event);

                    let flags = AUDCLNT_STREAMFLAGS_LOOPBACK
                        | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
                    if let Err(e) = audio_client.Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        flags,
                        200_000, // 20 ms
                        0,
                        &wfx,
                        None,
                    ) {
                        let _ =
                            ready_tx.send(Err(format!("IAudioClient::Initialize failed: {e:?}")));
                        return;
                    }

                    if audio_client.SetEventHandle(h_event).is_err() {
                        let _ = ready_tx.send(Err("SetEventHandle failed".to_string()));
                        return;
                    }

                    let capture_client: IAudioCaptureClient = match audio_client.GetService() {
                        Ok(c) => c,
                        Err(e) => {
                            let _ = ready_tx.send(Err(format!("GetService failed: {e:?}")));
                            return;
                        }
                    };

                    if let Err(e) = audio_client.Start() {
                        let _ = ready_tx.send(Err(format!("IAudioClient::Start failed: {e:?}")));
                        return;
                    }

                    crate::capture::log_capture_diag(Some(&app), &format!("screen_audio active=true device=process_loopback_virtual mode={} sample_rate={} channels={} format=f32", mode.as_label(), OPUS_SAMPLE_RATE, OPUS_CHANNELS));
                    let _ = ready_tx.send(Ok(()));

                    let mut pcm_accum: Vec<f32> =
                        Vec::with_capacity(OPUS_FRAME_SAMPLES_TOTAL * 4);
                    let frame_dur = Duration::from_millis(OPUS_FRAME_DURATION_MS);
                    let mut frame_index: u64 = 0;
                    let (mut pcm_frames, mut silent_frames, mut opus_frames, mut opus_bytes, mut sample_writes, mut sample_bytes, mut read_errors, mut encode_errors, mut write_errors) = (0u64,0u64,0u64,0u64,0u64,0u64,0u64,0u64,0u64);
                    let mut last_diag = std::time::Instant::now();
                    let mut last_hresult = 0i32;

                    while !stop_flag_thread.load(Ordering::Relaxed) {
                        if last_diag.elapsed() >= Duration::from_secs(5) {
                            crate::capture::log_capture_diag(Some(&app), &format!("screen_audio active=true pcm_frames={} silent_frames={} opus_frames={} opus_bytes={} sample_writes_ok={} sample_bytes_ok={} read_errors={} encode_errors={} write_errors={} last_hresult=0x{:08X}", pcm_frames, silent_frames, opus_frames, opus_bytes, sample_writes, sample_bytes, read_errors, encode_errors, write_errors, last_hresult as u32));
                            last_diag = std::time::Instant::now();
                        }
                        let _ = WaitForSingleObject(h_event, 20);
                        let _ = ResetEvent(h_event);

                        if stop_flag_thread.load(Ordering::Relaxed) {
                            break;
                        }

                        loop {
                            let pkt_size = match capture_client.GetNextPacketSize() {
                                Ok(size) => size,
                                Err(e) => { read_errors += 1; last_hresult = e.code().0; break; }
                            };
                            if pkt_size == 0 {
                                break;
                            }
                            let mut data_ptr: *mut u8 = std::ptr::null_mut();
                            let mut num_frames: u32 = 0;
                            let mut flags_out: u32 = 0;
                            if let Err(e) = capture_client
                                .GetBuffer(
                                    &mut data_ptr,
                                    &mut num_frames,
                                    &mut flags_out,
                                    None,
                                    None,
                                )
                            {
                                read_errors += 1; last_hresult = e.code().0;
                                break;
                            }

                            let is_silent = (flags_out & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                            pcm_frames += num_frames as u64;
                            if is_silent { silent_frames += num_frames as u64; }
                            let total_samples = (num_frames as usize) * (OPUS_CHANNELS as usize);
                            if !is_silent && !data_ptr.is_null() && num_frames > 0 {
                                let floats = std::slice::from_raw_parts(
                                    data_ptr as *const f32,
                                    total_samples,
                                );
                                pcm_accum.extend_from_slice(floats);
                            } else if num_frames > 0 {
                                pcm_accum.resize(pcm_accum.len() + total_samples, 0.0);
                            }

                            if let Err(e) = capture_client.ReleaseBuffer(num_frames) { read_errors += 1; last_hresult = e.code().0; }
                        }

                        while pcm_accum.len() >= OPUS_FRAME_SAMPLES_TOTAL {
                            if stop_flag_thread.load(Ordering::Relaxed) {
                                break;
                            }
                            let chunk: Vec<f32> =
                                pcm_accum.drain(..OPUS_FRAME_SAMPLES_TOTAL).collect();
                            if let Ok(pkt) = opus_enc.encode_frame_f32(&chunk) {
                                opus_frames += 1;
                                let packet_len = pkt.len() as u64;
                                opus_bytes += packet_len;
                                let sample_ts = stream_epoch
                                    + Duration::from_millis(frame_index * OPUS_FRAME_DURATION_MS);
                                let sample = Sample {
                                    data: Bytes::from(pkt),
                                    timestamp: sample_ts,
                                    duration: frame_dur,
                                    ..Default::default()
                                };
                                let track_ref = Arc::clone(&audio_track);
                                match rt_handle.block_on(async move { track_ref.write_sample(&sample).await }) {
                                    Ok(()) => { sample_writes += 1; sample_bytes += packet_len; }
                                    Err(_) => write_errors += 1,
                                }
                                frame_index += 1;
                            } else { encode_errors += 1; }
                        }
                    }

                    crate::capture::log_capture_diag(Some(&app), &format!("screen_audio active=false pcm_frames={} silent_frames={} opus_frames={} opus_bytes={} sample_writes_ok={} sample_bytes_ok={} read_errors={} encode_errors={} write_errors={}", pcm_frames, silent_frames, opus_frames, opus_bytes, sample_writes, sample_bytes, read_errors, encode_errors, write_errors));
                    let _ = audio_client.Stop();
                    drop(capture_client);
                    drop(audio_client);
                    // _event_guard, opus_enc, and _com_guard drop here deterministically
                }
            })
            .map_err(|e| format!("spawn wasapi thread failed: {e}"))?;

        match ready_rx.recv_timeout(Duration::from_secs(6)) {
            Ok(Ok(())) => Ok((handle, mode_label)),
            Ok(Err(e)) => {
                let _ = handle.join();
                Err(e)
            }
            Err(_) => {
                stop_flag.store(true, Ordering::SeqCst);
                let _ = handle.join();
                Err("WASAPI loopback initialization timed out".to_string())
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub use win_impl::{activate_process_loopback_client, spawn_app_audio_thread, LibOpusEncoder};

#[cfg(not(target_os = "windows"))]
pub fn spawn_app_audio_thread(
    _mode: LoopbackMode,
    _audio_track: Arc<TrackLocalStaticSample>,
    _stop_flag: Arc<AtomicBool>,
    _rt_handle: tokio::runtime::Handle,
    _stream_epoch: SystemTime,
) -> std::result::Result<(std::thread::JoinHandle<()>, String), String> {
    Err("WASAPI Process Loopback is only supported on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_loopback_mode_labels() {
        let inc = LoopbackMode::IncludeProcessTree { pid: 1234 };
        assert_eq!(inc.as_label(), "include_pid:1234");
        let exc = LoopbackMode::ExcludeSelfProcessTree { self_pid: 5678 };
        assert_eq!(exc.as_label(), "exclude_self:5678");
    }

    #[test]
    fn test_resample_to_48k_stereo_f32() {
        // Passthrough 48kHz stereo
        let src_48k_stereo = vec![0.1f32, -0.1, 0.2, -0.2, 0.3, -0.3];
        assert_eq!(
            resample_to_48k_stereo_f32(&src_48k_stereo, 48_000, 2),
            src_48k_stereo
        );

        // Mono 48kHz -> stereo 48kHz
        let src_48k_mono = vec![0.25f32, -0.5, 0.75];
        assert_eq!(
            resample_to_48k_stereo_f32(&src_48k_mono, 48_000, 1),
            vec![0.25, 0.25, -0.5, -0.5, 0.75, 0.75]
        );

        // 44.1kHz stereo (441 frames = 10ms) -> 48kHz stereo (480 frames = 10ms)
        let mut src_44k = Vec::with_capacity(441 * 2);
        for i in 0..441 {
            let v = (i as f32) / 441.0;
            src_44k.push(v);
            src_44k.push(-v);
        }
        let resampled = resample_to_48k_stereo_f32(&src_44k, 44_100, 2);
        assert_eq!(resampled.len(), 480 * 2);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_libopus_encode_decode_roundtrip_48k_stereo() {
        use opus_codec::{Channels, Decoder, SampleRate};

        let mut enc = LibOpusEncoder::new(OPUS_DEFAULT_BITRATE_BPS).expect("LibOpusEncoder::new");
        let mut dec = Decoder::new(SampleRate::Hz48000, Channels::Stereo).expect("Decoder::new");

        let mut decoded = vec![0.0f32; OPUS_FRAME_SAMPLES_TOTAL];
        let mut total_encoded_bytes = 0usize;

        for frame_idx in 0..5 {
            let mut pcm = Vec::with_capacity(OPUS_FRAME_SAMPLES_TOTAL);
            for i in 0..OPUS_FRAME_SAMPLES_PER_CH {
                let t = ((frame_idx * OPUS_FRAME_SAMPLES_PER_CH + i) as f32) / 48_000.0;
                let s = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.4;
                pcm.push(s);
                pcm.push(s * 0.8);
            }

            let pkt = enc.encode_frame_f32(&pcm).expect("encode_frame_f32");
            assert!(!pkt.is_empty(), "Opus packet must not be empty");
            total_encoded_bytes += pkt.len();

            let decoded_samples_per_ch = dec
                .decode_float(&pkt, &mut decoded, false)
                .expect("decode_float");
            assert_eq!(decoded_samples_per_ch, OPUS_FRAME_SAMPLES_PER_CH);
        }

        assert!(total_encoded_bytes > 0);
        let energy: f32 = decoded.iter().map(|x| x * x).sum();
        assert!(
            energy > 1.0,
            "Decoded Opus audio should preserve signal energy, got {energy}"
        );
    }
}
