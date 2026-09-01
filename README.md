# RÚNA

<p align="center">
  <strong>Ephemeral end-to-end encrypted collaborative markdown.</strong><br>
  The server cannot read what you write. The document lives only in RAM.<br>
  Any participant can burn it to nothing on demand.
</p>

---

## Table of contents

- [What is RÚNA?](#what-is-rúna)
- [How it works (in plain English)](#how-it-works-in-plain-english)
- [What you need before you start](#what-you-need-before-you-start)
  - [Install Rust](#1-install-rust)
  - [Install Node.js](#2-install-nodejs)
  - [Verify everything works](#3-verify-everything-works)
- [Getting the code](#getting-the-code)
- [Running RÚNA on your computer](#running-rúna-on-your-computer)
  - [Start the server](#step-1-start-the-server)
  - [Start the web app](#step-2-start-the-web-app)
  - [Open it in your browser](#step-3-open-it-in-your-browser)
- [Using RÚNA](#using-rúna)
  - [Creating a room](#creating-a-room)
  - [Sharing a room](#sharing-a-room)
  - [Editing together](#editing-together)
  - [Shredding a room](#shredding-a-room)
- [Running the tests](#running-the-tests)
- [Deploying to the internet](#deploying-to-the-internet)
  - [Docker (recommended)](#docker-recommended)
  - [Behind a reverse proxy](#behind-a-reverse-proxy)
- [Troubleshooting](#troubleshooting)
- [Security: what this does and does not protect you from](#security-what-this-does-and-does-not-protect-you-from)
- [Project structure](#project-structure)
- [Licence and attribution](#licence-and-attribution)

---

## What is RÚNA?

RÚNA is a shared notepad that you run on your own computer or server. Multiple
people can open the same document in their web browsers and type at the same
time, like Google Docs.

The difference is **privacy**. When you type into Google Docs, Google's servers
read every character. With RÚNA, your text is **encrypted inside your browser**
before it ever leaves your computer. The server that passes messages between
users sees only scrambled ciphertext — it mathematically cannot read what you
wrote.

When everyone is done, anyone can press **Shred**. This destroys the encryption
keys and wipes the server's copy. The document is gone — permanently, by design.

Think of it like passing locked envelopes between friends. The postal worker
(the server) delivers them but cannot open them. When you're done, everyone
burns their envelopes and throws away their keys.

## How it works (in plain English)

```
   Your browser                  Server                  Friend's browser
┌───────────────┐              ┌───────────────┐              ┌───────────────┐
│ You type      │              │ Stores        │              │ They see      │
│ "hello"       ├──encrypted──►│ scrambled     ├──encrypted──►│ "hello"       │
│               │    bytes     │ bytes         │    bytes     │               │
│ Has the key   │              │ Has NO key    │              │ Has the key   │
└───────────────┘              └───────────────┘              └───────────────┘
```

- Your browser encrypts every keystroke using a key derived from the room's
  secret link (or passphrase). The key **never leaves your browser**.
- The server receives encrypted bytes and forwards them to other people in the
  same room. It cannot decrypt them because it never had the key.
- Everyone in the room has the same key because they all opened the same
  secret link. Their browsers decrypt the messages and show the text.

For a detailed technical explanation of exactly how the cryptography works,
see [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and
[docs/PROTOCOL.md](docs/PROTOCOL.md).

---

## What you need before you start

You need three things installed on your computer:

| Tool | What it does | Version needed |
|---|---|---|
| [Rust](https://rustup.rs) | Compiles the server program | 1.70 or newer |
| [Node.js](https://nodejs.org) | Runs the build tools for the web interface | 18 or newer |
| A web browser | To use the app | Chrome, Firefox, Safari, or Edge |

If you already have these installed, skip ahead to [Getting the code](#getting-the-code).
Otherwise, follow the steps below for your operating system.

### 1. Install Rust

#### macOS

Open **Terminal** (find it in Applications → Utilities → Terminal) and paste:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Press `1` (or Enter) when asked which installation option you want. Wait for it
to finish, then close and reopen Terminal so the changes take effect.

Verify it worked:

```sh
rustc --version
```

You should see something like `rustc 1.75.0` (the exact number doesn't matter,
as long as it's 1.70 or higher).

#### Linux (Ubuntu / Debian)

Open a terminal (`Ctrl+Alt+T` on most distributions) and paste:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

Verify:

```sh
rustc --version
```

#### Linux (Fedora / RHEL)

```sh
sudo dnf install rust cargo
```

#### Windows

1. Go to [https://rustup.rs](https://rustup.rs)
2. Download and run `rustup-init.exe`
3. Press `1` (or Enter) when prompted
4. You may also need to install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) — the installer will tell you if so
5. Close and reopen Command Prompt or PowerShell

Verify in your new terminal window:

```powershell
rustc --version
```

### 2. Install Node.js

Go to [https://nodejs.org](https://nodejs.org) and download the **LTS** version
(the big green button). Run the installer with default settings.

Verify it worked by opening a new terminal window:

```sh
node --version
npm --version
```

You should see something like `v20.11.0` and `10.2.0`. As long as both commands
print a version number, you're good.

> **Windows note:** After installing Node.js, you may need to restart your
> computer before `node` is recognised in Command Prompt.

### 3. Verify everything works

Run these two commands one at a time. If both print version numbers without
errors, you're ready to continue.

```sh
rustc --version && cargo --version
node --version && npm --version
```

<details>
<summary>If something went wrong…</summary>

**"command not found" error:** The tool was installed but your terminal doesn't
know where to find it. Close ALL terminal windows and open a fresh one. On
Linux/macOS, also try running `source ~/.zshrc` or `source ~/.bashrc`.

**Rust says "linker not found":** On macOS, install Xcode command-line tools:
```sh
xcode-select --install
```
On Windows, install Visual Studio Build Tools from the link above.
On Linux, install the build essentials:
```sh
sudo apt install build-essential pkg-config libssl-dev
```
</details>

---

## Getting the code

### Option A: Using git (recommended if you plan to make changes)

```sh
git clone https://github.com/YOUR_USERNAME/Runa.git
cd Runa
```

(Replace `YOUR_USERNAME` with your GitHub username after you fork the repo.)

### Option B: Download as ZIP (no git required)

1. Go to the repository page on GitHub
2. Click the green **Code** button → **Download ZIP**
3. Unzip the file somewhere you can find it (like your Desktop)
4. Open a terminal and navigate into the folder:

```sh
cd ~/Desktop/Runa-main     # macOS / Linux
cd Desktop\Runa-main       # Windows PowerShell
```

---

## Running RÚNA on your computer

There are two programs to start: a **server** (Rust) and a **web app**
(Node.js). You need both running at the same time, each in its own terminal
window or tab.

### Step 1: Start the server

Open a terminal in the project folder and run:

```sh
cargo run --release -p runa-server
```

The first time you do this it will take **several minutes** because Rust needs
to compile every dependency from source. Subsequent starts will be much faster
(just a few seconds).

When it's ready you'll see:

```
INFO runa_server: runa server listening addr=127.0.0.1:3000
```

**Leave this terminal open and running.** If you close it, the server stops.

<details>
<summary>What just happened?</summary>
Cargo downloaded ~200 Rust packages (called "crates"), compiled them along
with the RÚNA server code, optimised everything for release, and produced an
executable binary at <code>target/release/runa-server</code>. It then ran that
binary, which started listening for connections on port 3000.
</details>

### Step 2: Start the web app

Open a **second** terminal window (don't close the first one!) and run:

```sh
cd web
npm ci
npm run dev
```

Again, the first time will take a minute or two while npm downloads packages.

When it's ready you'll see something like:

```
VITE v6.0.6  ready in 500 ms
➜  Local:   http://localhost:5173/
```

**Leave this terminal open too.**

<details>
<summary>What just happened?</summary>
<code>npm ci</code> downloaded ~400 JavaScript packages into a folder called
<code>node_modules</code>. Then <code>npm run dev</code> started Vite, a
development server that compiles the React/TypeScript code in real time and
serves it at port 5173. It also proxies API calls and WebSocket connections
to the Rust server on port 3000, so the two programs work together seamlessly.
</details>

### Step 3: Open it in your browser

Open your web browser and go to:

```
http://localhost:5173
```

You should see the RÚNA landing page with a dark background and two options:
**UNLISTED** and **NAMED**.

🎉 **That's it!** Continue to [Using RÚNA](#using-rúna) below.

---

## Using RÚNA

### Creating a room

1. On the landing page, choose **UNLISTED** (default, recommended) or **NAMED**

   | UNLISTED | NAMED |
   |---|---|
   | Nobody can find this room | Anyone who knows the name can find it |
   | The link contains the secret key | Protected by a passphrase |
   | Share by sending the full link | Share by saying the name + passphrase |
   | Best for most uses | Best when you need to speak the address aloud |

2. Pick an expiry time (how long until the room self-destructs):
   - **30 min / 1 h / 8 h** after last activity
   - **24 h** from creation
   - **No expiry** (dies when everyone leaves, you shred it, or the server restarts)

3. Click **Create unlisted room** or fill in a name + passphrase and click
   **Create named room**

### Sharing a room

After creating a room, look at the URL in your browser's address bar. It looks
something like:

```
http://localhost:5173/r/a1b2c3d4e5f6...#k=AbCdEf123456&s=GhIjKl789012
```

**The entire URL including everything after the `#` is the room's key.** Send
the whole thing to people you want to invite. You can use the **Copy link**
button in the status bar.

> ⚠️ **Important:** Some chat apps (Slack, Discord, Teams) strip the part
> after the `#`. Always test the link yourself before sharing it, or copy-paste
> it manually rather than clicking a preview.

For **named rooms**, share the name and passphrase separately — like telling
someone "go to copper-lantern and the password is harbor thistle quartz nine."

### Editing together

Everyone who opens the same link sees the same document. Changes appear in
real-time (within about 100 ms on a local network). The status bar at the top
shows how many people are connected.

### Shredding a room

Click the red **Shred** button in the top-right corner. This opens a dialog
explaining what will happen. In a multi-person room, **everyone must agree**
before the shred executes — one person pressing the button alone does nothing
unless they're the only one there.

When the shred completes, every browser is redirected to a tombstone page that
says *"Nothing here anymore."* The encryption keys are gone. There is no undo.

---

## Running the tests

The fastest check is the verification script. It runs the server tests, clippy,
the Linux cross-compile check, the web suite, type checking, linting, the
production build, and the supply-chain scans — stopping at the first failure:

```sh
./scripts/verify.sh
```

It prints `VERIFIED` and nothing else if everything passed.

To run the suites separately:

```sh
# Terminal 1: Server tests
cd /path/to/Runa
cargo test -p runa-server

# Terminal 2: Web tests
cd /path/to/Runa/web
npm ci          # only needed once, or if package.json changed
npx vitest run
```

You should see all tests pass. The server has 47 unit tests and 23 integration
tests. The web suite has over 130 tests covering cryptography, transport,
document convergence, rendering security, and shred consensus.

---

## Deploying to the internet

The instructions above run RÚNA locally. To put it on the internet where
other people can reach it, you have two options:

### Docker (recommended)

This is the easiest way to deploy. You need [Docker](https://docs.docker.com/get-docker/)
installed on your server.

```sh
# Build the image (from the project root)
docker build -t runa .

# Run it
docker run \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --memory=512m --memory-swap=512m \
  --pids-limit=256 \
  -p 3000:3000 \
  runa
```

This runs the server with:
- No write access to disk (nothing can persist)
- No Linux capabilities (minimal attack surface)
- No privilege escalation possible
- Memory capped at 512 MB (with swap disabled)
- Process count limited to 256

The container serves the built frontend and the API/WebSocket on port 3000.

### Sizing it for the host

Rooms live entirely in RAM, so "how much memory can strangers make this process
hold" is a number you set, not one you discover. The server prints its ceiling
at startup:

```
resource ceiling: retained ciphertext will not exceed max_total_log_mib across
all rooms  max_rooms=512 max_log_mib_per_room=32 max_total_log_mib=512
```

`RUNA_MAX_TOTAL_LOG_MB` is the one that actually bounds the process. The
per-room limit only caps a single document; the total is what a host shared
with anything else needs.

| Variable | Default | What it bounds |
|---|---|---|
| `RUNA_MAX_TOTAL_LOG_MB` | `512` | **Ciphertext retained across all rooms.** The real memory ceiling |
| `RUNA_MAX_ROOMS` | `512` | Live rooms. Creation returns `503 AT_CAPACITY` past this |
| `RUNA_MAX_LOG` | `33554432` | Bytes of history in one room, before snapshot compaction |
| `RUNA_MAX_PEERS` | `32` | Connections per room |
| `RUNA_MAX_FRAME` | `262144` | Bytes in one WebSocket message |
| `RUNA_MAX_CONFIG_BLOB` | `4096` | Bytes of encrypted room config held for the room's life |
| `RUNA_MAX_CONNECTIONS` | `1024` | Concurrent sockets, process-wide. The per-IP limit bounds one address; this bounds the sum |
| `RUNA_MAX_QUEUE_KB` | `4096` | Bytes one connection may have queued but not yet written to its socket |
| `RUNA_ROOMS_PER_HR` | `20` | Unlisted rooms one address may create per hour |
| `RUNA_NAMED_PER_HR` | `5` | Named rooms one address may create per hour |
| `RUNA_IDLE_CEILING` | `43200` | Seconds an unattended `ttl: none` room survives |
| `RUNA_ALLOW_CEILING_OPTOUT` | unset | Set to `1` to let clients create rooms that never expire. **Off by default** — an immortal room is a permanent memory reservation any anonymous caller could make |

Sizing for a small shared VM — say 1 GB, with other services on it:

```sh
RUNA_MAX_TOTAL_LOG_MB=128 RUNA_MAX_ROOMS=64 RUNA_MAX_PEERS=16 \
RUNA_MAX_CONNECTIONS=256 RUNA_MAX_QUEUE_KB=512 \
RUNA_TRUSTED_PROXY=1 RUNA_BIND=127.0.0.1:3000 RUNA_DIST=web/dist \
  ./runa-server
```

That works out to roughly `25 + 179 + 128 + 32 ≈ 364 MB` worst case, which
fits a `MemoryMax=512M` unit with room to spare.

The worst case has a closed form, which is the point of the last two:

```
peak ≈ 25 MB baseline
     + 1.4 × RUNA_MAX_TOTAL_LOG_MB      (entry overhead and allocator slack)
     + RUNA_MAX_CONNECTIONS × RUNA_MAX_QUEUE_KB
     + ~32 MB rate-limiter tables, fully saturated
```

The 1.4 factor is because the budget counts frame bytes; each log entry also
carries a 56-byte record and its own allocation. Frames queued for a peer that
has stopped reading are *not* retained history, so nothing else accounts for
them — hence the per-connection byte cap rather than a frame count.

> On Linux the server calls `mlockall(MCL_CURRENT | MCL_FUTURE)` so key
> material cannot reach swap. It needs a raised `RLIMIT_MEMLOCK` (or
> `CAP_IPC_LOCK`) to take effect; the distroless image runs as `nonroot` with
> Docker's default 64 KB limit, so the call fails and is ignored. If you want
> the guarantee, run with `--ulimit memlock=-1` and keep the log budget well
> under the host's RAM — locked pages cannot be reclaimed under pressure.

### Behind a reverse proxy

Any real deployment needs HTTPS in front of RÚNA — the browser refuses `ws://`
on anything but loopback, so without TLS the editor simply will not connect.

> **Required behind any proxy: `RUNA_TRUSTED_PROXY=1`.**
>
> Every per-IP rate limit keys on the address RÚNA sees. Behind a proxy that
> address is the loopback for *every* visitor, so all the limits in `config.rs`
> collapse into one shared bucket — the eleventh simultaneous visitor is refused
> a WebSocket because the whole server has "used up" its ten connections. With
> this variable set, RÚNA keys the limits on the last `X-Forwarded-For` entry
> instead. That value is used in memory as a limiter key and is never logged.
>
> Leave it **off** when RÚNA is exposed directly, or anyone can forge the header
> and get a fresh bucket per request.

#### Caddy (recommended)

Caddy is the better fit here for one specific reason: **it does not log
requests unless you ask it to.** RÚNA's URLs contain the room ID, which is the
secret, so a proxy that writes request paths to disk by default is a
liability. Caddy also obtains and renews Let's Encrypt certificates on its own.

```caddyfile
runa.example.com {
    # No `log` directive, deliberately. The request path contains the room ID.
    tls {
        protocols tls1.3 tls1.3
    }
    reverse_proxy 127.0.0.1:3000
}
```

Point an A record at the machine, run `caddy run --config Caddyfile`, and the
certificate is issued on first request.

#### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name runa.example.com;

    ssl_certificate     /etc/letsencrypt/live/runa.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/runa.example.com/privkey.pem;
    ssl_protocols TLSv1.3;

    # The request path contains the room ID, which is a secret. nginx logs
    # every path by default, so this line is a security control, not a
    # preference. Do not remove it to "debug something quickly".
    access_log off;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;

        # RÚNA reads this only when RUNA_TRUSTED_PROXY=1, and only ever as an
        # in-memory rate-limit key. It is never written anywhere.
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

#### Running the server behind it

Bind RÚNA to the loopback interface so it is reachable only through the proxy:

```sh
cd web && npm ci && npm run build && cd ..
RUNA_TRUSTED_PROXY=1 RUNA_DIST=web/dist RUNA_BIND=127.0.0.1:3000 \
  cargo run --release -p runa-server
```

Or with Docker, publishing the port to loopback only:

```sh
docker run -d --name runa \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges:true \
  --memory=512m --memory-swap=512m --pids-limit=256 \
  -e RUNA_TRUSTED_PROXY=1 \
  -p 127.0.0.1:3000:3000 \
  runa
```

> Rooms live only in RAM. Restarting the container, deploying, or rebooting the
> host destroys every open document. That is the design, not a bug — but it
> means you should not restart a production instance casually.

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `cargo: command not found` | Rust isn't in your PATH | Close and reopen your terminal, or run `source ~/.cargo/env` |
| `npm: command not found` | Node.js isn't installed or PATH issue | Reinstall Node.js, restart terminal |
| Port 3000 already in use | Something else is listening on that port | Kill the other process or set `RUNA_BIND=127.0.0.1:3001` and update the Vite proxy target |
| Browser shows blank page | The web app isn't running | Make sure `npm run dev` is still running in its own terminal |
| Blank page from a deployed server | `RUNA_DIST` does not point at a built bundle | Run `npm run build` in `web/` and set `RUNA_DIST=web/dist`. The server logs a warning at startup when it cannot find `index.html` |
| "This page is not on HTTPS" | Serving over plain `http://` on a public hostname | Browsers refuse `ws://` from such a page. Put TLS in front — see [Behind a reverse proxy](#behind-a-reverse-proxy). `localhost` is exempt |
| Room creation fails with `AT_CAPACITY` | The server is at `RUNA_MAX_ROOMS` | Raise it if the host has the memory, or wait for rooms to expire |
| Only one client can connect behind a proxy | `RUNA_TRUSTED_PROXY` is not set | Every request appears to come from the proxy, so all clients share one rate-limit bucket. Set `RUNA_TRUSTED_PROXY=1` |
| Browser shows "Connection refused" | The Rust server isn't running | Check that `cargo run --release -p runa-server` is still active |
| "This link is missing its key" | The `#k=…&s=…` part was stripped from the URL | Ask whoever shared the room for the full link including everything after the `#` |
| Compilation errors mentioning OpenSSL | Missing system libraries | macOS: `brew install openssl` · Ubuntu: `sudo apt install libssl-dev pkg-config` · Fedora: `sudo dnf install openssl-devel` |
| `npm ERR!` during install | Corrupt cache or network issue | Try `rm -rf node_modules package-lock.json && npm install`, or check your internet connection |

---

## Security: what this does and does not protect you from

Read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the full picture. Here
are the two sentences that matter most:

1. **A malicious server operator can serve you modified JavaScript.** This is
   true of every browser-delivered end-to-end-encrypted application. Self-host
   if you don't trust whoever runs the server.

2. **Shredding removes the shared copy, not copies on other people's machines.**
   Anyone who could read the document can screenshot it or copy-paste it.
   RÚNA cannot reach into someone else's computer.

### What RÚNA *does* protect against

| Threat | Protection |
|---|---|
| Passive network eavesdropper | AES-256-GCM encryption on every frame, independent of TLS |
| Honest-but-curious server admin | Server stores only ciphertext; keys never leave browsers |
| Brute-force room guessing | 128-bit unguessable IDs + Argon2id KDF + rate limiting + timing-floor auth |
| Post-hoc disk forensics | No database, no files written, memory-hardened process, core dumps disabled |
| Malicious peer forging shred votes | Client-side signature verification, frozen roster hashes, fail-closed deadlines |

### What RÚNA does *not* protect against

| Threat | Why not |
|---|---|
| Someone screenshots the document | RÚNA controls its own page, not other applications |
| Malware on a participant's computer | Out of scope — use a clean machine |
| Traffic correlation (who talks to whom, when) | Use Tor if this matters to you |
| The server serving modified JS | See §2.4 of THREAT_MODEL — this is inherent to browser-delivered apps |

---

## Project structure

```
Runa/
├── server/                  Rust backend (the blind relay)
│   ├── src/
│   │   ├── main.rs          Entry point, router, signal handling
│   │   ├── config.rs        All limits as env-overridable constants
│   │   ├── memguard.rs      mlockall, core-dump suppression (Linux)
│   │   ├── bifrost/         WebSocket relay, frame codec, HTTP API
│   │   ├── heimdall/        Auth verification, rate limiting
│   │   ├── runar/           Room lifecycle, ciphertext log, name registry
│   │   ├── gjallarhorn/     Shred frame relay (counts nothing)
│   │   └── surtr/           Purge (one code path ends a room's life)
│   ├── fuzz/                Fuzz targets for the frame parser
│   └── tests/               Integration tests (real WebSocket clients)
├── web/                     Frontend (React + TypeScript)
│   ├── src/
│   │   ├── crypto/          Argon2id, HKDF, AES-GCM, identity, fingerprints
│   │   ├── transport/       Frame encoding, WebSocket client, reconnect
│   │   ├── doc/             Yjs CRDT wrapper, Monaco binding, awareness
│   │   ├── render/          Markdown pipeline with sanitiser-last ordering
│   │   ├── shred/           Consensus machine, roster hashing, wipe sequence
│   │   ├── routes/          Landing page and editor room components
│   │   ├── ui/              Status bar, quorum dial, shred modal
│   │   └── export/          PDF export via Paged.js
│   └── scripts/             E2E smoke tests, SRI injection, origin checker
├── docs/                    Public documentation
│   ├── THREAT_MODEL.md      What RÚNA defends against (and what it doesn't)
│   ├── SECURITY.md          How to report vulnerabilities
│   ├── PROTOCOL.md          Wire format specification
│   └── ATTRIBUTION.md       Upstream credits and dependency licences
├── scripts/verify.sh        One-command check: tests, lint, build, supply chain
├── .github/workflows/       CI pipeline
├── Dockerfile               Distroless production image
└── deny.toml                Bans database crates, enforces licences
```

---

## Licence and attribution

This project is MIT-licensed. It derives from
[Rustpad](https://github.com/ekzhang/rustpad) by Eric Zhang — specifically,
Rustpad's operational transform engine was replaced with an encrypted CRDT
relay. The MIT licence notice for both projects travels in the [`LICENSE`](LICENSE)
file. See [`docs/ATTRIBUTION.md`](docs/ATTRIBUTION.md) for details on what was
kept, what was removed, and what was added. This project does not imply
upstream endorsement.

---

<div align="center">
<em>RÚNA · Nothing here anymore.</em>
</div>
