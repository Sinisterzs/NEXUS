use keyring::Entry;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

static ACTIVE_USER_ID: OnceLock<Mutex<Option<String>>> = OnceLock::new();

pub fn set_active_user_id(user_id: Option<String>) {
    let lock = ACTIVE_USER_ID.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = lock.lock() {
        *guard = user_id;
    }
}

pub fn get_active_user_id() -> Option<String> {
    let lock = ACTIVE_USER_ID.get_or_init(|| Mutex::new(None));
    lock.lock().ok().and_then(|g| g.clone())
}

/// Validates and resolves `account_id` safely.
/// - If an authenticated session is active in memory (`ACTIVE_USER_ID`), any provided `account_id`
///   must match the active session's user ID (preventing cross-account spoofing), and if omitted
///   it is derived directly from `ACTIVE_USER_ID`.
/// - If no authenticated session is active, `provided` is validated against safe identifier rules
///   (and `'legacy_unassigned'` is always rejected for direct queries).
pub fn resolve_and_validate_account_id(
    provided: Option<&str>,
    allow_offline_demo: bool,
) -> Result<String, String> {
    let clean_provided = provided.map(|s| s.trim()).filter(|s| !s.is_empty());

    if let Some( provided_str ) = clean_provided {
        if provided_str == "legacy_unassigned" {
            return Err("Acesso negado: registros em quarentena (legacy_unassigned) não podem ser acessados diretamente.".to_string());
        }
        if !allow_offline_demo && provided_str == "offline_demo" {
            return Err("Acesso negado: conta offline_demo não permitida em operação autenticada.".to_string());
        }
        if provided_str.len() > 64
            || !provided_str
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("Formato de account_id inválido.".to_string());
        }
    }

    if let Some(active_uid) = get_active_user_id() {
        if let Some(provided_str) = clean_provided {
            if provided_str != active_uid {
                return Err(
                    "Acesso negado: account_id incompatível com a sessão autenticada ativa."
                        .to_string(),
                );
            }
        }
        return Ok(active_uid);
    }

    match clean_provided {
        Some(p) => Ok(p.to_string()),
        None => {
            if allow_offline_demo {
                Ok("offline_demo".to_string())
            } else {
                Err("Nenhuma conta autenticada ativa ou identificada para a operação.".to_string())
            }
        }
    }
}

fn service_name() -> &'static str {
    if crate::lab::enabled() {
        return if crate::lab::profile() == "A" { "nexus_testlab_A" } else { "nexus_testlab_B" };
    }
    "nexus_desktop"
}

static MOCK_KEYRING: std::sync::RwLock<Option<std::collections::HashMap<String, String>>> =
    std::sync::RwLock::new(None);

fn mock_keyring_get(key: &str) -> Option<String> {
    let guard = MOCK_KEYRING.read().ok()?;
    guard.as_ref().and_then(|m| m.get(key).cloned())
}

fn mock_keyring_set(key: &str, val: String) {
    if let Ok(mut guard) = MOCK_KEYRING.write() {
        if guard.is_none() {
            *guard = Some(std::collections::HashMap::new());
        }
        if let Some(ref mut m) = *guard {
            m.insert(key.to_string(), val);
        }
    }
}

fn mock_keyring_delete(key: &str) {
    if let Ok(mut guard) = MOCK_KEYRING.write() {
        if let Some(ref mut m) = *guard {
            m.remove(key);
        }
    }
}

pub fn get_session_user_key() -> &'static str {
    if crate::lab::enabled() { return "session_token_lab"; }
    if crate::is_test_environment() {
        return "session_token_isolated_test";
    }
    if let Ok(key) = std::env::var("NEXUS_KEYRING_KEY") {
        if key == "test_homologation" {
            return "session_token_homologation_rc1";
        }
    }
    "session_token"
}
pub const DEFAULT_API_BASE: &str = "https://nexus-api.dynv6.net";
const DEFAULT_GOOGLE_CLIENT_ID: &str =
    "964906993797-r3v176v8d8b88fo0r9bethub6dr4cre2.apps.googleusercontent.com";

pub fn get_google_client_id() -> String {
    // 1. Runtime override via env var (if user explicitly specifies in environment)
    if let Ok(val) = std::env::var("GOOGLE_CLIENT_ID") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    // 2. Compile-time embedded default resolved by build.rs from nexus.config.json or nexus-server/.env
    if let Some(val) = option_env!("NEXUS_DEFAULT_GOOGLE_CLIENT_ID") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    // 3. Fallback constant
    DEFAULT_GOOGLE_CLIENT_ID.to_string()
}

pub fn get_default_api_base() -> String {
    if crate::lab::enabled() { return crate::lab::API.into(); }
    if let Some(val) = option_env!("NEXUS_DEFAULT_API_URL") {
        if let Ok(valid) = crate::network::validate_server_url(val) {
            return valid;
        }
    }
    DEFAULT_API_BASE.to_string()
}

pub fn get_api_base() -> String {
    if crate::lab::enabled() { return crate::lab::API.into(); }
    // 0. Dynamic runtime override (set by NetworkManager, already validated)
    if let Some(dyn_url) = crate::network::get_dynamic_api_base() {
        if let Ok(valid) = crate::network::validate_server_url(&dyn_url) {
            return valid;
        }
    }
    // 1. Persisted server URL from previous configuration or successful Tailscale discovery
    if let Some(persisted_url) = crate::network::load_persisted_server_url() {
        if let Ok(valid) = crate::network::validate_server_url(&persisted_url) {
            return valid;
        }
    }
    // 2. Runtime override via NEXUS_API_URL or NEXUS_API_BASE
    if let Ok(val) = std::env::var("NEXUS_API_URL").or_else(|_| std::env::var("NEXUS_API_BASE")) {
        if let Ok(valid) = crate::network::validate_server_url(&val) {
            return valid;
        }
    }
    // 3. Compile-time embedded default from build.rs
    if let Some(val) = option_env!("NEXUS_DEFAULT_API_URL") {
        if let Ok(valid) = crate::network::validate_server_url(val) {
            return valid;
        }
    }
    // 4. Default fallback
    DEFAULT_API_BASE.to_string()
}

#[tauri::command]
pub fn get_oauth_config() -> serde_json::Value {
    serde_json::json!({
        "google_client_id": get_google_client_id(),
        "api_url": get_api_base()
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUserProfile {
    pub id: String,
    pub username: String,
    pub email: String,
    #[serde(alias = "display_name")]
    pub display_name: String,
    #[serde(alias = "avatar_url")]
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub status: String,
    #[serde(alias = "custom_status")]
    pub custom_status: Option<String>,
    pub activity: Option<String>,
    #[serde(alias = "has_password")]
    pub has_password: bool,
    #[serde(alias = "has_google")]
    pub has_google: bool,
    #[serde(alias = "created_at")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
struct AuthApiResponse {
    pub user: AuthUserProfile,
    pub session_token: String,
}

#[derive(Debug, Deserialize)]
struct ApiErrorDetail {
    #[allow(dead_code)]
    pub code: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct ApiErrorResponse {
    pub error: ApiErrorDetail,
}

fn format_api_error(err: ApiErrorResponse) -> String {
    if !err.error.code.trim().is_empty() {
        format!("{}: {}", err.error.code.trim(), err.error.message.trim())
    } else {
        err.error.message
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSessionCredential {
    pub token: String,
    pub server_origin: String,
    #[serde(default)]
    pub server_id: Option<String>,
}

static AUTHENTICATED_SERVER_ORIGIN: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static AUTHENTICATED_SERVER_IDENTITY: OnceLock<Mutex<Option<String>>> = OnceLock::new();

pub fn record_authenticated_server_identity(origin: &str, server_id: &str) {
    let norm = origin.trim().trim_end_matches('/').to_lowercase();
    let lock_origin = AUTHENTICATED_SERVER_ORIGIN.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = lock_origin.lock() {
        *guard = Some(norm);
    }
    let lock_id = AUTHENTICATED_SERVER_IDENTITY.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = lock_id.lock() {
        *guard = Some(server_id.trim().to_string());
    }
}

pub fn record_authenticated_server_origin(origin: &str) {
    let norm_origin = origin.trim().trim_end_matches('/').to_lowercase();
    let lock_origin = AUTHENTICATED_SERVER_ORIGIN.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = lock_origin.lock() {
        *guard = Some(norm_origin);
    }
}

pub fn clear_authenticated_server_origin() {
    let lock_origin = AUTHENTICATED_SERVER_ORIGIN.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = lock_origin.lock() {
        *guard = None;
    }
    let lock_id = AUTHENTICATED_SERVER_IDENTITY.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = lock_id.lock() {
        *guard = None;
    }
}

pub fn get_authenticated_server_origin() -> Option<String> {
    let lock_origin = AUTHENTICATED_SERVER_ORIGIN.get_or_init(|| Mutex::new(None));
    lock_origin.lock().ok()?.clone()
}

pub fn get_authenticated_server_identity() -> Option<String> {
    let lock_id = AUTHENTICATED_SERVER_IDENTITY.get_or_init(|| Mutex::new(None));
    lock_id.lock().ok()?.clone()
}

pub fn is_server_origin_authenticated(origin: &str) -> bool {
    let norm = origin.trim().trim_end_matches('/').to_lowercase();
    let auth_origin = get_authenticated_server_origin();
    let auth_id = get_authenticated_server_identity();
    auth_origin.as_deref() == Some(&norm) && auth_id.is_some()
}

/// Securely stores session token in the OS Keyring (Windows Credential Manager / DPAPI)
/// bound to the current server origin
pub fn save_secure_token(token: &str) -> Result<(), String> {
    let current_origin = get_api_base().trim().trim_end_matches('/').to_lowercase();
    save_secure_token_for_origin(token, &current_origin)
}

/// Securely stores session token in the OS Keyring explicitly bound to a target server origin
pub fn save_secure_token_for_origin(token: &str, origin: &str) -> Result<(), String> {
    let norm_origin = origin.trim().trim_end_matches('/').to_lowercase();
    let auth_id = get_authenticated_server_identity();
    if let Some(ref id) = auth_id {
        record_authenticated_server_identity(&norm_origin, id);
    } else {
        record_authenticated_server_origin(&norm_origin);
    }

    let cred = StoredSessionCredential {
        token: token.trim().to_string(),
        server_origin: norm_origin,
        server_id: auth_id,
    };
    let payload = serde_json::to_string(&cred)
        .map_err(|e| format!("Falha ao serializar credencial de sessão: {}", e))?;

    if crate::is_test_environment() {
        mock_keyring_set(get_session_user_key(), payload);
        return Ok(());
    }

    let entry = Entry::new(service_name(), get_session_user_key())
        .map_err(|e| format!("Falha ao acessar Windows Credential Manager: {}", e))?;
    entry
        .set_password(&payload)
        .map_err(|e| format!("Falha ao salvar no Windows Credential Manager: {}", e))?;
    Ok(())
}

/// Retrieves stored session token from OS Keyring, enforcing persistent origin binding to prevent token leakage
pub fn get_secure_token() -> Option<String> {
    let current_origin = get_api_base().trim().trim_end_matches('/').to_lowercase();

    let auth_origin = get_authenticated_server_origin();
    let auth_id = get_authenticated_server_identity();

    // Fast in-memory origin check
    if let Some(ref auth_orig) = auth_origin {
        if auth_orig != &current_origin {
            eprintln!(
                "[Auth] Token retido por segurança: servidor atual ({}) difere do servidor autenticado em memória ({}).",
                current_origin, auth_orig
            );
            return None;
        }
    }

    let raw_payload = if crate::is_test_environment() {
        mock_keyring_get(get_session_user_key())?
    } else {
        let entry = Entry::new(service_name(), get_session_user_key()).ok()?;
        entry.get_password().ok()?
    };
    let trimmed = raw_payload.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Try parsing as structured credential with persisted server origin
    if let Ok(cred) = serde_json::from_str::<StoredSessionCredential>(trimmed) {
        let stored_origin = cred.server_origin.trim().trim_end_matches('/').to_lowercase();
        if stored_origin != current_origin {
            let is_in_memory_verified = auth_origin.as_deref() == Some(&current_origin) && auth_id.is_some();

            let is_stored_authorized = url::Url::parse(&stored_origin)
                .ok()
                .and_then(|u| u.host_str().map(crate::network::is_authorized_server_host))
                .unwrap_or(false);
            let is_current_authorized = url::Url::parse(&current_origin)
                .ok()
                .and_then(|u| u.host_str().map(crate::network::is_authorized_server_host))
                .unwrap_or(false);

            // Server identity consistency: MUST match the server_id where the token was generated
            let is_same_server_identity = match (&cred.server_id, &auth_id) {
                (Some(stored_id), Some(curr_id)) => stored_id == curr_id,
                (None, Some(curr_id)) => {
                    // Legacy credential without server_id: check persisted approved_server_id
                    crate::network::load_persisted_network_config()
                        .and_then(|c| c.approved_server_id)
                        .map(|app_id| &app_id == curr_id)
                        .unwrap_or(true)
                }
                _ => false,
            };

            if is_in_memory_verified && is_stored_authorized && is_current_authorized && is_same_server_identity {
                eprintln!(
                    "[Auth] Migrando token para servidor Tailscale com identidade criptográfica comprovada ({}) a partir de ({}).",
                    current_origin, stored_origin
                );
                let _ = save_secure_token_for_origin(&cred.token, &current_origin);
                return Some(cred.token);
            }

            eprintln!(
                "[Auth] Token retido por segurança: servidor atual ({}) difere do servidor de origem autenticado ({}) ou identidade não coincide.",
                current_origin, stored_origin
            );
            return None;
        }
        record_authenticated_server_origin(&stored_origin);
        return Some(cred.token);
    }

    // Backwards compatibility for legacy unformatted tokens:
    // A legacy token has no stored origin. It can ONLY be accepted if the current origin matches
    // either the in-memory recorded origin OR the compile-time default server origin.
    // It must NEVER be delivered to an arbitrary new or changed dynamic address on cold start!
    let default_origin = get_default_api_base().trim().trim_end_matches('/').to_lowercase();
    if let Some(ref auth_orig) = auth_origin {
        if auth_orig != &current_origin {
            eprintln!(
                "[Auth] Token legado retido por segurança: servidor atual ({}) difere do servidor autenticado em memória ({}).",
                current_origin, auth_orig
            );
            return None;
        }
    } else if current_origin != default_origin {
        eprintln!(
            "[Auth] Token legado retido por segurança: servidor atual ({}) difere da origem padrão confiável ({}) após cold start. Reautentique-se neste servidor.",
            current_origin, default_origin
        );
        return None;
    }

    record_authenticated_server_origin(&current_origin);
    // Automatically migrate legacy token to structured format for future runs
    let _ = save_secure_token_for_origin(trimmed, &current_origin);
    Some(trimmed.to_string())
}

/// Deletes stored session token from OS Keyring
pub fn delete_secure_token() -> Result<(), String> {
    clear_authenticated_server_origin();
    if crate::is_test_environment() {
        mock_keyring_delete(get_session_user_key());
        return Ok(());
    }
    if crate::lab::enabled() {
        let entry = Entry::new(service_name(), get_session_user_key()).map_err(|e| e.to_string())?;
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        };
    }
    if let Ok(entry) = Entry::new(service_name(), get_session_user_key()) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

/// Checks whether a valid session token exists in OS Keyring
#[tauri::command]
pub fn auth_has_stored_session() -> bool {
    get_secure_token().is_some()
}

#[tauri::command]
pub async fn auth_register(
    username: String,
    email: String,
    password: String,
    display_name: Option<String>,
) -> Result<AuthUserProfile, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/v1/auth/register", get_api_base());

    let payload = serde_json::json!({
        "username": username.trim(),
        "email": email.trim().to_lowercase(),
        "password": password,
        "display_name": display_name
    });

    let resp = match client.post(&url).json(&payload).send().await {
        Ok(r) => r,
        Err(e) => return Err(format!("Falha ao conectar ao servidor NEXUS: {}", e)),
    };

    let status = resp.status();
    if status == StatusCode::CREATED {
        let auth_res: AuthApiResponse = resp
            .json()
            .await
            .map_err(|e| format!("Falha ao decodificar resposta do servidor: {}", e))?;

        // Securely persist token into Windows Credential Manager
        save_secure_token(&auth_res.session_token)?;
        record_authenticated_server_origin(&get_api_base());
        set_active_user_id(Some(auth_res.user.id.clone()));

        Ok(auth_res.user)
    } else {
        let err: ApiErrorResponse = resp
            .json()
            .await
            .map_err(|_| "Erro desconhecido retornado pelo servidor".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn auth_login(login: String, password: String) -> Result<AuthUserProfile, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/v1/auth/login", get_api_base());

    let payload = serde_json::json!({
        "login": login.trim(),
        "password": password
    });

    let resp = match client.post(&url).json(&payload).send().await {
        Ok(r) => r,
        Err(e) => return Err(format!("Falha de conexão com o servidor NEXUS: {}", e)),
    };

    let status = resp.status();
    if status == StatusCode::OK {
        let auth_res: AuthApiResponse = resp
            .json()
            .await
            .map_err(|e| format!("Falha ao decodificar resposta do servidor: {}", e))?;

        // Securely persist token into Windows Credential Manager
        save_secure_token(&auth_res.session_token)?;
        record_authenticated_server_origin(&get_api_base());
        set_active_user_id(Some(auth_res.user.id.clone()));

        Ok(auth_res.user)
    } else {
        let err: ApiErrorResponse = resp
            .json()
            .await
            .map_err(|_| "Credenciais inválidas. Verifique seu login e senha.".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn auth_logout() -> Result<(), String> {
    // 1. Immediately revoke microphone consent, active user context, and purge local keyring credential first
    crate::reset_mic_consent();
    set_active_user_id(None);
    let token_opt = get_secure_token();
    delete_secure_token()?;

    // 2. Attempt remote session revocation with bounded timeout (best effort)
    if let Some(token) = token_opt {
        if let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
        {
            let url = format!("{}/v1/auth/logout", get_api_base());
            let _ = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", token))
                .send()
                .await;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn auth_restore_session() -> Result<Option<AuthUserProfile>, String> {
    let token = match get_secure_token() {
        Some(t) => t,
        None => return Ok(None),
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Err(format!(
                "NETWORK_ERROR: Falha ao inicializar cliente HTTP ({})",
                e
            ))
        }
    };

    let url = format!("{}/v1/users/me", get_api_base());

    let resp = match client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            // Server offline or network timeout: preserve token in keyring so session resumes when server is back
            return Err(format!("NETWORK_ERROR: Servidor indisponível ({})", e));
        }
    };

    let status = resp.status();
    if status == StatusCode::OK {
        let user: AuthUserProfile = resp
            .json()
            .await
            .map_err(|e| format!("Falha ao decodificar perfil retornado: {}", e))?;
        record_authenticated_server_origin(&get_api_base());
        set_active_user_id(Some(user.id.clone()));
        Ok(Some(user))
    } else if status == StatusCode::UNAUTHORIZED {
        // Token confirmed expired or revoked by backend -> delete from keyring
        set_active_user_id(None);
        let _ = delete_secure_token();
        Ok(None)
    } else {
        // Transient 5xx error or server error: preserve token, do NOT delete from keyring
        Err(format!(
            "NETWORK_ERROR: Servidor indisponível (HTTP {})",
            status
        ))
    }
}

#[tauri::command]
pub async fn auth_check_backend() -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/health", get_api_base());
    match client.get(&url).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn auth_login_google() -> Result<AuthUserProfile, String> {
    if crate::lab::enabled() { return Err("Use local lab accounts".into()); }
    let client_id = get_google_client_id();

    let auth_res = crate::oauth::execute_google_desktop_flow(&client_id).await?;

    let client = reqwest::Client::new();
    let url = format!("{}/v1/auth/google", get_api_base());

    let payload = serde_json::json!({
        "code": auth_res.code,
        "code_verifier": auth_res.code_verifier,
        "redirect_uri": auth_res.redirect_uri,
        "nonce": auth_res.nonce
    });

    let resp = match client.post(&url).json(&payload).send().await {
        Ok(r) => r,
        Err(e) => return Err(format!("Falha de conexão com o servidor NEXUS: {}", e)),
    };

    let status = resp.status();
    if status.is_success() {
        let auth_data: AuthApiResponse = resp
            .json()
            .await
            .map_err(|e| format!("Resposta inválida do backend NEXUS: {}", e))?;

        // Securely persist token into Windows Credential Manager
        save_secure_token(&auth_data.session_token)?;
        record_authenticated_server_origin(&get_api_base());
        set_active_user_id(Some(auth_data.user.id.clone()));

        Ok(auth_data.user)
    } else {
        let err: ApiErrorResponse = resp
            .json()
            .await
            .map_err(|_| "Falha na autenticação com o Google".to_string())?;
        Err(format_api_error(err))
    }
}

#[tauri::command]
pub async fn auth_link_google() -> Result<String, String> {
    if crate::lab::enabled() { return Err("Use local lab accounts".into()); }
    let session_token = get_secure_token()
        .ok_or_else(|| "Nenhuma sessão ativa encontrada para vincular conta.".to_string())?;

    let client_id = get_google_client_id();

    let auth_res = crate::oauth::execute_google_desktop_flow(&client_id).await?;

    let client = reqwest::Client::new();
    let url = format!("{}/v1/auth/google/link", get_api_base());

    let payload = serde_json::json!({
        "code": auth_res.code,
        "code_verifier": auth_res.code_verifier,
        "redirect_uri": auth_res.redirect_uri,
        "nonce": auth_res.nonce
    });

    let resp = match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", session_token))
        .json(&payload)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return Err(format!("Falha ao conectar com o backend NEXUS: {}", e)),
    };

    if resp.status().is_success() {
        let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let msg = body["message"]
            .as_str()
            .unwrap_or("Conta Google vinculada com sucesso!")
            .to_string();
        Ok(msg)
    } else {
        let err: ApiErrorResponse = resp
            .json()
            .await
            .map_err(|_| "Falha ao vincular conta Google".to_string())?;
        Err(format_api_error(err))
    }
}

#[tauri::command]
pub async fn auth_unlink_google() -> Result<(), String> {
    let session_token =
        get_secure_token().ok_or_else(|| "Nenhuma sessão ativa encontrada.".to_string())?;

    let client = reqwest::Client::new();
    let url = format!("{}/v1/auth/google", get_api_base());

    let resp = match client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", session_token))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return Err(format!("Falha ao conectar com o backend NEXUS: {}", e)),
    };

    if resp.status().is_success() {
        Ok(())
    } else {
        let err: ApiErrorResponse = resp
            .json()
            .await
            .map_err(|_| "Falha ao desvincular conta Google".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn auth_get_me() -> Result<Option<AuthUserProfile>, String> {
    auth_restore_session().await
}

#[tauri::command]
pub async fn auth_update_profile(
    username: Option<String>,
    display_name: Option<String>,
    bio: Option<String>,
    custom_status: Option<String>,
) -> Result<AuthUserProfile, String> {
    let session_token =
        get_secure_token().ok_or_else(|| "Nenhuma sessão ativa encontrada.".to_string())?;

    let client = reqwest::Client::new();
    let url = format!("{}/v1/users/me", get_api_base());

    let payload = serde_json::json!({
        "username": username,
        "display_name": display_name,
        "bio": bio,
        "custom_status": custom_status,
    });

    let resp = match client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", session_token))
        .json(&payload)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return Err(format!("Falha ao conectar com o servidor NEXUS: {}", e)),
    };

    let status = resp.status();
    if status.is_success() {
        let user: AuthUserProfile = resp
            .json()
            .await
            .map_err(|e| format!("Falha ao decodificar perfil retornado: {}", e))?;
        set_active_user_id(Some(user.id.clone()));
        Ok(user)
    } else {
        let err: ApiErrorResponse = resp
            .json()
            .await
            .map_err(|_| "Falha ao atualizar perfil".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub fn auth_cancel_google_login() {
    crate::oauth::cancel_google_flow();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_id_loaded_without_manual_env_var() {
        let client_id = get_google_client_id();
        assert!(!client_id.is_empty());
        assert!(client_id.contains(".apps.googleusercontent.com"));
        assert_eq!(
            client_id,
            "964906993797-r3v176v8d8b88fo0r9bethub6dr4cre2.apps.googleusercontent.com"
        );
    }

    #[test]
    fn test_api_base_loaded_without_manual_env_var() {
        crate::network::clear_dynamic_api_base_for_tests();
        crate::network::clear_persisted_server_url_for_tests();
        let api_base = get_api_base();
        assert!(!api_base.is_empty());
        assert!(crate::network::validate_server_url(&api_base).is_ok());
        assert!(
            api_base == "https://nexus-api.dynv6.net"
                || api_base == "http://127.0.0.1:3001"
                || api_base == "http://nexus-server:3001",
            "Unexpected default api_base: {}",
            api_base
        );
    }

    #[test]
    fn test_auth_user_profile_camel_case_serialization_and_snake_case_deserialization() {
        let backend_json = r#"{
            "id": "11111111-1111-1111-1111-111111111111",
            "username": "kel",
            "email": "kel@nexus.chat",
            "display_name": "Kel",
            "avatar_url": null,
            "bio": null,
            "status": "online",
            "custom_status": null,
            "activity": null,
            "has_password": false,
            "has_google": true,
            "created_at": "2026-11-03T00:00:00Z"
        }"#;

        let profile: AuthUserProfile = serde_json::from_str(backend_json)
            .expect("Should deserialize snake_case backend JSON with aliases");
        assert!(!profile.has_password);
        assert!(profile.has_google);
        assert_eq!(profile.display_name, "Kel");

        let client_json = serde_json::to_string(&profile)
            .expect("Should serialize AuthUserProfile to camelCase JSON");
        assert!(
            client_json.contains("\"hasGoogle\":true"),
            "Must serialize as hasGoogle for frontend: {}",
            client_json
        );
        assert!(
            client_json.contains("\"hasPassword\":false"),
            "Must serialize as hasPassword for frontend: {}",
            client_json
        );
        assert!(
            client_json.contains("\"displayName\":\"Kel\""),
            "Must serialize as displayName: {}",
            client_json
        );
    }

    #[test]
    fn test_format_api_error_preserves_code_and_message() {
        let conflict_json = r#"{
            "error": {
                "code": "ACCOUNT_CONFLICT_EMAIL_EXISTS",
                "message": "Já existe uma conta cadastrada com este e-mail. Para vincular, faça login com sua senha."
            }
        }"#;
        let resp: ApiErrorResponse = serde_json::from_str(conflict_json).unwrap();
        let formatted = format_api_error(resp);
        assert_eq!(
            formatted,
            "ACCOUNT_CONFLICT_EMAIL_EXISTS: Já existe uma conta cadastrada com este e-mail. Para vincular, faça login com sua senha."
        );

        let unlinked_json = r#"{
            "error": {
                "code": "GOOGLE_IDENTITY_NOT_LINKED",
                "message": "Este e-mail pertence a uma conta NEXUS sem senha..."
            }
        }"#;
        let resp2: ApiErrorResponse = serde_json::from_str(unlinked_json).unwrap();
        let formatted2 = format_api_error(resp2);
        assert!(formatted2.starts_with("GOOGLE_IDENTITY_NOT_LINKED:"));
    }

    #[test]
    fn test_existing_google_user_api_response_parsing() {
        let raw_backend_response = r#"{
            "user": {
                "id": "e4b2d5a1-7788-4e12-98ab-123456789abc",
                "username": "returning_google_user",
                "email": "returning@fictitious-google.test",
                "display_name": "Returning Google User",
                "avatar_url": "https://lh3.googleusercontent.com/a/mock-pic",
                "bio": null,
                "status": "online",
                "custom_status": null,
                "activity": null,
                "has_password": false,
                "has_google": true,
                "created_at": "2026-11-01T00:00:00Z"
            },
            "session_token": "fictitious_google_session_token_xyz_987",
            "expires_at": "2026-11-15T00:00:00Z"
        }"#;

        let auth_api: AuthApiResponse = serde_json::from_str(raw_backend_response)
            .expect("Should deserialize returning Google user response");
        assert_eq!(auth_api.user.username, "returning_google_user");
        assert!(!auth_api.user.has_password, "Google-only account has no password");
        assert!(auth_api.user.has_google, "Google-only account has has_google true");
        assert_eq!(auth_api.session_token, "fictitious_google_session_token_xyz_987");
    }

    #[tokio::test]
    async fn test_keyring_and_session_restore_lifecycle() {
        let _guard = crate::network::tests::TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("NEXUS_API_BASE");
        std::env::remove_var("NEXUS_API_URL");
        clear_authenticated_server_origin();
        crate::network::clear_dynamic_api_base_for_tests();
        crate::network::clear_persisted_server_url_for_tests();

        // Step 1: Basic save, retrieval and deletion in Windows Credential Manager
        let test_token = "test_nexus_session_token_12345";
        assert!(save_secure_token(test_token).is_ok());
        let retrieved = get_secure_token();
        assert_eq!(retrieved, Some(test_token.to_string()));
        assert!(auth_has_stored_session());
        assert!(delete_secure_token().is_ok());
        assert_eq!(get_secure_token(), None);
        assert!(!auth_has_stored_session());

        // Step 2: Session restore preserves token on network error (backend unreachable)
        std::env::set_var("NEXUS_API_BASE", "http://127.0.0.1:59999");
        let sample_token = "dummy_token_for_network_failure_test";
        assert!(save_secure_token(sample_token).is_ok());

        let restore_res = auth_restore_session().await;
        assert!(
            restore_res.is_err(),
            "Expected network error on unreachable backend"
        );
        let err_msg = restore_res.err().unwrap();
        assert!(
            err_msg.contains("NETWORK_ERROR"),
            "Error message must indicate NETWORK_ERROR: {}",
            err_msg
        );
        assert_eq!(
            get_secure_token(),
            Some(sample_token.to_string()),
            "Token must remain in keyring on network drop"
        );

        // Clean up network test
        assert!(delete_secure_token().is_ok());
        std::env::remove_var("NEXUS_API_BASE");

        // Step 3: Session restore purges token from Keyring when server returns 401 Unauthorized
        let invalid_token = "invalid_or_revoked_session_token_9999";
        assert!(save_secure_token(invalid_token).is_ok());

        let restore_401_res = auth_restore_session().await;
        match restore_401_res {
            Ok(maybe_user) => {
                assert!(maybe_user.is_none(), "Invalid token should resolve to None");
                assert_eq!(
                    get_secure_token(),
                    None,
                    "Token must be deleted from keyring on 401"
                );
            }
            Err(e) => {
                if e.contains("NETWORK_ERROR") {
                    println!(
                        "Note: Backend was offline during 401 test; skipping live 401 assertion"
                    );
                    let _ = delete_secure_token();
                } else {
                    panic!("Unexpected error: {}", e);
                }
            }
        }
    }
}
