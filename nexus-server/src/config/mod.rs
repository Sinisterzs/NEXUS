#[cfg(all(feature = "test-lab", not(debug_assertions)))]
compile_error!("test-lab is restricted to Debug builds");
use std::env;

/// Lab compilation occurs in a generated, secret-free source stage.
pub fn lab_root() -> std::path::PathBuf {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    assert_eq!(root.file_name().and_then(|s| s.to_str()), Some(".nexus-lab"), "Use scripts/lab.ps1 Prepare");
    root.to_path_buf()
}

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
        if cfg!(feature = "test-lab") {
            // No dotenv, production secrets, Tailscale discovery or inherited DB URL.
            let password = std::fs::read_to_string(lab_root().join("pg-password")).expect("Prepare lab first");
            assert!(password.trim().len() == 64 && password.trim().chars().all(|c| c.is_ascii_hexdigit()));
            return Self {
                database_url: format!("postgres://nexus_lab:{}@127.0.0.1:15432/nexus_lab", password.trim()),
                test_database_url: None, server_host: "127.0.0.1".into(), server_port: 13001,
                session_ttl_hours: 12, rate_limit_auth_per_minute: 30,
                google_client_id: String::new(), google_client_secret: None,
                google_jwks_url: "http://127.0.0.1:1/disabled".into(),
                tailscale_ip: None, public_fqdn: None, trust_proxy_headers: false,
                turn_secret: None, turn_server: None,
            };
        }
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

// ==========================================
// Transactional e-mail configuration (password recovery)
// ==========================================
//
// Kept separate from `AppConfig` on purpose: `AppConfig` is constructed with
// struct literals in several test suites, and this module must stay
// dependency-free (std only) so offline security tests can include it directly.

/// Default HTTPS bridge URL used in password recovery e-mails so webmail clients
/// (such as Gmail, which strips custom `nexus://` links) render a clickable link.
pub const DEFAULT_PASSWORD_RESET_URL: &str = "https://nexus-api.dynv6.net/reset-password";
/// Custom desktop URI scheme opened by the HTTPS bridge page (`nexus://reset-password?token=...`).
pub const DEFAULT_DEEP_LINK_RESET_URL: &str = "nexus://reset-password";
/// Default Resend API endpoint used when `NEXUS_EMAIL_PROVIDER=resend` and no URL override is given.
pub const DEFAULT_RESEND_API_URL: &str = "https://api.resend.com/emails";
/// Default sender identity when `NEXUS_EMAIL_FROM` is not configured.
pub const DEFAULT_EMAIL_FROM: &str = "NEXUS <no-reply@nexus.local>";

/// Resolves the password recovery base URL to an `http(s)://` address suitable for e-mail clients.
/// - If `configured` starts with `https://` or `http://`, it is preserved.
/// - If `configured` is omitted or uses a custom scheme like `nexus://` (which Gmail strips from
///   `<a href>`), it is automatically upgraded to `https://<public_fqdn>/reset-password` or
///   [`DEFAULT_PASSWORD_RESET_URL`].
pub fn resolve_https_reset_url(configured: Option<&str>, public_fqdn: Option<&str>) -> String {
    if let Some(raw) = configured {
        let trimmed = raw.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("https://") || lower.starts_with("http://") {
            return trimmed.to_string();
        }
    }

    if let Some(fqdn) = public_fqdn {
        let clean = fqdn
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .to_ascii_lowercase();
        if !clean.is_empty() {
            return format!("https://{}/reset-password", clean);
        }
    }

    DEFAULT_PASSWORD_RESET_URL.to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailProviderKind {
    /// Never sends anything (default). Requests still succeed with the uniform response.
    Disabled,
    /// Resend HTTP API (`POST /emails`, Bearer API key).
    Resend,
    /// Generic HTTPS webhook receiving a JSON payload (optional Bearer API key).
    Webhook,
    /// SMTP relay. Not compiled into this build (no SMTP client dependency);
    /// treated as unavailable at runtime and reported at startup.
    Smtp,
}

impl EmailProviderKind {
    /// Parses `NEXUS_EMAIL_PROVIDER`. Unknown or empty values fail closed to `Disabled`.
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "resend" => EmailProviderKind::Resend,
            "webhook" | "http" => EmailProviderKind::Webhook,
            "smtp" => EmailProviderKind::Smtp,
            _ => EmailProviderKind::Disabled,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            EmailProviderKind::Disabled => "disabled",
            EmailProviderKind::Resend => "resend",
            EmailProviderKind::Webhook => "webhook",
            EmailProviderKind::Smtp => "smtp",
        }
    }
}

/// E-mail provider configuration loaded from:
/// `NEXUS_EMAIL_PROVIDER` (`resend` | `webhook` | `smtp` | `disabled`),
/// `NEXUS_EMAIL_API_URL`, `NEXUS_EMAIL_API_KEY`, `NEXUS_EMAIL_FROM`,
/// and optionally `NEXUS_PASSWORD_RESET_URL` (link base, default `nexus://reset-password`).
#[derive(Clone, PartialEq, Eq)]
pub struct EmailConfig {
    pub provider: EmailProviderKind,
    pub api_url: Option<String>,
    pub api_key: Option<String>,
    pub from: String,
    pub reset_url_base: String,
}

impl std::fmt::Debug for EmailConfig {
    // Never print the API key.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmailConfig")
            .field("provider", &self.provider)
            .field("api_url", &self.api_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "***"))
            .field("from", &self.from)
            .field("reset_url_base", &self.reset_url_base)
            .finish()
    }
}

impl Default for EmailConfig {
    fn default() -> Self {
        Self::disabled()
    }
}

impl EmailConfig {
    pub fn disabled() -> Self {
        Self {
            provider: EmailProviderKind::Disabled,
            api_url: None,
            api_key: None,
            from: DEFAULT_EMAIL_FROM.to_string(),
            reset_url_base: DEFAULT_PASSWORD_RESET_URL.to_string(),
        }
    }

    pub fn from_env() -> Self {
        Self::from_lookup(|key| env::var(key).ok())
    }

    /// Builds the configuration from an arbitrary key lookup (testable without touching process env).
    pub fn from_lookup<F>(lookup: F) -> Self
    where
        F: Fn(&str) -> Option<String>,
    {
        let get = |key: &str| {
            lookup(key)
                .map(|v| v.trim().trim_matches('"').trim_matches('\'').trim().to_string())
                .filter(|v| !v.is_empty())
        };

        let provider = get("NEXUS_EMAIL_PROVIDER")
            .map(|p| EmailProviderKind::parse(&p))
            .unwrap_or(EmailProviderKind::Disabled);

        let mut api_url = get("NEXUS_EMAIL_API_URL");
        if api_url.is_none() && provider == EmailProviderKind::Resend {
            api_url = Some(DEFAULT_RESEND_API_URL.to_string());
        }

        let public_fqdn = get("PUBLIC_FQDN").or_else(|| get("PUBLIC_DOMAIN"));
        let reset_url_base = resolve_https_reset_url(
            get("NEXUS_PASSWORD_RESET_URL").as_deref(),
            public_fqdn.as_deref(),
        );

        Self {
            provider,
            api_url,
            api_key: get("NEXUS_EMAIL_API_KEY"),
            from: get("NEXUS_EMAIL_FROM").unwrap_or_else(|| DEFAULT_EMAIL_FROM.to_string()),
            reset_url_base,
        }
    }

    /// Returns a human-readable reason when the selected provider cannot deliver mail.
    /// Never includes secrets.
    pub fn delivery_problem(&self) -> Option<&'static str> {
        match self.provider {
            EmailProviderKind::Disabled => Some("NEXUS_EMAIL_PROVIDER=disabled: password recovery e-mails will NOT be sent"),
            EmailProviderKind::Smtp => Some("NEXUS_EMAIL_PROVIDER=smtp is not supported by this build; use 'resend' or 'webhook'. E-mails will NOT be sent"),
            EmailProviderKind::Resend if self.api_key.is_none() => Some("NEXUS_EMAIL_PROVIDER=resend requires NEXUS_EMAIL_API_KEY. E-mails will NOT be sent"),
            EmailProviderKind::Webhook if self.api_url.is_none() => Some("NEXUS_EMAIL_PROVIDER=webhook requires NEXUS_EMAIL_API_URL. E-mails will NOT be sent"),
            _ => None,
        }
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
