use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};
use uuid::Uuid;

use nexus_server::config::AppConfig;
use nexus_server::create_app;
use nexus_server::models::{CallStatus, FriendRequestsResponse, GatewayEvent};
use nexus_server::repositories::{FriendRepository, SessionRepository, UserRepository};
use nexus_server::services::presence::{
    ClientConnection, GATEWAY_CRITICAL_QUEUE_CAPACITY, GATEWAY_EPHEMERAL_QUEUE_CAPACITY,
};
use nexus_server::services::{AuthService, CallService, PresenceManager};

async fn setup_test_server() -> (String, PgPool, AppConfig) {
    let mut config = AppConfig::from_env();
    let test_db_url = config
        .test_database_url
        .clone()
        .unwrap_or_else(|| "postgres://postgres@localhost:5432/nexus_test_db".to_string());
    config.database_url = test_db_url.clone();
    config.rate_limit_auth_per_minute = 500;

    let pool = PgPool::connect(&test_db_url)
        .await
        .expect("Falha ao conectar no banco de testes nexus_test_db");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Falha ao rodar migrações no banco de teste");

    sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .expect("Falha ao limpar tabelas de teste");

    let app = create_app(pool.clone(), config.clone());

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

    (format!("http://{}", addr), pool, config)
}

async fn register_user(base_url: &str, username: &str, email: &str) -> (Uuid, String) {
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
    let user_id = Uuid::parse_str(body["user"]["id"].as_str().unwrap()).unwrap();
    let token = body["session_token"].as_str().unwrap().to_string();
    (user_id, token)
}

async fn make_friends(base_url: &str, alice_token: &str, bob_token: &str, bob_username: &str) {
    let client = Client::new();
    let send_res = client
        .post(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({ "target": bob_username }))
        .send()
        .await
        .unwrap();
    assert_eq!(send_res.status(), StatusCode::OK);

    let reqs: FriendRequestsResponse = client
        .get(format!("{}/v1/friends/requests", base_url))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let accept_res = client
        .post(format!(
            "{}/v1/friends/requests/{}/accept",
            base_url, reqs.incoming[0].id
        ))
        .header("Authorization", format!("Bearer {}", bob_token))
        .send()
        .await
        .unwrap();
    assert_eq!(accept_res.status(), StatusCode::OK);
}

async fn connect_with_ephemeral_ticket(
    base_url: &str,
    session_token: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let client = Client::new();
    let ticket_resp: Value = client
        .post(format!("{}/v1/gateway/ticket", base_url))
        .header("Authorization", format!("Bearer {}", session_token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let ticket = ticket_resp["ticket"].as_str().unwrap().to_string();

    let ws_url = format!("{}/v1/gateway", base_url.replace("http://", "ws://"));
    let (mut ws, _) = connect_async(&ws_url).await.unwrap();
    ws.send(WsMessage::Text(
        json!({ "op": "authenticate", "ticket": ticket }).to_string(),
    ))
    .await
    .unwrap();

    // Consume until connection.ready
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(3), ws.next())
            .await
            .expect("Timeout aguardando connection.ready")
            .unwrap()
            .unwrap();
        if let WsMessage::Text(txt) = frame {
            let evt: GatewayEvent = serde_json::from_str(&txt).unwrap();
            if evt.event_type == "connection.ready" {
                break;
            }
        }
    }

    ws
}

async fn recv_event_of_type(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    expected_type: &str,
    timeout_ms: u64,
) -> Option<GatewayEvent> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(txt)))) => {
                if let Ok(evt) = serde_json::from_str::<GatewayEvent>(&txt) {
                    if evt.event_type == expected_type {
                        return Some(evt);
                    }
                }
            }
            Ok(None) | Ok(Some(Ok(WsMessage::Close(_)))) | Ok(Some(Err(_))) => return None,
            Err(_) => return None,
            _ => {}
        }
    }
    None
}

// ============================================================================
// ITEM 2: Multi-connection call preservation & orphan cleanup
// ============================================================================
#[tokio::test]
async fn test_b1_01_multi_connection_secondary_disconnect_preserves_call_and_last_cleans_up() {
    let (base_url, _pool, _cfg) = setup_test_server().await;

    let (alice_id, alice_token) = register_user(&base_url, "alice_mc", "alice_mc@nexus.local").await;
    let (bob_id, bob_token) = register_user(&base_url, "bob_mc", "bob_mc@nexus.local").await;
    make_friends(&base_url, &alice_token, &bob_token, "bob_mc").await;

    // 1. Alice opens two WebSocket connections (primary + secondary) using ephemeral tickets
    let mut alice_ws_1 = connect_with_ephemeral_ticket(&base_url, &alice_token).await;
    let alice_ws_2 = connect_with_ephemeral_ticket(&base_url, &alice_token).await;
    let mut bob_ws = connect_with_ephemeral_ticket(&base_url, &bob_token).await;

    // 2. Alice invites Bob from primary connection
    alice_ws_1
        .send(WsMessage::Text(
            json!({ "op": "call.invite", "target_user_id": bob_id }).to_string(),
        ))
        .await
        .unwrap();

    let ringing_evt = recv_event_of_type(&mut alice_ws_1, "call.ringing", 2000)
        .await
        .expect("Alice deve receber call.ringing");
    let call_id = ringing_evt.payload["call_id"].as_str().unwrap().to_string();

    let incoming_evt = recv_event_of_type(&mut bob_ws, "call.incoming", 2000)
        .await
        .expect("Bob deve receber call.incoming");
    assert_eq!(incoming_evt.payload["call_id"].as_str().unwrap(), call_id);

    // 3. Bob accepts the call
    bob_ws
        .send(WsMessage::Text(
            json!({ "op": "call.accept", "call_id": call_id }).to_string(),
        ))
        .await
        .unwrap();

    let accepted_evt = recv_event_of_type(&mut alice_ws_1, "call.accepted", 2000)
        .await
        .expect("Alice deve receber call.accepted");
    assert_eq!(accepted_evt.payload["call_id"].as_str().unwrap(), call_id);

    // 4. Close Alice's secondary connection (alice_ws_2)
    drop(alice_ws_2);
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Verify Bob did NOT receive call.ended
    let unexpected_end = recv_event_of_type(&mut bob_ws, "call.ended", 300).await;
    assert!(
        unexpected_end.is_none(),
        "Fechamento da conexão secundária de Alice NÃO deve encerrar a chamada ativa!"
    );

    // Verify the call is still active by relaying an SDP offer from Alice's primary connection to Bob
    alice_ws_1
        .send(WsMessage::Text(
            json!({
                "op": "call.webrtc.offer",
                "call_id": call_id,
                "target_user_id": bob_id,
                "sdp": "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n"
            })
            .to_string(),
        ))
        .await
        .unwrap();

    let offer_evt = recv_event_of_type(&mut bob_ws, "call.webrtc.offer", 2000)
        .await
        .expect("Chamada preservada na sessão principal deve continuar retransmitindo SDP");
    assert_eq!(
        offer_evt.payload["sender_id"].as_str().unwrap(),
        alice_id.to_string()
    );

    // 5. Close Alice's LAST connection (alice_ws_1) -> now the orphaned call MUST be cleaned up
    drop(alice_ws_1);

    let ended_evt = recv_event_of_type(&mut bob_ws, "call.ended", 2000)
        .await
        .expect("Fechamento da última conexão de Alice deve encerrar a chamada órfã e notificar Bob");
    assert_eq!(ended_evt.payload["call_id"].as_str().unwrap(), call_id);
}

// ============================================================================
// ITEM 3: Offline presence persistence & preference separation
// ============================================================================
#[tokio::test]
async fn test_b1_02_presence_offline_persistence_and_preference_separation() {
    let (base_url, pool, _cfg) = setup_test_server().await;
    let client = Client::new();

    let (alice_id, alice_token) =
        register_user(&base_url, "alice_pres", "alice_pres@nexus.local").await;
    let (_bob_id, bob_token) = register_user(&base_url, "bob_pres", "bob_pres@nexus.local").await;
    make_friends(&base_url, &alice_token, &bob_token, "bob_pres").await;

    // 1. Alice connects and sets preferred_status = "dnd", custom_status = "Foco total", activity = "Rust"
    let alice_ws = connect_with_ephemeral_ticket(&base_url, &alice_token).await;
    let mut bob_ws = connect_with_ephemeral_ticket(&base_url, &bob_token).await;

    let patch_res = client
        .patch(format!("{}/v1/users/me/presence", base_url))
        .header("Authorization", format!("Bearer {}", alice_token))
        .json(&json!({
            "preferred_status": "dnd",
            "custom_status": "Foco total",
            "activity": "Rust"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patch_res.status(), StatusCode::OK);

    let dnd_evt = recv_event_of_type(&mut bob_ws, "presence.updated", 2000)
        .await
        .expect("Bob deve receber atualização DND de Alice");
    assert_eq!(dnd_evt.payload["status"], "dnd");
    assert_eq!(dnd_evt.payload["custom_status"], "Foco total");

    // 2. Alice disconnects her last WebSocket connection
    let before_disconnect = chrono::Utc::now();
    tokio::time::sleep(Duration::from_millis(20)).await;
    drop(alice_ws);

    let off_evt = recv_event_of_type(&mut bob_ws, "presence.updated", 2000)
        .await
        .expect("Bob deve receber status offline de Alice ao desconectar última sessão");
    assert_eq!(off_evt.payload["status"], "offline");

    // 3. Inspect PostgreSQL directly:
    // - user_profiles.status must be 'offline'
    // - user_profiles.last_seen_at must be updated (>= before_disconnect)
    // - user_profiles.custom_status and activity must be preserved
    // - user_presence_preferences.preferred_status must STILL be 'dnd' (never 'offline' or overwritten!)
    let (db_status, db_custom, db_activity, db_last_seen): (
        String,
        Option<String>,
        Option<String>,
        chrono::DateTime<chrono::Utc>,
    ) = sqlx::query_as(
        "SELECT status, custom_status, activity, last_seen_at FROM user_profiles WHERE user_id = $1",
    )
    .bind(alice_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        db_status, "offline",
        "user_profiles.status deve ser persistido como 'offline' após desconexão"
    );
    assert_eq!(
        db_custom.as_deref(),
        Some("Foco total"),
        "custom_status deve ser preservado após desconexão"
    );
    assert_eq!(
        db_activity.as_deref(),
        Some("Rust"),
        "activity deve ser preservado após desconexão"
    );
    assert!(
        db_last_seen >= before_disconnect,
        "last_seen_at deve ser atualizado no momento da desconexão"
    );

    let (db_pref_status,): (String,) = sqlx::query_as(
        "SELECT preferred_status FROM user_presence_preferences WHERE user_id = $1",
    )
    .bind(alice_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(
        db_pref_status, "dnd",
        "preferred_status escolhido ('dnd') deve permanecer intacto em user_presence_preferences"
    );

    // 4. Alice reconnects -> her effective status must automatically restore to 'dnd'
    let _alice_ws_reconn = connect_with_ephemeral_ticket(&base_url, &alice_token).await;
    let reconn_evt = recv_event_of_type(&mut bob_ws, "presence.updated", 2000)
        .await
        .expect("Bob deve receber presença 'dnd' restaurada quando Alice reconecta");
    assert_eq!(reconn_evt.payload["status"], "dnd");
}

// ============================================================================
// ITEM 4: Atomic CallService transitions, concurrent invites, accept vs cancel, timeouts
// ============================================================================
#[tokio::test]
async fn test_b1_03_call_service_concurrency_races_and_atomic_timeouts() {
    let (base_url, pool, config) = setup_test_server().await;

    let (alice_id, alice_token) =
        register_user(&base_url, "alice_race", "alice_race@nexus.local").await;
    let (bob_id, bob_token) = register_user(&base_url, "bob_race", "bob_race@nexus.local").await;
    let (carol_id, carol_token) =
        register_user(&base_url, "carol_race", "carol_race@nexus.local").await;

    make_friends(&base_url, &alice_token, &bob_token, "bob_race").await;
    make_friends(&base_url, &carol_token, &bob_token, "bob_race").await;

    let user_repo = UserRepository::new(pool.clone());
    let session_repo = SessionRepository::new(pool.clone());
    let friend_repo = FriendRepository::new(pool.clone());
    let presence_mgr = PresenceManager::new(friend_repo.clone());
    let auth_service =
        AuthService::new(user_repo, session_repo, config).with_presence_manager(presence_mgr.clone());

    // Register in-memory connections for Alice, Bob, and Carol (keep receivers alive for the test duration)
    let mut _keep_alive_rxs = Vec::new();
    for uid in [alice_id, bob_id, carol_id] {
        let (crit_tx, crit_rx) = mpsc::channel(GATEWAY_CRITICAL_QUEUE_CAPACITY);
        let (eph_tx, eph_rx) = mpsc::channel(GATEWAY_EPHEMERAL_QUEUE_CAPACITY);
        _keep_alive_rxs.push((crit_rx, eph_rx));
        let conn = ClientConnection::new(Uuid::new_v4(), crit_tx, eph_tx, std::sync::Arc::new(Notify::new()));
        presence_mgr
            .register_connection(uid, conn.connection_id, conn)
            .await
            .unwrap();
    }

    let call_service = CallService::new(friend_repo, auth_service, presence_mgr)
        .with_ringing_timeout(Duration::from_secs(5));

    // --- Sub-test A: Simultaneous competing invites to Bob (Alice -> Bob AND Carol -> Bob) ---
    let cs1 = call_service.clone();
    let cs2 = call_service.clone();
    let (res_alice, res_carol) =
        tokio::join!(cs1.invite(alice_id, bob_id), cs2.invite(carol_id, bob_id));

    assert!(
        res_alice.is_ok() ^ res_carol.is_ok(),
        "Exatamente UM dos convites simultâneos para Bob deve vencer; o outro deve falhar atomicamente: alice={:?}, carol={:?}",
        res_alice.as_ref().err(),
        res_carol.as_ref().err()
    );
    assert_eq!(call_service.active_call_count().await, 1);
    assert_eq!(call_service.active_timer_count().await, 1);

    // Clean up winner call before next sub-test
    let winner_call = res_alice.or(res_carol).unwrap();
    call_service
        .cancel(winner_call.caller_id, winner_call.id)
        .await
        .unwrap();
    assert_eq!(call_service.active_call_count().await, 0);
    assert_eq!(call_service.active_timer_count().await, 0);

    // --- Sub-test B: Simultaneous mutual invites (Alice -> Bob AND Bob -> Alice) ---
    let cs1 = call_service.clone();
    let cs2 = call_service.clone();
    let (res_ab, res_ba) = tokio::join!(cs1.invite(alice_id, bob_id), cs2.invite(bob_id, alice_id));
    assert!(
        res_ab.is_ok() ^ res_ba.is_ok(),
        "Convites mútuos simultâneos não podem criar duas chamadas incompatíveis"
    );
    let mutual_call = res_ab.or(res_ba).unwrap();
    call_service
        .cancel(mutual_call.caller_id, mutual_call.id)
        .await
        .unwrap();

    // --- Sub-test C: Concurrent accept vs cancel race ---
    for _ in 0..10 {
        let session = call_service.invite(alice_id, bob_id).await.unwrap();
        let cs_acc = call_service.clone();
        let cs_can = call_service.clone();
        let (acc_res, can_res) = tokio::join!(
            cs_acc.accept(bob_id, session.id),
            cs_can.cancel(alice_id, session.id)
        );

        assert!(
            acc_res.is_ok() ^ can_res.is_ok(),
            "Accept e Cancel concorrentes devem ser mutuamente exclusivos"
        );
        assert_eq!(
            call_service.active_timer_count().await,
            0,
            "Timer de toque deve ser abortado tanto em accept quanto em cancel"
        );

        if acc_res.is_ok() {
            // If accept won, call must be Active and cancel must have failed
            let active = call_service.active_call_for_user(alice_id).await.unwrap();
            assert_eq!(active.status, CallStatus::Active);
            call_service.end(alice_id, session.id).await.unwrap();
        } else {
            // If cancel won, no call may remain registered
            assert!(call_service.active_call_for_user(alice_id).await.is_none());
            assert!(call_service.active_call_for_user(bob_id).await.is_none());
        }
    }

    // --- Sub-test D: Stale ringing timeout must NOT cancel an already accepted call ---
    let call_service = call_service.with_ringing_timeout(Duration::from_millis(180));
    let accepted_call = call_service.invite(alice_id, bob_id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(40)).await;
    call_service
        .accept(bob_id, accepted_call.id)
        .await
        .unwrap();

    // Wait well past the 180ms ringing timeout
    tokio::time::sleep(Duration::from_millis(220)).await;
    let still_active = call_service
        .active_call_for_user(alice_id)
        .await
        .expect("Timeout antigo de 180ms NÃO pode encerrar chamada já aceita!");
    assert_eq!(still_active.status, CallStatus::Active);
    call_service.end(bob_id, accepted_call.id).await.unwrap();

    // --- Sub-test E: Unanswered call expires after ringing timeout and frees both users ---
    let unanswered_call = call_service.invite(alice_id, bob_id).await.unwrap();
    assert_eq!(call_service.active_call_count().await, 1);
    tokio::time::sleep(Duration::from_millis(240)).await;
    assert_eq!(
        call_service.active_call_count().await,
        0,
        "Chamada não atendida deve expirar e ser removida após timeout"
    );
    assert!(call_service.active_call_for_user(alice_id).await.is_none());
    assert!(call_service.active_call_for_user(bob_id).await.is_none());

    // Late events on expired/ended call must fail cleanly
    assert!(call_service
        .accept(bob_id, unanswered_call.id)
        .await
        .is_err());
    assert!(call_service
        .relay_sdp(alice_id, unanswered_call.id, bob_id, "offer", "v=0".to_string())
        .await
        .is_err());
}

// ============================================================================
// ITEM 5: WebSocket Backpressure (Critical vs Ephemeral & Slow Consumer) + ICE Bursts
// ============================================================================
#[tokio::test]
async fn test_b1_04_backpressure_ephemeral_shedding_and_slow_consumer_disconnect() {
    let (_base_url, pool, _cfg) = setup_test_server().await;
    let friend_repo = FriendRepository::new(pool);
    let presence_mgr = PresenceManager::new(friend_repo);

    let user_id = Uuid::new_v4();
    let conn_id = Uuid::new_v4();
    let (crit_tx, mut crit_rx) = mpsc::channel(GATEWAY_CRITICAL_QUEUE_CAPACITY);
    let (eph_tx, mut eph_rx) = mpsc::channel(GATEWAY_EPHEMERAL_QUEUE_CAPACITY);
    let slow_notify = std::sync::Arc::new(Notify::new());

    let conn = ClientConnection::new(conn_id, crit_tx, eph_tx, slow_notify.clone());
    presence_mgr
        .register_connection(user_id, conn_id, conn)
        .await
        .unwrap();

    // 1. Flood 100 ephemeral presence.updated events without reading
    for i in 0..100 {
        let eph_evt = GatewayEvent::new("presence.updated", json!({ "seq": i }));
        presence_mgr.send_to_user(user_id, &eph_evt).await;
    }

    // Send 1 critical call.incoming event while ephemeral queue is full
    let crit_evt = GatewayEvent::new("call.incoming", json!({ "call_id": "critical-1" }));
    presence_mgr.send_to_user(user_id, &crit_evt).await;

    // Critical event must be immediately available in critical_rx without loss!
    let received_crit = crit_rx
        .try_recv()
        .expect("Evento crítico call.incoming NUNCA deve ser descartado por saturação de eventos efêmeros");
    assert_eq!(received_crit.event_type, "call.incoming");

    // Ephemeral queue must be capped at GATEWAY_EPHEMERAL_QUEUE_CAPACITY (64)
    let mut eph_count = 0;
    while eph_rx.try_recv().is_ok() {
        eph_count += 1;
    }
    assert_eq!(
        eph_count, GATEWAY_EPHEMERAL_QUEUE_CAPACITY,
        "Fila efêmera deve limitar o armazenamento exatamente a GATEWAY_EPHEMERAL_QUEUE_CAPACITY"
    );

    // 2. Now simulate a stalled client that stops reading critical events beyond GATEWAY_CRITICAL_QUEUE_CAPACITY
    let notify_waiter = slow_notify.notified();
    for i in 0..(GATEWAY_CRITICAL_QUEUE_CAPACITY + 5) {
        let evt = GatewayEvent::new("dm.message.created", json!({ "seq": i }));
        presence_mgr.send_to_user(user_id, &evt).await;
    }

    // Slow consumer disconnect signal must have fired!
    tokio::time::timeout(Duration::from_millis(200), notify_waiter)
        .await
        .expect("Excesso na fila crítica deve acionar desconexão controlada do cliente lento");
}

#[tokio::test]
async fn test_b1_05_ice_candidate_burst_does_not_drop_call_or_websocket() {
    let (base_url, _pool, _cfg) = setup_test_server().await;

    let (_alice_id, alice_token) =
        register_user(&base_url, "alice_ice", "alice_ice@nexus.local").await;
    let (bob_id, bob_token) = register_user(&base_url, "bob_ice", "bob_ice@nexus.local").await;
    make_friends(&base_url, &alice_token, &bob_token, "bob_ice").await;

    let mut alice_ws = connect_with_ephemeral_ticket(&base_url, &alice_token).await;
    let mut bob_ws = connect_with_ephemeral_ticket(&base_url, &bob_token).await;

    // Start and accept call
    alice_ws
        .send(WsMessage::Text(
            json!({ "op": "call.invite", "target_user_id": bob_id }).to_string(),
        ))
        .await
        .unwrap();

    let ringing = recv_event_of_type(&mut alice_ws, "call.ringing", 2000)
        .await
        .unwrap();
    let call_id = ringing.payload["call_id"].as_str().unwrap().to_string();
    let _ = recv_event_of_type(&mut bob_ws, "call.incoming", 2000)
        .await
        .unwrap();

    bob_ws
        .send(WsMessage::Text(
            json!({ "op": "call.accept", "call_id": call_id }).to_string(),
        ))
        .await
        .unwrap();
    let _ = recv_event_of_type(&mut alice_ws, "call.accepted", 2000)
        .await
        .unwrap();

    // Alice sends a rapid burst of 65 ICE candidates in <100ms (more than the old 30 msg/s limit!)
    for i in 0..65 {
        alice_ws
            .send(WsMessage::Text(
                json!({
                    "op": "call.webrtc.ice_candidate",
                    "call_id": call_id,
                    "target_user_id": bob_id,
                    "candidate": {
                        "candidate": format!("candidate:{} 1 udp 2122260223 100.64.0.1 {} typ host", i, 50000 + i),
                        "sdpMid": "0",
                        "sdpMLineIndex": 0
                    }
                })
                .to_string(),
            ))
            .await
            .unwrap();
    }

    // Bob must receive all 65 ICE candidates and the call must NOT be terminated
    let mut received_ice = 0;
    while let Some(_evt) = recv_event_of_type(&mut bob_ws, "call.webrtc.ice_candidate", 1500).await {
        received_ice += 1;
        if received_ice == 65 {
            break;
        }
    }
    assert_eq!(
        received_ice, 65,
        "Rajada legítima de 65 ICE candidates não deve derrubar o WebSocket nem perder candidatos"
    );

    // Verify Alice's WebSocket is still alive and responds to ping
    alice_ws
        .send(WsMessage::Text(json!({ "op": "ping" }).to_string()))
        .await
        .unwrap();
    let pong = recv_event_of_type(&mut alice_ws, "pong", 1500).await;
    assert!(
        pong.is_some(),
        "Conexão WebSocket de Alice deve continuar ativa após rajada de candidatos ICE"
    );
}

#[tokio::test]
async fn test_b2_06_ice_burst_above_120_per_sec_sheds_excess_without_dropping_call() {
    let (base_url, _pool, _cfg) = setup_test_server().await;

    let (_alice_id, alice_token) =
        register_user(&base_url, "alice_ice145", "alice_ice145@nexus.local").await;
    let (bob_id, bob_token) =
        register_user(&base_url, "bob_ice145", "bob_ice145@nexus.local").await;
    make_friends(&base_url, &alice_token, &bob_token, "bob_ice145").await;

    let mut alice_ws = connect_with_ephemeral_ticket(&base_url, &alice_token).await;
    let mut bob_ws = connect_with_ephemeral_ticket(&base_url, &bob_token).await;

    // Start and accept call
    alice_ws
        .send(WsMessage::Text(
            json!({ "op": "call.invite", "target_user_id": bob_id }).to_string(),
        ))
        .await
        .unwrap();

    let ringing = recv_event_of_type(&mut alice_ws, "call.ringing", 2000)
        .await
        .unwrap();
    let call_id = ringing.payload["call_id"].as_str().unwrap().to_string();
    let _ = recv_event_of_type(&mut bob_ws, "call.incoming", 2000)
        .await
        .unwrap();

    bob_ws
        .send(WsMessage::Text(
            json!({ "op": "call.accept", "call_id": call_id }).to_string(),
        ))
        .await
        .unwrap();
    let _ = recv_event_of_type(&mut alice_ws, "call.accepted", 2000)
        .await
        .unwrap();

    // Alice sends 145 ICE candidates in <100ms (>120/s limit)
    for i in 0..145 {
        alice_ws
            .send(WsMessage::Text(
                json!({
                    "op": "call.webrtc.ice_candidate",
                    "call_id": call_id,
                    "target_user_id": bob_id,
                    "candidate": {
                        "candidate": format!("candidate:{} 1 udp 2122260223 100.64.0.2 {} typ host", i, 51000 + i),
                        "sdpMid": "0",
                        "sdpMLineIndex": 0
                    }
                })
                .to_string(),
            ))
            .await
            .unwrap();
    }

    // Bob must receive up to 120 ICE candidates and excess (25) must be shed without dropping the call
    let mut received_ice = 0;
    while let Some(_evt) = recv_event_of_type(&mut bob_ws, "call.webrtc.ice_candidate", 350).await {
        received_ice += 1;
    }
    assert_eq!(
        received_ice, 120,
        "Rate limiter de ICE do servidor deve repassar 120 candidatos/s e descartar apenas o excesso (25)"
    );

    // Verify Alice's WebSocket and active call remain intact
    alice_ws
        .send(WsMessage::Text(json!({ "op": "ping" }).to_string()))
        .await
        .unwrap();
    let pong = recv_event_of_type(&mut alice_ws, "pong", 1500).await;
    assert!(
        pong.is_some(),
        "Conexão WebSocket de Alice não deve cair ao exceder 120 candidatos ICE/s"
    );

    // End the call normally to prove the call session was preserved
    alice_ws
        .send(WsMessage::Text(
            json!({ "op": "call.end", "call_id": call_id }).to_string(),
        ))
        .await
        .unwrap();
    let ended = recv_event_of_type(&mut bob_ws, "call.ended", 2000).await;
    assert!(
        ended.is_some(),
        "A chamada ativa deve permanecer viva e encerrar normalmente após descarte de excesso de ICE"
    );
}
