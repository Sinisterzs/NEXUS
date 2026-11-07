use std::net::SocketAddr;
use std::time::{Duration, Instant};

use reqwest::{Client, StatusCode};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use nexus_server::config::AppConfig;
use nexus_server::create_app;
use nexus_server::models::{DirectConversationDto, DirectMessageDto};

#[cfg(windows)]
fn get_current_process_memory_mb() -> (f64, f64) {
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
            let working_set_mb = counters.WorkingSetSize as f64 / (1024.0 * 1024.0);
            let private_bytes_mb = counters.PagefileUsage as f64 / (1024.0 * 1024.0);
            (working_set_mb, private_bytes_mb)
        } else {
            (0.0, 0.0)
        }
    }
}

#[cfg(not(windows))]
fn get_current_process_memory_mb() -> (f64, f64) {
    (0.0, 0.0)
}

async fn setup_bench_server() -> (String, PgPool) {
    let mut config = AppConfig::from_env();
    let test_db_url = config
        .test_database_url
        .clone()
        .unwrap_or_else(|| "postgres://postgres@localhost:5432/nexus_test_db".to_string());
    config.database_url = test_db_url.clone();
    config.rate_limit_auth_per_minute = 100_000;

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

async fn create_bench_user(pool: &PgPool, username: &str) -> (Uuid, String) {
    let user_id = Uuid::new_v4();
    let email = format!("{}@bench.nexus.local", username);
    let session_token = format!("bench_token_{}", username);

    // 1. users
    sqlx::query!(
        "INSERT INTO users (id, username, created_at, updated_at) VALUES ($1, $2, NOW(), NOW())",
        user_id,
        username
    )
    .execute(pool)
    .await
    .unwrap();

    // 2. user_credentials
    sqlx::query!(
        "INSERT INTO user_credentials (user_id, email, password_hash) VALUES ($1, $2, 'dummy_hash')",
        user_id,
        email
    )
    .execute(pool)
    .await
    .unwrap();

    // 3. user_profiles
    sqlx::query!(
        "INSERT INTO user_profiles (user_id, display_name, status) VALUES ($1, $2, 'online')",
        user_id,
        username
    )
    .execute(pool)
    .await
    .unwrap();

    // 4. sessions
    use sha2::{Digest, Sha256};
    let token_hash = hex::encode(Sha256::digest(session_token.as_bytes()));
    let expires_at = chrono::Utc::now() + chrono::Duration::hours(24);

    sqlx::query!(
        "INSERT INTO sessions (user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, NOW())",
        user_id,
        token_hash,
        expires_at
    )
    .execute(pool)
    .await
    .unwrap();

    (user_id, session_token)
}

#[tokio::test]
async fn run_dm_performance_benchmarks() {
    let (base_url, pool) = setup_bench_server().await;
    let client = Client::new();

    let (mem_rest_ws, mem_rest_pb) = get_current_process_memory_mb();
    println!("\n=======================================================");
    println!(" [BENCHMARK] NEXUS Phase 2.3 - Direct Messages Real Bench");
    println!(" Memória em repouso: WorkingSet: {:.2} MB | PrivateBytes: {:.2} MB", mem_rest_ws, mem_rest_pb);
    println!("=======================================================\n");

    // 1. Create 2 benchmark users and friendship
    let (user_a, token_a) = create_bench_user(&pool, "bench_user_a").await;
    let (user_b, token_b) = create_bench_user(&pool, "bench_user_b").await;

    sqlx::query(
        "INSERT INTO friendships (user_a_id, user_b_id) VALUES (LEAST($1, $2), GREATEST($1, $2))",
    )
    .bind(user_a)
    .bind(user_b)
    .execute(&pool)
    .await
    .unwrap();

    // 2. Create conversation
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

    // -------------------------------------------------------------
    // Benchmark 1: Throughput de envio em lote (1.000 mensagens)
    // -------------------------------------------------------------
    println!("--- [TESTE 1] Inserção de 1.000 mensagens & Throughput ---");
    let start_1k = Instant::now();

    // Insert 1000 messages via fast pipeline / concurrent batches
    let batch_size = 50;
    for batch in 0..20 {
        let mut handles = Vec::new();
        for i in 0..batch_size {
            let msg_idx = batch * batch_size + i;
            let c = client.clone();
            let url = format!("{}/v1/dm/conversations/{}/messages", base_url, conv.id);
            let t = token_a.clone();
            let c_id = Uuid::new_v4();

            handles.push(tokio::spawn(async move {
                c.post(&url)
                    .header("Authorization", format!("Bearer {}", t))
                    .json(&json!({
                        "client_message_id": c_id,
                        "content": format!("Mensagem de benchmark {:04}", msg_idx)
                    }))
                    .send()
                    .await
            }));
        }

        for h in handles {
            let res = h.await.unwrap().unwrap();
            assert_eq!(res.status(), StatusCode::OK);
        }
    }

    let elapsed_1k = start_1k.elapsed();
    let throughput_1k = 1000.0 / elapsed_1k.as_secs_f64();
    println!(" -> 1.000 mensagens enviadas com sucesso em {:?}", elapsed_1k);
    println!(" -> Throughput: {:.2} msgs/seg", throughput_1k);

    // -------------------------------------------------------------
    // Benchmark 2: Latência de paginação com 1.000 mensagens
    // -------------------------------------------------------------
    println!("\n--- [TESTE 2] Latência de paginação por cursor (1.000 mensagens) ---");
    let mut page_latencies = Vec::new();
    let mut before_cursor: Option<Uuid> = None;

    for _page in 0..10 {
        let page_start = Instant::now();
        let mut url = format!("{}/v1/dm/conversations/{}/messages?limit=50", base_url, conv.id);
        if let Some(c) = before_cursor {
            url.push_str(&format!("&before_id={}", c));
        }

        let resp: Vec<DirectMessageDto> = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token_b))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        let page_time = page_start.elapsed();
        page_latencies.push(page_time);
        assert_eq!(resp.len(), 50);
        before_cursor = Some(resp[0].id);
    }

    let avg_latency = page_latencies.iter().sum::<Duration>() / 10;
    let max_latency = page_latencies.iter().max().unwrap();
    println!(" -> 10 páginas de 50 msgs consultadas");
    println!(" -> Latência média por página: {:.2} ms", avg_latency.as_secs_f64() * 1000.0);
    println!(" -> Latência máxima por página: {:.2} ms", max_latency.as_secs_f64() * 1000.0);
    assert!(avg_latency.as_millis() < 50, "Latência média de paginação deve ser < 50ms");

    // -------------------------------------------------------------
    // Benchmark 3: Carga de 10.000 mensagens (Estabilidade do Banco)
    // -------------------------------------------------------------
    println!("\n--- [TESTE 3] Carga extrema: 10.000 mensagens no PostgreSQL ---");
    let start_10k = Instant::now();

    // Direct bulk insertion to reach 10,000 messages efficiently in DB
    let mut tx = pool.begin().await.unwrap();
    let base_ts = chrono::Utc::now();

    for chunk in 1..=9 {
        let chunk_start = (chunk * 1000) as i64;
        let mut query_builder = sqlx::QueryBuilder::new(
            "INSERT INTO direct_messages (conversation_id, sender_id, client_message_id, content, created_at) "
        );

        let mut values = Vec::new();
        for i in 0..1000 {
            let msg_idx = chunk_start + i;
            let c_id = Uuid::new_v4();
            let content = format!("Carga 10k mensagem {:05}", msg_idx);
            let ts = base_ts + chrono::Duration::milliseconds(msg_idx);
            values.push((conv.id, user_a, c_id, content, ts));
        }

        query_builder.push_values(values, |mut b, (cid, sid, cmid, cont, ts)| {
            b.push_bind(cid)
             .push_bind(sid)
             .push_bind(cmid)
             .push_bind(cont)
             .push_bind(ts);
        });

        query_builder.build().execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();

    let count_10k: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM direct_messages WHERE conversation_id = $1",
        conv.id
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .unwrap();

    assert_eq!(count_10k, 10_000, "Deve haver exatamente 10.000 mensagens registradas");
    println!(" -> 10.000 mensagens persistidas no banco em {:?}", start_10k.elapsed());

    // Test pagination latency over 10,000 messages
    let query_10k_start = Instant::now();
    let page_10k: Vec<DirectMessageDto> = client
        .get(format!("{}/v1/dm/conversations/{}/messages?limit=50", base_url, conv.id))
        .header("Authorization", format!("Bearer {}", token_b))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let query_10k_elapsed = query_10k_start.elapsed();

    assert_eq!(page_10k.len(), 50);
    println!(" -> Consulta dos últimos 50 itens sobre 10k mensagens: {:.2} ms", query_10k_elapsed.as_secs_f64() * 1000.0);
    assert!(query_10k_elapsed.as_millis() < 60, "Consulta sobre 10.000 itens deve ser < 60ms");

    // -------------------------------------------------------------
    // Benchmark 4: Medição Real do Consumo de Memória RAM sob Carga
    // -------------------------------------------------------------
    let (mem_load_ws, mem_load_pb) = get_current_process_memory_mb();
    println!("\n=======================================================");
    println!(" [RESULTADOS REAIS DE CONSUMO DE MEMÓRIA]");
    println!(" -> Working Set (RAM ativa): {:.2} MB", mem_load_ws);
    println!(" -> Private Bytes (Commit memory): {:.2} MB", mem_load_pb);
    println!(" -> Limite máximo permitido pela especificação: 50.00 MB");
    println!("=======================================================\n");

    if mem_load_pb > 0.0 {
        assert!(mem_load_pb < 50.0, "Consumo de Private Bytes deve ser < 50 MB, obtido: {:.2} MB", mem_load_pb);
    }
}
