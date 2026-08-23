export function MissingKey() {
  return (
    <main className="landing">
      <h1 className="mono">RÚNA</h1>
      <p className="micro-label tag">THIS LINK IS MISSING ITS KEY</p>
      <div className="panel">
        <p>
          Ask whoever shared this room for the full link. The part after the{" "}
          <code className="mono">#</code> is the key — chat apps and link unfurlers
          sometimes strip it, and retyping the address loses it entirely.
        </p>
        <p style={{ marginBottom: 0 }}>
          <a href="/">← New room</a>
        </p>
      </div>
    </main>
  );
}
