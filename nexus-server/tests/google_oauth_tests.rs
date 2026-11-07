use std::net::SocketAddr;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::{Client, StatusCode};
use rsa::pkcs8::EncodePrivateKey;
use rsa::traits::PublicKeyParts;
use rsa::RsaPrivateKey;
use serde_json::{json, Value};
use sqlx::PgPool;

use nexus_server::config::AppConfig;
use nexus_server::create_app_with_auth_service;
use nexus_server::repositories::{SessionRepository, UserRepository};
use nexus_server::services::{AuthService, GoogleJwkKey, GoogleJwkSet, GoogleOAuthVerifier};

const TEST_KID: &str = "test-key-id-nexus-01";
const TEST_AUD: &str = "nexus-desktop-dev.apps.googleusercontent.com";
const TEST_ISS: &str = "https://accounts.google.com";

struct TestOAuthContext {
    base_url: String,
    pool: PgPool,
    priv_pem: String,
    wrong_priv_pem: String,
}

fn create_id_token(
    priv_pem: &str,
    kid: &str,
    sub: &str,
    email: &str,
    email_verified: bool,
    aud: &str,
    iss: &str,
    exp_offset_secs: i64,
    nonce: Option<&str>,
) -> String {
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some(kid.to_string());

    let now = chrono::Utc::now().timestamp();
    let claims = json!({
        "iss": iss,
        "aud": aud,
        "sub": sub,
        "email": email,
        "email_verified": email_verified,
        "name": format!("User {}", sub),
        "picture": "https://lh3.googleusercontent.com/test_avatar.png",
        "nonce": nonce,
        "exp": now + exp_offset_secs,
        "iat": now,
    });

    let enc_key = jsonwebtoken::EncodingKey::from_rsa_pem(priv_pem.as_bytes())
        .expect("Chave privada RSA de teste inválida");
    jsonwebtoken::encode(&header, &claims, &enc_key).expect("Falha ao assinar JWT de teste")
}

async fn setup_test_server() -> TestOAuthContext {
    let mut config = AppConfig::from_env();
    let test_db_url = config
        .test_database_url
        .clone()
        .unwrap_or_else(|| "postgres://postgres@localhost:5432/nexus_test_db".to_string());
    config.database_url = test_db_url.clone();
    config.google_client_id = TEST_AUD.to_string();

    let pool = PgPool::connect(&test_db_url)
        .await
        .expect("Falha ao conectar no banco de testes");

    // Clean tables before tests
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("Falha ao limpar tabelas de teste");

    // Generate legitimate RSA key pair for testing
    let mut rng = rand::thread_rng();
    let priv_key = RsaPrivateKey::new(&mut rng, 2048).expect("Falha ao gerar chave RSA de teste");
    let pub_key = priv_key.to_public_key();

    let n_bytes = pub_key.n().to_bytes_be();
    let e_bytes = pub_key.e().to_bytes_be();
    let n_b64 = URL_SAFE_NO_PAD.encode(&n_bytes);
    let e_b64 = URL_SAFE_NO_PAD.encode(&e_bytes);

    let jwk = GoogleJwkKey {
        kty: "RSA".to_string(),
        alg: "RS256".to_string(),
        kid: TEST_KID.to_string(),
        n: n_b64,
        e: e_b64,
    };
    let jwks = GoogleJwkSet { keys: vec![jwk] };
    let priv_pem = priv_key
        .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
        .expect("Falha ao exportar PEM PKCS8")
        .to_string();

    // Generate separate wrong RSA key pair for signature rejection tests
    let wrong_priv_key =
        RsaPrivateKey::new(&mut rng, 2048).expect("Falha ao gerar chave RSA errada");
    let wrong_priv_pem = wrong_priv_key
        .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
        .unwrap()
        .to_string();

    // Create auth service with test Google verifier
    let user_repo = UserRepository::new(pool.clone());
    let session_repo = SessionRepository::new(pool.clone());
    let google_verifier = GoogleOAuthVerifier::new(config.clone()).with_test_jwks(jwks);
    let auth_service = AuthService::new(user_repo, session_repo, config.clone())
        .with_google_verifier(google_verifier);

    let app = create_app_with_auth_service(auth_service, config);

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

    TestOAuthContext {
        base_url: format!("http://{}", addr),
        pool,
        priv_pem,
        wrong_priv_pem,
    }
}

#[tokio::test]
async fn test_01_first_login_creates_account_and_session() {
    let ctx = setup_test_server().await;
    let client = Client::new();

    let sub = "google_sub_1001";
    let email = "alex_google@nexus.test";
    let token = create_id_token(
        &ctx.priv_pem,
        TEST_KID,
        sub,
        email,
        true,
        TEST_AUD,
        TEST_ISS,
        3600,
        Some("test_nonce_abc"),
    );

    let resp = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({
            "id_token": token,
            "nonce": "test_nonce_abc"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["user"]["email"], email);
    assert!(body["session_token"].as_str().unwrap().starts_with("nx_sess_"));

    // Verify database: user_oauth_accounts created and password_hash is NULL
    let oauth_row: (String, String) = sqlx::query_as(
        "SELECT provider, provider_subject FROM user_oauth_accounts WHERE provider_subject = $1",
    )
    .bind(sub)
    .fetch_one(&ctx.pool)
    .await
    .unwrap();

    assert_eq!(oauth_row.0, "google");
    assert_eq!(oauth_row.1, sub);

    let creds_row: (Option<String>,) = sqlx::query_as(
        "SELECT password_hash FROM user_credentials WHERE email = $1",
    )
    .bind(email)
    .fetch_one(&ctx.pool)
    .await
    .unwrap();

    assert_eq!(creds_row.0, None);
}

#[tokio::test]
async fn test_02_login_existing_google_user_reuses_account() {
    let ctx = setup_test_server().await;
    let client = Client::new();

    let sub = "google_sub_2002";
    let email = "existing_google@nexus.test";
    let token = create_id_token(
        &ctx.priv_pem,
        TEST_KID,
        sub,
        email,
        true,
        TEST_AUD,
        TEST_ISS,
        3600,
        None,
    );

    // First login -> creates account
    let resp1 = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": token }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp1.status(), StatusCode::OK);
    let body1: Value = resp1.json().await.unwrap();
    let user_id1 = body1["user"]["id"].as_str().unwrap().to_string();

    // Second login with same Google account -> reuses account
    let token2 = create_id_token(
        &ctx.priv_pem,
        TEST_KID,
        sub,
        email,
        true,
        TEST_AUD,
        TEST_ISS,
        3600,
        None,
    );
    let resp2 = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": token2 }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp2.status(), StatusCode::OK);
    let body2: Value = resp2.json().await.unwrap();
    let user_id2 = body2["user"]["id"].as_str().unwrap();

    assert_eq!(user_id1, user_id2);

    // Verify only 1 oauth account entry exists for this sub
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM user_oauth_accounts WHERE provider = 'google' AND provider_subject = $1",
    )
    .bind(sub)
    .fetch_one(&ctx.pool)
    .await
    .unwrap();
    assert_eq!(count.0, 1);
}

#[tokio::test]
async fn test_03_conflict_email_already_registered_with_password() {
    let ctx = setup_test_server().await;
    let client = Client::new();

    // 1. User registers via traditional email + password
    let conflict_email = "conflict@nexus.test";
    client
        .post(format!("{}/v1/auth/register", ctx.base_url))
        .json(&json!({
            "username": "password_user",
            "email": conflict_email,
            "password": "Password123!"
        }))
        .send()
        .await
        .unwrap();

    // 2. An unlinked Google user tries to sign in with the exact same email
    let token = create_id_token(
        &ctx.priv_pem,
        TEST_KID,
        "different_google_sub_9999",
        conflict_email,
        true,
        TEST_AUD,
        TEST_ISS,
        3600,
        None,
    );

    let resp = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": token }))
        .send()
        .await
        .unwrap();

    // MUST be rejected with 409 Conflict - Never automatically merge accounts!
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let err_body: Value = resp.json().await.unwrap();
    assert_eq!(err_body["error"]["code"], "ACCOUNT_CONFLICT_EMAIL_EXISTS");
}

#[tokio::test]
async fn test_04_authenticated_user_can_link_and_unlink_google() {
    let ctx = setup_test_server().await;
    let client = Client::new();

    // 1. Create traditional password account
    let reg_resp = client
        .post(format!("{}/v1/auth/register", ctx.base_url))
        .json(&json!({
            "username": "link_tester",
            "email": "link_tester@nexus.test",
            "password": "Password123!"
        }))
        .send()
        .await
        .unwrap();
    let reg_body: Value = reg_resp.json().await.unwrap();
    let session_token = reg_body["session_token"].as_str().unwrap();

    // 2. Link Google account while authenticated
    let google_sub = "google_linked_sub_3003";
    let token = create_id_token(
        &ctx.priv_pem,
        TEST_KID,
        google_sub,
        "link_tester@gmail.com",
        true,
        TEST_AUD,
        TEST_ISS,
        3600,
        None,
    );

    let link_resp = client
        .post(format!("{}/v1/auth/google/link", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .json(&json!({ "id_token": token }))
        .send()
        .await
        .unwrap();
    assert_eq!(link_resp.status(), StatusCode::OK);

    // 3. User can now also sign in directly using Google
    let direct_google_resp = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": token }))
        .send()
        .await
        .unwrap();
    assert_eq!(direct_google_resp.status(), StatusCode::OK);
    let direct_body: Value = direct_google_resp.json().await.unwrap();
    assert_eq!(direct_body["user"]["username"], "link_tester");

    // 4. Unlink Google account succeeds because user has a password
    let unlink_resp = client
        .delete(format!("{}/v1/auth/google", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .send()
        .await
        .unwrap();
    assert_eq!(unlink_resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_05_reject_duplicate_link_to_another_account() {
    let ctx = setup_test_server().await;
    let client = Client::new();

    // 1. Register User A with Google
    let google_sub = "shared_sub_4004";
    let token = create_id_token(
        &ctx.priv_pem,
        TEST_KID,
        google_sub,
        "user_a_google@nexus.test",
        true,
        TEST_AUD,
        TEST_ISS,
        3600,
        None,
    );

    client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": token }))
        .send()
        .await
        .unwrap();

    // 2. Register User B with password
    let reg_b = client
        .post(format!("{}/v1/auth/register", ctx.base_url))
        .json(&json!({
            "username": "user_b",
            "email": "user_b@nexus.test",
            "password": "Password123!"
        }))
        .send()
        .await
        .unwrap();
    let reg_b_body: Value = reg_b.json().await.unwrap();
    let session_b = reg_b_body["session_token"].as_str().unwrap();

    // 3. User B attempts to link User A's Google account
    let link_attempt = client
        .post(format!("{}/v1/auth/google/link", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_b))
        .json(&json!({ "id_token": token }))
        .send()
        .await
        .unwrap();

    assert_eq!(link_attempt.status(), StatusCode::CONFLICT);
    let err: Value = link_attempt.json().await.unwrap();
    assert_eq!(err["error"]["code"], "OAUTH_ACCOUNT_ALREADY_LINKED");
}

#[tokio::test]
async fn test_06_reject_invalid_signature_expired_wrong_aud_and_nonce_mismatch() {
    let ctx = setup_test_server().await;
    let client = Client::new();

    // 1. Invalid signature (signed with wrong private key)
    let bad_sig_token = create_id_token(
        &ctx.wrong_priv_pem,
        TEST_KID,
        "sub_bad_sig",
        "bad_sig@nexus.test",
        true,
        TEST_AUD,
        TEST_ISS,
        3600,
        None,
    );
    let resp1 = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": bad_sig_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp1.status(), StatusCode::UNAUTHORIZED);

    // 2. Expired token (exp 300 seconds in the past)
    let expired_token = create_id_token(
        &ctx.priv_pem,
        TEST_KID,
        "sub_expired",
        "expired@nexus.test",
        true,
        TEST_AUD,
        TEST_ISS,
        -300,
        None,
    );
    let resp2 = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": expired_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp2.status(), StatusCode::UNAUTHORIZED);

    // 3. Wrong audience
    let wrong_aud_token = create_id_token(
        &ctx.priv_pem,
        TEST_KID,
        "sub_wrong_aud",
        "wrong_aud@nexus.test",
        true,
        "malicious-rogue-client.apps.googleusercontent.com",
        TEST_ISS,
        3600,
        None,
    );
    let resp3 = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": wrong_aud_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp3.status(), StatusCode::UNAUTHORIZED);

    // 4. Nonce mismatch
    let nonce_token = create_id_token(
        &ctx.priv_pem,
        TEST_KID,
        "sub_nonce",
        "nonce@nexus.test",
        true,
        TEST_AUD,
        TEST_ISS,
        3600,
        Some("actual_token_nonce"),
    );
    let resp4 = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({
            "id_token": nonce_token,
            "nonce": "different_expected_nonce"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp4.status(), StatusCode::UNAUTHORIZED);

    // 5. Unverified email
    let unverified_token = create_id_token(
        &ctx.priv_pem,
        TEST_KID,
        "sub_unverified",
        "unverified@nexus.test",
        false, // email_verified: false
        TEST_AUD,
        TEST_ISS,
        3600,
        None,
    );
    let resp5 = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": unverified_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp5.status(), StatusCode::BAD_REQUEST);
}
