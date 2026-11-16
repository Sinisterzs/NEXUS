use axum::{
    extract::State,
    http::{header, HeaderValue, StatusCode},
    response::IntoResponse,
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::errors::AppError;
use crate::middleware::CurrentUser;
use crate::models::{LegalDocument, LegalDocumentType, LegalRecordType};
use crate::repositories::LegalRepository;

#[derive(Debug, Clone, Serialize)]
pub struct LegalDocumentDto {
    pub id: Uuid,
    pub doc_type: String,
    pub version: String,
    pub content_hash: String,
    pub published_at: Option<DateTime<Utc>>,
    pub effective_at: Option<DateTime<Utc>>,
    pub content_markdown: Option<String>,
    pub official_url: Option<String>,
}

impl From<LegalDocument> for LegalDocumentDto {
    fn from(doc: LegalDocument) -> Self {
        Self {
            id: doc.id,
            doc_type: doc.doc_type,
            version: doc.version,
            content_hash: doc.content_hash,
            published_at: doc.published_at,
            effective_at: doc.effective_at,
            content_markdown: doc.content_markdown,
            official_url: doc.official_url,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CurrentLegalDocumentsResponse {
    pub documents: Vec<LegalDocumentDto>,
    pub missing_required_types: Vec<String>,
    pub complete: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AcceptLegalDocumentRequest {
    pub doc_type: LegalDocumentType,
    pub version: String,
    pub content_hash: String,
    pub record_type: LegalRecordType,
    pub flow_origin: String,
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AcceptLegalDocumentResponse {
    pub id: Uuid,
    pub doc_type: String,
    pub doc_version: String,
    pub doc_hash: String,
    pub record_type: String,
    pub recorded_at: DateTime<Utc>,
    pub flow_origin: String,
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LegalErrorResponse {
    pub code: &'static str,
    pub message: String,
}

fn legal_error(
    status: StatusCode,
    code: &'static str,
    message: impl Into<String>,
) -> (StatusCode, Json<LegalErrorResponse>) {
    (
        status,
        Json(LegalErrorResponse {
            code,
            message: message.into(),
        }),
    )
}

/// `GET /v1/legal/current` — public read-only endpoint returning currently effective legal documents.
pub async fn get_current_legal_documents(
    State(repo): State<LegalRepository>,
) -> Result<impl IntoResponse, AppError> {
    let mut documents = Vec::new();
    let mut missing_required_types = Vec::new();

    for doc_type in [LegalDocumentType::TermsOfUse, LegalDocumentType::PrivacyPolicy] {
        match repo.get_current_document(doc_type).await? {
            Some(doc) => documents.push(LegalDocumentDto::from(doc)),
            None => missing_required_types.push(doc_type.as_str().to_string()),
        }
    }

    let complete = missing_required_types.is_empty();
    let body = CurrentLegalDocumentsResponse {
        documents,
        missing_required_types,
        complete,
    };

    Ok((
        StatusCode::OK,
        [(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store, max-age=0"),
        )],
        Json(body),
    ))
}

/// `POST /v1/legal/accept` — authenticated endpoint to record acceptance or acknowledgement.
pub async fn accept_legal_document(
    State(repo): State<LegalRepository>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(payload): Json<AcceptLegalDocumentRequest>,
) -> Result<(StatusCode, Json<AcceptLegalDocumentResponse>), (StatusCode, Json<LegalErrorResponse>)>
{
    if payload.record_type != payload.doc_type.default_record_type() {
        return Err(legal_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "LEGAL_INVALID_RECORD_TYPE",
            "Tipo de registro incompatível com o documento informado.",
        ));
    }

    let flow_origin = payload.flow_origin.trim();
    if flow_origin.is_empty() || flow_origin.len() > 32 {
        return Err(legal_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "LEGAL_INVALID_FLOW_ORIGIN",
            "Origem do fluxo inválida.",
        ));
    }

    let current = repo
        .get_current_document(payload.doc_type)
        .await
        .map_err(|_| {
            legal_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "LEGAL_INTERNAL_ERROR",
                "Falha ao consultar documento legal.",
            )
        })?
        .ok_or_else(|| {
            legal_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "LEGAL_DOCUMENT_UNAVAILABLE",
                "Documento legal vigente indisponível no momento.",
            )
        })?;

    if current.version != payload.version.trim() || current.content_hash != payload.content_hash.trim()
    {
        return Err(legal_error(
            StatusCode::CONFLICT,
            "LEGAL_VERSION_MISMATCH",
            "A versão ou o hash do documento não corresponde à versão vigente.",
        ));
    }

    let mut tx = repo.pool().begin().await.map_err(|_| {
        legal_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "LEGAL_INTERNAL_ERROR",
            "Falha ao iniciar transação.",
        )
    })?;

    let record = LegalRepository::record_acceptance_tx(
        &mut tx,
        user.id,
        payload.doc_type,
        &current.version,
        &current.content_hash,
        payload.record_type,
        flow_origin,
        payload.app_version.as_deref(),
    )
    .await
    .map_err(|_| {
        legal_error(
            StatusCode::CONFLICT,
            "LEGAL_VERSION_MISMATCH",
            "Não foi possível registrar o aceite para a versão informada.",
        )
    })?;

    tx.commit().await.map_err(|_| {
        legal_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "LEGAL_INTERNAL_ERROR",
            "Falha ao confirmar transação.",
        )
    })?;

    Ok((
        StatusCode::OK,
        Json(AcceptLegalDocumentResponse {
            id: record.id,
            doc_type: record.doc_type,
            doc_version: record.doc_version,
            doc_hash: record.doc_hash,
            record_type: record.record_type,
            recorded_at: record.recorded_at,
            flow_origin: record.flow_origin,
            app_version: record.app_version,
        }),
    ))
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgeDeclarationRequest {
    pub confirmed: bool,
    pub flow_origin: String,
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgeDeclarationResponse {
    pub id: Uuid,
    pub minimum_age: i16,
    pub confirmed: bool,
    pub declared_at: DateTime<Utc>,
    pub flow_origin: String,
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentComplianceStatus {
    Accepted,
    Pending,
    Outdated,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
pub struct DocumentStatusDto {
    pub doc_type: String,
    pub status: DocumentComplianceStatus,
    pub current_version: Option<String>,
    pub current_hash: Option<String>,
    pub accepted_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LegalStatusResponse {
    pub age_confirmed: bool,
    pub terms_of_use: DocumentStatusDto,
    pub privacy_policy: DocumentStatusDto,
    pub ready: bool,
}

/// `POST /v1/legal/age-declaration` — authenticated endpoint to record explicit 16+ confirmation.
pub async fn record_age_declaration(
    State(repo): State<LegalRepository>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Json(payload): Json<AgeDeclarationRequest>,
) -> Result<(StatusCode, Json<AgeDeclarationResponse>), (StatusCode, Json<LegalErrorResponse>)> {
    if !payload.confirmed {
        return Err(legal_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "AGE_REQUIREMENT_NOT_MET",
            "É necessário confirmar ter 16 anos ou mais.",
        ));
    }

    let flow_origin = payload.flow_origin.trim();
    if flow_origin.is_empty() || flow_origin.len() > 32 {
        return Err(legal_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "LEGAL_INVALID_FLOW_ORIGIN",
            "Origem do fluxo inválida.",
        ));
    }

    let mut tx = repo.pool().begin().await.map_err(|_| {
        legal_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "LEGAL_INTERNAL_ERROR",
            "Falha ao iniciar transação.",
        )
    })?;

    let record = LegalRepository::record_age_declaration_tx(
        &mut tx,
        user.id,
        true,
        flow_origin,
        payload.app_version.as_deref(),
    )
    .await
    .map_err(|_| {
        legal_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "LEGAL_INTERNAL_ERROR",
            "Falha ao registrar declaração de idade.",
        )
    })?;

    tx.commit().await.map_err(|_| {
        legal_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "LEGAL_INTERNAL_ERROR",
            "Falha ao confirmar transação.",
        )
    })?;

    Ok((
        StatusCode::OK,
        Json(AgeDeclarationResponse {
            id: record.id,
            minimum_age: record.minimum_age,
            confirmed: record.confirmed,
            declared_at: record.declared_at,
            flow_origin: record.flow_origin,
            app_version: record.app_version,
        }),
    ))
}

/// `GET /v1/legal/status` — authenticated read-only endpoint returning user's legal compliance status.
pub async fn get_legal_status(
    State(repo): State<LegalRepository>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<Json<LegalStatusResponse>, AppError> {
    let age_confirmed = repo.has_confirmed_age(user.id).await?;
    let acceptances = repo.list_user_acceptances(user.id).await?;

    let evaluate = |doc_type: LegalDocumentType, current: Option<LegalDocument>| {
        let user_latest = acceptances
            .iter()
            .find(|a| a.doc_type == doc_type.as_str());

        match current {
            None => DocumentStatusDto {
                doc_type: doc_type.as_str().to_string(),
                status: DocumentComplianceStatus::Unavailable,
                current_version: None,
                current_hash: None,
                accepted_version: user_latest.map(|a| a.doc_version.clone()),
            },
            Some(doc) => {
                let accepted_current = acceptances.iter().any(|a| {
                    a.doc_type == doc_type.as_str()
                        && a.doc_version == doc.version
                        && a.doc_hash == doc.content_hash
                });

                let status = if accepted_current {
                    DocumentComplianceStatus::Accepted
                } else if user_latest.is_some() {
                    DocumentComplianceStatus::Outdated
                } else {
                    DocumentComplianceStatus::Pending
                };

                DocumentStatusDto {
                    doc_type: doc_type.as_str().to_string(),
                    status,
                    current_version: Some(doc.version),
                    current_hash: Some(doc.content_hash),
                    accepted_version: user_latest.map(|a| a.doc_version.clone()),
                }
            }
        }
    };

    let current_terms = repo.get_current_document(LegalDocumentType::TermsOfUse).await?;
    let current_privacy = repo
        .get_current_document(LegalDocumentType::PrivacyPolicy)
        .await?;

    let terms_of_use = evaluate(LegalDocumentType::TermsOfUse, current_terms);
    let privacy_policy = evaluate(LegalDocumentType::PrivacyPolicy, current_privacy);

    let ready = age_confirmed
        && matches!(terms_of_use.status, DocumentComplianceStatus::Accepted)
        && matches!(privacy_policy.status, DocumentComplianceStatus::Accepted);

    Ok(Json(LegalStatusResponse {
        age_confirmed,
        terms_of_use,
        privacy_policy,
        ready,
    }))
}
