use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as TungsteniteMessage};

use nexus_server::config::AppConfig;
use nexus_server::create_app;
use nexus_server::models::{FriendDto, FriendRequestsResponse, GatewayEvent};

async fn setup_test_server() -> (String, PgPool) {
    let mut config = AppConfig::from_env();
    let test_db_url = config
        .test_database_url
        .clone()
        .unwrap_or_else(|| "postgres://postgres@localhost:5432/nexus_test_db".to_string());
    config.database_url = test_db_url.clone();

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

#[tokio::test]
async fn test_01_send_and_list_friend_requests() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_alice_id, alice_token) = register_user(&base_url, "alice_f1", "alice_f1@nexus.local").await;
    let (bob_id, bob_token) = register_user(&base_url, "bob_f1", "bob_f1@nexus.local").await;

    // Alice sends request to Bob
    let send_res = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({ "target": "bob_f1" }))
        .send()
        .await
        .unwrap();

    let status = send_res.status();
    assert_eq!(status, StatusCode::OK);
    let send_body: Value = send_res.json().await.unwrap();
    assert_eq!(send_body["username"], "bob_f1");
    assert_eq!(send_body["status"], "pending");

    // Bob checks pending requests -> should have 1 incoming from Alice
    let bob_reqs_res = client
        .get(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap();

    assert_eq!(bob_reqs_res.status(), StatusCode::OK);
    let bob_reqs: FriendRequestsResponse = bob_reqs_res.json().await.unwrap();
    assert_eq!(bob_reqs.incoming.len(), 1);
    assert_eq!(bob_reqs.incoming[0].username, "alice_f1");
    assert_eq!(bob_reqs.outgoing.len(), 0);

    // Alice checks pending requests -> should have 1 outgoing to Bob
    let alice_reqs_res = client
        .get(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .send()
        .await
        .unwrap();

    assert_eq!(alice_reqs_res.status(), StatusCode::OK);
    let alice_reqs: FriendRequestsResponse = alice_reqs_res.json().await.unwrap();
    assert_eq!(alice_reqs.outgoing.len(), 1);
    assert_eq!(alice_reqs.outgoing[0].user_id.to_string(), bob_id);
    assert_eq!(alice_reqs.incoming.len(), 0);
}

#[tokio::test]
async fn test_02_accept_friend_request_creates_bidirectional_friendship() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_alice_id, alice_token) = register_user(&base_url, "alice_f2", "alice_f2@nexus.local").await;
    let (_bob_id, bob_token) = register_user(&base_url, "bob_f2", "bob_f2@nexus.local").await;

    // Alice sends request to Bob
    let _ = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({ "target": "bob_f2" }))
        .send()
        .await
        .unwrap();

    // Bob gets request id
    let reqs_res = client
        .get(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap();
    let reqs: FriendRequestsResponse = reqs_res.json().await.unwrap();
    let request_id = reqs.incoming[0].id;

    // Bob accepts request
    let accept_res = client
        .post(format!("{}/v1/friends/requests/{}/accept", base_url, request_id))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap();

    assert_eq!(accept_res.status(), StatusCode::OK);

    // Alice lists friends -> includes Bob
    let alice_friends_res = client
        .get(format!("{}/v1/friends", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .send()
        .await
        .unwrap();
    let alice_friends: Vec<FriendDto> = alice_friends_res.json().await.unwrap();
    assert_eq!(alice_friends.len(), 1);
    assert_eq!(alice_friends[0].username, "bob_f2");

    // Bob lists friends -> includes Alice
    let bob_friends_res = client
        .get(format!("{}/v1/friends", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap();
    let bob_friends: Vec<FriendDto> = bob_friends_res.json().await.unwrap();
    assert_eq!(bob_friends.len(), 1);
    assert_eq!(bob_friends[0].username, "alice_f2");
}

#[tokio::test]
async fn test_03_reject_and_cancel_friend_request() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_alice_id, alice_token) = register_user(&base_url, "alice_f3", "alice_f3@nexus.local").await;
    let (_bob_id, bob_token) = register_user(&base_url, "bob_f3", "bob_f3@nexus.local").await;

    // Alice sends request to Bob
    let _ = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({ "target": "bob_f3" }))
        .send()
        .await
        .unwrap();

    let reqs: FriendRequestsResponse = client
        .get(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let request_id = reqs.incoming[0].id;

    // Bob rejects
    let reject_res = client
        .post(format!("{}/v1/friends/requests/{}/reject", base_url, request_id))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap();

    assert_eq!(reject_res.status(), StatusCode::OK);

    // Friends list should still be empty
    let bob_friends: Vec<FriendDto> = client
        .get(format!("{}/v1/friends", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(bob_friends.len(), 0);

    // Now test cancellation: Alice sends request again and cancels it
    let send_again = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({ "target": "bob_f3" }))
        .send()
        .await
        .unwrap();
    assert_eq!(send_again.status(), StatusCode::OK);

    let alice_reqs: FriendRequestsResponse = client
        .get(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let outgoing_id = alice_reqs.outgoing[0].id;

    // Alice cancels outgoing request
    let cancel_res = client
        .delete(format!("{}/v1/friends/requests/{}", base_url, outgoing_id))
        .header("Authorization", format!("Bearer {}", alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(cancel_res.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_04_prevent_duplicate_self_and_cross_requests() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_alice_id, alice_token) = register_user(&base_url, "alice_f4", "alice_f4@nexus.local").await;
    let (_bob_id, bob_token) = register_user(&base_url, "bob_f4", "bob_f4@nexus.local").await;

    // 1. Cannot request self
    let self_res = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({ "target": "alice_f4" }))
        .send()
        .await
        .unwrap();
    assert_eq!(self_res.status(), StatusCode::BAD_REQUEST);

    // 2. First request succeeds
    let ok_res = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({ "target": "bob_f4" }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok_res.status(), StatusCode::OK);

    // 3. Second request from Alice fails with CONFLICT
    let dup_res = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({ "target": "bob_f4" }))
        .send()
        .await
        .unwrap();
    assert_eq!(dup_res.status(), StatusCode::CONFLICT);

    // 4. Cross-request: Bob sends request to Alice while Alice's is pending -> AUTO-ACCEPTS!
    let cross_res = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .json(&json!({ "target": "alice_f4" }))
        .send()
        .await
        .unwrap();
    assert_eq!(cross_res.status(), StatusCode::OK);

    // They are now friends!
    let friends: Vec<FriendDto> = client
        .get(format!("{}/v1/friends", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(friends.len(), 1);
    assert_eq!(friends[0].username, "bob_f4");
}

#[tokio::test]
async fn test_05_block_unblock_and_privacy_preferences() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_alice_id, alice_token) = register_user(&base_url, "alice_f5", "alice_f5@nexus.local").await;
    let (bob_id, bob_token) = register_user(&base_url, "bob_f5", "bob_f5@nexus.local").await;

    // 1. Bob sets allow_friend_requests = false in presence preferences
    let pref_res = client
        .patch(format!("{}/v1/users/me/presence", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .json(&json!({ "allow_friend_requests": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(pref_res.status(), StatusCode::OK);

    // Alice tries to send friend request to Bob -> rejected with BadRequest
    let rej_res = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({ "target": "bob_f5" }))
        .send()
        .await
        .unwrap();
    assert_eq!(rej_res.status(), StatusCode::BAD_REQUEST);

    // Bob re-enables friend requests
    let _ = client
        .patch(format!("{}/v1/users/me/presence", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .json(&json!({ "allow_friend_requests": true }))
        .send()
        .await
        .unwrap();

    // Alice sends and Bob accepts
    let _ = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({ "target": "bob_f5" }))
        .send()
        .await
        .unwrap();
    let reqs: FriendRequestsResponse = client
        .get(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let _ = client
        .post(format!("{}/v1/friends/requests/{}/accept", base_url, reqs.incoming[0].id))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap();

    // 2. Alice blocks Bob
    let block_res = client
        .post(format!("{}/v1/users/{}/block", base_url, bob_id))
        .header("Authorization", format!("Bearer {}", alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(block_res.status(), StatusCode::OK);

    // Friendship is immediately severed
    let alice_friends: Vec<FriendDto> = client
        .get(format!("{}/v1/friends", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(alice_friends.len(), 0);

    // Alice unblocks Bob
    let unblock_res = client
        .delete(format!("{}/v1/users/{}/block", base_url, bob_id))
        .header("Authorization", format!("Bearer {}", alice_token))
        .send()
        .await
        .unwrap();
    assert_eq!(unblock_res.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_06_secure_gateway_websocket_presence() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (alice_id, alice_token) = register_user(&base_url, "alice_gw", "alice_gw@nexus.local").await;
    let (bob_id, bob_token) = register_user(&base_url, "bob_gw", "bob_gw@nexus.local").await;

    // Establish friendship
    let _ = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({ "target": "bob_gw" }))
        .send()
        .await
        .unwrap();

    let reqs: FriendRequestsResponse = client
        .get(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let _ = client
        .post(format!("{}/v1/friends/requests/{}/accept", base_url, reqs.incoming[0].id))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap();

    // Connect Alice to /v1/gateway WITHOUT token in URL
    let ws_url = base_url.replace("http://", "ws://");
    let (mut alice_ws, _) = connect_async(format!("{}/v1/gateway", ws_url))
        .await
        .expect("Alice falhou ao conectar no Gateway");

    // Alice authenticates via initial frame
    alice_ws
        .send(TungsteniteMessage::Text(
            json!({ "op": "authenticate", "token": alice_token }).to_string(),
        ))
        .await
        .unwrap();

    // Alice reads connection.ready event
    let msg1 = alice_ws.next().await.unwrap().unwrap();
    let evt1: GatewayEvent = serde_json::from_str(&msg1.to_text().unwrap()).unwrap();
    assert_eq!(evt1.event_type, "connection.ready");
    assert_eq!(evt1.payload["user_id"].as_str().unwrap(), alice_id);

    // Connect Bob to /v1/gateway
    let (mut bob_ws, _) = connect_async(format!("{}/v1/gateway", ws_url))
        .await
        .expect("Bob falhou ao conectar no Gateway");

    bob_ws
        .send(TungsteniteMessage::Text(
            json!({ "op": "authenticate", "token": bob_token }).to_string(),
        ))
        .await
        .unwrap();

    let _ = bob_ws.next().await.unwrap().unwrap(); // Bob's connection.ready

    // Alice should receive Bob's presence.updated ("online")!
    let msg_online = alice_ws.next().await.unwrap().unwrap();
    let evt_online: GatewayEvent = serde_json::from_str(&msg_online.to_text().unwrap()).unwrap();
    assert_eq!(evt_online.event_type, "presence.updated");
    assert_eq!(evt_online.payload["user_id"].as_str().unwrap(), bob_id);
    assert_eq!(evt_online.payload["status"].as_str().unwrap(), "online");

    // Bob changes presence to idle
    bob_ws
        .send(TungsteniteMessage::Text(
            json!({
                "op": "set_presence",
                "status": "idle",
                "custom_status": "Programando Rust",
                "activity": "NEXUS Core"
            })
            .to_string(),
        ))
        .await
        .unwrap();

    // Alice should receive Bob's updated presence
    let msg_idle = alice_ws.next().await.unwrap().unwrap();
    let evt_idle: GatewayEvent = serde_json::from_str(&msg_idle.to_text().unwrap()).unwrap();
    assert_eq!(evt_idle.event_type, "presence.updated");
    assert_eq!(evt_idle.payload["status"].as_str().unwrap(), "idle");
    assert_eq!(evt_idle.payload["activity"].as_str().unwrap(), "NEXUS Core");

    // Bob disconnects -> Alice receives offline status
    drop(bob_ws);
    let msg_offline = alice_ws.next().await.unwrap().unwrap();
    let evt_offline: GatewayEvent = serde_json::from_str(&msg_offline.to_text().unwrap()).unwrap();
    assert_eq!(evt_offline.event_type, "presence.updated");
    assert_eq!(evt_offline.payload["status"].as_str().unwrap(), "offline");
}

#[tokio::test]
async fn test_07_invisible_status_and_multi_connection() {
    let (base_url, _pool) = setup_test_server().await;
    let client = Client::new();

    let (_alice_id, alice_token) = register_user(&base_url, "alice_inv", "alice_inv@nexus.local").await;
    let (bob_id, bob_token) = register_user(&base_url, "bob_inv", "bob_inv@nexus.local").await;

    // Establish friendship
    let _ = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({ "target": "bob_inv" }))
        .send()
        .await
        .unwrap();

    let reqs: FriendRequestsResponse = client
        .get(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let _ = client
        .post(format!("{}/v1/friends/requests/{}/accept", base_url, reqs.incoming[0].id))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap();

    // Connect Alice to Gateway
    let ws_url = base_url.replace("http://", "ws://");
    let (mut alice_ws, _) = connect_async(format!("{}/v1/gateway", ws_url)).await.unwrap();
    alice_ws
        .send(TungsteniteMessage::Text(
            json!({ "op": "authenticate", "token": alice_token }).to_string(),
        ))
        .await
        .unwrap();
    let _ = alice_ws.next().await.unwrap().unwrap(); // connection.ready

    // Bob sets presence preference = invisible BEFORE connecting
    let _ = client
        .patch(format!("{}/v1/users/me/presence", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .json(&json!({ "preferred_status": "invisible" }))
        .send()
        .await
        .unwrap();

    // Now Bob connects to Gateway
    let (mut bob_ws, _) = connect_async(format!("{}/v1/gateway", ws_url)).await.unwrap();
    bob_ws
        .send(TungsteniteMessage::Text(
            json!({ "op": "authenticate", "token": bob_token }).to_string(),
        ))
        .await
        .unwrap();
    let _ = bob_ws.next().await.unwrap().unwrap(); // connection.ready

    // Alice should NOT receive an "online" update because Bob is invisible!
    // Try to read with a 500ms timeout -> should timeout
    let timeout_res = tokio::time::timeout(Duration::from_millis(500), alice_ws.next()).await;
    assert!(timeout_res.is_err(), "Alice não deveria receber presença de usuário invisível!");

    // REST friends list for Alice also reports Bob as offline
    let alice_friends: Vec<FriendDto> = client
        .get(format!("{}/v1/friends", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(alice_friends[0].username, "bob_inv");
    assert_eq!(alice_friends[0].status, "offline");

    // Multi-connection test: Bob opens a second connection
    let (mut bob_ws_2, _) = connect_async(format!("{}/v1/gateway", ws_url)).await.unwrap();
    bob_ws_2
        .send(TungsteniteMessage::Text(
            json!({ "op": "authenticate", "token": bob_token }).to_string(),
        ))
        .await
        .unwrap();
    let _ = bob_ws_2.next().await.unwrap().unwrap();

    // Bob sets presence to online
    bob_ws_2
        .send(TungsteniteMessage::Text(
            json!({ "op": "set_presence", "status": "online" }).to_string(),
        ))
        .await
        .unwrap();

    // Now Alice receives Bob's online presence
    let msg_bob_online = alice_ws.next().await.unwrap().unwrap();
    let evt: GatewayEvent = serde_json::from_str(&msg_bob_online.to_text().unwrap()).unwrap();
    assert_eq!(evt.event_type, "presence.updated");
    assert_eq!(evt.payload["user_id"].as_str().unwrap(), bob_id);
    assert_eq!(evt.payload["status"].as_str().unwrap(), "online");

    // Bob drops connection 1 -> still has connection 2 active, so he is NOT offline
    drop(bob_ws);
    let timeout_conn = tokio::time::timeout(Duration::from_millis(500), alice_ws.next()).await;
    assert!(timeout_conn.is_err(), "Bob ainda possui conexão 2 ativa, não deve ficar offline!");

    // Bob drops connection 2 -> now he goes offline!
    drop(bob_ws_2);
    let msg_offline = alice_ws.next().await.unwrap().unwrap();
    let evt_off: GatewayEvent = serde_json::from_str(&msg_offline.to_text().unwrap()).unwrap();
    assert_eq!(evt_off.event_type, "presence.updated");
    assert_eq!(evt_off.payload["status"].as_str().unwrap(), "offline");
}
