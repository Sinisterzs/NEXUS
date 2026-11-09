use std::env;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub database_url: String,
    pub test_database_url: Option<String>,
    pub server_host: String,
    pub server_port: u16,
    pub session_ttl_hours: i64,
    pub rate_limit_auth_per_minute: u32,
    pub google_client_id: String,
    pub google_client_secret: Option<String>,
    pub google_jwks_url: String,
    pub tailscale_ip: Option<String>,
    pub public_fqdn: Option<String>,
    pub trust_proxy_headers: bool,
    pub turn_secret: Option<String>,
    pub turn_server: Option<String>,
}

impl AppConfig {
    pub fn from_env() -> Self {
        // 1. Try standard dotenv in current directory and parent directories
        let _ = dotenvy::dotenv();

        // 2. Always attempt loading from nexus-server/.env if running from workspace root or subfolder
        let _ = dotenvy::from_path("nexus-server/.env");
        let _ = dotenvy::from_path("../nexus-server/.env");

        let database_url = env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://postgres@localhost:5432/nexus_db".to_string());

        let test_database_url = env::var("TEST_DATABASE_URL").ok();

        let server_host = env::var("SERVER_HOST")
            .unwrap_or_else(|_| "127.0.0.1".to_string());

        let server_port = env::var("SERVER_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3001);

        let session_ttl_hours = env::var("SESSION_TTL_HOURS")
            .ok()
            .and_then(|h| h.parse().ok())
            .unwrap_or(72);

        let rate_limit_auth_per_minute = env::var("RATE_LIMIT_AUTH_PER_MINUTE")
            .ok()
            .and_then(|r| r.parse().ok())
            .unwrap_or(30);

        // Fallback direct parser for .env files to guarantee loading regardless of working dir or shell inheritance
        let mut file_client_id: Option<String> = None;
        let mut file_client_secret: Option<String> = None;
        let mut file_tailscale_ip: Option<String> = None;
        for path in &["nexus-server/.env", "../nexus-server/.env", ".env"] {
            if let Ok(content) = std::fs::read_to_string(path) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with('#') || trimmed.is_empty() {
                        continue;
                    }
                    if let Some(val) = trimmed.strip_prefix("GOOGLE_CLIENT_ID=") {
                        let clean = val.trim().trim_matches('"').trim_matches('\'').trim();
                        if !clean.is_empty() && file_client_id.is_none() {
                            file_client_id = Some(clean.to_string());
                        }
                    }
                    if let Some(val) = trimmed.strip_prefix("GOOGLE_CLIENT_SECRET=") {
                        let clean = val.trim().trim_matches('"').trim_matches('\'').trim();
                        if !clean.is_empty() && file_client_secret.is_none() {
                            file_client_secret = Some(clean.to_string());
                        }
                    }
                    if let Some(val) = trimmed.strip_prefix("TAILSCALE_IP=") {
                        let clean = val.trim().trim_matches('"').trim_matches('\'').trim();
                        if !clean.is_empty() && file_tailscale_ip.is_none() {
                            file_tailscale_ip = Some(clean.to_string());
                        }
                    }
                }
            }
            if file_client_id.is_some() && file_client_secret.is_some() && file_tailscale_ip.is_some() {
                break;
            }
        }

        let google_client_id = env::var("GOOGLE_CLIENT_ID")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or(file_client_id)
            .unwrap_or_else(|| "964906993797-r3v176v8d8b88fo0r9bethub6dr4cre2.apps.googleusercontent.com".to_string());

        let google_client_secret = env::var("GOOGLE_CLIENT_SECRET")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or(file_client_secret);

        let google_jwks_url = env::var("GOOGLE_JWKS_URL")
            .unwrap_or_else(|_| "https://www.googleapis.com/oauth2/v3/certs".to_string());

        let tailscale_ip = env::var("TAILSCALE_IP")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(detect_tailscale_ip);

        let public_fqdn = env::var("PUBLIC_FQDN")
            .or_else(|_| env::var("PUBLIC_DOMAIN"))
            .ok()
            .map(|s| {
                s.trim()
                    .trim_start_matches("https://")
                    .trim_start_matches("http://")
                    .trim_end_matches('/')
                    .to_ascii_lowercase()
            })
            .filter(|s| !s.is_empty());

        let trust_proxy_headers = env::var("TRUST_PROXY_HEADERS")
            .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
            .unwrap_or(false);

        let turn_secret = env::var("TURN_SECRET")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let turn_server = env::var("TURN_SERVER")
            .or_else(|_| env::var("TURN_URLS"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        Self {
            database_url,
            test_database_url,
            server_host,
            server_port,
            session_ttl_hours,
            rate_limit_auth_per_minute,
            google_client_id,
            google_client_secret,
            google_jwks_url,
            tailscale_ip,
            public_fqdn,
            trust_proxy_headers,
            turn_secret,
            turn_server,
        }
    }

    pub fn server_addr(&self) -> String {
        format!("{}:{}", self.server_host, self.server_port)
    }
}

/// Detects the IPv4 address assigned to the Tailscale interface on this host.
pub fn detect_tailscale_ip() -> Option<String> {
    // 1. Runtime environment variable
    if let Ok(ip) = env::var("TAILSCALE_IP") {
        let trimmed = ip.trim();
        if is_valid_tailscale_ip(trimmed) {
            return Some(trimmed.to_string());
        }
    }

    // 2. Direct read from .env files
    for path in &["nexus-server/.env", "../nexus-server/.env", ".env"] {
        if let Ok(content) = std::fs::read_to_string(path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if let Some(val) = trimmed.strip_prefix("TAILSCALE_IP=") {
                    let clean = val.trim().trim_matches('"').trim_matches('\'').trim();
                    if is_valid_tailscale_ip(clean) {
                        return Some(clean.to_string());
                    }
                }
            }
        }
    }

    // 3. Try executing `tailscale ip -4`
    let mut cmd = std::process::Command::new("tailscale");
    cmd.arg("ip").arg("-4");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let out_str = String::from_utf8_lossy(&output.stdout);
            for line in out_str.lines() {
                let clean = line.trim();
                if is_valid_tailscale_ip(clean) {
                    return Some(clean.to_string());
                }
            }
        }
    }

    // 4. Check standard Tailscale installation paths on Windows
    #[cfg(windows)]
    {
        let local_app_path = env::var("LOCALAPPDATA")
            .map(|p| format!(r"{}\Tailscale\tailscale.exe", p))
            .unwrap_or_default();

        for path in &[
            r"C:\Program Files\Tailscale\tailscale.exe",
            r"C:\Program Files (x86)\Tailscale\tailscale.exe",
            &local_app_path,
        ] {
            if !path.is_empty() && std::path::Path::new(path).exists() {
                let mut cmd = std::process::Command::new(path);
                cmd.arg("ip").arg("-4");
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
                if let Ok(output) = cmd.output() {
                    if output.status.success() {
                        let out_str = String::from_utf8_lossy(&output.stdout);
                        for line in out_str.lines() {
                            let clean = line.trim();
                            if is_valid_tailscale_ip(clean) {
                                return Some(clean.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

/// Validates whether an IP address string belongs to the Tailscale Carrier-Grade NAT block (RFC 6598: 100.64.0.0/10)
pub fn is_valid_tailscale_ip(ip_str: &str) -> bool {
    if let Ok(ip) = ip_str.parse::<std::net::Ipv4Addr>() {
        let octets = ip.octets();
        octets[0] == 100 && (octets[1] >= 64 && octets[1] <= 127)
    } else {
        false
    }
}

/// Redacts credentials/passwords from a database connection URL before logging.
pub fn redact_database_url(raw_url: &str) -> String {
    let trimmed = raw_url.trim();
    if let Some(scheme_end) = trimmed.find("://") {
        let scheme = &trimmed[..scheme_end];
        let rest = &trimmed[scheme_end + 3..];
        let authority_end = rest.find(['/', '?']).unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        let path_and_query_raw = &rest[authority_end..];
        // Also strip any query parameters that might contain password=...
        let safe_path = path_and_query_raw
            .split('?')
            .next()
            .unwrap_or(path_and_query_raw);

        if let Some(at_pos) = authority.rfind('@') {
            let userinfo = &authority[..at_pos];
            let host_port = &authority[at_pos + 1..];
            let user = userinfo.split(':').next().unwrap_or("user");
            return format!("{}://{}:***@{}", scheme, user, host_port) + safe_path;
        } else {
            return format!("{}://{}{}", scheme, authority, safe_path);
        }
    }
    "<redacted-database-url>".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_tailscale_ip() {
        assert!(is_valid_tailscale_ip("100.64.0.1"));
        assert!(is_valid_tailscale_ip("100.100.12.34"));
        assert!(is_valid_tailscale_ip("100.127.255.254"));
        assert!(!is_valid_tailscale_ip("100.128.0.1"));
        assert!(!is_valid_tailscale_ip("100.63.255.255"));
        assert!(!is_valid_tailscale_ip("192.168.1.1"));
        assert!(!is_valid_tailscale_ip("127.0.0.1"));
    }

    #[test]
    fn test_redact_database_url_never_leaks_password() {
        let with_pw = "postgres://postgres:SuperSecret123!@#@127.0.0.1:5432/nexus_db?sslmode=disable&password=Leak";
        let redacted = redact_database_url(with_pw);
        assert_eq!(redacted, "postgres://postgres:***@127.0.0.1:5432/nexus_db");
        assert!(!redacted.contains("SuperSecret123"));
        assert!(!redacted.contains("Leak"));

        let without_pw = "postgres://postgres@localhost:5432/nexus_db";
        assert_eq!(
            redact_database_url(without_pw),
            "postgres://postgres:***@localhost:5432/nexus_db"
        );

        let malformed = "user=postgres password=secret host=localhost";
        let redacted_malformed = redact_database_url(malformed);
        assert_eq!(redacted_malformed, "<redacted-database-url>");
        assert!(!redacted_malformed.contains("secret"));
    }
}
