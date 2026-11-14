use crate::{
    errors::AppError,
    middleware::{auth_middleware, CurrentSessionId, CurrentUser},
    services::{AuthService, RoomService},
};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    routing::{get, post, put},
    Extension, Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use uuid::Uuid;
#[path = "../../shared/diagnostics.rs"]
pub mod wire;
use wire::{Batch, Consent, Kind};

#[derive(Clone)]
pub struct Diagnostics {
    pool: PgPool,
    rooms: RoomService,
}
fn invalid() -> AppError {
    AppError::BadRequest("Diagnóstico inválido ou limite excedido.".into())
}
fn denied() -> AppError {
    AppError::Forbidden("Diagnóstico não autorizado.".into())
}

pub fn routes(auth: AuthService, rooms: RoomService) -> Router {
    Router::new()
        .route("/consent", put(consent))
        .route("/context", post(context))
        .route("/events", post(ingest))
        .layer(DefaultBodyLimit::max(196608))
        .layer(axum::middleware::from_fn_with_state(
            auth.clone(),
            auth_middleware,
        ))
        .layer(axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async move {
                let local = request
                    .extensions()
                    .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                    .is_some_and(|p| p.0.ip().is_loopback());
                let tls = local
                    && request
                        .headers()
                        .get("x-forwarded-proto")
                        .and_then(|v| v.to_str().ok())
                        == Some("https");
                if !tls && !(cfg!(debug_assertions) && local) {
                    return axum::response::IntoResponse::into_response(
                        axum::http::StatusCode::FORBIDDEN,
                    );
                }
                next.run(request).await
            },
        ))
        .with_state(Diagnostics {
            pool: auth.pool().clone(),
            rooms,
        })
}
#[derive(Serialize)]
pub struct Receipt {
    revision: Uuid,
    expires_at: DateTime<Utc>,
    permissions: Consent,
}

async fn consent(
    State(s): State<Diagnostics>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(CurrentSessionId(session)): Extension<CurrentSessionId>,
    Json(value): Json<Consent>,
) -> Result<Json<Receipt>, AppError> {
    let mut tx = s.pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '3s'")
        .execute(&mut *tx)
        .await?;
    // Serialize consent/revocation with ingestion for this authenticated session.
    sqlx::query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE")
        .bind(session)
        .execute(&mut *tx)
        .await?;
    let granting = value.p2p || value.color || value.synthetic;
    // Revocation is always accepted, including after the upload budget is exhausted.
    if granting {
        budget(&mut tx, user.id).await?;
    }
    let audit_count:i64=sqlx::query_scalar("SELECT count(*) FROM diagnostics_consent_audit WHERE owner_id=$1 AND created_at>now()-interval '7 days'")
        .bind(user.id).fetch_one(&mut *tx).await?;
    if granting && audit_count >= 1000 {
        return Err(AppError::RateLimited);
    }
    let revision = Uuid::new_v4();
    let expires_at = Utc::now() + chrono::Duration::minutes(15);
    sqlx::query("INSERT INTO diagnostics_consent(auth_session,owner_id,revision,p2p,color,synthetic,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(auth_session) DO UPDATE SET revision=$3,p2p=$4,color=$5,synthetic=$6,expires_at=$7,updated_at=now()")
        .bind(session).bind(user.id).bind(revision).bind(value.p2p).bind(value.color).bind(value.synthetic).bind(expires_at).execute(&mut *tx).await?;
    if audit_count < 1000 {
        sqlx::query(
            "INSERT INTO diagnostics_consent_audit(owner_id,revision,permissions) VALUES($1,$2,$3)",
        )
        .bind(user.id)
        .bind(revision)
        .bind(serde_json::to_value(&value).map_err(|_| invalid())?)
        .execute(&mut *tx)
        .await?;
    }
    // Even when audit quota is full, current consent stores the verifiable
    // revoked revision and updated_at; existing historical grant receipts remain.
    tx.commit().await?;
    Ok(Json(Receipt {
        revision,
        expires_at,
        permissions: value,
    }))
}
async fn budget(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: Uuid,
) -> Result<(), AppError> {
    let row=sqlx::query("INSERT INTO diagnostics_budgets(owner_id,requests) VALUES($1,1) ON CONFLICT(owner_id) DO UPDATE SET requests=CASE WHEN diagnostics_budgets.window_start < now()-interval '1 minute' THEN 1 ELSE diagnostics_budgets.requests+1 END,window_start=CASE WHEN diagnostics_budgets.window_start < now()-interval '1 minute' THEN now() ELSE diagnostics_budgets.window_start END RETURNING requests")
        .bind(owner).fetch_one(&mut **tx).await?;
    if row.get::<i32, _>("requests") > 24 {
        return Err(AppError::RateLimited);
    }
    Ok(())
}
#[derive(Serialize)]
pub struct Context {
    session_id: Uuid,
    participant: Uuid,
    peers: Vec<Peer>,
}
#[derive(Serialize)]
pub struct Peer {
    user_id: Uuid,
    alias: Uuid,
    synthetic_allowed: bool,
}
async fn context(
    State(s): State<Diagnostics>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
) -> Result<Json<Context>, AppError> {
    let (session_id, ids) = s.rooms.diagnostics_members(user.id).await?;
    let mut tx = s.pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '3s'")
        .execute(&mut *tx)
        .await?;
    budget(&mut tx, user.id).await?;
    let mut peers = Vec::new();
    let mut participant = Uuid::nil();
    for owner in ids {
        let alias:Uuid=sqlx::query_scalar("INSERT INTO diagnostics_participants(session_id,owner_id) VALUES($1,$2) ON CONFLICT(session_id,owner_id) DO UPDATE SET owner_id=EXCLUDED.owner_id RETURNING alias")
            .bind(session_id).bind(owner).fetch_one(&mut *tx).await?;
        if owner == user.id {
            participant = alias;
        }
        let synthetic_allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM diagnostics_consent WHERE owner_id=$1 AND synthetic AND expires_at>now())")
            .bind(owner).fetch_one(&mut *tx).await?;
        peers.push(Peer {
            user_id: owner,
            alias,
            synthetic_allowed,
        });
    }
    tx.commit().await?;
    Ok(Json(Context {
        session_id,
        participant,
        peers,
    }))
}
async fn ingest(
    State(s): State<Diagnostics>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Extension(CurrentSessionId(session)): Extension<CurrentSessionId>,
    Json(batch): Json<Batch>,
) -> Result<Json<serde_json::Value>, AppError> {
    if batch.events.is_empty()
        || batch.events.len() > 24
        || batch.events.iter().any(|e| !e.validate())
    {
        return Err(invalid());
    }
    let mut tx = s.pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM sessions WHERE id=$1 FOR UPDATE")
        .bind(session)
        .execute(&mut *tx)
        .await?;
    budget(&mut tx, user.id).await?;
    let r=sqlx::query("SELECT revision,p2p,color,synthetic FROM diagnostics_consent WHERE auth_session=$1 AND owner_id=$2 AND expires_at>now()")
        .bind(session).bind(user.id).fetch_optional(&mut *tx).await?.ok_or_else(denied)?;
    if r.get::<Uuid, _>("revision") != batch.consent_revision {
        return Err(denied());
    }
    // Shared DB lock serializes total storage quota across users and server replicas.
    sqlx::query("SELECT pg_advisory_xact_lock(1714140801)")
        .execute(&mut *tx)
        .await?;
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM diagnostics_events WHERE received_at>now()-interval '7 days'",
    )
    .fetch_one(&mut *tx)
    .await?;
    let owned:i64=sqlx::query_scalar("SELECT count(*) FROM diagnostics_events WHERE owner_id=$1 AND received_at>now()-interval '7 days'").bind(user.id).fetch_one(&mut *tx).await?;
    let ids: Vec<Uuid> = batch.events.iter().map(|e| e.id).collect();
    let existing: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM diagnostics_events WHERE id=ANY($1)")
            .bind(&ids)
            .fetch_all(&mut *tx)
            .await?;
    let new_count = ids
        .iter()
        .filter(|id| !existing.contains(id))
        .collect::<std::collections::HashSet<_>>()
        .len() as i64;
    if total + new_count > 100000 || owned + new_count > 6000 {
        return Err(AppError::RateLimited);
    }
    let mut accepted = 0;
    for e in batch.events {
        let permitted = match e.kind {
            Kind::P2p => r.get::<bool, _>("p2p"),
            Kind::Color => r.get::<bool, _>("color"),
            Kind::Synthetic => r.get::<bool, _>("synthetic"),
        };
        if !permitted {
            return Err(denied());
        }
        let own:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM diagnostics_participants WHERE session_id=$1 AND owner_id=$2 AND alias=$3 AND created_at>now()-interval '7 days')")
            .bind(e.session_id).bind(user.id).bind(e.participant).fetch_one(&mut *tx).await?;
        let pair:i64=sqlx::query_scalar("SELECT count(DISTINCT alias) FROM diagnostics_participants WHERE session_id=$1 AND alias=ANY($2) AND created_at>now()-interval '7 days'")
            .bind(e.session_id).bind(vec![e.source,e.destination]).fetch_one(&mut *tx).await?;
        let role_ok = match e.role {
            wire::Role::Sender => e.participant == e.source,
            wire::Role::Receiver => e.participant == e.destination,
            wire::Role::Local => e.source == e.participant && e.destination == e.participant,
        };
        if !own || pair != if e.source == e.destination { 1 } else { 2 } || !role_ok {
            return Err(denied());
        }
        if existing.contains(&e.id) {
            continue;
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM diagnostics_events WHERE owner_id=$1 AND session_id=$2",
        )
        .bind(user.id)
        .bind(e.session_id)
        .fetch_one(&mut *tx)
        .await?;
        if count >= 2000 {
            return Err(AppError::RateLimited);
        }
        let kind = match e.kind {
            Kind::P2p => "p2p",
            Kind::Color => "color",
            Kind::Synthetic => "synthetic",
        };
        accepted+=sqlx::query("INSERT INTO diagnostics_events(id,owner_id,session_id,consent_revision,kind,version,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING")
            .bind(e.id).bind(user.id).bind(e.session_id).bind(batch.consent_revision).bind(kind).bind(&e.version).bind(serde_json::to_value(&e).map_err(|_|invalid())?)
            .execute(&mut *tx).await?.rows_affected();
    }
    tx.commit().await?;
    Ok(Json(serde_json::json!({"accepted":accepted})))
}
pub async fn purge(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for query in [
        "DELETE FROM diagnostics_events WHERE received_at<now()-interval '7 days'",
        "DELETE FROM diagnostics_participants WHERE created_at<now()-interval '7 days'",
        "DELETE FROM diagnostics_consent_audit WHERE created_at<now()-interval '7 days'",
        "DELETE FROM diagnostics_consent WHERE updated_at<now()-interval '7 days'",
        "DELETE FROM diagnostics_budgets WHERE window_start<now()-interval '7 days'",
    ] {
        sqlx::query(query).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Clone)]
pub struct Admin {
    pool: PgPool,
    allowed: std::sync::Arc<Vec<Uuid>>,
}
fn admin_allowed(allowed: &[Uuid], id: Uuid) -> Result<(), AppError> {
    if allowed.contains(&id) {
        Ok(())
    } else {
        Err(denied())
    }
}
pub fn admin_app(auth: AuthService, allowed: Vec<Uuid>) -> Router {
    let protected = Router::new()
        .route("/sessions", get(list))
        .route("/sessions/:id", get(detail))
        .layer(axum::middleware::from_fn_with_state(
            auth.clone(),
            auth_middleware,
        ))
        .with_state(Admin {
            pool: auth.pool().clone(),
            allowed: std::sync::Arc::new(allowed),
        });
    let limiter = crate::middleware::RateLimiter::new(10, std::time::Duration::from_secs(60));
    let login = Router::new()
        .route("/login", post(crate::handlers::auth::login))
        .route("/logout", post(crate::handlers::auth::logout))
        .layer(axum::middleware::from_fn_with_state(
            limiter,
            crate::middleware::rate_limit_layer,
        ))
        .with_state(auth);
    Router::new().route("/",get(||async{axum::response::Html(include_str!("../admin/index.html"))}))
        .route("/panel.js",get(||async{([(axum::http::header::CONTENT_TYPE,"text/javascript")],include_str!("../admin/panel.js"))}))
        .nest("/api",protected.merge(login)).layer(DefaultBodyLimit::max(8192))
        .layer(axum::middleware::from_fn(|request:axum::extract::Request,next:axum::middleware::Next|async move{
            // Resist DNS rebinding. SSH can forward to any local port, but the
            // browser must address localhost/127.0.0.1 rather than a remote origin.
            if let Some(host)=request.headers().get("host").and_then(|v|v.to_str().ok()) {
                let name=host.split(':').next().unwrap_or("");
                if name!="localhost" && name!="127.0.0.1" {
                    return axum::response::IntoResponse::into_response(axum::http::StatusCode::BAD_REQUEST);
                }
            }
            let mut response=next.run(request).await;
            response.headers_mut().insert("cache-control","no-store".parse().unwrap());
            response.headers_mut().insert("content-security-policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'".parse().unwrap());
            response.headers_mut().insert("x-content-type-options","nosniff".parse().unwrap());response
        }))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filter {
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub version: Option<String>,
    pub kind: Option<String>,
}
async fn list(
    State(s): State<Admin>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Query(q): Query<Filter>,
) -> Result<Json<serde_json::Value>, AppError> {
    admin_allowed(&s.allowed, user.id)?;
    if q.version.as_ref().is_some_and(|v| !wire::valid_version(v))
        || q.kind
            .as_ref()
            .is_some_and(|k| !["p2p", "color", "synthetic", "screen"].contains(&k.as_str()))
    {
        return Err(invalid());
    }
    let rows=sqlx::query("SELECT session_id,min(received_at) AS first,max(received_at) AS last,count(*) AS events FROM diagnostics_events WHERE received_at>now()-interval '7 days' AND ($1::timestamptz IS NULL OR received_at >= $1) AND ($2::timestamptz IS NULL OR received_at <= $2) AND ($3::text IS NULL OR version=$3) AND ($4::text IS NULL OR kind=$4 OR ($4='screen' AND kind IN ('color','synthetic'))) GROUP BY session_id ORDER BY last DESC LIMIT 100")
        .bind(q.from).bind(q.to).bind(q.version).bind(q.kind).fetch_all(&s.pool).await?;
    Ok(Json(serde_json::json!(rows.iter().map(|r|serde_json::json!({"session_id":r.get::<Uuid,_>("session_id"),"first":r.get::<DateTime<Utc>,_>("first"),"last":r.get::<DateTime<Utc>,_>("last"),"events":r.get::<i64,_>("events")})).collect::<Vec<_>>())))
}
async fn detail(
    State(s): State<Admin>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    admin_allowed(&s.allowed, user.id)?;
    let rows=sqlx::query("SELECT payload,received_at FROM diagnostics_events WHERE session_id=$1 AND received_at>now()-interval '7 days' ORDER BY received_at,id LIMIT 8000")
        .bind(id).fetch_all(&s.pool).await?;
    let mut events = Vec::new();
    for row in rows {
        let e: wire::Event = serde_json::from_value(row.get("payload")).map_err(|_| invalid())?;
        let (classification, confidence) = wire::classify(&e);
        events.push(serde_json::json!({"event":e,"received_at":row.get::<DateTime<Utc>,_>("received_at"),"classification":classification,"confidence":confidence}));
    }
    Ok(Json(serde_json::json!({"session_id":id,"events":events})))
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    #[test]
    fn users_are_not_admin_by_default() {
        let user = Uuid::new_v4();
        assert!(admin_allowed(&[], user).is_err());
        assert!(admin_allowed(&[user], user).is_ok());
    }

    async fn call(
        app: &Router,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        builder = builder.extension(axum::extract::ConnectInfo(
            "127.0.0.1:39001".parse::<std::net::SocketAddr>().unwrap(),
        ));
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }
    #[tokio::test]
    async fn diagnostics_postgres_auth_consent_quota_retention_and_admin() {
        // Hard gate: NEVER use DATABASE_URL, dotenv or an existing service for tests.
        let root = std::env::var("NEXUS_DIAGNOSTICS_TEST_ROOT")
            .expect("Run scripts/Test-DiagnosticsBackend.ps1");
        let password =
            std::fs::read_to_string(std::path::Path::new(&root).join("pg-password")).unwrap();
        assert!(
            password.trim().len() == 64 && password.trim().bytes().all(|b| b.is_ascii_hexdigit())
        );
        let pool = PgPool::connect(&format!(
            "postgres://nexus_diag:{}@127.0.0.1:15439/nexus_diagnostics",
            password.trim()
        ))
        .await
        .unwrap();
        let ids: Vec<Uuid> = (0..4).map(|_| Uuid::new_v4()).collect();
        let mut tokens = Vec::new();
        use sha2::{Digest, Sha256};
        for id in &ids {
            sqlx::query("INSERT INTO users(id,username) VALUES($1,$2)")
                .bind(id)
                .bind(format!("diag_{}", &id.to_string()[..20]))
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO user_profiles(user_id,display_name) VALUES($1,'synthetic-test')",
            )
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO user_credentials(user_id,email,password_hash) VALUES($1,$2,'synthetic-not-a-password-hash')").bind(id).bind(format!("{id}@diagnostics.invalid")).execute(&pool).await.unwrap();
            let token = format!("nx_sess_{}", Uuid::new_v4());
            sqlx::query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')")
                .bind(id).bind(format!("{:x}",Sha256::digest(token.as_bytes()))).execute(&pool).await.unwrap();
            tokens.push(token);
        }
        let config = crate::config::AppConfig {
            database_url: String::new(),
            test_database_url: None,
            server_host: "127.0.0.1".into(),
            server_port: 13019,
            session_ttl_hours: 1,
            rate_limit_auth_per_minute: 30,
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
            crate::repositories::UserRepository::new(pool.clone()),
            crate::repositories::SessionRepository::new(pool.clone()),
            config,
        );
        let friends = crate::repositories::FriendRepository::new(pool.clone());
        let rooms = RoomService::new(
            pool.clone(),
            auth.clone(),
            crate::services::PresenceManager::new(friends),
        );
        let app = routes(auth.clone(), rooms.clone());
        assert_eq!(
            call(&app, "POST", "/events", None, serde_json::json!({}))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                &app,
                "POST",
                "/context",
                Some(&tokens[0]),
                serde_json::json!({})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        // Real room membership and four aliases; remote synthetic permission is
        // visible only for an active consenting participant, never inferred from IP.
        let community = Uuid::new_v4();
        let channel = Uuid::new_v4();
        sqlx::query("INSERT INTO communities(id,owner_id,name,initials) VALUES($1,$2,'synthetic-room','TEST')").bind(community).bind(ids[0]).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO community_channels(id,community_id,name,channel_type) VALUES($1,$2,'synthetic-voice','voice')").bind(channel).bind(community).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO community_roles(community_id,name,is_default,permissions_bitmask) VALUES($1,'default',true,$2)")
            .bind(community).bind(crate::services::community_permissions::ALL_DEFINED_PERMISSIONS).execute(&pool).await.unwrap();
        for id in &ids {
            sqlx::query("INSERT INTO community_members(community_id,user_id) VALUES($1,$2)")
                .bind(community)
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
            rooms.join_room(community, channel, *id).await.unwrap();
        }
        let (status, first_context) = call(
            &app,
            "POST",
            "/context",
            Some(&tokens[0]),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first_context["peers"].as_array().unwrap().len(), 4);
        assert!(first_context["peers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["synthetic_allowed"] == false));
        call(
            &app,
            "PUT",
            "/consent",
            Some(&tokens[1]),
            serde_json::json!({"p2p":false,"color":false,"synthetic":true}),
        )
        .await;
        let (_, second_context) = call(
            &app,
            "POST",
            "/context",
            Some(&tokens[0]),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(first_context["session_id"], second_context["session_id"]);
        assert_eq!(
            second_context["peers"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| p["synthetic_allowed"] == true)
                .count(),
            1
        );
        for id in &ids {
            rooms.leave_room(*id).await.unwrap();
        }
        rooms.join_room(community, channel, ids[0]).await.unwrap();
        let (_, next_context) = call(
            &app,
            "POST",
            "/context",
            Some(&tokens[0]),
            serde_json::json!({}),
        )
        .await;
        assert_ne!(first_context["session_id"], next_context["session_id"]);
        rooms.leave_room(ids[0]).await.unwrap();
        let session_id = Uuid::new_v4();
        let aliases: Vec<Uuid> = (0..4).map(|_| Uuid::new_v4()).collect();
        for (id, alias) in ids.iter().zip(&aliases) {
            sqlx::query(
                "INSERT INTO diagnostics_participants(session_id,owner_id,alias) VALUES($1,$2,$3)",
            )
            .bind(session_id)
            .bind(id)
            .bind(alias)
            .execute(&pool)
            .await
            .unwrap();
        }
        let make = |source: usize| wire::Event {
            id: Uuid::new_v4(),
            session_id,
            participant: aliases[0],
            source: aliases[source],
            destination: aliases[0],
            attempt: format!(
                "{:x}",
                Sha256::digest(
                    format!("{session_id}:{}:{}:same-offer", aliases[source], aliases[0])
                        .as_bytes()
                )
            ),
            generation: 1,
            kind: Kind::P2p,
            role: wire::Role::Receiver,
            version: "0.4.0-nightly.5".into(),
            elapsed_ms: 15000,
            metrics: wire::safe_metrics(
                &serde_json::json!({"iceConnectionState":"checking","icePairs":21,"iceResponsesReceivedTotal":0,"localCandidateType":null}),
            ),
            patches: Vec::new(),
        };
        let event = make(1);
        let dummy = Batch {
            consent_revision: Uuid::new_v4(),
            events: vec![event.clone()],
        };
        assert_eq!(
            call(
                &app,
                "POST",
                "/events",
                Some(&tokens[0]),
                serde_json::to_value(&dummy).unwrap()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let (status, receipt) = call(
            &app,
            "PUT",
            "/consent",
            Some(&tokens[0]),
            serde_json::json!({"p2p":true,"color":false,"synthetic":false}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let revision: Uuid = serde_json::from_value(receipt["revision"].clone()).unwrap();
        let batch = Batch {
            consent_revision: revision,
            events: vec![event.clone(), make(2), make(3)],
        };
        assert_eq!(
            call(
                &app,
                "POST",
                "/events",
                Some(&tokens[0]),
                serde_json::to_value(&batch).unwrap()
            )
            .await
            .1["accepted"],
            3
        );
        assert_eq!(
            call(
                &app,
                "POST",
                "/events",
                Some(&tokens[0]),
                serde_json::to_value(&batch).unwrap()
            )
            .await
            .1["accepted"],
            0
        );
        let mut invalid_payload = serde_json::to_value(&batch).unwrap();
        invalid_payload["events"][0]["metrics"]["sdp"] = serde_json::json!("PRIVATE");
        assert_eq!(
            call(&app, "POST", "/events", Some(&tokens[0]), invalid_payload)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        let mut spoof = event.clone();
        spoof.id = Uuid::new_v4();
        spoof.participant = aliases[1];
        assert_eq!(
            call(
                &app,
                "POST",
                "/events",
                Some(&tokens[0]),
                serde_json::to_value(Batch {
                    consent_revision: revision,
                    events: vec![spoof]
                })
                .unwrap()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let mut color = event.clone();
        color.id = Uuid::new_v4();
        color.kind = Kind::Color;
        color.metrics = wire::safe_for_kind(Kind::Color, &serde_json::json!({"gpu":"amd"}));
        assert_eq!(
            call(
                &app,
                "POST",
                "/events",
                Some(&tokens[0]),
                serde_json::to_value(Batch {
                    consent_revision: revision,
                    events: vec![color]
                })
                .unwrap()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let oversized = serde_json::json!({"x":"x".repeat(200000)});
        assert_eq!(
            call(&app, "POST", "/events", Some(&tokens[0]), oversized)
                .await
                .0,
            StatusCode::PAYLOAD_TOO_LARGE
        );
        // A remote peer cannot claim TLS just by supplying a forwarded header.
        let remote = Request::builder()
            .method("POST")
            .uri("/context")
            .header("authorization", format!("Bearer {}", tokens[0]))
            .header("x-forwarded-proto", "https")
            .extension(axum::extract::ConnectInfo(
                "198.51.100.9:39001"
                    .parse::<std::net::SocketAddr>()
                    .unwrap(),
            ))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(remote).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let admin = admin_app(auth.clone(), vec![ids[3]]);
        let rebound = Request::builder()
            .uri("/")
            .header("host", "untrusted.invalid:18080")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            admin.clone().oneshot(rebound).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );

        assert_eq!(
            call(
                &admin,
                "GET",
                "/api/sessions",
                Some(&tokens[0]),
                serde_json::Value::Null
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let (status, export) = call(
            &admin,
            "GET",
            &format!("/api/sessions/{session_id}"),
            Some(&tokens[3]),
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(export["events"].as_array().unwrap().len(), 3);
        let serialized = export.to_string();
        for id in &ids {
            assert!(!serialized.contains(&id.to_string()));
        }
        for token in &tokens {
            assert!(!serialized.contains(token));
        }
        assert_eq!(
            export["events"][0]["classification"],
            "ice_without_selected_pair"
        );
        assert_eq!(
            call(
                &app,
                "GET",
                "/api/sessions",
                Some(&tokens[3]),
                serde_json::Value::Null
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        call(
            &app,
            "PUT",
            "/consent",
            Some(&tokens[0]),
            serde_json::json!({"p2p":false,"color":false,"synthetic":false}),
        )
        .await;
        assert_eq!(
            call(
                &app,
                "POST",
                "/events",
                Some(&tokens[0]),
                serde_json::to_value(&batch).unwrap()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        sqlx::query(
            "UPDATE diagnostics_budgets SET requests=24,window_start=now() WHERE owner_id=$1",
        )
        .bind(ids[0])
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            call(
                &app,
                "POST",
                "/context",
                Some(&tokens[0]),
                serde_json::json!({})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &app,
                "PUT",
                "/consent",
                Some(&tokens[0]),
                serde_json::json!({"p2p":true,"color":false,"synthetic":false})
            )
            .await
            .0,
            StatusCode::TOO_MANY_REQUESTS
        );
        sqlx::query("UPDATE diagnostics_budgets SET requests=0 WHERE owner_id=$1")
            .bind(ids[0])
            .execute(&pool)
            .await
            .unwrap();
        let (_, color_receipt) = call(
            &app,
            "PUT",
            "/consent",
            Some(&tokens[0]),
            serde_json::json!({"p2p":false,"color":true,"synthetic":false}),
        )
        .await;
        let color_revision: Uuid =
            serde_json::from_value(color_receipt["revision"].clone()).unwrap();
        let mut color = event.clone();
        color.id = Uuid::new_v4();
        color.kind = Kind::Color;
        color.metrics = wire::safe_for_kind(
            Kind::Color,
            &serde_json::json!({"gpu":"amd","decoderOutput":"unavailable"}),
        );
        let color_batch = Batch {
            consent_revision: color_revision,
            events: vec![color.clone()],
        };
        assert_eq!(
            call(
                &app,
                "POST",
                "/events",
                Some(&tokens[0]),
                serde_json::to_value(&color_batch).unwrap()
            )
            .await
            .1["accepted"],
            1
        );
        assert_eq!(
            call(
                &app,
                "POST",
                "/events",
                Some(&tokens[0]),
                serde_json::to_value(Batch {
                    consent_revision: color_revision,
                    events: vec![make(1)]
                })
                .unwrap()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        // Exercise the per-owner/per-room storage ceiling without any real user data.
        sqlx::query("INSERT INTO diagnostics_events(id,owner_id,session_id,consent_revision,kind,version,payload) SELECT gen_random_uuid(),$1,$2,$3,'color','0.4.0-nightly.5',$4 FROM generate_series(1,2000)")
            .bind(ids[0]).bind(session_id).bind(color_revision).bind(serde_json::to_value(&color).unwrap()).execute(&pool).await.unwrap();
        assert_eq!(
            call(
                &app,
                "POST",
                "/events",
                Some(&tokens[0]),
                serde_json::to_value(&color_batch).unwrap()
            )
            .await
            .1["accepted"],
            0
        );
        color.id = Uuid::new_v4();
        assert_eq!(
            call(
                &app,
                "POST",
                "/events",
                Some(&tokens[0]),
                serde_json::to_value(Batch {
                    consent_revision: color_revision,
                    events: vec![color]
                })
                .unwrap()
            )
            .await
            .0,
            StatusCode::TOO_MANY_REQUESTS
        );
        sqlx::query(
            "UPDATE diagnostics_events SET received_at=now()-interval '8 days' WHERE owner_id=$1",
        )
        .bind(ids[0])
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            call(
                &admin,
                "GET",
                &format!("/api/sessions/{session_id}"),
                Some(&tokens[3]),
                serde_json::Value::Null
            )
            .await
            .1["events"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        purge(&pool).await.unwrap();
        let remaining: i64 =
            sqlx::query_scalar("SELECT count(*) FROM diagnostics_events WHERE owner_id=$1")
                .bind(ids[0])
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(remaining, 0);
        sqlx::query("DELETE FROM communities WHERE id=$1")
            .bind(community)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM users WHERE id=ANY($1)")
            .bind(&ids)
            .execute(&pool)
            .await
            .unwrap();
    }
}
