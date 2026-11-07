use keyring::Entry;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

const SERVICE_NAME: &str = "nexus_desktop";
const SESSION_USER_KEY: &str = "session_token";
const DEFAULT_API_BASE: &str = "http://127.0.0.1:3001";
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

pub fn get_api_base() -> String {
    // 0. Dynamic runtime override (set by NetworkManager)
    if let Some(dyn_url) = crate::network::get_dynamic_api_base() {
        if !dyn_url.is_empty() {
            return dyn_url;
        }
    }
    // 1. Runtime override via NEXUS_API_URL or NEXUS_API_BASE
    if let Ok(val) = std::env::var("NEXUS_API_URL").or_else(|_| std::env::var("NEXUS_API_BASE")) {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.trim_end_matches('/').to_string();
        }
    }
    // 2. Compile-time embedded default from build.rs
    if let Some(val) = option_env!("NEXUS_DEFAULT_API_URL") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return trimmed.trim_end_matches('/').to_string();
        }
    }
    // 3. Default fallback
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

/// Securely stores session token in the OS Keyring (Windows Credential Manager / DPAPI)
pub fn save_secure_token(token: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, SESSION_USER_KEY)
        .map_err(|e| format!("Falha ao acessar Windows Credential Manager: {}", e))?;
    entry
        .set_password(token)
        .map_err(|e| format!("Falha ao salvar no Windows Credential Manager: {}", e))?;
    Ok(())
}

/// Retrieves stored session token from OS Keyring
pub fn get_secure_token() -> Option<String> {
    let entry = Entry::new(SERVICE_NAME, SESSION_USER_KEY).ok()?;
    let pw = entry.get_password().ok()?;
    let trimmed = pw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Deletes stored session token from OS Keyring
pub fn delete_secure_token() -> Result<(), String> {
    if let Ok(entry) = Entry::new(SERVICE_NAME, SESSION_USER_KEY) {
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
    if let Some(token) = get_secure_token() {
        let client = reqwest::Client::new();
        let url = format!("{}/v1/auth/logout", get_api_base());

        // Attempt remote revocation (best effort)
        let _ = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await;
    }

    // Always purge local keyring credential
    delete_secure_token()?;
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
        Ok(Some(user))
    } else if status == StatusCode::UNAUTHORIZED {
        // Token confirmed expired or revoked by backend -> delete from keyring
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

        Ok(auth_data.user)
    } else {
        let err: ApiErrorResponse = resp
            .json()
            .await
            .map_err(|_| "Falha na autenticação com o Google".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn auth_link_google() -> Result<String, String> {
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
        Err(err.error.message)
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
        let api_base = get_api_base();
        assert!(!api_base.is_empty());
        assert_eq!(api_base, "http://127.0.0.1:3001");
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

    #[tokio::test]
    async fn test_keyring_and_session_restore_lifecycle() {
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
