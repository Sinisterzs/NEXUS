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

/// Builds the recovery link used in e-mails:
/// - For `http://` and `https://` bridge URLs without an existing query string, uses a URI
///   fragment (`<base>#token=<token>`) so that webmail clients (like Gmail) keep the `https://`
///   link clickable while browsers never transmit the single-use token in HTTP request lines,
///   proxy logs, or `Referer` headers.
/// - For custom desktop schemes (`nexus://reset-password`) or URLs that already contain `?`,
///   uses `<base>?token=<token>` (or `&token=<token>`).
pub fn build_reset_link(reset_url_base: &str, raw_token: &str) -> String {
    let base = reset_url_base.trim();
    let lower = base.to_ascii_lowercase();
    let is_http = lower.starts_with("https://") || lower.starts_with("http://");

    if is_http && !base.contains('?') {
        let sep = if base.ends_with('#') {
            ""
        } else if base.contains('#') {
            "&"
        } else {
            "#"
        };
        format!("{}{}token={}", base, sep, raw_token)
    } else {
        let sep = if base.ends_with('?') || base.ends_with('&') {
            ""
        } else if base.contains('?') {
            "&"
        } else {
            "?"
        };
        format!("{}{}token={}", base, sep, raw_token)
    }
}

/// Builds the direct desktop protocol deep link (`nexus://reset-password?token=<token>`).
pub fn build_deep_link(raw_token: &str) -> String {
    format!(
        "{}?token={}",
        crate::config::DEFAULT_DEEP_LINK_RESET_URL,
        raw_token.trim()
    )
}

/// Content-Security-Policy applied to the static HTTPS password recovery bridge page.
/// Forbids all network connections (`connect-src 'none'`), forms, frames, and third-party assets.
pub const PASSWORD_RESET_BRIDGE_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

/// Self-contained static HTML bridge page served at `GET /reset-password`.
/// - Reads the recovery token from `#token=...` (or `?token=...`) strictly in the browser.
/// - Immediately scrubs the token from the URL bar and browser history via `history.replaceState`.
/// - Provides a primary button to launch the desktop app via `nexus://reset-password?token=...`
///   and a manual fallback to copy the 64-character one-time code.
/// - Zero external scripts, zero analytics, zero network requests.
pub fn password_reset_bridge_html() -> &'static str {
    r#"<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <title>NEXUS — Recuperação de Senha</title>
  <style>
    :root {
      color-scheme: dark;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: radial-gradient(circle at top, #1a1325 0%, #090a0f 65%);
      color: #f4f4f6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .card {
      width: 100%;
      max-width: 440px;
      background: #12131c;
      border: 1px solid #26293a;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
    }
    .bar {
      height: 4px;
      background: linear-gradient(90deg, #e11d48, #fb7185, #e11d48);
    }
    .content {
      padding: 28px 24px 24px;
      text-align: center;
    }
    .logo {
      width: 48px;
      height: 48px;
      margin: 0 auto 14px;
      border-radius: 12px;
      background: #181a26;
      border: 1px solid #2e3247;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      font-size: 20px;
      color: #e11d48;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 18px;
      font-weight: 700;
    }
    p {
      margin: 0 0 18px;
      font-size: 13px;
      line-height: 1.55;
      color: #a1a6bc;
    }
    .btn-primary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding: 12px 18px;
      border-radius: 12px;
      background: #e11d48;
      color: #ffffff;
      font-size: 13px;
      font-weight: 700;
      text-decoration: none;
      border: none;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .btn-primary:hover {
      background: #be123c;
    }
    .divider {
      margin: 20px 0 16px;
      border-top: 1px solid #232637;
      position: relative;
    }
    .divider span {
      position: relative;
      top: -9px;
      background: #12131c;
      padding: 0 10px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #7b819a;
    }
    .code-box {
      background: #0b0c12;
      border: 1px solid #26293a;
      border-radius: 12px;
      padding: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      color: #e4e6f1;
      word-break: break-all;
      user-select: all;
      margin-bottom: 10px;
    }
    .btn-secondary {
      width: 100%;
      padding: 10px 14px;
      border-radius: 10px;
      background: #1a1c29;
      border: 1px solid #2e3247;
      color: #e4e6f1;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-secondary:hover {
      background: #232638;
    }
    .notice {
      margin-top: 16px;
      font-size: 11px;
      color: #7b819a;
      line-height: 1.45;
    }
    .error-box {
      display: none;
      background: rgba(225, 29, 72, 0.1);
      border: 1px solid rgba(225, 29, 72, 0.35);
      color: #fda4af;
      border-radius: 12px;
      padding: 14px;
      font-size: 12px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="bar"></div>
    <div class="content">
      <div class="logo">N</div>
      <h1>Redefinir senha no NEXUS</h1>
      <div id="valid-section">
        <p>Clique no botão abaixo para abrir o aplicativo <strong>NEXUS</strong> e redefinir sua senha.</p>
        <a id="open-nexus-app" class="btn-primary" href="nexus://reset-password">Abrir no aplicativo NEXUS</a>

        <div class="divider"><span>ou insira o código manualmente</span></div>
        <p style="margin-bottom:10px;font-size:12px;">
          Se o aplicativo não abrir automaticamente, copie o código de uso único abaixo e cole no campo
          <strong>"Código ou link de recuperação"</strong> na tela de recuperação do NEXUS:
        </p>
        <div id="manual-token-value" class="code-box"></div>
        <button id="copy-token-btn" type="button" class="btn-secondary">Copiar código de recuperação</button>
        <p class="notice">
          Este código é de uso único e expira em 15 minutos. Ao redefinir a senha, todas as sessões anteriores serão encerradas.
        </p>
      </div>

      <div id="missing-section" class="error-box">
        Nenhum código de recuperação válido foi encontrado neste link. Copie o código diretamente do e-mail recebido ou solicite um novo código na tela de login do aplicativo NEXUS.
      </div>
    </div>
  </div>

  <script>
    (function () {
      function readToken() {
        var hash = window.location.hash ? window.location.hash.substring(1) : "";
        var search = window.location.search ? window.location.search.substring(1) : "";
        var fromHash = new URLSearchParams(hash).get("token");
        var fromSearch = new URLSearchParams(search).get("token");
        var raw = (fromHash || fromSearch || "").trim();
        if (!raw || raw.length > 256 || !/^[A-Za-z0-9._~+-]{6,256}$/.test(raw)) {
          return "";
        }
        return raw;
      }

      var token = readToken();

      // Scrub the token from the address bar and browser history immediately.
      if (window.history && typeof window.history.replaceState === "function") {
        window.history.replaceState(null, document.title, window.location.pathname);
      }

      var validSection = document.getElementById("valid-section");
      var missingSection = document.getElementById("missing-section");
      var openBtn = document.getElementById("open-nexus-app");
      var codeBox = document.getElementById("manual-token-value");
      var copyBtn = document.getElementById("copy-token-btn");

      if (!token) {
        validSection.style.display = "none";
        missingSection.style.display = "block";
        return;
      }

      var deepLink = "nexus://reset-password?token=" + encodeURIComponent(token);
      openBtn.setAttribute("href", deepLink);
      codeBox.textContent = token;

      copyBtn.addEventListener("click", function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(token).then(function () {
            copyBtn.textContent = "Código copiado!";
            setTimeout(function () {
              copyBtn.textContent = "Copiar código de recuperação";
            }, 2500);
          });
        }
      });

      // Attempt to launch the desktop protocol automatically after rendering the fallback UI.
      setTimeout(function () {
        window.location.href = deepLink;
      }, 150);
    })();
  </script>
</body>
</html>"#
}

/// Renders the password recovery e-mail (pt-BR) containing the clickable HTTPS link and one-time code.
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
         Abra o link abaixo para redefinir sua senha no aplicativo NEXUS ou cole o código de recuperação na tela \"Redefinir senha\":\n\n\
         Link: {link}\n\
         Código: {token}\n\n\
         Este código é de uso único e expira em {ttl} minutos. Ao redefinir a senha, todas as sessões ativas serão encerradas.\n\n\
         Se você não solicitou a recuperação, ignore este e-mail: sua senha atual continua válida.\n\n\
         — Equipe NEXUS\n",
        link = link,
        token = raw_token,
        ttl = ttl_minutes
    );
    let escaped_link = html_escape(&link);
    let escaped_token = html_escape(raw_token);
    let html = format!(
        "<!doctype html><html><body style=\"font-family:Arial,sans-serif;color:#111;line-height:1.5\">\
         <p>Olá,</p>\
         <p>Recebemos uma solicitação para redefinir a senha da sua conta <strong>NEXUS</strong>.</p>\
         <p style=\"margin:20px 0\">\
           <a href=\"{link}\" target=\"_blank\" rel=\"noopener noreferrer\" style=\"display:inline-block;background-color:#e11d48;color:#ffffff;font-weight:bold;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px\">Redefinir minha senha</a>\
         </p>\
         <p style=\"font-size:12px;color:#444\">Se o botão acima não funcionar no seu cliente de e-mail, acesse diretamente:<br>\
           <a href=\"{link}\" target=\"_blank\" rel=\"noopener noreferrer\" style=\"color:#e11d48;word-break:break-all\">{link}</a>\
         </p>\
         <p>Ou copie e cole este código de recuperação diretamente no aplicativo NEXUS:</p>\
         <p style=\"font-family:monospace;font-size:14px;word-break:break-all;background:#f3f3f3;padding:10px;border-radius:6px;border:1px solid #ddd\">{token}</p>\
         <p>Este código é de uso único e expira em {ttl} minutos. Ao redefinir a senha, todas as sessões ativas serão encerradas.</p>\
         <p>Se você não solicitou a recuperação, ignore este e-mail: sua senha atual continua válida.</p>\
         <p>— Equipe NEXUS</p></body></html>",
        link = escaped_link,
        token = escaped_token,
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
