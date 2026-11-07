use serde::{Deserialize, Serialize};

use crate::auth::{get_api_base, get_secure_token};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendDto {
    pub id: String,
    pub username: String,
    pub tag: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub status: String,
    pub custom_status: Option<String>,
    pub activity: Option<String>,
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendRequestDto {
    pub id: String,
    pub user_id: String,
    pub username: String,
    pub tag: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendRequestsResponse {
    pub incoming: Vec<FriendRequestDto>,
    pub outgoing: Vec<FriendRequestDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSearchDto {
    pub id: String,
    pub username: String,
    pub tag: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub is_friend: bool,
    pub has_pending_request: bool,
    pub is_blocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceResponseDto {
    pub user_id: String,
    pub status: String,
    pub preferred_status: String,
    pub custom_status: Option<String>,
    pub activity: Option<String>,
    pub allow_friend_requests: bool,
    pub last_seen_at: Option<String>,
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

fn require_token() -> Result<String, String> {
    get_secure_token().ok_or_else(|| "Nenhuma sessão ativa encontrada.".to_string())
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[tauri::command]
pub async fn friends_get_list() -> Result<Vec<FriendDto>, String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/friends", get_api_base());

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Falha de conexão com o servidor NEXUS: {}", e))?;

    if resp.status().is_success() {
        resp.json::<Vec<FriendDto>>()
            .await
            .map_err(|e| format!("Falha ao decodificar lista de amigos: {}", e))
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao buscar amigos.".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn friends_get_requests() -> Result<FriendRequestsResponse, String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/friends/requests", get_api_base());

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Falha ao conectar com o servidor: {}", e))?;

    if resp.status().is_success() {
        resp.json::<FriendRequestsResponse>()
            .await
            .map_err(|e| format!("Falha ao decodificar solicitações: {}", e))
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao buscar solicitações.".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn friends_send_request(target: String) -> Result<FriendRequestDto, String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/friends/requests", get_api_base());

    let payload = serde_json::json!({
        "username": target.trim(),
        "target": target.trim(),
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Falha ao conectar com o servidor: {}", e))?;

    if resp.status().is_success() {
        resp.json::<FriendRequestDto>()
            .await
            .map_err(|e| format!("Falha ao decodificar resposta da solicitação: {}", e))
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao enviar solicitação.".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn friends_accept_request(request_id: String) -> Result<FriendDto, String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!(
        "{}/v1/friends/requests/{}/accept",
        get_api_base(),
        request_id
    );

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Falha ao conectar com o servidor: {}", e))?;

    if resp.status().is_success() {
        resp.json::<FriendDto>()
            .await
            .map_err(|e| format!("Falha ao decodificar dados do novo amigo: {}", e))
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao aceitar solicitação.".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn friends_reject_request(request_id: String) -> Result<(), String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!(
        "{}/v1/friends/requests/{}/reject",
        get_api_base(),
        request_id
    );

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Falha ao conectar com o servidor: {}", e))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao rejeitar solicitação.".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn friends_cancel_request(request_id: String) -> Result<(), String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/friends/requests/{}", get_api_base(), request_id);

    let resp = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Falha ao conectar com o servidor: {}", e))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao cancelar solicitação.".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn friends_decline_request(request_id: String) -> Result<(), String> {
    friends_reject_request(request_id).await
}

#[tauri::command]
pub async fn friends_remove(friend_id: String) -> Result<(), String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/friends/{}", get_api_base(), friend_id);

    let resp = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Falha ao conectar com o servidor: {}", e))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao remover amigo.".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn friends_block_user(user_id: String) -> Result<(), String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/users/{}/block", get_api_base(), user_id);

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Falha ao conectar com o servidor: {}", e))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao bloquear usuário.".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn friends_unblock_user(user_id: String) -> Result<(), String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/users/{}/block", get_api_base(), user_id);

    let resp = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Falha ao conectar com o servidor: {}", e))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao desbloquear usuário.".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn friends_search_users(query: String) -> Result<Vec<UserSearchDto>, String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!(
        "{}/v1/users/search?username={}",
        get_api_base(),
        urlencoding(&query)
    );

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Falha ao conectar com o servidor: {}", e))?;

    if resp.status().is_success() {
        resp.json::<Vec<UserSearchDto>>()
            .await
            .map_err(|e| format!("Falha ao decodificar resultados da busca: {}", e))
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro retornado pelo servidor ao buscar usuários.".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn friends_get_presence() -> Result<PresenceResponseDto, String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/users/me/presence", get_api_base());

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Falha ao conectar com o servidor: {}", e))?;

    if resp.status().is_success() {
        resp.json::<PresenceResponseDto>()
            .await
            .map_err(|e| format!("Falha ao decodificar presença: {}", e))
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro ao consultar presença.".to_string())?;
        Err(err.error.message)
    }
}

#[tauri::command]
pub async fn friends_update_presence(
    status: Option<String>,
    preferred_status: Option<String>,
    custom_status: Option<String>,
    activity: Option<String>,
    allow_friend_requests: Option<bool>,
) -> Result<PresenceResponseDto, String> {
    let token = require_token()?;
    let client = http_client();
    let url = format!("{}/v1/users/me/presence", get_api_base());

    let payload = serde_json::json!({
        "status": status,
        "preferred_status": preferred_status,
        "custom_status": custom_status,
        "activity": activity,
        "allow_friend_requests": allow_friend_requests,
    });

    let resp = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Falha ao conectar com o servidor: {}", e))?;

    if resp.status().is_success() {
        resp.json::<PresenceResponseDto>()
            .await
            .map_err(|e| format!("Falha ao decodificar resposta da presença: {}", e))
    } else {
        let err = resp
            .json::<ApiErrorResponse>()
            .await
            .map_err(|_| "Erro ao atualizar presença.".to_string())?;
        Err(err.error.message)
    }
}

/// Returns the Gateway WebSocket URL without credentials
#[tauri::command]
pub fn gateway_get_ws_url() -> Result<String, String> {
    let api_base = get_api_base();
    let ws_base = if api_base.starts_with("https://") {
        api_base.replace("https://", "wss://")
    } else {
        api_base.replace("http://", "ws://")
    };

    Ok(format!("{}/v1/gateway", ws_base))
}

/// Securely retrieves the active session token from Keyring strictly for Gateway initial authentication
#[tauri::command]
pub fn gateway_get_auth_token() -> Result<String, String> {
    require_token()
}

/// Legacy helper for backwards compatibility
#[tauri::command]
pub fn friends_get_ws_url() -> Result<String, String> {
    gateway_get_ws_url()
}

fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}
