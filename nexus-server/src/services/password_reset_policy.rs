//! Pure, database-free security primitives for the password recovery flow.
//!
//! This module intentionally depends only on `std`, `rand`, `sha2` and `hex`
//! (no `crate::` imports) so that the adversarial test-suite
//! `tests/password_reset_security_tests.rs` can include it directly and run
//! fully offline, without a live PostgreSQL instance at compile time.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Raw token entropy: 32 bytes = 256 bits from the OS CSPRNG.
pub const RESET_TOKEN_BYTES: usize = 32;
/// Hex-encoded raw token length.
pub const RESET_TOKEN_HEX_LEN: usize = RESET_TOKEN_BYTES * 2;
/// Token lifetime (exactly 15 minutes).
pub const RESET_TOKEN_TTL_MINUTES: i64 = 15;

pub const PASSWORD_MIN_CHARS: usize = 8;
pub const PASSWORD_MAX_CHARS: usize = 128;
/// RFC 5321 practical upper bound for a full address.
pub const MAX_EMAIL_LEN: usize = 254;

/// Per-IP budget for `POST /v1/auth/password/forgot`.
pub const FORGOT_MAX_PER_IP: usize = 10;
/// Per-normalized-e-mail budget for `POST /v1/auth/password/forgot`.
pub const FORGOT_MAX_PER_EMAIL: usize = 3;
/// Sliding window shared by both forgot-password limiters.
pub const FORGOT_WINDOW: Duration = Duration::from_secs(15 * 60);
/// Upper bound on tracked keys per limiter (bounded memory under flooding).
pub const FORGOT_MAX_TRACKED_KEYS: usize = 8192;

/// Uniform response for every forgot-password request (existing, Google-only,
/// unknown, malformed or e-mail-throttled addresses alike).
pub const FORGOT_PASSWORD_GENERIC_MESSAGE: &str = "Se o endereço informado estiver associado a uma conta NEXUS, enviaremos as instruções de recuperação em instantes.";
pub const RESET_PASSWORD_SUCCESS_MESSAGE: &str =
    "Senha redefinida com sucesso. Faça login com sua nova senha.";

/// Normalizes an e-mail address (`trim().to_lowercase()`).
/// Returns `None` for inputs that can never belong to an account
/// (empty, oversized, missing local/domain part, whitespace or control characters).
pub fn normalize_email(raw: &str) -> Option<String> {
    let email = raw.trim().to_lowercase();
    if email.is_empty() || email.len() > MAX_EMAIL_LEN {
        return None;
    }
    if email.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let at = email.rfind('@')?;
    if at == 0 || at == email.len() - 1 {
        return None;
    }
    Some(email)
}

/// Generates a fresh raw reset token: 32 CSPRNG bytes, lowercase hex (64 chars).
pub fn generate_reset_token() -> String {
    let mut bytes = [0u8; RESET_TOKEN_BYTES];
    OsRng.fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    // Best-effort wipe of the stack copy.
    bytes.iter_mut().for_each(|b| *b = 0);
    token
}

/// SHA-256 lowercase hex digest of a raw token. Only this value is persisted.
pub fn hash_reset_token(raw_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw_token.as_bytes());
    hex::encode(hasher.finalize())
}

/// Canonicalizes a user-supplied token (trim + ASCII lowercase) and rejects
/// anything that is not exactly 64 hex characters, so malformed or oversized
/// input never reaches the database.
pub fn normalize_reset_token(raw: &str) -> Option<String> {
    let token = raw.trim();
    if token.len() != RESET_TOKEN_HEX_LEN || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(token.to_ascii_lowercase())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordPolicyError {
    TooShort,
    TooLong,
    Blank,
}

impl PasswordPolicyError {
    pub fn message(&self) -> &'static str {
        match self {
            PasswordPolicyError::TooShort => "A nova senha deve ter no mínimo 8 caracteres.",
            PasswordPolicyError::TooLong => "A nova senha deve ter no máximo 128 caracteres.",
            PasswordPolicyError::Blank => "A nova senha não pode ser composta apenas por espaços.",
        }
    }
}

/// Password policy for resets (same bounds as registration: 8..=128 characters).
pub fn validate_password(password: &str) -> Result<(), PasswordPolicyError> {
    let len = password.chars().count();
    if len < PASSWORD_MIN_CHARS {
        return Err(PasswordPolicyError::TooShort);
    }
    if len > PASSWORD_MAX_CHARS {
        return Err(PasswordPolicyError::TooLong);
    }
    if password.trim().is_empty() {
        return Err(PasswordPolicyError::Blank);
    }
    Ok(())
}

/// Rate-limit key for an e-mail: a domain-separated SHA-256 digest, so the
/// limiter never keeps plaintext addresses in memory.
pub fn email_rate_key(normalized_email: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"nexus:pwreset:email:");
    hasher.update(normalized_email.as_bytes());
    hex::encode(hasher.finalize())
}

/// Bounded sliding-window rate limiter keyed by arbitrary strings.
#[derive(Clone)]
pub struct KeyedRateLimiter {
    inner: Arc<Mutex<HashMap<String, VecDeque<Instant>>>>,
    max_requests: usize,
    window: Duration,
    max_keys: usize,
}

impl KeyedRateLimiter {
    pub fn new(max_requests: usize, window: Duration, max_keys: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            max_requests: max_requests.max(1),
            window,
            max_keys: max_keys.max(1),
        }
    }

    /// Records an attempt for `key` and returns `true` when it is within budget.
    pub fn check(&self, key: &str) -> bool {
        self.check_at(key, Instant::now())
    }

    /// Same as [`check`](Self::check) with an explicit clock (deterministic tests).
    pub fn check_at(&self, key: &str, now: Instant) -> bool {
        let mut map = match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let window = self.window;
        let expired = |t: &Instant| now.saturating_duration_since(*t) >= window;

        if !map.contains_key(key) && map.len() >= self.max_keys {
            map.retain(|_, ts| {
                while ts.front().map_or(false, |t| expired(t)) {
                    ts.pop_front();
                }
                !ts.is_empty()
            });
            if map.len() >= self.max_keys {
                // Evict the key with the oldest most-recent attempt.
                if let Some(victim) = map
                    .iter()
                    .min_by_key(|(_, ts)| ts.back().copied().unwrap_or(now))
                    .map(|(k, _)| k.clone())
                {
                    map.remove(&victim);
                }
            }
        }

        let timestamps = map.entry(key.to_string()).or_default();
        while timestamps.front().map_or(false, |t| expired(t)) {
            timestamps.pop_front();
        }
        if timestamps.len() >= self.max_requests {
            return false;
        }
        timestamps.push_back(now);
        true
    }

    pub fn tracked_keys(&self) -> usize {
        match self.inner.lock() {
            Ok(guard) => guard.len(),
            Err(poisoned) => poisoned.into_inner().len(),
        }
    }
}

/// Per-IP and per-e-mail limiters for the forgot-password endpoint.
#[derive(Clone)]
pub struct ForgotPasswordLimiter {
    pub per_ip: KeyedRateLimiter,
    pub per_email: KeyedRateLimiter,
}

/// Outcome of the forgot-password throttling decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgotThrottle {
    /// Proceed with token issuance (if the account exists).
    Allow,
    /// The client IP exceeded its budget: reject with HTTP 429 (reveals nothing about accounts).
    RejectIp,
    /// The address exceeded its budget: answer with the uniform 200 response but send nothing
    /// (prevents mail-bombing a victim without revealing whether the account exists).
    SilentlyDropEmail,
}

impl Default for ForgotPasswordLimiter {
    fn default() -> Self {
        Self::new(FORGOT_MAX_PER_IP, FORGOT_MAX_PER_EMAIL, FORGOT_WINDOW)
    }
}

impl ForgotPasswordLimiter {
    pub fn new(max_per_ip: usize, max_per_email: usize, window: Duration) -> Self {
        Self {
            per_ip: KeyedRateLimiter::new(max_per_ip, window, FORGOT_MAX_TRACKED_KEYS),
            per_email: KeyedRateLimiter::new(max_per_email, window, FORGOT_MAX_TRACKED_KEYS),
        }
    }

    /// `normalized_email` is `None` for malformed input: it still consumes IP budget.
    pub fn evaluate(&self, client_ip: &str, normalized_email: Option<&str>) -> ForgotThrottle {
        if !self.per_ip.check(&format!("ip:{}", client_ip)) {
            return ForgotThrottle::RejectIp;
        }
        if let Some(email) = normalized_email {
            if !self.per_email.check(&email_rate_key(email)) {
                return ForgotThrottle::SilentlyDropEmail;
            }
        }
        ForgotThrottle::Allow
    }
}
