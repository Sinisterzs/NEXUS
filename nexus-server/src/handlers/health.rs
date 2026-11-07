use axum::{http::HeaderValue, response::IntoResponse, Json};
use chrono::Utc;

use crate::models::HealthResponse;

pub async fn health_check() -> impl IntoResponse {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::HeaderName::from_static("x-nexus-service"),
        HeaderValue::from_static("nexus-server"),
    );

    (
        headers,
        Json(HealthResponse {
            status: "ok".to_string(),
            service: "nexus-server".to_string(),
            timestamp: Utc::now(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        }),
    )
}
