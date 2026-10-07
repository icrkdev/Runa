export function MissingKey() {
  return (
    <main className="landing">
      <h1 className="mono">RÚNA</h1>
      <p className="micro-label tag">THIS LINK IS MISSING ITS KEY</p>
      <div className="panel">
        <p>
          If you refreshed a <strong>highest-security</strong> room, this is on purpose: those
          rooms keep their key only in the open tab, so nothing on this device remembers it.
          Paste the full link into <a href="/">Join a room</a> to go back in.
        </p>
        <p>
          Otherwise, ask whoever shared this room for the full link. The part after the{" "}
          <code className="mono">#</code> is the key — chat apps and link unfurlers
          sometimes strip it, and retyping the address loses it entirely.
        </p>
        <p style={{ marginBottom: 0 }}>
          <a href="/">← Join a room, or start a new one</a>
        </p>
      </div>
    </main>
  );
}
