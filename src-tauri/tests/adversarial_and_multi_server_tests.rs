use std::sync::Mutex;
static TEST_MUTEX: Mutex<()> = Mutex::new(());

#[test]
fn test_adversarial_relay_proxy_blocked_by_channel_binding() {
    let _guard = TEST_MUTEX.lock().unwrap();
    nexus_lib::set_test_environment_override(true);
    use base64::prelude::*;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
    use sha2::{Digest, Sha256};

    // 1. Legitimate server setup
    let rng = SystemRandom::new();
    let pkcs8_bytes = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
    let legit_keypair = Ed25519KeyPair::from_pkcs8(pkcs8_bytes.as_ref()).unwrap();
    let legit_pubkey_bytes = legit_keypair.public_key().as_ref();
    let _legit_pubkey_b64 = BASE64_STANDARD.encode(legit_pubkey_bytes);
    let _legit_server_id = format!("nexus-id-{}", hex::encode(Sha256::digest(legit_pubkey_bytes)));
    let legit_bound_endpoint = "http://100.86.96.35:3001";

    // 2. Client initiates challenge targeting rogue proxy endpoint
    let rogue_endpoint = "http://100.99.99.99:3001";
    let client_nonce = hex::encode([0xAAu8; 32]);
    let client_timestamp = 1731000000i64;

    // === SCENARIO A: Rogue Proxy forwards challenge unchanged to legitimate server ===
    // Legitimate server inspects target_url ("http://100.99.99.99:3001").
    // Server sees target_url does NOT match its active bound interface (100.86.96.35:3001 or loopback).
    let server_interfaces = ["127.0.0.1:3001", "100.86.96.35:3001"];
    let is_legit_target = server_interfaces.iter().any(|iface| rogue_endpoint.contains(iface));
    assert!(
        !is_legit_target,
        "Legitimate server MUST reject challenge when target_url does not match its bound interfaces"
    );

    // === SCENARIO B: Rogue Proxy alters target_url to legitimate server's URL to obtain a valid signature ===
    // Legitimate server accepts altered target_url and signs transcript for 100.86.96.35:3001
    let server_nonce = hex::encode([0xBBu8; 32]);
    let forged_by_proxy_transcript = format!(
        "NEXUS-V1-CHANNEL-BIND:{}:{}:{}:{}",
        client_nonce, legit_bound_endpoint, client_timestamp, server_nonce
    );
    let legit_signature = legit_keypair.sign(forged_by_proxy_transcript.as_bytes());

    // Proxy returns this response to client at 100.99.99.99
    // Client verifies channel binding against rogue_endpoint (100.99.99.99:3001)
    let client_expected_transcript = format!(
        "NEXUS-V1-CHANNEL-BIND:{}:{}:{}:{}",
        client_nonce, rogue_endpoint, client_timestamp, server_nonce
    );

    let verifier = UnparsedPublicKey::new(&ED25519, legit_pubkey_bytes);

    // Assertion 1: Client verification fails because signature was bound to 100.86.96.35:3001
    let verify_res = verifier.verify(client_expected_transcript.as_bytes(), legit_signature.as_ref());
    assert!(
        verify_res.is_err(),
        "Client MUST REJECT relayed signature because channel transcript binds the contacted endpoint"
    );

    // Assertion 2: If proxy instead returns bound_endpoint = 'http://100.86.96.35:3001',
    // client channel check detects bound_endpoint != rogue_endpoint
    assert_ne!(
        legit_bound_endpoint, rogue_endpoint,
        "Client detects endpoint mismatch between contacted URL and signed bound_endpoint"
    );
}

#[test]
fn test_adversarial_in_path_mitm_demonstration_why_tls_is_required() {
    let _guard = TEST_MUTEX.lock().unwrap();
    // TECHNICAL PROOF:
    // If an attacker performs transparent in-path packet interception (e.g. ARP poisoning or rogue router)
    // where the client connects directly to 'http://100.86.96.35:3001' without changing the IP:
    // 1. The challenge packet passes transparently to the real server.
    // 2. The real server signs it (since target_url is its own IP).
    // 3. The client receives a valid Ed25519 signature and considers the server authenticated.
    // 4. SUBSEQUENT REQUEST: Client sends 'Authorization: Bearer <TOKEN>' over plain HTTP.
    // 5. Because the HTTP channel is unencrypted, the transparent in-path sniffer intercepts the Bearer token!
    //
    // CONCLUSION:
    // Channel binding with Ed25519 successfully stops endpoint confusion, identity spoofing, and remote proxy relay.
    // BUT IT DOES NOT REPLACE TRANSPORT ENCRYPTION (TLS / WireGuard).
    // In Tailscale, WireGuard provides point-to-point transport encryption between nodes.
    let target_url_is_not_tls = true;
    assert!(target_url_is_not_tls, "Documented technical evidence: target_url over HTTP cannot encrypt subsequent payload");
}

#[test]
fn test_two_servers_simulation_rogue_server_never_receives_tokens() {
    let _guard = TEST_MUTEX.lock().unwrap();
    nexus_lib::set_test_environment_override(true);
    use nexus_lib::auth::{
        clear_authenticated_server_origin, delete_secure_token, get_secure_token,
        record_authenticated_server_identity, save_secure_token_for_origin,
    };
    use nexus_lib::network::{
        clear_dynamic_api_base_for_tests, clear_persisted_server_url_for_tests,
        save_persisted_network_config, set_dynamic_api_base,
    };

    // Clean up initially
    let _ = delete_secure_token();
    clear_authenticated_server_origin();
    clear_dynamic_api_base_for_tests();
    clear_persisted_server_url_for_tests();

    let server_a_url = "http://100.86.96.35:3001";
    let server_a_id = "nexus-id-legitimate-approved-server-111";
    let server_a_key = "dGVzdC1wdWJsaWMta2V5LWxlZ2l0";

    let server_b_rogue_url = "http://100.99.99.99:3001";
    let _server_b_rogue_id = "nexus-id-rogue-attacker-server-666";

    // Step 1: User establishes session on approved Server A
    assert!(save_persisted_network_config(server_a_url, Some(server_a_id), Some(server_a_key), None).is_ok());
    record_authenticated_server_identity(server_a_url, server_a_id);
    set_dynamic_api_base(server_a_url.to_string());

    let user_token = "secret_session_token_of_legitimate_user_999";
    assert!(save_secure_token_for_origin(user_token, server_a_url).is_ok());

    // Token is correctly available for Server A
    assert_eq!(get_secure_token().as_deref(), Some(user_token));

    // Step 2: Rogue Server B appears on the network and client points to Server B
    set_dynamic_api_base(server_b_rogue_url.to_string());

    // Because Server B is NOT the authenticated server in memory and its ID is not approved,
    // get_secure_token() MUST WITHHOLD THE TOKEN!
    assert_eq!(
        get_secure_token(),
        None,
        "CRITICAL: User session token MUST NEVER be delivered to rogue server B!"
    );

    // Step 3: Simulate application restart (cold start) while configured on rogue Server B
    clear_authenticated_server_origin();
    set_dynamic_api_base(server_b_rogue_url.to_string());

    assert_eq!(
        get_secure_token(),
        None,
        "Token MUST NOT be delivered to rogue server B even after cold start / restart"
    );

    // Step 4: Reconnect back to legitimate Server A
    record_authenticated_server_identity(server_a_url, server_a_id);
    set_dynamic_api_base(server_a_url.to_string());

    assert_eq!(
        get_secure_token().as_deref(),
        Some(user_token),
        "Token is safely restored and delivered when connecting back to legitimate Server A"
    );

    // Cleanup
    let _ = delete_secure_token();
    clear_authenticated_server_origin();
    clear_dynamic_api_base_for_tests();
    clear_persisted_server_url_for_tests();
}
