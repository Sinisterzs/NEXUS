use axum::http::StatusCode;
use base64::prelude::*;
use chrono::Utc;
use nexus_server::identity::ServerIdentity;
use nexus_server::models::{ChallengeRequest, ChallengeResponse, HealthResponse};
use ring::rand::SystemRandom;
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

    // 3. Relay Attack: target_url points to a rogue server at 100.99.99.99
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
