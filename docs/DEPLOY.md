# Deploying RÚNA

This is the path for a small VM shared with other services. It is what the
`scripts/deploy-oracle.sh` script automates; read this once, then use the
script.

> **Just want to deploy?** Follow
> [`detailed_instructions.md`](../detailed_instructions.md) — every command
> labelled with where it runs. This file is the reasoning behind it.

## Two supported paths

| | Command | Needs on the box |
|---|---|---|
| **Docker** — own image, own namespace, nothing else installed | `./scripts/deploy-docker.sh` | Docker |
| **systemd** — no daemon added, tighter syscall confinement | `./scripts/deploy-oracle.sh` | rustup |

Both bind to loopback and sit behind the same reverse proxy. Neither is
obviously better; they isolate different things.

**Docker** keeps RÚNA's filesystem, processes and toolchain entirely separate
from whatever else the box runs, and `docker rm -f runa` leaves nothing
behind. The honest cost is that installing Docker adds a root daemon and
rewrites `iptables`. That is a real change to a shared machine, and it is why
the deploy publishes to `127.0.0.1:3000` rather than `0.0.0.0:3000` — bound
to loopback, the container is unreachable from outside whatever happens to
the firewall rules.

**systemd** adds no daemon and confines the process more tightly than a
default container does: `DynamicUser=yes`, an empty capability bounding set,
a syscall filter, `ProtectSystem=strict`. The cost is a Rust toolchain on the
box and a build that competes for CPU with whatever else runs there.

Pick Docker for operational isolation, systemd for process confinement.

## What you need

- A domain pointed at the box with an **unproxied** A record.
- A reverse proxy terminating TLS. The browser refuses `ws://` on anything
  but loopback, so without TLS the editor will not connect at all.
- SSH access with `sudo`.
- Rust on the box (`rustup`), and Node on your **local** machine. The box
  never needs Node — the frontend is built locally and shipped as static
  files.

## The one command

```sh
./scripts/deploy-oracle.sh
```

Re-run it to ship an update; it is idempotent. Override the defaults with
environment variables if your host differs:

```sh
RUNA_HOST=runa.example.com \
RUNA_BOX_IP=203.0.113.10 \
RUNA_SSH_USER=ubuntu \
RUNA_SSH_KEY=~/.ssh/id_ed25519 \
  ./scripts/deploy-oracle.sh
```

It refuses to run on a dirty working tree. `git archive` ships the committed
tree, so uncommitted work would be silently left behind — the script makes
that a hard error rather than a surprise in production.

### What it does

| Step | |
|---|---|
| 1 | Preflight: ssh reachable, tree clean, DNS resolves to the box **unproxied** |
| 2 | `npm ci && npm run build` locally |
| 3 | Bundle digest, computed the way `release.yml` computes it |
| 4 | `git archive` the commit; tar the bundle; `scp` both |
| 5 | Build on the box with `--locked`, niced, stamping commit + digest into the binary |
| 6 | Install binary, swap assets atomically, install unit, restart |
| 7 | Append the Caddy vhost behind backup → validate → rollback-on-failure |
| 8 | Verify: loopback bind, HTTPS 200, `/version` matches, no client IPs in logs, other sites still healthy |

Step 7 never edits another site's configuration. It backs the file up,
appends, validates, and restores the backup if validation fails — a broken
Caddyfile would take TLS down for every site on the box.

## Sizing

`deploy/runa.env` carries the limits; `deploy/runa.service` carries
`MemoryMax`. **They must move together.** Rooms live only in RAM, so the
worst case is whatever you configure:

```
peak ≈ 25 MB baseline
     + 1.4 × RUNA_MAX_TOTAL_LOG_MB      (entry records + allocator slack)
     + RUNA_MAX_CONNECTIONS × RUNA_MAX_QUEUE_KB
     + ~32 MB rate-limiter tables, fully saturated
```

The shipped values — 700 MB of history, 512 concurrent editors — work out to
about 1549 MB, under a `MemoryMax=2G` cap with roughly 500 MB of headroom.
`MemoryHigh=1700M` makes the kernel reclaim and throttle before the cap kills
anything, which matters: a throttled RÚNA recovers, a killed one has
destroyed every live document.

To resize, edit `/etc/runa/runa.env` and `MemoryMax` in the unit, then
`sudo systemctl restart runa`. A redeploy will not overwrite `runa.env` once
it exists.

Two variables must stay unset in production:

- `RUNA_ALLOW_INSECURE` — permits plain `ws://`.
- `RUNA_ALLOW_CEILING_OPTOUT` — lets any anonymous caller create a room that
  never expires, which is a permanent memory reservation.

## After it is live

```sh
# Did a limit bind?
sudo journalctl -u runa | grep -E 'room budget exhausted|connection ceiling'

# Is the served bundle the one you built?
curl -s https://runa.example.com/version
```

- **A restart is a data-loss event.** `Restart=on-failure` brings the service
  back, but every live room died with the old process. A non-zero restart
  count in `systemctl status runa` is worth investigating.
- **Reboots destroy rooms.** Kernel updates included. Schedule them, and tell
  whoever is using it.
- **Rooms are not backed up, ever.** That is the product, not an omission.

## Backing out

```sh
./scripts/rollback-oracle.sh          # stop the service, leave Caddy alone
./scripts/rollback-oracle.sh --full   # also remove the Caddy vhost
```

The `--full` form removes exactly the RÚNA vhost block, validates, and
restores its backup if validation fails. Other sites are untouched.
