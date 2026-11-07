use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use jsonwebtoken::{decode, decode_header, DecodingKey, Validation};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::config::AppConfig;
use crate::errors::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleIdTokenClaims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub email: String,
    pub email_verified: Option<bool>,
    pub name: Option<String>,
    pub picture: Option<String>,
    pub nonce: Option<String>,
    pub exp: usize,
    pub iat: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleJwkKey {
    pub kty: String,
    pub alg: String,
    pub kid: String,
    pub n: String,
    pub e: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleJwkSet {
    pub keys: Vec<GoogleJwkKey>,
}

#[derive(Clone)]
pub struct GoogleOAuthVerifier {
    config: AppConfig,
    http_client: Client,
    jwks_cache: Arc<RwLock<Option<(Instant, GoogleJwkSet)>>>,
    // Optional static test JWKS used during automated tests
    test_jwks: Option<GoogleJwkSet>,
}

impl GoogleOAuthVerifier {
    pub fn new(config: AppConfig) -> Self {
        let http_client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();

        Self {
            config,
            http_client,
            jwks_cache: Arc::new(RwLock::new(None)),
            test_jwks: None,
        }
    }

    pub fn with_test_jwks(mut self, jwks: GoogleJwkSet) -> Self {
        self.test_jwks = Some(jwks);
        self
    }

    /// Fetches Google's public JWKS keys from Google or from in-memory cache
    async fn get_jwks(&self) -> Result<GoogleJwkSet, AppError> {
        if let Some(ref jwks) = self.test_jwks {
            return Ok(jwks.clone());
        }

        // Check cache (TTL 1 hour)
        {
            let cache = self.jwks_cache.read().await;
            if let Some((fetched_at, ref jwks)) = *cache {
                if fetched_at.elapsed() < Duration::from_secs(3600) {
                    return Ok(jwks.clone());
                }
            }
        }

        // Fetch from Google endpoint
        let resp = self
            .http_client
            .get(&self.config.google_jwks_url)
            .send()
            .await
            .map_err(|e| {
                AppError::InternalError(format!("Falha ao conectar com endpoint JWKS do Google: {}", e))
            })?;

        if !resp.status().is_success() {
            return Err(AppError::InternalError(format!(
                "Endpoint JWKS do Google retornou HTTP {}",
                resp.status()
            )));
        }

        let jwks: GoogleJwkSet = resp.json().await.map_err(|e| {
            AppError::InternalError(format!("Resposta JWKS do Google inválida: {}", e))
        })?;

        // Update cache
        {
            let mut cache = self.jwks_cache.write().await;
            *cache = Some((Instant::now(), jwks.clone()));
        }

        Ok(jwks)
    }

    /// Validates a Google ID Token according to OpenID Connect specification:
    /// 1. RS256 signature against Google's public JWKs
    /// 2. Issuer (https://accounts.google.com or accounts.google.com)
    /// 3. Audience (matches Google Client ID)
    /// 4. Expiration
    /// 5. Nonce (if expected)
    /// 6. Email verification
    pub async fn verify_id_token(
        &self,
        id_token: &str,
        expected_nonce: Option<&str>,
    ) -> Result<GoogleIdTokenClaims, AppError> {
        let header = decode_header(id_token)
            .map_err(|e| AppError::InvalidOAuthToken(format!("Cabeçalho JWT inválido: {}", e)))?;

        let kid = header
            .kid
            .ok_or_else(|| AppError::InvalidOAuthToken("Token do Google sem Key ID (kid)".to_string()))?;

        let jwks = self.get_jwks().await?;
        let key = jwks
            .keys
            .iter()
            .find(|k| k.kid == kid)
            .ok_or_else(|| {
                AppError::InvalidOAuthToken(format!("Chave pública do Google não encontrada para kid: {}", kid))
            })?;

        let decoding_key = DecodingKey::from_rsa_components(&key.n, &key.e)
            .map_err(|e| AppError::InvalidOAuthToken(format!("Componentes RSA do Google inválidos: {}", e)))?;

        let mut validation = Validation::new(jsonwebtoken::Algorithm::RS256);
        validation.set_issuer(&["https://accounts.google.com", "accounts.google.com"]);
        validation.set_audience(&[&self.config.google_client_id]);

        let token_data = decode::<GoogleIdTokenClaims>(id_token, &decoding_key, &validation)
            .map_err(|e| AppError::InvalidOAuthToken(format!("Validação do token Google falhou: {}", e)))?;

        let claims = token_data.claims;

        // Verify email verification status
        if claims.email_verified != Some(true) {
            return Err(AppError::OAuthEmailNotVerified);
        }

        // Verify nonce binding
        if let Some(expected) = expected_nonce {
            if claims.nonce.as_deref() != Some(expected) {
                return Err(AppError::InvalidOAuthToken(
                    "Nonce do token Google não coincide com a solicitação".to_string(),
                ));
            }
        }

        Ok(claims)
    }

    /// Exchanges an authorization code and PKCE code_verifier for Google tokens at https://oauth2.googleapis.com/token
    pub async fn exchange_authorization_code(
        &self,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
    ) -> Result<String, AppError> {
        let secret = self
            .config
            .google_client_secret
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                AppError::InternalError(
                    "GOOGLE_CLIENT_SECRET não foi carregado no backend (verifique nexus-server/.env)".to_string(),
                )
            })?;

        let form_params = [
            ("client_id", self.config.google_client_id.as_str()),
            ("client_secret", secret),
            ("code", code),
            ("code_verifier", code_verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
        ];

        let resp = self
            .http_client
            .post("https://oauth2.googleapis.com/token")
            .form(&form_params)
            .send()
            .await
            .map_err(|e| {
                AppError::InternalError(format!("Falha na conexão com Google token endpoint: {}", e))
            })?;

        if !resp.status().is_success() {
            let err_body = resp.text().await.unwrap_or_default();
            return Err(AppError::InvalidOAuthToken(format!(
                "Google rejeitou a troca do authorization code: {}",
                err_body
            )));
        }

        let token_data: serde_json::Value = resp.json().await.map_err(|e| {
            AppError::InternalError(format!("Falha ao interpretar resposta do Google: {}", e))
        })?;

        let id_token = token_data["id_token"].as_str().ok_or_else(|| {
            AppError::InvalidOAuthToken("Google não retornou o id_token esperado.".to_string())
        })?;

        Ok(id_token.to_string())
    }
}
