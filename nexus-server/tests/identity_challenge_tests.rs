use axum::http::StatusCode;
use base64::prelude::*;
use chrono::Utc;
use nexus_server::identity::ServerIdentity;
use nexus_server::models::ChallengeRequest;
use ring::signature::{UnparsedPublicKey, ED25519};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[tokio::test]
async fn test_server_identity_lifecycle_and_channel_challenge() {
    // 1. Create an ephemeral server identity
    let identity = ServerIdentity::generate_ephemeral();
    let server_id = identity.server_id.clone();
    let public_key_b64 = identity.public_key_base64.clone();

    // Verify server_id is derived from SHA-256 of public key
    let pub_bytes = BASE64_STANDARD.decode(&public_key_b64).expect("valid base64 pubkey");
    let expected_id = format!("nexus-id-{}", hex::encode(Sha256::digest(&pub_bytes)));
    assert_eq!(server_id, expected_id);

    // 2. Perform a valid challenge
    let client_nonce = hex::encode([0x42u8; 32]);
    let target_url = "http://127.0.0.1:3001";
    let now = Utc::now().timestamp();
    let server_nonce = hex::encode([0x77u8; 32]);

    let sig_b64 = identity.sign_channel_challenge(&client_nonce, target_url, now, &server_nonce);
    let sig_bytes = BASE64_STANDARD.decode(&sig_b64).expect("valid base64 sig");

    // Client verifies the signature
    let expected_message = format!(
        "NEXUS-V1-CHANNEL-BIND:{}:{}:{}:{}",
        client_nonce, target_url, now, server_nonce
    );
    let verifier = UnparsedPublicKey::new(&ED25519, &pub_bytes);
    assert!(
        verifier.verify(expected_message.as_bytes(), &sig_bytes).is_ok(),
        "Client must successfully verify server channel-bound signature"
    );

    // 3. Relay Attack Test: attacker attempts to forward signature for a different endpoint
    let rogue_target_url = "http://100.99.99.99:3001";
    let rogue_message = format!(
        "NEXUS-V1-CHANNEL-BIND:{}:{}:{}:{}",
        client_nonce, rogue_target_url, now, server_nonce
    );
    assert!(
        verifier.verify(rogue_message.as_bytes(), &sig_bytes).is_err(),
        "Signature bound to 127.0.0.1:3001 must FAIL for rogue 100.99.99.99:3001"
    );

    // 4. Tampered Nonce Test
    let tampered_nonce = hex::encode([0x99u8; 32]);
    let tampered_message = format!(
        "NEXUS-V1-CHANNEL-BIND:{}:{}:{}:{}",
        tampered_nonce, target_url, now, server_nonce
    );
    assert!(
        verifier.verify(tampered_message.as_bytes(), &sig_bytes).is_err(),
        "Signature must FAIL if client_nonce was modified"
    );
}

#[tokio::test]
async fn test_challenge_handler_relay_rejection() {
    let identity = ServerIdentity::generate_ephemeral();
    let state = nexus_server::handlers::health::SystemState {
        identity: Arc::new(identity),
        config_host: "127.0.0.1".to_string(),
        config_port: 3001,
        tailscale_ip: Some("100.86.96.35".to_string()),
        public_fqdn: Some("api.nexus.app".to_string()),
    };

    let client_nonce = hex::encode([0x11u8; 32]);
    let now = Utc::now().timestamp();

    // 1. Valid request to local bound interface
    let valid_req = ChallengeRequest {
        client_nonce: client_nonce.clone(),
        target_url: "http://127.0.0.1:3001".to_string(),
        client_timestamp: now,
    };
    let res = nexus_server::handlers::health::challenge_check(
        axum::extract::State(state.clone()),
        axum::Json(valid_req),
    )
    .await;
    assert!(res.is_ok(), "Valid request to 127.0.0.1:3001 must succeed");

    // 2. Valid request to Tailscale bound interface
    let valid_ts_req = ChallengeRequest {
        client_nonce: client_nonce.clone(),
        target_url: "http://100.86.96.35:3001".to_string(),
        client_timestamp: now,
    };
    let res_ts = nexus_server::handlers::health::challenge_check(
        axum::extract::State(state.clone()),
        axum::Json(valid_ts_req),
    )
    .await;
    assert!(res_ts.is_ok(), "Valid request to 100.86.96.35:3001 must succeed");

    // 3. Valid request to authorized Public FQDN via HTTPS (default port 443)
    let valid_fqdn_req = ChallengeRequest {
        client_nonce: client_nonce.clone(),
        target_url: "https://api.nexus.app".to_string(),
        client_timestamp: now,
    };
    let res_fqdn = nexus_server::handlers::health::challenge_check(
        axum::extract::State(state.clone()),
        axum::Json(valid_fqdn_req),
    )
    .await;
    assert!(res_fqdn.is_ok(), "Valid request to https://api.nexus.app must succeed");

    // 4. Valid request to authorized Public FQDN via HTTPS explicit port 443
    let valid_fqdn_port_req = ChallengeRequest {
        client_nonce: client_nonce.clone(),
        target_url: "https://api.nexus.app:443".to_string(),
        client_timestamp: now,
    };
    let res_fqdn_port = nexus_server::handlers::health::challenge_check(
        axum::extract::State(state.clone()),
        axum::Json(valid_fqdn_port_req),
    )
    .await;
    assert!(res_fqdn_port.is_ok(), "Valid request to https://api.nexus.app:443 must succeed");

    // 5. Relay Attack: target_url points to an unauthorized public domain
    let rogue_domain_req = ChallengeRequest {
        client_nonce: client_nonce.clone(),
        target_url: "https://evil-relay.com".to_string(),
        client_timestamp: now,
    };
    let res_rogue_domain = nexus_server::handlers::health::challenge_check(
        axum::extract::State(state.clone()),
        axum::Json(rogue_domain_req),
    )
    .await;
    assert!(res_rogue_domain.is_err(), "Server must REJECT challenge for unauthorized domain evil-relay.com");
    let (code, msg) = res_rogue_domain.err().unwrap();
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(msg.contains("possível ataque de relay detectado"));

    // 6. Relay Attack: target_url points to a rogue server at 100.99.99.99
    let rogue_req = ChallengeRequest {
        client_nonce: client_nonce.clone(),
        target_url: "http://100.99.99.99:3001".to_string(),
        client_timestamp: now,
    };
    let res_rogue = nexus_server::handlers::health::challenge_check(
        axum::extract::State(state.clone()),
        axum::Json(rogue_req),
    )
    .await;
    assert!(res_rogue.is_err(), "Server must REJECT challenge for rogue endpoint 100.99.99.99:3001");
    let (code, msg) = res_rogue.err().unwrap();
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(msg.contains("possível ataque de relay detectado"));

    // 4. Replay Attack: expired timestamp (> 60s)
    let expired_req = ChallengeRequest {
        client_nonce,
        target_url: "http://127.0.0.1:3001".to_string(),
        client_timestamp: now - 120, // 2 minutes ago
    };
    let res_expired = nexus_server::handlers::health::challenge_check(
        axum::extract::State(state),
        axum::Json(expired_req),
    )
    .await;
    assert!(res_expired.is_err(), "Server must REJECT expired challenge");
    let (code, msg) = res_expired.err().unwrap();
    assert_eq!(code, StatusCode::BAD_REQUEST);
    assert!(msg.contains("expirado ou dessincronizado"));
}

#[tokio::test]
async fn test_webrtc_ice_servers_ephemeral_credentials() {
    use uuid::Uuid;
    use nexus_server::middleware::CurrentUser;
    use nexus_server::models::UserProfileResponse;

    let test_user = CurrentUser(UserProfileResponse {
        id: Uuid::new_v4(),
        email: "webrtc_user@nexus.app".to_string(),
        username: "webrtc_user".to_string(),
        display_name: "WebRTC User".to_string(),
        avatar_url: None,
        bio: None,
        status: "online".to_string(),
        custom_status: None,
        activity: None,
        has_password: true,
        has_google: false,
        created_at: Utc::now(),
    });

    // 1. Unconfigured TURN secret: returns Google STUN servers only
    let state_stun_only = nexus_server::handlers::webrtc::WebrtcState {
        turn_secret: None,
        turn_server: None,
    };
    let res_stun = nexus_server::handlers::webrtc::get_ice_servers(
        axum::extract::Extension(test_user.clone()),
        axum::extract::State(state_stun_only),
    )
    .await
    .expect("ICE servers must return successfully");

    assert_eq!(res_stun.ice_servers.len(), 1);
    assert!(res_stun.ice_servers[0].urls[0].starts_with("stun:"));
    assert!(res_stun.ice_servers[0].username.is_none());
    assert!(res_stun.ice_servers[0].credential.is_none());

    // 2. Configured TURN secret: returns STUN + signed ephemeral TURN credentials
    let state_with_turn = nexus_server::handlers::webrtc::WebrtcState {
        turn_secret: Some("my_super_secret_coturn_key".to_string()),
        turn_server: Some("turn.nexus.app".to_string()),
    };
    let res_turn = nexus_server::handlers::webrtc::get_ice_servers(
        axum::extract::Extension(test_user.clone()),
        axum::extract::State(state_with_turn),
    )
    .await
    .expect("ICE servers with TURN must return successfully");

    assert_eq!(res_turn.ice_servers.len(), 2);
    // First entry is STUN
    assert!(res_turn.ice_servers[0].urls[0].starts_with("stun:"));
    // Second entry is TURN with ephemeral credentials
    let turn_entry = &res_turn.ice_servers[1];
    assert!(turn_entry.urls[0].starts_with("turn:turn.nexus.app:3478?transport=udp"));
    assert!(turn_entry.urls[1].starts_with("turn:turn.nexus.app:3478?transport=tcp"));

    let username = turn_entry.username.as_ref().expect("username must be generated");
    let credential = turn_entry.credential.as_ref().expect("credential must be generated");

    // Username format: <expiry_timestamp>:<user_id>
    let parts: Vec<&str> = username.split(':').collect();
    assert_eq!(parts.len(), 2);
    let expiry: u64 = parts[0].parse().expect("timestamp must be valid u64");
    let user_id_str = parts[1];
    assert_eq!(user_id_str, test_user.0.id.to_string());
    assert!(expiry > Utc::now().timestamp() as u64);

    // Verify HMAC-SHA1 signature matches
    let key = ring::hmac::Key::new(
        ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY,
        b"my_super_secret_coturn_key",
    );
    let expected_tag = ring::hmac::sign(&key, username.as_bytes());
    let expected_b64 = BASE64_STANDARD.encode(expected_tag.as_ref());
    assert_eq!(credential, &expected_b64);
}
