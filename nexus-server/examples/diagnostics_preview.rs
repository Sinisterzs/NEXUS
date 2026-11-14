//! Disposable local UI homologation; never connects to production or publishes a listener.
#[cfg(not(debug_assertions))]
compile_error!("diagnostics_preview is Debug-only");
use nexus_server::{
    config::AppConfig,
    diagnostics::{
        admin_app,
        wire::{safe_for_kind, Event, Kind, Role},
    },
    repositories::{SessionRepository, UserRepository},
    services::AuthService,
};
use uuid::Uuid;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::PathBuf::from(std::env::var("NEXUS_DIAGNOSTICS_TEST_ROOT")?);
    let password = std::fs::read_to_string(root.join("pg-password"))?;
    assert!(password.trim().len() == 64 && password.trim().bytes().all(|b| b.is_ascii_hexdigit()));
    let pool = sqlx::PgPool::connect(&format!(
        "postgres://nexus_diag:{}@127.0.0.1:15439/nexus_diagnostics",
        password.trim()
    ))
    .await?;
    let owner = Uuid::parse_str("a0000000-0000-4000-8000-000000000001")?;
    let hashed = AuthService::hash_password("DiagnosticsLocalOnly42!")?;
    sqlx::query(
        "INSERT INTO users(id,username) VALUES($1,'diagnostics-lab') ON CONFLICT(id) DO NOTHING",
    )
    .bind(owner)
    .execute(&pool)
    .await?;
    sqlx::query("INSERT INTO user_profiles(user_id,display_name) VALUES($1,'Diagnostico ficticio local') ON CONFLICT(user_id) DO NOTHING").bind(owner).execute(&pool).await?;
    sqlx::query("INSERT INTO user_credentials(user_id,email,password_hash) VALUES($1,'diagnostics-lab@example.invalid',$2) ON CONFLICT(user_id) DO UPDATE SET password_hash=$2").bind(owner).bind(hashed).execute(&pool).await?;
    let session_id = Uuid::parse_str("a0000000-0000-4000-8000-000000000002")?;
    sqlx::query("DELETE FROM diagnostics_events WHERE session_id=$1")
        .bind(session_id)
        .execute(&pool)
        .await?;
    let participants: Vec<Uuid> = (0..4).map(|_| Uuid::new_v4()).collect();
    for source in 1..4 {
        let metrics = serde_json::json!({"connectionState":if source==3{"connected"}else{"failed"},"iceConnectionState":if source==3{"connected"}else{"checking"},"dtlsState":if source==3{"connected"}else{"new"},"icePairs":21,"iceRequestsSentTotal":222,"iceResponsesReceivedTotal":if source==3{200}else{0},"framesDecoded":if source==3{150}else{0},"bytesReceived":if source==3{900000}else{0},"localCandidateType":if source==3{Some("srflx")}else{None},"remoteCandidateType":if source==3{Some("srflx")}else{None}});
        let event = Event {
            id: Uuid::new_v4(),
            session_id,
            participant: participants[0],
            source: participants[source],
            destination: participants[0],
            attempt: format!("{:064x}", source),
            generation: 1,
            kind: Kind::P2p,
            role: Role::Receiver,
            version: "0.0.0-nightly.0".into(),
            elapsed_ms: 15000,
            metrics: safe_for_kind(Kind::P2p, &metrics),
            patches: Vec::new(),
        };
        insert(&pool, owner, event).await?;
    }
    let event = Event {
        id: Uuid::new_v4(),
        session_id,
        participant: participants[1],
        source: participants[1],
        destination: participants[0],
        attempt: format!("{:064x}", 1),
        generation: 1,
        kind: Kind::Color,
        role: Role::Sender,
        version: "0.0.0-nightly.0".into(),
        elapsed_ms: 10000,
        metrics: safe_for_kind(
            Kind::Color,
            &serde_json::json!({"gpu":"nvidia","encoder":"mf_h264","capture":"wgc","vpOutputColorSpace":8,"fullRange":true,"decoderOutput":"unavailable","stage":"encoding","result":"observed"}),
        ),
        patches: Vec::new(),
    };
    insert(&pool, owner, event).await?;
    let config = AppConfig {
        database_url: String::new(),
        test_database_url: None,
        server_host: "127.0.0.1".into(),
        server_port: 18080,
        session_ttl_hours: 1,
        rate_limit_auth_per_minute: 10,
        google_client_id: String::new(),
        google_client_secret: None,
        google_jwks_url: "http://127.0.0.1:1".into(),
        tailscale_ip: None,
        public_fqdn: None,
        trust_proxy_headers: false,
        turn_secret: None,
        turn_server: None,
    };
    let auth = AuthService::new(
        UserRepository::new(pool.clone()),
        SessionRepository::new(pool),
        config,
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:18080").await?;
    println!("Disposable UI fixture listening on 127.0.0.1:18080; synthetic fixtures only");
    axum::serve(
        listener,
        admin_app(auth, vec![owner]).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}
async fn insert(pool: &sqlx::PgPool, owner: Uuid, e: Event) -> Result<(), sqlx::Error> {
    let kind = if e.kind == Kind::P2p { "p2p" } else { "color" };
    sqlx::query("INSERT INTO diagnostics_events(id,owner_id,session_id,consent_revision,kind,version,payload) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(e.id).bind(owner).bind(e.session_id).bind(Uuid::new_v4()).bind(kind).bind(&e.version).bind(serde_json::to_value(&e).unwrap()).execute(pool).await?;
    Ok(())
}
