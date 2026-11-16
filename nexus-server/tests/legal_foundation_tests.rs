use chrono::Utc;
use nexus_server::models::{LegalDocumentType, LegalRecordType};
use nexus_server::repositories::LegalRepository;
use sqlx::PgPool;
use uuid::Uuid;

async fn test_pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres@127.0.0.1:55432/nexus_test".to_string());
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to disposable PostgreSQL")
}

async fn create_legacy_user(pool: &PgPool, username: &str, email: &str) -> Uuid {
    let user_id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username) VALUES ($1, $2)")
        .bind(user_id)
        .bind(username)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO user_credentials (user_id, email, password_hash) VALUES ($1, $2, $3)",
    )
    .bind(user_id)
    .bind(email)
    .bind("legacy_argon2_hash")
    .execute(pool)
    .await
    .unwrap();
    user_id
}

#[tokio::test]
async fn test_legal_documents_lifecycle_and_immutability() {
    let pool = test_pool().await;
    let repo = LegalRepository::new(pool.clone());

    // Without published documents, get_current_document returns None (non-blocking)
    let version = format!("1.0.0-{}", &Uuid::new_v4().simple().to_string()[..8]);
    let content = "# Termos de Uso v1\nConteúdo oficial de teste.";
    let hash = LegalRepository::canonical_document_hash(
        LegalDocumentType::TermsOfUse,
        &version,
        Some(content),
        None,
    );

    // Insert published document
    let now = Utc::now();
    sqlx::query(
        r#"
        INSERT INTO legal_documents (doc_type, version, content_markdown, content_hash, status, published_at, effective_at)
        VALUES ('terms_of_use', $1, $2, $3, 'published', $4, $4)
        "#,
    )
    .bind(&version)
    .bind(content)
    .bind(&hash)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Mutating content of a published document must fail via trigger
    let mutate_res = sqlx::query(
        "UPDATE legal_documents SET content_markdown = 'alterado' WHERE doc_type = 'terms_of_use' AND version = $1",
    )
    .bind(&version)
    .execute(&pool)
    .await;
    assert!(mutate_res.is_err(), "Published document must be immutable");

    // Transition published -> retired is allowed
    let retire_res = sqlx::query(
        "UPDATE legal_documents SET status = 'retired' WHERE doc_type = 'terms_of_use' AND version = $1",
    )
    .bind(&version)
    .execute(&pool)
    .await;
    assert!(retire_res.is_ok(), "Transition published -> retired must succeed");

    // Transition retired -> published must fail
    let unretire_res = sqlx::query(
        "UPDATE legal_documents SET status = 'published' WHERE doc_type = 'terms_of_use' AND version = $1",
    )
    .bind(&version)
    .execute(&pool)
    .await;
    assert!(unretire_res.is_err(), "Retired document cannot return to published");

    let fetched = repo
        .get_document_version(LegalDocumentType::TermsOfUse, &version)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fetched.content_hash, hash);
    assert_eq!(fetched.status, "retired");
}

#[tokio::test]
async fn test_acceptance_idempotency_concurrency_and_record_types() {
    let pool = test_pool().await;
    let repo = LegalRepository::new(pool.clone());

    let user_id = create_legacy_user(
        &pool,
        &format!("u_{}", &Uuid::new_v4().simple().to_string()[..8]),
        &format!("{}@example.com", Uuid::new_v4().simple()),
    )
    .await;

    // Verify legacy user has email_verified_at = NULL
    let verified_at: Option<chrono::DateTime<Utc>> =
        sqlx::query_scalar("SELECT email_verified_at FROM user_credentials WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(verified_at.is_none());

    let terms_ver = format!("1.0.0-{}", &Uuid::new_v4().simple().to_string()[..8]);
    let terms_md = "Termos de Uso Teste";
    let terms_hash = LegalRepository::canonical_document_hash(
        LegalDocumentType::TermsOfUse,
        &terms_ver,
        Some(terms_md),
        None,
    );
    let now = Utc::now();

    sqlx::query(
        r#"
        INSERT INTO legal_documents (doc_type, version, content_markdown, content_hash, status, published_at, effective_at)
        VALUES ('terms_of_use', $1, $2, $3, 'published', $4, $4)
        "#,
    )
    .bind(&terms_ver)
    .bind(terms_md)
    .bind(&terms_hash)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Reject silent conversion between record types (TermsOfUse must use Acceptance)
    {
        let mut tx = pool.begin().await.unwrap();
        let wrong_type = LegalRepository::record_acceptance_tx(
            &mut tx,
            user_id,
            LegalDocumentType::TermsOfUse,
            &terms_ver,
            &terms_hash,
            LegalRecordType::Acknowledgement,
            "register",
            Some("0.4.0"),
        )
        .await;
        assert!(wrong_type.is_err(), "Must reject wrong record_type");
    }

    // Concurrent idempotent acceptance calls
    let (r1, r2) = tokio::join!(
        async {
            let mut tx = pool.begin().await.unwrap();
            let res = LegalRepository::record_acceptance_tx(
                &mut tx,
                user_id,
                LegalDocumentType::TermsOfUse,
                &terms_ver,
                &terms_hash,
                LegalRecordType::Acceptance,
                "regularization",
                Some("0.4.0"),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            res
        },
        async {
            let mut tx = pool.begin().await.unwrap();
            let res = LegalRepository::record_acceptance_tx(
                &mut tx,
                user_id,
                LegalDocumentType::TermsOfUse,
                &terms_ver,
                &terms_hash,
                LegalRecordType::Acceptance,
                "regularization",
                Some("0.4.0"),
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            res
        }
    );

    assert_eq!(r1.id, r2.id, "Concurrent calls must return the same record");

    // Append-only: UPDATE on user_legal_acceptances must fail
    let update_res = sqlx::query("UPDATE user_legal_acceptances SET flow_origin = 'hack' WHERE id = $1")
        .bind(r1.id)
        .execute(&pool)
        .await;
    assert!(update_res.is_err(), "user_legal_acceptances must be append-only");

    // Age declaration
    {
        let mut tx = pool.begin().await.unwrap();
        let decl = LegalRepository::record_age_declaration_tx(
            &mut tx,
            user_id,
            true,
            "regularization",
            Some("0.4.0"),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(decl.minimum_age, 16);
        assert!(decl.confirmed);
    }

    assert!(repo
        .has_accepted_version(user_id, LegalDocumentType::TermsOfUse, &terms_ver)
        .await
        .unwrap());
}
