use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use axum::{
    extract::{ConnectInfo, Request, State},
    middleware::Next,
    response::Response,
};

use crate::errors::AppError;

pub const DEFAULT_MAX_TRACKED_IPS: usize = 4096;

#[derive(Clone)]
pub struct RateLimiter {
    requests: Arc<Mutex<HashMap<IpAddr, Vec<Instant>>>>,
    max_requests: usize,
    window: Duration,
    max_entries: usize,
}

impl RateLimiter {
    pub fn new(max_requests: usize, window: Duration) -> Self {
        Self::with_max_entries(max_requests, window, DEFAULT_MAX_TRACKED_IPS)
    }

    pub fn with_max_entries(max_requests: usize, window: Duration, max_entries: usize) -> Self {
        Self {
            requests: Arc::new(Mutex::new(HashMap::new())),
            max_requests,
            window,
            max_entries: max_entries.max(1),
        }
    }

    pub async fn tracked_ip_count(&self) -> usize {
        self.requests.lock().await.len()
    }

    pub async fn check(&self, ip: IpAddr) -> bool {
        let mut map = self.requests.lock().await;
        let now = Instant::now();
        let window = self.window;

        // If map is at capacity and this is a new IP, first prune all expired entries across the map
        if !map.contains_key(&ip) && map.len() >= self.max_entries {
            map.retain(|_, ts| {
                ts.retain(|&t| now.duration_since(t) < window);
                !ts.is_empty()
            });

            // If still at capacity after pruning expired entries, evict the oldest active IP entry
            if map.len() >= self.max_entries {
                if let Some(oldest_ip) = map
                    .iter()
                    .min_by_key(|(_, ts)| ts.last().copied().unwrap_or(now))
                    .map(|(k, _)| *k)
                {
                    map.remove(&oldest_ip);
                }
            }
        }

        let timestamps = map.entry(ip).or_default();
        timestamps.retain(|&t| now.duration_since(t) < window);

        if timestamps.len() >= self.max_requests {
            if timestamps.is_empty() {
                map.remove(&ip);
            }
            false
        } else {
            timestamps.push(now);
            true
        }
    }
}

pub fn extract_client_ip(req: &Request) -> IpAddr {
    // Strictly use actual TCP peer address from ConnectInfo; never trust client-supplied X-Forwarded-For
    if let Some(connect_info) = req.extensions().get::<ConnectInfo<SocketAddr>>() {
        return connect_info.0.ip();
    }

    // Default to localhost (e.g. in-process oneshot test requests)
    IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))
}

pub async fn rate_limit_layer(
    State(limiter): State<RateLimiter>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let client_ip = extract_client_ip(&request);

    if !limiter.check(client_ip).await {
        tracing::warn!(
            target: "nexus_server::rate_limit",
            ip = %client_ip,
            "Rate limit exceeded"
        );
        return Err(AppError::RateLimited);
    }

    Ok(next.run(request).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;

    #[test]
    fn test_extract_client_ip_ignores_spoofed_x_forwarded_for() {
        let mut req = Request::builder()
            .uri("/v1/auth/login")
            .header("x-forwarded-for", "203.0.113.99, 198.51.100.1")
            .body(Body::empty())
            .unwrap();

        let real_peer: SocketAddr = "100.101.102.103:54321".parse().unwrap();
        req.extensions_mut().insert(ConnectInfo(real_peer));

        let extracted = extract_client_ip(&req);
        assert_eq!(extracted, "100.101.102.103".parse::<IpAddr>().unwrap());
    }

    #[tokio::test]
    async fn test_rate_limiter_bounded_storage_and_expiration() {
        let limiter = RateLimiter::with_max_entries(2, Duration::from_millis(80), 8);

        for i in 1..=50u8 {
            let ip = IpAddr::V4(Ipv4Addr::new(100, 64, 0, i));
            assert!(limiter.check(ip).await);
            assert!(
                limiter.tracked_ip_count().await <= 8,
                "RateLimiter map exceeded max_entries cap of 8"
            );
        }

        // Wait for window to expire, then insert one new IP to trigger cleanup of expired entries
        tokio::time::sleep(Duration::from_millis(100)).await;
        let fresh_ip = IpAddr::V4(Ipv4Addr::new(100, 64, 1, 1));
        assert!(limiter.check(fresh_ip).await);
        assert_eq!(limiter.tracked_ip_count().await, 1);
    }
}
