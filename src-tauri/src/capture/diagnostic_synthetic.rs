//! Reuses the laboratory's synthetic GPU probe. Never accepts HWNDs, paths or frames.
use super::mf_encoder::color_probe;
use serde_json::{json, Value};
use tauri::Manager;
pub fn run(app: &tauri::AppHandle, vendor: &str) -> Result<Value, String> {
    let id = match vendor {
        "amd" => 0x1002,
        "nvidia" => 0x10de,
        "intel" => 0x8086,
        _ => return Err("diagnostics_invalid_vendor".into()),
    };
    let parent = app
        .path()
        .app_cache_dir()
        .map_err(|_| "diagnostics_cache_unavailable")?
        .join("synthetic-diagnostics");
    std::fs::create_dir_all(&parent).map_err(|_| "diagnostics_cache_unavailable")?;
    let directory = parent.join(uuid::Uuid::new_v4().to_string());
    // Only this fresh random child is ever removed. It contains generated chart data.
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(directory.clone());
    let success = color_probe::run(&directory, id).is_ok();
    if !crate::diagnostics::enabled(crate::diagnostics::wire::Kind::Synthetic) {
        return Err("diagnostics_synthetic_cancelled".into());
    }
    let report: Value = serde_json::from_slice(
        &std::fs::read(directory.join("reference.json"))
            .map_err(|_| "diagnostics_probe_unavailable")?,
    )
    .map_err(|_| "diagnostics_probe_invalid")?;
    let mut metrics = json!({"capture":"synthetic","pixelFormat":"bgra8","gpu":vendor,"encoder":"mf_h264",
        "syntheticOnly":true,"physicalDisplayMeasured":false,"decoderInput":"unavailable","decoderOutput":"unavailable",
        "renderer":"unavailable","hdr":"sdr","width":1280,"height":720,"stage":"conversion","result":if success{"measured"}else{"failed"},
        "hardware":report.get("hardware"),"outputs":report.get("outputs"),"maximum":report.get("gpuMax709LimitedError"),
        "range":"unavailable","matrixName":"unavailable"});
    let mut patches = Vec::new();
    if let Some(values) = report["gpuPatchMeasurements"].as_array() {
        let mut total = 0.0;
        let mut maximum = 0.0f64;
        for patch in values.iter().take(24) {
            let Some(actual) = patch["nv12"].as_array() else {
                continue;
            };
            let Some(expected) = patch["expected709Limited"].as_array() else {
                continue;
            };
            if actual.len() != 3 || expected.len() != 3 {
                continue;
            }
            let mut measured = [0.0; 3];
            let mut reference = [0u8; 3];
            let mut error = 0.0;
            let mut max = 0.0f64;
            for c in 0..3 {
                measured[c] = actual[c].as_f64().unwrap_or(0.0);
                let target = expected[c].as_f64().unwrap_or(0.0);
                reference[c] = target.round().clamp(0.0, 255.0) as u8;
                let delta = (measured[c] - reference[c] as f64).abs();
                error += delta;
                max = max.max(delta);
            }
            total += error;
            maximum = maximum.max(max);
            // Explicitly YUV values, not RGB measurements. Stage/format identifies interpretation.
            patches.push(json!({"index":patch["index"],"expected":reference,"measured":measured,"mae":error/3.0,"maximum":max}));
        }
        if !patches.is_empty() {
            metrics["mae"] = json!(total / (patches.len() * 3) as f64);
            metrics["maximum"] = json!(maximum);
        }
    }
    metrics["pixelFormat"] = json!("nv12");
    // Configuration readback, not a pixel-based claim about range or display output.
    if let Some(n) = report["videoProcessorAfterBlt"]["colorSpace1Readback"]["input"].as_u64() {
        metrics["vpInputColorSpace"] = json!(n);
    }
    if let Some(n) = report["videoProcessorAfterBlt"]["colorSpace1Readback"]["output"].as_u64() {
        metrics["vpOutputColorSpace"] = json!(n);
    }
    let mut result = json!({"metrics":crate::diagnostics::wire::safe_for_kind(crate::diagnostics::wire::Kind::Synthetic,&metrics),"patches":patches});
    // Only the first generated IDR access unit is exposed over local IPC for a
    // browser decode measurement. It is NEVER part of a diagnostic Event or upload.
    if let Ok(bytes) = std::fs::read(directory.join("encoded.h264")) {
        if bytes.len() <= 16 * 1024 * 1024 {
            let mut access = Vec::new();
            let mut idr = false;
            let mut codec = None;
            for nalu in super::mf_encoder::split_annex_b_nalus(&bytes) {
                let Some(first) = nalu.first() else { continue };
                let kind = first & 31;
                if idr && kind != 5 {
                    break;
                }
                if kind == 7 && nalu.len() >= 4 {
                    codec = Some(format!(
                        "avc1.{:02X}{:02X}{:02X}",
                        nalu[1], nalu[2], nalu[3]
                    ));
                    if let Some(metadata) = super::diagnostic_metadata::sps(nalu) {
                        if let Some(fields) = metadata.as_object() {
                            for (k, v) in fields {
                                result["metrics"][k] = v.clone();
                            }
                        }
                    }
                }
                if [5, 6, 7, 8].contains(&kind) {
                    access.extend_from_slice(&[0, 0, 0, 1]);
                    access.extend_from_slice(nalu);
                }
                idr |= kind == 5;
            }
            if idr && access.len() <= 2 * 1024 * 1024 {
                use base64::Engine;
                result["synthetic_access_unit"] =
                    json!(base64::engine::general_purpose::STANDARD.encode(access));
                result["synthetic_codec"] = json!(codec);
                result["reference_rgb"] = json!(report["gpuPatchMeasurements"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|v| v["rgb"].clone())
                    .collect::<Vec<_>>());
            }
        }
    }
    Ok(result)
}
