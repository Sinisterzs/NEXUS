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

pub fn is_valid_public_fqdn(host: &str) -> bool {
    let clean = host.trim().trim_end_matches('.');
    if clean.is_empty() || clean.len() > 253 {
        return false;
    }

    // Disallow raw IP addresses (prevents SSRF against internal LAN/cloud metadata like 192.168.x.x, 10.x.x.x, 169.254.169.254)
    if clean.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }

    let labels: Vec<&str> = clean.split('.').collect();
    // Must have at least 2 labels (domain.tld)
    if labels.len() < 2 {
        return false;
    }

    // TLD must not be purely numeric (RFC 1123) and at least 2 characters
    let tld = labels.last().unwrap();
    if tld.len() < 2 || tld.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }

    for label in labels {
        if label.is_empty() || label.len() > 63 {
            return false;
        }
        if label.starts_with('-') || label.ends_with('-') {
            return false;
        }
        if !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return false;
        }
    }

    true
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

    // 4. Valid RFC 1123 Public Domain FQDN
    if is_valid_public_fqdn(&clean) {
        return true;
    }

    false
}

pub fn validate_server_url(raw_url: &str) -> Result<String, String> {
    if crate::lab::enabled() {
        return if raw_url.trim().trim_end_matches('/') == crate::lab::API {
            Ok(crate::lab::API.into())
        } else { Err("Laboratório aceita somente seu backend loopback".into()) };
    }
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
            "Host não autorizado. Use apenas loopback (127.0.0.1/localhost), endereço privado Tailscale (100.64.0.0/10, *.ts.net) ou domínio público FQDN seguro."
                .to_string(),
        );
    }

    // Public FQDNs must use https:// (http:// is strictly allowed only on loopback or Tailscale)
    let is_local_or_tailnet = host == "127.0.0.1"
        || host == "localhost"
        || host == "[::1]"
        || host == "::1"
        || host == "nexus-server"
        || host.ends_with(".ts.net")
        || is_valid_tailscale_ip(host);

    if !is_local_or_tailnet && scheme != "https" {
        return Err("Domínios públicos externos exigem conexão segura https://.".to_string());
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
pub struct PersistedNetworkConfig {
    pub server_url: Option<String>,
    #[serde(default)]
    pub approved_server_id: Option<String>,
    #[serde(default)]
    pub approved_public_key: Option<String>,
    #[serde(default)]
    pub approved_node_key: Option<String>,
    pub updated_at: i64,
}

static PERSISTED_API_BASE: RwLock<Option<String>> = RwLock::new(None);
static PERSISTED_CONFIG_CACHE: RwLock<Option<PersistedNetworkConfig>> = RwLock::new(None);

fn get_network_config_path() -> PathBuf {
    if crate::is_test_environment() {
        let temp_dir = std::env::temp_dir().join("nexus_test_isolated_network");
        let _ = std::fs::create_dir_all(&temp_dir);
        return temp_dir.join("nexus_network.json");
    }
    if let Ok(custom) = std::env::var("NEXUS_APP_DATA_DIR") {
        let p = PathBuf::from(custom.trim());
        if !p.as_os_str().is_empty() {
            return p.join("nexus_network.json");
        }
    }
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let p = PathBuf::from(appdata).join("com.nexus.desktop");
            return p.join("nexus_network.json");
        }
    }
    PathBuf::from("nexus_network.json")
}

pub fn save_persisted_network_config(
    url: &str,
    server_id: Option<&str>,
    public_key: Option<&str>,
    node_key: Option<&str>,
) -> Result<(), String> {
    let validated = validate_server_url(url)?;
    if let Ok(mut lock) = PERSISTED_API_BASE.write() {
        *lock = Some(validated.clone());
    }
    let now_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let config = PersistedNetworkConfig {
        server_url: Some(validated),
        approved_server_id: server_id.map(|s| s.trim().to_string()),
        approved_public_key: public_key.map(|s| s.trim().to_string()),
        approved_node_key: node_key.map(|s| s.trim().to_string()),
        updated_at: now_ts,
    };
    if let Ok(mut cache_lock) = PERSISTED_CONFIG_CACHE.write() {
        *cache_lock = Some(config.clone());
    }
    let path = get_network_config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Falha ao serializar configuração de rede: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Falha ao gravar nexus_network.json: {}", e))?;
    Ok(())
}

pub fn load_persisted_network_config() -> Option<PersistedNetworkConfig> {
    if let Ok(lock) = PERSISTED_CONFIG_CACHE.read() {
        if let Some(ref val) = *lock {
            return Some(val.clone());
        }
    }
    let path = get_network_config_path();
    if !path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    let cfg: PersistedNetworkConfig = serde_json::from_str(&content).ok()?;
    if let Ok(mut lock) = PERSISTED_CONFIG_CACHE.write() {
        *lock = Some(cfg.clone());
    }
    Some(cfg)
}

pub fn save_persisted_server_url(url: &str) -> Result<(), String> {
    let existing = load_persisted_network_config();
    save_persisted_network_config(
        url,
        existing.as_ref().and_then(|c| c.approved_server_id.as_deref()),
        existing.as_ref().and_then(|c| c.approved_public_key.as_deref()),
        existing.as_ref().and_then(|c| c.approved_node_key.as_deref()),
    )
}

pub const OFFICIAL_SERVER_ID: &str =
    "nexus-id-6a2d70e5c08d48566d6e1d7749359de11eba6dc8fa3743c01d59411b4d7e7092";

pub fn load_persisted_server_url() -> Option<String> {
    if let Ok(lock) = PERSISTED_API_BASE.read() {
        if let Some(ref val) = *lock {
            if val != "http://100.86.96.35:3001" {
                return Some(val.clone());
            }
        }
    }
    let config = load_persisted_network_config()?;
    let url = config.server_url?;
    let validated = validate_server_url(&url).ok()?;

    // Automatic migration: If the persisted server is the old default Tailscale endpoint (100.86.96.35),
    // ONLY migrate to DEFAULT_API_BASE if it corresponds to the official server (or unassigned/cold start),
    // strictly preserving intentional custom private configurations.
    if validated == "http://100.86.96.35:3001" {
        let is_official_or_unassigned = match config.approved_server_id.as_deref() {
            Some(id) => id == OFFICIAL_SERVER_ID,
            None => true,
        };

        if is_official_or_unassigned {
            let public_default = crate::auth::DEFAULT_API_BASE.to_string();
            let _ = save_persisted_network_config(
                &public_default,
                config.approved_server_id.as_deref(),
                config.approved_public_key.as_deref(),
                config.approved_node_key.as_deref(),
            );
            if let Ok(mut lock) = PERSISTED_API_BASE.write() {
                *lock = Some(public_default.clone());
            }
            return Some(public_default);
        }
    }

    if let Ok(mut lock) = PERSISTED_API_BASE.write() {
        *lock = Some(validated.clone());
    }
    Some(validated)
}

pub fn clear_persisted_server_url_for_tests() {
    if let Ok(mut lock) = PERSISTED_API_BASE.write() {
        *lock = None;
    }
    if let Ok(mut lock) = PERSISTED_CONFIG_CACHE.write() {
        *lock = None;
    }
    if crate::is_test_environment() || std::env::var("NEXUS_APP_DATA_DIR").is_ok() {
        let path = get_network_config_path();
        let _ = std::fs::remove_file(path);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TailscalePeerSummary {
    pub host_name: String,
    pub dns_name: String,
    pub tailscale_ips: Vec<String>,
    pub node_key: Option<String>,
    pub online: bool,
    pub is_likely_server: bool,
    pub server_id: Option<String>,
    pub is_approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerHealthProbe {
    pub latency_ms: u64,
    pub server_id: Option<String>,
    pub public_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifiedServerIdentity {
    pub server_id: String,
    pub public_key: String,
    pub bound_endpoint: String,
    pub is_approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkStatus {
    pub tailscale_installed: bool,
    pub tailscale_service_running: bool,
    pub tailscale_authenticated: bool,
    pub tailscale_state: String,
    pub tailscale_ips: Vec<String>,
    pub tailscale_self_name: Option<String>,
    pub tailscale_auth_url: Option<String>,
    pub server_reachability: String,
    pub server_url: String,
    pub server_latency_ms: Option<u64>,
    pub is_magic_dns: bool,
    pub detected_peers: Vec<TailscalePeerSummary>,
    pub pending_server_identity: Option<VerifiedServerIdentity>,
    pub approved_server_id: Option<String>,
    pub verified_server_identity: Option<VerifiedServerIdentity>,
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

pub async fn probe_server_health(url: &str) -> Result<ServerHealthProbe, String> {
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
                let server_id = body.get("server_id").and_then(|v| v.as_str()).map(String::from);
                let public_key = body.get("public_key").and_then(|v| v.as_str()).map(String::from);
                return Ok(ServerHealthProbe {
                    latency_ms: elapsed,
                    server_id,
                    public_key,
                });
            }
        }
        Err("Servidor respondeu mas não possui a identidade autêntica do NEXUS ('service': 'nexus-server').".to_string())
    } else {
        Err(format!("Servidor respondeu com HTTP {}", resp.status()))
    }
}

pub async fn verify_channel_bound_server_identity(
    target_url: &str,
    expected_server_id: Option<&str>,
    expected_public_key: Option<&str>,
) -> Result<VerifiedServerIdentity, String> {
    use base64::prelude::*;
    use ring::rand::SystemRandom;
    use ring::signature::{UnparsedPublicKey, ED25519};
    use sha2::{Digest, Sha256};

    let validated_target = validate_server_url(target_url)?;
    let clean_target = validated_target.trim_end_matches('/').to_lowercase();
    let challenge_url = format!("{}/v1/system/challenge", clean_target);

    // 1. Generate random 32-byte client_nonce
    let rng = SystemRandom::new();
    let mut nonce_bytes = [0u8; 32];
    ring::rand::SecureRandom::fill(&rng, &mut nonce_bytes)
        .map_err(|_| "Falha ao gerar nonce aleatório para o desafio".to_string())?;
    let client_nonce = hex::encode(nonce_bytes);

    // 2. Client timestamp for anti-replay
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(3000))
        .build()
        .map_err(|e| e.to_string())?;

    let payload = serde_json::json!({
        "client_nonce": client_nonce,
        "target_url": clean_target,
        "client_timestamp": now,
    });

    let resp = client
        .post(&challenge_url)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Falha ao conectar no endpoint de desafio do servidor: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("Servidor rejeitou o desafio de identidade: {}", err_text));
    }

    let challenge_resp: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Resposta de desafio inválida: {}", e))?;

    let server_id = challenge_resp
        .get("server_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "server_id ausente na resposta de desafio".to_string())?;
    let public_key_b64 = challenge_resp
        .get("public_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "public_key ausente na resposta de desafio".to_string())?;
    let server_nonce = challenge_resp
        .get("server_nonce")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "server_nonce ausente na resposta de desafio".to_string())?;
    let signature_b64 = challenge_resp
        .get("signature")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "signature ausente na resposta de desafio".to_string())?;
    let bound_endpoint = challenge_resp
        .get("bound_endpoint")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // 3. Verify channel binding: bound_endpoint must match the exact URL we contacted
    if bound_endpoint.trim().trim_end_matches('/').to_lowercase() != clean_target {
        return Err(format!(
            "Violação de segurança: o servidor assinou para o endpoint '{}', diferente da URL conectada '{}'. Possível ataque de relay!",
            bound_endpoint, clean_target
        ));
    }

    // 4. Verify public_key format and derive server_id
    let pub_bytes = BASE64_STANDARD
        .decode(public_key_b64)
        .map_err(|_| "Chave pública Ed25519 inválida".to_string())?;
    if pub_bytes.len() != 32 {
        return Err("Chave pública Ed25519 deve ter 32 bytes".to_string());
    }

    let computed_server_id = format!("nexus-id-{}", hex::encode(Sha256::digest(&pub_bytes)));
    if computed_server_id != server_id {
        return Err("server_id não corresponde à impressão digital da chave pública apresentada".to_string());
    }

    // 5. Verify Ed25519 signature over transcript
    let message = format!(
        "NEXUS-V1-CHANNEL-BIND:{}:{}:{}:{}",
        client_nonce, clean_target, now, server_nonce
    );
    let sig_bytes = BASE64_STANDARD
        .decode(signature_b64)
        .map_err(|_| "Assinatura do servidor inválida em base64".to_string())?;

    let verifier = UnparsedPublicKey::new(&ED25519, &pub_bytes);
    verifier
        .verify(message.as_bytes(), &sig_bytes)
        .map_err(|_| "Falha na verificação da assinatura criptográfica do servidor!".to_string())?;

    // 6. Check against expected server identity
    let is_approved = if let Some(exp_id) = expected_server_id {
        let id_matches = server_id == exp_id;
        let pk_matches = expected_public_key.map(|exp_pk| exp_pk == public_key_b64).unwrap_or(true);
        id_matches && pk_matches
    } else {
        false
    };

    Ok(VerifiedServerIdentity {
        server_id: server_id.to_string(),
        public_key: public_key_b64.to_string(),
        bound_endpoint: clean_target,
        is_approved,
    })
}

#[tauri::command]
pub async fn network_get_status(include_tailscale: Option<bool>) -> Result<NetworkStatus, String> {
    // Determine current target server URL first
    let current_base = crate::auth::get_api_base();
    let mut active_url = current_base.clone();
    let is_public_https = active_url.starts_with("https://");

    // Only query Tailscale daemon if:
    // 1) Explicitly requested by caller (e.g. settings / diagnostic refresh)
    // 2) The user is explicitly configured with a private Tailscale / local address
    let should_query_tailscale = match include_tailscale {
        Some(explicit) => explicit,
        None => !is_public_https,
    };

    let cli_opt = find_tailscale_cli();
    let installed = cli_opt.is_some();

    let mut service_running = false;
    let mut authenticated = false;
    let mut state_str = if installed {
        if should_query_tailscale {
            "stopped".to_string()
        } else {
            "idle".to_string()
        }
    } else {
        "not_installed".to_string()
    };
    let mut ips: Vec<String> = Vec::new();
    let mut self_name: Option<String> = None;
    let mut auth_url: Option<String> = None;
    let mut detected_peers: Vec<TailscalePeerSummary> = Vec::new();

    if !crate::lab::enabled() && installed && should_query_tailscale {
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
                        let node_key = p_val
                            .get("PublicKey")
                            .and_then(|v| v.as_str())
                            .map(String::from);
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
                            node_key,
                            online,
                            is_likely_server: is_server,
                            server_id: None,
                            is_approved: false,
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

    let mut server_latency: Option<u64> = None;
    let mut reachability = "server_unreachable".to_string();
    let mut pending_server_identity: Option<VerifiedServerIdentity> = None;
    let mut verified_server_identity: Option<VerifiedServerIdentity> = None;

    let persisted_cfg = load_persisted_network_config();
    let approved_server_id = persisted_cfg.as_ref().and_then(|c| c.approved_server_id.clone());
    let approved_pub_key = persisted_cfg.as_ref().and_then(|c| c.approved_public_key.clone());

    // 1. Probe the current/configured server URL first
    if let Ok(probe) = probe_server_health(&active_url).await {
        server_latency = Some(probe.latency_ms);

        // Perform cryptographic channel-bound verification
        match verify_channel_bound_server_identity(
            &active_url,
            approved_server_id.as_deref(),
            approved_pub_key.as_deref(),
        )
        .await
        {
            Ok(ver) => {
                if ver.is_approved {
                    reachability = "connected".to_string();
                    crate::auth::record_authenticated_server_identity(&active_url, &ver.server_id);
                    verified_server_identity = Some(ver);
                } else if approved_server_id.is_none()
                    && (active_url.contains("127.0.0.1") || active_url.contains("localhost"))
                {
                    // Auto-approve loopback on cold start for local development
                    let _ = save_persisted_network_config(
                        &active_url,
                        Some(&ver.server_id),
                        Some(&ver.public_key),
                        None,
                    );
                    crate::auth::record_authenticated_server_identity(&active_url, &ver.server_id);
                    reachability = "connected".to_string();
                    let mut approved_ver = ver;
                    approved_ver.is_approved = true;
                    verified_server_identity = Some(approved_ver);
                } else {
                    // Server responded and proved its key via channel binding, but has NOT been approved by the user yet
                    reachability = "needs_approval".to_string();
                    pending_server_identity = Some(ver.clone());
                    verified_server_identity = Some(ver);
                }
            }
            Err(err) => {
                eprintln!("[Network] Falha na validação de identidade criptográfica do servidor {}: {}", active_url, err);
                reachability = "server_unreachable".to_string();
            }
        }
    }

    // 2. Fallback: Only scan private candidates if configured server is on a private network!
    // For users configured with public HTTPS, avoid unprompted scanning of private Tailscale peers.
    if !crate::lab::enabled() && reachability != "connected" && reachability != "needs_approval" && !is_public_https {
        let mut candidates: Vec<String> = Vec::new();

        // Pass 0: Default public HTTPS server if not already active_url
        let default_public = crate::auth::get_default_api_base();
        if default_public != active_url {
            candidates.push(default_public);
        }

        // Pass 1: Peers labeled as likely servers
        for p in &detected_peers {
            if p.online && p.is_likely_server {
                if !p.dns_name.is_empty() {
                    candidates.push(format!("http://{}:3001", p.dns_name));
                }
                for ip in &p.tailscale_ips {
                    candidates.push(format!("http://{}:3001", ip));
                }
            }
        }

        // Pass 2: Self Tailscale IPs (if backend is running on local Tailscale interface)
        for ip in &ips {
            if is_valid_tailscale_ip(ip) {
                candidates.push(format!("http://{}:3001", ip));
            }
        }

        // Pass 3: Loopback
        candidates.push("http://127.0.0.1:3001".to_string());
        candidates.push("http://localhost:3001".to_string());

        // Pass 4: Other online peers in the Tailnet
        for p in &detected_peers {
            if p.online && !p.is_likely_server {
                if !p.dns_name.is_empty() {
                    candidates.push(format!("http://{}:3001", p.dns_name));
                }
                for ip in &p.tailscale_ips {
                    candidates.push(format!("http://{}:3001", ip));
                }
            }
        }

        // Deduplicate candidates while preserving order
        let mut seen = std::collections::HashSet::new();
        candidates.retain(|c| seen.insert(c.clone()));

        for cand in candidates {
            if cand == active_url {
                continue;
            }
            if let Ok(probe) = probe_server_health(&cand).await {
                // If an approved_server_id was previously saved, candidate must match it
                if let (Some(ref app_id), Some(ref cand_id)) = (&approved_server_id, &probe.server_id) {
                    if app_id == cand_id {
                        if let Ok(ver) = verify_channel_bound_server_identity(
                            &cand,
                            Some(app_id),
                            approved_pub_key.as_deref(),
                        )
                        .await
                        {
                            server_latency = Some(probe.latency_ms);
                            reachability = "connected".to_string();
                            active_url = cand.clone();
                            set_dynamic_api_base(cand.clone());
                            let _ = save_persisted_server_url(&cand);
                            crate::auth::record_authenticated_server_identity(&cand, &ver.server_id);
                            eprintln!(
                                "[Network] Servidor NEXUS legítimo reconectado e autenticado criptograficamente via Tailscale: {} (ID: {})",
                                cand, ver.server_id
                            );
                            verified_server_identity = Some(ver);
                            break;
                        }
                    }
                } else if approved_server_id.is_none() {
                    // TOFU (Trust On First Use): Server identity verified cryptographically via Ed25519 channel challenge
                    if let Ok(ver) = verify_channel_bound_server_identity(
                        &cand,
                        None,
                        None,
                    )
                    .await
                    {
                        if cand.contains("127.0.0.1") || cand.contains("localhost") {
                            // Auto-approve loopback on cold start for local development
                            let _ = save_persisted_network_config(
                                &cand,
                                Some(&ver.server_id),
                                Some(&ver.public_key),
                                None,
                            );
                            server_latency = Some(probe.latency_ms);
                            reachability = "connected".to_string();
                            active_url = cand.clone();
                            set_dynamic_api_base(cand.clone());
                            crate::auth::record_authenticated_server_identity(&cand, &ver.server_id);
                            eprintln!(
                                "[Network] Servidor local em loopback auto-aprovado: {} (ID: {})",
                                cand, ver.server_id
                            );
                            let mut approved_ver = ver;
                            approved_ver.is_approved = true;
                            verified_server_identity = Some(approved_ver);
                            break;
                        } else {
                            // Tailscale server candidate located and cryptographically verified:
                            // Propose to user for explicit approval (TOFU banner)
                            server_latency = Some(probe.latency_ms);
                            reachability = "needs_approval".to_string();
                            active_url = cand.clone();
                            set_dynamic_api_base(cand.clone());
                            pending_server_identity = Some(ver.clone());
                            verified_server_identity = Some(ver);
                            eprintln!(
                                "[Network] Novo servidor NEXUS aguardando aprovação do usuário: {} (ID: {})",
                                cand, pending_server_identity.as_ref().unwrap().server_id
                            );
                            break;
                        }
                    }
                }
            }
        }
    }

    if reachability != "connected" && reachability != "needs_approval" {
        if active_url.starts_with("https://") {
            // Public HTTPS server connectivity failure does not indicate private Tailscale disconnection
            reachability = "server_unreachable".to_string();
        } else if !installed || state_str != "running" {
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
        pending_server_identity,
        approved_server_id,
        verified_server_identity,
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
    if crate::lab::enabled() { return Err("Tailscale do host não é gerenciado pelo laboratório".into()); }
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
    let _ = save_persisted_server_url(&valid_url);
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
pub async fn network_approve_server(url: String) -> Result<VerifiedServerIdentity, String> {
    let valid_url = validate_server_url(&url)?;
    let ver = verify_channel_bound_server_identity(&valid_url, None, None).await?;
    let old_cfg = load_persisted_network_config();
    let is_different_server = old_cfg
        .as_ref()
        .and_then(|c| c.approved_server_id.as_deref())
        .map(|old_id| old_id != ver.server_id)
        .unwrap_or(false);

    save_persisted_network_config(&valid_url, Some(&ver.server_id), Some(&ver.public_key), None)?;
    set_dynamic_api_base(valid_url.clone());
    crate::auth::record_authenticated_server_identity(&valid_url, &ver.server_id);

    if is_different_server {
        eprintln!(
            "[Network] Novo servidor com identidade distinta aprovado. Sessão anterior desvinculada para evitar vazamento de token para outra entidade."
        );
        crate::auth::set_active_user_id(None);
        let _ = crate::auth::delete_secure_token();
    }

    eprintln!(
        "[Network] Servidor aprovado explicitamente pelo usuário: {} (ID: {})",
        valid_url, ver.server_id
    );
    Ok(ver)
}

#[tauri::command]
pub async fn network_verify_server(url: Option<String>) -> Result<VerifiedServerIdentity, String> {
    let target = url.unwrap_or_else(|| crate::auth::get_api_base());
    let valid_target = validate_server_url(&target)?;
    let persisted_cfg = load_persisted_network_config();
    let app_id = persisted_cfg.as_ref().and_then(|c| c.approved_server_id.as_deref());
    let app_pk = persisted_cfg.as_ref().and_then(|c| c.approved_public_key.as_deref());
    verify_channel_bound_server_identity(&valid_target, app_id, app_pk).await
}

#[tauri::command]
pub async fn network_check_server(url: Option<String>) -> Result<serde_json::Value, String> {
    let raw_target = url.unwrap_or_else(|| crate::auth::get_api_base());
    let target = validate_server_url(&raw_target)?;
    match probe_server_health(&target).await {
        Ok(probe) => Ok(serde_json::json!({
            "status": "connected",
            "url": target,
            "latency_ms": probe.latency_ms,
            "server_id": probe.server_id,
            "public_key": probe.public_key
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
pub(crate) mod tests {
    use super::*;

    pub(crate) static TEST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
        // Valid HTTPS Public FQDNs
        assert_eq!(
            validate_server_url("https://api.nexus.app").unwrap(),
            "https://api.nexus.app"
        );
        assert_eq!(
            validate_server_url("https://nexus.mydomain.com:443/").unwrap(),
            "https://nexus.mydomain.com"
        );
    }

    #[test]
    fn test_validate_server_url_rejects_unauthorized_hosts_and_exfiltration_vectors() {
        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        clear_dynamic_api_base_for_tests();

        // Plaintext HTTP on external domains must be rejected to prevent credential interception
        assert!(validate_server_url("http://attacker.example.com:3001").is_err());
        assert!(validate_server_url("http://nexus-server.attacker.com:3001").is_err());
        assert!(validate_server_url("http://ts.net.attacker.com:3001").is_err());
        assert!(validate_server_url("http://api.nexus.app").is_err());

        // Malformed domain names or numeric TLDs must be rejected
        assert!(validate_server_url("https://-invalid.example.com").is_err());
        assert!(validate_server_url("https://invalid-.example.com").is_err());
        assert!(validate_server_url("https://invalid..example.com").is_err());
        assert!(validate_server_url("https://domain.123").is_err());

        // IPs outside Tailscale 100.64.0.0/10 and loopback must be rejected (prevents LAN SSRF and metadata probing)
        assert!(validate_server_url("http://100.63.255.255:3001").is_err());
        assert!(validate_server_url("http://100.128.0.1:3001").is_err());
        assert!(validate_server_url("http://192.168.1.50:3001").is_err());
        assert!(validate_server_url("https://192.168.1.50").is_err());
        assert!(validate_server_url("http://10.0.0.1:3001").is_err());
        assert!(validate_server_url("https://10.0.0.1").is_err());
        assert!(validate_server_url("http://169.254.169.254:3001").is_err());
        assert!(validate_server_url("https://169.254.169.254").is_err());
        assert!(validate_server_url("http://8.8.8.8:3001").is_err());
        assert!(validate_server_url("https://8.8.8.8").is_err());

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
        clear_persisted_server_url_for_tests();
    }

    #[test]
    fn test_persisted_server_url_lifecycle() {
        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        clear_dynamic_api_base_for_tests();
        clear_persisted_server_url_for_tests();

        assert_eq!(load_persisted_server_url(), None);

        assert!(save_persisted_server_url("http://100.117.183.97:3001").is_ok());
        assert_eq!(
            load_persisted_server_url(),
            Some("http://100.117.183.97:3001".to_string())
        );

        clear_persisted_server_url_for_tests();
        assert_eq!(load_persisted_server_url(), None);
    }

    #[test]
    fn test_channel_challenge_signature_verification_rules() {
        use ring::rand::SystemRandom;
        use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
        use sha2::{Digest, Sha256};

        // 1. Generate an Ed25519 keypair for the server
        let rng = SystemRandom::new();
        let pkcs8_bytes = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let keypair = Ed25519KeyPair::from_pkcs8(pkcs8_bytes.as_ref()).unwrap();
        let pubkey_bytes = keypair.public_key().as_ref();
        let server_id = format!("nexus-id-{}", hex::encode(Sha256::digest(pubkey_bytes)));

        let client_nonce = hex::encode([0x12u8; 32]);
        let target_url = "http://100.86.96.35:3001";
        let timestamp = 1731000000i64;
        let server_nonce = hex::encode([0x34u8; 32]);

        let message = format!(
            "NEXUS-V1-CHANNEL-BIND:{}:{}:{}:{}",
            client_nonce, target_url, timestamp, server_nonce
        );
        let sig = keypair.sign(message.as_bytes());

        // Client verification succeeds with matching endpoint, key, nonces
        let verifier = UnparsedPublicKey::new(&ED25519, pubkey_bytes);
        assert!(verifier.verify(message.as_bytes(), sig.as_ref()).is_ok());

        // Derived server_id must match SHA-256 of public key
        let derived_id = format!("nexus-id-{}", hex::encode(Sha256::digest(pubkey_bytes)));
        assert_eq!(derived_id, server_id);

        // Relay Attack Attempt: message was signed for 100.86.96.35:3001, but attacker presents it at 100.99.99.99:3001
        let rogue_target = "http://100.99.99.99:3001";
        let rogue_message = format!(
            "NEXUS-V1-CHANNEL-BIND:{}:{}:{}:{}",
            client_nonce, rogue_target, timestamp, server_nonce
        );
        assert!(
            verifier.verify(rogue_message.as_bytes(), sig.as_ref()).is_err(),
            "Client must reject signature if target endpoint differs"
        );

        // Rogue Server Identity: rogue key generates different server_id
        let rogue_pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let rogue_keypair = Ed25519KeyPair::from_pkcs8(rogue_pkcs8.as_ref()).unwrap();
        let rogue_server_id = format!(
            "nexus-id-{}",
            hex::encode(Sha256::digest(rogue_keypair.public_key().as_ref()))
        );
        assert_ne!(rogue_server_id, server_id, "Different keys must produce distinct server_ids");
    }

    #[test]
    fn test_auth_token_withholding_on_unauthenticated_server() {
        use crate::auth::*;

        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        clear_authenticated_server_origin();
        clear_dynamic_api_base_for_tests();
        clear_persisted_server_url_for_tests();

        let initial_origin = "http://127.0.0.1:3001";
        let token = "test_safe_session_secret_777";
        set_dynamic_api_base(initial_origin.to_string());
        assert!(save_secure_token_for_origin(token, initial_origin).is_ok());

        // If active origin is the same, token is retrieved
        assert_eq!(get_secure_token(), Some(token.to_string()));

        // Switch dynamic API base to an unapproved rogue server
        let rogue_origin = "http://100.99.99.99:3001";
        set_dynamic_api_base(rogue_origin.to_string());

        // Token MUST BE WITHHELD! Because 100.99.99.99 is not the authenticated origin in memory
        // and has not passed cryptographic verification.
        assert_eq!(
            get_secure_token(),
            None,
            "Token must be withheld from unauthenticated rogue origin"
        );

        // When legitimately authenticated with cryptographic identity matching:
        record_authenticated_server_identity(rogue_origin, "nexus-id-approved-123");
        assert_eq!(
            get_secure_token(),
            Some(token.to_string()),
            "Token safely delivered only after cryptographic verification records identity"
        );

        clear_authenticated_server_origin();
        clear_dynamic_api_base_for_tests();
        clear_persisted_server_url_for_tests();
        let _ = delete_secure_token();
    }

    #[tokio::test]
    async fn test_live_backend_needs_approval_flow() {
        use crate::auth::clear_authenticated_server_origin;

        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        clear_authenticated_server_origin();
        clear_dynamic_api_base_for_tests();
        clear_persisted_server_url_for_tests();

        // When no server is approved yet:
        let status = network_get_status(None).await.expect("network_get_status must succeed");
        println!(
            "[Test] Live status reachability: {}, server_url: {}, pending_id: {:?}",
            status.server_reachability,
            status.server_url,
            status.pending_server_identity.as_ref().map(|p| &p.server_id)
        );

        assert_eq!(status.server_reachability, "needs_approval");
        assert!(status.pending_server_identity.is_some());
        let pending = status.pending_server_identity.unwrap();
        assert_eq!(
            pending.server_id,
            "nexus-id-6a2d70e5c08d48566d6e1d7749359de11eba6dc8fa3743c01d59411b4d7e7092"
        );

        // Now test approving this server:
        let approved = network_approve_server(status.server_url.clone())
            .await
            .expect("Approval must succeed");
        assert_eq!(approved.server_id, pending.server_id);

        // After approval, network_get_status must report connected:
        let status_after = network_get_status(None)
            .await
            .expect("network_get_status after approval must succeed");
        assert_eq!(status_after.server_reachability, "connected");

        // Cleanup
        clear_authenticated_server_origin();
        clear_dynamic_api_base_for_tests();
        clear_persisted_server_url_for_tests();
    }

    #[tokio::test]
    async fn test_network_status_public_https_bypasses_tailscale_probe() {
        use crate::auth::clear_authenticated_server_origin;

        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        clear_authenticated_server_origin();
        clear_dynamic_api_base_for_tests();
        clear_persisted_server_url_for_tests();

        // Default endpoint is https://nexus-api.dynv6.net
        let status = network_get_status(None).await.expect("network_get_status must succeed");
        assert!(status.server_url.starts_with("https://"));
        // Tailscale state is idle because it was never queried or started
        assert_eq!(status.tailscale_state, "idle");
        assert!(status.detected_peers.is_empty(), "Private peers must not be queried for public HTTPS");
    }

    #[test]
    fn test_legacy_tailscale_default_url_migration() {
        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        clear_persisted_server_url_for_tests();

        // Case 1: Migrate when corresponding to official server ID
        let _ = save_persisted_network_config(
            "http://100.86.96.35:3001",
            Some(OFFICIAL_SERVER_ID),
            Some("legacy-key"),
            None,
        );
        let resolved_official = load_persisted_server_url().expect("Must resolve URL");
        assert_eq!(resolved_official, crate::auth::DEFAULT_API_BASE);

        clear_persisted_server_url_for_tests();

        // Case 2: Migrate when unassigned (cold start / unapproved)
        let _ = save_persisted_network_config(
            "http://100.86.96.35:3001",
            None,
            None,
            None,
        );
        let resolved_unassigned = load_persisted_server_url().expect("Must resolve URL");
        assert_eq!(resolved_unassigned, crate::auth::DEFAULT_API_BASE);

        clear_persisted_server_url_for_tests();

        // Case 3: Preserve intentional custom private configuration
        let _ = save_persisted_network_config(
            "http://100.86.96.35:3001",
            Some("custom-private-server-id"),
            Some("custom-key"),
            None,
        );
        let resolved_custom = load_persisted_server_url().expect("Must resolve URL");
        assert_eq!(
            resolved_custom, "http://100.86.96.35:3001",
            "Intentional custom private configuration must be preserved"
        );

        clear_persisted_server_url_for_tests();
    }

    #[tokio::test]
    async fn test_https_init_flow_with_tailscale_states() {
        use crate::auth::clear_authenticated_server_origin;

        let _guard = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        clear_authenticated_server_origin();
        clear_dynamic_api_base_for_tests();
        clear_persisted_server_url_for_tests();

        // 1. HTTPS default init: Tailscale is never queried or waited on (idle)
        let status = network_get_status(None).await.expect("HTTPS status must succeed");
        assert!(status.server_url.starts_with("https://"));
        assert_eq!(status.tailscale_state, "idle");
        assert!(status.detected_peers.is_empty());

        // 2. Private endpoint when Tailscale is inactive: reports disconnected/unreachable
        crate::network::set_dynamic_api_base("http://100.100.100.100:3001".to_string());
        let private_status = network_get_status(None).await.expect("Private status must resolve");
        assert_ne!(private_status.server_reachability, "connected");

        clear_authenticated_server_origin();
        clear_dynamic_api_base_for_tests();
        clear_persisted_server_url_for_tests();
    }
}
