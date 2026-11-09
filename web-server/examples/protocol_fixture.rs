//! Test-only process for the existing Node protocol fixtures. Production main
//! never reads these switches; normal tests still run the production binary.
use std::path::Path;
use witchy_web_server::{
    access::InviteAccess, alchemy::AlchemyService, app::AppState, bots::BotService,
    rooms::RoomsService, router::build_router,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    witchy_web_server::gameplay::initialize_config(root)?;
    let alchemy = AlchemyService::from_env(root)?;
    let ready = alchemy.ready();
    let bots = BotService::from_root(root)?;
    let rooms = if std::env::var("WITCHY_TEST_CHAIN").as_deref() == Ok("1") {
        RoomsService::with_room_setup(alchemy, bots, |room| {
            room.set_random_source(witchy_web_server::gameplay::RandomSource::scripted(vec![
                1.0, 1.0, 1.0, 0.0, 0.0,
            ]));
        })
    } else {
        RoomsService::new(alchemy, bots)
    };
    if std::env::var("WITCHY_TEST_PAUSE_MAINTENANCE").as_deref() == Ok("1") {
        rooms.stop_maintenance();
    }
    let state = AppState {
        rooms: rooms.clone(),
        ai_ready: ready,
        access: InviteAccess::new(std::env::var("INVITE_CODE_SHA256").ok().as_deref()),
    };
    let port: u16 = std::env::var("PORT")?.parse()?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let shutdown_rooms = rooms.clone();
    axum::serve(listener, build_router(state, root))
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                let mut signal =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .unwrap();
                tokio::select! {_=signal.recv()=>{},_=tokio::signal::ctrl_c()=>{}}
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            rooms.close();
        })
        .await?;
    shutdown_rooms.shutdown().await;
    Ok(())
}
