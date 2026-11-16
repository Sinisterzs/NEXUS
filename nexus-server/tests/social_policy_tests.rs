use nexus_server::services::social_policy::{
    DmPolicy, FriendRequestPolicy, PrivateCallPolicy, SocialPermissionDecision, SocialPolicyService,
};
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
    let username = format!("s_{}", &id.simple().to_string()[..8]);
    sqlx::query("INSERT INTO users (id, username) VALUES ($1, $2)")
        .bind(id)
        .bind(&username)
        .execute(pool)
        .await
        .unwrap();
    id
}

#[tokio::test]
async fn test_social_policy_defaults_blocks_friendships_communities_and_concurrency() {
    let pool = test_pool().await;
    let svc = SocialPolicyService::new(pool.clone());

    let a = create_user(&pool).await;
    let b = create_user(&pool).await;
    let nonexistent = Uuid::new_v4();

    // 1. Default preferences for existing user without row
    let prefs = svc.get_preferences(b).await.unwrap();
    assert_eq!(prefs.dm_policy, DmPolicy::FriendsAndCommunity);
    assert_eq!(prefs.friend_request_policy, FriendRequestPolicy::Everyone);
    assert_eq!(prefs.private_call_policy, PrivateCallPolicy::FriendsOnly);

    // 2. Nonexistent user -> Denied
    assert_eq!(
        svc.can_start_dm(a, nonexistent).await.unwrap(),
        SocialPermissionDecision::Denied
    );

    // 3. No link -> friend request Allowed (everyone), DM Denied, Call Denied, Invite Denied
    assert_eq!(
        svc.can_send_friend_request(a, b).await.unwrap(),
        SocialPermissionDecision::Allowed
    );
    assert_eq!(
        svc.can_start_dm(a, b).await.unwrap(),
        SocialPermissionDecision::Denied
    );
    assert_eq!(
        svc.can_start_private_call(a, b).await.unwrap(),
        SocialPermissionDecision::Denied
    );

    // 4. Shared community -> DM RequestRequired
    let comm_id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, name, initials, owner_id) VALUES ($1, 'Comm', 'CM', $2)")
        .bind(comm_id)
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO community_members (community_id, user_id) VALUES ($1, $2), ($1, $3)")
        .bind(comm_id)
        .bind(a)
        .bind(b)
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(
        svc.can_start_dm(a, b).await.unwrap(),
        SocialPermissionDecision::RequestRequired
    );

    // 5. Accepted friendship -> DM Allowed, Call Allowed, Invite Allowed
    let (ua, ub) = if a < b { (a, b) } else { (b, a) };
    sqlx::query("INSERT INTO friendships (user_a_id, user_b_id) VALUES ($1, $2)")
        .bind(ua)
        .bind(ub)
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(
        svc.can_start_dm(a, b).await.unwrap(),
        SocialPermissionDecision::Allowed
    );
    assert_eq!(
        svc.can_start_private_call(a, b).await.unwrap(),
        SocialPermissionDecision::Allowed
    );
    assert_eq!(
        svc.can_send_direct_invite(a, b).await.unwrap(),
        SocialPermissionDecision::Allowed
    );

    // 6. Block B -> A (and A -> B) -> all Denied
    sqlx::query("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)")
        .bind(b)
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();

    let (r1, r2, r3, r4) = tokio::join!(
        svc.can_start_dm(a, b),
        svc.can_start_private_call(a, b),
        svc.can_send_friend_request(a, b),
        svc.can_send_direct_invite(a, b),
    );
    assert_eq!(r1.unwrap(), SocialPermissionDecision::Denied);
    assert_eq!(r2.unwrap(), SocialPermissionDecision::Denied);
    assert_eq!(r3.unwrap(), SocialPermissionDecision::Denied);
    assert_eq!(r4.unwrap(), SocialPermissionDecision::Denied);
}

#[tokio::test]
async fn test_social_policy_enforcement_toggle_and_preferences() {
    let pool = test_pool().await;
    let disabled_svc = SocialPolicyService::new(pool.clone()).with_enforcement(false);
    let enabled_svc = SocialPolicyService::new(pool.clone()).with_enforcement(true);

    assert!(!disabled_svc.is_enforcement_enabled());
    assert!(enabled_svc.is_enforcement_enabled());

    let a = create_user(&pool).await;
    let b = create_user(&pool).await;

    // Target B sets friend_request_policy = 'community_only' and private_call_policy = 'nobody'
    sqlx::query(
        r#"
        INSERT INTO user_privacy_preferences (user_id, dm_policy, friend_request_policy, private_call_policy)
        VALUES ($1, 'friends_only', 'community_only', 'nobody')
        "#,
    )
    .bind(b)
    .execute(&pool)
    .await
    .unwrap();

    // Without shared community -> friend request Denied
    assert_eq!(
        enabled_svc.can_send_friend_request(a, b).await.unwrap(),
        SocialPermissionDecision::Denied
    );

    // Even if A and B become friends, private_call_policy = 'nobody' -> Denied
    let (ua, ub) = if a < b { (a, b) } else { (b, a) };
    sqlx::query("INSERT INTO friendships (user_a_id, user_b_id) VALUES ($1, $2)")
        .bind(ua)
        .bind(ub)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        enabled_svc.can_start_private_call(a, b).await.unwrap(),
        SocialPermissionDecision::Denied
    );

    // Remove friendship -> direct invite Denied
    sqlx::query("DELETE FROM friendships WHERE user_a_id = $1 AND user_b_id = $2")
        .bind(ua)
        .bind(ub)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        enabled_svc.can_send_direct_invite(a, b).await.unwrap(),
        SocialPermissionDecision::Denied
    );
}
