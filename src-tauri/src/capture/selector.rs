use std::collections::HashMap;
use windows::core::{Interface, Result, BOOL, PWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Dxgi::Common::DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput6, DXGI_OUTPUT_DESC, DXGI_OUTPUT_DESC1,
};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayDevicesW, EnumDisplayMonitors, GetMonitorInfoW, DISPLAY_DEVICEW, HDC, HMONITOR,
    MONITORINFOEXW,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, GW_OWNER, MONITORINFOF_PRIMARY,
    WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

use super::{CaptureSourceInfo, CaptureSourceKind, CaptureSources};

#[derive(Clone, Debug)]
struct DxgiOutputMeta {
    adapter_index: u32,
    output_index: u32,
    is_hdr: bool,
}

fn collect_dxgi_output_meta_map() -> HashMap<String, DxgiOutputMeta> {
    let mut map = HashMap::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return map;
        };
        let mut adapter_idx = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(adapter_idx) {
            let mut out_idx = 0u32;
            while let Ok(output) = adapter.EnumOutputs(out_idx) {
                if let Ok(desc) = output.GetDesc() {
                    let odesc: DXGI_OUTPUT_DESC = desc;
                    let name = utf16_z(&odesc.DeviceName);
                    let mut is_hdr = false;
                    if let Ok(output6) = output.cast::<IDXGIOutput6>() {
                        if let Ok(d1) = output6.GetDesc1() {
                            let d1: DXGI_OUTPUT_DESC1 = d1;
                            is_hdr = d1.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020
                                || d1.BitsPerColor >= 10;
                        }
                    }
                    map.insert(
                        name,
                        DxgiOutputMeta {
                            adapter_index: adapter_idx,
                            output_index: out_idx,
                            is_hdr,
                        },
                    );
                }
                out_idx += 1;
            }
            adapter_idx += 1;
        }
    }
    map
}

fn utf16_z(slice: &[u16]) -> String {
    let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
    String::from_utf16_lossy(&slice[..end])
}

fn query_monitor_friendly_name(device_name: &str) -> String {
    unsafe {
        let wide_dev: Vec<u16> = device_name.encode_utf16().chain(Some(0)).collect();
        let mut dd = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        if EnumDisplayDevicesW(
            windows::core::PCWSTR(wide_dev.as_ptr()),
            0,
            &mut dd,
            0,
        )
        .as_bool()
        {
            let s = utf16_z(&dd.DeviceString);
            if !s.is_empty() {
                return s;
            }
        }
        device_name.to_string()
    }
}

struct MonitorEnumCtx<'a> {
    meta_map: &'a HashMap<String, DxgiOutputMeta>,
    monitors: Vec<CaptureSourceInfo>,
}

unsafe extern "system" fn enum_monitor_proc(
    hmonitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut MonitorEnumCtx);
    let mut mi = MONITORINFOEXW::default();
    mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if !GetMonitorInfoW(hmonitor, &mut mi.monitorInfo).as_bool() {
        return BOOL(1);
    }

    let rc = mi.monitorInfo.rcMonitor;
    let dev_name = utf16_z(&mi.szDevice);
    let friendly = query_monitor_friendly_name(&dev_name);

    let mut dpi_x = 96u32;
    let mut dpi_y = 96u32;
    let _ = GetDpiForMonitor(hmonitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);

    let meta = ctx.meta_map.get(&dev_name);
    let raw = hmonitor.0 as isize;
    let is_primary = (mi.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0;
    let width = (rc.right - rc.left).max(0) as u32;
    let height = (rc.bottom - rc.top).max(0) as u32;

    ctx.monitors.push(CaptureSourceInfo {
        id: format!("monitor:0x{:X}", raw),
        kind: CaptureSourceKind::DxgiMonitor,
        title: friendly,
        process_name: "Desktop".to_string(),
        pid: 0,
        width,
        height,
        is_primary,
        is_hdr: meta.map(|m| m.is_hdr).unwrap_or(false),
        is_minimized: false,
        left: rc.left,
        top: rc.top,
        scale_factor: (dpi_x as f32) / 96.0,
        device_name: Some(dev_name),
        adapter_index: meta.map(|m| m.adapter_index),
        output_index: meta.map(|m| m.output_index),
    });

    BOOL(1)
}

pub fn enumerate_monitors() -> Result<Vec<CaptureSourceInfo>> {
    let meta_map = collect_dxgi_output_meta_map();
    let mut ctx = MonitorEnumCtx {
        meta_map: &meta_map,
        monitors: Vec::new(),
    };
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(enum_monitor_proc),
            LPARAM(&mut ctx as *mut _ as isize),
        );
    }
    Ok(ctx.monitors)
}

fn query_process_name(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = vec![0u16; 512];
        let mut len = buf.len() as u32;
        let res = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        if res.is_ok() && len > 0 {
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            full.rsplit('\\').next().unwrap_or(&full).to_string()
        } else {
            String::new()
        }
    }
}

unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<CaptureSourceInfo>);

    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }

    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if (ex_style & WS_EX_TOOLWINDOW.0) != 0 && (ex_style & WS_EX_APPWINDOW.0) == 0 {
        return BOOL(1);
    }

    if let Ok(owner) = GetWindow(hwnd, GW_OWNER) {
        if !owner.is_invalid() && (ex_style & WS_EX_APPWINDOW.0) == 0 {
            return BOOL(1);
        }
    }

    // Filter out DWM-cloaked UWP/virtual-desktop hidden windows
    let mut cloaked: u32 = 0;
    if DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        (&mut cloaked as *mut u32).cast(),
        std::mem::size_of::<u32>() as u32,
    )
    .is_ok()
        && cloaked != 0
    {
        return BOOL(1);
    }

    let title_len = GetWindowTextLengthW(hwnd);
    if title_len <= 0 {
        return BOOL(1);
    }
    let mut title_buf = vec![0u16; (title_len + 1) as usize];
    let copied = GetWindowTextW(hwnd, &mut title_buf);
    if copied <= 0 {
        return BOOL(1);
    }
    let title = String::from_utf16_lossy(&title_buf[..copied as usize]);
    if title.trim().is_empty() {
        return BOOL(1);
    }

    let is_minimized = IsIconic(hwnd).as_bool();
    let mut rect = RECT::default();
    let _ = GetWindowRect(hwnd, &mut rect);
    let width = (rect.right - rect.left).max(0) as u32;
    let height = (rect.bottom - rect.top).max(0) as u32;
    if !is_minimized && (width <= 1 || height <= 1) {
        return BOOL(1);
    }

    let mut pid: u32 = 0;
    let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let process_name = if pid != 0 {
        query_process_name(pid)
    } else {
        String::new()
    };

    let raw = hwnd.0 as isize;
    list.push(CaptureSourceInfo {
        id: format!("window:0x{:X}", raw),
        kind: CaptureSourceKind::WgcWindow,
        title,
        process_name,
        pid,
        width,
        height,
        is_primary: false,
        is_hdr: false,
        is_minimized,
        left: rect.left,
        top: rect.top,
        scale_factor: 1.0,
        device_name: None,
        adapter_index: None,
        output_index: None,
    });

    BOOL(1)
}

pub fn enumerate_windows() -> Result<Vec<CaptureSourceInfo>> {
    let mut list: Vec<CaptureSourceInfo> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(enum_window_proc),
            LPARAM(&mut list as *mut _ as isize),
        );
    }
    Ok(list)
}

pub fn enumerate_all_sources() -> Result<CaptureSources> {
    Ok(CaptureSources {
        monitors: enumerate_monitors()?,
        windows: enumerate_windows()?,
    })
}

/// Parses a `source_id` (`monitor:0x...` or `window:0x...`) into a raw handle value.
pub fn parse_source_handle(id: &str) -> Option<(CaptureSourceKind, isize)> {
    if let Some(rest) = id.strip_prefix("monitor:") {
        let val = parse_isize_hex_or_dec(rest)?;
        Some((CaptureSourceKind::DxgiMonitor, val))
    } else if let Some(rest) = id.strip_prefix("wgc_monitor:") {
        let val = parse_isize_hex_or_dec(rest)?;
        Some((CaptureSourceKind::WgcMonitor, val))
    } else if let Some(rest) = id.strip_prefix("window:") {
        let val = parse_isize_hex_or_dec(rest)?;
        Some((CaptureSourceKind::WgcWindow, val))
    } else {
        None
    }
}

fn parse_isize_hex_or_dec(s: &str) -> Option<isize> {
    let trimmed = s.trim();
    if let Some(hex) = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        usize::from_str_radix(hex, 16).ok().map(|v| v as isize)
    } else {
        trimmed.parse::<isize>().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_source_handle() {
        assert_eq!(
            parse_source_handle("monitor:0x10001"),
            Some((CaptureSourceKind::DxgiMonitor, 0x10001))
        );
        assert_eq!(
            parse_source_handle("window:0xABCD"),
            Some((CaptureSourceKind::WgcWindow, 0xABCD))
        );
        assert_eq!(
            parse_source_handle("wgc_monitor:12345"),
            Some((CaptureSourceKind::WgcMonitor, 12345))
        );
        assert_eq!(parse_source_handle("invalid:123"), None);
    }
}
