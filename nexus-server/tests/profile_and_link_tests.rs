use std::net::SocketAddr;

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;

use nexus_server::config::AppConfig;
use nexus_server::create_app;
use nexus_server::models::UserProfileResponse;

async fn setup_test_server() -> (String, PgPool) {
    let mut config = AppConfig::from_env();
    let test_db_url = config
        .test_database_url
        .clone()
        .unwrap_or_else(|| "postgres://postgres@localhost:5432/nexus_test_db".to_string());
    config.database_url = test_db_url.clone();
    config.rate_limit_auth_per_minute = 10000;

    let pool = PgPool::connect(&test_db_url)
        .await
        .expect("Falha ao conectar no banco de testes");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Falha ao rodar migrações no banco de teste");

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

async fn register_user(base_url: &str, username: &str, email: &str) -> (String, String) {
    let client = Client::new();
    let res = client
        .post(format!("{}/v1/auth/register", base_url))
        .json(&json!({
            "username": username,
            "email": email,
            "password": "Password123!",
            "display_name": username
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::CREATED);
    let body: Value = res.json().await.unwrap();
    let user_id = body["user"]["id"].as_str().unwrap().to_string();
    let token = body["session_token"].as_str().unwrap().to_string();
    (user_id, token)
}

#[tokio::test]
async fn test_01_profile_query_returns_real_oauth_links_and_password_presence() {
    let (base_url, pool) = setup_test_server().await;
    let client = Client::new();

    // 1. Password-registered user
    let (alice_id, alice_token) = register_user(&base_url, "alice_prf", "alice_prf@nexus.local").await;

    let res = client
        .get(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::OK);
    let profile: UserProfileResponse = res.json().await.unwrap();
    assert_eq!(profile.id.to_string(), alice_id);
    assert_eq!(profile.username, "alice_prf");
    assert_eq!(profile.display_name, "alice_prf");
    assert!(profile.has_password);
    assert!(!profile.has_google);

    // 2. Link Google account directly in database for testing
    let google_sub = "google_sub_alice_12345";
    sqlx::query!(
        "INSERT INTO user_oauth_accounts (user_id, provider, provider_subject) VALUES ($1, 'google', $2)",
        profile.id,
        google_sub
    )
    .execute(&pool)
    .await
    .unwrap();

    // Query again: now has_google must be TRUE!
    let res2 = client
        .get(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .send()
        .await
        .unwrap();

    assert_eq!(res2.status(), StatusCode::OK);
    let profile2: UserProfileResponse = res2.json().await.unwrap();
    assert!(profile2.has_password);
    assert!(profile2.has_google);
}

#[tokio::test]
async fn test_02_update_profile_username_display_name_bio_and_custom_status() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (bob_id, bob_token) = register_user(&base_url, "bob_prf", "bob_prf@nexus.local").await;

    // PATCH /v1/users/me
    let patch_res = client
        .patch(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .json(&json!({
            "username": "bob_new_handle",
            "display_name": "Bob O Construtor",
            "bio": "Engenheiro de Software & Rustacean",
            "custom_status": "Focado desenvolvendo NEXUS"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(patch_res.status(), StatusCode::OK);
    let updated: UserProfileResponse = patch_res.json().await.unwrap();
    assert_eq!(updated.id.to_string(), bob_id);
    assert_eq!(updated.username, "bob_new_handle");
    assert_eq!(updated.display_name, "Bob O Construtor");
    assert_eq!(updated.bio.as_deref(), Some("Engenheiro de Software & Rustacean"));
    assert_eq!(updated.custom_status.as_deref(), Some("Focado desenvolvendo NEXUS"));

    // Verify persistence via fresh GET /v1/users/me
    let get_res = client
        .get(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap();

    assert_eq!(get_res.status(), StatusCode::OK);
    let fresh: UserProfileResponse = get_res.json().await.unwrap();
    assert_eq!(fresh.username, "bob_new_handle");
    assert_eq!(fresh.display_name, "Bob O Construtor");
    assert_eq!(fresh.bio.as_deref(), Some("Engenheiro de Software & Rustacean"));
    assert_eq!(fresh.custom_status.as_deref(), Some("Focado desenvolvendo NEXUS"));
}

#[tokio::test]
async fn test_03_reject_unauthenticated_profile_update() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    // No token
    let res1 = client
        .patch(format!("{}/v1/users/me", base_url))
        .json(&json!({ "display_name": "Hacker" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res1.status(), StatusCode::UNAUTHORIZED);

    // Invalid / fake token
    let res2 = client
        .patch(format!("{}/v1/users/me", base_url))
        .header("Authorization", "Bearer invalid_token_xyz")
        .json(&json!({ "display_name": "Hacker" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res2.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_04_reject_duplicate_username_conflict_409() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_alice_id, alice_token) = register_user(&base_url, "alice_unique", "alice_u@nexus.local").await;
    let (_bob_id, _bob_token) = register_user(&base_url, "bob_unique", "bob_u@nexus.local").await;

    // Alice tries to rename her username to Bob's (case-insensitive test)
    let res = client
        .patch(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({ "username": "BOB_UNIQUE" }))
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::CONFLICT);
    let err_body: Value = res.json().await.unwrap();
    assert_eq!(err_body["error"]["code"], "USERNAME_ALREADY_EXISTS");
}

#[tokio::test]
async fn test_05_username_validation_rules() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_carol_id, carol_token) = register_user(&base_url, "carol_val", "carol_val@nexus.local").await;

    // 1. Too short (< 3 chars)
    let res_short = client
        .patch(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", carol_token))
        .json(&json!({ "username": "ab" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res_short.status(), StatusCode::BAD_REQUEST);

    // 2. Invalid characters (spaces, symbols)
    let res_invalid = client
        .patch(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", carol_token))
        .json(&json!({ "username": "carol name with spaces" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res_invalid.status(), StatusCode::BAD_REQUEST);

    // 3. Invalid characters (dots, special chars)
    let res_symbol = client
        .patch(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", carol_token))
        .json(&json!({ "username": "carol@vance!" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res_symbol.status(), StatusCode::BAD_REQUEST);

    // 4. Empty display_name rejected
    let res_empty_dn = client
        .patch(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", carol_token))
        .json(&json!({ "display_name": "   " }))
        .send()
        .await
        .unwrap();
    assert_eq!(res_empty_dn.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_06_cannot_unlink_last_auth_method_google() {
    let (base_url, pool) = setup_test_server().await;
    let client = Client::new();

    // Create a Google-only user with NULL password_hash
    let user_id = uuid::Uuid::new_v4();
    let token = format!("google_only_tok_{}", user_id.simple());
    let token_hash = nexus_server::services::AuthService::hash_token(&token);

    sqlx::query!(
        "INSERT INTO users (id, username) VALUES ($1, 'google_only_usr')",
        user_id
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query!(
        "INSERT INTO user_credentials (user_id, email, password_hash) VALUES ($1, 'google_only@nexus.local', NULL)",
        user_id
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query!(
        "INSERT INTO user_profiles (user_id, display_name, status) VALUES ($1, 'Google Only User', 'online')",
        user_id
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query!(
        "INSERT INTO user_oauth_accounts (user_id, provider, provider_subject) VALUES ($1, 'google', 'sub_google_only_999')",
        user_id
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query!(
        "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')",
        user_id,
        token_hash
    )
    .execute(&pool)
    .await
    .unwrap();

    // Verify GET /v1/users/me returns has_password = false and has_google = true
    let res_me = client
        .get(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();

    assert_eq!(res_me.status(), StatusCode::OK);
    let me: UserProfileResponse = res_me.json().await.unwrap();
    assert!(!me.has_password);
    assert!(me.has_google);

    // Attempt to unlink Google -> MUST BE REJECTED with 400 Bad Request CANNOT_UNLINK_LAST_AUTH_METHOD
    let res_unlink = client
        .delete(format!("{}/v1/auth/google", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .unwrap();

    assert_eq!(res_unlink.status(), StatusCode::BAD_REQUEST);
    let err_body: Value = res_unlink.json().await.unwrap();
    assert_eq!(err_body["error"]["code"], "CANNOT_UNLINK_LAST_AUTH_METHOD");
}

#[tokio::test]
async fn test_07_unlink_google_permitted_when_password_exists() {
    let (base_url, pool) = setup_test_server().await;
    let client = Client::new();

    let (_dave_id, dave_token) = register_user(&base_url, "dave_link", "dave_link@nexus.local").await;

    // Query me: has_password = true, has_google = false
    let me1: UserProfileResponse = client
        .get(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", dave_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(me1.has_password);
    assert!(!me1.has_google);

    // Link Google account in database
    sqlx::query!(
        "INSERT INTO user_oauth_accounts (user_id, provider, provider_subject) VALUES ($1, 'google', 'dave_sub_123')",
        me1.id
    )
    .execute(&pool)
    .await
    .unwrap();

    // Query me: has_google = true
    let me2: UserProfileResponse = client
        .get(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", dave_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(me2.has_google);

    // Unlink Google via DELETE /v1/auth/google -> Should succeed!
    let res_unlink = client
        .delete(format!("{}/v1/auth/google", base_url))
        .header("Authorization", format!("Bearer {}", dave_token))
        .send()
        .await
        .unwrap();

    assert_eq!(res_unlink.status(), StatusCode::OK);

    // Query me: has_google is now FALSE again
    let me3: UserProfileResponse = client
        .get(format!("{}/v1/users/me", base_url))
        .header("Authorization", format!("Bearer {}", dave_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!me3.has_google);
    assert!(me3.has_password);
}
