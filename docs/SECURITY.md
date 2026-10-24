# Security Policy

## Supported versions

Only the latest release tag receives security fixes. RÚNA moves fast precisely
because it stores nothing; pin and review what you deploy.

## Reporting a vulnerability

**Use [GitHub private vulnerability reporting](https://github.com/vardrlabs/Runa/security/advisories/new).**
It opens a private thread visible only to you and the maintainers, so nothing
is disclosed while it is being fixed, and there is no address for scrapers to
harvest.

If you would rather not use GitHub, `security@vardrlabs.com` reaches the same
people. It is a forwarding alias, not a personal inbox. The GitHub route is
preferred because it keeps the report, the fix and the advisory in one place.

- Please include reproduction steps, affected commit or bundle hash
  (`GET /version` prints both), and your assessment of severity.
- You will receive an acknowledgement within **72 hours** and a status update
  at least every **7 days** until resolution or public disclosure.
- Coordinated disclosure window: **90 days**, extendable by mutual agreement.
- Please do not open public issues for unpatched vulnerabilities.
- Safe-harbour: good-faith research against your own deployments is welcome;
  do not access other people's documents, do not run denial-of-service against
  hosted infrastructure, and respect rate limits.

## Scope notes

Read `docs/THREAT_MODEL.md` first — it defines exactly what RÚNA claims to
defend against. Findings outside that scope (endpoint malware, traffic
correlation, or a malicious operator serving modified JavaScript) are
documented limitations, not vulnerabilities, unless the documentation itself
is wrong.

The highest-value targets, in order:

1. The markdown render pipeline — any XSS there defeats E2EE.
2. The nonce/AEAD construction and its AAD binding.
3. Consensus tallying — anything that lets a server forge outcomes.
4. Anything that writes to disk (there must be nothing to find).

## Published advisories

Every vulnerability that reached a release is published as a GitHub security
advisory, with its affected and fixed versions. These five were found in the
maintainer's own review and fixed in 0.5.0; all affect 0.2.0-rc.3 through 0.4.0.

| Advisory | Flaw | Severity (CVSS 3.1) |
| --- | --- | --- |
| [GHSA-5w54-gxx9-7rh7](https://github.com/vardrlabs/Runa/security/advisories/GHSA-5w54-gxx9-7rh7) | Other websites could lock visitors out of their rooms | Medium, 4.3 |
| [GHSA-xgcx-rgxg-qvhm](https://github.com/vardrlabs/Runa/security/advisories/GHSA-xgcx-rgxg-qvhm) | One client could block every new join to a known room | Low, 3.7 |
| [GHSA-fh8j-4944-xvj9](https://github.com/vardrlabs/Runa/security/advisories/GHSA-fh8j-4944-xvj9) | A shredded room could stay readable to link holders | Low, 3.1 |
| [GHSA-6w2w-5f9x-j7r8](https://github.com/vardrlabs/Runa/security/advisories/GHSA-6w2w-5f9x-j7r8) | Any room member could cancel another member's shred vote | Low, 3.1 |
| [GHSA-gqrj-3v47-c9h2](https://github.com/vardrlabs/Runa/security/advisories/GHSA-gqrj-3v47-c9h2) | Passphrase rooms silently used PBKDF2 instead of Argon2id | Low, 2.2 |

The full list stays current at
[Security advisories](https://github.com/vardrlabs/Runa/security/advisories).

## Release integrity

Release artifacts are signed with [cosign](https://docs.sigstore.dev/) using
keyless Sigstore signing, so there is no long-lived public key to distribute or
protect. Every release publishes the artifact, its SHA-256, a signature, and the
short-lived signing certificate. Verify a download with:

```sh
cosign verify-blob \
  --signature   runa-<target>.tar.gz.sig \
  --certificate runa-<target>.tar.gz.pem \
  --certificate-identity-regexp '^https://github\.com/vardrlabs/Runa/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  runa-<target>.tar.gz
```

The bills of materials, `runa-server-sbom.json` and `runa-web-sbom.json`, are
signed the same way and verified with the same command:

```sh
cosign verify-blob \
  --signature   runa-server-sbom.json.sig \
  --certificate runa-server-sbom.json.pem \
  --certificate-identity-regexp '^https://github\.com/vardrlabs/Runa/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  runa-server-sbom.json
```

Releases up to and including v0.4.0 published the SBOMs unsigned, so one could
have been replaced on the release page with nothing to show it. The container image on GHCR is
signed too, for final releases; pre-release tags do not build an image.

The identity regexp is what actually matters: it proves the artifact was built
by this repository's tagged release workflow and not by someone who merely holds
a key. `GET /version` returns the running commit and bundle SHA-256 so you can
compare what you were served with what was audited.

The repository moved from `icrkdev/Runa` to `vardrlabs/Runa` on 2026-10-24, and
the signing identity moved with it. Releases from v0.5.3 on are signed as
`vardrlabs/Runa`, as in the commands above. Releases up to and including v0.5.2
were signed as `icrkdev/Runa` and verify only with that identity:

```sh
  --certificate-identity-regexp '^https://github\.com/icrkdev/Runa/\.github/workflows/release\.yml@refs/tags/v'
```

Their images stay at `ghcr.io/icrkdev/runa`; new images are published at
`ghcr.io/vardrlabs/runa`.

That proof is only as good as the code the workflow runs, so every third-party
action in it is pinned to a full commit SHA rather than a tag. A tag can be
moved by whoever controls the action's repository; a commit cannot.
