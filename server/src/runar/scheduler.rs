use std::sync::Arc;
use std::time::Duration;

use crate::runar::room::RoomRegistry;
use crate::surtr;

/// The single scheduler that ends rooms. Drain grace, idle TTL, absolute TTL,
/// and the idle ceiling all flow through this one sweep into surtr's one
/// purge path — there is no other code that can retire a room.
pub async fn run_scheduler(
    registry: Arc<RoomRegistry>,
    drain_grace: Duration,
    idle_ceiling: Duration,
) {
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        for (room, reason) in registry.sweep_candidates(drain_grace, idle_ceiling) {
            if surtr::purge(&registry, &room.id, reason).await {
                tracing::info!(reason = reason, "scheduled purge executed");
            }
        }
    }
}
