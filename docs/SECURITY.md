# Security Policy

## Supported versions

Only the latest release tag receives security fixes. RÚNA moves fast precisely
because it stores nothing; pin and review what you deploy.

## Reporting a vulnerability

Email: **security@vardrlabs.com**

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

## Release integrity

Release artifacts are signed with [cosign](https://docs.sigstore.dev/) using
keyless Sigstore signing, so there is no long-lived public key to distribute or
protect. Every release publishes the artifact, its SHA-256, a signature, and the
short-lived signing certificate. Verify a download with:

```sh
cosign verify-blob \
  --signature   runa-<target>.tar.gz.sig \
  --certificate runa-<target>.tar.gz.pem \
  --certificate-identity-regexp '^https://github\.com/icrkdev/Runa/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  runa-<target>.tar.gz
```

The identity regexp is what actually matters: it proves the artifact was built
by this repository's tagged release workflow and not by someone who merely holds
a key. `GET /version` returns the running commit and bundle SHA-256 so you can
compare what you were served with what was audited.
