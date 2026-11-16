use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use chrono::Utc;
use nexus_server::config::AppConfig;
use nexus_server::models::LegalDocumentType;
use nexus_server::repositories::{
    DmRepository, FriendRepository, LegalRepository, SessionRepository, UserRepository,
};
use nexus_server::routes::create_router;
use nexus_server::services::{AuthService, DmService, FriendService, PresenceManager};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

async fn test_pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres@127.0.0.1:55432/nexus_test".to_string());
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to disposable PostgreSQL")
}

fn build_app(pool: PgPool) -> axum::Router {
    let config = AppConfig::from_env();
    let user_repo = UserRepository::new(pool.clone());
    let session_repo = SessionRepository::new(pool.clone());
    let friend_repo = FriendRepository::new(pool.clone());
    let presence_mgr = PresenceManager::new(friend_repo.clone());
    let auth_service = AuthService::new(user_repo.clone(), session_repo, config.clone());
    let friend_service = FriendService::new(friend_repo.clone(), presence_mgr.clone());
    let dm_service = DmService::new(DmRepository::new(pool), friend_repo, user_repo, presence_mgr);
    create_router(auth_service, friend_service, dm_service, &config)
}

async fn create_user_and_token(app: &axum::Router) -> String {
    let username = format!("u_{}", &Uuid::new_v4().simple().to_string()[..8]);
    let email = format!("{}@example.com", Uuid::new_v4().simple());
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/auth/register")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "username": username,
                        "email": email,
                        "display_name": "Test User",
                        "password": "StrongPassword123!"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let json_body: Value = serde_json::from_slice(&body).unwrap();
    json_body["session_token"]
        .as_str()
        .or_else(|| json_body["token"].as_str())
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn test_legal_api_current_and_accept_flows() {
    let pool = test_pool().await;
    let app = build_app(pool.clone());

    // Clean any previously published docs in disposable DB for deterministic test
    sqlx::query("DELETE FROM user_legal_acceptances")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM legal_documents")
        .execute(&pool)
        .await
        .unwrap();

    // 1. GET /v1/legal/current without published documents
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/legal/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let json_body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json_body["complete"], false);
    assert_eq!(json_body["documents"].as_array().unwrap().len(), 0);

    // 2. Insert a draft (must NOT be exposed) and a published TermsOfUse
    let terms_ver = "1.0.0";
    let terms_md = "# Termos de Uso";
    let terms_hash = LegalRepository::canonical_document_hash(
        LegalDocumentType::TermsOfUse,
        terms_ver,
        Some(terms_md),
        None,
    );
    let now = Utc::now();

    sqlx::query(
        "INSERT INTO legal_documents (doc_type, version, content_markdown, content_hash, status, published_at, effective_at) VALUES ('terms_of_use', $1, $2, $3, 'published', $4, $4)",
    )
    .bind(terms_ver)
    .bind(terms_md)
    .bind(&terms_hash)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO legal_documents (doc_type, version, content_markdown, content_hash, status) VALUES ('privacy_policy', '0.9.0-draft', 'Rascunho', '0000000000000000000000000000000000000000000000000000000000000000', 'draft')",
    )
    .execute(&pool)
    .await
    .unwrap();

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/legal/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let json_body: Value = serde_json::from_slice(&body).unwrap();
    let docs = json_body["documents"].as_array().unwrap();
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0]["doc_type"], "terms_of_use");
    assert_eq!(docs[0]["version"], terms_ver);

    // 3. POST /v1/legal/accept without auth -> 401
    let unauth_res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/legal/accept")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "doc_type": "terms_of_use",
                        "version": terms_ver,
                        "content_hash": terms_hash,
                        "record_type": "acceptance",
                        "flow_origin": "regularization"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauth_res.status(), StatusCode::UNAUTHORIZED);

    let token = create_user_and_token(&app).await;

    // 4. POST with wrong record_type -> 422 LEGAL_INVALID_RECORD_TYPE
    let bad_type_res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/legal/accept")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "doc_type": "terms_of_use",
                        "version": terms_ver,
                        "content_hash": terms_hash,
                        "record_type": "acknowledgement",
                        "flow_origin": "regularization"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bad_type_res.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // 5. POST with wrong hash -> 409 LEGAL_VERSION_MISMATCH
    let bad_hash_res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/legal/accept")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "doc_type": "terms_of_use",
                        "version": terms_ver,
                        "content_hash": "deadbeef",
                        "record_type": "acceptance",
                        "flow_origin": "regularization"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bad_hash_res.status(), StatusCode::CONFLICT);

    // 6. Concurrent valid POST /v1/legal/accept
    let make_req = || {
        app.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/legal/accept")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "doc_type": "terms_of_use",
                        "version": terms_ver,
                        "content_hash": terms_hash,
                        "record_type": "acceptance",
                        "flow_origin": "regularization",
                        "app_version": "0.4.0"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
    };
    let (r1, r2) = tokio::join!(make_req(), make_req());
    let r1 = r1.unwrap();
    let r2 = r2.unwrap();
    assert_eq!(r1.status(), StatusCode::OK);
    assert_eq!(r2.status(), StatusCode::OK);
    let b1: Value =
        serde_json::from_slice(&axum::body::to_bytes(r1.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    let b2: Value =
        serde_json::from_slice(&axum::body::to_bytes(r2.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    assert_eq!(b1["id"], b2["id"]);
}

#[tokio::test]
async fn test_legal_age_declaration_and_status_flows() {
    let pool = test_pool().await;
    let app = build_app(pool.clone());

    sqlx::query("DELETE FROM user_legal_acceptances")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM user_age_declarations")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM legal_documents")
        .execute(&pool)
        .await
        .unwrap();

    // Unauthenticated age-declaration & status -> 401
    let unauth_age = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/legal/age-declaration")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "confirmed": true, "flow_origin": "regularization" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauth_age.status(), StatusCode::UNAUTHORIZED);

    let unauth_status = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/legal/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauth_status.status(), StatusCode::UNAUTHORIZED);

    let token = create_user_and_token(&app).await;

    // Initial status without published documents
    let status_res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/legal/status")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(status_res.status(), StatusCode::OK);
    let status_json: Value = serde_json::from_slice(
        &axum::body::to_bytes(status_res.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(status_json["age_confirmed"], false);
    assert_eq!(status_json["terms_of_use"]["status"], "unavailable");
    assert_eq!(status_json["privacy_policy"]["status"], "unavailable");
    assert_eq!(status_json["ready"], false);

    // confirmed: false -> 422 AGE_REQUIREMENT_NOT_MET
    let neg_age = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/legal/age-declaration")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "confirmed": false, "flow_origin": "regularization" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(neg_age.status(), StatusCode::UNPROCESSABLE_ENTITY);

    // Concurrent idempotent age declarations
    let make_age_req = || {
        app.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/legal/age-declaration")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "confirmed": true,
                        "flow_origin": "regularization",
                        "app_version": "0.4.0"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
    };
    let (a1, a2) = tokio::join!(make_age_req(), make_age_req());
    let a1 = a1.unwrap();
    let a2 = a2.unwrap();
    assert_eq!(a1.status(), StatusCode::OK);
    assert_eq!(a2.status(), StatusCode::OK);
    let j1: Value =
        serde_json::from_slice(&axum::body::to_bytes(a1.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    let j2: Value =
        serde_json::from_slice(&axum::body::to_bytes(a2.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    assert_eq!(j1["id"], j2["id"]);
    assert_eq!(j1["minimum_age"], 16);

    // Publish Terms v1.0 and Privacy v1.0
    let now = Utc::now() - chrono::Duration::seconds(10);
    let terms_v1_hash = LegalRepository::canonical_document_hash(
        LegalDocumentType::TermsOfUse,
        "1.0.0",
        Some("Termos v1"),
        None,
    );
    let priv_v1_hash = LegalRepository::canonical_document_hash(
        LegalDocumentType::PrivacyPolicy,
        "1.0.0",
        Some("Privacidade v1"),
        None,
    );
    sqlx::query("INSERT INTO legal_documents (doc_type, version, content_markdown, content_hash, status, published_at, effective_at) VALUES ('terms_of_use', '1.0.0', 'Termos v1', $1, 'published', $2, $2)")
        .bind(&terms_v1_hash)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO legal_documents (doc_type, version, content_markdown, content_hash, status, published_at, effective_at) VALUES ('privacy_policy', '1.0.0', 'Privacidade v1', $1, 'published', $2, $2)")
        .bind(&priv_v1_hash)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();

    // Accept only Terms v1.0 (partial)
    let acc_terms = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/legal/accept")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "doc_type": "terms_of_use",
                        "version": "1.0.0",
                        "content_hash": terms_v1_hash,
                        "record_type": "acceptance",
                        "flow_origin": "regularization"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(acc_terms.status(), StatusCode::OK);

    // Publish Terms v1.1 -> Terms status must become outdated
    let later = Utc::now() - chrono::Duration::seconds(1);
    let terms_v11_hash = LegalRepository::canonical_document_hash(
        LegalDocumentType::TermsOfUse,
        "1.1.0",
        Some("Termos v1.1"),
        None,
    );
    sqlx::query("INSERT INTO legal_documents (doc_type, version, content_markdown, content_hash, status, published_at, effective_at) VALUES ('terms_of_use', '1.1.0', 'Termos v1.1', $1, 'published', $2, $2)")
        .bind(&terms_v11_hash)
        .bind(later)
        .execute(&pool)
        .await
        .unwrap();

    let status_res2 = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/legal/status")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status_json2: Value = serde_json::from_slice(
        &axum::body::to_bytes(status_res2.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(status_json2["age_confirmed"], true);
    assert_eq!(status_json2["terms_of_use"]["status"], "outdated");
    assert_eq!(status_json2["terms_of_use"]["accepted_version"], "1.0.0");
    assert_eq!(status_json2["terms_of_use"]["current_version"], "1.1.0");
    assert_eq!(status_json2["privacy_policy"]["status"], "pending");
    assert_eq!(status_json2["ready"], false);
}
