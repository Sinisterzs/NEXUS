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
use nexus_server::models::UserProfileResponse;
use nexus_server::repositories::{SessionRepository, UserRepository};
use nexus_server::services::{AuthService, GoogleJwkKey, GoogleJwkSet, GoogleOAuthVerifier};

const TEST_KID: &str = "test-kid-consistency-01";
const TEST_AUD: &str = "nexus-desktop-dev.apps.googleusercontent.com";
const TEST_ISS: &str = "https://accounts.google.com";

struct TestContext {
    base_url: String,
    #[allow(dead_code)]
    pool: PgPool,
    priv_pem: String,
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

async fn setup_test_server() -> TestContext {
    dotenvy::dotenv().ok();

    let mut config = AppConfig::from_env();
    let test_db_url = config
        .test_database_url
        .clone()
        .unwrap_or_else(|| "postgres://postgres@localhost:5432/nexus_test_db".to_string());
    config.database_url = test_db_url.clone();
    config.google_client_id = TEST_AUD.to_string();

    let pool = PgPool::connect(&test_db_url)
        .await
        .expect("Falha ao conectar ao banco de dados de teste");

    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("Falha ao limpar tabelas de teste");

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

    TestContext {
        base_url: format!("http://{}", addr),
        pool,
        priv_pem,
    }
}

/// Scenario 1 & 2: User registered directly with Google has has_google=true, has_password=false
#[tokio::test]
async fn test_01_google_registration_creates_oauth_link_and_has_google_true() {
    let ctx = setup_test_server().await;
    let client = Client::new();

    let sub = "google_sub_user_01";
    let email = "user01@gmail.com";
    let token = create_id_token(&ctx.priv_pem, TEST_KID, sub, email, true, TEST_AUD, TEST_ISS, 3600, None);

    let res = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": token }))
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = res.json().await.unwrap();

    let session_token = body["session_token"].as_str().unwrap();
    assert_eq!(body["user"]["email"], email);
    assert_eq!(body["user"]["has_google"], true);
    assert_eq!(body["user"]["has_password"], false);

    // Verify GET /v1/users/me returns consistent real PostgreSQL data
    let me_res = client
        .get(format!("{}/v1/users/me", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .send()
        .await
        .unwrap();

    assert_eq!(me_res.status(), StatusCode::OK);
    let me: UserProfileResponse = me_res.json().await.unwrap();
    assert_eq!(me.email, email);
    assert!(me.has_google, "Profile must return has_google = true for Google-registered account");
    assert!(!me.has_password, "Profile must return has_password = false for Google-only account");
}

/// Scenario 3: Recurrent Google login accesses the same identity
#[tokio::test]
async fn test_02_recurrent_google_login_accesses_same_identity() {
    let ctx = setup_test_server().await;
    let client = Client::new();

    let sub = "google_sub_user_02";
    let email = "user02@gmail.com";

    // 1st login (registration)
    let token1 = create_id_token(&ctx.priv_pem, TEST_KID, sub, email, true, TEST_AUD, TEST_ISS, 3600, None);
    let res1 = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": token1 }))
        .send()
        .await
        .unwrap();
    let body1: Value = res1.json().await.unwrap();
    let user_id_1 = body1["user"]["id"].as_str().unwrap().to_string();

    // 2nd login (recurrent login with same Google sub)
    let token2 = create_id_token(&ctx.priv_pem, TEST_KID, sub, email, true, TEST_AUD, TEST_ISS, 3600, None);
    let res2 = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": token2 }))
        .send()
        .await
        .unwrap();
    assert_eq!(res2.status(), StatusCode::OK);
    let body2: Value = res2.json().await.unwrap();
    let user_id_2 = body2["user"]["id"].as_str().unwrap();

    assert_eq!(user_id_1, user_id_2, "Recurrent Google login must return the exact same user identity");
    assert_eq!(body2["user"]["has_google"], true);
    assert_eq!(body2["user"]["has_password"], false);
}

/// Scenario 4 & 5: Account created with password initially has has_google=false, then updates to true upon explicit link
#[tokio::test]
async fn test_03_password_account_linking_updates_has_google_to_true() {
    let ctx = setup_test_server().await;
    let client = Client::new();

    // 1. Register with username & password
    let reg_res = client
        .post(format!("{}/v1/auth/register", ctx.base_url))
        .json(&json!({
            "username": "bob_pass",
            "email": "bob@nexus.local",
            "password": "Password123!",
            "display_name": "Bob Password"
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(reg_res.status(), StatusCode::CREATED);
    let reg_body: Value = reg_res.json().await.unwrap();
    let session_token = reg_body["session_token"].as_str().unwrap();
    assert_eq!(reg_body["user"]["has_google"], false);
    assert_eq!(reg_body["user"]["has_password"], true);

    // Initial check: has_google is FALSE
    let me1_res = client
        .get(format!("{}/v1/users/me", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .send()
        .await
        .unwrap();
    let me1: UserProfileResponse = me1_res.json().await.unwrap();
    assert!(!me1.has_google, "Initially has_google must be false for password accounts");
    assert!(me1.has_password, "Initially has_password must be true for password accounts");

    // 2. Explicitly link Google account
    let google_sub = "google_sub_bob_999";
    let token = create_id_token(&ctx.priv_pem, TEST_KID, google_sub, "bob_google@gmail.com", true, TEST_AUD, TEST_ISS, 3600, None);

    let link_res = client
        .post(format!("{}/v1/auth/google/link", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .json(&json!({ "id_token": token }))
        .send()
        .await
        .unwrap();

    assert_eq!(link_res.status(), StatusCode::OK);
    let link_body: Value = link_res.json().await.unwrap();
    assert!(link_body["message"].as_str().unwrap().contains("vinculada com sucesso"));

    // 3. Query me again: now has_google must be TRUE and has_password must be TRUE
    let me2_res = client
        .get(format!("{}/v1/users/me", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .send()
        .await
        .unwrap();
    let me2: UserProfileResponse = me2_res.json().await.unwrap();
    assert!(me2.has_google, "After linking, has_google must be true");
    assert!(me2.has_password, "After linking, has_password remains true");

    // 4. Verify login via Google now works and resolves to Bob's account!
    let google_login_token = create_id_token(&ctx.priv_pem, TEST_KID, google_sub, "bob_google@gmail.com", true, TEST_AUD, TEST_ISS, 3600, None);
    let google_login_res = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": google_login_token }))
        .send()
        .await
        .unwrap();

    assert_eq!(google_login_res.status(), StatusCode::OK);
    let google_login_body: Value = google_login_res.json().await.unwrap();
    assert_eq!(google_login_body["user"]["username"], "bob_pass");
    assert_eq!(google_login_body["user"]["has_google"], true);
    assert_eq!(google_login_body["user"]["has_password"], true);
}

/// Scenario 6 & 7: Unlinking allowed when password is present; state persists across restart
#[tokio::test]
async fn test_04_unlinking_allowed_when_password_present() {
    let ctx = setup_test_server().await;
    let client = Client::new();

    // Register user with password
    let reg_res = client
        .post(format!("{}/v1/auth/register", ctx.base_url))
        .json(&json!({
            "username": "carol_unlink",
            "email": "carol@nexus.local",
            "password": "Password123!",
            "display_name": "Carol"
        }))
        .send()
        .await
        .unwrap();
    let reg_body: Value = reg_res.json().await.unwrap();
    let session_token = reg_body["session_token"].as_str().unwrap();

    // Link Google
    let sub = "google_sub_carol_888";
    let token = create_id_token(&ctx.priv_pem, TEST_KID, sub, "carol@gmail.com", true, TEST_AUD, TEST_ISS, 3600, None);
    client
        .post(format!("{}/v1/auth/google/link", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .json(&json!({ "id_token": token }))
        .send()
        .await
        .unwrap();

    // Verify linked
    let me1: UserProfileResponse = client
        .get(format!("{}/v1/users/me", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(me1.has_google);

    // Unlink Google
    let unlink_res = client
        .delete(format!("{}/v1/auth/google", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .send()
        .await
        .unwrap();
    assert_eq!(unlink_res.status(), StatusCode::OK);

    // Verify unlinked in /v1/users/me
    let me2: UserProfileResponse = client
        .get(format!("{}/v1/users/me", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!me2.has_google, "After unlink, has_google must be false");
    assert!(me2.has_password, "has_password remains true");
}

/// Scenario 8: Block unlinking if Google is the sole authentication method
#[tokio::test]
async fn test_05_block_unlinking_sole_google_auth_method() {
    let ctx = setup_test_server().await;
    let client = Client::new();

    // Register via Google (no password)
    let sub = "google_sub_sole_auth";
    let token = create_id_token(&ctx.priv_pem, TEST_KID, sub, "sole@gmail.com", true, TEST_AUD, TEST_ISS, 3600, None);
    let res = client
        .post(format!("{}/v1/auth/google", ctx.base_url))
        .json(&json!({ "id_token": token }))
        .send()
        .await
        .unwrap();
    let body: Value = res.json().await.unwrap();
    let session_token = body["session_token"].as_str().unwrap();

    // Attempt to unlink Google: MUST BE BLOCKED!
    let unlink_res = client
        .delete(format!("{}/v1/auth/google", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .send()
        .await
        .unwrap();

    assert_eq!(unlink_res.status(), StatusCode::BAD_REQUEST);
    let err_body: Value = unlink_res.json().await.unwrap();
    assert_eq!(err_body["error"]["code"], "CANNOT_UNLINK_LAST_AUTH_METHOD");

    // has_google must still be TRUE
    let me: UserProfileResponse = client
        .get(format!("{}/v1/users/me", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(me.has_google, "Account must remain linked since unlink was rejected");
}

/// Scenario 9: Prevent linking a Google account already associated with another user
#[tokio::test]
async fn test_06_reject_linking_google_already_associated_with_another_account() {
    let ctx = setup_test_server().await;
    let client = Client::new();

    // User A registers with password and links Google account X
    let reg_a: Value = client
        .post(format!("{}/v1/auth/register", ctx.base_url))
        .json(&json!({
            "username": "user_a",
            "email": "user_a@nexus.local",
            "password": "Password123!"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token_a = reg_a["session_token"].as_str().unwrap();

    let shared_google_sub = "google_shared_sub_777";
    let google_token = create_id_token(&ctx.priv_pem, TEST_KID, shared_google_sub, "shared@gmail.com", true, TEST_AUD, TEST_ISS, 3600, None);

    let link_a = client
        .post(format!("{}/v1/auth/google/link", ctx.base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "id_token": google_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(link_a.status(), StatusCode::OK);

    // User B registers with password and tries to link the SAME Google account X
    let reg_b: Value = client
        .post(format!("{}/v1/auth/register", ctx.base_url))
        .json(&json!({
            "username": "user_b",
            "email": "user_b@nexus.local",
            "password": "Password123!"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token_b = reg_b["session_token"].as_str().unwrap();

    let link_b = client
        .post(format!("{}/v1/auth/google/link", ctx.base_url))
        .header("Authorization", format!("Bearer {}", token_b))
        .json(&json!({ "id_token": google_token }))
        .send()
        .await
        .unwrap();

    assert_eq!(link_b.status(), StatusCode::CONFLICT);
    let err_b: Value = link_b.json().await.unwrap();
    assert_eq!(err_b["error"]["code"], "OAUTH_ACCOUNT_ALREADY_LINKED");
}

/// Scenario 10: Prevent linking a second Google account if user already has one linked
#[tokio::test]
async fn test_07_prevent_linking_second_google_account_to_same_user() {
    let ctx = setup_test_server().await;
    let client = Client::new();

    let reg_res: Value = client
        .post(format!("{}/v1/auth/register", ctx.base_url))
        .json(&json!({
            "username": "user_double_link",
            "email": "double@nexus.local",
            "password": "Password123!"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let session_token = reg_res["session_token"].as_str().unwrap();

    // Link 1st Google account
    let sub1 = "google_sub_first_001";
    let token1 = create_id_token(&ctx.priv_pem, TEST_KID, sub1, "first@gmail.com", true, TEST_AUD, TEST_ISS, 3600, None);
    let link1 = client
        .post(format!("{}/v1/auth/google/link", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .json(&json!({ "id_token": token1 }))
        .send()
        .await
        .unwrap();
    assert_eq!(link1.status(), StatusCode::OK);

    // Attempt to link 2nd DIFFERENT Google account: must be rejected with 400
    let sub2 = "google_sub_second_002";
    let token2 = create_id_token(&ctx.priv_pem, TEST_KID, sub2, "second@gmail.com", true, TEST_AUD, TEST_ISS, 3600, None);
    let link2 = client
        .post(format!("{}/v1/auth/google/link", ctx.base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .json(&json!({ "id_token": token2 }))
        .send()
        .await
        .unwrap();

    assert_eq!(link2.status(), StatusCode::BAD_REQUEST);
    let err2: Value = link2.json().await.unwrap();
    assert!(err2["error"]["message"].as_str().unwrap().contains("já possui uma conta Google vinculada"));
}
