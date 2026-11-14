//! Opt-in diagnostic probe. Real capture requires an explicitly supplied synthetic window.
use super::*;
use windows::Win32::Media::MediaFoundation::*;
pub(super) const W: usize = 1280;
pub(super) const H: usize = 720;
pub(super) const COLORS: [[u8;3]; 24] = [
    [0,0,0],[16,16,16],[32,32,32],[64,64,64],[128,128,128],[192,192,192],[235,235,235],[255,255,255],
    [255,0,0],[0,255,0],[0,0,255],[255,255,0],[0,255,255],[255,0,255],[192,128,96],[128,80,64],
    [32,64,96],[64,128,192],[96,160,96],[224,192,160],[192,64,64],[64,192,64],[64,64,192],[200,160,120],
];
pub(super) fn chart() -> (Vec<u8>, serde_json::Value) {
    let mut pixels=vec![0u8; W*H*4]; let mut patches=Vec::new();
    for (i,c) in COLORS.iter().enumerate() {
        let x=(i%8)*160; let y=(i/8)*160;
        for yy in y..y+160 { for xx in x..x+160 {
            let p=(yy*W+xx)*4; pixels[p..p+4].copy_from_slice(&[c[2],c[1],c[0],255]);
        }}
        patches.push(serde_json::json!({"index":i,"x":x+40,"y":y+40,"width":80,"height":80,"rgb":c}));
    }
    for y in 480..H { for x in 0..W {
        let v=(x*255/(W-1)) as u8;
        let c=match (y-480)/60 {0=>[v,v,v],1=>[v,0,0],2=>[0,v,0],_=>[0,0,v]};
        let p=(y*W+x)*4;pixels[p..p+4].copy_from_slice(&[c[2],c[1],c[0],255]);
    }}
    (pixels,serde_json::json!(patches))
}
pub(super) unsafe fn media_colors(mt: &IMFMediaType) -> serde_json::Value {
    let mut out=serde_json::Map::new();
    for (name,id) in [("matrix",MF_MT_YUV_MATRIX),("range",MF_MT_VIDEO_NOMINAL_RANGE),("primaries",MF_MT_VIDEO_PRIMARIES),("transfer",MF_MT_TRANSFER_FUNCTION),("chroma",MF_MT_VIDEO_CHROMA_SITING)] {
        out.insert(name.into(),serde_json::json!(mt.GetUINT32(&id).ok()));
    }
    serde_json::Value::Object(out)
}

fn has_analysis_frames(outputs: u32, raw_outputs: u32) -> bool { outputs>=31 && raw_outputs>=31 }
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn incomplete_mft_output_is_not_reported_as_analyzable() {
        for count in [0,1,30] {assert!(!has_analysis_frames(count,60));assert!(!has_analysis_frames(60,count));}
        assert!(has_analysis_frames(31,31));assert!(has_analysis_frames(60,60));
    }
}
#[cfg(feature = "color-diagnostics")]
pub fn run(output: &std::path::Path, expected_vendor: u32) -> std::result::Result<(),String> {
    run_internal(output, expected_vendor, None,"auto")
}
#[cfg(feature = "color-diagnostics")]
pub fn run_with_color_path(output:&std::path::Path,vendor:u32,path:&str) -> std::result::Result<(),String> {
    run_internal(output,vendor,None,path)
}
#[cfg(feature = "color-diagnostics")]
#[path = "real_color_capture.rs"]
mod real_capture;
#[cfg(feature = "color-diagnostics")]
pub fn run_capture(output: &std::path::Path, vendor: u32, backend: &str, hwnd: isize, owner: u32) -> std::result::Result<(),String> {
    if !matches!(backend,"dxgi"|"wgc") {return Err("Backend must be dxgi or wgc".into());}
    run_internal(output,vendor,Some((backend,hwnd,owner)),"auto")
}
#[cfg(feature = "color-diagnostics")]
fn run_internal(output: &std::path::Path, expected_vendor: u32, capture: Option<(&str,isize,u32)>,color_path:&str) -> std::result::Result<(),String> {
    use std::io::Write;
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1,IDXGIFactory1,IDXGIDevice,IDXGIOutput6};
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
    use windows::Win32::System::Com::{CoInitializeEx,CoUninitialize,COINIT_MULTITHREADED};
    // A new directory is mandatory: never overwrite unrelated or earlier results.
    std::fs::create_dir(output).map_err(|_|"Output directory must be new and its parent must exist".to_string())?;
    let mut report=serde_json::json!({"schema":1,"status":"starting","syntheticOnly":true,
        "captureStarted":false,"audioStarted":false,"peerCreated":false,
        "expectedVendorId":expected_vendor,"requestedColorPath":color_path,"width":W,"height":H,"framesInput":60,
        "fps":60,"bitrateUnchanged":3500000});
    let com=unsafe{CoInitializeEx(None,COINIT_MULTITHREADED).ok()};
    if com.is_err(){return Err("COM initialization failed".into());}
    let result=(|| -> std::result::Result<(),Box<dyn std::error::Error>> {
        unsafe{MFStartup(MF_VERSION,MFSTARTUP_NOSOCKET)?;}
        let factory:IDXGIFactory1=unsafe{CreateDXGIFactory1()?};
        let mut adapters=Vec::new();let mut selected=None;let mut index=0;
        while let Ok(adapter)=unsafe{factory.EnumAdapters1(index)} {
            let desc=unsafe{adapter.GetDesc1()?};let name=String::from_utf16_lossy(&desc.Description).trim_end_matches('\0').to_owned();
            adapters.push(serde_json::json!({"index":index,"description":name,"vendorId":desc.VendorId,"deviceId":desc.DeviceId}));
            if desc.VendorId==expected_vendor && selected.is_none(){selected=Some(index);}
            index+=1;
        }
        report["adapters"]=serde_json::json!(adapters);
        let index=selected.ok_or("Requested GPU vendor is not available; refusing to label another GPU as NVIDIA/AMD")?;
        let (device,context)=crate::capture::dxgi_wgc::create_d3d11_on_adapter(index)?;
        let dxgi:IDXGIDevice=device.cast()?;let adapter=unsafe{dxgi.GetAdapter()?};let desc=unsafe{adapter.GetDesc()?};
        if desc.VendorId!=expected_vendor{return Err("D3D device vendor does not match requested vendor".into());}
        report["selectedAdapter"]=serde_json::json!({"index":index,"description":String::from_utf16_lossy(&desc.Description).trim_end_matches('\0'),"vendorId":desc.VendorId,"deviceId":desc.DeviceId});
        let mut displays=Vec::new();let mut oi=0;
        while let Ok(out)=unsafe{adapter.EnumOutputs(oi)} {
            if let Ok(out6)=out.cast::<IDXGIOutput6>() {if let Ok(d)=unsafe{out6.GetDesc1()}{
                displays.push(serde_json::json!({"index":oi,"colorSpace":d.ColorSpace.0,"bitsPerColor":d.BitsPerColor,"minLuminance":d.MinLuminance,"maxLuminance":d.MaxLuminance}));
            }}
            oi+=1;
        }
        report["displayColorMetadata"]=serde_json::json!(displays);
        report["displayMetadataNote"]=serde_json::json!(if capture.is_some(){"Read-only output metadata. ColorSpace/bits are context, not proof of Windows HDR/ICC state or a tone-mapping diagnosis"}else{"Read-only output metadata; this synthetic test does not exercise HDR capture or tone mapping"});
        let (pixels,patches)=chart();report["patches"]=patches;
        std::fs::write(output.join("source.bgra"),&pixels)?;
        let mut texture=None;
        unsafe{device.CreateTexture2D(&D3D11_TEXTURE2D_DESC {Width:W as u32,Height:H as u32,MipLevels:1,ArraySize:1,Format:DXGI_FORMAT_B8G8R8A8_UNORM,SampleDesc:DXGI_SAMPLE_DESC{Count:1,Quality:0},Usage:D3D11_USAGE_DEFAULT,BindFlags:(D3D11_BIND_SHADER_RESOURCE.0|D3D11_BIND_RENDER_TARGET.0) as u32,..Default::default()},None,Some(&mut texture))?;}
        let texture=texture.unwrap();unsafe{context.UpdateSubresource(&texture,0,None,pixels.as_ptr().cast(),(W*4) as u32,0);}
        let texture = if let Some((backend,hwnd,owner))=capture {
            report["captureStarted"]=serde_json::json!(true);
            report["captureBackend"]=serde_json::json!(backend);
            report["captureCadenceNote"]=serde_json::json!("One fresh captured chart replayed through 60 encoder inputs; not a capture FPS measurement");
            let (captured, bgra, metadata)=real_capture::acquire(&device,&context,index,backend,hwnd,owner)?;
            report["realCapture"]=metadata;
            // Only a validated, synthetic-only ROI is persisted. Never save the monitor texture.
            std::fs::write(output.join("captured.bgra"),bgra)?;
            match crate::capture::preview::diagnostic_color_frame(&device,&context,&captured) {
                Ok(bytes)=>{std::fs::write(output.join("preview.bgra"),bytes)?;report["previewDiagnostic"]=serde_json::json!({"width":640,"height":360,"source":"same captured ROI texture","implementation":"production GpuPreview","ipcOrCanvasMeasured":false});}
                Err(e)=>{report["previewDiagnostic"]=serde_json::json!({"error":e.to_string()});}
            }
            captured
        } else {texture};
        let mut converter=GpuBgraToNv12::new_for_diagnostics(&device,&context,W as u32,H as u32,W as u32,H as u32,color_path)?;
        report["videoProcessorBeforeBlt"]=converter.color_diagnostics();
        report["gpuStreamColorBits"]=serde_json::json!(unsafe{converter.video_context.VideoProcessorGetStreamColorSpace(&converter.processor,0)._bitfield});
        report["gpuOutputColorBits"]=serde_json::json!(unsafe{converter.video_context.VideoProcessorGetOutputColorSpace(&converter.processor)._bitfield});
        converter.convert(&texture)?;let mut nv12=Vec::new();converter.copy_nv12_to_cpu(&mut nv12)?;
        report["videoProcessorAfterBlt"]=converter.color_diagnostics();
        std::fs::write(output.join("conversion.nv12"),&nv12)?;
        let mut yuv=Vec::new();let mut max_error=0.0f64;
        for (i,rgb) in COLORS.iter().enumerate(){
            let x=(i%8)*160+80;let y=(i/8)*160+80;let uv=W*H+(y/2)*W+(x/2)*2;
            let actual=[nv12[y*W+x],nv12[uv],nv12[uv+1]];
            let [r,g,b]=rgb.map(|v|v as f64/255.0);let l=0.2126*r+0.7152*g+0.0722*b;
            let expected=[16.0+219.0*l,128.0+224.0*(b-l)/(2.0*(1.0-0.0722)),128.0+224.0*(r-l)/(2.0*(1.0-0.2126))];
            for c in 0..3{max_error=max_error.max((actual[c] as f64-expected[c]).abs());}
            yuv.push(serde_json::json!({"index":i,"rgb":rgb,"nv12":actual,"expected709Limited":expected}));
        }
        report["gpuPatchMeasurements"]=serde_json::json!(yuv);report["gpuMax709LimitedError"]=serde_json::json!(max_error);
        report["nv12Matches709Limited"]=serde_json::json!(max_error<=2.0);
        // Persist the GPU result even when the MFT cannot initialize on this machine.
        std::fs::write(output.join("reference.json"),serde_json::to_vec_pretty(&report)?)?;
        let mut encoder=MfH264Encoder::new(&device,W as u32,H as u32,60,3500000,false)?;
        report["encoder"]=serde_json::json!(encoder.encoder_name);report["hardware"]=serde_json::json!(encoder.is_hardware);
        report["d3dZeroCopy"]=serde_json::json!(encoder.uses_d3d_zero_copy());report["encoderProperties"]=encoder.property_readback.clone();
        report["mfInput"]=unsafe{media_colors(&encoder.mft.GetInputCurrentType(0)?)};
        report["mfOutput"]=unsafe{media_colors(&encoder.mft.GetOutputCurrentType(0)?)};
        let expected_name=if expected_vendor==0x10de{"nvidia"}else{"amd"};
        report["encoderVendorMatchesRequested"]=serde_json::json!(encoder.is_hardware && encoder.encoder_name.to_lowercase().contains(expected_name));
        if (capture.is_some() || color_path!="auto") && report["encoderVendorMatchesRequested"]!=serde_json::json!(true) {
            encoder.shutdown();
            return Err("Requested hardware encoder was not selected; retaining capture/NV12 measurements without mislabeling encoder results".into());
        }
        let mut raw_file=std::fs::File::create(output.join("encoder-raw.h264"))?;
        let mut final_file=std::fs::File::create(output.join("encoded.h264"))?;
        let mut outputs=0;let mut raw_outputs=0;
        for i in 0..60 {
            converter.convert(&texture)?;
            let raw=encoder.encode_raw(&mut converter,i*10_000_000/60)?;
            if raw.is_empty(){continue;}raw_file.write_all(&raw)?;raw_outputs+=1;
            let normalized=super::h264_color::sdr_annex_b(raw).map_err(|_|"SPS normalization rejected encoder output")?;
            let sample=encoder.process_annex_b(normalized);
            if !sample.annex_b.is_empty(){final_file.write_all(&sample.annex_b)?;outputs+=1;}
        }
        encoder.shutdown();report["outputs"]=serde_json::json!(outputs);report["rawOutputs"]=serde_json::json!(raw_outputs);
        if !has_analysis_frames(outputs,raw_outputs){return Err("MFT produced insufficient output: frame 30 cannot be analyzed; keep the partial data".into());}
        report["all60OutputsPresent"]=serde_json::json!(outputs==60 && raw_outputs==60);
        report["status"]=serde_json::json!("collected-not-a-color-pass");
        Ok(())
    })();
    unsafe{let _=MFShutdown();CoUninitialize();}
    if let Err(ref error)=result{report["status"]=serde_json::json!("collection_failed");report["error"]=serde_json::json!(error.to_string());}
    if let Ok(exe)=std::env::current_exe(){if let Ok(bytes)=std::fs::read(exe){use sha2::{Digest,Sha256};report["probeSha256"]=serde_json::json!(format!("{:x}",Sha256::digest(bytes)));}}
    std::fs::write(output.join("reference.json"),serde_json::to_vec_pretty(&report).unwrap()).map_err(|_|"Could not write result".to_string())?;
    result.map_err(|e|e.to_string())
}
