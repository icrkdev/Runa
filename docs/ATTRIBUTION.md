# Attribution

## Upstream project

RÚNA is a derivative of [Rustpad](https://github.com/ekzhang/rustpad) by
Eric Zhang (ekzhang), which is licensed under the MIT Licence.

RÚNA itself is licensed under Apache-2.0 (see `LICENSE`). MIT-licensed work
may be distributed as part of an Apache-2.0 work provided the original notice
is retained, and it is — reproduced in full in `NOTICE`, which also records
what the relicence does and does not change. Upstream Rustpad remains
available under its own MIT licence, unaffected by anything here.

- Derived from commit `54e4a9383c84d7317af42a7ddb177ce8bcba058d` (2025-02-02).
- What was taken: the single-binary Rust service skeleton, room registry /
  cleanup architecture, integration test structure, and the general product
  idea of a fast collaborative pad.
- What was changed: **the operational transform engine was removed and replaced
  with an encrypted CRDT relay.** The server no longer reads, transforms,
  merges, or stores document content; it relays opaque ciphertext blobs. An
  end-to-end encryption layer, authentication, consensus shredding, expiry, and
  a redesigned client were added.

RÚNA is *not* Rustpad with features bolted on. It is Rustpad's deployment
shape with the algorithm and security model replaced. Upstream deserves the
accurate description.

Upstream Rustpad remains available under its original MIT licence at the link
above. We are grateful for it.

## Key dependencies (client)

| Package | Licence | Role |
|---|---|---|
| yjs | MIT | CRDT document model |
| monaco-editor | MIT | Editor |
| react / react-dom | MIT | UI |
| hash-wasm | Apache-2.0 | Argon2id KDF (WASM, self-hosted) |
| cbor2 | MIT | Canonical CBOR encoding for signed shred payloads |
| pagedjs | MIT | Paged.js print preview (lazy-loaded) |
| hast-util-sanitize | MIT | Sanitiser core used via rehype-sanitize |
| unified / remark-* / rehype-* | MIT | Markdown pipeline |
| katex | MIT | Math rendering |
| highlight.js | BSD-3-Clause | Code highlighting |
| qrcode | MIT | Key handoff QR |

Licence inventory enforced by `cargo deny` (server) and `npm audit` (web)
in CI.

## Key dependencies (server)

Crates are inventoried by `cargo deny` (including licence scan) on every CI
run. No database driver of any kind is permitted; see `deny.toml`.
