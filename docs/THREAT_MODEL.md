# RÚNA Threat Model

This document defines exactly what RÚNA claims to defend against. Any
security claim elsewhere in the product or its marketing must be consistent
with it. Where a claim conflicts with this document, this document wins.

## Assets, ranked

1. **Document plaintext.** The only thing that truly matters.
2. **Content encryption key material.** Compromise equals asset 1.
3. **Room passphrase.** Reused passwords make this worse than it looks.
4. **Participation metadata.** Who connected, when, from where, for how long.
5. **Document existence and shape.** Length, edit cadence, peer count.

## Adversaries

| ID | Adversary | Capability assumed | In scope |
|---|---|---|---|
| A1 | Passive network observer | Reads all traffic, cannot break TLS | Yes |
| A2 | Honest-but-curious server operator | Full server RAM, disk, logs, process memory | Yes |
| A3 | Malicious server operator | A2 plus can modify relayed messages, forge peers, drop votes, and serve modified JS | Partially. See the honest limits below. |
| A4 | Hostile peer in the room | Has the key and the plaintext, wants to break others or persist the doc | Partially. See the honest limits below. |
| A5 | Off-path attacker with the room URL but not the passphrase | Online guessing only | Yes |
| A6 | Attacker with post-hoc access to the server host | Cold RAM, swap, core dumps, disk | Yes, best effort. See "Known limits" below. |
| A7 | Attacker with access to a peer's endpoint | Malware, screen capture, keylogger | **No.** Out of scope. |
| A8 | Global adversary doing traffic correlation | Timing and volume analysis across the network | **No.** Use Tor. |

## What RÚNA actually defends against

- **A1:** TLS plus a second, independent layer of AES-256-GCM. Even a full TLS
  compromise yields ciphertext.
- **A2:** The server holds ciphertext, a 32-byte auth verifier, and connection
  state. There is no key material to steal, because none is ever sent.
- **A5:** Argon2id at 64 MiB makes offline attack expensive, and there is no
  offline attack surface anyway because the verifier is a SHA-256 of a 256-bit
  random-equivalent value. Online guessing is rate-limited and locked out.
- **A6:** No disk persistence, `mlock` on secret buffers, core dumps disabled,
  `panic = "abort"`, and explicit zeroization on drop.

## The honest limit: a malicious server can serve you bad JavaScript

This is the unfixable weakness of every browser-delivered E2EE application,
including Signal's web clients, CryptPad, and every "encrypted pastebin" ever
shipped. If the server decides to serve a targeted user a modified bundle that
exfiltrates the key, the user's browser will run it, and no amount of clever
protocol design inside that bundle helps.

What can be done, and what RÚNA does:

- Zero third-party script origins. No CDN, no analytics, no hosted fonts.
- Strict CSP with `script-src 'self'` and Subresource Integrity on every asset.
- Trusted Types enforced, with the policy allow-list naming only `default` and
  the nine policies monaco-editor creates. **Honest limit:** the `default`
  policy's `createHTML` is a pass-through compatibility shim for Monaco's own
  DOM writes — it is not a sanitiser. The control that protects document
  content is `rehype-sanitize` in `web/src/render/pipeline.ts`. What the
  `default` policy does enforce is `createScriptURL`, which is restricted to
  same-origin URLs.
- Reproducible builds, with the SHA-256 of the release bundle published in the
  git tag and served at `/version`.
- Release artifacts signed with `cosign`.
- A self-host path that is one `docker run`, documented as the answer for
  anyone whose threat model includes the operator.

What must **not** be done: claim this problem is solved.

## The honest limit: nonce separation rests on 64 bits

Every peer in a room encrypts under the same AES-256-GCM key. The only thing
keeping two of them off the same nonce is the 12-byte `sess || counter`, of
which 8 bytes are random per session (a 4-byte session id and a 4-byte counter
prefix). Nonce reuse in GCM is not a degradation but a total break: the XOR of
the two plaintexts falls out and the authentication key leaks.

64 bits puts the birthday bound past 2^32 sessions, which is far beyond any
room's lifetime. It is not, however, the 96 bits a random-nonce scheme would
give, and it is worth knowing which number the guarantee rests on. Widening the
session id is a wire-format change and is deferred to a protocol revision.

The counter never restarts within a session — a client that rebuilt its cipher
mid-connection would replay nonces, which is why JOIN_ACK re-labels the sender
in place and is accepted only once per connection.

## The honest limit: consensus shred is not a confidentiality control

Any peer who can read the document already has the plaintext in their browser.
They can copy it, screenshot it, or leave a tab open. Shred removes the shared
live copy and destroys the keys. It does not and cannot reach into another
person's machine.

What consensus shred is actually good for:

- Preventing accidental or unilateral destruction of shared work.
- Making the server's copy provably unrecoverable, since it never had keys.
- Giving a group a clear, agreed, observable moment of "this is over."

The UI says this in plain words at the moment of first use, once — not in a
terms page nobody reads.

## Metadata the server unavoidably learns

| Leak | Why | Mitigation |
|---|---|---|
| Your IP address | It is a TCP connection | No IP logging, `X-Forwarded-For` stripped, Tor works fine |
| That a room exists and when | Routing | Unlisted room IDs are 128-bit and unguessable; identical responses for "wrong password" and "no such room". Named rooms give this up by construction. |
| Number of connected peers | Relay fan-out | Not hideable in a client-server relay |
| Approximate document size | Ciphertext length | Padding to 256-byte buckets |
| Edit cadence and typing rhythm | Frame timing | Update coalescing on an 80 ms timer; optional constant-rate mode closes the channel entirely at a bandwidth cost |
| Session duration | Connection lifetime | None |
| Room TTL | The server enforces it, so it must know it | None. It is a scheduling parameter, not a secret |
| A named room's name | It is the routing address | None, by construction. This is the entire trade; it is why named rooms are a separate class with a separate promise |

## Known limits stated plainly

`Vec`/`String` growth reallocates and leaves stale copies behind; the allocator
may not return pages promptly; a root-level attacker on the host reads process
memory regardless; JavaScript strings are immutable and cannot be individually
zeroized, which is why client wipe ends in realm destruction via hard
navigation. `zeroize` narrows a window; it does not close a door.
