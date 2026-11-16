use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegalDocumentType {
    TermsOfUse,
    PrivacyPolicy,
}

impl LegalDocumentType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::TermsOfUse => "terms_of_use",
            Self::PrivacyPolicy => "privacy_policy",
        }
    }

    pub fn default_record_type(&self) -> LegalRecordType {
        match self {
            Self::TermsOfUse => LegalRecordType::Acceptance,
            Self::PrivacyPolicy => LegalRecordType::Acknowledgement,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegalDocumentStatus {
    Draft,
    Published,
    Retired,
}

impl LegalDocumentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Published => "published",
            Self::Retired => "retired",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegalRecordType {
    Acceptance,
    Acknowledgement,
}

impl LegalRecordType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Acceptance => "acceptance",
            Self::Acknowledgement => "acknowledgement",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct LegalDocument {
    pub id: Uuid,
    pub doc_type: String,
    pub version: String,
    pub content_markdown: Option<String>,
    pub official_url: Option<String>,
    pub content_hash: String,
    pub status: String,
    pub published_at: Option<DateTime<Utc>>,
    pub effective_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct UserLegalAcceptance {
    pub id: Uuid,
    pub user_id: Uuid,
    pub doc_type: String,
    pub doc_version: String,
    pub doc_hash: String,
    pub record_type: String,
    pub recorded_at: DateTime<Utc>,
    pub flow_origin: String,
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct UserAgeDeclaration {
    pub id: Uuid,
    pub user_id: Uuid,
    pub minimum_age: i16,
    pub confirmed: bool,
    pub declared_at: DateTime<Utc>,
    pub flow_origin: String,
    pub app_version: Option<String>,
}
