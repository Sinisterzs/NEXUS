use std::net::SocketAddr;

use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use nexus_server::config::AppConfig;
use nexus_server::create_app;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = AppConfig::from_env();

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nexus_server=debug,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("Conectando ao banco PostgreSQL em {}...", config.database_url);
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(&config.database_url)
        .await?;

    tracing::info!("Executando migrações do banco de dados...");
    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!("Migrações aplicadas com sucesso.");

    // Reseta qualquer status residual no banco de execuções anteriores do servidor
    if let Err(e) = sqlx::query("UPDATE user_profiles SET status = 'offline' WHERE status != 'offline'")
        .execute(&pool)
        .await
    {
        tracing::warn!("Aviso ao inicializar presença dos usuários: {}", e);
    }

    let app = create_app(pool, config.clone());

    let client_id_prefix = if config.google_client_id.len() > 16 {
        format!("{}...", &config.google_client_id[..16])
    } else {
        config.google_client_id.clone()
    };
    tracing::info!("Google OAuth ativo com Client ID: {}", client_id_prefix);
    let has_secret = config.google_client_secret.is_some();
    tracing::info!("Google OAuth: Client Secret carregado no backend: {}", has_secret);

    let server_port = config.server_port;

    // Direct explicit host configuration (e.g. custom or testing)
    if config.server_host != "127.0.0.1" && config.server_host != "localhost" {
        let addr: SocketAddr = config.server_addr().parse()?;
        tracing::info!("NEXUS Server escutando em http://{}", addr);
        let listener = tokio::net::TcpListener::bind(addr).await?;
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await?;
        return Ok(());
    }

    // 1. Loopback listener: always active on 127.0.0.1 (never 0.0.0.0)
    let loopback_addr: SocketAddr = format!("127.0.0.1:{}", server_port).parse()?;
    let loopback_listener = tokio::net::TcpListener::bind(loopback_addr).await?;
    tracing::info!("NEXUS Server escutando em loopback: http://{}", loopback_addr);

    let app_loopback = app.clone();
    let h_loopback = tokio::spawn(async move {
        if let Err(e) = axum::serve(
            loopback_listener,
            app_loopback.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        {
            tracing::error!("Erro no listener loopback: {}", e);
        }
    });

    // 2. Dynamic Tailscale supervisor task:
    // Periodically checks the host's Tailscale IP, binds to it, and updates if the IP changes or recovers.
    let app_tailscale = app.clone();
    let h_tailscale = tokio::spawn(async move {
        let mut current_bound_ip: Option<String> = None;
        let mut shutdown_tx: Option<tokio::sync::oneshot::Sender<()>> = None;

        loop {
            let detected = nexus_server::config::detect_tailscale_ip();

            if detected != current_bound_ip {
                // If previously listening on a different IP, stop old listener
                if let Some(tx) = shutdown_tx.take() {
                    let _ = tx.send(());
                    tracing::info!(
                        "Encerrando listener da interface Tailscale anterior ({:?})",
                        current_bound_ip
                    );
                    current_bound_ip = None;
                }

                if let Some(ref new_ip) = detected {
                    let ts_addr_str = format!("{}:{}", new_ip, server_port);
                    match ts_addr_str.parse::<SocketAddr>() {
                        Ok(ts_addr) => {
                            match tokio::net::TcpListener::bind(ts_addr).await {
                                Ok(ts_listener) => {
                                    tracing::info!(
                                        "NEXUS Server escutando na interface Tailscale: http://{}",
                                        ts_addr
                                    );
                                    current_bound_ip = Some(new_ip.clone());
                                    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
                                    shutdown_tx = Some(tx);
                                    let app_instance = app_tailscale.clone();

                                    tokio::spawn(async move {
                                        let server = axum::serve(
                                            ts_listener,
                                            app_instance
                                                .into_make_service_with_connect_info::<SocketAddr>(),
                                        )
                                        .with_graceful_shutdown(async move {
                                            let _ = rx.await;
                                        });

                                        if let Err(e) = server.await {
                                            tracing::error!(
                                                "Erro no listener Tailscale ({}): {}",
                                                ts_addr,
                                                e
                                            );
                                        }
                                    });
                                }
                                Err(err) => {
                                    tracing::warn!(
                                        "Não foi possível fazer bind no IP Tailscale {}: {}. Tentando novamente em 5s.",
                                        ts_addr_str,
                                        err
                                    );
                                }
                            }
                        }
                        Err(err) => {
                            tracing::warn!("Endereço Tailscale inválido '{}': {}", ts_addr_str, err);
                        }
                    }
                } else {
                    tracing::info!("Tailscale IP não detectado ou inativo. Aguardando interface privada...");
                }
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        }
    });

    let _ = tokio::try_join!(h_loopback, h_tailscale);

    Ok(())
}
