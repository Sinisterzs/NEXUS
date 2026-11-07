use std::net::SocketAddr;

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;

use nexus_server::config::AppConfig;
use nexus_server::create_app;

async fn setup_test_server() -> (String, PgPool) {
    let mut config = AppConfig::from_env();
    let test_db_url = config
        .test_database_url
        .clone()
        .unwrap_or_else(|| "postgres://postgres@localhost:5432/nexus_test_db".to_string());
    config.database_url = test_db_url.clone();

    let pool = PgPool::connect(&test_db_url)
        .await
        .expect("Falha ao conectar no banco de testes");

    // Clean tables before tests
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("Falha ao limpar tabelas de teste");

    let app = create_app(pool.clone(), config);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("Falha ao vincular porta efêmera");
    let addr = listener.local_addr().expect("Falha ao obter endereço local");

    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    (format!("http://{}", addr), pool)
}

#[tokio::test]
async fn test_01_register_two_distinct_users() {
    let (base_url, _) = setup_test_server().await;
    let client = Client::new();

    // 1. Register Alice
    let resp = client
        .post(format!("{}/v1/auth/register", base_url))
        .json(&json!({
            "username": "alice",
            "email": "alice@nexus.test",
            "password": "Password123!",
            "display_name": "Alice Wonderland"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::CREATED);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["user"]["username"], "alice");
    assert_eq!(body["user"]["email"], "alice@nexus.test");
    assert_eq!(body["user"]["display_name"], "Alice Wonderland");
    assert!(body["session_token"].as_str().unwrap().starts_with("nx_sess_"));

    // 2. Register Bob
    let resp = client
        .post(format!("{}/v1/auth/register", base_url))
        .json(&json!({
            "username": "bob",
            "email": "bob@nexus.test",
            "password": "Password123!",
            "display_name": "Bob Builder"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::CREATED);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["user"]["username"], "bob");
    assert_eq!(body["user"]["email"], "bob@nexus.test");
    assert_eq!(body["user"]["display_name"], "Bob Builder");
    assert!(body["session_token"].as_str().unwrap().starts_with("nx_sess_"));
}

#[tokio::test]
async fn test_02_duplicate_email_and_username_rejection() {
    let (base_url, _) = setup_test_server().await;
    let client = Client::new();

    // Register initial user
    client
        .post(format!("{}/v1/auth/register", base_url))
        .json(&json!({
            "username": "user1",
            "email": "user1@nexus.test",
            "password": "Password123!"
        }))
        .send()
        .await
        .unwrap();

    // Duplicate email
    let resp = client
        .post(format!("{}/v1/auth/register", base_url))
        .json(&json!({
            "username": "different_user",
            "email": "USER1@nexus.test", // test case-insensitive normalization
            "password": "Password123!"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error"]["code"], "EMAIL_ALREADY_EXISTS");

    // Duplicate username
    let resp2 = client
        .post(format!("{}/v1/auth/register", base_url))
        .json(&json!({
            "username": "User1", // test case-insensitive
            "email": "another@nexus.test",
            "password": "Password123!"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp2.status(), StatusCode::CONFLICT);
    let body2: Value = resp2.json().await.unwrap();
    assert_eq!(body2["error"]["code"], "USERNAME_ALREADY_EXISTS");
}

#[tokio::test]
async fn test_03_and_04_login_valid_and_invalid() {
    let (base_url, _) = setup_test_server().await;
    let client = Client::new();

    // Register user
    client
        .post(format!("{}/v1/auth/register", base_url))
        .json(&json!({
            "username": "carol",
            "email": "carol@nexus.test",
            "password": "CarolSecurePassword1!"
        }))
        .send()
        .await
        .unwrap();

    // 1. Valid login with email
    let resp = client
        .post(format!("{}/v1/auth/login", base_url))
        .json(&json!({
            "login": "carol@nexus.test",
            "password": "CarolSecurePassword1!"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["user"]["username"], "carol");
    let session_token = body["session_token"].as_str().unwrap();
    assert!(session_token.starts_with("nx_sess_"));

    // 2. Valid login with username
    let resp = client
        .post(format!("{}/v1/auth/login", base_url))
        .json(&json!({
            "login": "carol",
            "password": "CarolSecurePassword1!"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // 3. Invalid password (non-enumerable generic error)
    let resp_invalid_pw = client
        .post(format!("{}/v1/auth/login", base_url))
        .json(&json!({
            "login": "carol",
            "password": "WrongPassword!"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp_invalid_pw.status(), StatusCode::UNAUTHORIZED);
    let err_body: Value = resp_invalid_pw.json().await.unwrap();
    assert_eq!(err_body["error"]["code"], "INVALID_CREDENTIALS");

    // 4. Non-existent user (identical error code and status)
    let resp_no_user = client
        .post(format!("{}/v1/auth/login", base_url))
        .json(&json!({
            "login": "nonexistent_person",
            "password": "WrongPassword!"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp_no_user.status(), StatusCode::UNAUTHORIZED);
    let err_body2: Value = resp_no_user.json().await.unwrap();
    assert_eq!(err_body2["error"]["code"], "INVALID_CREDENTIALS");
}

#[tokio::test]
async fn test_05_argon2id_hash_and_token_hash_stored_in_postgres() {
    let (base_url, pool) = setup_test_server().await;
    let client = Client::new();

    let raw_pw = "SuperSecretPlainText!";
    let resp = client
        .post(format!("{}/v1/auth/register", base_url))
        .json(&json!({
            "username": "security_check",
            "email": "security@nexus.test",
            "password": raw_pw
        }))
        .send()
        .await
        .unwrap();

    let body: Value = resp.json().await.unwrap();
    let raw_session_token = body["session_token"].as_str().unwrap().to_string();

    // Query database directly to verify password hash format
    let creds: (String,) = sqlx::query_as("SELECT password_hash FROM user_credentials WHERE email = 'security@nexus.test'")
        .fetch_one(&pool)
        .await
        .unwrap();

    // Check that raw password is NOT stored
    assert_ne!(creds.0, raw_pw);
    // Check that Argon2id prefix is present
    assert!(creds.0.starts_with("$argon2id$"));

    // Check that session token hash in DB is SHA-256 (64 hex characters) and NOT the raw token
    let session: (String,) = sqlx::query_as("SELECT token_hash FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'security_check')")
        .fetch_one(&pool)
        .await
        .unwrap();

    assert_ne!(session.0, raw_session_token);
    assert_eq!(session.0.len(), 64);
}

#[tokio::test]
async fn test_06_and_07_invalid_token_rejection_and_logout_revocation() {
    let (base_url, _) = setup_test_server().await;
    let client = Client::new();

    // 1. Invalid or missing token
    let resp = client
        .get(format!("{}/v1/users/me", base_url))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    let resp_fake = client
        .get(format!("{}/v1/users/me", base_url))
        .header("Authorization", "Bearer nx_sess_fake000000000000000000000000000000000000000000000000000000000000")
        .send()
        .await
        .unwrap();
    assert_eq!(resp_fake.status(), StatusCode::UNAUTHORIZED);

    // 2. Register valid user
    let register_resp = client
        .post(format!("{}/v1/auth/register", base_url))
        .json(&json!({
            "username": "logout_tester",
            "email": "logout@nexus.test",
            "password": "Password123!"
        }))
        .send()
        .await
        .unwrap();

    let reg_body: Value = register_resp.json().await.unwrap();
    let token = reg_body["session_token"].as_str().unwrap();

    // 3. Check /v1/users/me works with valid token
    let me_resp = client
        .get(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();
    assert_eq!(me_resp.status(), StatusCode::OK);

    // 4. Logout (revoke session)
    let logout_resp = client
        .post(format!("{}/v1/auth/logout", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();
    assert_eq!(logout_resp.status(), StatusCode::OK);

    // 5. Subsequent request with revoked token MUST be rejected with 401
    let revoked_resp = client
        .get(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();
    assert_eq!(revoked_resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_08_and_12_session_restore_and_user_isolation() {
    let (base_url, _) = setup_test_server().await;
    let client = Client::new();

    // Register User A
    let resp_a = client
        .post(format!("{}/v1/auth/register", base_url))
        .json(&json!({
            "username": "user_a",
            "email": "a@nexus.test",
            "password": "Password123!",
            "display_name": "User Alpha"
        }))
        .send()
        .await
        .unwrap();
    let body_a: Value = resp_a.json().await.unwrap();
    let token_a = body_a["session_token"].as_str().unwrap();

    // Register User B
    let resp_b = client
        .post(format!("{}/v1/auth/register", base_url))
        .json(&json!({
            "username": "user_b",
            "email": "b@nexus.test",
            "password": "Password123!",
            "display_name": "User Beta"
        }))
        .send()
        .await
        .unwrap();
    let body_b: Value = resp_b.json().await.unwrap();
    let token_b = body_b["session_token"].as_str().unwrap();

    // Verify User A receives only User A's data
    let me_a: Value = client
        .get(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me_a["username"], "user_a");
    assert_eq!(me_a["email"], "a@nexus.test");
    assert_eq!(me_a["display_name"], "User Alpha");

    // Verify User B receives only User B's data
    let me_b: Value = client
        .get(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", token_b))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me_b["username"], "user_b");
    assert_eq!(me_b["email"], "b@nexus.test");
    assert_eq!(me_b["display_name"], "User Beta");
}

#[tokio::test]
async fn test_rate_limiting_on_auth_endpoints() {
    let (base_url, _) = setup_test_server().await;
    let client = Client::new();

    let mut last_status = StatusCode::OK;
    // Send 35 requests to trigger the 30 req/min rate limit
    for _ in 0..35 {
        let resp = client
            .post(format!("{}/v1/auth/login", base_url))
            .json(&json!({
                "login": "ratelimit_target",
                "password": "SomePassword"
            }))
            .send()
            .await
            .unwrap();

        last_status = resp.status();
        if last_status == StatusCode::TOO_MANY_REQUESTS {
            break;
        }
    }

    assert_eq!(last_status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn test_09_backend_restart_persistence() {
    let mut config = AppConfig::from_env();
    let test_db_url = config
        .test_database_url
        .clone()
        .unwrap_or_else(|| "postgres://postgres@localhost:5432/nexus_test_db".to_string());
    config.database_url = test_db_url.clone();

    let pool = PgPool::connect(&test_db_url)
        .await
        .expect("Falha ao conectar no banco de testes");

    // Clear and start Server 1
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .unwrap();

    let app1 = create_app(pool.clone(), config.clone());
    let listener1 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr1 = listener1.local_addr().unwrap();

    let server1_handle = tokio::spawn(async move {
        axum::serve(listener1, app1.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });

    let client = Client::new();
    // Register user on Server 1
    let resp = client
        .post(format!("http://{}/v1/auth/register", addr1))
        .json(&json!({
            "username": "persistent_user",
            "email": "persist@nexus.test",
            "password": "Password123!"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body: Value = resp.json().await.unwrap();
    let token = body["session_token"].as_str().unwrap().to_string();

    // Abort Server 1 to simulate restart
    server1_handle.abort();

    // Start Server 2 connected to the exact same Postgres DB
    let app2 = create_app(pool.clone(), config.clone());
    let listener2 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr2 = listener2.local_addr().unwrap();

    tokio::spawn(async move {
        axum::serve(listener2, app2.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });

    // Verify session token is still valid on Server 2
    let me_resp = client
        .get(format!("http://{}/v1/users/me", addr2))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();
    assert_eq!(me_resp.status(), StatusCode::OK);
    let me_body: Value = me_resp.json().await.unwrap();
    assert_eq!(me_body["username"], "persistent_user");
}

#[tokio::test]
async fn test_11_idempotent_migrations() {
    let config = AppConfig::from_env();
    let test_db_url = config
        .test_database_url
        .unwrap_or_else(|| "postgres://postgres@localhost:5432/nexus_test_db".to_string());

    let pool = PgPool::connect(&test_db_url).await.unwrap();

    // Run migrations twice to verify idempotency
    let res1 = sqlx::migrate!("./migrations").run(&pool).await;
    assert!(res1.is_ok(), "Primeira execução de migração deve suceder");

    let res2 = sqlx::migrate!("./migrations").run(&pool).await;
    assert!(res2.is_ok(), "Segunda execução de migração repetida deve ser idempotente");
}
