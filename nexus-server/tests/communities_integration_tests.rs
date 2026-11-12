use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, StatusCode},
    Router,
};
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use nexus_server::config::AppConfig;
use nexus_server::create_app_with_identity;
use nexus_server::identity::ServerIdentity;
use nexus_server::models::{
    AcceptInviteResponse, ChannelMessageDto, ChannelMessagesPageDto,
    ChannelPermissionOverwriteDto, ChannelReadStateDto, CommunityAuditLogDto, CommunityBan,
    CommunityBanDto, CommunityCategoryDto, CommunityChannelDto, CommunityDto, CommunityInviteDto,
    CommunityMemberMuteDto, CommunityRoleDto, CommunitySnapshotDto, InvitePreviewDto,
};
use nexus_server::services::community_permissions::{
    DEFAULT_EVERYONE_PERMISSIONS, PERM_ADMINISTRATOR, PERM_MANAGE_CHANNELS, PERM_MANAGE_COMMUNITY,
    PERM_MANAGE_MESSAGES, PERM_MANAGE_ROLES, PERM_MODERATE_MEMBERS, PERM_VIEW_AUDIT_LOG,
    PERM_VIEW_CHANNEL,
};

async fn setup_test_app() -> (Router, PgPool) {
    let mut config = AppConfig::from_env();
    let test_db_url = config
        .test_database_url
        .clone()
        .unwrap_or_else(|| "postgres://postgres@localhost:5432/nexus_test_db".to_string());
    config.database_url = test_db_url.clone();
    config.rate_limit_auth_per_minute = 10_000;

    let pool = PgPool::connect(&test_db_url)
        .await
        .expect("Falha ao conectar no banco de testes");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Falha ao rodar migrações no banco de teste");

    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("Falha ao limpar tabelas de teste");

    let app = create_app_with_identity(pool.clone(), config, ServerIdentity::generate_ephemeral());
    (app, pool)
}

async fn send_request(
    app: &Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(tok) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {}", tok));
    }

    let req = match body {
        Some(json_val) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json_val.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };

    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let parsed = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            Value::String(String::from_utf8_lossy(&bytes).into_owned())
        })
    };
    (status, parsed)
}

async fn register_user(app: &Router, username: &str, email: &str) -> (Uuid, String) {
    let (status, body) = send_request(
        app,
        Method::POST,
        "/v1/auth/register",
        None,
        Some(json!({
            "username": username,
            "email": email,
            "password": "Password123!",
            "display_name": username
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "register failed: {:?}", body);
    let user_id = Uuid::parse_str(body["user"]["id"].as_str().unwrap()).unwrap();
    let token = body["session_token"].as_str().unwrap().to_string();
    (user_id, token)
}

async fn create_community(app: &Router, token: &str, name: &str) -> CommunityDto {
    let (status, body) = send_request(
        app,
        Method::POST,
        "/v1/communities",
        Some(token),
        Some(json!({
            "name": name,
            "description": "Comunidade de teste B1",
            "privacy": "invite_only"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create_community failed: {:?}", body);
    serde_json::from_value(body).unwrap()
}

async fn invite_and_join(
    app: &Router,
    community_id: Uuid,
    inviter_token: &str,
    joiner_token: &str,
) -> CommunityInviteDto {
    let (status, inv_body) = send_request(
        app,
        Method::POST,
        &format!("/v1/communities/{}/invites", community_id),
        Some(inviter_token),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create_invite failed: {:?}", inv_body);
    let invite: CommunityInviteDto = serde_json::from_value(inv_body).unwrap();

    let (acc_status, acc_body) = send_request(
        app,
        Method::POST,
        &format!("/v1/invites/{}/accept", invite.code),
        Some(joiner_token),
        None,
    )
    .await;
    assert_eq!(
        acc_status,
        StatusCode::OK,
        "accept_invite failed: {:?}",
        acc_body
    );
    invite
}

// =========================================================================
// 1. Community Lifecycle: Creation, Snapshot, Edit, Transfer, Leave, Delete
// =========================================================================

#[tokio::test]
async fn test_01_community_lifecycle_ownership_leave_and_delete() {
    let (app, _pool) = setup_test_app().await;

    let (alice_id, alice_token) = register_user(&app, "alice_c1", "alice_c1@nexus.test").await;
    let (bob_id, bob_token) = register_user(&app, "bob_c1", "bob_c1@nexus.test").await;

    // 1. Create community
    let created = create_community(&app, &alice_token, "Tropa Nexus").await;
    assert_eq!(created.owner_id, alice_id);
    assert_eq!(created.name, "Tropa Nexus");
    assert_eq!(created.initials, "TN");
    assert_eq!(created.member_count, 1);

    // 2. List communities for Alice (1) and Bob (0)
    let (st, list_alice) =
        send_request(&app, Method::GET, "/v1/communities", Some(&alice_token), None).await;
    assert_eq!(st, StatusCode::OK);
    let alice_comms: Vec<CommunityDto> = serde_json::from_value(list_alice).unwrap();
    assert_eq!(alice_comms.len(), 1);
    assert_eq!(alice_comms[0].id, created.id);

    let (st, list_bob) =
        send_request(&app, Method::GET, "/v1/communities", Some(&bob_token), None).await;
    assert_eq!(st, StatusCode::OK);
    let bob_comms: Vec<CommunityDto> = serde_json::from_value(list_bob).unwrap();
    assert!(bob_comms.is_empty());

    // 3. Snapshot verifies @everyone role, #geral channel, owner member
    let (st, snap_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}", created.id),
        Some(&alice_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let snapshot: CommunitySnapshotDto = serde_json::from_value(snap_val).unwrap();
    assert_eq!(snapshot.roles.len(), 1);
    assert!(snapshot.roles[0].is_default);
    assert_eq!(snapshot.roles[0].name, "@everyone");
    assert_eq!(snapshot.roles[0].position, 0);
    assert_eq!(
        snapshot.roles[0].permissions_bitmask,
        DEFAULT_EVERYONE_PERMISSIONS.to_string()
    );
    assert_eq!(snapshot.categories.len(), 1);
    assert_eq!(snapshot.channels.len(), 1);
    assert_eq!(snapshot.channels[0].name, "geral");
    assert_eq!(snapshot.channels[0].channel_type, "text");
    assert_eq!(snapshot.members.len(), 1);
    assert!(snapshot.members[0].is_owner);

    // Audit log contains community.create
    let (st, logs_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}/audit-logs", created.id),
        Some(&alice_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let logs: Vec<CommunityAuditLogDto> = serde_json::from_value(logs_val).unwrap();
    assert!(logs.iter().any(|l| l.action == "community.create"));

    // 4. Edit community
    let (st, upd_val) = send_request(
        &app,
        Method::PATCH,
        &format!("/v1/communities/{}", created.id),
        Some(&alice_token),
        Some(json!({
            "name": "Tropa Alpha",
            "description": "Nova descrição",
            "privacy": "private"
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let updated: CommunityDto = serde_json::from_value(upd_val).unwrap();
    assert_eq!(updated.name, "Tropa Alpha");
    assert_eq!(updated.description.as_deref(), Some("Nova descrição"));
    assert_eq!(updated.privacy, "private");

    // 5. Owner cannot leave without transferring ownership
    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/leave", created.id),
        Some(&alice_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // 6. Invite Bob and test ownership transfer validation + success
    invite_and_join(&app, created.id, &alice_token, &bob_token).await;

    // Wrong confirm_name fails
    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/transfer-ownership", created.id),
        Some(&alice_token),
        Some(json!({
            "target_user_id": bob_id,
            "confirm_name": "Wrong Name"
        })),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // Non-owner cannot transfer
    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/transfer-ownership", created.id),
        Some(&bob_token),
        Some(json!({
            "target_user_id": bob_id,
            "confirm_name": "Tropa Alpha"
        })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Valid transfer to Bob
    let (st, tr_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/transfer-ownership", created.id),
        Some(&alice_token),
        Some(json!({
            "target_user_id": bob_id,
            "confirm_name": "Tropa Alpha"
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let transferred: CommunityDto = serde_json::from_value(tr_val).unwrap();
    assert_eq!(transferred.owner_id, bob_id);

    // Now Alice (former owner) can leave, while Bob (new owner) cannot leave
    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/leave", created.id),
        Some(&alice_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/leave", created.id),
        Some(&bob_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // 7. Delete community requires exact confirm_name and owner
    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!("/v1/communities/{}", created.id),
        Some(&bob_token),
        Some(json!({ "confirm_name": "tropa alpha" })),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!("/v1/communities/{}", created.id),
        Some(&bob_token),
        Some(json!({ "confirm_name": "Tropa Alpha" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    // Snapshot now returns 404 NotFound
    let (st, _) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}", created.id),
        Some(&bob_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

// =========================================================================
// 2. Categories, Channels, Private/Read-Only, Reorder, Role & User Overwrites
// =========================================================================

#[tokio::test]
async fn test_02_categories_channels_private_readonly_reorder_and_overwrites() {
    let (app, _pool) = setup_test_app().await;

    let (_owner_id, owner_token) = register_user(&app, "owner_c2", "owner_c2@nexus.test").await;
    let (member_id, member_token) =
        register_user(&app, "member_c2", "member_c2@nexus.test").await;
    let (vip_id, vip_token) = register_user(&app, "vip_c2", "vip_c2@nexus.test").await;

    let comm = create_community(&app, &owner_token, "Arena Dev").await;
    invite_and_join(&app, comm.id, &owner_token, &member_token).await;
    invite_and_join(&app, comm.id, &owner_token, &vip_token).await;

    // Create two categories and reorder them
    let (st, cat1_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/categories", comm.id),
        Some(&owner_token),
        Some(json!({ "name": "Projetos", "position": 1 })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let cat1: CommunityCategoryDto = serde_json::from_value(cat1_val).unwrap();

    let (st, cat2_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/categories", comm.id),
        Some(&owner_token),
        Some(json!({ "name": "Staff", "position": 2 })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let cat2: CommunityCategoryDto = serde_json::from_value(cat2_val).unwrap();

    let (st, reordered_cats_val) = send_request(
        &app,
        Method::PUT,
        &format!("/v1/communities/{}/categories/reorder", comm.id),
        Some(&owner_token),
        Some(json!({
            "items": [
                { "id": cat2.id, "position": 1 },
                { "id": cat1.id, "position": 2 }
            ]
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let reordered_cats: Vec<CommunityCategoryDto> =
        serde_json::from_value(reordered_cats_val).unwrap();
    let staff_pos = reordered_cats
        .iter()
        .find(|c| c.id == cat2.id)
        .unwrap()
        .position;
    let proj_pos = reordered_cats
        .iter()
        .find(|c| c.id == cat1.id)
        .unwrap()
        .position;
    assert!(staff_pos < proj_pos);

    // Create VIP role and assign to vip_id
    let (st, role_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/roles", comm.id),
        Some(&owner_token),
        Some(json!({
            "name": "VIP",
            "position": 5,
            "permissions_bitmask": DEFAULT_EVERYONE_PERMISSIONS.to_string()
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let vip_role: CommunityRoleDto = serde_json::from_value(role_val).unwrap();

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!(
            "/v1/communities/{}/members/{}/roles/{}",
            comm.id, vip_id, vip_role.id
        ),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    // Create private channel & read-only channel
    let (st, priv_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels", comm.id),
        Some(&owner_token),
        Some(json!({
            "category_id": cat2.id,
            "name": "vip-lounge",
            "channel_type": "text",
            "is_private": true,
            "position": 0
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let priv_ch: CommunityChannelDto = serde_json::from_value(priv_val).unwrap();

    let (st, ro_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels", comm.id),
        Some(&owner_token),
        Some(json!({
            "category_id": cat1.id,
            "name": "anuncios",
            "channel_type": "text",
            "is_read_only": true,
            "position": 1
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let ro_ch: CommunityChannelDto = serde_json::from_value(ro_val).unwrap();

    // Private channel hidden in member's snapshot & blocked on message send
    let (st, snap_member_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}", comm.id),
        Some(&member_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let snap_member: CommunitySnapshotDto = serde_json::from_value(snap_member_val).unwrap();
    assert!(!snap_member.channels.iter().any(|c| c.id == priv_ch.id));
    assert!(snap_member.channels.iter().any(|c| c.id == ro_ch.id));

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/messages", comm.id, priv_ch.id),
        Some(&member_token),
        Some(json!({ "content": "Tentando entrar sem VIEW_CHANNEL" })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Role overwrite grants VIP access to private channel; user overwrite grants member access too
    let (st, ow_role_val) = send_request(
        &app,
        Method::PUT,
        &format!(
            "/v1/communities/{}/channels/{}/overwrites",
            comm.id, priv_ch.id
        ),
        Some(&owner_token),
        Some(json!({
            "target_type": "role",
            "target_id": vip_role.id,
            "allow_flags": ["VIEW_CHANNEL"]
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let ow_role: ChannelPermissionOverwriteDto = serde_json::from_value(ow_role_val).unwrap();
    assert_eq!(ow_role.target_id, vip_role.id);

    // VIP can now see private channel in snapshot and send message
    let (st, snap_vip_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}", comm.id),
        Some(&vip_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let snap_vip: CommunitySnapshotDto = serde_json::from_value(snap_vip_val).unwrap();
    assert!(snap_vip.channels.iter().any(|c| c.id == priv_ch.id));

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/messages", comm.id, priv_ch.id),
        Some(&vip_token),
        Some(json!({ "content": "VIP falando no privado!" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    // Read-only channel blocks regular member from sending, owner can send, explicit user overwrite allows member
    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/messages", comm.id, ro_ch.id),
        Some(&member_token),
        Some(json!({ "content": "Spam no canal de anúncios" })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/messages", comm.id, ro_ch.id),
        Some(&owner_token),
        Some(json!({ "content": "Comunicado oficial do owner" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(
        &app,
        Method::PUT,
        &format!("/v1/communities/{}/channels/{}/overwrites", comm.id, ro_ch.id),
        Some(&owner_token),
        Some(json!({
            "target_type": "user",
            "target_id": member_id,
            "allow_flags": ["SEND_MESSAGES"]
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/messages", comm.id, ro_ch.id),
        Some(&member_token),
        Some(json!({ "content": "Agora liberado por overwrite de usuário" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    // Delete overwrite and verify member is blocked again
    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!(
            "/v1/communities/{}/channels/{}/overwrites/user/{}",
            comm.id, ro_ch.id, member_id
        ),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/messages", comm.id, ro_ch.id),
        Some(&member_token),
        Some(json!({ "content": "Bloqueado novamente" })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Reorder channels across categories
    let (st, reordered_ch_val) = send_request(
        &app,
        Method::PUT,
        &format!("/v1/communities/{}/channels/reorder", comm.id),
        Some(&owner_token),
        Some(json!({
            "items": [
                { "id": ro_ch.id, "category_id": cat2.id, "position": 0 },
                { "id": priv_ch.id, "category_id": cat1.id, "position": 1 }
            ]
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let reordered_ch: Vec<CommunityChannelDto> =
        serde_json::from_value(reordered_ch_val).unwrap();
    assert_eq!(
        reordered_ch
            .iter()
            .find(|c| c.id == ro_ch.id)
            .unwrap()
            .category_id,
        Some(cat2.id)
    );
}

// =========================================================================
// 3. Channel Messages: Idempotency, Pagination, Edit, Delete, Read States
// =========================================================================

#[tokio::test]
async fn test_03_channel_messages_idempotency_pagination_edit_delete_and_read() {
    let (app, _pool) = setup_test_app().await;

    let (_owner_id, owner_token) = register_user(&app, "owner_c3", "owner_c3@nexus.test").await;
    let (_mod_id, mod_token) = register_user(&app, "mod_c3", "mod_c3@nexus.test").await;
    let (_user_id, user_token) = register_user(&app, "user_c3", "user_c3@nexus.test").await;

    let comm = create_community(&app, &owner_token, "Chat Central").await;
    invite_and_join(&app, comm.id, &owner_token, &mod_token).await;
    invite_and_join(&app, comm.id, &owner_token, &user_token).await;

    // Get #geral channel
    let (st, snap_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}", comm.id),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let snapshot: CommunitySnapshotDto = serde_json::from_value(snap_val).unwrap();
    let geral_id = snapshot.channels[0].id;

    // Create second channel to test cross-channel client_message_id conflict
    let (st, other_ch_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels", comm.id),
        Some(&owner_token),
        Some(json!({ "name": "off-topic", "channel_type": "text" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let other_ch: CommunityChannelDto = serde_json::from_value(other_ch_val).unwrap();

    // Give mod_c3 a Moderator role with MANAGE_MESSAGES
    let (st, mod_role_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/roles", comm.id),
        Some(&owner_token),
        Some(json!({
            "name": "Mod",
            "position": 10,
            "permissions_bitmask": (DEFAULT_EVERYONE_PERMISSIONS | PERM_MANAGE_MESSAGES).to_string()
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let mod_role: CommunityRoleDto = serde_json::from_value(mod_role_val).unwrap();

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!(
            "/v1/communities/{}/members/{}/roles/{}",
            comm.id, _mod_id, mod_role.id
        ),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    // 1. Idempotent send via client_message_id
    let client_msg_id = format!("idem-{}", Uuid::new_v4());
    let (st1, m1_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/messages", comm.id, geral_id),
        Some(&user_token),
        Some(json!({
            "content": "Primeira mensagem idempotente",
            "client_message_id": client_msg_id
        })),
    )
    .await;
    assert_eq!(st1, StatusCode::OK);
    let m1: ChannelMessageDto = serde_json::from_value(m1_val).unwrap();

    let (st2, m2_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/messages", comm.id, geral_id),
        Some(&user_token),
        Some(json!({
            "content": "Primeira mensagem idempotente",
            "client_message_id": client_msg_id
        })),
    )
    .await;
    assert_eq!(st2, StatusCode::OK);
    let m2: ChannelMessageDto = serde_json::from_value(m2_val).unwrap();
    assert_eq!(m1.id, m2.id);

    // Reusing the same client_message_id in another channel returns 409 Conflict
    let (st_conflict, _) = send_request(
        &app,
        Method::POST,
        &format!(
            "/v1/communities/{}/channels/{}/messages",
            comm.id, other_ch.id
        ),
        Some(&user_token),
        Some(json!({
            "content": "Mesmo client_message_id em outro canal",
            "client_message_id": client_msg_id
        })),
    )
    .await;
    assert_eq!(st_conflict, StatusCode::CONFLICT);

    // 2. Send 3 more messages and test pagination (before / limit)
    for i in 2..=4 {
        let (st, _) = send_request(
            &app,
            Method::POST,
            &format!("/v1/communities/{}/channels/{}/messages", comm.id, geral_id),
            Some(&user_token),
            Some(json!({ "content": format!("Mensagem {}", i) })),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
    }

    let (st, page1_val) = send_request(
        &app,
        Method::GET,
        &format!(
            "/v1/communities/{}/channels/{}/messages?limit=2",
            comm.id, geral_id
        ),
        Some(&mod_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let page1: ChannelMessagesPageDto = serde_json::from_value(page1_val).unwrap();
    assert_eq!(page1.messages.len(), 2);
    assert!(page1.has_more);
    assert_eq!(page1.messages[0].content, "Mensagem 3");
    assert_eq!(page1.messages[1].content, "Mensagem 4");

    let next_before = page1.next_before.unwrap();
    let (st, page2_val) = send_request(
        &app,
        Method::GET,
        &format!(
            "/v1/communities/{}/channels/{}/messages?limit=2&before={}",
            comm.id, geral_id, next_before
        ),
        Some(&mod_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let page2: ChannelMessagesPageDto = serde_json::from_value(page2_val).unwrap();
    assert_eq!(page2.messages.len(), 2);
    assert!(!page2.has_more);
    assert_eq!(page2.messages[0].id, m1.id);

    // 3. Edit message: author succeeds, moderator fails (403)
    let (st, _) = send_request(
        &app,
        Method::PATCH,
        &format!(
            "/v1/communities/{}/channels/{}/messages/{}",
            comm.id, geral_id, m1.id
        ),
        Some(&mod_token),
        Some(json!({ "content": "Mod tentando editar" })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, edited_val) = send_request(
        &app,
        Method::PATCH,
        &format!(
            "/v1/communities/{}/channels/{}/messages/{}",
            comm.id, geral_id, m1.id
        ),
        Some(&user_token),
        Some(json!({ "content": "Mensagem 1 editada" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let edited: ChannelMessageDto = serde_json::from_value(edited_val).unwrap();
    assert_eq!(edited.content, "Mensagem 1 editada");
    assert!(edited.edited_at.is_some());

    // 4. Mark channel read for moderator & verify unread_count becomes 0
    let (st, snap_before_read) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}", comm.id),
        Some(&mod_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let snap_before: CommunitySnapshotDto = serde_json::from_value(snap_before_read).unwrap();
    assert_eq!(snap_before.community.unread_count, 4);

    let (st, read_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/read", comm.id, geral_id),
        Some(&mod_token),
        Some(json!({ "last_read_message_id": page1.messages[1].id })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let read_state: ChannelReadStateDto = serde_json::from_value(read_val).unwrap();
    assert_eq!(
        read_state.last_read_message_id,
        Some(page1.messages[1].id)
    );

    let (st, snap_after_read) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}", comm.id),
        Some(&mod_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let snap_after: CommunitySnapshotDto = serde_json::from_value(snap_after_read).unwrap();
    assert_eq!(snap_after.community.unread_count, 0);

    // 5. Delete message: author deletes own message, moderator deletes another message (audit logged)
    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!(
            "/v1/communities/{}/channels/{}/messages/{}",
            comm.id, geral_id, m1.id
        ),
        Some(&user_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let target_msg_id = page1.messages[1].id;
    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!(
            "/v1/communities/{}/channels/{}/messages/{}",
            comm.id, geral_id, target_msg_id
        ),
        Some(&mod_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, logs_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}/audit-logs?action=message.delete", comm.id),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let logs: Vec<CommunityAuditLogDto> = serde_json::from_value(logs_val).unwrap();
    assert!(logs.iter().any(|l| l.target_id == Some(target_msg_id)));
}

// =========================================================================
// 4. Security & Anti-Escalation Hierarchy (Backend Authoritative)
// =========================================================================

#[tokio::test]
async fn test_04_security_hierarchy_and_anti_escalation() {
    let (app, _pool) = setup_test_app().await;

    let (owner_id, owner_token) = register_user(&app, "owner_c4", "owner_c4@nexus.test").await;
    let (manager_id, manager_token) =
        register_user(&app, "manager_c4", "manager_c4@nexus.test").await;
    let (peer_id, peer_token) = register_user(&app, "peer_c4", "peer_c4@nexus.test").await;
    let (low_id, low_token) = register_user(&app, "low_c4", "low_c4@nexus.test").await;
    let (_outsider_id, outsider_token) =
        register_user(&app, "outsider_c4", "outsider_c4@nexus.test").await;

    let comm = create_community(&app, &owner_token, "Security Guild").await;
    invite_and_join(&app, comm.id, &owner_token, &manager_token).await;
    invite_and_join(&app, comm.id, &owner_token, &peer_token).await;
    invite_and_join(&app, comm.id, &owner_token, &low_token).await;

    let (st, snap_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}", comm.id),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let snapshot: CommunitySnapshotDto = serde_json::from_value(snap_val).unwrap();
    let everyone_role_id = snapshot.roles.iter().find(|r| r.is_default).unwrap().id;
    let geral_id = snapshot.channels[0].id;

    // Non-member receives 403 on community endpoints
    let (st, _) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}", comm.id),
        Some(&outsider_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/messages", comm.id, geral_id),
        Some(&outsider_token),
        Some(json!({ "content": "Outsider tentando postar" })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Regular member without permissions receives 403 on admin endpoints
    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/roles", comm.id),
        Some(&low_token),
        Some(json!({ "name": "HackedRole", "position": 1 })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Owner creates roles:
    // - ManagerRole (pos 10, MANAGE_ROLES | MANAGE_CHANNELS | MODERATE_MEMBERS)
    // - PeerRole (pos 10, VIEW_CHANNEL)
    // - HighRole (pos 20, VIEW_CHANNEL)
    // - LowRole (pos 3, VIEW_CHANNEL)
    let manager_perms =
        DEFAULT_EVERYONE_PERMISSIONS | PERM_MANAGE_ROLES | PERM_MANAGE_CHANNELS | PERM_MODERATE_MEMBERS;
    let (st, mr_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/roles", comm.id),
        Some(&owner_token),
        Some(json!({
            "name": "Manager",
            "position": 10,
            "permissions_bitmask": manager_perms.to_string()
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let manager_role: CommunityRoleDto = serde_json::from_value(mr_val).unwrap();

    let (st, pr_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/roles", comm.id),
        Some(&owner_token),
        Some(json!({
            "name": "Peer",
            "position": 10,
            "permissions_bitmask": PERM_VIEW_CHANNEL.to_string()
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let peer_role: CommunityRoleDto = serde_json::from_value(pr_val).unwrap();

    let (st, hr_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/roles", comm.id),
        Some(&owner_token),
        Some(json!({
            "name": "High",
            "position": 20,
            "permissions_bitmask": PERM_VIEW_CHANNEL.to_string()
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let high_role: CommunityRoleDto = serde_json::from_value(hr_val).unwrap();

    let (st, lr_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/roles", comm.id),
        Some(&owner_token),
        Some(json!({
            "name": "Low",
            "position": 3,
            "permissions_bitmask": PERM_VIEW_CHANNEL.to_string()
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let low_role: CommunityRoleDto = serde_json::from_value(lr_val).unwrap();

    for (uid, rid) in [
        (manager_id, manager_role.id),
        (peer_id, peer_role.id),
        (low_id, low_role.id),
    ] {
        let (st, _) = send_request(
            &app,
            Method::POST,
            &format!("/v1/communities/{}/members/{}/roles/{}", comm.id, uid, rid),
            Some(&owner_token),
            None,
        )
        .await;
        assert_eq!(st, StatusCode::OK);
    }

    // Anti-escalation on Roles:
    // 1. Cannot create role at position >= actor_top_position (10)
    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/roles", comm.id),
        Some(&manager_token),
        Some(json!({
            "name": "EqualPos",
            "position": 10,
            "permissions_bitmask": PERM_VIEW_CHANNEL.to_string()
        })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // 2. Cannot create role granting permissions the actor does not possess (e.g. MANAGE_COMMUNITY / ADMINISTRATOR)
    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/roles", comm.id),
        Some(&manager_token),
        Some(json!({
            "name": "BitEscalation",
            "position": 5,
            "permissions_bitmask": PERM_MANAGE_COMMUNITY.to_string()
        })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/roles", comm.id),
        Some(&manager_token),
        Some(json!({
            "name": "AdminEscalation",
            "position": 5,
            "permissions_bitmask": PERM_ADMINISTRATOR.to_string()
        })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // 3. Cannot edit/delete/assign role >= actor_top_position
    let (st, _) = send_request(
        &app,
        Method::PATCH,
        &format!("/v1/communities/{}/roles/{}", comm.id, high_role.id),
        Some(&manager_token),
        Some(json!({ "name": "Hijacked" })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!("/v1/communities/{}/roles/{}", comm.id, peer_role.id),
        Some(&manager_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!(
            "/v1/communities/{}/members/{}/roles/{}",
            comm.id, low_id, peer_role.id
        ),
        Some(&manager_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // 4. Cannot delete @everyone (even as owner)
    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!("/v1/communities/{}/roles/{}", comm.id, everyone_role_id),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // 5. Manager CANNOT modify owner's roles even when owner has no custom roles (highest_role_position = 0)
    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!(
            "/v1/communities/{}/members/{}/roles/{}",
            comm.id, owner_id, low_role.id
        ),
        Some(&manager_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _) = send_request(
        &app,
        Method::PUT,
        &format!("/v1/communities/{}/members/{}/roles", comm.id, owner_id),
        Some(&manager_token),
        Some(json!({ "role_ids": [] })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Anti-escalation on Moderation: cannot kick/ban/mute equal/higher peer or owner
    for endpoint in ["kick", "ban"] {
        let (st, _) = send_request(
            &app,
            Method::POST,
            &format!("/v1/communities/{}/members/{}/{}", comm.id, peer_id, endpoint),
            Some(&manager_token),
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);

        let (st, _) = send_request(
            &app,
            Method::POST,
            &format!(
                "/v1/communities/{}/members/{}/{}",
                comm.id, owner_id, endpoint
            ),
            Some(&manager_token),
            Some(json!({})),
        )
        .await;
        assert_eq!(st, StatusCode::FORBIDDEN);
    }

    let (st, _) = send_request(
        &app,
        Method::PUT,
        &format!("/v1/communities/{}/members/{}/mute", comm.id, peer_id),
        Some(&manager_token),
        Some(json!({ "text_muted_until": (Utc::now() + Duration::minutes(10)) })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Anti-escalation on Channel Overwrites:
    // 1. Cannot grant permission bit actor doesn't possess (VIEW_AUDIT_LOG)
    let (st, _) = send_request(
        &app,
        Method::PUT,
        &format!(
            "/v1/communities/{}/channels/{}/overwrites",
            comm.id, geral_id
        ),
        Some(&manager_token),
        Some(json!({
            "target_type": "user",
            "target_id": low_id,
            "allow_flags": ["VIEW_AUDIT_LOG"]
        })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // 2. Cannot overwrite a role >= actor_top_position or user >= actor_top_position or owner
    let (st, _) = send_request(
        &app,
        Method::PUT,
        &format!(
            "/v1/communities/{}/channels/{}/overwrites",
            comm.id, geral_id
        ),
        Some(&manager_token),
        Some(json!({
            "target_type": "role",
            "target_id": high_role.id,
            "deny_flags": ["SEND_MESSAGES"]
        })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _) = send_request(
        &app,
        Method::PUT,
        &format!(
            "/v1/communities/{}/channels/{}/overwrites",
            comm.id, geral_id
        ),
        Some(&manager_token),
        Some(json!({
            "target_type": "user",
            "target_id": peer_id,
            "deny_flags": ["SEND_MESSAGES"]
        })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _) = send_request(
        &app,
        Method::PUT,
        &format!(
            "/v1/communities/{}/channels/{}/overwrites",
            comm.id, geral_id
        ),
        Some(&manager_token),
        Some(json!({
            "target_type": "user",
            "target_id": owner_id,
            "deny_flags": ["SEND_MESSAGES"]
        })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
}

// =========================================================================
// 5. Invites & Blocks: Preview, Atomic uses_count, Re-accept, Expiry, Max Uses, Revoke, Bans, User Blocks
// =========================================================================

#[tokio::test]
async fn test_05_invites_atomic_consumption_expiration_revocation_bans_and_blocks() {
    let (app, pool) = setup_test_app().await;

    let (_owner_id, owner_token) = register_user(&app, "owner_c5", "owner_c5@nexus.test").await;
    let (_u1_id, u1_token) = register_user(&app, "user1_c5", "user1_c5@nexus.test").await;
    let (u2_id, u2_token) = register_user(&app, "user2_c5", "user2_c5@nexus.test").await;
    let (u3_id, u3_token) = register_user(&app, "user3_c5", "user3_c5@nexus.test").await;

    let comm = create_community(&app, &owner_token, "Convites Guild").await;

    // 1. Create invite with max_uses = 2
    let (st, inv_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/invites", comm.id),
        Some(&owner_token),
        Some(json!({ "max_uses": 2, "expires_in_secs": 3600 })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let inv: CommunityInviteDto = serde_json::from_value(inv_val).unwrap();
    assert_eq!(inv.uses_count, 0);

    // 2. Preview invite
    let (st, prev_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/invites/{}", inv.code),
        Some(&u1_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let preview: InvitePreviewDto = serde_json::from_value(prev_val).unwrap();
    assert!(preview.is_valid);
    assert_eq!(preview.community_id, comm.id);

    // 3. u1 accepts -> uses_count becomes 1, already_member = false
    let (st, acc1_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/invites/{}/accept", inv.code),
        Some(&u1_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let acc1: AcceptInviteResponse = serde_json::from_value(acc1_val).unwrap();
    assert!(!acc1.already_member);

    // 4. u1 re-accepts -> already_member = true, uses_count stays 1
    let (st, acc1_again_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/invites/{}/accept", inv.code),
        Some(&u1_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let acc1_again: AcceptInviteResponse = serde_json::from_value(acc1_again_val).unwrap();
    assert!(acc1_again.already_member);

    let (st, list_inv_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}/invites", comm.id),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let invs: Vec<CommunityInviteDto> = serde_json::from_value(list_inv_val).unwrap();
    assert_eq!(invs.iter().find(|i| i.id == inv.id).unwrap().uses_count, 1);

    // 5. Block user2 via user_blocks -> preview and accept return 403 without consuming use
    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/users/{}/block", u2_id),
        Some(&owner_token),
        None,
    )
    .await;
    assert!(st.is_success());

    let (st, _) = send_request(
        &app,
        Method::GET,
        &format!("/v1/invites/{}", inv.code),
        Some(&u2_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/invites/{}/accept", inv.code),
        Some(&u2_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // 6. Ban user3 before joining -> preview and accept return 403 without consuming use
    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/members/{}/ban", comm.id, u3_id),
        Some(&owner_token),
        Some(json!({ "reason": "Banido preventivamente" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(
        &app,
        Method::GET,
        &format!("/v1/invites/{}", inv.code),
        Some(&u3_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/invites/{}/accept", inv.code),
        Some(&u3_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Confirm uses_count is still 1
    let (st, list_inv_val2) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}/invites", comm.id),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let invs2: Vec<CommunityInviteDto> = serde_json::from_value(list_inv_val2).unwrap();
    assert_eq!(invs2.iter().find(|i| i.id == inv.id).unwrap().uses_count, 1);

    // Unblock user2 -> user2 accepts -> uses_count reaches 2 (max_uses exhausted)
    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!("/v1/users/{}/block", u2_id),
        Some(&owner_token),
        None,
    )
    .await;
    assert!(st.is_success());

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/invites/{}/accept", inv.code),
        Some(&u2_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    // Unban user3 -> tries exhausted invite -> 400 BadRequest
    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!("/v1/communities/{}/bans/{}", comm.id, u3_id),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/invites/{}/accept", inv.code),
        Some(&u3_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // 7. Revoked invite fails
    let (st, rev_inv_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/invites", comm.id),
        Some(&owner_token),
        Some(json!({})),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let rev_inv: CommunityInviteDto = serde_json::from_value(rev_inv_val).unwrap();

    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!("/v1/communities/{}/invites/{}", comm.id, rev_inv.id),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/invites/{}/accept", rev_inv.code),
        Some(&u3_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // 8. Expired invite fails
    let (st, exp_inv_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/invites", comm.id),
        Some(&owner_token),
        Some(json!({ "expires_in_secs": 120 })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let exp_inv: CommunityInviteDto = serde_json::from_value(exp_inv_val).unwrap();

    sqlx::query("UPDATE community_invites SET expires_at = NOW() - INTERVAL '5 minutes' WHERE id = $1")
        .bind(exp_inv.id)
        .execute(&pool)
        .await
        .unwrap();

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/invites/{}/accept", exp_inv.code),
        Some(&u3_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

// =========================================================================
// 6. Moderation & Audit Logs: Kick, Ban (delete_message_hours), Unban, Mute, VIEW_AUDIT_LOG
// =========================================================================

#[tokio::test]
async fn test_06_moderation_kick_ban_unban_mute_and_audit_logs() {
    let (app, _pool) = setup_test_app().await;

    let (_owner_id, owner_token) = register_user(&app, "owner_c6", "owner_c6@nexus.test").await;
    let (auditor_id, auditor_token) =
        register_user(&app, "auditor_c6", "auditor_c6@nexus.test").await;
    let (target_id, target_token) =
        register_user(&app, "target_c6", "target_c6@nexus.test").await;

    let comm = create_community(&app, &owner_token, "Moderation HQ").await;
    invite_and_join(&app, comm.id, &owner_token, &auditor_token).await;
    invite_and_join(&app, comm.id, &owner_token, &target_token).await;

    let (st, snap_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}", comm.id),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let snapshot: CommunitySnapshotDto = serde_json::from_value(snap_val).unwrap();
    let geral_id = snapshot.channels[0].id;

    // 1. Regular member cannot read audit logs (requires VIEW_AUDIT_LOG)
    let (st, _) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}/audit-logs", comm.id),
        Some(&auditor_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Grant auditor role with VIEW_AUDIT_LOG only
    let (st, aud_role_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/roles", comm.id),
        Some(&owner_token),
        Some(json!({
            "name": "Auditor",
            "position": 5,
            "permissions_bitmask": (DEFAULT_EVERYONE_PERMISSIONS | PERM_VIEW_AUDIT_LOG).to_string()
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let aud_role: CommunityRoleDto = serde_json::from_value(aud_role_val).unwrap();

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!(
            "/v1/communities/{}/members/{}/roles/{}",
            comm.id, auditor_id, aud_role.id
        ),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}/audit-logs", comm.id),
        Some(&auditor_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    // 2. Mute target in text -> target blocked from sending messages (403), then unmute -> allowed
    let (st, mute_val) = send_request(
        &app,
        Method::PUT,
        &format!("/v1/communities/{}/members/{}/mute", comm.id, target_id),
        Some(&owner_token),
        Some(json!({
            "reason": "Flood no chat",
            "text_muted_until": (Utc::now() + Duration::minutes(15))
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let mute: CommunityMemberMuteDto = serde_json::from_value(mute_val).unwrap();
    assert!(mute.text_muted_until.is_some());

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/messages", comm.id, geral_id),
        Some(&target_token),
        Some(json!({ "content": "Tentando falar mutado" })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _) = send_request(
        &app,
        Method::PUT,
        &format!("/v1/communities/{}/members/{}/mute", comm.id, target_id),
        Some(&owner_token),
        Some(json!({
            "reason": "Desmutado",
            "text_muted_until": null
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, msg_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/messages", comm.id, geral_id),
        Some(&target_token),
        Some(json!({ "content": "Mensagem antes do ban" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let msg: ChannelMessageDto = serde_json::from_value(msg_val).unwrap();

    // 3. Kick target -> target removed from community, can rejoin with new invite
    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/members/{}/kick", comm.id, target_id),
        Some(&owner_token),
        Some(json!({ "reason": "Aviso inicial" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}", comm.id),
        Some(&target_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let rejoin_inv = invite_and_join(&app, comm.id, &owner_token, &target_token).await;

    // 4. Ban target with delete_message_hours = 24 -> removes member, soft-deletes recent message, blocks rejoin
    let (st, ban_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/members/{}/ban", comm.id, target_id),
        Some(&owner_token),
        Some(json!({
            "reason": "Reincidência",
            "delete_message_hours": 24
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let ban: CommunityBan = serde_json::from_value(ban_val).unwrap();
    assert_eq!(ban.user_id, target_id);

    // Message from target was soft-deleted
    let (st, page_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}/channels/{}/messages", comm.id, geral_id),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let page: ChannelMessagesPageDto = serde_json::from_value(page_val).unwrap();
    assert!(!page.messages.iter().any(|m| m.id == msg.id));

    // Bans list includes target
    let (st, bans_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}/bans", comm.id),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let bans: Vec<CommunityBanDto> = serde_json::from_value(bans_val).unwrap();
    assert!(bans.iter().any(|b| b.user_id == target_id));

    // Banned user cannot accept invite
    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/invites/{}/accept", rejoin_inv.code),
        Some(&target_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // 5. Unban target -> can rejoin and audit logs contain kick, ban, unban, mute
    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!("/v1/communities/{}/bans/{}", comm.id, target_id),
        Some(&owner_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/invites/{}/accept", rejoin_inv.code),
        Some(&target_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, logs_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}/audit-logs", comm.id),
        Some(&auditor_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let logs: Vec<CommunityAuditLogDto> = serde_json::from_value(logs_val).unwrap();
    for expected_action in ["member.mute", "member.kick", "member.ban", "member.unban"] {
        assert!(
            logs.iter().any(|l| l.action == expected_action),
            "expected audit log action {} not found",
            expected_action
        );
    }
}

// =========================================================================
// 7. Regression Check: Existing Core Routes (/health, /v1/auth, /v1/users, /v1/friends, /v1/dm, /v1/webrtc, /v1/gateway/ticket)
// =========================================================================

#[tokio::test]
async fn test_07_existing_routes_no_regression() {
    let (app, _pool) = setup_test_app().await;

    let (st, _) = send_request(&app, Method::GET, "/health", None, None).await;
    assert_eq!(st, StatusCode::OK);

    let (_alice_id, alice_token) = register_user(&app, "alice_reg", "alice_reg@nexus.test").await;

    let (st, _) = send_request(&app, Method::GET, "/v1/users/me", Some(&alice_token), None).await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(&app, Method::GET, "/v1/friends", Some(&alice_token), None).await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(
        &app,
        Method::GET,
        "/v1/dm/conversations",
        Some(&alice_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(
        &app,
        Method::GET,
        "/v1/webrtc/ice-servers",
        Some(&alice_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _) = send_request(
        &app,
        Method::POST,
        "/v1/gateway/ticket",
        Some(&alice_token),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
}

// =========================================================================
// 8. Invite Concurrency: Atomic max_uses enforcement under parallel accepts
// =========================================================================

#[tokio::test]
async fn test_08_invite_concurrency_max_uses_atomic() {
    let (app, pool) = setup_test_app().await;

    let (_owner_id, owner_token) = register_user(&app, "owner_c8", "owner_c8@nexus.test").await;
    let comm = create_community(&app, &owner_token, "Concurrency Guild").await;

    let mut user_tokens = Vec::new();
    for i in 0..6 {
        let (_uid, tok) = register_user(
            &app,
            &format!("conc_u{}", i),
            &format!("conc_u{}@nexus.test", i),
        )
        .await;
        user_tokens.push(tok);
    }

    // Part A: max_uses = 1 with 6 concurrent accept requests
    let (st, inv1_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/invites", comm.id),
        Some(&owner_token),
        Some(json!({ "max_uses": 1, "expires_in_secs": 3600 })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let inv1: CommunityInviteDto = serde_json::from_value(inv1_val).unwrap();

    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(6));
    let mut handles = Vec::new();
    for tok in &user_tokens {
        let app_c = app.clone();
        let code_c = inv1.code.clone();
        let tok_c = tok.clone();
        let b_c = barrier.clone();
        handles.push(tokio::spawn(async move {
            b_c.wait().await;
            send_request(
                &app_c,
                Method::POST,
                &format!("/v1/invites/{}/accept", code_c),
                Some(&tok_c),
                None,
            )
            .await
        }));
    }

    let mut ok_count = 0usize;
    let mut bad_req_count = 0usize;
    for h in handles {
        let (status, body) = h.await.unwrap();
        if status == StatusCode::OK {
            let acc: AcceptInviteResponse = serde_json::from_value(body).unwrap();
            assert!(!acc.already_member);
            ok_count += 1;
        } else {
            assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected status: {:?}", body);
            bad_req_count += 1;
        }
    }
    assert_eq!(ok_count, 1, "exactly 1 concurrent accept must succeed for max_uses=1");
    assert_eq!(bad_req_count, 5);

    let uses_db: i32 = sqlx::query_scalar("SELECT uses_count FROM community_invites WHERE id = $1")
        .bind(inv1.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(uses_db, 1);

    let members_db: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM community_members WHERE community_id = $1")
            .bind(comm.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(members_db, 2); // owner + 1 winner

    // Part B: max_uses = 2 with 6 concurrent accept requests (including the already-member winner)
    let (st, inv2_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/invites", comm.id),
        Some(&owner_token),
        Some(json!({ "max_uses": 2, "expires_in_secs": 3600 })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let inv2: CommunityInviteDto = serde_json::from_value(inv2_val).unwrap();

    let barrier2 = std::sync::Arc::new(tokio::sync::Barrier::new(6));
    let mut handles2 = Vec::new();
    for tok in &user_tokens {
        let app_c = app.clone();
        let code_c = inv2.code.clone();
        let tok_c = tok.clone();
        let b_c = barrier2.clone();
        handles2.push(tokio::spawn(async move {
            b_c.wait().await;
            send_request(
                &app_c,
                Method::POST,
                &format!("/v1/invites/{}/accept", code_c),
                Some(&tok_c),
                None,
            )
            .await
        }));
    }

    let mut new_joins = 0usize;
    let mut already_member_joins = 0usize;
    let mut rejected = 0usize;
    for h in handles2 {
        let (status, body) = h.await.unwrap();
        if status == StatusCode::OK {
            let acc: AcceptInviteResponse = serde_json::from_value(body).unwrap();
            if acc.already_member {
                already_member_joins += 1;
            } else {
                new_joins += 1;
            }
        } else {
            assert_eq!(status, StatusCode::BAD_REQUEST, "unexpected status: {:?}", body);
            rejected += 1;
        }
    }
    assert_eq!(new_joins, 2, "exactly 2 new members must consume max_uses=2");
    assert!(already_member_joins <= 1);
    assert_eq!(already_member_joins + rejected, 4);

    let uses_db2: i32 = sqlx::query_scalar("SELECT uses_count FROM community_invites WHERE id = $1")
        .bind(inv2.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(uses_db2, 2);

    let members_db2: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM community_members WHERE community_id = $1")
            .bind(comm.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(members_db2, 4); // owner + 1 from inv1 + 2 from inv2
}

// =========================================================================
// 9. Cross-Community Isolation: Resources of Community A inaccessible via Community B
// =========================================================================

#[tokio::test]
async fn test_09_cross_community_isolation() {
    let (app, _pool) = setup_test_app().await;

    let (_owner_a_id, owner_a_tok) = register_user(&app, "owner_iso_a", "owner_iso_a@nexus.test").await;
    let (_owner_b_id, owner_b_tok) = register_user(&app, "owner_iso_b", "owner_iso_b@nexus.test").await;
    let (member_a_id, member_a_tok) = register_user(&app, "member_iso_a", "member_iso_a@nexus.test").await;

    let comm_a = create_community(&app, &owner_a_tok, "Isolation Alpha").await;
    let comm_b = create_community(&app, &owner_b_tok, "Isolation Beta").await;

    invite_and_join(&app, comm_a.id, &owner_a_tok, &member_a_tok).await;
    // Also make owner_b a regular (non-admin) member of comm_a to test cross-community path confusion
    invite_and_join(&app, comm_a.id, &owner_a_tok, &owner_b_tok).await;

    // Create category, channel, role, overwrite, message in comm_a
    let (st, cat_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/categories", comm_a.id),
        Some(&owner_a_tok),
        Some(json!({ "name": "Alpha Cat" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let cat_a: CommunityCategoryDto = serde_json::from_value(cat_val).unwrap();

    let (st, ch_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels", comm_a.id),
        Some(&owner_a_tok),
        Some(json!({ "name": "alpha-secret", "channel_type": "text", "category_id": cat_a.id })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let chan_a: CommunityChannelDto = serde_json::from_value(ch_val).unwrap();

    let (st, role_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/roles", comm_a.id),
        Some(&owner_a_tok),
        Some(json!({
            "name": "Alpha Role",
            "position": 5,
            "permissions_bitmask": DEFAULT_EVERYONE_PERMISSIONS.to_string()
        })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let role_a: CommunityRoleDto = serde_json::from_value(role_val).unwrap();

    let (st, msg_val) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/messages", comm_a.id, chan_a.id),
        Some(&owner_a_tok),
        Some(json!({ "content": "Secret alpha message" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let msg_a: ChannelMessageDto = serde_json::from_value(msg_val).unwrap();

    // Owner of comm_b tries to manipulate comm_a's resources using comm_b's ID in the path
    let (st, _) = send_request(
        &app,
        Method::PATCH,
        &format!("/v1/communities/{}/channels/{}", comm_b.id, chan_a.id),
        Some(&owner_b_tok),
        Some(json!({ "name": "hijacked" })),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!("/v1/communities/{}/channels/{}", comm_b.id, chan_a.id),
        Some(&owner_b_tok),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let (st, _) = send_request(
        &app,
        Method::PUT,
        &format!(
            "/v1/communities/{}/channels/{}/overwrites",
            comm_b.id, chan_a.id
        ),
        Some(&owner_b_tok),
        Some(json!({
            "target_type": "role",
            "target_id": role_a.id,
            "allow_flags": ["VIEW_CHANNEL"]
        })),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let (st, _) = send_request(
        &app,
        Method::PATCH,
        &format!("/v1/communities/{}/roles/{}", comm_b.id, role_a.id),
        Some(&owner_b_tok),
        Some(json!({ "name": "Hijacked Role" })),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!("/v1/communities/{}/roles/{}", comm_b.id, role_a.id),
        Some(&owner_b_tok),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!(
            "/v1/communities/{}/members/{}/roles/{}",
            comm_b.id, member_a_id, role_a.id
        ),
        Some(&owner_b_tok),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/members/{}/kick", comm_b.id, member_a_id),
        Some(&owner_b_tok),
        Some(json!({ "reason": "cross-community kick attempt" })),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // Owner of comm_b tries to edit/delete msg_a in comm_a/chan_a (even as regular member of comm_a)
    let (st, _) = send_request(
        &app,
        Method::PATCH,
        &format!(
            "/v1/communities/{}/channels/{}/messages/{}",
            comm_a.id, chan_a.id, msg_a.id
        ),
        Some(&owner_b_tok),
        Some(json!({ "content": "tampered" })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _) = send_request(
        &app,
        Method::DELETE,
        &format!(
            "/v1/communities/{}/channels/{}/messages/{}",
            comm_a.id, chan_a.id, msg_a.id
        ),
        Some(&owner_b_tok),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Cross-community message access via comm_b's ID -> 404
    let (st, _) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}/channels/{}/messages", comm_b.id, chan_a.id),
        Some(&owner_b_tok),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // Audit log of comm_b must not expose any comm_a actions or target_ids
    let (st, audit_b_val) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}/audit-logs", comm_b.id),
        Some(&owner_b_tok),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let audit_b: Vec<CommunityAuditLogDto> = serde_json::from_value(audit_b_val).unwrap();
    assert!(
        audit_b.iter().all(|l| l.community_id == comm_b.id
            && l.target_id != Some(chan_a.id)
            && l.target_id != Some(role_a.id)
            && l.target_id != Some(cat_a.id)),
        "comm_b audit logs leaked comm_a resource"
    );

    // Non-member of comm_a (new user) cannot access chan_a messages or read state
    let (_outsider_id, outsider_tok) = register_user(&app, "outsider_iso", "outsider_iso@nexus.test").await;
    let (st, _) = send_request(
        &app,
        Method::GET,
        &format!("/v1/communities/{}/channels/{}/messages", comm_a.id, chan_a.id),
        Some(&outsider_tok),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _) = send_request(
        &app,
        Method::POST,
        &format!("/v1/communities/{}/channels/{}/read", comm_a.id, chan_a.id),
        Some(&outsider_tok),
        Some(json!({ "last_read_message_id": msg_a.id })),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
}
