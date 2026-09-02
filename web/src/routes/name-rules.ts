/// The server's name rules, restated for people rather than for a parser.
/// Kept deliberately in step with server/src/runar/names.rs — the server is
/// still the authority, this exists so nobody has to submit a form to find
/// out their name was never going to work.

export const RESERVED = new Set([
  "admin", "administrator", "api", "app", "assets", "auth", "blog", "config",
  "contact", "dashboard", "dev", "docs", "gone", "help", "index", "info",
  "login", "logout", "me", "moderator", "new", "news", "nobody", "null",
  "root", "security", "settings", "signup", "socket", "status", "support",
  "system", "test", "undefined", "user", "users", "version", "www", "runa",
  "runar", "vardr", "heimdall", "bifrost", "surtr", "gjallarhorn",
  "ginnungagap",
]);

export const MIN_NAME_LEN = 3;
export const MAX_NAME_LEN = 64;

/// null when the name is fine; otherwise a sentence you can show someone.
export function nameProblem(raw: string): string | null {
  const n = raw.trim().toLowerCase();
  if (!n) return "Give the room a name.";
  if (n.length < MIN_NAME_LEN) return "A bit longer — at least three characters.";
  if (n.length > MAX_NAME_LEN) return "That is too long for a web address. Keep it under 64 characters.";
  if (!/^[a-z0-9-]+$/.test(n)) {
    return "Letters, numbers and hyphens only — no spaces, dots or accents, because this becomes the web address.";
  }
  if (!/^[a-z0-9]/.test(n) || !/[a-z0-9]$/.test(n)) {
    return "Start and end with a letter or number, not a hyphen.";
  }
  if (RESERVED.has(n)) {
    return `“${n}” is reserved — the site already uses that address for something else. Try adding a second word.`;
  }
  if (!n.includes("-") && !/[0-9]/.test(n)) {
    return "Use two words joined by a hyphen, like copper-lantern. Single words are too easy for a stranger to guess.";
  }
  return null;
}
