# Contributing to RÚNA

Thanks for looking. This document is short because most of what matters is
enforced by `scripts/verify.sh` rather than by convention.

## Do not report vulnerabilities here

Use [private vulnerability
reporting](https://github.com/icrkdev/Runa/security/advisories/new). A public
issue on an unpatched flaw exposes every running instance while the fix is
written. See [`docs/SECURITY.md`](docs/SECURITY.md) for scope and safe-harbour.

## Getting set up

You need Rust (the toolchain is pinned in `rust-toolchain.toml`), Node 22 or
later, and a C toolchain — `rustc` shells out to `cc` for the final link, and
minimal Linux images ship without one.

```sh
git clone https://github.com/icrkdev/Runa.git && cd Runa
bash scripts/verify.sh
```

That must print `VERIFIED` before you change anything. If it does not, the
problem is your environment and not your patch, and it is much easier to
diagnose now.

To run it locally:

```sh
cd web && npm ci && npm run build && cd ..
cargo run --release -p runa-server   # then open http://127.0.0.1:3000
```

## The one command that gates a pull request

```sh
bash scripts/verify.sh
```

It runs the server tests, clippy at `-D warnings`, the web suite, a type check,
the production build, a wire-level smoke test that asserts a known string never
appears in captured traffic, and a two-peer headless browser run under the real
CSP. All of it must pass.

The browser run is not optional theatre. Unit tests cannot see Content Security
Policy or Trusted Types, and that run has already caught a policy allow-list
that silently disabled the editor.

## Constraints that are not negotiable

These are the product, not preferences. A patch that breaks one is wrong even
if it is otherwise good.

- **Nothing touches disk.** No database, no cache, no log of document content.
  CI greps the server source for `File::create`, `fs::write` and friends.
- **No third-party origins.** `check-origins.mjs` fails the build if shipped
  HTML references anything off-origin. Fonts and libraries are bundled. This is
  why there is no CDN and no webfont host.
- **The server never sees plaintext.** It relays opaque ciphertext. If a change
  requires the server to understand document content, it is the wrong change.
- **No `Math.random` anywhere.** Use `crypto.getRandomValues`. Enforced by
  eslint, deliberately without exceptions — an exception costs every future
  reader a judgement call.
- **Resource ceilings stay closed-form.** Rooms live in RAM. Anything that can
  grow without a documented bound is a denial-of-service waiting to happen; see
  the arithmetic in the README.

## What makes a good pull request

**Say what breaks if you are wrong.** The commit message is where the next
person learns why the code is shaped this way. Prefer explaining the failure
mode over describing the diff — the diff is already visible.

**Bring a test that fails without your change.** Then check that it does, by
reverting your fix and watching it go red. A test that passes both before and
after is worse than no test, because it looks like coverage.

**Be honest about what you could not verify.** "This is unproven on ARM" is
useful. Silence about it is not. Several of the more interesting bugs in this
project's history were found because somebody wrote down what they had *not*
checked.

**Small and focused beats large and thorough.** If a change has two reasons to
exist, it wants to be two pull requests.

## How this project is built

RÚNA is written by a human working with AI assistance — see the note at the top
of the README. Contributions written the same way are welcome, on exactly the
same terms as any other: you are responsible for understanding what you submit,
you have tested it, and you can explain why it is correct. Nobody reviewing a
pull request cares which tools produced it; they care whether the author can
answer questions about it.

## Licence

Contributions are accepted under [Apache-2.0](LICENSE), the licence of the
project. Note section 4(b): if you modify existing files, they must carry
notice that they were changed. For a security tool this matters more than the
formality suggests — a build with the cryptography altered can look entirely
plausible.
