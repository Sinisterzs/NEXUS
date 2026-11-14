fn main() {
    let mut args:Vec<String>=std::env::args().collect();
    let color_path=if args.len()>=3 && args[args.len()-2]=="--color-path" {
        let path=args.pop().unwrap();args.pop();path
    }else{"auto".into()};
    if !["auto","legacy","dxgi1"].contains(&color_path.as_str()) {eprintln!("Invalid color path");std::process::exit(2);}
    if !matches!(args.len(),5|11) || args[1]!="--vendor" || args[3]!="--output" {
        eprintln!("Usage: nexus-color-probe --vendor nvidia|amd --output NEW_DIRECTORY [--capture dxgi|wgc --window HWND --owner PID] [--color-path auto|legacy|dxgi1]");
        std::process::exit(2);
    }
    let vendor=match args[2].as_str(){"nvidia"=>0x10de,"amd"=>0x1002,_=>{eprintln!("Vendor must be nvidia or amd");std::process::exit(2);}};
    // Keep synthetic diagnostics away from the user's installed NEXUS logs/state.
    std::env::set_var("NEXUS_APP_DATA_DIR", &args[4]);
    #[cfg(target_os="windows")]
    let result=if args.len()==11 {
        if color_path!="auto" {eprintln!("Capture uses the automatic vendor policy; explicit A/B color paths are synthetic-only");std::process::exit(2);}
        if args[5]!="--capture" || args[7]!="--window" || args[9]!="--owner" {eprintln!("Invalid capture arguments");std::process::exit(2);}
        match (args[8].parse::<isize>(),args[10].parse::<u32>()) {
            (Ok(hwnd),Ok(owner))=>nexus_lib::capture::mf_encoder::color_probe::run_capture(std::path::Path::new(&args[4]),vendor,&args[6],hwnd,owner),
            _=>Err("Invalid HWND/owner".into())
        }
    }else{nexus_lib::capture::mf_encoder::color_probe::run_with_color_path(std::path::Path::new(&args[4]),vendor,&color_path)};
    #[cfg(target_os="windows")]
    match result {
        Ok(())=>println!("Synthetic data collected. No audio or peer opened. Analyze before interpreting color fidelity."),
        Err(error)=>{eprintln!("Collection incomplete: {error}");std::process::exit(1);}
    }
    #[cfg(not(target_os="windows"))]
    {let _=vendor;eprintln!("Windows is required");std::process::exit(2);}
}
