use nexus_server::repositories::DmRequestRepository;
use nexus_server::services::SocialPolicyService;
use sqlx::PgPool;
use uuid::Uuid;

async fn test_pool() -> PgPool {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres@127.0.0.1:55432/nexus_test".to_string());
    PgPool::connect(&url)
        .await
        .expect("Failed to connect to disposable PostgreSQL")
}

async fn create_user(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    let username = format!("d_{}", &id.simple().to_string()[..8]);
    sqlx::query("INSERT INTO users (id, username) VALUES ($1, $2)")
        .bind(id)
        .bind(&username)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn create_conversation(pool: &PgPool, a: Uuid, b: Uuid) -> Uuid {
    let (ua, ub) = if a < b { (a, b) } else { (b, a) };
    let conv_id = Uuid::new_v4();
    sqlx::query("INSERT INTO direct_conversations (id, user_a_id, user_b_id) VALUES ($1, $2, $3)")
        .bind(conv_id)
        .bind(ua)
        .bind(ub)
        .execute(pool)
        .await
        .unwrap();
    conv_id
}

#[tokio::test]
async fn test_dm_message_requests_lifecycle_concurrency_and_cooldown() {
    let pool = test_pool().await;
    let policy = SocialPolicyService::new(pool.clone()).with_enforcement(true);
    let repo = DmRequestRepository::new(pool.clone());

    let sender = create_user(&pool).await;
    let recipient = create_user(&pool).await;
    let conv_id = create_conversation(&pool, sender, recipient).await;

    // 1. Without shared community -> Denied
    assert!(repo
        .create_request(&policy, conv_id, sender, recipient)
        .await
        .is_err());

    // 2. Add shared community
    let comm_id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, name, initials, owner_id) VALUES ($1, 'Comm', 'CM', $2)")
        .bind(comm_id)
        .bind(sender)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO community_members (community_id, user_id) VALUES ($1, $2), ($1, $3)")
        .bind(comm_id)
        .bind(sender)
        .bind(recipient)
        .execute(&pool)
        .await
        .unwrap();

    // 3. Concurrent idempotent request creation
    let (r1, r2) = tokio::join!(
        repo.create_request(&policy, conv_id, sender, recipient),
        repo.create_request(&policy, conv_id, sender, recipient)
    );
    let req1 = r1.unwrap();
    let req2 = r2.unwrap();
    assert_eq!(req1.id, req2.id);
    assert_eq!(req1.status, "pending");

    // 4. Unauthorized user (sender) cannot accept/decline
    assert!(repo.accept_request(req1.id, sender).await.is_err());
    assert!(repo.decline_request(req1.id, sender, 24).await.is_err());

    // 5. Recipient declines -> cooldown_until set, new request blocked
    let declined = repo.decline_request(req1.id, recipient, 24).await.unwrap();
    assert_eq!(declined.status, "declined");
    assert!(declined.cooldown_until.is_some());

    assert!(repo
        .create_request(&policy, conv_id, sender, recipient)
        .await
        .is_err());

    // 6. Another sender can create and recipient accepts
    let sender2 = create_user(&pool).await;
    sqlx::query("INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)")
        .bind(comm_id)
        .bind(sender2)
        .execute(&pool)
        .await
        .unwrap();
    let conv2 = create_conversation(&pool, sender2, recipient).await;
    let req_s2 = repo
        .create_request(&policy, conv2, sender2, recipient)
        .await
        .unwrap();
    let accepted = repo.accept_request(req_s2.id, recipient).await.unwrap();
    assert_eq!(accepted.status, "accepted");
}
