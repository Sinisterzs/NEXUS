use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use url::Url;

// Shared cancellation flag for active Google login flows
static OAUTH_CANCELLED: AtomicBool = AtomicBool::new(false);
static OAUTH_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn generate_pkce() -> Pkce {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);

    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let hash = hasher.finalize();
    let challenge = URL_SAFE_NO_PAD.encode(hash);

    Pkce {
        verifier,
        challenge,
    }
}

pub fn generate_random_token(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(&bytes)
}

pub struct GoogleAuthResult {
    pub code: String,
    pub code_verifier: String,
    pub redirect_uri: String,
    pub nonce: String,
}

/// Cancels any currently pending Google OAuth loopback listener
pub fn cancel_google_flow() {
    OAUTH_CANCELLED.store(true, Ordering::SeqCst);
}

/// Executes the full OAuth 2.0 PKCE desktop flow:
/// 1. Binds ephemeral loopback listener
/// 2. Opens default browser to Google Authorization endpoint
/// 3. Captures redirect callback with authorization code
/// 4. Validates state
/// 5. Returns code + PKCE verifier + redirect_uri for secure backend exchange
pub async fn execute_google_desktop_flow(client_id: &str) -> Result<GoogleAuthResult, String> {
    let _guard = OAUTH_LOCK.lock().await;
    OAUTH_CANCELLED.store(false, Ordering::SeqCst);

    let pkce = generate_pkce();
    let state = generate_random_token(32);
    let nonce = generate_random_token(32);

    // 1. Bind ephemeral loopback listener
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Falha ao iniciar listener local: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Falha ao obter porta local: {}", e))?
        .port();

    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    // 2. Build authorization URL using strict URL serialization
    let mut auth_url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|e| format!("Falha ao parsear URL base do Google: {}", e))?;

    auth_url
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", "openid email profile")
        .append_pair("state", &state)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "online");

    let auth_url_str = auth_url.to_string();

    // 3. Open in Windows default system browser (strictly validated HTTPS URL)
    if let Err(e) = crate::network::safe_open_url(&auth_url_str) {
        eprintln!("[NEXUS OAuth] Falha ao abrir navegador padrão: {}", e);
    }

    // 4. Wait for incoming redirect with timeout (120s) and cancellation checks
    let code_result = wait_for_callback(listener, &state).await?;

    Ok(GoogleAuthResult {
        code: code_result,
        code_verifier: pkce.verifier,
        redirect_uri,
        nonce,
    })
}

async fn wait_for_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    let timeout = Duration::from_secs(120);
    let start_time = std::time::Instant::now();

    loop {
        if OAUTH_CANCELLED.load(Ordering::SeqCst) {
            return Err("Login com Google cancelado pelo usuário.".to_string());
        }

        if start_time.elapsed() > timeout {
            return Err("Tempo limite excedido para login com Google (120s).".to_string());
        }

        // Accept with 500ms poll timeout to check cancellation
        let accept_future = listener.accept();
        tokio::select! {
            result = accept_future => {
                match result {
                    Ok((mut stream, _)) => {
                        let mut buffer = [0u8; 4096];
                        let read_res = stream.read(&mut buffer).await;
                        let bytes_read = match read_res {
                            Ok(n) => n,
                            Err(e) => return Err(format!("Falha ao ler requisição de callback: {}", e)),
                        };

                        let request_str = String::from_utf8_lossy(&buffer[..bytes_read]);
                        let first_line = request_str.lines().next().unwrap_or("");
                        let url_part = first_line.split_whitespace().nth(1).unwrap_or("/");

                        let parsed_url = match Url::parse(&format!("http://localhost{}", url_part)) {
                            Ok(u) => u,
                            Err(_) => {
                                send_response(&mut stream, 400, "URL de callback malformada").await;
                                return Err("Callback com URL inválida.".to_string());
                            }
                        };

                        let query_params: std::collections::HashMap<_, _> = parsed_url.query_pairs().into_owned().collect();

                        // Check if Google returned an error (e.g. user pressed cancel in Google page)
                        if let Some(err) = query_params.get("error") {
                            send_response(&mut stream, 200, "Login cancelado. Você pode fechar esta aba.").await;
                            return Err(format!("Google OAuth cancelado ou recusado: {}", err));
                        }

                        let received_state = query_params.get("state").map(|s| s.as_str()).unwrap_or("");
                        if received_state != expected_state {
                            send_response(&mut stream, 400, "State inválido. Possível tentativa de CSRF.").await;
                            return Err("State OAuth inválido ou divergente da solicitação.".to_string());
                        }

                        let code = match query_params.get("code") {
                            Some(c) => c.clone(),
                            None => {
                                send_response(&mut stream, 400, "Código de autorização ausente.").await;
                                return Err("Authorization code ausente na resposta do Google.".to_string());
                            }
                        };

                        // Send success HTML page to browser
                        send_response(
                            &mut stream,
                            200,
                            "Autenticação com o Google concluída! Você pode fechar esta aba e retornar ao NEXUS.",
                        )
                        .await;

                        return Ok(code);
                    }
                    Err(e) => {
                        return Err(format!("Erro no listener local: {}", e));
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(500)) => {
                // Poll tick
            }
        }
    }
}

async fn send_response(stream: &mut tokio::net::TcpStream, status_code: u16, message: &str) {
    let body = format!(
        r#"<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>NEXUS - Autenticação</title>
  <style>
    body {{
      background: #0f1015;
      color: #f3f4f6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }}
    .card {{
      background: #161820;
      border: 1px solid #282a36;
      border-radius: 16px;
      padding: 36px;
      text-align: center;
      max-width: 420px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.6);
    }}
    .badge {{
      background: rgba(220, 38, 38, 0.15);
      color: #f87171;
      padding: 4px 14px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      border: 1px solid rgba(220, 38, 38, 0.3);
    }}
    h1 {{
      font-size: 18px;
      font-weight: 700;
      margin: 18px 0 10px;
      color: #ffffff;
    }}
    p {{
      color: #9ca3af;
      font-size: 13px;
      line-height: 1.5;
      margin: 0;
    }}
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">NEXUS DESKTOP</span>
    <h1>Autenticação Google</h1>
    <p>{}</p>
  </div>
</body>
</html>"#,
        message
    );

    let status_line = match status_code {
        200 => "HTTP/1.1 200 OK",
        _ => "HTTP/1.1 400 Bad Request",
    };

    let response = format!(
        "{}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status_line,
        body.len(),
        body
    );

    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auth_url_contains_required_parameters() {
        let client_id = "test-client-id.apps.googleusercontent.com";
        let redirect_uri = "http://127.0.0.1:54321/callback";
        let pkce = generate_pkce();
        let state_val = generate_random_token(32);
        let nonce_val = generate_random_token(32);

        let mut auth_url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
        auth_url
            .query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("scope", "openid email profile")
            .append_pair("state", &state_val)
            .append_pair("nonce", &nonce_val)
            .append_pair("code_challenge", &pkce.challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("access_type", "online");

        let url_str = auth_url.to_string();

        assert!(
            url_str.contains("response_type=code"),
            "URL deve conter response_type=code"
        );
        assert!(url_str.contains("client_id=test-client-id.apps.googleusercontent.com"));
        assert!(url_str.contains("code_challenge_method=S256"));
        assert!(url_str.contains(&format!("state={}", state_val)));
        assert!(url_str.contains(&format!("nonce={}", nonce_val)));
        assert!(
            url_str.contains("scope=openid+email+profile")
                || url_str.contains("scope=openid%20email%20profile")
        );
    }
}
