import { useState } from "react";
import { Api, randomRoomIdHex, type TtlBody } from "../api";
import {
  deriveRoomKeys,
  encryptRoomConfig,
  fragmentWithKey,
  passphraseMaterial,
  randomLinkSecret,
  randomSalt,
  verifierForAuthKey,
} from "../keys-session";
import { generateDicewarePassphrase, generateRoomName } from "../crypto/fingerprint";
import { estimatePassphrase } from "../crypto/passphrase";

type Class = "unlisted" | "named";

const TTL_PRESETS: { label: string; value: TtlBody }[] = [
  { label: "30 min after last activity", value: { kind: "idle-peers", secs: 1800 } },
  { label: "1 hour after last activity", value: { kind: "idle-peers", secs: 3600 } },
  { label: "8 hours after last activity", value: { kind: "idle-peers", secs: 28_800 } },
  { label: "24 hours from creation", value: { kind: "absolute", secs: 86_400 } },
];

export function Landing() {
  const [cls, setCls] = useState<Class>("unlisted");
  return (
    <main className="landing">
      <h1 className="mono">RÚNA</h1>
      <p className="micro-label tag">ENCRYPTED IN YOUR BROWSER · THE SERVER STORES CIPHERTEXT</p>

      <div className="panel" role="radiogroup" aria-label="Room class">
        <label className="row" style={{ justifyContent: "space-between" }}>
          <span>
            <strong>UNLISTED</strong>
            <div className="hint">Nobody can find this room. The link contains the key.</div>
          </span>
          <input type="radio" name="cls" checked={cls === "unlisted"} onChange={() => setCls("unlisted")} />
        </label>
        <hr style={{ border: "none", borderTop: "1px solid var(--hairline)", margin: "12px 0" }} />
        <label className="row" style={{ justifyContent: "space-between" }}>
          <span>
            <strong>NAMED</strong>
            <div className="hint">
              Anyone can find this room by name. The passphrase is the key.
              A passphrase is mandatory.
            </div>
          </span>
          <input type="radio" name="cls" checked={cls === "named"} onChange={() => setCls("named")} />
        </label>
      </div>

      {cls === "unlisted" ? <UnlistedForm /> : <NamedForm />}
    </main>
  );
}

function ExpiryPicker({ onChange }: { onChange: (ttl: TtlBody) => void }) {
  return (
    <div className="field">
      <label className="micro-label" htmlFor="expiry">EXPIRY</label>
      <select id="expiry" defaultValue={JSON.stringify(TTL_PRESETS[1].value)} onChange={(e) => {
        const v = JSON.parse(e.target.value) as TtlBody;
        onChange(v);
      }}>
        {TTL_PRESETS.map((p) => (
          <option key={p.label} value={JSON.stringify(p.value)}>{p.label}</option>
        ))}
        <option value={JSON.stringify({ kind: "none", secs: 0 })}>
          No expiry — dies when everyone leaves, you shred it, or the server restarts
        </option>
      </select>
    </div>
  );
}

function UnlistedForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ttl, setTtl] = useState<TtlBody>(TTL_PRESETS[1].value);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const roomIdHex = randomRoomIdHex();
      const salt = randomSalt();
      const linkSecret = randomLinkSecret();
      const { authKey, contentKey } = await deriveRoomKeys(null, linkSecret, salt);
      const verifierB64 = await verifierForAuthKey(authKey);
      await new Api("").createUnlisted({
        roomIdHex,
        verifierB64,
        kdf: { m_kib: 65536, t: 3, p: 1, salt: b64Of(salt) },
        ttl,
        ceilingOptout: ttl.kind === "none",
        configBlob: await encryptRoomConfig(contentKey, ttl, ttl.kind === "none"),
      });
      window.location.assign(`/r/${roomIdHex}${fragmentWithKey(linkSecret, salt)}`);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <ExpiryPicker onChange={setTtl} />
      <button onClick={create} disabled={busy}>{busy ? "Creating…" : "Create unlisted room"}</button>
      {error && <p className="error-text mono">{error}</p>}
      <p className="hint" style={{ marginTop: 14 }}>
        The part of the link after the # is the key. Send the whole thing.
      </p>
    </div>
  );
}

function NamedForm() {
  const [name, setName] = useState(generateRoomName(true));
  const [passphrase, setPassphrase] = useState("");
  const [suffixOn, setSuffixOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [ttl, setTtl] = useState<TtlBody>(TTL_PRESETS[1].value);

  const verdict = passphrase ? estimatePassphrase(passphrase) : null;
  const [degraded, setDegraded] = useState(false);

  const create = async () => {
    setError(null);
    setRefusal(null);
    const v = estimatePassphrase(passphrase);
    if (!v.dicewareWords || !v.ok) {
      setRefusal(
        "This room's name is public, so the passphrase is the only key protecting it. Use the Generate button to produce a four-word passphrase.",
      );
      return;
    }
    setBusy(true);
    try {
      const finalName = suffixOn ? name : name.replace(/-[0-9a-f]{4}$/, "");
      const salt = randomSalt();
      const kdfResult = await passphraseMaterial(passphrase, salt);
      setDegraded(kdfResult.degraded);
      const material = kdfResult.material;
      if (!material) throw new Error("no material");
      const { authKey, contentKey } = await deriveRoomKeys(material, null, salt);
      const verifierB64 = await verifierForAuthKey(authKey);
      await new Api("").createNamed({
        name: finalName,
        suffix: false,
        verifierB64,
        kdf: { m_kib: 65536, t: 3, p: 1, salt: b64Of(salt) },
        ttl,
        ceilingOptout: ttl.kind === "none",
        configBlob: await encryptRoomConfig(contentKey, ttl, ttl.kind === "none"),
      });
      window.location.assign(`/n/${finalName}`);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="field">
        <label className="micro-label" htmlFor="room-name">ROOM NAME</label>
        <div className="row">
          <input
            id="room-name"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
          />
          <button type="button" onClick={() => setName(generateRoomName(suffixOn))}>↻</button>
        </div>
        <p className="hint">Two words speak better than a string of characters.</p>
      </div>
      <label className="row field">
        <input
          type="checkbox"
          checked={suffixOn}
          onChange={(e) => {
            setSuffixOn(e.target.checked);
            setName(generateRoomName(e.target.checked));
          }}
        />
        <span className="hint">
          Disambiguating suffix. Dropping the suffix makes this name easier to guess.
          The passphrase still protects the contents.
        </span>
      </label>
      <div className="field">
        <label className="micro-label" htmlFor="passphrase">PASSPHRASE</label>
        <div className="row">
          <input
            id="passphrase"
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <button type="button" onClick={() => setPassphrase(generateDicewarePassphrase(4))}>Generate</button>
        </div>
        {verdict && !verdict.ok && (
          <p className="error-text mono">Short passphrase. This room is only as strong as it is.</p>
        )}
        {verdict?.ok && (
          <p className="hint mono">{verdict.dicewareWords > 0 ? `${verdict.dicewareWords} diceware words · ~${verdict.bits} bits` : `~${verdict.bits} bits`}</p>
        )}
      </div>
      {degraded && (
        <div className="banner" role="alert">
          <span className="error-text mono">Argon2 unavailable. Using a weaker key derivation.</span>
        </div>
      )}
      <ExpiryPicker onChange={setTtl} />
      <button onClick={create} disabled={busy}>{busy ? "Creating…" : "Create named room"}</button>
      {refusal && <p className="error-text mono" role="alert">{refusal}</p>}
      {error && <p className="error-text mono">{error}</p>}
    </div>
  );
}

function describeError(e: unknown): string {
  const code = e instanceof Error ? e.message : String(e);
  switch (code) {
    case "NAME_TAKEN":
    case "UNAVAILABLE":
      return "That name is in use by a room this passphrase does not open.";
    case "NAME_INVALID":
      return "That name is reserved or too short. Try another.";
    case "RATE_LIMITED":
      return "Too many attempts. Wait a minute and try again.";
    default:
      return `Could not create the room (${code}).`;
  }
}

function b64Of(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
