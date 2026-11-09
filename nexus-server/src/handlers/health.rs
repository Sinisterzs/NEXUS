use axum::{
    extract::State,
    http::{HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use ring::rand::SystemRandom;

use crate::identity::ServerIdentity;
use crate::models::{ChallengeRequest, ChallengeResponse, HealthResponse};
use std::sync::Arc;

#[derive(Clone)]
pub struct SystemState {
    pub identity: Arc<ServerIdentity>,
    pub config_host: String,
    pub config_port: u16,
    pub tailscale_ip: Option<String>,
}

pub async fn health_check(
    State(state): State<SystemState>,
) -> impl IntoResponse {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::HeaderName::from_static("x-nexus-service"),
        HeaderValue::from_static("nexus-server"),
    );

    (
        headers,
        Json(HealthResponse {
            status: "ok".to_string(),
            service: "nexus-server".to_string(),
            timestamp: Utc::now(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            server_id: Some(state.identity.server_id.clone()),
            public_key: Some(state.identity.public_key_base64.clone()),
        }),
    )
}

pub async fn challenge_check(
    State(state): State<SystemState>,
    Json(payload): Json<ChallengeRequest>,
) -> Result<Json<ChallengeResponse>, (StatusCode, String)> {
    // 1. Anti-replay protection: timestamp must be fresh (within ±60s)
    let now = Utc::now().timestamp();
    if (payload.client_timestamp - now).abs() > 60 {
        return Err((
            StatusCode::BAD_REQUEST,
            "Timestamp do desafio expirado ou dessincronizado (desvio > 60s).".to_string(),
        ));
    }

    // 2. Validate client_nonce (hex string of length 64 chars / 32 bytes)
    if payload.client_nonce.len() != 64 || hex::decode(&payload.client_nonce).is_err() {
        return Err((
            StatusCode::BAD_REQUEST,
            "client_nonce inválido (requer exatamente 32 bytes em hexadecimal).".to_string(),
        ));
    }

    // 3. Channel Binding / Relay Attack Protection:
    // target_url must match one of the server's own bound listener URLs
    let target = payload.target_url.trim().trim_end_matches('/').to_lowercase();
    let port = state.config_port;

    let is_valid_target = if let Ok(parsed) = url::Url::parse(&target) {
        let p_host = parsed
            .host_str()
            .unwrap_or("")
            .trim_start_matches('[')
            .trim_end_matches(']');
        let p_port = parsed.port().unwrap_or(80);

        let port_matches = p_port == port;

        let host_matches = p_host == "127.0.0.1"
            || p_host == "localhost"
            || p_host == "::1"
            || p_host == state.config_host.to_lowercase()
            || state
                .tailscale_ip
                .as_deref()
                .map(|ip| ip.eq_ignore_ascii_case(p_host))
                .unwrap_or(false)
            || crate::config::detect_tailscale_ip()
                .as_deref()
                .map(|ip| ip.eq_ignore_ascii_case(p_host))
                .unwrap_or(false);

        port_matches && host_matches
    } else {
        false
    };

    if !is_valid_target {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "Falha de vinculação de canal: target_url '{}' não corresponde às interfaces de escuta deste servidor (possível ataque de relay detectado).",
                payload.target_url
            ),
        ));
    }

    // 4. Generate random 32-byte server_nonce for mutual freshness
    let rng = SystemRandom::new();
    let mut server_nonce_bytes = [0u8; 32];
    ring::rand::SecureRandom::fill(&rng, &mut server_nonce_bytes)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Falha na geração de entropia criptográfica".to_string()))?;
    let server_nonce = hex::encode(server_nonce_bytes);

    // 5. Sign the channel-bound challenge
    let signature = state.identity.sign_channel_challenge(
        &payload.client_nonce,
        &target,
        payload.client_timestamp,
        &server_nonce,
    );

    Ok(Json(ChallengeResponse {
        server_id: state.identity.server_id.clone(),
        public_key: state.identity.public_key_base64.clone(),
        server_nonce,
        signature,
        bound_endpoint: target,
    }))
}
