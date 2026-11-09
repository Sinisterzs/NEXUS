use nexus_lib::network::safe_open_url;

#[test]
fn test_b4_01_safe_open_url_allows_legitimate_https() {
    assert!(safe_open_url("https://tailscale.com/download/windows").is_ok());
    assert!(safe_open_url("https://accounts.google.com/o/oauth2/v2/auth?client_id=test").is_ok());
    assert!(safe_open_url("https://github.com/Sinisterzs/NEXUS/releases").is_ok());
}

#[test]
fn test_b4_02_safe_open_url_rejects_dangerous_schemes_and_injection() {
    // Rejects HTTP (external browser opening must be HTTPS)
    assert!(safe_open_url("http://example.com").is_err());

    // Rejects javascript:, file:, data:
    assert!(safe_open_url("javascript:alert(1)").is_err());
    assert!(safe_open_url("file:///C:/Windows/System32/cmd.exe").is_err());
    assert!(safe_open_url("data:text/html,<script>alert(1)</script>").is_err());

    // Rejects empty or invalid
    assert!(safe_open_url("").is_err());
    assert!(safe_open_url("   ").is_err());
    assert!(safe_open_url("not a url").is_err());

    // Rejects shell metacharacters and control characters
    assert!(safe_open_url("https://tailscale.com/&calc.exe").is_ok()); // Valid path char, but let's test quotes / newlines:
    assert!(safe_open_url("https://tailscale.com/\"").is_err());
    assert!(safe_open_url("https://tailscale.com/'").is_err());
    assert!(safe_open_url("https://tailscale.com/`").is_err());
    assert!(safe_open_url("https://tailscale.com/\n").is_err());
    assert!(safe_open_url("https://tailscale.com/\0").is_err());
}

#[test]
fn test_b4_03_uuid_validation_rejects_path_traversal_and_injection() {
    let valid_uuid = "550e8400-e29b-41d4-a716-446655440000";
    assert!(uuid::Uuid::parse_str(valid_uuid).is_ok());

    let invalid_payloads = [
        "../admin",
        "../../etc/passwd",
        "550e8400-e29b-41d4-a716-446655440000/accept",
        "550e8400' OR '1'='1",
        "<script>alert(1)</script>",
        "",
        "   ",
        "not-a-uuid",
    ];

    for payload in invalid_payloads {
        assert!(uuid::Uuid::parse_str(payload).is_err(), "Payload '{}' should fail UUID validation", payload);
    }
}

#[test]
fn test_b4_04_tauri_conf_enforces_strict_csp_without_unsafe_eval() {
    let conf_str = std::fs::read_to_string("tauri.conf.json").expect("Failed to read tauri.conf.json");
    let conf: serde_json::Value = serde_json::from_str(&conf_str).expect("Invalid JSON in tauri.conf.json");

    let csp = conf["app"]["security"]["csp"].as_str().expect("CSP should be a string, not null");
    assert!(csp.contains("default-src 'self'"), "CSP must include default-src 'self'");
    assert!(csp.contains("script-src 'self'"), "CSP must include script-src 'self'");
    assert!(csp.contains("object-src 'none'"), "CSP must block objects");
    assert!(csp.contains("frame-src 'none'"), "CSP must block frames");
    assert!(!csp.contains("unsafe-eval"), "CSP must NEVER include unsafe-eval");

    // B4.1 Hardening: connect-src must strictly disallow generic scheme wildcards
    let connect_src = csp
        .split(';')
        .find(|part| part.trim().starts_with("connect-src"))
        .expect("CSP must include connect-src directive");

    let connect_tokens: Vec<&str> = connect_src.split_whitespace().collect();
    assert!(!connect_tokens.contains(&"http:"), "connect-src must not contain generic http:");
    assert!(!connect_tokens.contains(&"https:"), "connect-src must not contain generic https:");
    assert!(!connect_tokens.contains(&"ws:"), "connect-src must not contain generic ws:");
    assert!(!connect_tokens.contains(&"wss:"), "connect-src must not contain generic wss:");

    // Must allow essential origins
    assert!(connect_src.contains("ipc:"), "connect-src must allow ipc:");
    assert!(connect_src.contains("tauri:"), "connect-src must allow tauri:");
    assert!(connect_src.contains("ws://127.0.0.1:*") || connect_src.contains("http://127.0.0.1:*"), "connect-src must allow loopback");
    assert!(connect_src.contains("nexus-server"), "connect-src must allow nexus-server");
    assert!(connect_src.contains("*.ts.net"), "connect-src must allow Tailscale *.ts.net");
}

#[test]
fn test_b4_05_capabilities_denies_unscoped_open_path() {
    let cap_str = std::fs::read_to_string("capabilities/default.json").expect("Failed to read default.json");
    let cap: serde_json::Value = serde_json::from_str(&cap_str).expect("Invalid JSON in default.json");

    let perms = cap["permissions"].as_array().expect("Permissions must be array");
    let has_unrestricted_opener = perms.iter().any(|p| p.as_str() == Some("opener:default"));
    assert!(!has_unrestricted_opener, "Unrestricted opener:default must NOT be granted to WebView");

    let has_allowed_opener = perms.iter().any(|p| p.as_str() == Some("opener:allow-default-urls"));
    assert!(has_allowed_opener, "Scoped opener:allow-default-urls should be present");
}

#[test]
fn test_b4_06_version_consistency_across_metadata() {
    let pkg_version = env!("CARGO_PKG_VERSION");
    let tauri_conf_str = std::fs::read_to_string("tauri.conf.json").expect("Failed to read tauri.conf.json");
    let tauri_conf: serde_json::Value = serde_json::from_str(&tauri_conf_str).expect("Invalid JSON");

    assert_eq!(tauri_conf["version"].as_str().unwrap(), pkg_version, "tauri.conf.json version must match Cargo.toml");
}

static TEST_KEYRING_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn test_b4_07_token_origin_binding_prevents_leak_to_unknown_server() {
    let _guard = TEST_KEYRING_MUTEX.lock().unwrap();
    nexus_lib::set_test_environment_override(true);
    use nexus_lib::auth::{
        clear_authenticated_server_origin, delete_secure_token, get_secure_token,
        record_authenticated_server_origin, save_secure_token,
    };
    use nexus_lib::network::{clear_dynamic_api_base_for_tests, set_dynamic_api_base};

    // Clean up
    let _ = delete_secure_token();
    clear_authenticated_server_origin();
    clear_dynamic_api_base_for_tests();

    // Set server origin A before saving token
    set_dynamic_api_base("http://127.0.0.1:3001".to_string());
    record_authenticated_server_origin("http://127.0.0.1:3001");

    let test_token = "nexus_secret_session_token_origin_test";
    assert!(save_secure_token(test_token).is_ok());
    assert_eq!(get_secure_token().as_deref(), Some(test_token));

    // If server base changes to a different server (e.g. another port or machine), token is withheld!
    set_dynamic_api_base("http://nexus-server:3001".to_string());
    assert_eq!(
        get_secure_token(),
        None,
        "Token must NOT be leaked to a different server address than the authenticated origin"
    );

    // If reset back to the authenticated server, token is available again
    set_dynamic_api_base("http://127.0.0.1:3001".to_string());
    assert_eq!(get_secure_token().as_deref(), Some(test_token));

    // Cleanup
    let _ = delete_secure_token();
    clear_authenticated_server_origin();
    clear_dynamic_api_base_for_tests();
}

#[test]
fn test_b4_08_persisted_origin_binding_survives_cold_start_and_blocks_fake_server() {
    let _guard = TEST_KEYRING_MUTEX.lock().unwrap();
    nexus_lib::set_test_environment_override(true);
    use nexus_lib::auth::{
        clear_authenticated_server_origin, delete_secure_token, get_secure_token,
        save_secure_token,
    };
    use nexus_lib::network::{clear_dynamic_api_base_for_tests, set_dynamic_api_base};

    // Clean up initially
    let _ = delete_secure_token();
    clear_authenticated_server_origin();
    clear_dynamic_api_base_for_tests();

    // 1. Establish session on legitimate server A (http://127.0.0.1:3001)
    set_dynamic_api_base("http://127.0.0.1:3001".to_string());
    let token = "nx_sess_persistent_secret_123";
    assert!(save_secure_token(token).is_ok());

    // 2. Simulate complete application reboot (cold start: in-memory state is wiped)
    clear_authenticated_server_origin();

    // 3. Point app to an alternative or rogue server (http://100.115.92.19:3001)
    set_dynamic_api_base("http://100.115.92.19:3001".to_string());

    // 4. On cold start connection attempt, get_secure_token() MUST withhold the token
    // because the stored credential is bound to http://127.0.0.1:3001
    assert_eq!(
        get_secure_token(),
        None,
        "Token must NOT be leaked to alternative server on cold start / initial connection"
    );

    // 5. Simulate cold start again and restore to original server A
    clear_authenticated_server_origin();
    set_dynamic_api_base("http://127.0.0.1:3001".to_string());

    // 6. Token is successfully released to the legitimate originating server
    assert_eq!(
        get_secure_token().as_deref(),
        Some(token),
        "Token must be available when connecting to the authentic origin"
    );

    // Cleanup
    let _ = delete_secure_token();
    clear_authenticated_server_origin();
    clear_dynamic_api_base_for_tests();
}
