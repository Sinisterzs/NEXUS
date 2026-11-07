use std::net::SocketAddr;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use sqlx::PgPool;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as TungsteniteMessage};
use uuid::Uuid;

use nexus_server::config::AppConfig;
use nexus_server::create_app;
use nexus_server::models::GatewayEvent;

async fn setup_bench_server() -> (String, PgPool) {
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

#[cfg(windows)]
fn get_current_process_memory_mb() -> f64 {
    #[repr(C)]
    #[allow(non_snake_case)]
    struct PROCESS_MEMORY_COUNTERS {
        cb: u32,
        PageFaultCount: u32,
        PeakWorkingSetSize: usize,
        WorkingSetSize: usize,
        QuotaPeakPagedPoolUsage: usize,
        QuotaPagedPoolUsage: usize,
        QuotaPeakNonPagedPoolUsage: usize,
        QuotaNonPagedPoolUsage: usize,
        PagefileUsage: usize,
        PeakPagefileUsage: usize,
    }

    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(
            process: isize,
            counters: *mut PROCESS_MEMORY_COUNTERS,
            cb: u32,
        ) -> i32;
    }

    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let proc = GetCurrentProcess();
        if K32GetProcessMemoryInfo(proc, &mut counters, counters.cb) != 0 {
            counters.WorkingSetSize as f64 / (1024.0 * 1024.0)
        } else {
            0.0
        }
    }
}

#[cfg(not(windows))]
fn get_current_process_memory_mb() -> f64 {
    0.0
}

async fn create_bench_user(pool: &PgPool, username: &str) -> (Uuid, String) {
    let user_id = Uuid::new_v4();
    let token = format!("bench_tok_{}", user_id.simple());
    let token_hash = nexus_server::services::AuthService::hash_token(&token);
    let email = format!("{}@bench.local", username);

    sqlx::query!(
        "INSERT INTO users (id, username) VALUES ($1, $2)",
        user_id,
        username
    )
    .execute(pool)
    .await
    .unwrap();

    sqlx::query!(
        "INSERT INTO user_credentials (user_id, email, password_hash) VALUES ($1, $2, 'bench_hash')",
        user_id,
        email
    )
    .execute(pool)
    .await
    .unwrap();

    sqlx::query!(
        "INSERT INTO user_profiles (user_id, display_name, status) VALUES ($1, $2, 'online')",
        user_id,
        username
    )
    .execute(pool)
    .await
    .unwrap();

    sqlx::query!(
        "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')",
        user_id,
        token_hash
    )
    .execute(pool)
    .await
    .unwrap();

    (user_id, token)
}

#[tokio::test]
async fn run_presence_performance_benchmarks() {
    let (base_url, pool) = setup_bench_server().await;
    let ws_url = base_url.replace("http://", "ws://");

    // 1. Measure Baseline Memory with 0 WebSocket Connections
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mem_0_conns = get_current_process_memory_mb();
    println!("\n========================================================");
    println!(" [BENCHMARK] MÉTRICAS REAIS DE DESEMPENHO DO GATEWAY");
    println!("========================================================");
    println!(" Memória RAM do servidor (0 conexões): {:.2} MB", mem_0_conns);

    // 2. Setup Alice and Bob friendship to benchmark propagation latency
    let (alice_id, alice_token) = create_bench_user(&pool, "alice_lat").await;
    let (bob_id, bob_token) = create_bench_user(&pool, "bob_lat").await;

    // Create friendship directly in DB
    sqlx::query!(
        "INSERT INTO friendships (user_a_id, user_b_id) VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))",
        alice_id,
        bob_id
    )
    .execute(&pool)
    .await
    .unwrap();

    // Connect Alice & Bob to Gateway
    let (mut alice_ws, _) = connect_async(format!("{}/v1/gateway", ws_url)).await.unwrap();
    alice_ws
        .send(TungsteniteMessage::Text(
            json!({ "op": "authenticate", "token": alice_token }).to_string(),
        ))
        .await
        .unwrap();
    let _ = alice_ws.next().await.unwrap().unwrap(); // ready

    let (mut bob_ws, _) = connect_async(format!("{}/v1/gateway", ws_url)).await.unwrap();
    bob_ws
        .send(TungsteniteMessage::Text(
            json!({ "op": "authenticate", "token": bob_token }).to_string(),
        ))
        .await
        .unwrap();
    let _ = bob_ws.next().await.unwrap().unwrap(); // ready
    let _ = alice_ws.next().await.unwrap().unwrap(); // Bob's online event

    // 3. Measure Local Presence Propagation Latency across 20 iterations
    let mut latencies: Vec<Duration> = Vec::with_capacity(20);
    for i in 0..20 {
        let status = if i % 2 == 0 { "idle" } else { "online" };
        tokio::time::sleep(Duration::from_millis(40)).await;
        let start = Instant::now();

        bob_ws
            .send(TungsteniteMessage::Text(
                json!({ "op": "set_presence", "status": status }).to_string(),
            ))
            .await
            .unwrap();

        let msg = alice_ws.next().await.unwrap().unwrap();
        let elapsed = start.elapsed();
        latencies.push(elapsed);

        let evt: GatewayEvent = serde_json::from_str(&msg.to_text().unwrap()).unwrap();
        assert_eq!(evt.event_type, "presence.updated");
    }

    let avg_latency_us = latencies.iter().map(|d| d.as_micros()).sum::<u128>() as f64 / 20.0;
    let avg_latency_ms = avg_latency_us / 1000.0;
    let min_latency_us = latencies.iter().map(|d| d.as_micros()).min().unwrap();
    let max_latency_us = latencies.iter().map(|d| d.as_micros()).max().unwrap();

    println!(" Tempo médio de propagação de presença: {:.3} ms ({:.1} µs)", avg_latency_ms, avg_latency_us);
    println!(" Latência mínima: {:.3} ms | máxima: {:.3} ms", min_latency_us as f64 / 1000.0, max_latency_us as f64 / 1000.0);

    // 4. Benchmarking 10 Simultaneous Connections
    let mut sockets_10 = Vec::new();
    for i in 0..10 {
        let username = format!("bench_user_10_{}", i);
        let (_id, token) = create_bench_user(&pool, &username).await;
        let (mut ws, _) = connect_async(format!("{}/v1/gateway", ws_url)).await.unwrap();
        ws.send(TungsteniteMessage::Text(
            json!({ "op": "authenticate", "token": token }).to_string(),
        ))
        .await
        .unwrap();
        let _ = ws.next().await.unwrap().unwrap();
        sockets_10.push(ws);
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mem_10_conns = get_current_process_memory_mb();
    println!(" Memória RAM com 10 conexões ativas: {:.2} MB (delta: +{:.2} MB)", mem_10_conns, mem_10_conns - mem_0_conns);

    // 5. Benchmarking 100 Simultaneous Connections
    let mut sockets_100 = Vec::new();
    for i in 0..90 {
        let username = format!("bench_user_100_{}", i);
        let (_id, token) = create_bench_user(&pool, &username).await;
        let (mut ws, _) = connect_async(format!("{}/v1/gateway", ws_url)).await.unwrap();
        ws.send(TungsteniteMessage::Text(
            json!({ "op": "authenticate", "token": token }).to_string(),
        ))
        .await
        .unwrap();
        let _ = ws.next().await.unwrap().unwrap();
        sockets_100.push(ws);
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
    let mem_100_conns = get_current_process_memory_mb();
    println!(" Memória RAM com 100 conexões ativas: {:.2} MB (delta: +{:.2} MB)", mem_100_conns, mem_100_conns - mem_0_conns);

    // 6. Memory Growth / Leak Check after disconnect cycles
    drop(sockets_100);
    drop(sockets_10);
    drop(alice_ws);
    drop(bob_ws);
    tokio::time::sleep(Duration::from_millis(400)).await;

    let mem_after_disconnect = get_current_process_memory_mb();
    println!(" Memória RAM após desconexão total (ciclo limpo): {:.2} MB", mem_after_disconnect);
    println!(" Variação residual de memória após ciclo de 100 conexões: {:.2} MB", mem_after_disconnect - mem_0_conns);
    println!("========================================================\n");
}
