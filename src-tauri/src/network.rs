use std::path::PathBuf;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

static DYNAMIC_API_BASE: RwLock<Option<String>> = RwLock::new(None);

pub fn set_dynamic_api_base(url: String) {
    let clean = url.trim().trim_end_matches('/').to_string();
    if let Ok(mut lock) = DYNAMIC_API_BASE.write() {
        *lock = Some(clean);
    }
}

pub fn get_dynamic_api_base() -> Option<String> {
    if let Ok(lock) = DYNAMIC_API_BASE.read() {
        lock.clone()
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TailscalePeerSummary {
    pub host_name: String,
    pub dns_name: String,
    pub tailscale_ips: Vec<String>,
    pub online: bool,
    pub is_likely_server: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkStatus {
    pub tailscale_installed: bool,
    pub tailscale_service_running: bool,
    pub tailscale_authenticated: bool,
    pub tailscale_state: String, // "running", "needs_login", "stopped", "service_stopped", "not_installed"
    pub tailscale_ips: Vec<String>,
    pub tailscale_self_name: Option<String>,
    pub tailscale_auth_url: Option<String>,
    pub server_reachability: String, // "connected", "connecting", "server_unreachable", "network_disconnected"
    pub server_url: String,
    pub server_latency_ms: Option<u64>,
    pub is_magic_dns: bool,
    pub detected_peers: Vec<TailscalePeerSummary>,
    pub error_message: Option<String>,
}

pub fn find_tailscale_cli() -> Option<PathBuf> {
    for path in &[
        r"C:\Program Files\Tailscale\tailscale.exe",
        r"C:\Program Files (x86)\Tailscale\tailscale.exe",
    ] {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }

    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(local_app)
            .join("Tailscale")
            .join("tailscale.exe");
        if p.exists() {
            return Some(p);
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join("tailscale.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

pub fn find_tailscale_gui() -> Option<PathBuf> {
    for path in &[
        r"C:\Program Files\Tailscale\tailscale-ipn.exe",
        r"C:\Program Files (x86)\Tailscale\tailscale-ipn.exe",
    ] {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

pub fn query_tailscale_status_raw() -> Result<serde_json::Value, String> {
    let cli = find_tailscale_cli().ok_or_else(|| "Tailscale não está instalado.".to_string())?;

    let mut cmd = std::process::Command::new(cli);
    cmd.arg("status").arg("--json");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Falha ao executar Tailscale: {}", e))?;
    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err_msg.is_empty() {
            "Tailscale retornou erro ou serviço inativo.".to_string()
        } else {
            err_msg
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Falha ao interpretar status JSON do Tailscale: {}", e))
}

pub async fn probe_server_health(url: &str) -> Result<u64, String> {
    let clean_url = format!("{}/health", url.trim().trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(2500))
        .build()
        .map_err(|e| e.to_string())?;

    let start = Instant::now();
    let resp = client
        .get(&clean_url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        let elapsed = start.elapsed().as_millis() as u64;
        Ok(elapsed)
    } else {
        Err(format!("Servidor respondeu com HTTP {}", resp.status()))
    }
}

#[tauri::command]
pub async fn network_get_status() -> Result<NetworkStatus, String> {
    let cli_opt = find_tailscale_cli();
    let installed = cli_opt.is_some();

    let mut service_running = false;
    let mut authenticated = false;
    let mut state_str = if installed {
        "stopped".to_string()
    } else {
        "not_installed".to_string()
    };
    let mut ips: Vec<String> = Vec::new();
    let mut self_name: Option<String> = None;
    let mut auth_url: Option<String> = None;
    let mut detected_peers: Vec<TailscalePeerSummary> = Vec::new();

    if installed {
        match query_tailscale_status_raw() {
            Ok(json) => {
                service_running = true;
                let backend_state = json
                    .get("BackendState")
                    .and_then(|v| v.as_str())
                    .unwrap_or("NoState");

                if let Some(url_val) = json.get("AuthURL").and_then(|v| v.as_str()) {
                    if !url_val.is_empty() {
                        auth_url = Some(url_val.to_string());
                    }
                }

                if let Some(self_obj) = json.get("Self") {
                    if let Some(hn) = self_obj.get("HostName").and_then(|v| v.as_str()) {
                        self_name = Some(hn.to_string());
                    }
                    if let Some(ip_arr) = self_obj.get("TailscaleIPs").and_then(|v| v.as_array()) {
                        for ip_val in ip_arr {
                            if let Some(ip_s) = ip_val.as_str() {
                                ips.push(ip_s.to_string());
                            }
                        }
                    }
                }

                // Parse peers to discover potential Nexus server
                if let Some(peer_map) = json.get("Peer").and_then(|v| v.as_object()) {
                    for (_k, p_val) in peer_map {
                        let hn = p_val
                            .get("HostName")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let dns = p_val
                            .get("DNSName")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let online = p_val
                            .get("Online")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        let mut p_ips = Vec::new();
                        if let Some(ip_arr) = p_val.get("TailscaleIPs").and_then(|v| v.as_array()) {
                            for item in ip_arr {
                                if let Some(ip_str) = item.as_str() {
                                    p_ips.push(ip_str.to_string());
                                }
                            }
                        }

                        let clean_dns = dns.trim_end_matches('.').to_string();
                        let is_server = hn.to_lowercase().contains("nexus")
                            || hn.to_lowercase().contains("server")
                            || clean_dns.to_lowercase().contains("nexus");

                        detected_peers.push(TailscalePeerSummary {
                            host_name: hn,
                            dns_name: clean_dns,
                            tailscale_ips: p_ips,
                            online,
                            is_likely_server: is_server,
                        });
                    }
                }

                match backend_state {
                    "Running" => {
                        authenticated = true;
                        state_str = "running".to_string();
                    }
                    "NeedsLogin" => {
                        authenticated = false;
                        state_str = "needs_login".to_string();
                    }
                    "Stopped" => {
                        authenticated = false;
                        state_str = "stopped".to_string();
                    }
                    "NoState" | "Starting" => {
                        authenticated = false;
                        state_str = "starting".to_string();
                    }
                    other => {
                        state_str = other.to_lowercase();
                    }
                }
            }
            Err(_err) => {
                service_running = false;
                state_str = "service_stopped".to_string();
            }
        }
    }

    // Determine current target server URL
    let current_base = crate::auth::get_api_base();
    let mut candidate_urls: Vec<String> = Vec::new();

    // 1. Current configured or dynamic URL
    candidate_urls.push(current_base.clone());

    // 2. MagicDNS candidates from detected peers or default MagicDNS
    for p in &detected_peers {
        if p.is_likely_server {
            if !p.dns_name.is_empty() {
                candidate_urls.push(format!("http://{}:3001", p.dns_name));
            }
            if let Some(first_ip) = p.tailscale_ips.first() {
                candidate_urls.push(format!("http://{}:3001", first_ip));
            }
        }
    }
    candidate_urls.push("http://nexus-server:3001".to_string());

    // 3. Localhost fallback
    candidate_urls.push("http://127.0.0.1:3001".to_string());

    // Probe reachability
    let mut active_url = current_base.clone();
    let mut server_latency: Option<u64> = None;
    let mut reachability = "server_unreachable".to_string();

    // First try the current configured URL
    if let Ok(lat) = probe_server_health(&active_url).await {
        server_latency = Some(lat);
        reachability = "connected".to_string();
    } else {
        // Try other candidates to automatically find the server via MagicDNS or Tailscale
        for cand in candidate_urls {
            if cand == active_url {
                continue;
            }
            if let Ok(lat) = probe_server_health(&cand).await {
                server_latency = Some(lat);
                reachability = "connected".to_string();
                active_url = cand.clone();
                set_dynamic_api_base(cand);
                break;
            }
        }
    }

    if reachability != "connected" {
        if !installed || state_str != "running" {
            reachability = "network_disconnected".to_string();
        } else {
            reachability = "server_unreachable".to_string();
        }
    }

    let is_magic = active_url.contains("nexus-server") || active_url.contains(".ts.net");

    Ok(NetworkStatus {
        tailscale_installed: installed,
        tailscale_service_running: service_running,
        tailscale_authenticated: authenticated,
        tailscale_state: state_str,
        tailscale_ips: ips,
        tailscale_self_name: self_name,
        tailscale_auth_url: auth_url,
        server_reachability: reachability,
        server_url: active_url,
        server_latency_ms: server_latency,
        is_magic_dns: is_magic,
        detected_peers,
        error_message: None,
    })
}

#[tauri::command]
pub async fn network_open_tailscale() -> Result<(), String> {
    // 1. Launch Tailscale GUI if present
    if let Some(gui) = find_tailscale_gui() {
        let mut cmd = std::process::Command::new(gui);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }

    // 2. Open Auth URL if user needs to authenticate
    if let Ok(json) = query_tailscale_status_raw() {
        if let Some(auth_url) = json.get("AuthURL").and_then(|v| v.as_str()) {
            if !auth_url.is_empty() {
                open::that(auth_url).map_err(|e| format!("Falha ao abrir navegador: {}", e))?;
                return Ok(());
            }
        }
    }

    // 3. If Tailscale is installed, trigger CLI up non-silently
    if let Some(cli) = find_tailscale_cli() {
        let mut cmd = std::process::Command::new(cli);
        cmd.arg("up");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        if let Ok(child) = cmd.spawn() {
            let _ = child;
            return Ok(());
        }
    }

    // 4. Fallback: Open Tailscale official download page
    open::that("https://tailscale.com/download/windows")
        .map_err(|e| format!("Falha ao abrir página do Tailscale: {}", e))
}

#[tauri::command]
pub fn network_get_server_address() -> String {
    crate::auth::get_api_base()
}

#[tauri::command]
pub fn network_set_server_address(url: String) -> Result<String, String> {
    let clean = url.trim().trim_end_matches('/').to_string();
    if clean.is_empty() {
        return Err("Endereço do servidor não pode ser vazio.".to_string());
    }
    set_dynamic_api_base(clean.clone());
    Ok(clean)
}

#[tauri::command]
pub async fn network_check_server(url: Option<String>) -> Result<serde_json::Value, String> {
    let target = url.unwrap_or_else(|| crate::auth::get_api_base());
    match probe_server_health(&target).await {
        Ok(latency_ms) => Ok(serde_json::json!({
            "status": "connected",
            "url": target,
            "latency_ms": latency_ms
        })),
        Err(err) => Ok(serde_json::json!({
            "status": "unreachable",
            "url": target,
            "error": err
        })),
    }
}
