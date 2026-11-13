use std::mem::ManuallyDrop;
use std::time::{Duration, Instant};
use windows::core::{Interface, Result, GUID};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D, ID3D11VideoContext,
    ID3D11VideoDevice, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_OPTIMAL_SPEED, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::IDXGISurface;
use windows::Win32::Media::MediaFoundation::{
    eAVEncCommonRateControlMode_CBR, ICodecAPI, IMFActivate, IMFDXGIDeviceManager,
    IMFMediaBuffer, IMFMediaEventGenerator, IMFSample, IMFTransform, MFCreateDXGIDeviceManager,
    MFCreateDXGISurfaceBuffer, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
    MFMediaType_Video, MFTEnumEx, MFVideoFormat_H264, MFVideoFormat_NV12,
    MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG, MFT_ENUM_FLAG_HARDWARE,
    MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_SYNCMFT, MFT_FRIENDLY_NAME_Attribute,
    MFT_MESSAGE_COMMAND_FLUSH, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_START_OF_STREAM,
    MFT_MESSAGE_SET_D3D_MANAGER, MFT_OUTPUT_DATA_BUFFER, MFT_OUTPUT_STREAM_INFO,
    MFT_REGISTER_TYPE_INFO, MF_E_NO_EVENTS_AVAILABLE, MF_E_TRANSFORM_NEED_MORE_INPUT,
    MF_E_TRANSFORM_STREAM_CHANGE, MF_EVENT_FLAG_NO_WAIT, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MPEG2_PROFILE,
    MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_TRANSFORM_ASYNC, MF_TRANSFORM_ASYNC_UNLOCK,
    CODECAPI_AVEncCommonLowLatency, CODECAPI_AVEncCommonMeanBitRate,
    CODECAPI_AVEncCommonMaxBitRate, CODECAPI_AVEncCommonQuality, CODECAPI_AVEncVideoEncodeQP,
    CODECAPI_AVEncCommonRateControlMode, CODECAPI_AVEncMPVDefaultBPictureCount,
    CODECAPI_AVEncMPVGOPSize, CODECAPI_AVEncVideoForceKeyFrame, CODECAPI_AVLowLatencyMode,
    MFVideoInterlace_Progressive,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Variant::VARIANT;

const ME_TRANSFORM_NEED_INPUT: u32 = 601;
const ME_TRANSFORM_HAVE_OUTPUT: u32 = 602;

const H264_PROFILE_BASE: u32 = 66;
const H264_PROFILE_MAIN: u32 = 77;

#[inline]
fn pack_u32_pair(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | (lo as u64)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BitrateUpdateOutcome {
    Unchanged,
    AppliedLive,
    Reinitialized,
    Deferred,
}

pub struct GpuBgraToNv12 {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    src_w: u32,
    src_h: u32,
    pub dst_w: u32,
    pub dst_h: u32,
    pub nv12_tex: ID3D11Texture2D,
    output_view: ID3D11VideoProcessorOutputView,
    staging_nv12: Option<ID3D11Texture2D>,
}

impl GpuBgraToNv12 {
    pub fn new(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        src_w: u32,
        src_h: u32,
        dst_w: u32,
        dst_h: u32,
    ) -> Result<Self> {
        unsafe {
            if let Ok(mt) = device.cast::<ID3D11Multithread>() {
                let _ = mt.SetMultithreadProtected(true);
            }
            let video_device: ID3D11VideoDevice = device.cast()?;
            let video_context: ID3D11VideoContext = context.cast()?;

            let content_desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: DXGI_RATIONAL {
                    Numerator: 60,
                    Denominator: 1,
                },
                InputWidth: src_w.max(2),
                InputHeight: src_h.max(2),
                OutputFrameRate: DXGI_RATIONAL {
                    Numerator: 60,
                    Denominator: 1,
                },
                OutputWidth: dst_w.max(2),
                OutputHeight: dst_h.max(2),
                Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
            };
            let enumerator = video_device.CreateVideoProcessorEnumerator(&content_desc)?;
            let processor = video_device.CreateVideoProcessor(&enumerator, 0)?;

            let nv12_desc = D3D11_TEXTURE2D_DESC {
                Width: dst_w.max(2),
                Height: dst_h.max(2),
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut nv12_tex: Option<ID3D11Texture2D> = None;
            device.CreateTexture2D(&nv12_desc, None, Some(&mut nv12_tex))?;
            let nv12_tex = nv12_tex.unwrap();

            let ov_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                ..Default::default()
            };
            let mut output_view: Option<ID3D11VideoProcessorOutputView> = None;
            video_device.CreateVideoProcessorOutputView(
                &nv12_tex,
                &enumerator,
                &ov_desc,
                Some(&mut output_view),
            )?;
            let output_view = output_view.unwrap();

            Ok(Self {
                device: device.clone(),
                context: context.clone(),
                video_device,
                video_context,
                enumerator,
                processor,
                src_w: src_w.max(2),
                src_h: src_h.max(2),
                dst_w: dst_w.max(2),
                dst_h: dst_h.max(2),
                nv12_tex,
                output_view,
                staging_nv12: None,
            })
        }
    }

    pub fn ensure_sizes(&mut self, src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> Result<()> {
        let sw = src_w.max(2);
        let sh = src_h.max(2);
        let dw = dst_w.max(2);
        let dh = dst_h.max(2);
        if self.src_w == sw && self.src_h == sh && self.dst_w == dw && self.dst_h == dh {
            return Ok(());
        }
        *self = Self::new(&self.device, &self.context, sw, sh, dw, dh)?;
        Ok(())
    }

    pub fn convert(&mut self, src_bgra: &ID3D11Texture2D) -> Result<()> {
        unsafe {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            src_bgra.GetDesc(&mut desc);
            self.ensure_sizes(desc.Width, desc.Height, self.dst_w, self.dst_h)?;

            let iv_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                ..Default::default()
            };
            let mut input_view: Option<ID3D11VideoProcessorInputView> = None;
            self.video_device.CreateVideoProcessorInputView(
                src_bgra,
                &self.enumerator,
                &iv_desc,
                Some(&mut input_view),
            )?;
            let input_view = input_view.unwrap();

            let src_rect = RECT {
                left: 0,
                top: 0,
                right: desc.Width as i32,
                bottom: desc.Height as i32,
            };
            let (left,top,right,bottom)=super::recovery::fit_destination(desc.Width,desc.Height,self.dst_w,self.dst_h);
            let dst_rect = RECT {left,top,right,bottom};
            let output_rect=RECT {left:0,top:0,right:self.dst_w as i32,bottom:self.dst_h as i32};
            let black=windows::Win32::Graphics::Direct3D11::D3D11_VIDEO_COLOR {
                Anonymous:windows::Win32::Graphics::Direct3D11::D3D11_VIDEO_COLOR_0 {
                    RGBA:windows::Win32::Graphics::Direct3D11::D3D11_VIDEO_COLOR_RGBA {R:0.0,G:0.0,B:0.0,A:1.0}
                }
            };
            self.video_context.VideoProcessorSetOutputBackgroundColor(&self.processor,false,&black);
            self.video_context.VideoProcessorSetStreamSourceRect(
                &self.processor,
                0,
                true,
                Some(&src_rect),
            );
            self.video_context.VideoProcessorSetStreamDestRect(
                &self.processor,
                0,
                true,
                Some(&dst_rect),
            );
            self.video_context
                .VideoProcessorSetOutputTargetRect(&self.processor, true, Some(&output_rect));

            let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(Some(input_view)),
                ..Default::default()
            };
            let res = self.video_context.VideoProcessorBlt(
                &self.processor,
                &self.output_view,
                0,
                std::slice::from_ref(&stream),
            );
            ManuallyDrop::drop(&mut stream.pInputSurface);
            res
        }
    }

    pub fn copy_nv12_to_cpu(&mut self, dst: &mut Vec<u8>) -> Result<()> {
        unsafe {
            if self.staging_nv12.is_none() {
                let s_desc = D3D11_TEXTURE2D_DESC {
                    Width: self.dst_w,
                    Height: self.dst_h,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_NV12,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut st: Option<ID3D11Texture2D> = None;
                self.device.CreateTexture2D(&s_desc, None, Some(&mut st))?;
                self.staging_nv12 = st;
            }
            let staging = self.staging_nv12.as_ref().unwrap();
            self.context.CopyResource(staging, &self.nv12_tex);

            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;

            let w = self.dst_w as usize;
            let h = self.dst_h as usize;
            let total = w * h * 3 / 2;
            dst.resize(total, 0);
            let pitch = mapped.RowPitch as usize;
            let src_ptr = mapped.pData as *const u8;

            for row in 0..h {
                std::ptr::copy_nonoverlapping(
                    src_ptr.add(row * pitch),
                    dst.as_mut_ptr().add(row * w),
                    w,
                );
            }
            let uv_src_offset = h * pitch;
            let uv_dst_offset = w * h;
            for row in 0..(h / 2) {
                std::ptr::copy_nonoverlapping(
                    src_ptr.add(uv_src_offset + row * pitch),
                    dst.as_mut_ptr().add(uv_dst_offset + row * w),
                    w,
                );
            }

            self.context.Unmap(staging, 0);
            Ok(())
        }
    }
}

pub struct EncodedSample {
    pub annex_b: Vec<u8>,
    pub is_idr: bool,
    pub injected_sps_pps: bool,
}

pub struct MfH264Encoder {
    mft: IMFTransform,
    codec_api: Option<ICodecAPI>,
    event_gen: Option<IMFMediaEventGenerator>,
    is_async: bool,
    need_input_ready: bool,
    uses_d3d_surface: bool,
    output_stream_info: MFT_OUTPUT_STREAM_INFO,
    pub encoder_name: String,
    pub is_hardware: bool,
    pub profile_level_id: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub current_bitrate_bps: u32,
    pub property_readback: serde_json::Value,
    force_software: bool,
    supports_live_bitrate: bool,
    last_reinit_at: Instant,
    frame_duration_100ns: i64,
    cpu_scratch: Vec<u8>,
    _device_manager: Option<IMFDXGIDeviceManager>,
    cached_sps: Option<Vec<u8>>,
    cached_pps: Option<Vec<u8>>,
    pub idr_count: u64,
    pub sps_pps_injections: u64,
    pub reinit_count: u64,
}

impl MfH264Encoder {
    pub fn new(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        fps: u32,
        bitrate_bps: u32,
        force_software: bool,
    ) -> Result<Self> {
        if super::health::validate_encoder_dimensions(width, height).is_err() {
            return Err(windows::core::Error::from_hresult(windows::Win32::Media::MediaFoundation::MF_E_INVALIDMEDIATYPE));
        }
        unsafe {
            let out_type = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: MFVideoFormat_H264,
            };

            if !force_software {
                let hw_flags = MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER;
                if let Ok(enc) = Self::try_init_with_flags(
                    device,
                    width,
                    height,
                    fps,
                    bitrate_bps,
                    force_software,
                    &out_type,
                    hw_flags,
                    true,
                ) {
                    return Ok(enc);
                }
                eprintln!("[MF] Hardware H.264 MFT unavailable/failed, falling back to software MFT");
            }

            let sw_flags = MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER;
            Self::try_init_with_flags(
                device,
                width,
                height,
                fps,
                bitrate_bps,
                force_software,
                &out_type,
                sw_flags,
                false,
            )
        }
    }

    unsafe fn try_init_with_flags(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        fps: u32,
        bitrate_bps: u32,
        force_software: bool,
        out_type: &MFT_REGISTER_TYPE_INFO,
        flags: MFT_ENUM_FLAG,
        try_hw: bool,
    ) -> Result<Self> {
        let mut pp_activate: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count: u32 = 0;
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            flags,
            None,
            Some(out_type),
            &mut pp_activate,
            &mut count,
        )?;
        if count == 0 || pp_activate.is_null() {
            return Err(windows::core::Error::from_hresult(windows::core::HRESULT(-1)));
        }

        let slice = std::slice::from_raw_parts(pp_activate, count as usize);
        let mut last_err = windows::core::Error::from_hresult(windows::core::HRESULT(-1));

        for act_opt in slice {
            if let Some(act) = act_opt {
                let name = get_act_string(act, &MFT_FRIENDLY_NAME_Attribute)
                    .unwrap_or_else(|| "Unknown MFT".to_string());
                match Self::init_single_mft(
                    act,
                    &name,
                    try_hw,
                    force_software,
                    device,
                    width,
                    height,
                    fps,
                    bitrate_bps,
                ) {
                    Ok(enc) => {
                        CoTaskMemFree(Some(pp_activate.cast()));
                        return Ok(enc);
                    }
                    Err(e) => {
                        eprintln!("[MF] Init failed for \"{}\": {:?}", name, e);
                        last_err = e;
                    }
                }
            }
        }
        CoTaskMemFree(Some(pp_activate.cast()));
        Err(last_err)
    }

    unsafe fn init_single_mft(
        act: &IMFActivate,
        name: &str,
        is_hardware: bool,
        force_software: bool,
        device: &ID3D11Device,
        width: u32,
        height: u32,
        fps: u32,
        bitrate_bps: u32,
    ) -> Result<Self> {
        let mft: IMFTransform = act.ActivateObject()?;

        let mut is_async = false;
        if let Ok(attrs) = mft.GetAttributes() {
            if attrs.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) != 0 {
                attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                is_async = true;
            }
        }

        let mut device_manager: Option<IMFDXGIDeviceManager> = None;
        let mut uses_d3d_surface = false;
        if is_hardware {
            let mut reset_token: u32 = 0;
            let mut mgr: Option<IMFDXGIDeviceManager> = None;
            if MFCreateDXGIDeviceManager(&mut reset_token, &mut mgr).is_ok() {
                if let Some(ref m) = mgr {
                    if m.ResetDevice(device, reset_token).is_ok() {
                        let raw_ptr = m.as_raw() as usize;
                        if mft.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, raw_ptr).is_ok() {
                            uses_d3d_surface = true;
                            device_manager = mgr;
                        }
                    }
                }
            }
        }

        let codec_api = mft.cast::<ICodecAPI>().ok();
        let mut set_results = serde_json::Map::new();
        if let Some(ref api) = codec_api {
            for (name,key,value) in [
                ("rate_control", CODECAPI_AVEncCommonRateControlMode, VARIANT::from(eAVEncCommonRateControlMode_CBR.0 as u32)),
                ("mean_bitrate", CODECAPI_AVEncCommonMeanBitRate, VARIANT::from(bitrate_bps)),
                ("low_latency", CODECAPI_AVEncCommonLowLatency, VARIANT::from(true)),
                ("low_latency_mode", CODECAPI_AVLowLatencyMode, VARIANT::from(true)),
                ("b_frames", CODECAPI_AVEncMPVDefaultBPictureCount, VARIANT::from(0u32)),
                ("gop", CODECAPI_AVEncMPVGOPSize, VARIANT::from(fps.max(1)*2)),
            ] {
                let hr=(Interface::vtable(api).SetValue)(Interface::as_raw(api), &key, &value);
                set_results.insert(name.into(), serde_json::json!({"hresult":hr.0,"accepted":hr.0==0}));
            }
        }

        let mut chosen_profile = H264_PROFILE_BASE;
        let out_mt_base = build_h264_out_mt(width, height, fps, bitrate_bps, H264_PROFILE_BASE)?;
        if let Err(e) = mft.SetOutputType(0, &out_mt_base, 0) {
            crate::capture::log_capture_diag(None, &format!("screen_encoder stage=SetOutputType profile=baseline width={} height={} hresult=0x{:08X}", width, height, e.code().0 as u32));
            chosen_profile = H264_PROFILE_MAIN;
            let out_mt_main =
                build_h264_out_mt(width, height, fps, bitrate_bps, H264_PROFILE_MAIN)?;
            mft.SetOutputType(0, &out_mt_main, 0).map_err(|e| {
                crate::capture::log_capture_diag(None, &format!("screen_encoder stage=SetOutputType profile=main width={} height={} hresult=0x{:08X}", width, height, e.code().0 as u32)); e
            })?;
        }

        let in_mt = MFCreateMediaType()?;
        in_mt.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        in_mt.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
        in_mt.SetUINT64(&MF_MT_FRAME_SIZE, pack_u32_pair(width, height))?;
        in_mt.SetUINT64(&MF_MT_FRAME_RATE, pack_u32_pair(fps, 1))?;
        in_mt.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        in_mt.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u32_pair(1, 1))?;
        mft.SetInputType(0, &in_mt, 0).map_err(|e| {
            crate::capture::log_capture_diag(None, &format!("screen_encoder stage=SetInputType format=NV12 width={} height={} hresult=0x{:08X}", width, height, e.code().0 as u32)); e
        })?;
        crate::capture::log_capture_diag(None, &format!("screen_encoder configured target_bps={} fps={} gop_requested={} rate_control_requested=CBR max_bitrate_configured=false qp_configured=false", bitrate_bps, fps, fps.max(1) * 2));

        let mut property_readback = codec_snapshot(codec_api.as_ref(), bitrate_bps, fps);
        property_readback["set_results"] = serde_json::Value::Object(set_results);
        crate::capture::log_capture_diag(None, &format!("screen_encoder properties={}", property_readback));
        let output_stream_info = mft.GetOutputStreamInfo(0)?;
        let _ = mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
        let _ = mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

        let event_gen = if is_async {
            Some(mft.cast::<IMFMediaEventGenerator>()?)
        } else {
            None
        };

        // AMD AMF MFT (`AMDh264Encoder`) ignores CODECAPI_AVEncCommonMeanBitRate mid-stream
        // even when SetValue returns S_OK; detect this and use transparent flush+reinit.
        let is_amd_mft = name.to_ascii_lowercase().contains("amd");
        let supports_live_bitrate = if is_amd_mft {
            false
        } else if let Some(ref api) = codec_api {
            codec_flag(api, &CODECAPI_AVEncCommonMeanBitRate, true)
        } else {
            false
        };

        let profile_level_id = if chosen_profile == H264_PROFILE_BASE {
            "42001f".to_string()
        } else {
            "4d001f".to_string()
        };

        eprintln!(
            "[MF] \"{}\" ready: hw={} d3d_zc={} async={} live_bitrate={} profile={} ({}x{}@{}fps {}kbps)",
            name,
            is_hardware,
            uses_d3d_surface,
            is_async,
            supports_live_bitrate,
            profile_level_id,
            width,
            height,
            fps,
            bitrate_bps / 1000
        );

        Ok(Self {
            mft,
            codec_api,
            event_gen,
            is_async,
            need_input_ready: false,
            uses_d3d_surface,
            output_stream_info,
            encoder_name: name.to_string(),
            is_hardware,
            profile_level_id,
            width,
            height,
            fps,
            current_bitrate_bps: bitrate_bps,
            property_readback,
            force_software,
            supports_live_bitrate,
            last_reinit_at: Instant::now(),
            frame_duration_100ns: (10_000_000i64) / (fps.max(1) as i64),
            cpu_scratch: Vec::new(),
            _device_manager: device_manager,
            cached_sps: None,
            cached_pps: None,
            idr_count: 0,
            sps_pps_injections: 0,
            reinit_count: 0,
        })
    }

    pub fn force_keyframe(&mut self) -> bool {
        if let Some(ref api) = self.codec_api {
            unsafe { set_codec_u32(api, &CODECAPI_AVEncVideoForceKeyFrame, 1).is_ok() }
        } else {
            false
        }
    }

    /// Updates target bitrate. Uses `ICodecAPI::SetValue` when supported by the MFT,
    /// or transparently flushes and re-initializes the MFT (e.g. for `AMDh264Encoder`)
    /// so adaptive bitrate works reliably without interrupting capture or WebRTC peers.
    pub fn set_bitrate(
        &mut self,
        device: &ID3D11Device,
        bitrate_bps: u32,
        immediate: bool,
    ) -> Result<BitrateUpdateOutcome> {
        if bitrate_bps == self.current_bitrate_bps {
            return Ok(BitrateUpdateOutcome::Unchanged);
        }

        if self.supports_live_bitrate {
            if let Some(ref api) = self.codec_api {
                if unsafe { set_codec_u32(api, &CODECAPI_AVEncCommonMeanBitRate, bitrate_bps) }.is_ok()
                {
                    self.property_readback = unsafe { codec_snapshot(Some(api), bitrate_bps, self.fps) };
                    let readback = unsafe { read_codec_u32(api, &CODECAPI_AVEncCommonMeanBitRate) };
                    crate::capture::log_capture_diag(None, &format!("screen_encoder live_requested_bps={} live_readback_bps={:?}", bitrate_bps, readback));
                    if readback == Some(bitrate_bps) {
                        self.current_bitrate_bps = bitrate_bps;
                        return Ok(BitrateUpdateOutcome::AppliedLive);
                    }
                    // Reconcile a write with unknown/mismatching readback immediately.
                    // Do not let the normal 12% cooldown leave the MFT in an unknown state.
                    self.supports_live_bitrate = false;
                    self.reconfigure(device,self.width,self.height,self.fps,bitrate_bps,self.force_software)?;
                    return Ok(BitrateUpdateOutcome::Reinitialized);

                }
            }
            self.supports_live_bitrate = false;
        }

        let prev = self.current_bitrate_bps.max(1) as f64;
        let rel_delta = ((bitrate_bps as f64) - prev).abs() / prev;
        if !immediate && (rel_delta < 0.12 || self.last_reinit_at.elapsed() < Duration::from_secs(2))
        {
            return Ok(BitrateUpdateOutcome::Deferred);
        }

        self.reconfigure(
            device,
            self.width,
            self.height,
            self.fps,
            bitrate_bps,
            self.force_software,
        )?;
        Ok(BitrateUpdateOutcome::Reinitialized)
    }

    /// Transparently flushes and re-initializes the MFT with new dimensions, FPS, or bitrate.
    pub fn reconfigure(
        &mut self,
        device: &ID3D11Device,
        width: u32,
        height: u32,
        fps: u32,
        bitrate_bps: u32,
        force_software: bool,
    ) -> Result<()> {
        let prev_idr = self.idr_count;
        let prev_inj = self.sps_pps_injections;
        let prev_reinit = self.reinit_count;

        self.shutdown();
        let mut next = Self::new(device, width, height, fps, bitrate_bps, force_software)?;
        next.idr_count = prev_idr;
        next.sps_pps_injections = prev_inj;
        next.reinit_count = prev_reinit + 1;
        next.last_reinit_at = Instant::now();
        let _ = next.force_keyframe();
        *self = next;
        Ok(())
    }

    pub fn uses_d3d_zero_copy(&self) -> bool {
        self.uses_d3d_surface
    }

    pub fn encode_nv12_texture(
        &mut self,
        converter: &mut GpuBgraToNv12,
        timestamp_100ns: i64,
    ) -> Result<EncodedSample> {
        let raw = self.encode_raw(converter, timestamp_100ns)?;
        if raw.is_empty() {
            return Ok(EncodedSample {
                annex_b: raw,
                is_idr: false,
                injected_sps_pps: false,
            });
        }
        Ok(self.process_annex_b(raw))
    }

    fn process_annex_b(&mut self, raw: Vec<u8>) -> EncodedSample {
        let nalus = split_annex_b_nalus(&raw);
        let mut has_sps = false;
        let mut has_pps = false;
        let mut has_idr = false;

        for nalu in &nalus {
            if nalu.is_empty() {
                continue;
            }
            let nalu_type = nalu[0] & 0x1F;
            match nalu_type {
                7 => {
                    has_sps = true;
                    if self.cached_sps.is_none() && nalu.len() >= 4 {
                        let prof = format!("{:02x}{:02x}{:02x}", nalu[1], nalu[2], nalu[3]);
                        self.profile_level_id = prof;
                    }
                    self.cached_sps = Some(nalu.to_vec());
                }
                8 => {
                    has_pps = true;
                    self.cached_pps = Some(nalu.to_vec());
                }
                5 => {
                    has_idr = true;
                }
                _ => {}
            }
        }

        if has_idr {
            self.idr_count += 1;
        }

        let mut injected = false;
        let final_bytes = if has_idr && (!has_sps || !has_pps) {
            if let (Some(sps), Some(pps)) = (&self.cached_sps, &self.cached_pps) {
                let mut out = Vec::with_capacity(raw.len() + sps.len() + pps.len() + 8);
                if !has_sps {
                    out.extend_from_slice(&[0, 0, 0, 1]);
                    out.extend_from_slice(sps);
                }
                if !has_pps {
                    out.extend_from_slice(&[0, 0, 0, 1]);
                    out.extend_from_slice(pps);
                }
                out.extend_from_slice(&raw);
                injected = true;
                self.sps_pps_injections += 1;
                out
            } else {
                raw
            }
        } else {
            raw
        };

        EncodedSample {
            annex_b: final_bytes,
            is_idr: has_idr,
            injected_sps_pps: injected,
        }
    }

    fn encode_raw(
        &mut self,
        converter: &mut GpuBgraToNv12,
        timestamp_100ns: i64,
    ) -> Result<Vec<u8>> {
        unsafe {
            let sample: IMFSample = MFCreateSample()?;
            sample.SetSampleTime(timestamp_100ns)?;
            sample.SetSampleDuration(self.frame_duration_100ns)?;

            let buf: IMFMediaBuffer = if self.uses_d3d_surface {
                let surface: IDXGISurface = converter.nv12_tex.cast()?;
                MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &surface, 0, false)?
            } else {
                converter.copy_nv12_to_cpu(&mut self.cpu_scratch)?;
                let mb = MFCreateMemoryBuffer(self.cpu_scratch.len() as u32)?;
                let mut dst_ptr: *mut u8 = std::ptr::null_mut();
                let mut max_len = 0u32;
                let mut cur_len = 0u32;
                mb.Lock(&mut dst_ptr, Some(&mut max_len), Some(&mut cur_len))?;
                std::ptr::copy_nonoverlapping(
                    self.cpu_scratch.as_ptr(),
                    dst_ptr,
                    self.cpu_scratch.len(),
                );
                mb.Unlock()?;
                mb.SetCurrentLength(self.cpu_scratch.len() as u32)?;
                mb
            };

            sample.AddBuffer(&buf)?;

            if self.is_async {
                let ev_gen = self.event_gen.as_ref().unwrap().clone();
                let wait_event = |timeout_ms: u64| -> Result<Option<u32>> {
                    let start = Instant::now();
                    loop {
                        match ev_gen.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                            Ok(ev) => return Ok(Some(ev.GetType()?)),
                            Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                                if start.elapsed().as_millis() as u64 >= timeout_ms {
                                    return Ok(None);
                                }
                                std::thread::sleep(Duration::from_micros(200));
                            }
                            Err(e) => return Err(e),
                        }
                    }
                };

                while let Some(ev_type) = wait_event(0)? {
                    if ev_type == ME_TRANSFORM_NEED_INPUT {
                        self.need_input_ready = true;
                    } else if ev_type == ME_TRANSFORM_HAVE_OUTPUT {
                        let _ = self.drain_one_output();
                    }
                }

                if !self.need_input_ready {
                    let deadline = Instant::now() + Duration::from_millis(500);
                    while Instant::now() < deadline {
                        if let Some(ev_type) = wait_event(50)? {
                            if ev_type == ME_TRANSFORM_NEED_INPUT {
                                self.need_input_ready = true;
                                break;
                            } else if ev_type == ME_TRANSFORM_HAVE_OUTPUT {
                                let _ = self.drain_one_output();
                            }
                        }
                    }
                }
                if !self.need_input_ready {
                    return Err(windows::core::Error::from_hresult(MF_E_NO_EVENTS_AVAILABLE));
                }
                self.need_input_ready = false;
                self.mft.ProcessInput(0, &sample, 0)?;

                let mut encoded_bytes = Vec::new();
                let out_deadline = Instant::now() + Duration::from_millis(200);
                while Instant::now() < out_deadline {
                    match wait_event(20)? {
                        Some(ME_TRANSFORM_HAVE_OUTPUT) => {
                            let chunk = self.drain_one_output()?;
                            encoded_bytes.extend_from_slice(&chunk);
                            break;
                        }
                        Some(ME_TRANSFORM_NEED_INPUT) => {
                            self.need_input_ready = true;
                        }
                        Some(_) => {}
                        None => break,
                    }
                }
                Ok(encoded_bytes)
            } else {
                self.mft.ProcessInput(0, &sample, 0)?;
                let mut encoded_bytes = Vec::new();
                loop {
                    match self.drain_one_output() {
                        Ok(chunk) => encoded_bytes.extend_from_slice(&chunk),
                        Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => break,
                        Err(e) => return Err(e),
                    }
                }
                Ok(encoded_bytes)
            }
        }
    }

    unsafe fn drain_one_output(&mut self) -> Result<Vec<u8>> {
        for attempt in 0..2 {
            let mft_provides_samples = (self.output_stream_info.dwFlags & 0x100) != 0;

            let out_sample: Option<IMFSample> = if mft_provides_samples {
                None
            } else {
                let s = MFCreateSample()?;
                let sz = self.output_stream_info.cbSize.max(self.width * self.height);
                let b = MFCreateMemoryBuffer(sz)?;
                s.AddBuffer(&b)?;
                Some(s)
            };

            let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: 0,
                pSample: ManuallyDrop::new(out_sample),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            }];
            let mut status = 0u32;
            let res = self.mft.ProcessOutput(0, &mut buffers, &mut status);

            if let Err(e) = res {
                let mut buf0 = buffers;
                ManuallyDrop::drop(&mut buf0[0].pSample);
                ManuallyDrop::drop(&mut buf0[0].pEvents);
                if e.code() == MF_E_TRANSFORM_STREAM_CHANGE && attempt == 0 {
                    if let Ok(avail_out) = self.mft.GetOutputAvailableType(0, 0) {
                        let _ = self.mft.SetOutputType(0, &avail_out, 0);
                        if let Ok(info) = self.mft.GetOutputStreamInfo(0) {
                            self.output_stream_info = info;
                        }
                        continue;
                    }
                }
                return Err(e);
            }

            let mut out_bytes = Vec::new();
            let mut buf0 = buffers;
            if let Some(ref sample) = *buf0[0].pSample {
                if let Ok(contiguous) = sample.ConvertToContiguousBuffer() {
                    let mut ptr: *mut u8 = std::ptr::null_mut();
                    let mut max_len = 0u32;
                    let mut cur_len = 0u32;
                    if contiguous
                        .Lock(&mut ptr, Some(&mut max_len), Some(&mut cur_len))
                        .is_ok()
                    {
                        if cur_len > 0 && !ptr.is_null() {
                            out_bytes.extend_from_slice(std::slice::from_raw_parts(
                                ptr,
                                cur_len as usize,
                            ));
                        }
                        let _ = contiguous.Unlock();
                    }
                }
            }
            ManuallyDrop::drop(&mut buf0[0].pSample);
            ManuallyDrop::drop(&mut buf0[0].pEvents);
            return Ok(out_bytes);
        }
        Err(windows::core::Error::from_hresult(
            MF_E_TRANSFORM_NEED_MORE_INPUT,
        ))
    }

    pub fn shutdown(&mut self) {
        unsafe {
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
        }
    }
}

unsafe fn build_h264_out_mt(
    width: u32,
    height: u32,
    fps: u32,
    bitrate_bps: u32,
    profile: u32,
) -> Result<windows::Win32::Media::MediaFoundation::IMFMediaType> {
    let out_mt = MFCreateMediaType()?;
    out_mt.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
    out_mt.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
    out_mt.SetUINT32(&MF_MT_AVG_BITRATE, bitrate_bps)?;
    out_mt.SetUINT64(&MF_MT_FRAME_SIZE, pack_u32_pair(width, height))?;
    out_mt.SetUINT64(&MF_MT_FRAME_RATE, pack_u32_pair(fps, 1))?;
    out_mt.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
    out_mt.SetUINT32(&MF_MT_MPEG2_PROFILE, profile)?;
    out_mt.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_u32_pair(1, 1))?;
    Ok(out_mt)
}

pub fn split_annex_b_nalus(data: &[u8]) -> Vec<&[u8]> {
    let mut nalus = Vec::new();
    let mut i = 0usize;
    let mut nalu_start: Option<usize> = None;

    while i < data.len() {
        let sc_len = if i + 3 < data.len()
            && data[i] == 0
            && data[i + 1] == 0
            && data[i + 2] == 0
            && data[i + 3] == 1
        {
            4
        } else if i + 2 < data.len() && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            3
        } else {
            0
        };

        if sc_len > 0 {
            if let Some(start) = nalu_start {
                if i > start {
                    nalus.push(&data[start..i]);
                }
            }
            i += sc_len;
            nalu_start = Some(i);
        } else {
            i += 1;
        }
    }
    if let Some(start) = nalu_start {
        if start < data.len() {
            nalus.push(&data[start..]);
        }
    }
    nalus
}

unsafe fn get_act_string(act: &IMFActivate, key: &GUID) -> Option<String> {
    let len = act.GetStringLength(key).ok()?;
    let mut buf = vec![0u16; (len + 1) as usize];
    let mut actual_len = 0u32;
    if act.GetString(key, &mut buf, Some(&mut actual_len)).is_ok() {
        Some(String::from_utf16_lossy(&buf[..actual_len as usize]))
    } else {
        None
    }
}

// IsSupported/IsModifiable return S_FALSE as a successful HRESULT. Require S_OK.
unsafe fn codec_flag(api: &ICodecAPI, key: &GUID, modifiable: bool) -> bool {
    let result = if modifiable { (Interface::vtable(api).IsModifiable)(Interface::as_raw(api), key) }
        else { (Interface::vtable(api).IsSupported)(Interface::as_raw(api), key) };
    result.0 == 0
}
unsafe fn read_codec_u32(api: &ICodecAPI, key: &GUID) -> Option<u32> {
    api.GetValue(key).ok().and_then(|value| u32::try_from(&value).ok())
}
unsafe fn codec_snapshot(api: Option<&ICodecAPI>, bitrate: u32, fps: u32) -> serde_json::Value {
    let mut values = serde_json::Map::new();
    for (name, key, requested) in [
        ("rate_control", CODECAPI_AVEncCommonRateControlMode, Some(0)),
        ("mean_bitrate", CODECAPI_AVEncCommonMeanBitRate, Some(bitrate)),
        ("max_bitrate", CODECAPI_AVEncCommonMaxBitRate, None),
        ("gop", CODECAPI_AVEncMPVGOPSize, Some(fps.max(1)*2)),
        ("b_frames", CODECAPI_AVEncMPVDefaultBPictureCount, Some(0)),
        ("quality", CODECAPI_AVEncCommonQuality, None),
        ("qp", CODECAPI_AVEncVideoEncodeQP, None),
    ] {
        let readback = api.and_then(|a| a.GetValue(&key).ok()).and_then(|v| u64::try_from(&v).ok());
        values.insert(name.into(), serde_json::json!({"supported": api.is_some_and(|a| codec_flag(a,&key,false)), "modifiable":api.is_some_and(|a| codec_flag(a,&key,true)), "requested":requested, "readback":readback, "matches_requested":requested.zip(readback).map(|(a,b)| a as u64==b)}));
    }
    let advertised_modes = api.and_then(|a| {
        let mut ptr: *mut VARIANT = std::ptr::null_mut(); let mut count=0u32;
        if a.GetParameterValues(&CODECAPI_AVEncCommonRateControlMode,&mut ptr,&mut count).is_err() || ptr.is_null() {return None;}
        let mut modes=Vec::new();
        for i in 0..count {
            let value=&mut *ptr.add(i as usize);
            if let Ok(mode)=u32::try_from(&*value) {modes.push(mode);}
            let _=windows::Win32::System::Variant::VariantClear(value);
        }
        CoTaskMemFree(Some(ptr.cast())); Some(modes)
    });
    values.insert("advertised_rate_control_modes".into(),serde_json::json!(advertised_modes));
    serde_json::Value::Object(values)
}

unsafe fn set_codec_u32(api: &ICodecAPI, key: &GUID, val: u32) -> Result<()> {
    let var = VARIANT::from(val);
    api.SetValue(key, &var)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_annex_b_nalus() {
        let stream = [
            0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f, // SPS (type 7)
            0, 0, 1, 0x68, 0xce, 0x3c, 0x80,    // PPS (type 8)
            0, 0, 0, 1, 0x65, 0x88, 0x84,       // IDR (type 5)
        ];
        let nalus = split_annex_b_nalus(&stream);
        assert_eq!(nalus.len(), 3);
        assert_eq!(nalus[0][0] & 0x1F, 7);
        assert_eq!(nalus[1][0] & 0x1F, 8);
        assert_eq!(nalus[2][0] & 0x1F, 5);
    }
}
