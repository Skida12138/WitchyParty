use std::path::Path;

use witchy_web_server::{
    alchemy::AlchemyService, app::AppState, bots::BotService, router::build_router,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root");
    dotenv::from_path(root.join(".env")).ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "witchy_web_server=info".into()),
        )
        .init();
    witchy_web_server::gameplay::initialize_config(root)?;
    let state = AppState::new(
        AlchemyService::from_env(root)?,
        BotService::from_root(root)?,
    );
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3001);
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    println!(
        "Witchy Party: http://{} (deepseek; AI {})",
        listener.local_addr()?,
        if state.ai_ready {
            "configured"
        } else {
            "not configured"
        }
    );
    let rooms = state.rooms.clone();
    let shutdown_rooms = rooms.clone();
    axum::serve(listener, build_router(state, root))
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            rooms.close();
        })
        .await?;
    shutdown_rooms.shutdown().await;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
