//! Same-session GPU thumbnail. Never waits for the GPU, IPC or the UI.
use std::mem::ManuallyDrop;
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use windows::core::{Interface, Result};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::DXGI_ERROR_WAS_STILL_DRAWING;

static NEXT_SESSION: AtomicU32 = AtomicU32::new(1);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreviewConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}
impl PreviewConfig {
    pub fn bounded(width: u32, height: u32, fps: u32) -> Self {
        let fps = fps.clamp(5, 60);
        // At most ~62 MB/s raw pixels. Original 1080p60 would be ~498 MB/s.
        let (width, height) = super::fit_even_resolution(width, height, 960, 540);
        let scale = (15_552_000.0 / (width as f64 * height as f64 * fps as f64))
            .sqrt()
            .min(1.0);
        let width = ((width as f64 * scale) as u32 & !1).max(2);
        let height = ((height as f64 * scale) as u32 & !1).max(2);
        Self {
            width: width.clamp(64, 960),
            height: height.clamp(36, 540),
            fps,
        }
    }
}
struct SlotState {
    active: bool,
    enabled: bool,
    generation: u32,
    frame: Option<Vec<u8>>,
    demand: Option<(PreviewConfig, Instant)>,
}
pub struct PreviewSlot {
    pub id: u32,
    state: Mutex<SlotState>,
    available: tokio::sync::Notify,
}
impl PreviewSlot {
    pub fn new() -> Self {
        Self {
            id: NEXT_SESSION.fetch_add(1, Ordering::Relaxed),
            state: Mutex::new(SlotState {
                active: true,
                enabled: false,
                generation: 0,
                frame: None,
                demand: None,
            }),
            available: tokio::sync::Notify::new(),
        }
    }
    pub fn visibility(&self, enabled: bool) -> u32 {
        let mut state = self.state.lock().unwrap();
        state.enabled = enabled && state.active;
        state.generation = state.generation.wrapping_add(1);
        state.frame = None;
        state.demand = None;
        self.available.notify_one();
        state.generation
    }
    pub async fn take(&self, config: PreviewConfig, generation: u32) -> Vec<u8> {
        // The single IPC consumer sleeps here; capture never sleeps waiting for it.
        let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
        loop {
            let notified = self.available.notified();
            {
                let mut state = self.state.lock().unwrap();
                if !state.active || !state.enabled || state.generation != generation {
                    return Vec::new();
                }
                if state.demand.is_some_and(|(previous, _)| previous != config) {
                    state.frame = None;
                }
                state.demand = Some((config, Instant::now()));
                if let Some(frame) = state.frame.take() {
                    return frame;
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Vec::new();
            }
        }
    }
    fn demand(&self) -> std::result::Result<Option<(PreviewConfig, u32)>, ()> {
        // Contention is not revocation: preserve pending resources and skip this tick.
        let state = self.state.try_lock().map_err(|_| ())?;
        if !state.active || !state.enabled {
            return Ok(None);
        }
        Ok(state
            .demand
            .filter(|(_, seen)| seen.elapsed() < Duration::from_millis(750))
            .map(|(config, _)| (config, state.generation)))
    }
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.active = false;
        state.frame = None;
        state.demand = None;
        self.available.notify_one();
    }
    fn publish(&self, frame: Vec<u8>, generation: u32) {
        if let Ok(mut state) = self.state.try_lock() {
            if state.active && state.enabled && state.generation == generation {
                state.frame = Some(frame);
                self.available.notify_one();
            }
        }
    }
}

struct GpuPreview {
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
    pub output_tex: ID3D11Texture2D,
    output_view: ID3D11VideoProcessorOutputView,
    staging: Option<ID3D11Texture2D>,
}

impl GpuPreview {
    pub fn new(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        src_w: u32,
        src_h: u32,
        dst_w: u32,
        dst_h: u32,
    ) -> Result<Self> {
        unsafe {
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

            let output_desc = D3D11_TEXTURE2D_DESC {
                Width: dst_w.max(2),
                Height: dst_h.max(2),
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut output_tex: Option<ID3D11Texture2D> = None;
            device.CreateTexture2D(&output_desc, None, Some(&mut output_tex))?;
            let output_tex = output_tex.unwrap();

            let ov_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                ..Default::default()
            };
            let mut output_view: Option<ID3D11VideoProcessorOutputView> = None;
            video_device.CreateVideoProcessorOutputView(
                &output_tex,
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
                output_tex,
                output_view,
                staging: None,
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
            let dst_rect = RECT {
                left: 0,
                top: 0,
                right: self.dst_w as i32,
                bottom: self.dst_h as i32,
            };
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
            self.video_context.VideoProcessorSetOutputTargetRect(
                &self.processor,
                true,
                Some(&dst_rect),
            );

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

    fn read_ready(&mut self, session: u32, sequence: u32) -> Result<Option<Vec<u8>>> {
        unsafe {
            let Some(staging) = &self.staging else {
                return Ok(None);
            };
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            match self.context.Map(
                staging,
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(&mut mapped),
            ) {
                Err(e) if e.code() == DXGI_ERROR_WAS_STILL_DRAWING => return Ok(None),
                Err(e) => return Err(e),
                Ok(()) => {}
            }
            let row_bytes = self.dst_w as usize * 4;
            let mut frame = Vec::with_capacity(32 + row_bytes * self.dst_h as usize);
            for value in [session, sequence, self.dst_w, self.dst_h, 0, 0, 0, 0] {
                frame.extend_from_slice(&value.to_le_bytes());
            }
            for row in 0..self.dst_h as usize {
                let bytes = std::slice::from_raw_parts(
                    (mapped.pData as *const u8).add(row * mapped.RowPitch as usize),
                    row_bytes,
                );
                frame.extend_from_slice(bytes);
            }
            self.context.Unmap(staging, 0);
            Ok(Some(frame))
        }
    }
    fn submit(&mut self, texture: &ID3D11Texture2D) -> Result<()> {
        self.convert(texture)?;
        unsafe {
            if self.staging.is_none() {
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                self.output_tex.GetDesc(&mut desc);
                desc.Usage = D3D11_USAGE_STAGING;
                desc.BindFlags = 0;
                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                self.device
                    .CreateTexture2D(&desc, None, Some(&mut self.staging))?;
            }
            self.context
                .CopyResource(self.staging.as_ref().unwrap(), &self.output_tex);
        }
        Ok(())
    }
}

pub struct PreviewSampler {
    gpu: Option<GpuPreview>,
    pending: bool,
    generation: u32,
    disabled: bool,
    sequence: u32,
    last_sample: Instant,
    last_request: Instant,
    next_sample: Instant,
    limited_until: Instant,
    priority_skips: u64,
    submit_ms: f64,
    read_ms: f64,
    ready_wait_ms: f64,
    sampled: u64,
    delivered: u64,
    gpu_busy: u64,
    cpu_total_ms: f64,
    cpu_max_ms: f64,
}
impl PreviewSampler {
    pub fn new() -> Self {
        Self {
            gpu: None,
            pending: false,
            generation: 0,
            disabled: false,
            sequence: 0,
            last_sample: Instant::now() - Duration::from_secs(1),
            last_request: Instant::now(),
            next_sample: Instant::now(),
            limited_until: Instant::now(),
            priority_skips: 0,
            submit_ms: 0.0,
            read_ms: 0.0,
            ready_wait_ms: 0.0,
            sampled: 0,
            delivered: 0,
            gpu_busy: 0,
            cpu_total_ms: 0.0,
            cpu_max_ms: 0.0,
        }
    }
    // Only bounded GPU submissions and a nonblocking Map; no IPC on capture thread.
    pub fn tick(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        texture: &ID3D11Texture2D,
        slot: &PreviewSlot,
        frame_period: Duration,
        capture_priority: bool,
    ) {
        let started = Instant::now();
        let prior_size = self
            .gpu
            .as_ref()
            .map(|g| (g.src_w, g.src_h, g.dst_w, g.dst_h));
        self.tick_inner(device, context, texture, slot, capture_priority);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        self.cpu_total_ms += ms;
        self.cpu_max_ms = self.cpu_max_ms.max(ms);
        let same_size = prior_size.is_some()
            && prior_size
                == self
                    .gpu
                    .as_ref()
                    .map(|g| (g.src_w, g.src_h, g.dst_w, g.dst_h));
        if same_size && ms > (frame_period.as_secs_f64() * 1000.0 * 0.15).max(2.0) {
            self.limited_until = Instant::now() + Duration::from_secs(3);
        }
    }
    pub fn invalidate_source(&mut self, slot: &PreviewSlot) {
        self.pending=false;self.gpu=None;self.disabled=false;self.next_sample=Instant::now();
        if let Ok(mut state)=slot.state.try_lock() {state.frame=None;}
    }
    pub fn diagnostics(&self) -> String {
        format!("screen_preview sampled={} delivered={} gpu_busy={} disabled={} cpu_total_ms={:.3} cpu_max_ms={:.3} submit_ms={:.3} read_ms={:.3} ready_wait_ms={:.3} priority_skips={}",
            self.sampled, self.delivered, self.gpu_busy, self.disabled, self.cpu_total_ms, self.cpu_max_ms,
            self.submit_ms, self.read_ms, self.ready_wait_ms, self.priority_skips)
    }
    fn tick_inner(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        texture: &ID3D11Texture2D,
        slot: &PreviewSlot,
        capture_priority: bool,
    ) {
        let demand = match slot.demand() {
            Ok(demand) => demand,
            Err(()) => return,
        };
        let Some((mut config, generation)) = demand else {
            self.pending = false;
            self.gpu = None;
            return;
        };
        if generation != self.generation {
            self.gpu = None;
            self.pending = false;
            self.disabled = false;
            self.generation = generation;
            self.next_sample = Instant::now();
        }
        if self.disabled {
            return;
        }
        if self.pending {
            let read_started = Instant::now();
            let result = self
                .gpu
                .as_mut()
                .unwrap()
                .read_ready(slot.id, self.sequence);
            self.read_ms += read_started.elapsed().as_secs_f64() * 1000.0;
            match result {
                Ok(Some(frame)) => {
                    self.pending = false;
                    self.delivered += 1;
                    self.ready_wait_ms += self.last_sample.elapsed().as_secs_f64() * 1000.0;
                    slot.publish(frame, self.generation);
                }
                Ok(None) => {
                    self.gpu_busy += 1;
                    if self.last_sample.elapsed() > Duration::from_millis(500) {
                        self.disable();
                    }
                    return;
                }
                Err(_) => {
                    self.disable();
                    return;
                }
            }
        }
        self.last_request = Instant::now();
        if capture_priority {
            self.priority_skips += 1;
            self.limited_until = Instant::now() + Duration::from_secs(3);
            return;
        }
        if Instant::now() < self.limited_until {
            config = PreviewConfig::bounded(
                config.width.min(480),
                config.height.min(270),
                config.fps.min(15),
            );
        }
        let now = Instant::now();
        if now < self.next_sample {
            return;
        }
        let period = Duration::from_secs_f64(1.0 / config.fps as f64);
        // Keep the sampling clock, rather than adding a period after each late tick.
        self.next_sample += period;
        if self.next_sample < now {
            self.next_sample = now + period;
        }
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            texture.GetDesc(&mut desc);
        }
        let (width, height) =
            super::fit_even_resolution(desc.Width, desc.Height, config.width, config.height);
        if self.gpu.as_ref().is_none_or(|g| {
            g.src_w != desc.Width || g.src_h != desc.Height || g.dst_w != width || g.dst_h != height
        }) {
            match GpuPreview::new(device, context, desc.Width, desc.Height, width, height) {
                Ok(gpu) => self.gpu = Some(gpu),
                Err(_) => {
                    self.disable();
                    return;
                }
            }
        }
        let submit_started = Instant::now();
        if self.gpu.as_mut().unwrap().submit(texture).is_err() {
            self.disable();
            return;
        }
        self.submit_ms += submit_started.elapsed().as_secs_f64() * 1000.0;
        self.sequence = self.sequence.wrapping_add(1).max(1);
        self.sampled += 1;
        self.pending = true;
        self.last_sample = Instant::now();
    }
    fn disable(&mut self) {
        // Preview errors must never affect capture, encoder or peer state.
        self.disabled = true;
        self.pending = false;
        self.gpu = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn preview_slot_is_bounded_and_cannot_publish_after_close() {
        let slot = std::sync::Arc::new(PreviewSlot::new());
        let config = PreviewConfig::bounded(480, 270, 15);
        let generation = slot.visibility(true);
        slot.publish(vec![1], generation);
        slot.publish(vec![2], generation);
        assert_eq!(slot.take(config, generation).await, vec![2]);
        let waiting = {
            let slot = slot.clone();
            tokio::spawn(async move { slot.take(config, generation).await })
        };
        tokio::time::sleep(Duration::from_millis(5)).await;
        slot.close();
        assert!(waiting.await.unwrap().is_empty());
        slot.publish(vec![3], generation);
        assert!(slot.take(config, generation).await.is_empty());
        assert!(slot.demand().unwrap().is_none());
        assert_ne!(slot.id, PreviewSlot::new().id);
    }
    #[tokio::test]
    async fn preview_waits_for_newest_frame_and_wakes_without_polling() {
        let slot = std::sync::Arc::new(PreviewSlot::new());
        let generation = slot.visibility(true);
        let config = PreviewConfig::bounded(9999, 9999, 9999);
        assert!(config.width as u64 * config.height as u64 * config.fps as u64 <= 15_552_000);
        assert_eq!(config.fps, 60);
        let waiting = {
            let slot = slot.clone();
            tokio::spawn(async move { slot.take(config, generation).await })
        };
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(!waiting.is_finished());
        slot.publish(vec![7], generation);
        assert_eq!(waiting.await.unwrap(), vec![7]);
        slot.close();
    }
    #[tokio::test]
    async fn eye_off_cancels_wait_and_reenable_rejects_old_generation() {
        let slot = std::sync::Arc::new(PreviewSlot::new());
        let config = PreviewConfig::bounded(640, 360, 60);
        let old = slot.visibility(true);
        let waiting = {
            let slot = slot.clone();
            tokio::spawn(async move { slot.take(config, old).await })
        };
        tokio::time::sleep(Duration::from_millis(5)).await;
        slot.visibility(false);
        assert!(waiting.await.unwrap().is_empty());
        assert!(slot.demand().unwrap().is_none());
        let new = slot.visibility(true);
        slot.publish(vec![8], old);
        assert!(slot.take(config, old).await.is_empty());
        slot.publish(vec![9], new);
        assert_eq!(slot.take(config, new).await, vec![9]);
        slot.close();
    }
    #[test]
    fn demand_contention_does_not_revoke_resources() {
        let slot = PreviewSlot::new();
        let _guard = slot.state.lock().unwrap();
        assert!(slot.demand().is_err());
    }
    #[test]
    fn preview_gpu_downscales_known_pixels_without_blocking_map() {
        let (device, context) =
            super::super::dxgi_wgc::create_d3d11_on_adapter(0).expect("D3D11 device");
        let pixels = [20u8, 80, 180, 255].repeat(960 * 540);
        let mut texture = None;
        unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: 960,
                Height: 540,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
                ..Default::default()
            };
            let initial = D3D11_SUBRESOURCE_DATA {
                pSysMem: pixels.as_ptr().cast(),
                SysMemPitch: 960 * 4,
                SysMemSlicePitch: 0,
            };
            device
                .CreateTexture2D(&desc, Some(&initial), Some(&mut texture))
                .expect("synthetic texture");
        }
        let mut gpu =
            GpuPreview::new(&device, &context, 960, 540, 640, 360).expect("GPU downscaler");
        gpu.submit(&texture.unwrap()).expect("GPU submit");
        let start = Instant::now();
        let frame = loop {
            if let Some(frame) = gpu.read_ready(42, 1).expect("nonblocking map") {
                break frame;
            }
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "GPU thumbnail timeout"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(frame.len(), 32 + 640 * 360 * 4);
        for (got, expected) in frame[32..35].iter().zip([20i16, 80, 180]) {
            assert!((*got as i16 - expected).abs() <= 4, "GPU color mismatch");
        }
        // Only timing/size evidence; never store pixels, even for this synthetic source.
        eprintln!(
            "preview_gpu synthetic=960x540 thumbnail=640x360 read_ready_ms={:.3}",
            start.elapsed().as_secs_f64() * 1000.0
        );
    }
}
