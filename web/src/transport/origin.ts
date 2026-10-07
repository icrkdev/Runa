/// Whether this page may open a plain `ws://` socket.
///
/// Browsers refuse `ws://` from a public `http://` page, and the client
/// refuses it too, so that a deployment without TLS fails loudly instead of
/// sending the handshake in clear. Two kinds of origin are exempt:
///
/// - **Loopback**, which never leaves the machine.
/// - **An onion service.** Tor encrypts the whole path to the service and the
///   address *is* the service's public key, so `http://` over `.onion` is
///   already end-to-end encrypted and authenticated. Onion services commonly
///   serve plain HTTP for exactly this reason; Tor Browser treats them as
///   secure contexts.
export function plainWebSocketAllowed(loc: { protocol: string; hostname: string }): boolean {
  if (loc.protocol !== "http:") return false;
  const h = loc.hostname;
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]" ||
    h.endsWith(".localhost") ||
    /^[a-z2-7]{56}\.onion$/.test(h)
  );
}
