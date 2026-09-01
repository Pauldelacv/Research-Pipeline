# Self-hosting in production

A complete path from a blank Ubuntu VPS to a running, HTTPS-terminated,
backed-up Research Pipeline. It assumes no knowledge of the internal
architecture: everything the pipeline does is behind two commands and one
configuration file.

```
Ubuntu 24.04 LTS
   └── Docker Engine + Compose plugin
        └── docker compose -f infra/production/docker-compose.prod.yml
             ├── caddy      :80/:443  automatic TLS
             ├── web        :3000     operator console      (private)
             ├── api        :4000     REST + SSE            (private)
             ├── worker     ×N        executes pipeline steps
             ├── postgres   :5432     durable state         (private)
             └── redis      :6379     queue + pub/sub       (private)
```

Only Caddy is exposed. Postgres, Redis, the API and the web console are
reachable solely on the private compose network.

**Time:** about 30 minutes, most of it waiting for the first image build.

---

## 0. What you need

|                      |                                                                            |
| -------------------- | -------------------------------------------------------------------------- |
| A VPS                | 2 vCPU / 4 GB RAM / 40 GB SSD is a working minimum. See [sizing](#sizing). |
| A domain             | You need to add two DNS records.                                           |
| An email address     | Let's Encrypt sends expiry warnings to it.                                 |
| Provider credentials | Optional at first — the stack runs on mock providers with none.            |

Costs to expect: the VPS, plus whatever your search and model providers charge.
The **Cost** tab on every run reports the second figure per run, per provider
and per stage.

---

## 1. DNS

Two `A` records pointing at the server's public IPv4 address (`AAAA` too, if it
has IPv6):

| Type | Name           | Value          | Purpose                           |
| ---- | -------------- | -------------- | --------------------------------- |
| `A`  | `research`     | `203.0.113.10` | Operator console                  |
| `A`  | `api.research` | `203.0.113.10` | REST API and the run event stream |

Two names rather than one because the browser bundle is built against an
absolute API URL, and because it lets you put the API behind a different
network policy later without touching the console.

Do this **first**. Caddy proves control of both names over ACME before it can
issue a certificate; if DNS has not propagated, the first boot fails and you
spend the next hour re-issuing into a rate limit.

```bash
# From your laptop, not the server — you want to see what the world sees.
dig +short research.example.com
dig +short api.research.example.com
```

Both must return the server's IP before you continue. If you use Cloudflare,
set the records to **DNS only** (grey cloud) for the first issuance; proxied
records break the HTTP-01 challenge.

---

## 2. The server

As root on a fresh Ubuntu 24.04:

```bash
apt-get update && apt-get upgrade -y
apt-get install -y ca-certificates curl git ufw
timedatectl set-timezone UTC     # every timestamp in the system is UTC
```

### An unprivileged user

```bash
adduser --disabled-password --gecos '' frp
usermod -aG sudo frp
rsync --archive --chown=frp:frp ~/.ssh /home/frp
```

### Docker Engine

From Docker's own repository, not Ubuntu's — the distribution package lags and
ships without the Compose plugin.

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker frp
```

Verify, as `frp`:

```bash
docker compose version     # v2.x
```

### Firewall

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status verbose
```

> **The one thing to understand about ufw and Docker.** Docker writes its own
> iptables rules and they are evaluated _before_ ufw's. Any port published with
> `ports:` in a compose file is reachable from the internet regardless of what
> ufw says. This is why `docker-compose.prod.yml` publishes **no** database or
> Redis ports — the protection is the absence of the mapping, not the firewall.
> Never add `ports: ['5432:5432']` to a production stack and assume ufw covers
> you. If you must reach Postgres from outside, tunnel over SSH:
> `ssh -L 5432:localhost:5432 frp@server` with the port bound to `127.0.0.1`.

### SSH hardening

In `/etc/ssh/sshd_config`, then `systemctl restart ssh`:

```
PasswordAuthentication no
PermitRootLogin no
```

Keep your current session open until you have confirmed key login in a second
terminal.

---

## 3. Configuration

As `frp`:

```bash
git clone https://github.com/Pauldelacv/Research-Pipeline.git ~/research-pipeline
cd ~/research-pipeline/infra/production
cp .env.production.example .env
chmod 600 .env
```

Generate the two secrets and put them in `.env`:

```bash
openssl rand -base64 32   # POSTGRES_PASSWORD
openssl rand -hex 32      # API_KEY
```

The values that must be set before the stack will start:

```bash
APP_DOMAIN=research.example.com
API_DOMAIN=api.research.example.com
TLS_EMAIL=ops@example.com
POSTGRES_PASSWORD=…
API_KEY=…
```

`API_KEY` deserves a moment. This system has **no user authentication** — see
[docs/security.md](./security.md) — so that shared secret is the only thing
between the internet and your research data. Set it. Store it in whatever your
team uses for secrets, not in a chat message.

Everything else has a working default. The providers start on `mock`, which
produces convincing synthetic data: right for a first boot, wrong the moment
anyone treats a result as real. Switch them over when you add credentials:

```bash
PROVIDER_RESEARCH=openrouter
PROVIDER_SEARCH=bright-data
PROVIDER_EXTRACTION=openrouter
OPENROUTER_API_KEY=sk-or-…
BRIGHT_DATA_API_KEY=…
```

See [docs/providers.md](./providers.md) for what each provider needs.

---

## 4. First boot

```bash
cd ~/research-pipeline/infra/production
docker compose -f docker-compose.prod.yml up -d --build
```

The first build takes several minutes: three images, one of them a Next.js
production build. Then:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f caddy
```

Caddy logs `certificate obtained successfully` once per domain. If it does not,
go to [troubleshooting](#troubleshooting) — do not restart in a loop, because
Let's Encrypt rate-limits failed issuances.

Check the stack from outside:

```bash
curl https://api.research.example.com/health
```

```json
{ "ok": true, "checks": { "database": {...}, "redis": {...}, "queue": {...} }, "version": "0.1.0" }
```

`/health` is deliberately unauthenticated and probes Postgres, Redis and the
queue for real. It returns 503 if any of them is down, so it works directly as
an uptime-monitor target.

Then open `https://research.example.com`.

### The migration question

The `api` container runs `node dist/migrate.js` before starting. Migrations are
recorded in `__drizzle_migrations` and skipped once applied, so this is safe on
every boot and every upgrade — there is no separate migration step to remember
and no way to start a container against a schema it does not understand.

The production stack does **not** seed. The development compose does, and demo
companies in a production database are indistinguishable from real ones three
months later.

---

## 5. Backups

Two things need backing up, and only one of them is interesting.

**Postgres holds everything** — projects, runs, entities, evidence, provider
usage. **Redis holds in-flight queue jobs**, which are worth persisting (the
production stack enables AOF) but not worth backing up: losing them strands
runs mid-pipeline, and the fix is to re-run, not to restore.

`infra/production/backup.sh` dumps Postgres in its custom format, **verifies
the dump is readable**, prunes old ones, and optionally ships them offsite. The
verification step is the point: a zero-byte dump restores as an empty database,
silently, and you find out during an incident.

```bash
cd ~/research-pipeline/infra/production
./backup.sh
ls -lh backups/
```

Schedule it nightly:

```bash
crontab -e
```

```cron
# 03:12 rather than 03:00 — every cron job in the world runs on the hour.
12 3 * * * cd /home/frp/research-pipeline/infra/production && ./backup.sh >> backups/backup.log 2>&1
```

Backups that live only on the machine they protect do not survive that machine.
Set `BACKUP_SYNC_CMD` in the environment to copy them elsewhere:

```bash
BACKUP_SYNC_CMD="rclone copy ./backups remote:frp-backups"
```

### Restoring

```bash
cd ~/research-pipeline/infra/production
docker compose -f docker-compose.prod.yml stop api worker

# --clean drops the objects it is about to recreate; without it a restore onto
# a non-empty database fails halfway and leaves a mixture.
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U frp -d frp --clean --if-exists < backups/frp-20260601T031200Z.dump

docker compose -f docker-compose.prod.yml start api worker
```

**Rehearse this once, on a throwaway server, before you need it.** A restore
procedure nobody has run is a hypothesis.

---

## 6. Upgrades

```bash
cd ~/research-pipeline
git pull
cd infra/production
docker compose -f docker-compose.prod.yml up -d --build
```

Compose recreates only the containers whose image or configuration changed, and
the API applies pending migrations as it starts.

The order that matters, if you want zero surprises:

```bash
./backup.sh                                                        # 1. dump first
docker compose -f docker-compose.prod.yml up -d --build api        # 2. schema + API
docker compose -f docker-compose.prod.yml up -d --build worker web # 3. the rest
```

Migrations here are additive — new tables and new nullable columns — so an old
worker against a new schema keeps working for the seconds between steps 2 and 3.
Read the migration in `packages/db/drizzle/` before assuming that of a future
release; a migration that drops or renames a column needs both stopped.

Rolling back means checking out the previous tag and rebuilding. Note that
**migrations do not roll back**: restore the dump you took in step 1 if a
release changed the schema in a way you need to undo.

### Watching an upgrade land

```bash
docker compose -f docker-compose.prod.yml logs -f api worker
```

The worker logs `worker ready` with its concurrency and the providers it
resolved. If a provider is misconfigured you will see it there, and again on
the **System** page, which probes every provider's healthcheck live.

---

## 7. Scaling the workers

One BullMQ job is one attempt of one pipeline step. Parallelism is therefore
exactly:

```
concurrent step attempts = WORKER_CONCURRENCY × WORKER_REPLICAS
```

```bash
# In .env
WORKER_CONCURRENCY=4     # per container
WORKER_REPLICAS=4        # containers
```

```bash
docker compose -f docker-compose.prod.yml up -d --scale worker=4
```

Workers are stateless and coordinate through Redis, so adding one needs no
configuration and removing one loses nothing — a step attempt that dies is
redelivered, and every step is idempotent.

**What actually limits you** is rarely the CPU. In order:

1. **Provider rate limits.** Extraction fans out over sources; twenty workers
   against a provider that allows five requests a second produce a run made
   mostly of retries. The **Cost** tab shows failed calls per provider, and the
   **Failures** tab names the rate-limit errors.
2. **Postgres connections.** Each worker container holds a pool. Keep
   `WORKER_CONCURRENCY × WORKER_REPLICAS` comfortably under
   `max_connections` (100 in the shipped configuration).
3. **Memory.** Roughly 200–400 MB per worker container under load.

Per-pipeline concurrency is a separate, finer control — `extraction.concurrency`
and `enrichment.concurrency` in the configuration bound how many sources one
step processes at once, which is the right place to protect a specific
provider. See [docs/configuration.md](./configuration.md).

<a id="sizing"></a>

### Sizing

| Runs                         | vCPU | RAM   | Disk    | Workers                         |
| ---------------------------- | ---- | ----- | ------- | ------------------------------- |
| A few per day, ≤100 entities | 2    | 4 GB  | 40 GB   | 1×4                             |
| Continuous, ≤1000 entities   | 4    | 8 GB  | 80 GB   | 2–4×4                           |
| Heavy, multi-tenant          | 8    | 16 GB | 160 GB+ | 4–8×8, Postgres on its own host |

Disk is dominated by evidence snippets and run events, not by entities. A run
that looks at 100 sources and produces 40 entities stores a few MB.

If you raise the RAM, raise Postgres with it — the shipped
`shared_buffers=512MB` and `effective_cache_size=1536MB` in
`docker-compose.prod.yml` are sized for a 4 GB box. The usual starting point is
25% of RAM for `shared_buffers` and 75% for `effective_cache_size`.

---

## 8. Operating it

### Where to look when something is wrong

| Question                     | Where                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| Is the stack healthy?        | `curl https://api…/health` — probes all three dependencies                                    |
| Why did this run fail?       | The run's **Failures** tab: stage, provider, retry count, entity, and the provider's response |
| What did this run cost?      | The run's **Cost** tab: per provider, per stage, per call                                     |
| What did the pipeline do?    | The run's **Events** tab, filterable by level                                                 |
| Is a provider misconfigured? | The **System** page — live healthchecks, not cached                                           |
| What is the queue doing?     | `GET /v1/metrics` returns waiting / active / failed / delayed                                 |

The failures view is worth knowing about specifically: it records the failures a
step _tolerated_ as well as the ones that ended it, with the provider's
(redacted) response attached. It exists so that debugging a run does not mean
reading `docker compose logs worker`.

### Logs

```bash
docker compose -f docker-compose.prod.yml logs -f --tail=200 api worker
```

Logs are structured JSON tagged with `runId`, `stepId` and `attempt`:

```bash
docker compose -f docker-compose.prod.yml logs --no-log-prefix worker | jq -c 'select(.runId=="run_…")'
```

Cap Docker's log growth in `/etc/docker/daemon.json` — the default is unbounded
and will eventually fill the disk:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
```

Then `systemctl restart docker`.

### Disk

```bash
docker system df
docker system prune -af --filter 'until=168h'   # images and layers, not volumes
```

`prune` never touches named volumes, so `postgres-data`, `redis-data`,
`caddy-data` and `exports` are safe. Exported files accumulate in the `exports`
volume; they are reproducible from the run, so pruning old ones is safe.

<a id="troubleshooting"></a>

---

## 9. Troubleshooting

### Caddy will not issue a certificate

```bash
docker compose -f docker-compose.prod.yml logs caddy | grep -i -E 'error|challenge'
```

| Cause                 | Check                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| DNS not resolving yet | `dig +short your.domain` from off the server                                                                             |
| Port 80 blocked       | `ufw status`; the HTTP-01 challenge needs 80, not just 443                                                               |
| Cloudflare proxying   | Set the records to DNS-only for the first issuance                                                                       |
| Rate limited          | Uncomment `acme_ca` (staging) in the `Caddyfile`, get it working, then comment it out and remove the `caddy-data` volume |

### `api` restarts in a loop

```bash
docker compose -f docker-compose.prod.yml logs api | tail -50
```

Almost always the environment. The API validates its whole environment at
startup and names the offending variable:

```
Invalid environment configuration:
  - DATABASE_URL: Too small: expected string to have >=1 characters
```

A `.env` missing `POSTGRES_PASSWORD` produces a `DATABASE_URL` with an empty
password, which fails here rather than three steps into a run.

### The web console loads but every request fails

The browser bundle is built against `NEXT_PUBLIC_API_URL`, which is baked in at
**build** time. Changing `API_DOMAIN` after the fact requires a rebuild:

```bash
docker compose -f docker-compose.prod.yml up -d --build web
```

If the console loads but calls are rejected, check `API_CORS_ORIGIN` matches
`https://$APP_DOMAIN` exactly — scheme included, no trailing slash.

### The run view does not update live

The pipeline view streams server-sent events. Any proxy that buffers responses
turns it into a page that updates once, at the end. The shipped `Caddyfile`
sets `flush_interval -1` and disables the read timeout for exactly this reason;
if you put another proxy in front, it needs the equivalent (`proxy_buffering
off` in nginx).

The console falls back to polling every 4 seconds when the stream drops, so a
run that updates _slowly_ rather than not at all is a buffering problem, not a
broken backend. The header shows `live` or `polling`.

### Runs queue but never start

The worker is not consuming. Check it is running and reached Redis:

```bash
docker compose -f docker-compose.prod.yml ps worker
docker compose -f docker-compose.prod.yml logs worker | grep 'worker ready'
curl -H "x-api-key: $API_KEY" https://api.research.example.com/v1/metrics
```

A growing `waiting` count with `active: 0` means no worker is attached.

### A run fails immediately with `PROVIDER_NOT_CONFIGURED`

A provider was selected without its credentials. This is deliberate and loud —
the alternative is silently producing fabricated data. The **System** page names
the missing variable; set it in `.env` and recreate the API and worker:

```bash
docker compose -f docker-compose.prod.yml up -d api worker
```

### Every run costs more than expected

Open the **Cost** tab. It breaks spend down by provider, operation and stage,
and flags a total as a _floor_ when some calls could not be priced. Two things
usually explain a surprise: `discovery.maxResults` fanning extraction out over
more sources than intended, and a large model doing bulk extraction where a
small one would do. Both are configuration changes, not code.

### Postgres will not start after a host restart

```bash
docker compose -f docker-compose.prod.yml logs postgres | tail -30
```

An unclean shutdown normally recovers on its own. If the data directory is
genuinely damaged, that is what the backups are for — see
[restoring](#5-backups).

---

## 10. What this deployment does not give you

Stated plainly, so nothing is a surprise later. The detail is in
[docs/security.md](./security.md).

- **No user authentication.** One shared `API_KEY` for everyone. There are no
  accounts, no roles, and reviewer attribution is whatever the client sends.
  Put it behind a VPN, an SSO proxy (Caddy has `forward_auth`), or an IP
  allow-list if more than a handful of trusted people can reach it.
- **Tenant isolation is by convention.** Every row carries `tenant_id` and
  every query filters on it, but nothing at the database level enforces that.
  The schema is shaped so row-level security can be switched on without a
  migration; it has not been.
- **No secrets manager.** Credentials live in `.env` on the host. `chmod 600`
  and a locked-down server are the whole story.
- **Single host.** Postgres and Redis run as containers beside the application.
  For anything with a real availability requirement, move both to managed
  services and point `DATABASE_URL` and `REDIS_URL` at them — nothing else in
  the stack changes.
- **No log shipping or alerting.** `/health` and `/v1/metrics` are designed as
  monitor targets; nothing consumes them for you.
