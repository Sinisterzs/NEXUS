//! Adversarial and pure security tests for the NEXUS v0.2.5 password recovery flow.
//!
//! Includes the password-reset modules directly via `#[path]` so the suite has zero
//! compile-time database dependencies (`sqlx::query!`) and runs completely offline.

#![allow(dead_code)]

#[path = "../src/config/mod.rs"]
pub mod config;
#[path = "../src/errors/mod.rs"]
pub mod errors;
#[path = "../src/models/mod.rs"]
pub mod models;
#[path = "../src/services/email.rs"]
pub mod email;
#[path = "../src/services/password_reset_policy.rs"]
pub mod password_reset_policy;

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::http::StatusCode;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use rand::rngs::OsRng;
use uuid::Uuid;

use config::{
    EmailConfig, EmailProviderKind, DEFAULT_EMAIL_FROM, DEFAULT_PASSWORD_RESET_URL,
    DEFAULT_RESEND_API_URL,
};
use email::{
    build_reset_link, is_secure_endpoint, render_password_reset_email, EmailError, EmailService,
};
use errors::AppError;
use models::{
    ForgotPasswordRequest, MessageResponse, ResetPasswordRequest, VerifyResetTokenRequest,
    VerifyResetTokenResponse,
};
use password_reset_policy::{
    email_rate_key, generate_reset_token, hash_reset_token, normalize_email,
    normalize_reset_token, validate_password, ForgotPasswordLimiter, ForgotThrottle,
    KeyedRateLimiter, PasswordPolicyError, FORGOT_MAX_PER_EMAIL, FORGOT_MAX_PER_IP,
    FORGOT_PASSWORD_GENERIC_MESSAGE, RESET_PASSWORD_SUCCESS_MESSAGE, RESET_TOKEN_BYTES,
    RESET_TOKEN_HEX_LEN, RESET_TOKEN_TTL_MINUTES,
};

// ============================================================================
// Reference in-memory state machine mirroring the SQL transaction semantics of
// `PasswordResetService` (`src/services/password_reset.rs`) for offline
// adversarial verification of single-use, expiration, session revocation,
// and Google-only account recovery.
// ============================================================================

#[derive(Clone, Debug)]
struct AccountRecord {
    user_id: Uuid,
    email: String,
    password_hash: Option<String>,
    oauth_links: Vec<(String, String)>, // (provider, provider_subject)
}

#[derive(Clone, Debug)]
struct ResetTokenRecord {
    id: Uuid,
    user_id: Uuid,
    token_hash: String,
    expires_at: DateTime<Utc>,
    used_at: Option<DateTime<Utc>>,
    request_ip: Option<String>,
}

struct InMemoryRecoveryHarness {
    accounts_by_id: HashMap<Uuid, AccountRecord>,
    user_id_by_email: HashMap<String, Uuid>,
    tokens: Vec<ResetTokenRecord>,
    active_sessions: HashMap<Uuid, Vec<Uuid>>, // user_id -> session_ids
    limiter: ForgotPasswordLimiter,
    email_service: EmailService,
    outbox: email::EmailOutbox,
    now: DateTime<Utc>,
}

impl InMemoryRecoveryHarness {
    fn new() -> Self {
        let (email_service, outbox) = EmailService::in_memory();
        Self {
            accounts_by_id: HashMap::new(),
            user_id_by_email: HashMap::new(),
            tokens: Vec::new(),
            active_sessions: HashMap::new(),
            limiter: ForgotPasswordLimiter::default(),
            email_service,
            outbox,
            now: Utc::now(),
        }
    }

    fn advance_time(&mut self, delta: ChronoDuration) {
        self.now = self.now + delta;
    }

    fn hash_password(password: &str) -> String {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .expect("argon2id hash")
            .to_string()
    }

    fn verify_password(password: &str, hash: &str) -> bool {
        let parsed = PasswordHash::new(hash).expect("valid phc hash");
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    }

    fn create_password_user(&mut self, email: &str, password: &str) -> Uuid {
        let norm = normalize_email(email).expect("valid email");
        let user_id = Uuid::new_v4();
        let hash = Self::hash_password(password);
        self.accounts_by_id.insert(
            user_id,
            AccountRecord {
                user_id,
                email: norm.clone(),
                password_hash: Some(hash),
                oauth_links: Vec::new(),
            },
        );
        self.user_id_by_email.insert(norm, user_id);
        self.active_sessions
            .insert(user_id, vec![Uuid::new_v4(), Uuid::new_v4()]);
        user_id
    }

    fn create_google_only_user(&mut self, email: &str, google_sub: &str) -> Uuid {
        let norm = normalize_email(email).expect("valid email");
        let user_id = Uuid::new_v4();
        self.accounts_by_id.insert(
            user_id,
            AccountRecord {
                user_id,
                email: norm.clone(),
                password_hash: None,
                oauth_links: vec![("google".to_string(), google_sub.to_string())],
            },
        );
        self.user_id_by_email.insert(norm, user_id);
        self.active_sessions.insert(user_id, vec![Uuid::new_v4()]);
        user_id
    }

    /// Mirrors `POST /v1/auth/password/forgot`.
    async fn forgot_password(
        &mut self,
        raw_email: &str,
        client_ip: &str,
    ) -> Result<(StatusCode, MessageResponse), AppError> {
        let normalized = normalize_email(raw_email);
        match self.limiter.evaluate(client_ip, normalized.as_deref()) {
            ForgotThrottle::RejectIp => return Err(AppError::RateLimited),
            ForgotThrottle::SilentlyDropEmail => {
                return Ok((
                    StatusCode::OK,
                    MessageResponse {
                        message: FORGOT_PASSWORD_GENERIC_MESSAGE.to_string(),
                    },
                ));
            }
            ForgotThrottle::Allow => {}
        }

        if let Some(norm_email) = normalized {
            if let Some(&user_id) = self.user_id_by_email.get(&norm_email) {
                // Invalidate previous pending tokens for this user
                self.tokens
                    .retain(|t| !(t.user_id == user_id && t.used_at.is_none()));

                let raw_token = generate_reset_token();
                let token_hash = hash_reset_token(&raw_token);
                // Guard against accidental plaintext storage
                assert_ne!(raw_token, token_hash);

                self.tokens.push(ResetTokenRecord {
                    id: Uuid::new_v4(),
                    user_id,
                    token_hash,
                    expires_at: self.now + ChronoDuration::minutes(RESET_TOKEN_TTL_MINUTES),
                    used_at: None,
                    request_ip: Some(client_ip.to_string()),
                });

                let msg = render_password_reset_email(
                    &norm_email,
                    &raw_token,
                    &self.email_service.config().reset_url_base,
                    RESET_TOKEN_TTL_MINUTES,
                );
                self.email_service.send(&msg).await.expect("in-memory send");
            }
        }

        Ok((
            StatusCode::OK,
            MessageResponse {
                message: FORGOT_PASSWORD_GENERIC_MESSAGE.to_string(),
            },
        ))
    }

    /// Mirrors `POST /v1/auth/password/verify` (non-consuming).
    fn verify_token(&self, raw_token: &str) -> Result<VerifyResetTokenResponse, AppError> {
        let token =
            normalize_reset_token(raw_token).ok_or(AppError::ResetTokenInvalidOrExpired)?;
        let token_hash = hash_reset_token(&token);
        let active = self.tokens.iter().any(|t| {
            t.token_hash == token_hash && t.used_at.is_none() && t.expires_at > self.now
        });
        if active {
            Ok(VerifyResetTokenResponse { valid: true })
        } else {
            Err(AppError::ResetTokenInvalidOrExpired)
        }
    }

    /// Mirrors `POST /v1/auth/password/reset`.
    fn reset_password(
        &mut self,
        raw_token: &str,
        new_password: &str,
    ) -> Result<MessageResponse, AppError> {
        // 1. Validate password policy BEFORE touching or consuming the token
        validate_password(new_password)
            .map_err(|e| AppError::ResetPasswordWeak(e.message().to_string()))?;

        // 2. Normalize & hash token
        let token =
            normalize_reset_token(raw_token).ok_or(AppError::ResetTokenInvalidOrExpired)?;
        let token_hash = hash_reset_token(&token);

        // 3. Atomic single-use consumption:
        //    UPDATE password_reset_tokens SET used_at = NOW()
        //    WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        //    RETURNING user_id
        let now = self.now;
        let user_id = {
            let record = self
                .tokens
                .iter_mut()
                .find(|t| t.token_hash == token_hash && t.used_at.is_none() && t.expires_at > now)
                .ok_or(AppError::ResetTokenInvalidOrExpired)?;
            record.used_at = Some(now);
            record.user_id
        };

        // 4. Update credentials with Argon2id without touching OAuth links
        let new_hash = Self::hash_password(new_password);
        let account = self
            .accounts_by_id
            .get_mut(&user_id)
            .ok_or(AppError::ResetTokenInvalidOrExpired)?;
        account.password_hash = Some(new_hash);

        // 5. Invalidate any remaining unused reset tokens for this user
        self.tokens
            .retain(|t| !(t.user_id == user_id && t.used_at.is_none()));

        // 6. Revoke ALL active sessions for this user
        if let Some(sessions) = self.active_sessions.get_mut(&user_id) {
            sessions.clear();
        }

        Ok(MessageResponse {
            message: RESET_PASSWORD_SUCCESS_MESSAGE.to_string(),
        })
    }
}

fn extract_token_from_email(msg: &email::EmailMessage) -> String {
    msg.text
        .lines()
        .find_map(|line| line.strip_prefix("Código: "))
        .expect("email contains Código line")
        .trim()
        .to_string()
}

// ============================================================================
// 1. Migration contract & SQL reversibility tests
// ============================================================================

#[test]
fn migration_defines_required_schema_indexes_and_down_comment() {
    let sql = include_str!("../migrations/20261111000001_password_reset_tokens.sql");

    assert!(sql.contains("CREATE TABLE IF NOT EXISTS password_reset_tokens"));
    assert!(sql.contains("id UUID PRIMARY KEY DEFAULT gen_random_uuid()"));
    assert!(sql.contains("user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE"));
    assert!(sql.contains("token_hash VARCHAR(64) NOT NULL UNIQUE"));
    assert!(sql.contains("expires_at TIMESTAMPTZ NOT NULL"));
    assert!(sql.contains("used_at TIMESTAMPTZ NULL"));
    assert!(sql.contains("request_ip VARCHAR(64) NULL"));
    assert!(sql.contains("created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"));

    // Indexes on user_id, token_hash, and expires_at
    assert!(sql.contains("ON password_reset_tokens(user_id)"));
    assert!(sql.contains("ON password_reset_tokens(token_hash)"));
    assert!(sql.contains("ON password_reset_tokens(expires_at)"));

    // Explicit reversibility comment
    assert!(sql.contains("DOWN: DROP TABLE IF EXISTS password_reset_tokens;"));

    // Never defines a plaintext token column
    for line in sql.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("--") {
            assert!(
                !trimmed.starts_with("token ") && !trimmed.starts_with("raw_token "),
                "Migration must never persist raw tokens: {}",
                trimmed
            );
        }
    }
}

// ============================================================================
// 2. Cryptographic token generation, hashing & normalization tests
// ============================================================================

#[test]
fn generated_tokens_are_256_bit_hex_unique_and_hashed_with_sha256() {
    assert_eq!(RESET_TOKEN_BYTES, 32);
    assert_eq!(RESET_TOKEN_HEX_LEN, 64);
    assert_eq!(RESET_TOKEN_TTL_MINUTES, 15);

    let mut raw_seen = HashSet::new();
    let mut hash_seen = HashSet::new();

    for _ in 0..512 {
        let raw = generate_reset_token();
        assert_eq!(raw.len(), 64);
        assert!(raw.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));

        let hashed = hash_reset_token(&raw);
        assert_eq!(hashed.len(), 64);
        assert!(hashed.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
        assert_ne!(raw, hashed, "Token hash must never equal raw token");

        // Deterministic hashing
        assert_eq!(hashed, hash_reset_token(&raw));

        assert!(raw_seen.insert(raw), "CSPRNG collision on raw token");
        assert!(hash_seen.insert(hashed), "SHA-256 collision on token hash");
    }
}

#[test]
fn normalize_reset_token_accepts_canonical_hex_and_rejects_adversarial_inputs() {
    let valid_raw = generate_reset_token();
    let upper = valid_raw.to_uppercase();
    let padded = format!("  \t{}\r\n ", upper);

    assert_eq!(normalize_reset_token(&padded).as_deref(), Some(valid_raw.as_str()));

    let invalid_inputs = [
        "",
        "   ",
        "deadbeef",
        &"a".repeat(63),
        &"a".repeat(65),
        // 64 chars with one non-hex character 'g'
        &format!("{}g", "a".repeat(63)),
        // SQL injection attempt of length 64
        "' OR '1'='1' -- aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        // Null byte injection
        &format!("{}\0", "a".repeat(63)),
    ];

    for bad in invalid_inputs {
        assert_eq!(
            normalize_reset_token(bad),
            None,
            "Adversarial token input should be rejected before DB query: {:?}",
            bad
        );
    }
}

// ============================================================================
// 3. E-mail normalization & header-injection rejection tests
// ============================================================================

#[test]
fn normalize_email_trims_lowercases_and_blocks_header_injection() {
    assert_eq!(
        normalize_email("  Alice.User+Tag@Example.COM \n"),
        Some("alice.user+tag@example.com".to_string())
    );

    let rejected = [
        "",
        "   ",
        "plainaddress",
        "@missing-local.com",
        "missing-domain@",
        "has space@example.com",
        "victim@example.com\r\nBcc: attacker@evil.example",
        "victim@example.com\nSubject: Injected",
        "null\0byte@example.com",
        &format!("{}@example.com", "a".repeat(250)),
    ];

    for input in rejected {
        assert_eq!(
            normalize_email(input),
            None,
            "Malformed or adversarial e-mail must be rejected: {:?}",
            input
        );
    }
}

// ============================================================================
// 4. Password policy validation tests
// ============================================================================

#[test]
fn password_policy_enforces_bounds_and_rejects_blank_passwords() {
    assert_eq!(validate_password(""), Err(PasswordPolicyError::TooShort));
    assert_eq!(validate_password("7chars!"), Err(PasswordPolicyError::TooShort));
    assert_eq!(validate_password("        "), Err(PasswordPolicyError::Blank));
    assert_eq!(
        validate_password(&"x".repeat(129)),
        Err(PasswordPolicyError::TooLong)
    );

    assert_eq!(validate_password("8chars!!"), Ok(()));
    assert_eq!(validate_password(&"x".repeat(128)), Ok(()));
    assert_eq!(validate_password("SenhaForte#2026!"), Ok(()));
}

// ============================================================================
// 5. End-to-end stateful security tests: non-enumeration, single-use,
//    expiration, weak-password non-consumption, Google-only recovery,
//    and full session revocation
// ============================================================================

#[tokio::test]
async fn forgot_password_returns_uniform_response_for_existing_google_and_unknown_accounts() {
    let mut harness = InMemoryRecoveryHarness::new();
    harness.create_password_user("known@nexus.test", "InitialPass!123");
    harness.create_google_only_user("google-only@nexus.test", "google-sub-999");

    let (status_known, body_known) = harness
        .forgot_password("  KNOWN@nexus.test ", "198.51.100.10")
        .await
        .unwrap();
    let (status_google, body_google) = harness
        .forgot_password("GOOGLE-ONLY@nexus.test", "198.51.100.11")
        .await
        .unwrap();
    let (status_unknown, body_unknown) = harness
        .forgot_password("nonexistent@nexus.test", "198.51.100.12")
        .await
        .unwrap();
    let (status_malformed, body_malformed) = harness
        .forgot_password("not-an-email", "198.51.100.13")
        .await
        .unwrap();

    assert_eq!(status_known, StatusCode::OK);
    assert_eq!(status_google, StatusCode::OK);
    assert_eq!(status_unknown, StatusCode::OK);
    assert_eq!(status_malformed, StatusCode::OK);

    assert_eq!(body_known.message, FORGOT_PASSWORD_GENERIC_MESSAGE);
    assert_eq!(body_google.message, FORGOT_PASSWORD_GENERIC_MESSAGE);
    assert_eq!(body_unknown.message, FORGOT_PASSWORD_GENERIC_MESSAGE);
    assert_eq!(body_malformed.message, FORGOT_PASSWORD_GENERIC_MESSAGE);

    // Exactly 2 e-mails sent (known password user + Google-only user), 0 for unknown/malformed
    let sent = harness.outbox.lock().unwrap();
    assert_eq!(sent.len(), 2);
}

#[tokio::test]
async fn token_is_single_use_and_weak_password_does_not_consume_token() {
    let mut harness = InMemoryRecoveryHarness::new();
    let user_id = harness.create_password_user("alice@nexus.test", "OldPassword!123");
    assert_eq!(harness.active_sessions[&user_id].len(), 2);

    harness
        .forgot_password("alice@nexus.test", "203.0.113.5")
        .await
        .unwrap();
    let raw_token = {
        let sent = harness.outbox.lock().unwrap();
        extract_token_from_email(&sent[0])
    };

    // 1. Verify succeeds multiple times without consuming the token
    assert!(harness.verify_token(&raw_token).unwrap().valid);
    assert!(harness.verify_token(&raw_token.to_uppercase()).unwrap().valid);

    // 2. Weak password fails with RESET_PASSWORD_WEAK BEFORE consuming the token
    let weak_err = harness.reset_password(&raw_token, "short").unwrap_err();
    assert_eq!(weak_err.error_code(), "RESET_PASSWORD_WEAK");
    assert_eq!(weak_err.status_code(), StatusCode::BAD_REQUEST);
    assert!(
        harness.verify_token(&raw_token).unwrap().valid,
        "Token must remain valid when password validation fails"
    );
    assert_eq!(
        harness.active_sessions[&user_id].len(),
        2,
        "Sessions must not be revoked on failed reset attempt"
    );

    // 3. Valid password consumes the token atomically, updates Argon2id hash, and revokes all sessions
    let reset_ok = harness
        .reset_password(&raw_token, "NewStrongPassword!2026")
        .unwrap();
    assert_eq!(reset_ok.message, RESET_PASSWORD_SUCCESS_MESSAGE);

    let updated_hash = harness.accounts_by_id[&user_id]
        .password_hash
        .as_deref()
        .unwrap();
    assert!(InMemoryRecoveryHarness::verify_password(
        "NewStrongPassword!2026",
        updated_hash
    ));
    assert!(!InMemoryRecoveryHarness::verify_password(
        "OldPassword!123",
        updated_hash
    ));
    assert!(
        harness.active_sessions[&user_id].is_empty(),
        "All active sessions must be revoked after password reset"
    );

    // 4. Replay of the same token is rejected on both verify and reset
    let verify_replay = harness.verify_token(&raw_token).unwrap_err();
    assert_eq!(verify_replay.error_code(), "RESET_TOKEN_INVALID_OR_EXPIRED");
    assert_eq!(verify_replay.status_code(), StatusCode::BAD_REQUEST);

    let reset_replay = harness
        .reset_password(&raw_token, "AnotherPassword!2026")
        .unwrap_err();
    assert_eq!(reset_replay.error_code(), "RESET_TOKEN_INVALID_OR_EXPIRED");
}

#[tokio::test]
async fn issuing_new_token_invalidates_previous_pending_tokens_and_ttl_is_15_minutes() {
    let mut harness = InMemoryRecoveryHarness::new();
    harness.create_password_user("bob@nexus.test", "InitialPass!123");

    harness
        .forgot_password("bob@nexus.test", "203.0.113.20")
        .await
        .unwrap();
    harness
        .forgot_password("bob@nexus.test", "203.0.113.20")
        .await
        .unwrap();

    let (first_token, second_token) = {
        let sent = harness.outbox.lock().unwrap();
        assert_eq!(sent.len(), 2);
        (
            extract_token_from_email(&sent[0]),
            extract_token_from_email(&sent[1]),
        )
    };
    assert_ne!(first_token, second_token);

    // First token was invalidated when the second was issued
    assert_eq!(
        harness.verify_token(&first_token).unwrap_err().error_code(),
        "RESET_TOKEN_INVALID_OR_EXPIRED"
    );
    assert!(harness.verify_token(&second_token).unwrap().valid);

    // At 14 minutes 59 seconds the second token is still valid
    harness.advance_time(ChronoDuration::seconds(14 * 60 + 59));
    assert!(harness.verify_token(&second_token).unwrap().valid);

    // At 15 minutes 0 seconds it is expired
    harness.advance_time(ChronoDuration::seconds(1));
    assert_eq!(
        harness.verify_token(&second_token).unwrap_err().error_code(),
        "RESET_TOKEN_INVALID_OR_EXPIRED"
    );
    assert_eq!(
        harness
            .reset_password(&second_token, "ValidPassword!123")
            .unwrap_err()
            .error_code(),
        "RESET_TOKEN_INVALID_OR_EXPIRED"
    );
}

#[tokio::test]
async fn google_only_account_can_set_local_password_without_altering_oauth_links() {
    let mut harness = InMemoryRecoveryHarness::new();
    let user_id = harness.create_google_only_user("oauth@nexus.test", "google-subject-42");
    assert!(harness.accounts_by_id[&user_id].password_hash.is_none());

    harness
        .forgot_password("oauth@nexus.test", "203.0.113.42")
        .await
        .unwrap();
    let token = {
        let sent = harness.outbox.lock().unwrap();
        extract_token_from_email(&sent[0])
    };

    harness
        .reset_password(&token, "NowHasLocalPass!99")
        .expect("Google-only user can establish local password after proving email ownership");

    let acc = &harness.accounts_by_id[&user_id];
    let pw_hash = acc.password_hash.as_deref().expect("password_hash set");
    assert!(InMemoryRecoveryHarness::verify_password(
        "NowHasLocalPass!99",
        pw_hash
    ));
    // OAuth identity links remain untouched
    assert_eq!(
        acc.oauth_links,
        vec![("google".to_string(), "google-subject-42".to_string())]
    );
    // Active sessions were revoked
    assert!(harness.active_sessions[&user_id].is_empty());
}

// ============================================================================
// 6. Rate limiting & anti-flooding tests (per-IP and per-normalized-email)
// ============================================================================

#[test]
fn forgot_password_rate_limiter_enforces_ip_and_normalized_email_budgets() {
    let limiter = ForgotPasswordLimiter::new(
        FORGOT_MAX_PER_IP,
        FORGOT_MAX_PER_EMAIL,
        Duration::from_secs(900),
    );

    // Same email with case differences maps to the exact same hashed rate-limit key
    let norm1 = normalize_email("Victim@Example.com").unwrap();
    let norm2 = normalize_email("  victim@example.com ").unwrap();
    assert_eq!(email_rate_key(&norm1), email_rate_key(&norm2));
    assert!(!email_rate_key(&norm1).contains("victim"));

    // Per-email budget: 3 allowed across rotating IPs, 4th silently dropped (no enumeration)
    for i in 1..=FORGOT_MAX_PER_EMAIL {
        let ip = format!("198.51.100.{}", i);
        assert_eq!(limiter.evaluate(&ip, Some(&norm1)), ForgotThrottle::Allow);
    }
    assert_eq!(
        limiter.evaluate("198.51.100.99", Some(&norm2)),
        ForgotThrottle::SilentlyDropEmail
    );

    // Per-IP budget: after FORGOT_MAX_PER_IP requests from a single IP, RejectIp (HTTP 429)
    let attacker_ip = "203.0.113.250";
    for i in 0..FORGOT_MAX_PER_IP {
        let target = format!("target{}@example.com", i);
        assert_eq!(
            limiter.evaluate(attacker_ip, Some(&target)),
            ForgotThrottle::Allow
        );
    }
    assert_eq!(
        limiter.evaluate(attacker_ip, Some("another@example.com")),
        ForgotThrottle::RejectIp
    );
}

#[test]
fn keyed_rate_limiter_bounds_memory_and_expires_old_windows() {
    let limiter = KeyedRateLimiter::new(2, Duration::from_secs(60), 16);
    let t0 = Instant::now();

    for i in 0..100 {
        let key = format!("ip:10.0.0.{}", i);
        assert!(limiter.check_at(&key, t0));
        assert!(
            limiter.tracked_keys() <= 16,
            "Tracked keys exceeded cap: {}",
            limiter.tracked_keys()
        );
    }

    // After the window elapses, a blocked key is allowed again
    let k = "ip:10.0.0.99";
    assert!(limiter.check_at(k, t0));
    assert!(!limiter.check_at(k, t0));
    let t_after = t0 + Duration::from_secs(61);
    assert!(limiter.check_at(k, t_after));
}

// ============================================================================
// 7. EmailService configuration, HTTPS enforcement & redaction tests
// ============================================================================

#[test]
fn email_config_parses_providers_and_fails_closed_when_misconfigured() {
    let disabled = EmailConfig::from_lookup(|_| None);
    assert_eq!(disabled.provider, EmailProviderKind::Disabled);
    assert_eq!(disabled.from, DEFAULT_EMAIL_FROM);
    assert_eq!(disabled.reset_url_base, DEFAULT_PASSWORD_RESET_URL);
    assert!(disabled.delivery_problem().is_some());

    let resend_missing_key = EmailConfig::from_lookup(|k| match k {
        "NEXUS_EMAIL_PROVIDER" => Some("resend".into()),
        _ => None,
    });
    assert_eq!(resend_missing_key.provider, EmailProviderKind::Resend);
    assert_eq!(
        resend_missing_key.api_url.as_deref(),
        Some(DEFAULT_RESEND_API_URL)
    );
    assert!(resend_missing_key.delivery_problem().is_some());

    let resend_ready = EmailConfig::from_lookup(|k| match k {
        "NEXUS_EMAIL_PROVIDER" => Some("RESEND".into()),
        "NEXUS_EMAIL_API_KEY" => Some("re_secret_test_key_123".into()),
        "NEXUS_EMAIL_FROM" => Some("NEXUS Security <security@nexus.app>".into()),
        _ => None,
    });
    assert_eq!(resend_ready.provider, EmailProviderKind::Resend);
    assert_eq!(resend_ready.delivery_problem(), None);
    assert!(!format!("{:?}", resend_ready).contains("re_secret_test_key_123"));

    let smtp_cfg = EmailConfig::from_lookup(|k| match k {
        "NEXUS_EMAIL_PROVIDER" => Some("smtp".into()),
        _ => None,
    });
    assert_eq!(smtp_cfg.provider, EmailProviderKind::Smtp);
    assert!(smtp_cfg.delivery_problem().is_some());
}

#[tokio::test]
async fn email_service_refuses_insecure_non_loopback_http_endpoints() {
    assert!(is_secure_endpoint("https://api.resend.com/emails"));
    assert!(is_secure_endpoint("http://127.0.0.1:4025/webhook"));
    assert!(is_secure_endpoint("http://localhost:8025/send"));
    assert!(is_secure_endpoint("http://[::1]:8025/send"));

    assert!(!is_secure_endpoint("http://api.resend.com/emails"));
    assert!(!is_secure_endpoint("http://198.51.100.10/webhook"));
    assert!(!is_secure_endpoint("ftp://files.example.com/mail"));

    let insecure_cfg = EmailConfig {
        provider: EmailProviderKind::Webhook,
        api_url: Some("http://evil.example.com/collect".to_string()),
        api_key: Some("secret-token".to_string()),
        from: DEFAULT_EMAIL_FROM.to_string(),
        reset_url_base: DEFAULT_PASSWORD_RESET_URL.to_string(),
    };
    let svc = EmailService::from_config(insecure_cfg);
    let msg = render_password_reset_email(
        "user@example.com",
        &generate_reset_token(),
        DEFAULT_PASSWORD_RESET_URL,
        15,
    );
    assert_eq!(svc.send(&msg).await, Err(EmailError::InsecureEndpoint));
}

#[test]
fn debug_representations_never_leak_tokens_emails_or_passwords() {
    let raw_token = generate_reset_token();
    let victim_email = "sensitive-user@private.example";
    let secret_password = "UltraSecretPassword!2026";

    let email_msg = render_password_reset_email(
        victim_email,
        &raw_token,
        DEFAULT_PASSWORD_RESET_URL,
        RESET_TOKEN_TTL_MINUTES,
    );
    assert!(email_msg.text.contains(&build_reset_link(
        DEFAULT_PASSWORD_RESET_URL,
        &raw_token
    )));

    let dbg_msg = format!("{:?}", email_msg);
    assert!(!dbg_msg.contains(&raw_token));
    assert!(!dbg_msg.contains(victim_email));

    let dbg_forgot = format!(
        "{:?}",
        ForgotPasswordRequest {
            email: victim_email.to_string()
        }
    );
    let dbg_verify = format!(
        "{:?}",
        VerifyResetTokenRequest {
            token: raw_token.clone()
        }
    );
    let dbg_reset = format!(
        "{:?}",
        ResetPasswordRequest {
            token: raw_token.clone(),
            new_password: secret_password.to_string(),
        }
    );

    assert!(!dbg_forgot.contains(victim_email));
    assert!(!dbg_verify.contains(&raw_token));
    assert!(!dbg_reset.contains(&raw_token));
    assert!(!dbg_reset.contains(secret_password));
}
