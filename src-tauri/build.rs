use std::fs;
use std::path::Path;

fn extract_json_value(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with(&format!("\"{}\"", key)) {
            if let Some(colon_pos) = trimmed.find(':') {
                let rest = trimmed[colon_pos + 1..].trim();
                let clean = rest.trim_matches(|c| c == '"' || c == ',' || c == ' ');
                if !clean.is_empty() {
                    return Some(clean.to_string());
                }
            }
        }
    }
    None
}

fn extract_env_value(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        if let Some(stripped) = trimmed.strip_prefix(key) {
            if let Some(rest) = stripped.strip_prefix('=') {
                let clean = rest.trim().trim_matches('"').trim_matches('\'');
                if !clean.is_empty() {
                    return Some(clean.to_string());
                }
            }
        }
    }
    None
}

fn main() {
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_TEST_LAB");
    if std::env::var_os("CARGO_FEATURE_TEST_LAB").is_some() {
        println!("cargo:rustc-env=NEXUS_DEFAULT_API_URL=http://127.0.0.1:13001");
        tauri_build::build();
        return;
    }
    println!("cargo:rerun-if-changed=../nexus.config.json");
    println!("cargo:rerun-if-changed=../nexus-server/.env");
    println!("cargo:rerun-if-env-changed=GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=NEXUS_API_URL");

    // 1. Resolve GOOGLE_CLIENT_ID
    let mut resolved_client_id: Option<String> = None;

    if let Ok(env_val) = std::env::var("GOOGLE_CLIENT_ID") {
        if !env_val.trim().is_empty() {
            resolved_client_id = Some(env_val.trim().to_string());
        }
    }

    if resolved_client_id.is_none() {
        let config_path = Path::new("../nexus.config.json");
        if config_path.exists() {
            if let Ok(content) = fs::read_to_string(config_path) {
                if let Some(val) = extract_json_value(&content, "googleClientId") {
                    resolved_client_id = Some(val);
                }
            }
        }
    }

    if resolved_client_id.is_none() {
        let server_env_path = Path::new("../nexus-server/.env");
        if server_env_path.exists() {
            if let Ok(content) = fs::read_to_string(server_env_path) {
                if let Some(val) = extract_env_value(&content, "GOOGLE_CLIENT_ID") {
                    resolved_client_id = Some(val);
                }
            }
        }
    }

    if let Some(client_id) = resolved_client_id {
        println!(
            "cargo:rustc-env=NEXUS_DEFAULT_GOOGLE_CLIENT_ID={}",
            client_id
        );
    }

    // 2. Resolve NEXUS_API_URL
    let mut resolved_api_url: Option<String> = None;

    if let Ok(env_val) = std::env::var("NEXUS_API_URL") {
        if !env_val.trim().is_empty() {
            resolved_api_url = Some(env_val.trim().to_string());
        }
    }

    if resolved_api_url.is_none() {
        let config_path = Path::new("../nexus.config.json");
        if config_path.exists() {
            if let Ok(content) = fs::read_to_string(config_path) {
                if let Some(val) = extract_json_value(&content, "apiUrl") {
                    resolved_api_url = Some(val);
                }
            }
        }
    }

    if let Some(api_url) = resolved_api_url {
        println!("cargo:rustc-env=NEXUS_DEFAULT_API_URL={}", api_url);
    }

    tauri_build::build()
}
