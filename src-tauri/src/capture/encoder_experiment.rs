//! Opt-in, headless synthetic experiment. No capture, audio, ICE, peers or application UI.
use std::{fs::File, io::Write, time::{Duration, Instant}};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use super::{dxgi_wgc::create_d3d11_on_adapter, mf_encoder::{GpuBgraToNv12, MfH264Encoder}};

// Public deterministic pattern; never reads a desktop, application or personal file.
fn frame(index: u32, pixels: &mut [u8]) {
    let t = index.saturating_sub(30); // First half-second static, then moving textured tiles.
    for y in 0..1080u32 { for x in 0..1920u32 {
        let tile = x/320 + (y/180)*6;
        let sx = x.wrapping_add(t*(3+tile%5*2)); let sy=y.wrapping_add(t*(2+tile%3*3));
        let off=(y as usize*1920+x as usize)*4;
        let checker=((sx/12+sy/12)&1) as u8;
        let text=sy%32>=8 && sy%32<23 && sx%14<8 && ((sx/14+sy/32)%3!=0);
        let panel=(x/320+y/180)%3;
        let v=if text {225} else {38+checker*35};
        pixels[off]=v.saturating_add((panel*8) as u8);
        pixels[off+1]=v;
        pixels[off+2]=v.saturating_sub((panel*6) as u8);
        pixels[off+3]=255;
    }}
}
#[test]
#[ignore = "explicit headless GPU experiment only; creates synthetic media under scratch"]
fn synthetic_mft_bitrate_matrix() {
    unsafe { CoInitializeEx(None,COINIT_MULTITHREADED).ok().expect("COM"); MFStartup(MF_VERSION,MFSTARTUP_NOSOCKET).expect("MF"); }
    let outcome=(|| -> Result<(),Box<dyn std::error::Error>> {
        let folder=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scratch/webrtc-h264-quality/mft");std::fs::create_dir_all(&folder)?;
        let (device,context)=create_d3d11_on_adapter(0)?;
        let mut texture=None;
        unsafe { device.CreateTexture2D(&D3D11_TEXTURE2D_DESC {Width:1920,Height:1080,MipLevels:1,ArraySize:1,Format:DXGI_FORMAT_B8G8R8A8_UNORM,SampleDesc:DXGI_SAMPLE_DESC{Count:1,Quality:0},Usage:D3D11_USAGE_DEFAULT,BindFlags:(D3D11_BIND_SHADER_RESOURCE.0|D3D11_BIND_RENDER_TARGET.0) as u32,..Default::default()},None,Some(&mut texture))?; }
        let texture=texture.unwrap(); let mut pixels=vec![0u8;1920*1080*4]; let mut rows=Vec::new();
        // D10 intentionally skipped: network evidence was not verified in this experiment.
        for (name,rate) in [("a35",3_500_000),("a4235",4_235_000),("b6",6_000_000),("c8",8_000_000)] {
            let mut converter=GpuBgraToNv12::new(&device,&context,1920,1080,1920,1080)?;
            let mut encoder=MfH264Encoder::new(&device,1920,1080,60,rate,false)?;
            if !encoder.is_hardware { return Err("Hardware MFT unavailable; refusing to mislabel software results".into()); }
            let mut encoded=File::create(folder.join(format!("{name}.h264")))?;
            let mut reference=if name=="a35" {Some(File::create(folder.join("reference-sampled.nv12"))?)} else {None};
            let start=Instant::now();let mut encode_ms=Vec::new();let(mut bytes,mut outputs,mut empty)=(0u64,0u32,0u32);
            for i in 0..120u32 {
                frame(i,&mut pixels);
                unsafe {context.UpdateSubresource(&texture,0,None,pixels.as_ptr().cast(),1920*4,0);}
                converter.convert(&texture)?;
                if i%12==11 {if let Some(ref mut reference)=reference {let mut nv12=Vec::new();converter.copy_nv12_to_cpu(&mut nv12)?;reference.write_all(&nv12)?;}}
                let tick=Instant::now();let sample=encoder.encode_nv12_texture(&mut converter,(i as i64)*10_000_000/60)?;
                encode_ms.push(tick.elapsed().as_secs_f64()*1000.0);
                if sample.annex_b.is_empty(){empty+=1;}else{outputs+=1;bytes+=sample.annex_b.len() as u64;encoded.write_all(&sample.annex_b)?;}
                let deadline=start+Duration::from_secs_f64((i+1) as f64/60.0);
                if let Some(wait)=deadline.checked_duration_since(Instant::now()){std::thread::sleep(wait);}
            }
            let elapsed=start.elapsed().as_secs_f64(); encode_ms.sort_by(f64::total_cmp);
            let row=serde_json::json!({"profile":name,"requested_bps":rate,"encoder":encoder.encoder_name,"hardware":encoder.is_hardware,"d3d_zero_copy":encoder.uses_d3d_zero_copy(),"properties":encoder.property_readback,"input_frames":120,"nonempty_outputs":outputs,"empty_outputs":empty,"payload_bytes":bytes,"encoded_payload_bps_media_time":bytes as f64*8.0/2.0,"wall_seconds":elapsed,"paced_input_fps":120.0/elapsed,"encode_p50_ms":encode_ms[60],"encode_p95_ms":encode_ms[114],"idr_count":encoder.idr_count,"rtp_bps":null,"rtt_ms":null,"loss":null,"nack":null,"pli":null});
            println!("SYNTHETIC_ENCODER {}",row);rows.push(row);
            if name=="c8" {
                let restored=encoder.set_bitrate(&device,3_500_000,true)?;
                assert_eq!(encoder.current_bitrate_bps,3_500_000);
                assert_eq!(encoder.property_readback["mean_bitrate"]["readback"].as_u64(),Some(3_500_000));
                println!("SYNTHETIC_RESTORE bitrate_bps=3500000 outcome={restored:?}");
                let small_delta=encoder.set_bitrate(&device,3_800_000,true)?;
                assert_eq!(encoder.current_bitrate_bps,3_800_000);
                assert_eq!(encoder.property_readback["mean_bitrate"]["readback"].as_u64(),Some(3_800_000));
                println!("SYNTHETIC_SMALL_DELTA bitrate_bps=3800000 outcome={small_delta:?}");
            }
            encoder.shutdown(); drop(encoder); drop(converter);
        }
        std::fs::write(folder.join("matrix.json"),serde_json::to_vec_pretty(&rows)?)?;
        Ok(())
    })();
    unsafe {let _=MFShutdown();CoUninitialize();}
    outcome.expect("synthetic encoder matrix");
}


#[test]
#[ignore="explicit synthetic input-mode recovery check; no screen or UI"]
fn synthetic_input_modes_preserve_encoder_and_emit_parameterized_idr() {
    unsafe {CoInitializeEx(None,COINIT_MULTITHREADED).ok().unwrap();MFStartup(MF_VERSION,MFSTARTUP_NOSOCKET).unwrap();}
    let result=(||->Result<(),Box<dyn std::error::Error>> {
        let folder=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scratch/webrtc-dxgi-recovery");std::fs::create_dir_all(&folder)?;
        let mut stream=File::create(folder.join("synthetic-mode-transitions.h264"))?;
        let(device,context)=create_d3d11_on_adapter(0)?;
        let mut converter=GpuBgraToNv12::new(&device,&context,1920,1080,1920,1080)?;
        // Existing experimental target must survive changes of source mode.
        let mut encoder=MfH264Encoder::new(&device,1920,1080,60,8_000_000,false)?;
        assert!(encoder.is_hardware);
        let mut index=0;let mut resumed=0;let mut outputs=0;
        for (sw,sh) in [(1920,1080),(1280,720),(1280,1024),(1920,1080)] {
            let pixels=[80u8,130,180,255].repeat(sw as usize*sh as usize);
            let mut texture=None;
            unsafe {device.CreateTexture2D(&D3D11_TEXTURE2D_DESC{Width:sw,Height:sh,MipLevels:1,ArraySize:1,Format:DXGI_FORMAT_B8G8R8A8_UNORM,SampleDesc:DXGI_SAMPLE_DESC{Count:1,Quality:0},Usage:D3D11_USAGE_DEFAULT,BindFlags:(D3D11_BIND_SHADER_RESOURCE.0|D3D11_BIND_RENDER_TARGET.0)as u32,..Default::default()},Some(&D3D11_SUBRESOURCE_DATA{pSysMem:pixels.as_ptr().cast(),SysMemPitch:sw*4,SysMemSlicePitch:0}),Some(&mut texture))?;}
            let texture=texture.unwrap();
            converter.ensure_sizes(sw,sh,1920,1080)?;
            assert!(encoder.force_keyframe());
            let mut saw_idr=false;
            for frame in 0..30 {
                converter.convert(&texture)?;
                let sample=encoder.encode_nv12_texture(&mut converter,index*10_000_000/60)?;index+=1;
                if sample.is_idr {
                    let nalus=super::mf_encoder::split_annex_b_nalus(&sample.annex_b);
                    assert!(nalus.iter().any(|n|!n.is_empty()&&n[0]&31==7),"IDR must include SPS");
                    assert!(nalus.iter().any(|n|!n.is_empty()&&n[0]&31==8),"IDR must include PPS");saw_idr=true;
                }
                if !sample.annex_b.is_empty(){outputs+=1;stream.write_all(&sample.annex_b)?;}
                if frame==5 {assert!(saw_idr,"recovery IDR delayed more than six frames");}
            }
            assert!(saw_idr,"recovery IDR missing");resumed+=1;
            assert_eq!((encoder.width,encoder.height,encoder.current_bitrate_bps),(1920,1080,8_000_000));
            assert_eq!(encoder.reinit_count,0);
        }
        assert_eq!(outputs,120);
        println!("SYNTHETIC_MODE_RECOVERY phases={} frames={} output=1920x1080 fps=60 encoder_reinitializations=0 bitrate=8000000 parameterized_idr_each_phase=true",resumed,outputs);
        encoder.shutdown();Ok(())
    })();
    unsafe {let _=MFShutdown();CoUninitialize();}result.expect("mode transition pipeline");
}
