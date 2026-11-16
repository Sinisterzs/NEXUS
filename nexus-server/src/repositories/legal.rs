use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::errors::AppError;
use crate::models::{
    LegalDocument, LegalDocumentType, LegalRecordType, UserAgeDeclaration, UserLegalAcceptance,
};

#[derive(Clone)]
pub struct LegalRepository {
    pool: PgPool,
}

impl LegalRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Computes canonical SHA-256 hex digest from normalized document representation.
    pub fn canonical_document_hash(
        doc_type: LegalDocumentType,
        version: &str,
        content_markdown: Option<&str>,
        official_url: Option<&str>,
    ) -> String {
        let normalized_md = content_markdown
            .unwrap_or("")
            .replace("\r\n", "\n")
            .trim()
            .to_string();
        let normalized_url = official_url.unwrap_or("").trim().to_string();

        let canonical = format!(
            "doc_type={}\nversion={}\nmarkdown={}\nurl={}",
            doc_type.as_str(),
            version.trim(),
            normalized_md,
            normalized_url
        );

        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Validates that a document has non-empty content or official URL before publishing.
    pub fn has_valid_content(
        content_markdown: Option<&str>,
        official_url: Option<&str>,
    ) -> bool {
        let md_ok = content_markdown.map(|s| !s.trim().is_empty()).unwrap_or(false);
        let url_ok = official_url.map(|s| !s.trim().is_empty()).unwrap_or(false);
        md_ok || url_ok
    }

    /// Lists all legal documents ordered by type and creation date.
    pub async fn list_documents(&self) -> Result<Vec<LegalDocument>, AppError> {
        let docs = sqlx::query_as::<_, LegalDocument>(
            r#"
            SELECT id, doc_type, version, content_markdown, official_url, content_hash,
                   status, published_at, effective_at, created_at, updated_at
            FROM legal_documents
            ORDER BY doc_type ASC, created_at DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(docs)
    }

    /// Retrieves a specific version of a legal document.
    pub async fn get_document_version(
        &self,
        doc_type: LegalDocumentType,
        version: &str,
    ) -> Result<Option<LegalDocument>, AppError> {
        let doc = sqlx::query_as::<_, LegalDocument>(
            r#"
            SELECT id, doc_type, version, content_markdown, official_url, content_hash,
                   status, published_at, effective_at, created_at, updated_at
            FROM legal_documents
            WHERE doc_type = $1 AND version = $2
            "#,
        )
        .bind(doc_type.as_str())
        .bind(version)
        .fetch_optional(&self.pool)
        .await?;

        Ok(doc)
    }

    /// Deterministically identifies the currently effective published version of a document.
    pub async fn get_current_document(
        &self,
        doc_type: LegalDocumentType,
    ) -> Result<Option<LegalDocument>, AppError> {
        let doc = sqlx::query_as::<_, LegalDocument>(
            r#"
            SELECT id, doc_type, version, content_markdown, official_url, content_hash,
                   status, published_at, effective_at, created_at, updated_at
            FROM legal_documents
            WHERE doc_type = $1
              AND status = 'published'
              AND effective_at IS NOT NULL
              AND effective_at <= NOW()
            ORDER BY effective_at DESC, published_at DESC, created_at DESC
            LIMIT 1
            "#,
        )
        .bind(doc_type.as_str())
        .fetch_optional(&self.pool)
        .await?;

        Ok(doc)
    }

    /// Records an acceptance or acknowledgement idempotently inside a transaction.
    /// Rejects if the referenced document does not exist, is not published, or has a mismatched hash.
    pub async fn record_acceptance_tx(
        tx: &mut Transaction<'_, Postgres>,
        user_id: Uuid,
        doc_type: LegalDocumentType,
        doc_version: &str,
        doc_hash: &str,
        record_type: LegalRecordType,
        flow_origin: &str,
        app_version: Option<&str>,
    ) -> Result<UserLegalAcceptance, AppError> {
        let doc = sqlx::query_as::<_, LegalDocument>(
            r#"
            SELECT id, doc_type, version, content_markdown, official_url, content_hash,
                   status, published_at, effective_at, created_at, updated_at
            FROM legal_documents
            WHERE doc_type = $1 AND version = $2
            "#,
        )
        .bind(doc_type.as_str())
        .bind(doc_version)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Documento legal não encontrado.".to_string()))?;

        if doc.status != "published" {
            return Err(AppError::ValidationError(
                "Documento legal não está publicado.".to_string(),
            ));
        }

        if doc.content_hash != doc_hash {
            return Err(AppError::ValidationError(
                "Hash do documento legal incompatível.".to_string(),
            ));
        }

        if record_type != doc_type.default_record_type() {
            return Err(AppError::ValidationError(
                "Tipo de registro incompatível com a natureza do documento.".to_string(),
            ));
        }

        let inserted = sqlx::query_as::<_, UserLegalAcceptance>(
            r#"
            INSERT INTO user_legal_acceptances (
                user_id, doc_type, doc_version, doc_hash, record_type, flow_origin, app_version
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (user_id, doc_type, doc_version) DO NOTHING
            RETURNING id, user_id, doc_type, doc_version, doc_hash, record_type,
                      recorded_at, flow_origin, app_version
            "#,
        )
        .bind(user_id)
        .bind(doc_type.as_str())
        .bind(doc_version)
        .bind(doc_hash)
        .bind(record_type.as_str())
        .bind(flow_origin)
        .bind(app_version)
        .fetch_optional(&mut **tx)
        .await?;

        if let Some(record) = inserted {
            return Ok(record);
        }

        let existing = sqlx::query_as::<_, UserLegalAcceptance>(
            r#"
            SELECT id, user_id, doc_type, doc_version, doc_hash, record_type,
                   recorded_at, flow_origin, app_version
            FROM user_legal_acceptances
            WHERE user_id = $1 AND doc_type = $2 AND doc_version = $3
            "#,
        )
        .bind(user_id)
        .bind(doc_type.as_str())
        .bind(doc_version)
        .fetch_one(&mut **tx)
        .await?;

        if existing.doc_hash != doc_hash || existing.record_type != record_type.as_str() {
            return Err(AppError::ValidationError(
                "Registro existente diverge em hash ou tipo de registro.".to_string(),
            ));
        }

        Ok(existing)
    }

    /// Lists all legal acceptance/acknowledgement records for a user.
    pub async fn list_user_acceptances(
        &self,
        user_id: Uuid,
    ) -> Result<Vec<UserLegalAcceptance>, AppError> {
        let records = sqlx::query_as::<_, UserLegalAcceptance>(
            r#"
            SELECT id, user_id, doc_type, doc_version, doc_hash, record_type,
                   recorded_at, flow_origin, app_version
            FROM user_legal_acceptances
            WHERE user_id = $1
            ORDER BY recorded_at DESC
            "#,
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(records)
    }

    /// Checks whether a user has accepted/acknowledged a specific document version.
    pub async fn has_accepted_version(
        &self,
        user_id: Uuid,
        doc_type: LegalDocumentType,
        version: &str,
    ) -> Result<bool, AppError> {
        let exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM user_legal_acceptances
                WHERE user_id = $1 AND doc_type = $2 AND doc_version = $3
            )
            "#,
        )
        .bind(user_id)
        .bind(doc_type.as_str())
        .bind(version)
        .fetch_one(&self.pool)
        .await?;

        Ok(exists)
    }

    /// Returns currently effective documents that the user has not yet accepted/acknowledged.
    pub async fn missing_current_documents(
        &self,
        user_id: Uuid,
    ) -> Result<Vec<LegalDocument>, AppError> {
        let mut missing = Vec::new();
        for doc_type in [LegalDocumentType::TermsOfUse, LegalDocumentType::PrivacyPolicy] {
            if let Some(current) = self.get_current_document(doc_type).await? {
                if !self
                    .has_accepted_version(user_id, doc_type, &current.version)
                    .await?
                {
                    missing.push(current);
                }
            }
        }
        Ok(missing)
    }

    /// Records an explicit 16+ age declaration idempotently inside a transaction.
    pub async fn record_age_declaration_tx(
        tx: &mut Transaction<'_, Postgres>,
        user_id: Uuid,
        confirmed: bool,
        flow_origin: &str,
        app_version: Option<&str>,
    ) -> Result<UserAgeDeclaration, AppError> {
        let inserted = sqlx::query_as::<_, UserAgeDeclaration>(
            r#"
            INSERT INTO user_age_declarations (
                user_id, minimum_age, confirmed, flow_origin, app_version
            )
            VALUES ($1, 16, $2, $3, $4)
            ON CONFLICT (user_id, minimum_age) WHERE confirmed = TRUE DO NOTHING
            RETURNING id, user_id, minimum_age, confirmed, declared_at, flow_origin, app_version
            "#,
        )
        .bind(user_id)
        .bind(confirmed)
        .bind(flow_origin)
        .bind(app_version)
        .fetch_optional(&mut **tx)
        .await?;

        if let Some(record) = inserted {
            return Ok(record);
        }

        let existing = sqlx::query_as::<_, UserAgeDeclaration>(
            r#"
            SELECT id, user_id, minimum_age, confirmed, declared_at, flow_origin, app_version
            FROM user_age_declarations
            WHERE user_id = $1 AND minimum_age = 16 AND confirmed = TRUE
            LIMIT 1
            "#,
        )
        .bind(user_id)
        .fetch_one(&mut **tx)
        .await?;

        Ok(existing)
    }

    /// Checks whether the user has an explicit 16+ age confirmation.
    pub async fn has_confirmed_age(&self, user_id: Uuid) -> Result<bool, AppError> {
        let exists: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM user_age_declarations
                WHERE user_id = $1 AND minimum_age = 16 AND confirmed = TRUE
            )
            "#,
        )
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;

        Ok(exists)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_hash_normalizes_line_endings_and_whitespace() {
        let h1 = LegalRepository::canonical_document_hash(
            LegalDocumentType::TermsOfUse,
            "1.0.0",
            Some("  Linha 1\r\nLinha 2  "),
            None,
        );
        let h2 = LegalRepository::canonical_document_hash(
            LegalDocumentType::TermsOfUse,
            "1.0.0",
            Some("Linha 1\nLinha 2"),
            Some("   "),
        );
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn canonical_hash_detects_content_or_type_changes() {
        let h_terms = LegalRepository::canonical_document_hash(
            LegalDocumentType::TermsOfUse,
            "1.0.0",
            Some("Texto"),
            None,
        );
        let h_privacy = LegalRepository::canonical_document_hash(
            LegalDocumentType::PrivacyPolicy,
            "1.0.0",
            Some("Texto"),
            None,
        );
        assert_ne!(h_terms, h_privacy);
    }

    #[test]
    fn valid_content_requires_markdown_or_url() {
        assert!(!LegalRepository::has_valid_content(None, None));
        assert!(!LegalRepository::has_valid_content(Some("   "), Some("")));
        assert!(LegalRepository::has_valid_content(Some("# Termos"), None));
        assert!(LegalRepository::has_valid_content(
            None,
            Some("https://nexus.example/terms")
        ));
    }
}
