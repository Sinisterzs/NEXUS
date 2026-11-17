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
    pub public_fqdn: Option<String>,
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
        let scheme = parsed.scheme();
        let default_port = if scheme == "https" { 443 } else { 80 };
        let p_port = parsed.port().unwrap_or(default_port);

        let is_public_fqdn_match = state
            .public_fqdn
            .as_deref()
            .map(|fqdn| fqdn.eq_ignore_ascii_case(p_host))
            .unwrap_or(false);

        let port_matches = p_port == port
            || (is_public_fqdn_match && (p_port == 443 || p_port == 80 || p_port == port))
            || ((p_port == 443 || p_port == 80) && (p_host == "127.0.0.1" || p_host == "localhost"));

        let host_matches = p_host == "127.0.0.1"
            || p_host == "localhost"
            || p_host == "::1"
            || p_host == state.config_host.to_lowercase()
            || is_public_fqdn_match
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

#[derive(serde::Serialize)]
pub struct SystemCompatibilityResponse {
    pub min_client_version_stable: Option<String>,
    pub min_client_version_nightly: Option<String>,
}

fn validate_min_version(raw: Option<String>, allow_nightly: bool) -> Option<String> {
    // TypeScript compares these components as Number: larger integers lose
    // precision. Require canonical decimal spelling on both channels.
    fn valid_component(part: &str) -> bool {
        !part.is_empty()
            && (part.len() == 1 || !part.starts_with('0'))
            && part.bytes().all(|byte| byte.is_ascii_digit())
            && part.parse::<u64>().is_ok_and(|value| value <= 9_007_199_254_740_991)
    }

    let raw = raw?;
    // Configuration may have outer ASCII whitespace; return a canonical value.
    let val = raw.trim_matches(|c: char| c.is_ascii_whitespace());
    let core = if let Some((core, suffix)) = val.split_once('-') {
        if !allow_nightly || !valid_component(suffix.strip_prefix("nightly.")?) {
            return None;
        }
        core
    } else {
        val
    };
    let mut parts = core.split('.');
    for _ in 0..3 {
        if !valid_component(parts.next()?) {
            return None;
        }
    }
    if parts.next().is_some() {
        return None;
    }
    Some(val.to_owned())
}

pub async fn system_compatibility() -> impl axum::response::IntoResponse {
    let min_stable = validate_min_version(std::env::var("NEXUS_MIN_CLIENT_VERSION_STABLE").ok(), false);
    let min_nightly = validate_min_version(std::env::var("NEXUS_MIN_CLIENT_VERSION_NIGHTLY").ok(), true);

    (
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        axum::Json(SystemCompatibilityResponse {
            min_client_version_stable: min_stable,
            min_client_version_nightly: min_nightly,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::validate_min_version;

    #[test]
    fn validates_stable_and_nightly_min_versions() {
        #[derive(serde::Deserialize)]
        struct Case {
            raw: Option<String>,
            stable: Option<String>,
            nightly: Option<String>,
        }
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../../shared/minimum-version-cases.json"
        )).expect("valid shared version contract fixtures");
        for case in cases {
            assert_eq!(
                validate_min_version(case.raw.clone(), false), case.stable,
                "stable input: {:?}", case.raw
            );
            assert_eq!(
                validate_min_version(case.raw.clone(), true), case.nightly,
                "nightly input: {:?}", case.raw
            );
        }
        assert_eq!(validate_min_version(None, false), None);
        assert_eq!(validate_min_version(Some("".to_string()), false), None);
        assert_eq!(
            validate_min_version(Some("0.4.0".to_string()), false),
            Some("0.4.0".to_string())
        );
        assert_eq!(
            validate_min_version(Some("0.4.0-nightly.8".to_string()), true),
            Some("0.4.0-nightly.8".to_string())
        );
        assert_eq!(
            validate_min_version(Some("0.4.0-nightly.8".to_string()), false),
            None
        );
        assert_eq!(
            validate_min_version(Some("invalid-ver".to_string()), true),
            None
        );
    }
}
