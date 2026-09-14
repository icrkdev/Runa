# RÚNA Wire Protocol v1

Normative reference for the frame format, handshake, and relay semantics.
Normative reference for implementers. Five documented amendments appear at
the bottom — additions the original design required implicitly but did not
enumerate in its frame-type table.

## Transport rules

- WSS 1.3 only. Plain `ws://` refused unless `RUNA_ALLOW_INSECURE=1`, which
  also forces a permanent red banner in the UI.
- Binary frames only for document traffic. Control-plane bodies (JOIN,
  JOIN_ACK, PEER_JOIN/LEAVE, PURGE_ACK, ERROR) are UTF-8 JSON. Document
  payloads are ciphertext blobs; shred payloads are canonical CBOR *inside*
  AES-256-GCM.
- Limits: frame ≤ 1 MiB · room log ≤ 32 MiB · peers per room ≤ 32.
  Configurable downward only.

## Frame layout

```
 offset size  field           notes
 ------ ----  --------------  --------------------------------------------
 0      2     magic           0x52 0x55 ("RU")
 2      1     version         0x01
 3      1     frame_type      see table
 4      16    room_id         128-bit internal id
 20     4     epoch           u32 BE, rekey generation (field ships now; rekey is v1.1)
 24     4     nonce_sess      first 4 bytes of this connection's nonce session id
 28     4     flags           bit0 padded, bit1 compressed, rest reserved 0
 --- body: see per-type table
```

The 32-byte header is authenticated as AAD for every encrypted frame, together
with `"runa/v1" || room_id || frame_type || sender_peer_id || counter`.

Encrypted body = `counter` (8 B BE) `||` AES-256-GCM output `||` tag (16 B).

## Frame types

| Value | Name | Dir | Body |
|---|---|---|---|
| 0x01 | JOIN | C→S | JSON `{auth_key_b64? (32 B), session_pubkey_b64 (32 B), client_version, acks?}` |
| 0x02 | JOIN_ACK | S→C | JSON `{peer_id, epoch, log_len, base_index, has_snapshot, ttl, elapsed_secs, ceiling_optout, kdf:{alg,m,t,p,salt_b64}, config_blob?, roster:[{peer_id,pubkey_b64,joined_at_seq}], acks?, limits?:{max_frame_bytes,frames_per_sec,bytes_per_sec}}` — amendment E |
| 0x03 | DOC_UPDATE | both | encrypted Yjs update, or one part of a split one — amendment E |
| 0x04 | DOC_SYNC_REQ | C→S | JSON `{from_index}` (index form; state vectors leak clocks and are not used) |
| 0x05 | DOC_SYNC_RESP | S→C | one or more encrypted entries: snapshot blob then tail |
| 0x06 | AWARENESS | both | encrypted y-protocols awareness update |
| 0x07 | PEER_JOIN | S→C | JSON `{peer_id, pubkey_b64, joined_at_seq}` |
| 0x08 | PEER_LEAVE | S→C | JSON `{peer_id, reason}` |
| 0x09 | **DOC_ACK** | S→C | JSON `{ok, index?}`, to the sender of each DOC_UPDATE, only if its JOIN asked — amendment E |
| 0x10 | SHRED_REQUEST / SHRED_VOTE / SHRED_CANCEL (0x11, 0x12) | both | encrypted canonical-CBOR payload + Ed25519 signature over CBOR. No count fields exist anywhere. |
| 0x13 | PURGE | S→C | JSON `{reason}` tombstone signal |
| 0x14 | **PURGE_ACK** | C→S | JSON `{request_id}` — amendment A, below |
| 0x20 | EPOCH_KEY | both | encrypted wrapped epoch secret (v1.1 consumer) |
| 0x22 | **TTL_EXTEND** | both | JSON `{add_secs}` C→S; server broadcasts `{added_by, add_secs, effective_secs, kind}` — amendment D |
| 0x21 | **SNAPSHOT** | C→S | header ‖ `covers_up_to_index` u64 BE (8 B plaintext) ‖ encrypted blob — amendment B, below |
| 0x30 | ERROR | S→C | JSON `{code}` |

Error codes: 4001 AUTH_FAILED · 4002 RATE_LIMITED · 4003 ROOM_FULL ·
4004 FRAME_TOO_LARGE · 4005 PROTOCOL_ERROR · 4006 EPOCH_STALE ·
4010 PURGED · 4011 EXPIRED · 4012 NAME_TAKEN · 4013 NAME_INVALID.

**Join failures are deliberately indistinguishable.** A bad key, an unknown
room id, a room mid-purge, and a room that has exhausted its auth attempts all
answer 4001 after the same floor delay. Returning 4002 for the throttled case
made "does this room exist" a five-guess question. Unlisted room ids are
assigned by the server for the same reason: a creation endpoint that answered
409 for a live id and 201 for an unused one is the same oracle by another
route.

Wrong passphrase and missing room are deliberately the same code (4001) with
identical timing (250 ms floor on the auth path).

**JOIN_ACK's expiry fields.** For an absolute expiry, `ttl.secs` is the time
*remaining*, and `elapsed_secs` is the room's age by the server's clock. It is
sent rather than computed by the client, so a difference between the two clocks
cannot look like tampering. `config_blob` is the room's AEAD-protected config,
holding the expiry the creator chose. The client compares `ttl.secs +
elapsed_secs` with that duration and, if the server claims less, shows a
mismatch warning and uses the sealed value. This catches a server that
contradicts itself, not one that lies about both fields; see the threat model's
known limits.

## Server semantics per frame

- The server parses **only** the 32-byte header (plus SNAPSHOT's 8-byte index).
  It never reads past that boundary. Any function that inspects payload bytes is
  a design violation.
- DOC_UPDATE: append to room log (cap enforced), fan out to other peers, and
  acknowledge to the sender if it asked (amendment E).
- DOC_SYNC_REQ `{from_index}`: if `from_index <= base_index` send latest
  snapshot (if any) followed by the full tail; else send tail from
  `from_index`. Responses are re-framed as encrypted blobs relayed verbatim
  from stored log bytes — the server cannot decrypt or merge them.
- SNAPSHOT: record `covers_up_to_index`, drop log entries it supersedes,
  store the opaque snapshot bytes as the room's current snapshot. It verifies
  nothing and understands nothing.
- SHRED_*: relay verbatim to other peers (sender excluded). Count nothing,
  decide nothing.
- PURGE_ACK: mark requester as acked for `{request_id}`; when every currently
  connected socket has acked the same id, execute surtr purge. An ack counts
  only while the peer that sent it is still connected, and the ledger is
  bounded (16 request ids, 128-byte ids, 5-minute expiry) — otherwise a peer
  could bank approvals from throwaway sockets, drop them to shrink the
  denominator, and purge a room the remaining occupants never voted on. There
  is no
  timeout path: an unacknowledged request leaves the room intact.

## Amendments to the master spec's table (documented honestly)

**A · PURGE_ACK (0x14).** Spec §5.6 step 9 has clients acknowledge a shred so
the server can destroy its own copy, but no such frame type exists in §5.2,
and an encrypted ack could not be counted by a blind relay. Added 0x14 as an
unencrypted one-field frame. The server purges only when every currently
connected peer has acked the same `request_id`; there is no timeout, so an
unacknowledged request leaves the room intact. Acks are unauthenticated,
which is acceptable because the quorum — not the individual ack — is the
control, and the server holds no keys either way.

**B · SNAPSHOT (0x21) with plaintext index extension.** Late joiners need a
compacted history, which requires the server to truncate at an index it
cannot read from ciphertext, so the index must travel outside it. Added 0x21 whose body begins
with an 8-byte big-endian `covers_up_to_index` before the ciphertext; these 8
bytes are included in the AAD, so tampering breaks authentication and clients
reject the frame. The server learns one integer it already needed; nothing else.

**C · Sender envelope on relayed frames (S→C).** The AAD construction binds
`senderPeerId`, but the 32-byte header has no sender field, and the
receiver needs it to rebuild the AEAD. When the server fans out a C-originated
encrypted frame it emits `original_header(32 B) || sender_peer_id(16 B) ||
original_body`. These 16 bytes are written by the server, never inspected by
it, and are consumed by receivers as an AAD input. Sync responses reuse the
stored entry's original frame type; frame type 0x05 therefore stays reserved.
Server-authored event frames (JOIN_ACK, PEER_JOIN, PEER_LEAVE, PURGE, ERROR,
TTL_EXTEND, DOC_ACK) are **never enveloped** — receivers read their JSON directly from
the body; only relayed peer ciphertext carries the sender envelope. These
frames also carry epoch 0 by construction, so receivers must exempt them from
the epoch-staleness check. Both invariants are pinned by tests in
`server/tests/hardening.rs`.

**D · TTL_EXTEND (0x22).** Any single peer may extend the room's timer
(shortening still requires shred quorum), but no frame existed for it. Extension pushes the room's effective deadline
out monotonically (never shortens); the server clamps each addition to ≤720 h
**and the accumulated extension to ≤720 h in total**, so replaying the frame
cannot pin a room in memory indefinitely. The broadcast carries both
`effective_secs` (the room's total configured lifetime) and `remaining_secs`
(what is actually left, measured by the server). Clients re-anchor on
`remaining_secs`: `add_secs` is a request, not a result, and a client that
added its own request locally would drift past the real deadline once the
clamp engaged. The clear-text form is acceptable because TTL is public
scheduling information by design — the server must know it to enforce it.

**E · DOC_ACK (0x09), resending, and split updates.** DOC_UPDATE was
fire-and-forget, so a client could not tell an update the server stored from
one written into a connection that had already died — which a browser goes on
reporting as open until TCP gives up, often for minutes. Edits typed in that
window were lost, and nothing noticed.

- A client that sends `acks: true` in JOIN receives one DOC_ACK per DOC_UPDATE
  it sends, in the order sent: `{ok: true, index}` once the frame is in the
  log, `{ok: false}` when the log refused it. Its JOIN_ACK carries `acks: true`
  and `limits: {max_frame_bytes, frames_per_sec, bytes_per_sec}`. A client that
  does not ask sees neither field and never receives 0x09.
- The client keeps each update until it is acknowledged and resends whatever
  is outstanding on its next connection, paced under half of `limits`. An
  update unacknowledged for ten seconds means the connection is dead, and the
  client abandons it without waiting for the browser to agree. Yjs discards
  what it already holds, so resending something that did arrive costs log
  space and nothing else.
- No encrypted frame is sent before JOIN_ACK. Until then the client does not
  know the peer id that receivers bind into the AAD, so anything it sent would
  be rejected by every peer while the server stored it regardless.
- An update that does not fit in `max_frame_bytes` is sent as parts, each its
  own DOC_UPDATE. A part's plaintext is `u32 0xFFFFFFFF` ‖ 8-byte random
  message id ‖ `index` u16 ‖ `total` u16 ‖ data length u32 ‖ data ‖ zero
  padding to a 256-byte bucket. The marker is larger than any real length
  prefix, so a client that predates parts drops one as corrupt rather than
  applying half an update. Receivers apply the update once every part has
  arrived, and do not take a snapshot while any message is incomplete.

The server writes DOC_ACK straight to the sender's socket rather than through
its outbound queue, so a queue full of log replay cannot cost a client its
acks. An ack is not authenticated: a hostile server can acknowledge an update
and then discard it. That is no new power — it holds the log and can drop
anything — and it is the same exposure every relayed frame already has.

All amendments keep the invariant that matters: the server never learns
anything about document content.
