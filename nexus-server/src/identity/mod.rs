use base64::prelude::*;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone)]
pub struct ServerIdentity {
    key_pair: Arc<Ed25519KeyPair>,
    pub public_key_base64: String,
    pub server_id: String,
    pub identity_path: PathBuf,
}

impl ServerIdentity {
    pub fn load_or_generate(custom_path: Option<&str>) -> Result<Self, String> {
        let path = if let Some(p) = custom_path {
            PathBuf::from(p)
        } else if let Ok(env_path) = std::env::var("SERVER_IDENTITY_FILE") {
            PathBuf::from(env_path.trim())
        } else {
            // Default paths
            #[cfg(windows)]
            {
                let base = std::env::var("APPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_else(|_| PathBuf::from("."));
                base.join("nexus-server").join("server_identity.pk8")
            }
            #[cfg(not(windows))]
            {
                if PathBuf::from("/opt/nexus").exists() {
                    PathBuf::from("/opt/nexus/server_identity.pk8")
                } else {
                    PathBuf::from("server_identity.pk8")
                }
            }
        };

        if path.exists() {
            let bytes = fs::read(&path)
                .map_err(|e| format!("Falha ao ler chave de identidade do servidor: {}", e))?;
            let key_pair = Ed25519KeyPair::from_pkcs8(&bytes)
                .map_err(|e| format!("Chave PKCS#8 Ed25519 inválida ou corrompida: {}", e))?;
            let pub_bytes = key_pair.public_key().as_ref();
            let public_key_base64 = BASE64_STANDARD.encode(pub_bytes);
            let server_id = format!("nexus-id-{}", hex::encode(Sha256::digest(pub_bytes)));

            tracing::info!(
                "Identidade estável do servidor carregada de {}. ID: {}",
                path.display(),
                server_id
            );

            return Ok(Self {
                key_pair: Arc::new(key_pair),
                public_key_base64,
                server_id,
                identity_path: path,
            });
        }

        // Generate new Ed25519 key pair
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng)
            .map_err(|e| format!("Falha ao gerar chave Ed25519 do servidor: {}", e))?;

        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        fs::write(&path, pkcs8.as_ref())
            .map_err(|e| format!("Falha ao salvar chave de identidade: {}", e))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }

        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
            .map_err(|e| format!("Falha ao inicializar par de chaves recém-criado: {}", e))?;
        let pub_bytes = key_pair.public_key().as_ref();
        let public_key_base64 = BASE64_STANDARD.encode(pub_bytes);
        let server_id = format!("nexus-id-{}", hex::encode(Sha256::digest(pub_bytes)));

        tracing::info!(
            "Nova identidade estável do servidor criada e salva em {}. ID: {}",
            path.display(),
            server_id
        );

        Ok(Self {
            key_pair: Arc::new(key_pair),
            public_key_base64,
            server_id,
            identity_path: path,
        })
    }

    pub fn generate_ephemeral() -> Self {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("ephemeral key gen");
        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("key pair from pkcs8");
        let pub_bytes = key_pair.public_key().as_ref();
        let public_key_base64 = BASE64_STANDARD.encode(pub_bytes);
        let server_id = format!("nexus-id-{}", hex::encode(Sha256::digest(pub_bytes)));

        Self {
            key_pair: Arc::new(key_pair),
            public_key_base64,
            server_id,
            identity_path: PathBuf::from(":memory:"),
        }
    }

    pub fn sign_channel_challenge(
        &self,
        client_nonce: &str,
        target_url: &str,
        client_timestamp: i64,
        server_nonce: &str,
    ) -> String {
        let message = format!(
            "NEXUS-V1-CHANNEL-BIND:{}:{}:{}:{}",
            client_nonce, target_url, client_timestamp, server_nonce
        );
        let signature = self.key_pair.sign(message.as_bytes());
        BASE64_STANDARD.encode(signature.as_ref())
    }
}
