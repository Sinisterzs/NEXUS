//! Opt-in SDR reference. Writes only generated pixels; never captures a desktop/window.
use super::*;
use std::{fs::File, io::Write};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use super::color_probe::{W, H, COLORS, chart, media_colors};
fn assert_nv12_709_limited(nv12: &[u8]) {
    assert_nv12_709_limited_sized(nv12,W,H)
}
fn assert_nv12_709_limited_sized(nv12: &[u8],width:usize,height:usize) {
    for (i, rgb) in COLORS.iter().enumerate() {
        let x=((i%8)*160+80)*width/W; let y=((i/8)*160+80)*height/H;
        let uv=width*height+(y/2)*width+(x/2)*2;
        let [r,g,b]=rgb.map(|v|v as f64/255.0);
        let l=0.2126*r+0.7152*g+0.0722*b;
        let expected=[16.0+219.0*l,128.0+224.0*(b-l)/(2.0*(1.0-0.0722)),128.0+224.0*(r-l)/(2.0*(1.0-0.2126))];
        let actual=[nv12[y*width+x],nv12[uv],nv12[uv+1]];
        for c in 0..3 {assert!((actual[c] as f64-expected[c]).abs()<=2.0,"patch {i} channel {c}: actual {} expected {}",actual[c],expected[c]);}
    }
}
#[test]
fn sdr_color_contract_uses_matching_matrix_and_range_enums() {
    assert_eq!(SDR_RGB_COLOR_BITS,36); assert_eq!(SDR_NV12_COLOR_BITS,20);
    assert_eq!((SDR_RGB_COLOR_BITS>>1)&1,0,"RGB must stay full range");
    assert_eq!((SDR_NV12_COLOR_BITS>>2)&1,1,"709 matrix");
    assert_eq!((SDR_NV12_COLOR_BITS>>4)&3,1,"D3D studio range enum");
    assert_eq!(MFNominalRange_16_235.0,2,"MF has a different range enum");
}
#[test]
fn sdr_gpu_patches_match_bt709_limited_oracle() {
    gpu_oracle("auto",false);
}
#[test]
fn sdr_explicit_dxgi1_matches_24_colors_and_survives_resize() {
    gpu_oracle("dxgi1",true);
}
fn gpu_oracle(path:&str,resize:bool) {
    let (device,context)=crate::capture::dxgi_wgc::create_d3d11_on_adapter(0).unwrap();
    let (pixels,_)=chart();let mut texture=None;
    unsafe {device.CreateTexture2D(&D3D11_TEXTURE2D_DESC {Width:W as u32,Height:H as u32,MipLevels:1,ArraySize:1,Format:DXGI_FORMAT_B8G8R8A8_UNORM,SampleDesc:DXGI_SAMPLE_DESC{Count:1,Quality:0},Usage:D3D11_USAGE_DEFAULT,BindFlags:(D3D11_BIND_SHADER_RESOURCE.0|D3D11_BIND_RENDER_TARGET.0) as u32,..Default::default()},None,Some(&mut texture)).unwrap();}
    let texture=texture.unwrap();unsafe {context.UpdateSubresource(&texture,0,None,pixels.as_ptr().cast(),(W*4) as u32,0);}
    let mut converter=GpuBgraToNv12::new_for_diagnostics(&device,&context,W as u32,H as u32,W as u32,H as u32,path).unwrap();
    converter.convert(&texture).unwrap(); let mut nv12=Vec::new();converter.copy_nv12_to_cpu(&mut nv12).unwrap();
    assert_nv12_709_limited(&nv12);
    if resize {
        converter.ensure_sizes(W as u32,H as u32,W as u32/2,H as u32/2).unwrap();
        assert_eq!(converter.color_diagnostics()["path"],"dxgi1");
        converter.convert(&texture).unwrap();converter.copy_nv12_to_cpu(&mut nv12).unwrap();
        assert_nv12_709_limited_sized(&nv12,W/2,H/2);
    }
}
#[test]
#[ignore="explicit headless synthetic SDR color reference; no screen capture"]
fn synthetic_sdr_color_reference() {
    unsafe {CoInitializeEx(None,COINIT_MULTITHREADED).ok().expect("COM");MFStartup(MF_VERSION,MFSTARTUP_NOSOCKET).expect("MF");}
    let result=(|| -> std::result::Result<(),Box<dyn std::error::Error>> {
        let label=std::env::var("NEXUS_COLOR_TEST_VARIANT").unwrap_or_else(|_|"fixed".into());
        assert!(["fixed","fixed-software"].contains(&label.as_str()));
        let folder=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scratch/color-fidelity").join(&label);
        std::fs::create_dir_all(&folder)?;
        let (device,context)=crate::capture::dxgi_wgc::create_d3d11_on_adapter(0)?;
        let (pixels,patches)=chart();std::fs::write(folder.join("source.bgra"),&pixels)?;
        let mut texture=None;
        unsafe {device.CreateTexture2D(&D3D11_TEXTURE2D_DESC {Width:W as u32,Height:H as u32,MipLevels:1,ArraySize:1,Format:DXGI_FORMAT_B8G8R8A8_UNORM,SampleDesc:DXGI_SAMPLE_DESC{Count:1,Quality:0},Usage:D3D11_USAGE_DEFAULT,BindFlags:(D3D11_BIND_SHADER_RESOURCE.0|D3D11_BIND_RENDER_TARGET.0) as u32,..Default::default()},None,Some(&mut texture))?;}
        let texture=texture.unwrap();
        unsafe {context.UpdateSubresource(&texture,0,None,pixels.as_ptr().cast(),(W*4) as u32,0);}
        let mut converter=GpuBgraToNv12::new(&device,&context,W as u32,H as u32,W as u32,H as u32)?;
        let stream_bits=unsafe {converter.video_context.VideoProcessorGetStreamColorSpace(&converter.processor,0)._bitfield};
        let output_bits=unsafe {converter.video_context.VideoProcessorGetOutputColorSpace(&converter.processor)._bitfield};
        converter.convert(&texture)?;let mut nv12=Vec::new();converter.copy_nv12_to_cpu(&mut nv12)?;
        std::fs::write(folder.join("conversion.nv12"),&nv12)?;
        if label.starts_with("fixed") {assert_nv12_709_limited(&nv12);}
        let mut encoder=MfH264Encoder::new(&device,W as u32,H as u32,60,3_500_000,label=="fixed-software")?;
        let input=unsafe {media_colors(&encoder.mft.GetInputCurrentType(0)?)};
        let output=unsafe {media_colors(&encoder.mft.GetOutputCurrentType(0)?)};
        if label.starts_with("fixed") {
            for mt in [&input,&output] {
                assert_eq!(mt["matrix"],1); assert_eq!(mt["range"],2);
                assert_eq!(mt["primaries"],2); assert_eq!(mt["transfer"],5);
            }
        }
        let mut encoded=File::create(folder.join("encoded.h264"))?;let mut outputs=0;
        for i in 0..60 {
            converter.convert(&texture)?;
            let sample=encoder.encode_nv12_texture(&mut converter,i*10_000_000/60)?;
            if !sample.annex_b.is_empty(){outputs+=1;encoded.write_all(&sample.annex_b)?;}
        }
        let report=serde_json::json!({"width":W,"height":H,"framesInput":60,"outputs":outputs,"fps":60,"bitrateUnchanged":3500000,"encoder":encoder.encoder_name,"hardware":encoder.is_hardware,"d3dZeroCopy":encoder.uses_d3d_zero_copy(),"gpuStreamColorBits":stream_bits,"gpuOutputColorBits":output_bits,"mfInput":input,"mfOutput":output,"patches":patches});
        std::fs::write(folder.join("reference.json"),serde_json::to_vec_pretty(&report)?)?;
        println!("SYNTHETIC_COLOR {}",report);encoder.shutdown();
        assert!(outputs>0);Ok(())
    })();
    unsafe {let _=MFShutdown();CoUninitialize();}
    result.expect("synthetic SDR colors");
}
