/// How a room's key is treated on its members' devices (see `keyhandoff.ts`).
/// Chosen by whoever creates the room and sealed in its encrypted config, so
/// every member gets the same treatment and the server cannot tell which
/// rooms asked for which. A config without it — every room made before it
/// existed — reads as "everyday", which is what those rooms always did.
export type SecurityLevel = "everyday" | "highest";

export function parseSecurityLevel(v: unknown): SecurityLevel {
  return v === "highest" ? "highest" : "everyday";
}

/// The level a member applies, given what came of opening the room's sealed
/// config. Only an opened config can relax it: a missing or unreadable one is
/// treated as the strictest level, so a server that strips the config cannot
/// have a highest-security room's key kept in the tab.
export function securityLevelOf(config: { level: SecurityLevel } | null | undefined): SecurityLevel {
  return config ? config.level : "highest";
}
