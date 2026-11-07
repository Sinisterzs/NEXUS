use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as TungsteniteMessage};
use uuid::Uuid;

use nexus_server::config::AppConfig;
use nexus_server::create_app;
use nexus_server::models::{
    DirectConversationDto, DirectMessageDto, GatewayEvent, GatewayTicketResponse,
};

async fn setup_test_server() -> (String, PgPool) {
    let mut config = AppConfig::from_env();
    let test_db_url = config
        .test_database_url
        .clone()
        .unwrap_or_else(|| "postgres://postgres@localhost:5432/nexus_test_db".to_string());
    config.database_url = test_db_url.clone();
    config.rate_limit_auth_per_minute = 5000;

    let pool = PgPool::connect(&test_db_url)
        .await
        .expect("Falha ao conectar no banco de testes");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Falha ao rodar migrações no banco de teste");

    // Clean tables before tests
    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("Falha ao limpar tabelas de teste");

    let app = create_app(pool.clone(), config);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("Falha ao vincular porta efêmera");
    let addr = listener.local_addr().expect("Falha ao obter endereço local");

    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    (format!("http://{}", addr), pool)
}

async fn register_user(base_url: &str, username: &str, email: &str) -> (String, String) {
    let client = Client::new();
    let res = client
        .post(format!("{}/v1/auth/register", base_url))
        .json(&json!({
            "username": username,
            "email": email,
            "password": "Password123!",
            "display_name": username
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::CREATED);
    let body: Value = res.json().await.unwrap();
    let user_id = body["user"]["id"].as_str().unwrap().to_string();
    let token = body["session_token"].as_str().unwrap().to_string();
    (user_id, token)
}

async fn make_friends(base_url: &str, user_a_token: &str, user_b_token: &str, user_b_username: &str) {
    let client = Client::new();

    // 1. User A sends friend request to User B
    let req_res = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", user_a_token))
        .json(&json!({ "username": user_b_username }))
        .send()
        .await
        .unwrap();
    assert_eq!(req_res.status(), StatusCode::OK);
    let req_body: Value = req_res.json().await.unwrap();
    let req_id = req_body["id"].as_str().unwrap();

    // 2. User B accepts friend request
    let accept_res = client
        .post(format!("{}/v1/friends/requests/{}/accept", base_url, req_id))
        .header("Authorization", format!("Bearer {}", user_b_token))
        .send()
        .await
        .unwrap();
    assert_eq!(accept_res.status(), StatusCode::OK);
}

// -------------------------------------------------------------
// Tests 01..07: Friendship and Blocking Rules
// -------------------------------------------------------------

#[tokio::test]
async fn test_01_friends_can_send_and_receive_messages() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (user_a, token_a) = register_user(&base_url, "alice", "alice@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "bob", "bob@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "bob").await;

    // Alice creates conversation with Bob
    let conv_res = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap();
    assert_eq!(conv_res.status(), StatusCode::OK);
    let conv: DirectConversationDto = conv_res.json().await.unwrap();

    // Alice sends message to Bob
    let client_msg_id = Uuid::new_v4();
    let send_res = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": client_msg_id,
            "content": "Olá Bob! Tudo bem?"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(send_res.status(), StatusCode::OK);
    let msg: DirectMessageDto = send_res.json().await.unwrap();
    assert_eq!(msg.content, "Olá Bob! Tudo bem?");
    assert_eq!(msg.sender_id, Uuid::parse_str(&user_a).unwrap());
    assert!(msg.is_mine);

    // Bob lists messages
    let list_res = client
        .get(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_b))
        .send()
        .await
        .unwrap();
    assert_eq!(list_res.status(), StatusCode::OK);
    let msgs: Vec<DirectMessageDto> = list_res.json().await.unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].content, "Olá Bob! Tudo bem?");
    assert!(!msgs[0].is_mine);
}

#[tokio::test]
async fn test_02_non_friends_blocked_from_sending() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "charlie", "charlie@example.com").await;
    let (user_b, _token_b) = register_user(&base_url, "david", "david@example.com").await;

    // Charlie creates conversation with David (not friends yet)
    let conv_res = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap();
    assert_eq!(conv_res.status(), StatusCode::OK);
    let conv: DirectConversationDto = conv_res.json().await.unwrap();

    // Attempting to send message without friendship must return 403 Forbidden
    let send_res = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Tentando mandar sem amizade."
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(send_res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn test_03_and_04_removed_friendship_blocks_new_messages_but_preserves_history() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "eve", "eve@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "frank", "frank@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "frank").await;

    // Send a message while friends
    let conv_res = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap();
    let conv: DirectConversationDto = conv_res.json().await.unwrap();

    let send_res = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Mensagem antes da remoção da amizade."
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(send_res.status(), StatusCode::OK);

    // Eve removes Frank from friends
    let remove_res = client
        .delete(format!("{}/v1/friends/{}", base_url, user_b))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();
    assert_eq!(remove_res.status(), StatusCode::OK);

    // Point 3: New message sending must now fail with 403 Forbidden
    let send_blocked = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Não deve enviar após amizade desfeita."
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(send_blocked.status(), StatusCode::FORBIDDEN);

    // Point 4: Frank and Eve can still read past history
    let history_res = client
        .get(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_b))
        .send()
        .await
        .unwrap();
    assert_eq!(history_res.status(), StatusCode::OK);
    let msgs: Vec<DirectMessageDto> = history_res.json().await.unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].content, "Mensagem antes da remoção da amizade.");
}

#[tokio::test]
async fn test_05_and_06_block_blocks_sending_and_hides_history() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "grace", "grace@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "heidi", "heidi@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "heidi").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Send a message
    client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Mensagem que ficará oculta sob bloqueio."
        }))
        .send()
        .await
        .unwrap();

    // Grace blocks Heidi
    let block_res = client
        .post(format!("{}/v1/users/{}/block", base_url, user_b))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();
    assert_eq!(block_res.status(), StatusCode::OK);

    // Point 5: Sending message is blocked with 403 Forbidden
    let send_res = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_b))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Tentativa de Heidi bloqueada."
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(send_res.status(), StatusCode::FORBIDDEN);

    // Point 6: Reading conversation history is blocked with 403 Forbidden
    let history_res = client
        .get(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_b))
        .send()
        .await
        .unwrap();
    assert_eq!(history_res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn test_07_unblocking_restores_history_access() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "ivan", "ivan@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "judy", "judy@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "judy").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Histórico seguro."
        }))
        .send()
        .await
        .unwrap();

    // Ivan blocks Judy then unblocks her
    client
        .post(format!("{}/v1/users/{}/block", base_url, user_b))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();

    client
        .delete(format!("{}/v1/users/{}/block", base_url, user_b))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();

    // History is accessible again!
    let history_res = client
        .get(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_b))
        .send()
        .await
        .unwrap();
    assert_eq!(history_res.status(), StatusCode::OK);
    let msgs: Vec<DirectMessageDto> = history_res.json().await.unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].content, "Histórico seguro.");
}

// -------------------------------------------------------------
// Tests 08..12: Validation, Boundary & Idempotency Rules
// -------------------------------------------------------------

#[tokio::test]
async fn test_08_self_conversation_rejected() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (user_a, token_a) = register_user(&base_url, "kevin", "kevin@example.com").await;

    let self_conv = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_a }))
        .send()
        .await
        .unwrap();
    assert_eq!(self_conv.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_09_empty_or_whitespace_message_rejected() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "leo", "leo@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "mia", "mia@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "mia").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Empty message
    let empty_res = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": ""
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(empty_res.status(), StatusCode::BAD_REQUEST);

    // Whitespace only
    let ws_res = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "   \n\t   "
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(ws_res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_10_and_11_max_message_length_boundary() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "noah", "noah@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "olivia", "olivia@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "olivia").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Point 10: Exactly 2000 chars accepted
    let exact_2000 = "a".repeat(2000);
    let ok_res = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": exact_2000
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok_res.status(), StatusCode::OK);

    // Point 11: 2001 chars rejected with 400 Bad Request
    let over_2001 = "a".repeat(2001);
    let bad_res = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": over_2001
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad_res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_12_idempotency_duplicate_client_message_id() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "peter", "peter@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "quinn", "quinn@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "quinn").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let client_msg_id = Uuid::new_v4();

    // First attempt
    let first_res = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": client_msg_id,
            "content": "Mensagem com idempotência garantida."
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first_res.status(), StatusCode::OK);
    let first_msg: DirectMessageDto = first_res.json().await.unwrap();

    // Second attempt with same client_message_id
    let second_res = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": client_msg_id,
            "content": "Tentando duplicar com mesmo client ID."
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(second_res.status(), StatusCode::OK);
    let second_msg: DirectMessageDto = second_res.json().await.unwrap();

    // IDs match and no duplicate created!
    assert_eq!(first_msg.id, second_msg.id);

    // Verify conversation only has 1 message
    let list_res = client
        .get(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();
    let msgs: Vec<DirectMessageDto> = list_res.json().await.unwrap();
    assert_eq!(msgs.len(), 1);
}

// -------------------------------------------------------------
// Tests 13..19: Message Editing & Soft Deletion
// -------------------------------------------------------------

#[tokio::test]
async fn test_13_edit_own_message_success() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "ruby", "ruby@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "sam", "sam@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "sam").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let msg: DirectMessageDto = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Conteúdo original antes de editar."
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let edit_res = client
        .patch(format!("{}/v1/dm/messages/{}", base_url, msg.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "content": "Conteúdo editado com sucesso!"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(edit_res.status(), StatusCode::OK);
    let edited: DirectMessageDto = edit_res.json().await.unwrap();
    assert_eq!(edited.content, "Conteúdo editado com sucesso!");
    assert!(edited.edited_at.is_some());
}

#[tokio::test]
async fn test_14_edit_other_user_message_forbidden() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "tina", "tina@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "uma", "uma@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "uma").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let msg: DirectMessageDto = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Mensagem da Tina."
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Uma tries to edit Tina's message -> 403 Forbidden
    let edit_res = client
        .patch(format!("{}/v1/dm/messages/{}", base_url, msg.id))
        .header("Authorization", format!("Bearer {}", token_b))
        .json(&json!({
            "content": "Uma tentando alterar mensagem alheia."
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(edit_res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn test_15_edit_validation_bounds() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "victor", "victor@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "wendy", "wendy@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "wendy").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let msg: DirectMessageDto = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Mensagem teste."
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Empty edit
    let empty_edit = client
        .patch(format!("{}/v1/dm/messages/{}", base_url, msg.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "content": "" }))
        .send()
        .await
        .unwrap();
    assert_eq!(empty_edit.status(), StatusCode::BAD_REQUEST);

    // Over 2000 chars edit
    let huge_edit = client
        .patch(format!("{}/v1/dm/messages/{}", base_url, msg.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "content": "x".repeat(2001) }))
        .send()
        .await
        .unwrap();
    assert_eq!(huge_edit.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_16_edit_deleted_message_rejected() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "xander", "xander@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "yara", "yara@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "yara").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let msg: DirectMessageDto = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Mensagem antes de ser excluída."
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Delete message
    let del_res = client
        .delete(format!("{}/v1/dm/messages/{}", base_url, msg.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();
    assert_eq!(del_res.status(), StatusCode::OK);

    // Editing deleted message must fail with 400 Bad Request
    let edit_del = client
        .patch(format!("{}/v1/dm/messages/{}", base_url, msg.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "content": "Tentando ressuscitar mensagem apagada." }))
        .send()
        .await
        .unwrap();
    assert_eq!(edit_del.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_17_soft_delete_own_message() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "zack", "zack@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "amy", "amy@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "amy").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let msg: DirectMessageDto = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Esta mensagem será apagada."
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let del_res = client
        .delete(format!("{}/v1/dm/messages/{}", base_url, msg.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();
    assert_eq!(del_res.status(), StatusCode::OK);
    let deleted: DirectMessageDto = del_res.json().await.unwrap();
    assert_eq!(deleted.content, "[Mensagem apagada]");
    assert!(deleted.deleted_at.is_some());

    // Amy lists conversation messages: content is tombstoned
    let list_res = client
        .get(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_b))
        .send()
        .await
        .unwrap();
    let msgs: Vec<DirectMessageDto> = list_res.json().await.unwrap();
    assert_eq!(msgs[0].content, "[Mensagem apagada]");
    assert!(msgs[0].deleted_at.is_some());
}

#[tokio::test]
async fn test_18_delete_other_user_message_forbidden() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "brian", "brian@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "cora", "cora@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "cora").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let msg: DirectMessageDto = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Mensagem de Brian."
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Cora attempts to delete Brian's message -> 403 Forbidden
    let del_res = client
        .delete(format!("{}/v1/dm/messages/{}", base_url, msg.id))
        .header("Authorization", format!("Bearer {}", token_b))
        .send()
        .await
        .unwrap();
    assert_eq!(del_res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn test_19_delete_already_deleted_message_rejected() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "dean", "dean@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "ella", "ella@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "ella").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let msg: DirectMessageDto = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Mensagem única para apagar duas vezes."
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // First deletion -> 200 OK
    let del_1 = client
        .delete(format!("{}/v1/dm/messages/{}", base_url, msg.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();
    assert_eq!(del_1.status(), StatusCode::OK);

    // Second deletion -> 400 Bad Request
    let del_2 = client
        .delete(format!("{}/v1/dm/messages/{}", base_url, msg.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();
    assert_eq!(del_2.status(), StatusCode::BAD_REQUEST);
}

// -------------------------------------------------------------
// Tests 20..22: Delivery and Read Receipts
// -------------------------------------------------------------

#[tokio::test]
async fn test_20_delivery_receipt_marks_delivered() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "fiona", "fiona@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "gabe", "gabe@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "gabe").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let msg: DirectMessageDto = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Mensagem a ser confirmada como entregue."
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(msg.delivered_at.is_none());

    // Gabe confirms delivery of message
    let deliv_res = client
        .post(format!("{}/v1/dm/conversations/{}/delivered", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_b))
        .json(&json!({ "message_ids": [msg.id] }))
        .send()
        .await
        .unwrap();
    assert_eq!(deliv_res.status(), StatusCode::OK);

    // Checking message shows delivered_at is set
    let list_res = client
        .get(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();
    let msgs: Vec<DirectMessageDto> = list_res.json().await.unwrap();
    assert!(msgs[0].delivered_at.is_some());
}

#[tokio::test]
async fn test_21_and_22_read_receipt_marks_messages_read() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "hank", "hank@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "iris", "iris@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "iris").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Hank sends 3 messages
    for i in 1..=3 {
        client
            .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
            .header("Authorization", format!("Bearer {}", token_a))
            .json(&json!({
                "client_message_id": Uuid::new_v4(),
                "content": format!("Mensagem {}", i)
            }))
            .send()
            .await
            .unwrap();
    }

    // Iris lists conversations: unread_count is 3
    let convs_b: Vec<DirectConversationDto> = client
        .get(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_b))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(convs_b[0].unread_count, 3);

    // Iris marks conversation as read
    let read_res = client
        .post(format!("{}/v1/dm/conversations/{}/read", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_b))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(read_res.status(), StatusCode::OK);

    // Point 22: Cumulative read - unread_count drops to 0
    let convs_after: Vec<DirectConversationDto> = client
        .get(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_b))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(convs_after[0].unread_count, 0);

    // Point 21: Hank sees read_at populated on all his messages
    let msgs: Vec<DirectMessageDto> = client
        .get(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    for m in msgs {
        assert!(m.read_at.is_some(), "Mensagem deveria ter read_at preenchido");
    }
}

// -------------------------------------------------------------
// Tests 23..25: Ephemeral Gateway Tickets
// -------------------------------------------------------------

#[tokio::test]
async fn test_23_gateway_auth_ticket_generation() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "jack", "jack@example.com").await;

    let res = client
        .post(format!("{}/v1/gateway/ticket", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();
    let status = res.status();
    let text = res.text().await.unwrap();
    println!("STATUS: {} | BODY: {}", status, text);
    assert_eq!(status, StatusCode::OK);

    let body: GatewayTicketResponse = serde_json::from_str(&text).unwrap();
    assert!(body.ticket.starts_with("gw_tkt_"));
    assert_eq!(body.expires_in_secs, 60);
}

#[tokio::test]
async fn test_24_single_use_ticket_consumed_on_first_use() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "kyle", "kyle@example.com").await;

    let ticket_resp: GatewayTicketResponse = client
        .post(format!("{}/v1/gateway/ticket", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let ws_url = base_url.replace("http://", "ws://");

    // 1. First connection consumes ticket successfully
    let (mut ws_stream, _) = connect_async(format!("{}/v1/gateway", ws_url))
        .await
        .expect("Falha ao abrir socket WS");

    let auth_msg = json!({
        "op": "authenticate",
        "ticket": ticket_resp.ticket
    });
    ws_stream
        .send(TungsteniteMessage::Text(auth_msg.to_string()))
        .await
        .unwrap();

    let ready_frame = tokio::time::timeout(Duration::from_secs(3), ws_stream.next())
        .await
        .expect("Timeout aguardando ready")
        .unwrap()
        .unwrap();

    let ready_val: GatewayEvent = serde_json::from_str(&ready_frame.to_text().unwrap()).unwrap();
    assert_eq!(ready_val.event_type, "connection.ready");

    // 2. Second connection with SAME ticket must be rejected immediately
    let (mut ws_stream_2, _) = connect_async(format!("{}/v1/gateway", ws_url))
        .await
        .expect("Falha ao abrir segundo socket WS");

    ws_stream_2
        .send(TungsteniteMessage::Text(auth_msg.to_string()))
        .await
        .unwrap();

    let reject_frame = tokio::time::timeout(Duration::from_secs(3), ws_stream_2.next())
        .await
        .expect("Timeout aguardando reject")
        .unwrap()
        .unwrap();

    let err_val: GatewayEvent = serde_json::from_str(&reject_frame.to_text().unwrap()).unwrap();
    assert_eq!(err_val.event_type, "error");
}

#[tokio::test]
async fn test_25_expired_ticket_rejected() {
    let (base_url, pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "liam", "liam@example.com").await;

    let ticket_resp: GatewayTicketResponse = client
        .post(format!("{}/v1/gateway/ticket", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Artificially expire ticket in database
    sqlx::query!(
        "UPDATE gateway_auth_tickets SET expires_at = NOW() - INTERVAL '10 seconds' WHERE ticket = $1",
        ticket_resp.ticket
    )
    .execute(&pool)
    .await
    .unwrap();

    let ws_url = base_url.replace("http://", "ws://");
    let (mut ws_stream, _) = connect_async(format!("{}/v1/gateway", ws_url))
        .await
        .expect("Falha ao abrir socket WS");

    let auth_msg = json!({
        "op": "authenticate",
        "ticket": ticket_resp.ticket
    });
    ws_stream
        .send(TungsteniteMessage::Text(auth_msg.to_string()))
        .await
        .unwrap();

    let reject_frame = tokio::time::timeout(Duration::from_secs(3), ws_stream.next())
        .await
        .expect("Timeout aguardando reject")
        .unwrap()
        .unwrap();

    let err_val: GatewayEvent = serde_json::from_str(&reject_frame.to_text().unwrap()).unwrap();
    assert_eq!(err_val.event_type, "error");
}

// -------------------------------------------------------------
// Tests 26..27: Real-Time WebSocket Gateway Events
// -------------------------------------------------------------

#[tokio::test]
async fn test_26_realtime_websocket_message_created() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "mason", "mason@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "nora", "nora@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "nora").await;

    // Connect Nora to WebSocket
    let ws_url = base_url.replace("http://", "ws://");
    let (mut nora_ws, _) = connect_async(format!("{}/v1/gateway", ws_url)).await.unwrap();
    nora_ws
        .send(TungsteniteMessage::Text(
            json!({ "op": "authenticate", "token": token_b }).to_string(),
        ))
        .await
        .unwrap();

    // Consume connection.ready
    let _ = nora_ws.next().await.unwrap().unwrap();

    // Mason opens conversation and sends message
    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Olá Nora! Recebendo em tempo real?"
        }))
        .send()
        .await
        .unwrap();

    // Nora receives dm.message.created
    let event_frame = tokio::time::timeout(Duration::from_secs(3), nora_ws.next())
        .await
        .expect("Timeout aguardando evento WS")
        .unwrap()
        .unwrap();

    let event: GatewayEvent = serde_json::from_str(&event_frame.to_text().unwrap()).unwrap();
    assert_eq!(event.event_type, "dm.message.created");
    assert_eq!(
        event.payload["message"]["content"].as_str().unwrap(),
        "Olá Nora! Recebendo em tempo real?"
    );
    assert!(!event.payload["message"]["is_mine"].as_bool().unwrap());
}

#[tokio::test]
async fn test_27_realtime_websocket_edit_and_delete_notifications() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "oscar", "oscar@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "piper", "piper@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "piper").await;

    let ws_url = base_url.replace("http://", "ws://");
    let (mut piper_ws, _) = connect_async(format!("{}/v1/gateway", ws_url)).await.unwrap();
    piper_ws
        .send(TungsteniteMessage::Text(
            json!({ "op": "authenticate", "token": token_b }).to_string(),
        ))
        .await
        .unwrap();
    let _ = piper_ws.next().await.unwrap().unwrap(); // ready frame

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let msg: DirectMessageDto = client
        .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({
            "client_message_id": Uuid::new_v4(),
            "content": "Texto antes da edição em tempo real."
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Consume created & conversation.updated frames
    let _ = piper_ws.next().await.unwrap().unwrap();
    let _ = piper_ws.next().await.unwrap().unwrap();

    // Oscar edits message
    client
        .patch(format!("{}/v1/dm/messages/{}", base_url, msg.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "content": "Texto devidamente editado!" }))
        .send()
        .await
        .unwrap();

    // Piper receives dm.message.updated
    let edit_frame = tokio::time::timeout(Duration::from_secs(3), piper_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let edit_event: GatewayEvent = serde_json::from_str(&edit_frame.to_text().unwrap()).unwrap();
    assert_eq!(edit_event.event_type, "dm.message.updated");
    assert_eq!(
        edit_event.payload["message"]["content"].as_str().unwrap(),
        "Texto devidamente editado!"
    );

    // Oscar deletes message
    client
        .delete(format!("{}/v1/dm/messages/{}", base_url, msg.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();

    // Piper receives dm.message.deleted
    let del_frame = tokio::time::timeout(Duration::from_secs(3), piper_ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let del_event: GatewayEvent = serde_json::from_str(&del_frame.to_text().unwrap()).unwrap();
    assert_eq!(del_event.event_type, "dm.message.deleted");
    assert_eq!(del_event.payload["id"].as_str().unwrap(), msg.id.to_string());
}

// -------------------------------------------------------------
// Test 28: Keyset Cursor Pagination
// -------------------------------------------------------------

#[tokio::test]
async fn test_28_cursor_pagination_ordering_and_limits() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_user_a, token_a) = register_user(&base_url, "rose", "rose@example.com").await;
    let (user_b, token_b) = register_user(&base_url, "seth", "seth@example.com").await;

    make_friends(&base_url, &token_a, &token_b, "seth").await;

    let conv: DirectConversationDto = client
        .post(format!("{}/v1/dm/conversations", base_url))
        .header("Authorization", format!("Bearer {}", token_a))
        .json(&json!({ "target_user_id": user_b }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Send 15 messages sequentially
    for i in 1..=15 {
        client
            .post(format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id))
            .header("Authorization", format!("Bearer {}", token_a))
            .json(&json!({
                "client_message_id": Uuid::new_v4(),
                "content": format!("Msg {:02}", i)
            }))
            .send()
            .await
            .unwrap();
    }

    // Page 1: limit 5 newest messages
    let page1_res = client
        .get(format!("{}/v1/dm/conversations/{}/messages?limit=5", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();
    let page1: Vec<DirectMessageDto> = page1_res.json().await.unwrap();
    assert_eq!(page1.len(), 5);
    // Returned in chronological order (oldest to newest among the 5 latest: 11..=15)
    assert_eq!(page1[0].content, "Msg 11");
    assert_eq!(page1[4].content, "Msg 15");

    // Page 2: messages before page1[0].id
    let oldest_on_p1 = page1[0].id;
    let page2_res = client
        .get(format!(
            "{}/v1/dm/conversations/{}/messages?limit=5&before_id={}",
            base_url, conv.id, oldest_on_p1
        ))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();
    let page2: Vec<DirectMessageDto> = page2_res.json().await.unwrap();
    assert_eq!(page2.len(), 5);
    assert_eq!(page2[0].content, "Msg 06");
    assert_eq!(page2[4].content, "Msg 10");

    // Page 3: messages before page2[0].id
    let oldest_on_p2 = page2[0].id;
    let page3_res = client
        .get(format!(
            "{}/v1/dm/conversations/{}/messages?limit=5&before_id={}",
            base_url, conv.id, oldest_on_p2
        ))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();
    let page3: Vec<DirectMessageDto> = page3_res.json().await.unwrap();
    assert_eq!(page3.len(), 5);
    assert_eq!(page3[0].content, "Msg 01");
    assert_eq!(page3[4].content, "Msg 05");

    // Page 4: before page3[0].id -> empty
    let oldest_on_p3 = page3[0].id;
    let page4_res = client
        .get(format!(
            "{}/v1/dm/conversations/{}/messages?limit=5&before_id={}",
            base_url, conv.id, oldest_on_p3
        ))
        .header("Authorization", format!("Bearer {}", token_a))
        .send()
        .await
        .unwrap();
    let page4: Vec<DirectMessageDto> = page4_res.json().await.unwrap();
    assert!(page4.is_empty());
}
