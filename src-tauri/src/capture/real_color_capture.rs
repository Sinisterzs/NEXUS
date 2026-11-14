//! Diagnostic only. Crop the explicitly owned chart window BEFORE CPU readback.
use super::{W,H};
use windows::{core::Interface,Win32::{Foundation::{HWND,POINT,RECT},Graphics::{Direct3D11::*,Dxgi::{IDXGIDevice,IDXGIOutput6,Common::*}},UI::WindowsAndMessaging::*}};
use crate::capture::dxgi_wgc::{CaptureTarget,DxgiCapturer,WgcCapturer};
type E=Box<dyn std::error::Error>;
struct DpiGuard(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT);
impl Drop for DpiGuard {fn drop(&mut self){unsafe{let _=windows::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(self.0);}}}
struct WinrtGuard;
impl Drop for WinrtGuard {fn drop(&mut self){unsafe{windows::Win32::System::WinRT::RoUninitialize();}}}

unsafe fn check_window(hwnd:HWND, owner:u32) -> Result<RECT,E> {
    let mut pid=0;GetWindowThreadProcessId(hwnd,Some(&mut pid));
    if pid!=owner || owner==0 || !IsWindowVisible(hwnd).as_bool() || GetForegroundWindow()!=hwnd {
        return Err("Synthetic window must be visible, foreground, and owned by the supplied renderer process".into());
    }
    let mut r=RECT::default();GetWindowRect(hwnd,&mut r)?;
    let mut client=RECT::default();GetClientRect(hwnd,&mut client)?;
    if r.right-r.left<W as i32 || r.bottom-r.top<H as i32 || client.right!=r.right-r.left || client.bottom!=r.bottom-r.top {
        return Err("Synthetic window must be borderless, unscaled, and contain the 1280x720 chart".into());
    }
    // Reject occlusion at a dense grid before and after acquisition. Do not enumerate app titles.
    for y in (4..client.bottom).step_by(32) {for x in (4..client.right).step_by(32) {
        if WindowFromPoint(POINT{x:r.left+x,y:r.top+y})!=hwnd {return Err("Chart is occluded; nothing will be exported".into());}
    }}
    Ok(r)
}

// A privacy/alignment gate, NOT a color correctness assertion: permit systematic color
// shifts, but reject textured content, unexpected layout, and nonuniform chart interiors.
fn validate_chart(pixels:&[u8]) -> Result<(),E> {
    if pixels.len()!=W*H*4 {return Err("Invalid chart size".into());}
    let mut means=Vec::new();
    for i in 0..24 {
        let x=i%8*160+12;let y=i/8*160+12;let mut sum=[0u64;3];let mut lo=[255u8;3];let mut hi=[0u8;3];
        for yy in y..y+136 {for xx in x..x+136 {for c in 0..3 {
            let v=pixels[(yy*W+xx)*4+2-c];sum[c]+=v as u64;lo[c]=lo[c].min(v);hi[c]=hi[c].max(v);
        }}}
        let mean=sum.map(|v|v as f64/(136.0*136.0));
        for c in 0..3 {
            if hi[c]-lo[c]>8 || (mean[c]-super::COLORS[i][c] as f64).abs()>70.0 {
                return Err(format!("Synthetic layout gate failed: patch={} channel_rgb={} min={} max={} spread={} mean={:.3} expected={}; no captured pixels or encoded media exported",i,c,lo[c],hi[c],hi[c]-lo[c],mean[c],super::COLORS[i][c]).into());
            }
        }
        means.push(mean);
    }
    if means[0].iter().any(|v|*v>50.0) || means[7].iter().any(|v|*v<200.0) {
        return Err("Synthetic black/white markers missing".into());
    }
    // Validate the gradient region too, including every pixel. No exported strip is unchecked.
    for y in 480..H {for x in 0..W {
        let v=x as f64*255.0/(W-1) as f64;
        for c in 0..3 {let expected=if (y-480)/60==0 || (y-480)/60==c+1 {v}else{0.0};
            if (pixels[(y*W+x)*4+2-c] as f64-expected).abs()>70.0 {return Err("Synthetic gradient gate failed".into());}
        }
    }}
    // Validate patch edges as well. Tolerance deliberately allows a systematic SDR error.
    for y in 0..480 {for x in 0..W {let rgb=super::COLORS[y/160*8+x/160];
        for c in 0..3 {if (pixels[(y*W+x)*4+2-c] as f64-rgb[c] as f64).abs()>70.0 {return Err("Synthetic patch boundary gate failed".into());}}
    }}
    Ok(())
}

pub(super) fn acquire(device:&ID3D11Device, context:&ID3D11DeviceContext, adapter_index:u32, backend:&str, window:isize, owner:u32)
 -> Result<(ID3D11Texture2D,Vec<u8>,serde_json::Value),E> {
 unsafe {
    use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext,DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    let old=SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if old.0.is_null(){return Err("Could not establish physical-pixel DPI context".into());}
    let _dpi=DpiGuard(old);
    let hwnd=HWND(window as *mut _);let rect=check_window(hwnd,owner)?;
    windows::Win32::Graphics::Dwm::DwmFlush()?;
    let _winrt=if backend=="wgc" {
        windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED)?;
        Some(WinrtGuard)
    }else{None};
    let dxgi:IDXGIDevice=device.cast()?;let adapter=dxgi.GetAdapter()?;
    let mut oi=0;let (output_index,out,od)=loop {
        let out=adapter.EnumOutputs(oi)?;let d=out.GetDesc()?;
        if d.AttachedToDesktop.as_bool() && rect.left>=d.DesktopCoordinates.left && rect.top>=d.DesktopCoordinates.top && rect.right<=d.DesktopCoordinates.right && rect.bottom<=d.DesktopCoordinates.bottom {break (oi,out,d);}
        oi+=1;
    };
    if rect!=od.DesktopCoordinates {return Err("Synthetic window must cover the entire chosen monitor; refusing to acquire a desktop with personal regions".into());}
    if od.Rotation!=DXGI_MODE_ROTATION_IDENTITY {return Err("Rotated outputs are not supported by this diagnostic; no fallback".into());}
    let color=out.cast::<IDXGIOutput6>().ok().and_then(|v|v.GetDesc1().ok()).map(|v|serde_json::json!({"colorSpace":v.ColorSpace.0,"bitsPerColor":v.BitsPerColor,"minLuminance":v.MinLuminance,"maxLuminance":v.MaxLuminance}));
    let mut dx=if backend=="dxgi" {Some(DxgiCapturer::new(device,adapter_index,output_index,od.Monitor.0 as isize,false)?)}else{None};
    let mut wg=if backend=="wgc" {Some(WgcCapturer::new(device,&CaptureTarget::WgcWindow{hwnd:window},false)?)}else{None};
    // Always close WGC, including errors during acquisition/readback.
    let result=(|| -> Result<_,E> {
        let start=std::time::Instant::now();let mut attempts=0;
        let texture=loop {
            check_window(hwnd,owner)?;attempts+=1;
            let (t,fresh)=if let Some(d)=dx.as_mut(){d.acquire_into_texture(device,context,100)?}else{wg.as_mut().unwrap().acquire_into_texture(device,context,100)?};
            if fresh {if let Some(t)=t{break t;}}
            if start.elapsed()>std::time::Duration::from_secs(5){return Err("No fresh capture frame within five seconds".into());}
        };
        let after=check_window(hwnd,owner)?;
        if rect!=after {return Err("Chart moved during acquisition".into());}
        let mut desc=D3D11_TEXTURE2D_DESC::default();texture.GetDesc(&mut desc);
        if desc.Format!=DXGI_FORMAT_B8G8R8A8_UNORM || desc.SampleDesc.Count!=1 {return Err("Unexpected capture format; refusing to reinterpret pixels".into());}
        let x=((rect.right-rect.left-W as i32)/2) as u32;let y=((rect.bottom-rect.top-H as i32)/2) as u32;
        if x+W as u32>desc.Width || y+H as u32>desc.Height || desc.Width!=(rect.right-rect.left) as u32 || desc.Height!=(rect.bottom-rect.top) as u32 {return Err("Capture dimensions do not match synthetic monitor/window".into());}
        let crop_desc=D3D11_TEXTURE2D_DESC{Width:W as u32,Height:H as u32,MipLevels:1,ArraySize:1,Format:desc.Format,SampleDesc:DXGI_SAMPLE_DESC{Count:1,Quality:0},Usage:D3D11_USAGE_DEFAULT,BindFlags:(D3D11_BIND_SHADER_RESOURCE.0|D3D11_BIND_RENDER_TARGET.0) as u32,..Default::default()};
        let mut cropped=None;device.CreateTexture2D(&crop_desc,None,Some(&mut cropped))?;let cropped=cropped.unwrap();
        context.CopySubresourceRegion(&cropped,0,0,0,0,&texture,0,Some(&D3D11_BOX{left:x,top:y,front:0,right:x+W as u32,bottom:y+H as u32,back:1}));
        let mut staging=None;device.CreateTexture2D(&D3D11_TEXTURE2D_DESC{Usage:D3D11_USAGE_STAGING,BindFlags:0,CPUAccessFlags:D3D11_CPU_ACCESS_READ.0 as u32,..crop_desc},None,Some(&mut staging))?;
        let staging=staging.unwrap();context.CopyResource(&staging,&cropped);
        let mut map=D3D11_MAPPED_SUBRESOURCE::default();context.Map(&staging,0,D3D11_MAP_READ,0,Some(&mut map))?;
        let mut pixels=Vec::with_capacity(W*H*4);
        for row in 0..H {pixels.extend_from_slice(std::slice::from_raw_parts((map.pData as *const u8).add(row*map.RowPitch as usize),W*4));}
        context.Unmap(&staging,0);check_window(hwnd,owner)?;
        crate::capture::log_capture_diag(None,&format!("color_probe_roi backend={} texture={}x{} format={} crop_xy={},{} roi={}x{} fresh=true window_verified=true",backend,desc.Width,desc.Height,desc.Format.0,x,y,W,H));
        validate_chart(&pixels)?;
        Ok((cropped,pixels,serde_json::json!({"backendRequested":backend,"backendActual":backend,"fallback":false,"captureTextureWidth":desc.Width,"captureTextureHeight":desc.Height,"captureTextureFormat":desc.Format.0,"samples":desc.SampleDesc.Count,"roiWidth":W,"roiHeight":H,"outputIndex":output_index,"displayColorMetadata":color,"freshFramesCaptured":1,"acquisitionAttempts":attempts,"syntheticGate":"passed-layout-only-not-color-correctness","fullMonitorPersisted":false,"cursorEnabled":false,"roiResized":false})))
    })();
    if let Some(w)=wg.take(){w.close();} drop(dx);
    result
 }
}

#[cfg(test)] mod tests {
 use super::*;
 #[test] fn synthetic_gate_accepts_reference_and_systematic_shift() {
    let (mut p,_)=super::super::chart();assert!(validate_chart(&p).is_ok());
    for pixel in p.chunks_exact_mut(4){for c in 0..3{pixel[c]=pixel[c].saturating_add(8);}}
    assert!(validate_chart(&p).is_ok());
 }
 #[test] fn synthetic_gate_rejects_texture_and_wrong_layout() {
    let (mut p,_)=super::super::chart();p[(40*W+40)*4]=255;let failure=validate_chart(&p).unwrap_err().to_string();assert!(failure.contains("patch=0"));assert!(failure.contains("spread=255"));
    assert!(validate_chart(&vec![0;W*H*4]).is_err());assert!(validate_chart(&[0;4]).is_err());
 }
}
