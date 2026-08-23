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
  - [Behind a reverse proxy (nginx)](#behind-a-reverse-proxy-nginx)
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
Your browser                    Server                     Friend's browser
┌─────────────┐                ┌─────────────┐             ┌─────────────┐
│ You type    │   encrypted    │ Stores      │  encrypted  │ They see    │
│ "hello"  ───┼───scrambled────│ scrambled  ─┼──scrambled──▶ "hello"    │
│             │   bytes        │ bytes       │  bytes      │             │
│ Has the key │                │ Has NO key  │             │ Has the key │
└─────────────┘                └─────────────┘             └─────────────┘
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

If you want to verify that everything works correctly:

```sh
# Terminal 1: Server tests
cd /path/to/Runa
cargo test -p runa-server

# Terminal 2: Web tests
cd /path/to/Runa/web
npm ci          # only needed once, or if package.json changed
npx vitest run
```

You should see all tests pass. The server has 29 unit tests and 8 integration
tests. The web suite has over 100 tests covering cryptography, transport,
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

### Behind a reverse proxy (nginx)

If you're deploying manually (without Docker), put nginx in front of the
server to handle HTTPS:

```nginx
server {
    listen 443 ssl http2;
    server_name runa.yourdomain.com;

    # TLS certificate (use Let's Encrypt / certbot)
    ssl_certificate /etc/letsencrypt/live/runa.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/runa.yourdomain.com/privkey.pem;
    ssl_protocols TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Then build the web bundle and point the server at it:

```sh
cd web && npm ci && npm run build
cd ..
RUNA_DIST=web/dist cargo run --release -p runa-server -- --bind 0.0.0.0:3000
```

> ⚠️ **Critical nginx configuration:** Make sure your access logs either
> record no paths, or are disabled entirely. The request path contains the
> room ID, which is a secret. Also strip `X-Forwarded-For` — RÚNA does not
> need it, and logging IPs undermines the privacy promise.

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `cargo: command not found` | Rust isn't in your PATH | Close and reopen your terminal, or run `source ~/.cargo/env` |
| `npm: command not found` | Node.js isn't installed or PATH issue | Reinstall Node.js, restart terminal |
| Port 3000 already in use | Something else is listening on that port | Kill the other process or set `RUNA_BIND=127.0.0.1:3001` and update the Vite proxy target |
| Browser shows blank page | The web app isn't running | Make sure `npm run dev` is still running in its own terminal |
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
