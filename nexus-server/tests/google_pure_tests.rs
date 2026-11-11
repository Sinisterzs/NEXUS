//! DB-free tests: compile only config/errors/google_oauth via #[path] so no sqlx
//! `query!` macro (live DB) is needed. Fictitious identities, in-memory RSA keys/JWKS.
#![allow(dead_code)]
#[path = "../src/config/mod.rs"]
pub mod config;
#[path = "../src/errors/mod.rs"]
pub mod errors;
#[path = "../src/services/google_oauth.rs"]
mod google_oauth;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use config::AppConfig;
use errors::{email_conflict_error, AppError};
use google_oauth::{GoogleJwkKey, GoogleJwkSet, GoogleOAuthVerifier, NoncePolicy};
use rsa::pkcs8::EncodePrivateKey;
use rsa::traits::PublicKeyParts;
use rsa::RsaPrivateKey;
use serde_json::json;

const AUD: &str = "fictitious-client.apps.example";
const KID: &str = "kid-1";
const ISS: &str = "https://accounts.google.com";

struct Keys {
    pem: String,
    wrong_pem: String,
    verifier: GoogleOAuthVerifier,
}

fn cfg() -> AppConfig {
    AppConfig {
        database_url: String::new(),
        test_database_url: None,
        server_host: "127.0.0.1".into(),
        server_port: 0,
        session_ttl_hours: 1,
        rate_limit_auth_per_minute: 100,
        google_client_id: AUD.into(),
        google_client_secret: None,
        google_jwks_url: "http://127.0.0.1:1/disabled".into(),
        tailscale_ip: None,
        public_fqdn: None,
        trust_proxy_headers: false,
        turn_secret: None,
        turn_server: None,
    }
}

fn keys() -> Keys {
    let mut rng = rand::thread_rng();
    let k = RsaPrivateKey::new(&mut rng, 2048).unwrap();
    let w = RsaPrivateKey::new(&mut rng, 2048).unwrap();
    let p = k.to_public_key();
    let jwks = GoogleJwkSet {
        keys: vec![GoogleJwkKey {
            kty: "RSA".into(),
            alg: "RS256".into(),
            kid: KID.into(),
            n: URL_SAFE_NO_PAD.encode(p.n().to_bytes_be()),
            e: URL_SAFE_NO_PAD.encode(p.e().to_bytes_be()),
        }],
    };
    Keys {
        pem: k.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF).unwrap().to_string(),
        wrong_pem: w.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF).unwrap().to_string(),
        verifier: GoogleOAuthVerifier::new(cfg()).with_nonce_policy(NoncePolicy::LogOnly).with_test_jwks(jwks),
    }
}

fn token(pem: &str, sub: &str, email: &str, verified: bool, aud: &str, iss: &str, exp: i64, nonce: Option<&str>) -> String {
    let mut h = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    h.kid = Some(KID.into());
    let now = chrono::Utc::now().timestamp();
    let claims = json!({"iss":iss,"aud":aud,"sub":sub,"email":email,"email_verified":verified,
        "nonce":nonce,"exp":now+exp,"iat":now});
    jsonwebtoken::encode(&h, &claims, &jsonwebtoken::EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap()).unwrap()
}

// Cases 1/2/3/9 (identity key level): the verified (iss,sub) is stable across repeated
// validations / "restarts" (a fresh verifier), so lookups key on the same value.
#[tokio::test]
async fn valid_token_yields_stable_sub_across_repeats_and_restart() {
    let k = keys();
    let t = token(&k.pem, "sub-alice", "alice@example.test", true, AUD, ISS, 600, Some("n1"));
    let a = k.verifier.verify_id_token(&t, Some("n1")).await.unwrap();
    let b = k.verifier.verify_id_token(&t, Some("n1")).await.unwrap();
    assert_eq!(a.sub, b.sub);
    assert_eq!(a.sub, "sub-alice");
    // "accounts.google.com" issuer form is also accepted
    let t2 = token(&k.pem, "sub-alice", "alice@example.test", true, AUD, "accounts.google.com", 600, None);
    assert_eq!(k.verifier.verify_id_token(&t2, None).await.unwrap().sub, "sub-alice");
}

// Case 6: same e-mail, different sub => different identity keys (never equal by e-mail).
#[tokio::test]
async fn different_sub_same_email_is_a_different_identity() {
    let k = keys();
    let a = k.verifier.verify_id_token(&token(&k.pem, "sub-1", "x@example.test", true, AUD, ISS, 600, None), None).await.unwrap();
    let b = k.verifier.verify_id_token(&token(&k.pem, "sub-2", "x@example.test", true, AUD, ISS, 600, None), None).await.unwrap();
    assert_eq!(a.email, b.email);
    assert_ne!(a.sub, b.sub);
}

// Case 8: invalid / expired / tampered tokens are rejected.
#[tokio::test]
async fn invalid_tokens_are_rejected() {
    let k = keys();
    let v = &k.verifier;
    let bad = |r: Result<_, AppError>| assert!(matches!(r, Err(AppError::InvalidOAuthToken(_))));
    bad(v.verify_id_token(&token(&k.pem, "s", "e@example.test", true, AUD, ISS, -3600, None), None).await.map(|_| ()));
    bad(v.verify_id_token(&token(&k.wrong_pem, "s", "e@example.test", true, AUD, ISS, 600, None), None).await.map(|_| ()));
    bad(v.verify_id_token(&token(&k.pem, "s", "e@example.test", true, "other-aud", ISS, 600, None), None).await.map(|_| ()));
    bad(v.verify_id_token(&token(&k.pem, "s", "e@example.test", true, AUD, "https://evil.example", 600, None), None).await.map(|_| ()));
    bad(v.verify_id_token(&token(&k.pem, "s", "e@example.test", true, AUD, ISS, 600, Some("a")), Some("b")).await.map(|_| ()));
    bad(v.verify_id_token("not.a.jwt", None).await.map(|_| ()));
    let unverified = v.verify_id_token(&token(&k.pem, "s", "e@example.test", false, AUD, ISS, 600, None), None).await;
    assert!(matches!(unverified, Err(AppError::OAuthEmailNotVerified)));
}

// Cases 4/5/6/7: e-mail collision is never a login; classification never suggests an
// impossible "use your password" for a password-less account.
#[test]
fn email_conflict_classification() {
    let e = email_conflict_error(true);
    assert!(matches!(e, AppError::AccountConflictEmailExists));
    assert_eq!(e.error_code(), "ACCOUNT_CONFLICT_EMAIL_EXISTS");
    let e = email_conflict_error(false);
    assert!(matches!(e, AppError::GoogleIdentityNotLinked));
    assert_eq!(e.error_code(), "GOOGLE_IDENTITY_NOT_LINKED");
    assert!(!e.to_string().to_lowercase().contains("sua senha"));
    assert_eq!(e.status_code(), axum::http::StatusCode::CONFLICT);
}

// Nonce policy. Default (unset env) is Enforce; wrong nonce is always rejected.
#[test]
fn nonce_policy_parsing_defaults_to_enforce() {
    assert_eq!(NoncePolicy::parse(None), NoncePolicy::Enforce);
    assert_eq!(NoncePolicy::parse(Some("enforce")), NoncePolicy::Enforce);
    assert_eq!(NoncePolicy::parse(Some("garbage")), NoncePolicy::Enforce);
    assert_eq!(NoncePolicy::parse(Some(" LOG-ONLY ")), NoncePolicy::LogOnly);
    assert_eq!(NoncePolicy::parse(Some("false")), NoncePolicy::LogOnly);
}

#[tokio::test]
async fn missing_nonce_rejected_when_enforced_accepted_in_compat_mode() {
    let k = keys();
    let t = token(&k.pem, "sub-n", "n@example.test", true, AUD, ISS, 600, Some("n-1"));
    let enforce = k.verifier.clone().with_nonce_policy(NoncePolicy::Enforce);
    assert!(matches!(enforce.verify_id_token(&t, None).await, Err(AppError::InvalidOAuthToken(_))));
    assert!(matches!(enforce.verify_id_token(&t, Some("  ")).await, Err(AppError::InvalidOAuthToken(_))));
    assert_eq!(enforce.missing_nonce_count(), 2);
    let compat = k.verifier.clone().with_nonce_policy(NoncePolicy::LogOnly);
    assert_eq!(compat.verify_id_token(&t, None).await.unwrap().sub, "sub-n");
    assert_eq!(compat.missing_nonce_count(), 3); // counter is shared across clones
    // correct nonce works under both and does not bump the counter
    assert!(enforce.verify_id_token(&t, Some("n-1")).await.is_ok());
    assert_eq!(enforce.missing_nonce_count(), 3);
}

#[tokio::test]
async fn wrong_nonce_and_replay_with_other_nonce_always_rejected() {
    let k = keys();
    let t = token(&k.pem, "sub-r", "r@example.test", true, AUD, ISS, 600, Some("real"));
    for policy in [NoncePolicy::Enforce, NoncePolicy::LogOnly] {
        let v = k.verifier.clone().with_nonce_policy(policy);
        assert!(matches!(v.verify_id_token(&t, Some("attacker")).await, Err(AppError::InvalidOAuthToken(_))));
        // token without nonce claim presented with an expected nonce
        let t0 = token(&k.pem, "sub-r", "r@example.test", true, AUD, ISS, 600, None);
        assert!(matches!(v.verify_id_token(&t0, Some("real")).await, Err(AppError::InvalidOAuthToken(_))));
    }
}