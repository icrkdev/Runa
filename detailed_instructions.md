# Deploying RÚNA — copy-paste instructions

Every block below is labelled with **where** it runs. Work top to bottom.
Do not skip Part 0.

- 🖥️ **MAC** — your terminal, in the repo
- ☁️ **CLOUDFLARE** — the web dashboard
- 📦 **ORACLE BOX** — over SSH

Total time: about 25 minutes, most of it waiting for one build.

---

## Part 0 — How one IP serves two sites

You asked how `193.122.143.130` tells SKIPTI and RÚNA apart. **Caddy does it,
and it is completely standard.** Two mechanisms, in order:

1. **TLS SNI.** Before any HTTP is exchanged, the browser announces the
   hostname it wants inside the TLS handshake — `runa.vardrlabs.com` or
   `skipti.vardrlabs.com`. Caddy reads that and presents the matching
   certificate. It keeps a separate cert per site.
2. **HTTP `Host` header.** Once TLS is up, the request carries the hostname
   again. Caddy matches it to the site block and proxies to that block's
   backend.

So:

```
                    ┌───────────────────────────────────┐
  runa.vardrlabs    │  Caddy :443                       │
  ──────────────▶   │                                   │
                    │  SNI/Host = runa.…   ──▶ :3000    │──▶ RÚNA container
  skipti.vardrlabs  │  SNI/Host = skipti.… ──▶ :8080    │──▶ SKIPTI
  ──────────────▶   │                                   │
                    └───────────────────────────────────┘
```

Different ports on loopback, different site blocks, one public IP. This is
name-based virtual hosting — the same thing every shared host has done since
the 1990s. You do not need a second IP address.

**Neither service can reach the other.** RÚNA listens on `127.0.0.1:3000`,
SKIPTI on `127.0.0.1:8080`. Neither is reachable from the internet; only
Caddy can talk to either.

### About isolation

You wanted RÚNA in its own container. That is what these instructions do. To
be straight about what it buys you and what it costs:

**What you get:** RÚNA runs in its own image, its own filesystem, its own
process namespace. It has no Rust toolchain, no source, and no path to
SKIPTI's files. Removing it is `docker rm -f runa` — nothing left behind.
The container additionally runs read-only, with every Linux capability
dropped, `no-new-privileges`, a 2 GB memory cap and a 256-process cap.

**What it costs, honestly:** installing Docker on the box adds a root daemon
and rewrites `iptables`. That is a real change to a machine SKIPTI runs on.
The specific hazard is that Docker's rules can bypass a UFW firewall for
*published* ports — which is why Part 4 publishes to `127.0.0.1:3000` and not
`0.0.0.0:3000`. Bound to loopback, the container is unreachable from the
internet no matter what the firewall does.

If you would rather not add Docker to the box, `./scripts/deploy-oracle.sh`
does the same job with a hardened systemd unit instead. Both are supported.

---

## Part 1 — 🖥️ MAC · Get the code

```bash
cd /Users/prithvi/Downloads/Runa
```

```bash
git checkout main && git pull
```

You should be on `main` with a clean tree. Confirm:

```bash
git status --short && git log --oneline -1
```

`git status --short` should print **nothing**. If it prints filenames, commit
or stash them — the deploy ships the committed tree and would silently leave
your changes behind.

---

## Part 2 — ☁️ CLOUDFLARE · DNS

In the Cloudflare dashboard for `vardrlabs.com` → **DNS** → **Add record**:

| Field | Value |
|---|---|
| Type | `A` |
| Name | `runa` |
| IPv4 address | `193.122.143.130` |
| Proxy status | **DNS only** (grey cloud ☁️, *not* orange) |
| TTL | Auto |

**The grey cloud is not optional.** Orange means Cloudflare terminates TLS and
sees every request path. RÚNA's paths contain room IDs. Your own ADR-0032
already refused Cloudflare proxying for SKIPTI; the same reasoning applies
here.

Then, back on the 🖥️ **MAC**:

```bash
dig +short runa.vardrlabs.com A
```

Must print exactly `193.122.143.130`. If you see `172.67.*` or `104.21.*`,
the record is still proxied — go back and switch it to DNS only. The deploy
script refuses to run until this is right.

---

## Part 3 — 📦 ORACLE BOX · Install Docker (one time only)

Skip this whole part if `docker` is already installed.

```bash
ssh -i ~/.ssh/runa_oracle ubuntu@<NEW_INSTANCE_IP>
```

Now on the box:

```bash
curl -fsSL https://get.docker.com | sudo sh
```

```bash
sudo usermod -aG docker $USER
```

```bash
exit
```

The `usermod` only takes effect on a new login, which is why you exit here.
Log back in and confirm Docker works **without sudo**:

```bash
ssh -i ~/.ssh/runa_oracle ubuntu@<NEW_INSTANCE_IP> 'docker run --rm hello-world | head -3'
```

You should see `Hello from Docker!`. If you get a permission error, the group
change has not taken — log out and in again.

While you are here, confirm SKIPTI is still fine:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://skipti.vardrlabs.com/version
```

Should print `200`.

---

## Part 4 — 🖥️ MAC · Deploy

One command. It does everything: ships the source, builds the image on the
box, starts the container, wires the Caddy vhost, and verifies the result
from outside.

```bash
cd /Users/prithvi/Downloads/Runa && cd /Users/prithvi/Downloads/Runa && \
  RUNA_HOST=runa.vardrlabs.com RUNA_BOX_IP=<NEW_INSTANCE_IP> \
  RUNA_SSH_KEY=~/.ssh/runa_oracle \
  ./scripts/deploy-docker.sh
```

It prints six labelled phases. **The image build takes 10–15 minutes the
first time** — Rust with full link-time optimisation on 2 cores. Later
deploys reuse Docker's layer cache and are much faster.

If it stops, it stops *before* changing anything further. The Caddy step in
particular backs up the Caddyfile, validates, and restores the backup if
validation fails — a broken Caddyfile would drop TLS for SKIPTI too, so that
step is guarded.

Success ends with:

```
DEPLOYED  https://runa.vardrlabs.com/
```

---

## Part 5 — 🖥️ MAC + browser · Confirm it actually works

```bash
curl -sI https://runa.vardrlabs.com/ | head -1
```

```bash
curl -s https://runa.vardrlabs.com/version
```

The `commit` field must match `git rev-parse HEAD`. If it says `dev`, the
build did not pick up the commit stamp and you are serving a bundle you
cannot attest to.

Then the part no `curl` can check:

1. Open <https://runa.vardrlabs.com> in a browser.
2. Create a room.
3. Copy the link — **including everything after the `#`**. That fragment is
   the encryption key and never reaches the server.
4. Paste it into a second window.
5. Type in one. It should appear in the other immediately.
6. Both should read **`2 PEERS`**.
7. Close one window. The other should drop to **`1 PEER`** within seconds.

Step 7 is the one to watch. A stale peer count was one of the audit findings
— `PEER_LEAVE` frames were arriving malformed and clients never removed
departed peers. If the count drops correctly, the fix is live.

Finally, confirm you did not disturb your other service:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://skipti.vardrlabs.com/version
```

`200`. Done.

---

## Day-to-day

**Ship an update** — 🖥️ MAC, after committing and pushing:

```bash
cd /Users/prithvi/Downloads/Runa && git pull && cd /Users/prithvi/Downloads/Runa && \
  RUNA_HOST=runa.vardrlabs.com RUNA_BOX_IP=<NEW_INSTANCE_IP> \
  RUNA_SSH_KEY=~/.ssh/runa_oracle \
  ./scripts/deploy-docker.sh
```

**Watch the logs** — 🖥️ MAC:

```bash
ssh -i ~/.ssh/runa_oracle ubuntu@<NEW_INSTANCE_IP> 'docker logs -f runa'
```

**Check whether a limit is binding** — 🖥️ MAC:

```bash
ssh -i ~/.ssh/runa_oracle ubuntu@<NEW_INSTANCE_IP> "docker logs runa 2>&1 | grep -E 'room budget exhausted|connection ceiling'"
```

Either message means you should raise the limits **and** the container memory
together. See "Resizing" below.

**Remove it entirely** — 🖥️ MAC:

```bash
cd /Users/prithvi/Downloads/Runa && \
  RUNA_HOST=runa.vardrlabs.com RUNA_BOX_IP=<NEW_INSTANCE_IP> \
  RUNA_SSH_KEY=~/.ssh/runa_oracle \
  ./scripts/rollback-docker.sh --full
```

Stops the container, removes the images, removes the Caddy vhost. SKIPTI is
untouched. Delete the Cloudflare record by hand afterwards.

---

## Resizing

Rooms live only in RAM, so the ceiling is whatever you configure. It has a
closed form:

```
peak ≈ 25 MB baseline
     + 1.4 × RUNA_MAX_TOTAL_LOG_MB      (entry records + allocator slack)
     + RUNA_MAX_CONNECTIONS × RUNA_MAX_QUEUE_KB
     + ~32 MB rate-limiter tables
```

The shipped defaults — 700 MB of history, 512 concurrent editors — work out
to about **1549 MB**, which is why the container gets `--memory=2g`. That is
17% of your 12 GB box, leaving SKIPTI, Caddy and the OS about 10 GB.

To change it, pass environment variables to the deploy script:

```bash
RUNA_MEM=4g RUNA_LOG_MB=1600 RUNA_CONNS=1024 cd /Users/prithvi/Downloads/Runa && \
  RUNA_HOST=runa.vardrlabs.com RUNA_BOX_IP=<NEW_INSTANCE_IP> \
  RUNA_SSH_KEY=~/.ssh/runa_oracle \
  ./scripts/deploy-docker.sh
```

**Keep `RUNA_MEM` and the limits in step.** If the limits exceed the container
memory, the kernel kills the process — and every live document dies with it.

---

## Things that will surprise you if nobody says them

- **Restarting destroys every room.** There is no persistence, by design. A
  redeploy, a reboot, a kernel update, an OOM kill — all of them wipe every
  live document. Tell whoever is using it.
- **There are no backups and never will be.** That is the product.
- **The URL fragment is the key.** A link without the part after `#` is
  useless. Chat apps that "clean" links will break it.
- **`--restart unless-stopped`** brings the container back after a reboot,
  but the rooms it was holding are gone regardless.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Script stops at "DNS" | Cloudflare record still proxied | Switch to DNS only (grey cloud), wait a minute, re-run |
| Script stops at "docker is not installed" | Part 3 skipped or group not applied | Run Part 3; log out and back in |
| `permission denied` on docker | `usermod` needs a fresh login | `exit`, SSH again |
| Build fails, out of disk | Image layers + cache | `ssh … 'docker system prune -af'`, re-run |
| Caddy step says validation failed | A pre-existing Caddyfile problem | Script already restored the backup; SKIPTI is fine. Run `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` on the box to see the real error |
| HTTPS 200 never arrives | Certificate issuance | `ssh … 'sudo journalctl -u caddy --since "5 min ago" \| tail -30'`. Usually DNS not yet propagated |
| `/version` reports `dev` | Commit stamp missing | Re-run the deploy from a clean tree |
| Container not staying up | `--read-only` or capability drop | `ssh … 'docker logs runa \| tail -20'` |
