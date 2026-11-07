use std::path::PathBuf;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

static DYNAMIC_API_BASE: RwLock<Option<String>> = RwLock::new(None);

pub fn is_valid_tailscale_ip(host: &str) -> bool {
    let clean = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ipv4) = clean.parse::<std::net::Ipv4Addr>() {
        let octets = ipv4.octets();
        // RFC 6598 Tailscale CGNAT range: 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
        return octets[0] == 100 && (64..=127).contains(&octets[1]);
    }
    if let Ok(ipv6) = clean.parse::<std::net::Ipv6Addr>() {
        let segments = ipv6.segments();
        // Tailscale IPv6 ULA range: fd7a:115c:a1e0::/48
        return segments[0] == 0xfd7a && segments[1] == 0x115c && segments[2] == 0xa1e0;
    }
    false
}

pub fn is_authorized_server_host(host: &str) -> bool {
    let clean = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if clean.is_empty() {
        return false;
    }

    // 1. Loopback addresses
    if clean == "127.0.0.1" || clean == "localhost" || clean == "[::1]" || clean == "::1" {
        return true;
    }

    // 2. Tailscale private IP (100.64.0.0/10 or fd7a:115c:a1e0::/48)
    if is_valid_tailscale_ip(&clean) {
        return true;
    }

    // 3. Tailscale MagicDNS short hostname or FQDN (*.ts.net)
    if clean == "nexus-server" {
        return true;
    }

    if let Some(prefix) = clean.strip_suffix(".ts.net") {
        if !prefix.is_empty()
            && prefix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
            && !prefix.starts_with('.')
            && !prefix.ends_with('.')
        {
            return true;
        }
    }

    false
}

pub fn validate_server_url(raw_url: &str) -> Result<String, String> {
    let trimmed = raw_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Endereço do servidor não pode ser vazio.".to_string());
    }

    let parsed = url::Url::parse(trimmed)
        .map_err(|_| "Formato de URL inválido para o servidor NEXUS.".to_string())?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Apenas protocolos http:// ou https:// são permitidos.".to_string());
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Credenciais embutidas na URL não são permitidas.".to_string());
    }

    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Parâmetros de query ou fragmentos não são permitidos no endereço base.".to_string());
    }

    let path = parsed.path();
    if !path.is_empty() && path != "/" {
        return Err("O endereço do servidor não deve conter caminhos adicionais.".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "Host ausente no endereço do servidor.".to_string())?;

    if !is_authorized_server_host(host) {
        return Err(
            "Host não autorizado. Use apenas loopback (127.0.0.1/localhost) ou endereço privado Tailscale (100.64.0.0/10, nexus-server ou *.ts.net)."
                .to_string(),
        );
    }

    let normalized_host = host.trim_end_matches('.');
    match parsed.port() {
        Some(port) => Ok(format!("{}://{}:{}", scheme, normalized_host, port)),
        None => Ok(format!("{}://{}", scheme, normalized_host)),
    }
}

pub fn set_dynamic_api_base(url: String) {
    if let Ok(valid_url) = validate_server_url(&url) {
        if let Ok(mut lock) = DYNAMIC_API_BASE.write() {
            *lock = Some(valid_url);
        }
    }
}

pub fn clear_dynamic_api_base_for_tests() {
    if let Ok(mut lock) = DYNAMIC_API_BASE.write() {
        *lock = None;
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
            if dir.is_absolute() {
                let candidate = dir.join("tailscale.exe");
                if candidate.is_file() {
                    return Some(candidate);
                }
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
    let validated = validate_server_url(url)?;
    let clean_url = format!("{}/health", validated.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(2500))
        .build()
        .map_err(|e| e.to_string())?;

    let start = Instant::now();
    let resp = client
        .get(&clean_url)
        .send()
        .await
        .map_err(|e| format!("Falha de conexão: {}", e))?;

    if resp.status().is_success() {
        let has_nexus_header = resp
            .headers()
            .get("x-nexus-service")
            .and_then(|v| v.to_str().ok())
            == Some("nexus-server");

        if let Ok(body) = resp.json::<serde_json::Value>().await {
            let is_nexus_service =
                body.get("service").and_then(|v| v.as_str()) == Some("nexus-server");
            let is_ok = body.get("status").and_then(|v| v.as_str()) == Some("ok");
            let has_version = body.get("version").is_some();

            if is_ok && (is_nexus_service || has_nexus_header) && has_version {
                let elapsed = start.elapsed().as_millis() as u64;
                return Ok(elapsed);
            }
        }
        Err("Servidor respondeu mas não possui a identidade autêntica do NEXUS ('service': 'nexus-server').".to_string())
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

    // Determine current target server URL (preserves explicitly configured server; never auto-switches to arbitrary peers)
    let current_base = crate::auth::get_api_base();
    let active_url = current_base.clone();
    let mut server_latency: Option<u64> = None;
    let mut reachability = "server_unreachable".to_string();

    // Probe only the explicitly configured server URL
    if let Ok(lat) = probe_server_health(&active_url).await {
        server_latency = Some(lat);
        reachability = "connected".to_string();
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

pub fn safe_open_url(raw_url: &str) -> Result<(), String> {
    if raw_url.is_empty() {
        return Err("URL não pode ser vazia.".to_string());
    }

    // Prohibit control characters, newlines, quotes, or null bytes across raw input
    if raw_url.chars().any(|c| c.is_control() || c == '"' || c == '\'' || c == '`' || c == '\0') {
        return Err("URL contém caracteres de controle inválidos.".to_string());
    }

    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err("URL não pode ser vazia.".to_string());
    }

    let parsed = url::Url::parse(trimmed)
        .map_err(|e| format!("URL inválida para abertura externa: {}", e))?;

    // Only https:// scheme is permitted for opening external browser
    if parsed.scheme() != "https" {
        return Err("Apenas links seguros https:// podem ser abertos no navegador.".to_string());
    }

    let host = parsed.host_str().ok_or_else(|| "URL sem host.".to_string())?;
    if host.is_empty() {
        return Err("Host inválido na URL.".to_string());
    }

    open::that(trimmed).map_err(|e| format!("Falha ao abrir navegador: {}", e))
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

    // 2. Open Auth URL if user needs to authenticate (strictly HTTPS)
    if let Ok(json) = query_tailscale_status_raw() {
        if let Some(auth_url) = json.get("AuthURL").and_then(|v| v.as_str()) {
            let trimmed = auth_url.trim();
            if trimmed.starts_with("https://") {
                safe_open_url(trimmed)?;
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
    safe_open_url("https://tailscale.com/download/windows")
}

#[tauri::command]
pub fn network_get_server_address() -> String {
    crate::auth::get_api_base()
}

#[tauri::command]
pub fn network_set_server_address(url: String) -> Result<String, String> {
    let valid_url = validate_server_url(&url)?;
    let old_base = crate::auth::get_api_base();
    set_dynamic_api_base(valid_url.clone());
    if old_base != valid_url {
        eprintln!(
            "[Network] Origem do servidor alterada de {} para {}. Sessão ativa desvinculada para segurança.",
            old_base, valid_url
        );
        crate::auth::set_active_user_id(None);
    }
    Ok(valid_url)
}

#[tauri::command]
pub async fn network_check_server(url: Option<String>) -> Result<serde_json::Value, String> {
    let raw_target = url.unwrap_or_else(|| crate::auth::get_api_base());
    let target = validate_server_url(&raw_target)?;
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

/// Augments a strict CSP `connect-src` directive with the exact authorized origin of the configured server.
/// This ensures Tailscale IPs (100.x.x.x), loopback, or custom authorized nodes are permitted
/// without re-introducing generic, dangerous wildcards (http:, https:, ws:, wss:).
pub fn augment_csp_for_server(base_csp: &str, server_url: &str) -> String {
    let valid_url = match validate_server_url(server_url) {
        Ok(u) => u,
        Err(_) => return base_csp.to_string(),
    };
    let parsed = match url::Url::parse(&valid_url) {
        Ok(p) => p,
        Err(_) => return base_csp.to_string(),
    };
    let host = match parsed.host_str() {
        Some(h) => h,
        None => return base_csp.to_string(),
    };
    let scheme = parsed.scheme();
    let ws_scheme = if scheme == "https" { "wss" } else { "ws" };
    let port_suffix = match parsed.port() {
        Some(p) => format!(":{}", p),
        None => String::new(),
    };

    let http_origin = format!("{}://{}{}", scheme, host, port_suffix);
    let ws_origin = format!("{}://{}{}", ws_scheme, host, port_suffix);

    // If both origins are already explicitly present, no modification needed
    if base_csp.contains(&http_origin) && base_csp.contains(&ws_origin) {
        return base_csp.to_string();
    }

    if let Some(pos) = base_csp.find("connect-src ") {
        let insert_idx = pos + "connect-src ".len();
        let mut res = String::with_capacity(base_csp.len() + http_origin.len() + ws_origin.len() + 2);
        res.push_str(&base_csp[..insert_idx]);
        if !base_csp.contains(&http_origin) {
            res.push_str(&http_origin);
            res.push(' ');
        }
        if !base_csp.contains(&ws_origin) {
            res.push_str(&ws_origin);
            res.push(' ');
        }
        res.push_str(&base_csp[insert_idx..]);
        res
    } else {
        base_csp.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_augment_csp_for_server_injects_tailscale_ip_origins() {
        let base_csp = "default-src 'self'; connect-src 'self' ws://nexus-server:* ws://*.ts.net:*;";
        let augmented = augment_csp_for_server(base_csp, "http://100.115.92.19:3001");

        assert!(augmented.contains("ws://100.115.92.19:3001"), "Augmented CSP must contain exact ws:// origin");
        assert!(augmented.contains("http://100.115.92.19:3001"), "Augmented CSP must contain exact http:// origin");
        assert!(!augmented.contains("http: "), "Must NOT add generic http:");
        assert!(!augmented.contains("ws: "), "Must NOT add generic ws:");

        // If server is invalid/malicious, base_csp is untouched
        let rejected = augment_csp_for_server(base_csp, "http://evil.attacker.com:3001");
        assert_eq!(rejected, base_csp);
    }

    #[test]
    fn test_validate_server_url_allows_legitimate_loopback_and_tailscale() {
        assert_eq!(
            validate_server_url("http://127.0.0.1:3001/").unwrap(),
            "http://127.0.0.1:3001"
        );
        assert_eq!(
            validate_server_url("http://localhost:3001").unwrap(),
            "http://localhost:3001"
        );
        assert_eq!(
            validate_server_url("http://100.64.0.1:3001").unwrap(),
            "http://100.64.0.1:3001"
        );
        assert_eq!(
            validate_server_url("http://100.127.255.254:3001").unwrap(),
            "http://100.127.255.254:3001"
        );
        assert_eq!(
            validate_server_url("http://nexus-server:3001").unwrap(),
            "http://nexus-server:3001"
        );
        assert_eq!(
            validate_server_url("http://nexus-server.tail1234.ts.net:3001/").unwrap(),
            "http://nexus-server.tail1234.ts.net:3001"
        );
        assert_eq!(
            validate_server_url("https://nexus-server.tail1234.ts.net").unwrap(),
            "https://nexus-server.tail1234.ts.net"
        );
    }

    #[test]
    fn test_validate_server_url_rejects_unauthorized_hosts_and_exfiltration_vectors() {
        clear_dynamic_api_base_for_tests();

        // External domains (HTTP and HTTPS) must be rejected to prevent Bearer token exfiltration
        assert!(validate_server_url("http://attacker.example.com:3001").is_err());
        assert!(validate_server_url("https://attacker.example.com:3001").is_err());
        assert!(validate_server_url("http://nexus-server.attacker.com:3001").is_err());
        assert!(validate_server_url("http://ts.net.attacker.com:3001").is_err());

        // IPs outside Tailscale 100.64.0.0/10 and loopback must be rejected
        assert!(validate_server_url("http://100.63.255.255:3001").is_err());
        assert!(validate_server_url("http://100.128.0.1:3001").is_err());
        assert!(validate_server_url("http://192.168.1.50:3001").is_err());
        assert!(validate_server_url("http://8.8.8.8:3001").is_err());

        // Non-HTTP schemes, embedded credentials, paths, and queries must be rejected
        assert!(validate_server_url("ftp://127.0.0.1:3001").is_err());
        assert!(validate_server_url("javascript:alert(1)").is_err());
        assert!(validate_server_url("http://user:pass@127.0.0.1:3001").is_err());
        assert!(validate_server_url("http://127.0.0.1:3001/v1/evil").is_err());
        assert!(validate_server_url("http://127.0.0.1:3001?leak=1").is_err());

        // Ensure rejected network_set_server_address does not mutate DYNAMIC_API_BASE
        assert!(network_set_server_address("http://evil.example.com:3001".to_string()).is_err());
        assert_eq!(get_dynamic_api_base(), None);

        // Valid Tailscale IP updates DYNAMIC_API_BASE cleanly
        let ok = network_set_server_address("http://100.100.50.25:3001/".to_string()).unwrap();
        assert_eq!(ok, "http://100.100.50.25:3001");
        assert_eq!(
            get_dynamic_api_base(),
            Some("http://100.100.50.25:3001".to_string())
        );

        clear_dynamic_api_base_for_tests();
    }
}
