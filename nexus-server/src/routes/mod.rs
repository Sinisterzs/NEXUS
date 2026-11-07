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
    let rate_limiter = RateLimiter::new(
        config.rate_limit_auth_per_minute as usize,
        Duration::from_secs(60),
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

    let auth_routes = Router::new()
        .merge(auth_public_routes)
        .merge(auth_protected_routes)
        .with_state(auth_service.clone());

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

    // CORS configuration for Tauri & Web clients (strictly scoped origins)
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::AllowOrigin::predicate(
            |origin: &header::HeaderValue, _parts: &axum::http::request::Parts| {
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
        .route("/health", get(handlers::health::health_check))
        .nest("/v1/auth", auth_routes)
        .nest("/v1/users", users_routes)
        .nest("/v1/friends", friends_routes)
        .nest("/v1/dm", dm_routes)
        .nest("/v1/gateway", gateway_routes.clone())
        .nest("/v1/ws", gateway_routes.clone())
        .nest("/ws", gateway_routes)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
}
