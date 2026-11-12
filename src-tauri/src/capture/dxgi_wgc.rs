use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use windows::core::{factory, Interface, Result};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureAccess, GraphicsCaptureAccessKind,
    GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HMODULE, HWND, POINT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_RESOURCE_MISC_GDI_COMPATIBLE, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIDevice, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication,
    IDXGIResource, IDXGISurface1, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT,
    DXGI_OUTDUPL_FRAME_INFO,
};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::{
    DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, ICONINFO,
};

#[derive(Clone, Debug)]
pub enum CaptureTarget {
    DxgiMonitor {
        hmonitor: isize,
        adapter_index: u32,
        output_index: u32,
    },
    WgcMonitor {
        hmonitor: isize,
    },
    WgcWindow {
        hwnd: isize,
    },
}

pub fn create_d3d11_on_adapter(adapter_index: u32) -> Result<(ID3D11Device, ID3D11DeviceContext)> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
        let adapter = factory
            .EnumAdapters1(adapter_index)
            .or_else(|_| factory.EnumAdapters1(0))?;

        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        let mut fl = D3D_FEATURE_LEVEL_11_0;
        D3D11CreateDevice(
            &adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut fl),
            Some(&mut context),
        )?;
        Ok((device.unwrap(), context.unwrap()))
    }
}

pub struct WgcCapturer {
    d3d_winrt_device: IDirect3DDevice,
    item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    frame_token: i64,
    closed_token: i64,
    signal: Arc<(Mutex<u64>, Condvar)>,
    closed_flag: Arc<AtomicBool>,
    pool_w: u32,
    pool_h: u32,
    pub src_w: u32,
    pub src_h: u32,
    pub borderless_ok: bool,
    pub cursor_enabled: bool,
    cached_tex: Option<ID3D11Texture2D>,
}

impl WgcCapturer {
    pub fn new(
        device: &ID3D11Device,
        target: &CaptureTarget,
        cursor_enabled: bool,
    ) -> Result<Self> {
        let _borderless_req =
            GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless)
                .ok()
                .and_then(|op| op.join().ok());

        let dxgi_device: IDXGIDevice = device.cast()?;
        let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device)? };
        let d3d_winrt_device: IDirect3DDevice = inspectable.cast()?;
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;

        let item: GraphicsCaptureItem = unsafe {
            match target {
                CaptureTarget::WgcWindow { hwnd } => {
                    interop.CreateForWindow(HWND(*hwnd as *mut std::ffi::c_void))?
                }
                CaptureTarget::WgcMonitor { hmonitor }
                | CaptureTarget::DxgiMonitor { hmonitor, .. } => {
                    let hmon = if *hmonitor != 0 {
                        HMONITOR(*hmonitor as *mut std::ffi::c_void)
                    } else {
                        MonitorFromWindow(HWND::default(), MONITOR_DEFAULTTOPRIMARY)
                    };
                    interop.CreateForMonitor(hmon)?
                }
            }
        };

        let sz = item.Size()?;
        if sz.Width <= 0 || sz.Height <= 0 {
            return Err(windows::core::Error::from_hresult(windows::core::HRESULT(-1)));
        }

        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &d3d_winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            sz,
        )?;
        let session = pool.CreateCaptureSession(&item)?;
        let _ = session.SetIsCursorCaptureEnabled(cursor_enabled);
        let border_before = session.SetIsBorderRequired(false).is_ok();

        let signal = Arc::new((Mutex::new(0u64), Condvar::new()));
        let signal_cb = Arc::clone(&signal);
        let frame_token = pool.FrameArrived(&TypedEventHandler::<
            Direct3D11CaptureFramePool,
            windows::core::IInspectable,
        >::new(move |_, _| {
            let (lock, cvar) = &*signal_cb;
            let mut count = lock.lock().unwrap();
            *count += 1;
            cvar.notify_one();
            Ok(())
        }))?;

        let closed_flag = Arc::new(AtomicBool::new(false));
        let closed_cb = Arc::clone(&closed_flag);
        let closed_token = item.Closed(&TypedEventHandler::<
            GraphicsCaptureItem,
            windows::core::IInspectable,
        >::new(move |_, _| {
            closed_cb.store(true, Ordering::SeqCst);
            Ok(())
        }))?;

        session.StartCapture()?;
        // Critical: Windows 11 requires SetIsBorderRequired(false) AFTER StartCapture()
        let border_after = session.SetIsBorderRequired(false).is_ok();

        Ok(Self {
            d3d_winrt_device,
            item,
            pool,
            session,
            frame_token,
            closed_token,
            signal,
            closed_flag,
            pool_w: sz.Width as u32,
            pool_h: sz.Height as u32,
            src_w: sz.Width as u32,
            src_h: sz.Height as u32,
            borderless_ok: border_before || border_after,
            cursor_enabled,
            cached_tex: None,
        })
    }

    pub fn is_closed(&self) -> bool {
        self.closed_flag.load(Ordering::Relaxed)
    }

    pub fn set_cursor_enabled(&mut self, enabled: bool) -> bool {
        self.cursor_enabled = enabled;
        self.session.SetIsCursorCaptureEnabled(enabled).is_ok()
    }

    pub fn acquire_into_texture(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        wait_ms: u64,
    ) -> Result<(Option<ID3D11Texture2D>, bool)> {
        let mut latest_frame = None;
        while let Ok(f) = self.pool.TryGetNextFrame() {
            if let Some(prev) = latest_frame.replace(f) {
                let _ = prev.Close();
            }
        }
        if latest_frame.is_none() && self.cached_tex.is_none() && wait_ms > 0 {
            let (lock, cvar) = &*self.signal;
            let guard = lock.lock().unwrap();
            let _ = cvar.wait_timeout(guard, Duration::from_millis(wait_ms));
            while let Ok(f) = self.pool.TryGetNextFrame() {
                if let Some(prev) = latest_frame.replace(f) {
                    let _ = prev.Close();
                }
            }
        }

        if let Some(frame) = latest_frame {
            if let Ok(content_sz) = frame.ContentSize() {
                if content_sz.Width > 0
                    && content_sz.Height > 0
                    && (content_sz.Width as u32 != self.pool_w
                        || content_sz.Height as u32 != self.pool_h)
                {
                    let new_sz = SizeInt32 {
                        Width: content_sz.Width,
                        Height: content_sz.Height,
                    };
                    if self
                        .pool
                        .Recreate(
                            &self.d3d_winrt_device,
                            DirectXPixelFormat::B8G8R8A8UIntNormalized,
                            2,
                            new_sz,
                        )
                        .is_ok()
                    {
                        self.pool_w = content_sz.Width as u32;
                        self.pool_h = content_sz.Height as u32;
                    }
                }
            }

            let surf = frame.Surface()?;
            let access: IDirect3DDxgiInterfaceAccess = surf.cast()?;
            let tex: ID3D11Texture2D = unsafe { access.GetInterface()? };

            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe {
                tex.GetDesc(&mut desc);
            }
            let need_realloc = match &self.cached_tex {
                None => true,
                Some(c) => {
                    let mut cd = D3D11_TEXTURE2D_DESC::default();
                    unsafe {
                        c.GetDesc(&mut cd);
                    }
                    cd.Width != desc.Width || cd.Height != desc.Height
                }
            };
            if need_realloc {
                desc.Usage = D3D11_USAGE_DEFAULT;
                desc.BindFlags = (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32;
                desc.CPUAccessFlags = 0;
                desc.MiscFlags = 0;
                let mut cpy: Option<ID3D11Texture2D> = None;
                unsafe {
                    device.CreateTexture2D(&desc, None, Some(&mut cpy))?;
                }
                self.cached_tex = cpy;
                self.src_w = desc.Width;
                self.src_h = desc.Height;
            }
            if let Some(ref cpy) = self.cached_tex {
                unsafe {
                    context.CopyResource(cpy, &tex);
                }
            }
            let _ = frame.Close();
            Ok((self.cached_tex.clone(), true))
        } else {
            Ok((self.cached_tex.clone(), false))
        }
    }

    pub fn close(self) {
        let _ = self.pool.RemoveFrameArrived(self.frame_token);
        let _ = self.item.RemoveClosed(self.closed_token);
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

pub struct DxgiCapturer {
    adapter_index: u32,
    output_index: u32,
    output1: IDXGIOutput1,
    dupl: IDXGIOutputDuplication,
    monitor_left: i32,
    monitor_top: i32,
    pub src_w: u32,
    pub src_h: u32,
    pub cursor_enabled: bool,
    desktop_tex: Option<ID3D11Texture2D>,
    cursor_tex: Option<ID3D11Texture2D>,
    pub access_lost_recoveries: u64,
}

impl DxgiCapturer {
    pub fn new(
        device: &ID3D11Device,
        adapter_index: u32,
        output_index: u32,
        hmonitor: isize,
        cursor_enabled: bool,
    ) -> Result<Self> {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
            let adapter = factory.EnumAdapters1(adapter_index)?;
            let output = adapter.EnumOutputs(output_index)?;
            let odesc = output.GetDesc()?;
            let mut left = odesc.DesktopCoordinates.left;
            let mut top = odesc.DesktopCoordinates.top;
            let src_w = (odesc.DesktopCoordinates.right - left).max(1) as u32;
            let src_h = (odesc.DesktopCoordinates.bottom - top).max(1) as u32;

            if hmonitor != 0 {
                let mut mi = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                if GetMonitorInfoW(HMONITOR(hmonitor as *mut std::ffi::c_void), &mut mi).as_bool() {
                    left = mi.rcMonitor.left;
                    top = mi.rcMonitor.top;
                }
            }

            let output1: IDXGIOutput1 = output.cast()?;
            let dupl = output1.DuplicateOutput(device)?;
            Ok(Self {
                adapter_index,
                output_index,
                output1,
                dupl,
                monitor_left: left,
                monitor_top: top,
                src_w,
                src_h,
                cursor_enabled,
                desktop_tex: None,
                cursor_tex: None,
                access_lost_recoveries: 0,
            })
        }
    }

    pub fn set_cursor_enabled(&mut self, enabled: bool) {
        self.cursor_enabled = enabled;
    }

    fn recreate_duplication(&mut self, device: &ID3D11Device) -> Result<()> {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
            let adapter = factory.EnumAdapters1(self.adapter_index)?;
            let output = adapter.EnumOutputs(self.output_index)?;
            let odesc = output.GetDesc()?;
            self.monitor_left = odesc.DesktopCoordinates.left;
            self.monitor_top = odesc.DesktopCoordinates.top;
            self.src_w = (odesc.DesktopCoordinates.right - self.monitor_left).max(1) as u32;
            self.src_h = (odesc.DesktopCoordinates.bottom - self.monitor_top).max(1) as u32;
            let output1: IDXGIOutput1 = output.cast()?;
            let dupl = output1.DuplicateOutput(device)?;
            self.output1 = output1;
            self.dupl = dupl;
            self.desktop_tex = None;
            self.cursor_tex = None;
            Ok(())
        }
    }

    fn ensure_textures(
        &mut self,
        device: &ID3D11Device,
        src_desc: &D3D11_TEXTURE2D_DESC,
    ) -> Result<()> {
        let need_realloc = match &self.desktop_tex {
            None => true,
            Some(c) => {
                let mut cd = D3D11_TEXTURE2D_DESC::default();
                unsafe {
                    c.GetDesc(&mut cd);
                }
                cd.Width != src_desc.Width || cd.Height != src_desc.Height
            }
        };

        if need_realloc {
            let mut d = *src_desc;
            d.Usage = D3D11_USAGE_DEFAULT;
            d.BindFlags = (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32;
            d.CPUAccessFlags = 0;
            d.MiscFlags = 0;
            let mut dt: Option<ID3D11Texture2D> = None;
            unsafe {
                device.CreateTexture2D(&d, None, Some(&mut dt))?;
            }
            self.desktop_tex = dt;

            // Separate GDI-compatible texture for clean cursor compositing without trails
            d.MiscFlags = D3D11_RESOURCE_MISC_GDI_COMPATIBLE.0 as u32;
            let mut ct: Option<ID3D11Texture2D> = None;
            if unsafe { device.CreateTexture2D(&d, None, Some(&mut ct)) }.is_ok() {
                self.cursor_tex = ct;
            } else {
                self.cursor_tex = None;
            }

            self.src_w = src_desc.Width;
            self.src_h = src_desc.Height;
        }
        Ok(())
    }

    fn draw_cursor_on_texture(&self, context: &ID3D11DeviceContext) -> Option<ID3D11Texture2D> {
        let desktop = self.desktop_tex.as_ref()?;
        let cursor_tex = self.cursor_tex.as_ref()?;

        unsafe {
            context.CopyResource(cursor_tex, desktop);
            let mut ci = CURSORINFO {
                cbSize: std::mem::size_of::<CURSORINFO>() as u32,
                ..Default::default()
            };
            if GetCursorInfo(&mut ci).is_ok() && (ci.flags.0 & CURSOR_SHOWING.0) != 0 {
                let mut hot_x = 0i32;
                let mut hot_y = 0i32;
                let mut ii = ICONINFO::default();
                if GetIconInfo(ci.hCursor.into(), &mut ii).is_ok() {
                    hot_x = ii.xHotspot as i32;
                    hot_y = ii.yHotspot as i32;
                    if !ii.hbmMask.is_invalid() {
                        let _ = windows::Win32::Graphics::Gdi::DeleteObject(ii.hbmMask.into());
                    }
                    if !ii.hbmColor.is_invalid() {
                        let _ = windows::Win32::Graphics::Gdi::DeleteObject(ii.hbmColor.into());
                    }
                }
                let pt: POINT = ci.ptScreenPos;
                let rel_x = pt.x - self.monitor_left - hot_x;
                let rel_y = pt.y - self.monitor_top - hot_y;
                if rel_x >= -64
                    && rel_y >= -64
                    && rel_x < (self.src_w as i32) + 64
                    && rel_y < (self.src_h as i32) + 64
                {
                    if let Ok(surf1) = cursor_tex.cast::<IDXGISurface1>() {
                        if let Ok(hdc) = surf1.GetDC(false) {
                            let _ = DrawIconEx(
                                hdc,
                                rel_x,
                                rel_y,
                                ci.hCursor.into(),
                                0,
                                0,
                                0,
                                None,
                                DI_NORMAL,
                            );
                            let _ = surf1.ReleaseDC(None);
                        }
                    }
                }
            }
            Some(cursor_tex.clone())
        }
    }

    pub fn acquire_into_texture(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        wait_ms: u32,
    ) -> Result<(Option<ID3D11Texture2D>, bool)> {
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut res_opt: Option<IDXGIResource> = None;
            match self.dupl.AcquireNextFrame(wait_ms, &mut info, &mut res_opt) {
                Ok(()) => {
                    let mut got_new = false;
                    if let Some(res) = res_opt {
                        let tex: ID3D11Texture2D = res.cast()?;
                        let mut desc = D3D11_TEXTURE2D_DESC::default();
                        tex.GetDesc(&mut desc);
                        self.ensure_textures(device, &desc)?;
                        if let Some(ref dt) = self.desktop_tex {
                            context.CopyResource(dt, &tex);
                            got_new = true;
                        }
                    }
                    let _ = self.dupl.ReleaseFrame();
                    let out_tex = if self.cursor_enabled {
                        self.draw_cursor_on_texture(context)
                            .or_else(|| self.desktop_tex.clone())
                    } else {
                        self.desktop_tex.clone()
                    };
                    Ok((out_tex, got_new))
                }
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    let out_tex = if self.cursor_enabled {
                        self.draw_cursor_on_texture(context)
                            .or_else(|| self.desktop_tex.clone())
                    } else {
                        self.desktop_tex.clone()
                    };
                    Ok((out_tex, false))
                }
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => {
                    self.access_lost_recoveries += 1;
                    self.recreate_duplication(device)?;
                    Ok((None, false))
                }
                Err(e) => Err(e),
            }
        }
    }
}

pub enum HybridCapturer {
    Dxgi(DxgiCapturer),
    Wgc(WgcCapturer, &'static str),
}

impl HybridCapturer {
    pub fn open(
        device: &ID3D11Device,
        target: &CaptureTarget,
        cursor_enabled: bool,
    ) -> Result<Self> {
        match target {
            CaptureTarget::DxgiMonitor {
                hmonitor,
                adapter_index,
                output_index,
            } => {
                match DxgiCapturer::new(
                    device,
                    *adapter_index,
                    *output_index,
                    *hmonitor,
                    cursor_enabled,
                ) {
                    Ok(dxgi) => Ok(Self::Dxgi(dxgi)),
                    Err(e) => {
                        eprintln!(
                            "[Capture] DXGI Desktop Duplication failed ({:?}), falling back to WgcMonitor",
                            e
                        );
                        let wgc = WgcCapturer::new(
                            device,
                            &CaptureTarget::WgcMonitor {
                                hmonitor: *hmonitor,
                            },
                            cursor_enabled,
                        )?;
                        Ok(Self::Wgc(wgc, "WgcMonitor"))
                    }
                }
            }
            CaptureTarget::WgcMonitor { .. } => {
                let wgc = WgcCapturer::new(device, target, cursor_enabled)?;
                Ok(Self::Wgc(wgc, "WgcMonitor"))
            }
            CaptureTarget::WgcWindow { .. } => {
                let wgc = WgcCapturer::new(device, target, cursor_enabled)?;
                Ok(Self::Wgc(wgc, "WgcWindow"))
            }
        }
    }

    pub fn backend_used(&self) -> &'static str {
        match self {
            Self::Dxgi(_) => "DxgiMonitor",
            Self::Wgc(_, kind) => kind,
        }
    }

    pub fn borderless_ok(&self) -> bool {
        match self {
            Self::Dxgi(_) => true, // DXGI Desktop Duplication never has a yellow border
            Self::Wgc(w, _) => w.borderless_ok,
        }
    }

    pub fn src_size(&self) -> (u32, u32) {
        match self {
            Self::Dxgi(d) => (d.src_w, d.src_h),
            Self::Wgc(w, _) => (w.src_w, w.src_h),
        }
    }

    pub fn is_closed(&self) -> bool {
        match self {
            Self::Dxgi(_) => false,
            Self::Wgc(w, _) => w.is_closed(),
        }
    }

    pub fn set_cursor_enabled(&mut self, enabled: bool) {
        match self {
            Self::Dxgi(d) => d.set_cursor_enabled(enabled),
            Self::Wgc(w, _) => {
                let _ = w.set_cursor_enabled(enabled);
            }
        }
    }

    pub fn acquire_into_texture(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        wait_ms: u64,
    ) -> Result<(Option<ID3D11Texture2D>, bool)> {
        match self {
            Self::Dxgi(d) => d.acquire_into_texture(device, context, wait_ms as u32),
            Self::Wgc(w, _) => w.acquire_into_texture(device, context, wait_ms),
        }
    }

    pub fn close(self) {
        match self {
            Self::Dxgi(d) => drop(d),
            Self::Wgc(w, _) => w.close(),
        }
    }
}
