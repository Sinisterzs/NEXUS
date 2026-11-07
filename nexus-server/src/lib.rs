pub mod config;
pub mod errors;
pub mod handlers;
pub mod middleware;
pub mod models;
pub mod repositories;
pub mod routes;
pub mod services;

use axum::Router;
use sqlx::PgPool;

use crate::config::AppConfig;
use crate::repositories::{DmRepository, FriendRepository, SessionRepository, UserRepository};
use crate::services::{AuthService, DmService, FriendService, PresenceManager};

pub fn create_app(pool: PgPool, config: AppConfig) -> Router {
    let user_repo = UserRepository::new(pool.clone());
    let session_repo = SessionRepository::new(pool.clone());
    let friend_repo = FriendRepository::new(pool.clone());
    let presence_mgr = PresenceManager::new(friend_repo.clone());
    let auth_service = AuthService::new(user_repo.clone(), session_repo, config.clone())
        .with_presence_manager(presence_mgr.clone());

    let friend_service = FriendService::new(friend_repo.clone(), presence_mgr.clone());

    let dm_repo = DmRepository::new(pool);
    let dm_service = DmService::new(dm_repo, friend_repo, user_repo, presence_mgr);

    routes::create_router(auth_service, friend_service, dm_service, &config)
}

pub fn create_app_with_auth_service(auth_service: AuthService, config: AppConfig) -> Router {
    let pool = auth_service.pool().clone();
    let user_repo = UserRepository::new(pool.clone());
    let friend_repo = FriendRepository::new(pool.clone());
    let presence_mgr = PresenceManager::new(friend_repo.clone());
    let auth_service = auth_service.with_presence_manager(presence_mgr.clone());
    let friend_service = FriendService::new(friend_repo.clone(), presence_mgr.clone());

    let dm_repo = DmRepository::new(pool);
    let dm_service = DmService::new(dm_repo, friend_repo, user_repo, presence_mgr);

    routes::create_router(auth_service, friend_service, dm_service, &config)
}
