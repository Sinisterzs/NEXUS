use axum::{
    extract::{Extension, State},
    Json,
};
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::errors::AppError;
use crate::middleware::CurrentUser;

#[derive(Clone, Debug)]
pub struct WebrtcState {
    pub turn_secret: Option<String>,
    pub turn_server: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IceServerEntry {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IceServersResponse {
    pub ice_servers: Vec<IceServerEntry>,
    pub ttl_seconds: u64,
}

pub async fn get_ice_servers(
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    State(state): State<WebrtcState>,
) -> Result<Json<IceServersResponse>, AppError> {
    let mut ice_servers = Vec::new();

    // 1. Default reliable STUN servers (always available for reflexive candidates)
    ice_servers.push(IceServerEntry {
        urls: vec![
            "stun:stun.l.google.com:19302".to_string(),
            "stun:stun1.l.google.com:19302".to_string(),
            "stun:stun2.l.google.com:19302".to_string(),
        ],
        username: None,
        credential: None,
    });

    let ttl_seconds = 86400; // 24 hours

    // 2. Ephemeral TURN credentials (RFC 5766 / RFC 7635 REST API specification)
    // Generates HMAC-SHA1 signed single-use user credentials when TURN_SECRET is configured
    if let (Some(ref secret), Some(ref server_addr)) = (&state.turn_secret, &state.turn_server) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let expiry = now + ttl_seconds;
        let username = format!("{}:{}", expiry, user.id);

        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, secret.as_bytes());
        let signature = ring::hmac::sign(&key, username.as_bytes());
        let credential = base64::prelude::BASE64_STANDARD.encode(signature.as_ref());

        let clean_addr = server_addr
            .trim()
            .trim_start_matches("turn:")
            .trim_start_matches("turns:");

        let port_suffix = if clean_addr.contains(':') {
            clean_addr.to_string()
        } else {
            format!("{}:3478", clean_addr)
        };

        ice_servers.push(IceServerEntry {
            urls: vec![
                format!("turn:{}?transport=udp", port_suffix),
                format!("turn:{}?transport=tcp", port_suffix),
            ],
            username: Some(username),
            credential: Some(credential),
        });
    }

    Ok(Json(IceServersResponse {
        ice_servers,
        ttl_seconds,
    }))
}
