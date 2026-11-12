use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::{header, Method},
    routing::{delete, get, patch, post, put},
    Extension, Json, Router,
};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::config::AppConfig;
use crate::errors::AppError;
use crate::handlers;
use crate::middleware::{auth_middleware, rate_limit_layer, CurrentUser, RateLimiter};
use crate::models::VoiceRoomStateDto;
use crate::repositories::CommunityRepository;
use crate::services::{AuthService, CommunityService, DmService, FriendService, RoomService};

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
        .route("/reset-password", get(handlers::auth::password_reset_bridge))
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
        .route("/password/bridge", get(handlers::auth::password_reset_bridge))
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
    let room_service = RoomService::new(
        auth_service.pool().clone(),
        auth_service.clone(),
        friend_service.presence_manager().clone(),
    );

    let ws_state = handlers::ws::WsState {
        auth_service: auth_service.clone(),
        friend_service: friend_service.clone(),
        dm_service: dm_service.clone(),
        call_service: call_service.clone(),
        room_service: room_service.clone(),
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

    // 8. Community & Invite routes protected by auth middleware
    let community_repo = CommunityRepository::new(auth_service.pool().clone());
    let community_service = CommunityService::new_with_presence(
        community_repo,
        friend_service.presence_manager().clone(),
    );

    let communities_routes = Router::new()
        .route(
            "/",
            get(handlers::communities::list_communities)
                .post(handlers::communities::create_community),
        )
        .route(
            "/:community_id",
            get(handlers::communities::get_snapshot)
                .patch(handlers::communities::update_community)
                .delete(handlers::communities::delete_community),
        )
        .route(
            "/:community_id/transfer-ownership",
            post(handlers::communities::transfer_ownership),
        )
        .route(
            "/:community_id/leave",
            post(handlers::communities::leave_community),
        )
        // Categories
        .route(
            "/:community_id/categories",
            post(handlers::communities::create_category),
        )
        .route(
            "/:community_id/categories/reorder",
            put(handlers::communities::reorder_categories),
        )
        .route(
            "/:community_id/categories/:category_id",
            patch(handlers::communities::update_category)
                .delete(handlers::communities::delete_category),
        )
        // Channels & Overwrites
        .route(
            "/:community_id/channels",
            post(handlers::communities::create_channel),
        )
        .route(
            "/:community_id/channels/reorder",
            put(handlers::communities::reorder_channels),
        )
        .route(
            "/:community_id/channels/:channel_id",
            patch(handlers::communities::update_channel)
                .delete(handlers::communities::delete_channel),
        )
        .route(
            "/:community_id/channels/:channel_id/overwrites",
            get(handlers::communities::list_channel_overwrites)
                .put(handlers::communities::upsert_channel_overwrite),
        )
        .route(
            "/:community_id/channels/:channel_id/overwrites/:target_type/:target_id",
            delete(handlers::communities::delete_channel_overwrite),
        )
        // Messages & Read states
        .route(
            "/:community_id/channels/:channel_id/messages",
            get(handlers::communities::list_channel_messages)
                .post(handlers::communities::send_channel_message),
        )
        .route(
            "/:community_id/channels/:channel_id/messages/:message_id",
            patch(handlers::communities::edit_channel_message)
                .delete(handlers::communities::delete_channel_message),
        )
        .route(
            "/:community_id/channels/:channel_id/read",
            post(handlers::communities::mark_channel_read),
        )
        // Roles & Members
        .route(
            "/:community_id/roles",
            get(handlers::communities::list_roles).post(handlers::communities::create_role),
        )
        .route(
            "/:community_id/roles/reorder",
            put(handlers::communities::reorder_roles),
        )
        .route(
            "/:community_id/roles/:role_id",
            patch(handlers::communities::update_role)
                .delete(handlers::communities::delete_role),
        )
        .route(
            "/:community_id/members",
            get(handlers::communities::list_members),
        )
        .route(
            "/:community_id/members/:user_id",
            patch(handlers::communities::update_member),
        )
        .route(
            "/:community_id/members/:user_id/roles",
            put(handlers::communities::set_member_roles),
        )
        .route(
            "/:community_id/members/:user_id/roles/:role_id",
            post(handlers::communities::add_member_role)
                .delete(handlers::communities::remove_member_role),
        )
        // Moderation & Audit Logs
        .route(
            "/:community_id/members/:user_id/kick",
            post(handlers::communities::kick_member),
        )
        .route(
            "/:community_id/members/:user_id/ban",
            post(handlers::communities::ban_member),
        )
        .route(
            "/:community_id/bans",
            get(handlers::communities::list_bans),
        )
        .route(
            "/:community_id/bans/:user_id",
            delete(handlers::communities::unban_member),
        )
        .route(
            "/:community_id/members/:user_id/mute",
            put(handlers::communities::mute_member),
        )
        .route(
            "/:community_id/audit-logs",
            get(handlers::communities::list_audit_logs),
        )
        // Invites
        .route(
            "/:community_id/invites",
            get(handlers::communities::list_invites).post(handlers::communities::create_invite),
        )
        .route(
            "/:community_id/invites/:invite_id",
            delete(handlers::communities::revoke_invite),
        )
        .layer(axum::middleware::from_fn_with_state(
            auth_service.clone(),
            auth_middleware,
        ))
        .with_state(community_service.clone());

    let community_voice_rooms_routes = Router::new()
        .route(
            "/:community_id/voice-rooms",
            get(list_community_voice_rooms),
        )
        .layer(axum::middleware::from_fn_with_state(
            auth_service.clone(),
            auth_middleware,
        ))
        .with_state(room_service);

    let communities_routes = communities_routes.merge(community_voice_rooms_routes);

    let invites_routes = Router::new()
        .route("/:code", get(handlers::communities::get_invite_preview))
        .route("/:code/accept", post(handlers::communities::accept_invite))
        .layer(axum::middleware::from_fn_with_state(
            auth_service.clone(),
            auth_middleware,
        ))
        .with_state(community_service);

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
        .nest("/v1/communities", communities_routes)
        .nest("/v1/invites", invites_routes)
        .nest("/v1/webrtc", webrtc_routes)
        .nest("/v1/gateway", gateway_routes.clone())
        .nest("/v1/ws", gateway_routes.clone())
        .nest("/ws", gateway_routes)
        .layer(cors)
        .layer(
            TraceLayer::new_for_http().make_span_with(|request: &axum::http::Request<_>| {
                // Log only the request path (never query parameters or fragments) so
                // recovery tokens or ephemeral tickets can never enter HTTP trace logs.
                tracing::info_span!(
                    "http_request",
                    method = %request.method(),
                    path = %request.uri().path(),
                )
            }),
        )
}

async fn list_community_voice_rooms(
    State(room_service): State<RoomService>,
    Extension(CurrentUser(user)): Extension<CurrentUser>,
    Path(community_id): Path<Uuid>,
) -> Result<Json<Vec<VoiceRoomStateDto>>, AppError> {
    let rooms = room_service
        .list_community_voice_rooms(community_id, user.id)
        .await?;
    Ok(Json(rooms))
}
