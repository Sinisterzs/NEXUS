use std::time::Duration;

use axum::{
    http::{header, Method},
    routing::{delete, get, patch, post, put},
    Router,
};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::config::AppConfig;
use crate::handlers;
use crate::middleware::{auth_middleware, rate_limit_layer, RateLimiter};
use crate::services::{AuthService, DmService, FriendService};

#[derive(Clone)]
pub struct UsersState {
    pub auth_service: AuthService,
    pub friend_service: FriendService,
}

impl axum::extract::FromRef<UsersState> for FriendService {
    fn from_ref(state: &UsersState) -> Self {
        state.friend_service.clone()
    }
}

impl axum::extract::FromRef<UsersState> for AuthService {
    fn from_ref(state: &UsersState) -> Self {
        state.auth_service.clone()
    }
}

pub fn create_router(
    auth_service: AuthService,
    friend_service: FriendService,
    dm_service: DmService,
    config: &AppConfig,
) -> Router {
    let identity = crate::identity::ServerIdentity::load_or_generate(None)
        .unwrap_or_else(|_| crate::identity::ServerIdentity::generate_ephemeral());
    create_router_with_identity(auth_service, friend_service, dm_service, config, identity)
}

pub fn create_router_with_identity(
    auth_service: AuthService,
    friend_service: FriendService,
    dm_service: DmService,
    config: &AppConfig,
    identity: crate::identity::ServerIdentity,
) -> Router {
    let system_state = handlers::health::SystemState {
        identity: std::sync::Arc::new(identity),
        config_host: config.server_host.clone(),
        config_port: config.server_port,
        tailscale_ip: config.tailscale_ip.clone(),
        public_fqdn: config.public_fqdn.clone(),
    };

    let system_routes = Router::new()
        .route("/health", get(handlers::health::health_check))
        .route("/v1/system/challenge", post(handlers::health::challenge_check))
        .route("/system/challenge", post(handlers::health::challenge_check))
        .with_state(system_state);
    let rate_limiter = RateLimiter::with_options(
        config.rate_limit_auth_per_minute as usize,
        Duration::from_secs(60),
        crate::middleware::rate_limit::DEFAULT_MAX_TRACKED_IPS,
        config.trust_proxy_headers,
    );

    // 1. Public auth routes with rate limiting
    let auth_public_routes = Router::new()
        .route("/register", post(handlers::auth::register))
        .route("/login", post(handlers::auth::login))
        .route("/google", post(handlers::auth::google_auth))
        .layer(axum::middleware::from_fn_with_state(
            rate_limiter.clone(),
            rate_limit_layer,
        ));

    // 2. Protected auth routes (logout, refresh, link/unlink google)
    let auth_protected_routes = Router::new()
        .route("/logout", post(handlers::auth::logout))
        .route("/refresh", post(handlers::auth::refresh))
        .route(
            "/google/link",
            post(handlers::auth::google_link).layer(axum::middleware::from_fn_with_state(
                auth_service.clone(),
                auth_middleware,
            )),
        )
        .route(
            "/google",
            delete(handlers::auth::google_unlink).layer(axum::middleware::from_fn_with_state(
                auth_service.clone(),
                auth_middleware,
            )),
        );

    let password_reset_routes = Router::new()
        .route("/password/forgot", post(handlers::auth::forgot_password))
        .route(
            "/password/verify",
            post(handlers::auth::verify_reset_token),
        )
        .route("/password/reset", post(handlers::auth::reset_password))
        .layer(axum::middleware::from_fn_with_state(
            rate_limiter.clone(),
            rate_limit_layer,
        ))
        .with_state(auth_service.password_reset_service());

    let auth_routes = Router::new()
        .merge(auth_public_routes)
        .merge(auth_protected_routes)
        .with_state(auth_service.clone())
        .merge(password_reset_routes);

    let users_state = UsersState {
        auth_service: auth_service.clone(),
        friend_service: friend_service.clone(),
    };

    // 3. User routes protected by auth middleware
    let users_routes = Router::new()
        .route("/me", get(handlers::users::get_me))
        .route("/me", patch(handlers::users::update_me))
        .route("/me/presence", get(handlers::friends::get_presence))
        .route("/me/presence", patch(handlers::friends::update_presence))
        .route("/me/presence", put(handlers::friends::update_presence))
        .route("/search", get(handlers::friends::search_users))
        .route("/:id/block", post(handlers::friends::block_user))
        .route("/:id/block", delete(handlers::friends::unblock_user))
        .layer(axum::middleware::from_fn_with_state(
            auth_service.clone(),
            auth_middleware,
        ))
        .with_state(users_state);

    // 4. Friend routes protected by auth middleware
    let friends_routes = Router::new()
        .route("/", get(handlers::friends::list_friends))
        .route("/requests", get(handlers::friends::list_requests))
        .route("/requests", post(handlers::friends::send_request))
        .route("/requests/:id/accept", post(handlers::friends::accept_request))
        .route("/requests/:id/reject", post(handlers::friends::reject_request))
        .route("/requests/:id/decline", post(handlers::friends::reject_request))
        .route("/requests/:id", delete(handlers::friends::cancel_request))
        .route("/:friend_id", delete(handlers::friends::remove_friend))
        .layer(axum::middleware::from_fn_with_state(
            auth_service.clone(),
            auth_middleware,
        ))
        .with_state(friend_service.clone());

    // 5. DM routes protected by auth middleware
    let dm_routes = Router::new()
        .route("/conversations", get(handlers::dm::list_conversations))
        .route("/conversations", post(handlers::dm::create_conversation))
        .route("/conversations/:id/messages", get(handlers::dm::list_messages))
        .route("/conversations/:id/messages", post(handlers::dm::send_message))
        .route("/conversations/:id/read", post(handlers::dm::mark_read))
        .route("/conversations/:id/delivered", post(handlers::dm::mark_delivered))
        .route("/messages/:id", patch(handlers::dm::edit_message))
        .route("/messages/:id", delete(handlers::dm::delete_message))
        .layer(axum::middleware::from_fn_with_state(
            auth_service.clone(),
            auth_middleware,
        ))
        .with_state(dm_service.clone());

    // 6. WebSocket endpoint for Gateway real-time presence and social events + ephemeral ticket
    let call_service = crate::services::CallService::new(
        friend_service.friend_repository().clone(),
        auth_service.clone(),
        friend_service.presence_manager().clone(),
    );

    let ws_state = handlers::ws::WsState {
        auth_service: auth_service.clone(),
        friend_service: friend_service.clone(),
        dm_service: dm_service.clone(),
        call_service: call_service.clone(),
    };
    let gateway_ws_routes = Router::new()
        .route("/", get(handlers::ws::ws_handler))
        .with_state(ws_state);

    let gateway_ticket_routes = Router::new()
        .route("/ticket", post(handlers::dm::create_gateway_ticket))
        .layer(axum::middleware::from_fn_with_state(
            auth_service.clone(),
            auth_middleware,
        ))
        .with_state(dm_service.clone());

    let gateway_routes = Router::new()
        .merge(gateway_ws_routes)
        .merge(gateway_ticket_routes);

    // 7. WebRTC ICE / STUN / TURN routes protected by auth middleware
    let webrtc_state = handlers::webrtc::WebrtcState {
        turn_secret: config.turn_secret.clone(),
        turn_server: config.turn_server.clone(),
    };
    let webrtc_routes = Router::new()
        .route("/ice-servers", get(handlers::webrtc::get_ice_servers))
        .layer(axum::middleware::from_fn_with_state(
            auth_service.clone(),
            auth_middleware,
        ))
        .with_state(webrtc_state);

    // CORS configuration for Tauri & Web clients (strictly scoped origins)
    let public_fqdn = config.public_fqdn.clone();
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::AllowOrigin::predicate(
            move |origin: &header::HeaderValue, _parts: &axum::http::request::Parts| {
                if let Ok(s) = origin.to_str() {
                    let clean = s.trim().to_ascii_lowercase();
                    // 1. Tauri desktop application origins
                    if clean == "tauri://localhost"
                        || clean == "http://tauri.localhost"
                        || clean == "https://tauri.localhost"
                    {
                        return true;
                    }
                    // 2. Local development origins (Vite / local test clients)
                    if clean.starts_with("http://localhost:")
                        || clean.starts_with("http://127.0.0.1:")
                        || clean.starts_with("https://localhost:")
                        || clean.starts_with("https://127.0.0.1:")
                    {
                        return true;
                    }
                    // 3. Tailscale MagicDNS and private network origins
                    if clean.ends_with(".ts.net")
                        || clean.starts_with("http://100.")
                        || clean.starts_with("https://100.")
                    {
                        return true;
                    }
                    // 4. Configured Public FQDN origin (HTTPS or HTTP)
                    if let Some(ref fqdn) = public_fqdn {
                        let https_origin = format!("https://{}", fqdn);
                        let http_origin = format!("http://{}", fqdn);
                        if clean == https_origin
                            || clean == http_origin
                            || clean.starts_with(&format!("{}:", https_origin))
                            || clean.starts_with(&format!("{}:", http_origin))
                        {
                            return true;
                        }
                    }
                }
                false
            },
        ))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::ACCEPT,
        ]);

    Router::new()
        .merge(system_routes)
        .nest("/v1/auth", auth_routes)
        .nest("/v1/users", users_routes)
        .nest("/v1/friends", friends_routes)
        .nest("/v1/dm", dm_routes)
        .nest("/v1/webrtc", webrtc_routes)
        .nest("/v1/gateway", gateway_routes.clone())
        .nest("/v1/ws", gateway_routes.clone())
        .nest("/ws", gateway_routes)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
}
