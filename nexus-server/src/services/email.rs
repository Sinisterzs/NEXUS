//! Transactional e-mail abstraction (password recovery).
//!
//! Providers are selected by `NEXUS_EMAIL_PROVIDER` (see [`crate::config::EmailConfig`]).
//! SECURITY rules enforced here:
//! - Recipient addresses, message bodies (which contain raw reset tokens) and API keys
//!   are never logged nor included in error values or `Debug` output.
//! - API keys are only ever sent over HTTPS (plain HTTP is accepted for loopback relays only).
//! - HTTP redirects are not followed (no credential forwarding).
//!
//! This module only depends on `crate::config` plus external crates, so offline tests can
//! include it together with `src/config/mod.rs`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::config::{EmailConfig, EmailProviderKind};

const EMAIL_HTTP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, PartialEq, Eq)]
pub struct EmailMessage {
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
}

impl std::fmt::Debug for EmailMessage {
    // Recipient and bodies (which carry the raw reset token) are never printed.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmailMessage")
            .field("to", &"<redacted>")
            .field("subject", &self.subject)
            .field("text", &"<redacted>")
            .field("html", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmailError {
    /// Provider disabled or misconfigured (static reason, no secrets).
    NotDeliverable(&'static str),
    /// Refused to send credentials to a non-HTTPS, non-loopback endpoint.
    InsecureEndpoint,
    /// Network / serialization failure (URL stripped from the message).
    Transport(String),
    /// Provider answered with a non-success HTTP status.
    Rejected(u16),
}

impl std::fmt::Display for EmailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EmailError::NotDeliverable(reason) => write!(f, "e-mail not deliverable: {}", reason),
            EmailError::InsecureEndpoint => write!(f, "refusing to use a non-HTTPS e-mail endpoint"),
            EmailError::Transport(msg) => write!(f, "e-mail transport error: {}", msg),
            EmailError::Rejected(status) => write!(f, "e-mail provider rejected request with HTTP {}", status),
        }
    }
}

impl std::error::Error for EmailError {}

/// Returns true when `raw_url` may receive credentials: `https://`, or `http://` to a loopback host.
pub fn is_secure_endpoint(raw_url: &str) -> bool {
    let parsed = match url::Url::parse(raw_url.trim()) {
        Ok(u) => u,
        Err(_) => return false,
    };
    match parsed.scheme() {
        "https" => parsed.host_str().is_some(),
        "http" => match parsed.host() {
            Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        },
        _ => false,
    }
}

fn html_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Builds the recovery link: `<base>?token=<token>` (or `&token=` if the base already has a query).
pub fn build_reset_link(reset_url_base: &str, raw_token: &str) -> String {
    let base = reset_url_base.trim();
    let sep = if base.contains('?') { '&' } else { '?' };
    format!("{}{}token={}", base, sep, raw_token)
}

/// Renders the password recovery e-mail (pt-BR) containing the one-time code and link.
pub fn render_password_reset_email(
    to: &str,
    raw_token: &str,
    reset_url_base: &str,
    ttl_minutes: i64,
) -> EmailMessage {
    let link = build_reset_link(reset_url_base, raw_token);
    let subject = "NEXUS — Recuperação de senha".to_string();
    let text = format!(
        "Olá,\n\n\
         Recebemos uma solicitação para redefinir a senha da sua conta NEXUS.\n\n\
         Abra o link abaixo no aplicativo NEXUS ou cole o código de recuperação na tela \"Redefinir senha\":\n\n\
         Link: {link}\n\
         Código: {token}\n\n\
         Este código é de uso único e expira em {ttl} minutos. Ao redefinir a senha, todas as sessões ativas serão encerradas.\n\n\
         Se você não solicitou a recuperação, ignore este e-mail: sua senha atual continua válida.\n\n\
         — Equipe NEXUS\n",
        link = link,
        token = raw_token,
        ttl = ttl_minutes
    );
    let html = format!(
        "<!doctype html><html><body style=\"font-family:Arial,sans-serif;color:#111\">\
         <p>Olá,</p>\
         <p>Recebemos uma solicitação para redefinir a senha da sua conta <strong>NEXUS</strong>.</p>\
         <p><a href=\"{link}\">Redefinir minha senha</a></p>\
         <p>Ou cole este código de recuperação no aplicativo:</p>\
         <p style=\"font-family:monospace;font-size:14px;word-break:break-all;background:#f3f3f3;padding:8px\">{token}</p>\
         <p>Este código é de uso único e expira em {ttl} minutos. Ao redefinir a senha, todas as sessões ativas serão encerradas.</p>\
         <p>Se você não solicitou a recuperação, ignore este e-mail: sua senha atual continua válida.</p>\
         <p>— Equipe NEXUS</p></body></html>",
        link = html_escape(&link),
        token = html_escape(raw_token),
        ttl = ttl_minutes
    );
    EmailMessage {
        to: to.to_string(),
        subject,
        text,
        html,
    }
}

/// Shared outbox used by the in-memory provider (tests / local diagnostics).
pub type EmailOutbox = Arc<Mutex<Vec<EmailMessage>>>;

#[derive(Clone)]
pub struct EmailService {
    config: Arc<EmailConfig>,
    http: reqwest::Client,
    outbox: Option<EmailOutbox>,
}

impl EmailService {
    pub fn from_config(config: EmailConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(EMAIL_HTTP_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            config: Arc::new(config),
            http,
            outbox: None,
        }
    }

    pub fn from_env() -> Self {
        Self::from_config(EmailConfig::from_env())
    }

    /// In-memory provider: messages are captured in the returned outbox instead of being sent.
    pub fn in_memory() -> (Self, EmailOutbox) {
        let outbox: EmailOutbox = Arc::new(Mutex::new(Vec::new()));
        let mut svc = Self::from_config(EmailConfig::disabled());
        svc.outbox = Some(outbox.clone());
        (svc, outbox)
    }

    pub fn config(&self) -> &EmailConfig {
        &self.config
    }

    pub fn provider(&self) -> EmailProviderKind {
        self.config.provider
    }

    pub fn is_deliverable(&self) -> bool {
        self.outbox.is_some() || self.config.delivery_problem().is_none()
    }

    /// Logs (once, at startup) whether recovery e-mails can be delivered. No secrets logged.
    pub fn log_startup_status(&self) {
        if self.outbox.is_some() {
            tracing::info!(target: "nexus_server::email", provider = "in-memory", "E-mail service ready");
            return;
        }
        match self.config.delivery_problem() {
            None => tracing::info!(
                target: "nexus_server::email",
                provider = self.config.provider.as_str(),
                "E-mail service ready for password recovery"
            ),
            Some(reason) => tracing::warn!(
                target: "nexus_server::email",
                provider = self.config.provider.as_str(),
                "{}",
                reason
            ),
        }
    }

    pub async fn send(&self, message: &EmailMessage) -> Result<(), EmailError> {
        if let Some(outbox) = &self.outbox {
            match outbox.lock() {
                Ok(mut guard) => guard.push(message.clone()),
                Err(poisoned) => poisoned.into_inner().push(message.clone()),
            }
            return Ok(());
        }

        if let Some(reason) = self.config.delivery_problem() {
            return Err(EmailError::NotDeliverable(reason));
        }

        let url = self
            .config
            .api_url
            .as_deref()
            .ok_or(EmailError::NotDeliverable("missing NEXUS_EMAIL_API_URL"))?;
        if !is_secure_endpoint(url) {
            return Err(EmailError::InsecureEndpoint);
        }

        let payload = match self.config.provider {
            EmailProviderKind::Resend => serde_json::json!({
                "from": self.config.from,
                "to": [message.to],
                "subject": message.subject,
                "text": message.text,
                "html": message.html,
            }),
            EmailProviderKind::Webhook => serde_json::json!({
                "type": "password_reset",
                "from": self.config.from,
                "to": message.to,
                "subject": message.subject,
                "text": message.text,
                "html": message.html,
            }),
            // Unreachable: rejected by delivery_problem().
            EmailProviderKind::Disabled | EmailProviderKind::Smtp => {
                return Err(EmailError::NotDeliverable("provider cannot send"))
            }
        };

        let mut request = self.http.post(url).json(&payload);
        if let Some(key) = self.config.api_key.as_deref() {
            request = request.bearer_auth(key);
        }

        let response = request
            .send()
            .await
            .map_err(|e| EmailError::Transport(e.without_url().to_string()))?;

        let status = response.status();
        if !status.is_success() {
            // Response body is intentionally discarded: providers may echo the recipient.
            return Err(EmailError::Rejected(status.as_u16()));
        }
        Ok(())
    }
}
