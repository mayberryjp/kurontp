# Kuro

A small NTP relay with a single-page admin console, a REST/JSON backend, and SQLite
client tracking. One Python process, no external database, no frontend runtime
server. The production JS and CSS total about 9 KB gzipped.

## Run with Docker

```sh
docker build -t mayberry4477/kurontp:latest .
docker compose up -d
```

Open http://localhost:8000. Point LAN clients at the host's IP on UDP port 123.
Configure runtime variables in `docker-compose.yml`. The website and API have no
authentication: anyone who can reach HTTP can view client data and download backups.
The default Compose HTTP binding is loopback only. For remote administration, use
a trusted private network or a secured reverse proxy with HTTPS. Do not expose the
admin API or an open NTP relay directly to the internet.

The container runs as UID 10001 with no capabilities: host UDP 123 maps to internal
UDP 10123. Stop any existing time server using host port 123 before starting Kuro.
Host firewall rules must allow client UDP traffic and outbound upstream UDP 123.
The named volume `kuro-data` holds the database. Do not delete it during upgrades.

## Run Locally (PowerShell)

Python 3.12+ and Node 22+ are required for development. No virtual environment is needed.

```powershell
python -m pip install -e ".[dev]"
npm ci
npm run build
$env:NTP_PORT = "10123"
python -m kuro
```

Open http://127.0.0.1:8000. Local runs bind HTTP and NTP to loopback by default.
Set `NTP_LISTEN_ADDRESS=0.0.0.0` to serve the LAN. Port 123 may require privileges
on Linux; use a high port or the Docker port mapping instead. Upstream port 123 is
independent of the local listen port.

For frontend hot reload, keep the Python service running and run `npm run dev`;
open the URL Vite prints (normally http://127.0.0.1:3030). Production serves the built
frontend from Python. Run `npm run build` before packaging a wheel.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `NTP_SERVERS` | `time.cloudflare.com,time.google.com` | Comma-separated hostnames or IPs, including unbracketed IPv6 |
| `NTP_UPSTREAM_PORT` | `123` | Common upstream destination port |
| `NTP_SYNC_INTERVAL` | `64` | Seconds between polling rounds |
| `NTP_SYNC_MAX_AGE` | `600` | Seconds before a successful sample expires |
| `NTP_UPSTREAM_TIMEOUT` | `2` | Per-address socket timeout in seconds; OS DNS resolution has its own timeout |
| `NTP_LISTEN_ADDRESS` | `127.0.0.1` | Local bind address; `0.0.0.0` in Docker |
| `NTP_PORT` | `123` | UDP listen port; `10123` in Docker; `0` requests an ephemeral test port |
| `NTP_ALLOWED_NETWORKS` | Loopback and RFC1918 IPv4, `::1/128,fc00::/7` | Comma-separated allowed CIDRs; IPv6 link-local must be added explicitly |
| `NTP_RATE_LIMIT` | `20` | Replies per source IP per one-second window |
| `DATABASE_PATH` | `data/kuro.sqlite3` | SQLite file; `/data/kuro.sqlite3` in Docker |
| `API_LISTEN_ADDRESS` | `127.0.0.1` | HTTP bind address; `0.0.0.0` in Docker |
| `API_PORT` | `8000` | HTTP port |
| `LOG_LEVEL` | `INFO` | Python log level |

Configuration is read at startup. Restart after changing the environment. IPv4 is
the default listener; for IPv6 set an IPv6 listen address. This is one listener,
not a guaranteed dual-stack listener on every OS. The source IP is what reaches
the UDP socket: NAT and Docker Desktop may hide individual client IPs. Deploy
directly on the LAN host, or use Linux host networking when original IP visibility
is required; host networking needs the service configured to listen on UDP 123.

## Time and Tracking Behavior

- Supports basic 48-byte NTPv3/v4 client requests, not control/monitor commands.
- Uses `ntplib` packet parsing with connected UDP sockets and explicit origin,
  mode, version, stratum, timestamp, delay, and dispersion checks on upstream replies.
- Polls configured upstreams sequentially and selects the valid sample with the
  lowest round-trip delay. Failed upstreams are retried next round. The last good
  sample remains in use until it expires.
- Relays corrected time using a monotonic anchor; **does not change the host clock**.
  Host clock discipline should be handled by the OS. Before sync and after expiry,
  replies advertise leap indicator 3 and stratum 16, never a false healthy clock.
- This is a lightweight relay, not a chrony replacement: no NTS, authentication,
  consensus/falseticker rejection, frequency discipline, leap smear policy, or NTP
  era rollover support after February 2036. Choose upstreams with compatible leap
  policies. Use chrony for high-accuracy or security-critical time service.
- Tracks valid requests from allowed source IPs, including rate-limited requests.
  Counts are requests, not guaranteed delivered replies. Invalid/blocked packets
  are counted separately, not stored as clients. No reverse DNS is performed.
- A bounded 10,000-event queue flushes in one SQLite transaction every 500 ms.
  Graceful shutdown drains pending events. Abrupt termination can lose the pending
  batch; queue overflow or DB write failures increment the visible dropped count.
- SQLite uses WAL. Per-client counters persist indefinitely; no per-packet history
  is stored. Memory is bounded for the event queue and rate cache (4,096 IPs).
  The rate cache is abuse mitigation, not protection against a distributed flood.
- First/last seen are receipt times from the host clock, stored as Unix seconds and
  returned as UTC ISO 8601 strings. The dashboard displays browser-local time.
  Upstream offsets apply to NTP replies, not historical tracking timestamps.
- The traffic chart shows observed persisted request deltas while the page is open,
  not durable historical samples. Upstream state and diagnostic counters reset on restart.

## REST API

All endpoints are accessible without credentials. All API responses use JSON except
the SQLite backup. Errors use `status`, `code`, and `error`. CORS allows all origins
as in the reference standards. Restrict HTTP access at the network or reverse proxy.

| Endpoint | Result |
| --- | --- |
| `GET /health` | Process liveness (public) |
| `GET /ready` | 200 only with database, NTP listener, healthy tracking, and fresh sync; otherwise 503 (public) |
| `GET /api/status` | Sync, upstreams, configuration, counters, totals |
| `GET /api/clients` | All clients by default: `items`, `total` |
| `GET /api/clients?search=192.168&limit=25&offset=0` | IP substring search and explicit opt-in pagination |
| `GET /api/backup` | Streaming consistent SQLite snapshot of committed data |

The console loads directly and supports client JSON export and live refresh every
five seconds. Admin actions
are read-only; environment settings cannot be changed through the website.

### Backup and Restore

Use **Back up SQLite** or `GET /api/backup`. SQLite's online backup API includes
committed WAL data safely; do not copy only the live database file. A snapshot
excludes requests still in the tracking queue. Protect backups: they contain client IPs.

To restore: stop Kuro, preserve the current database and its `-wal`/`-shm` sidecars
elsewhere, put the backup at `DATABASE_PATH`, ensure no old sidecars remain at that
path, ensure UID 10001 owns the restored file in Docker, then restart. Restore is
deliberately offline, not an unauthenticated upload endpoint.

## Checks

```sh
python -m pytest
python -m ruff check src tests
python -m mypy src
python -m bandit -r src -q
npm run lint
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser checks start an isolated service on HTTP 18000 / UDP 10124. They cover
desktop/mobile, direct dashboard access, real UDP traffic, client search, downloads,
and network error recovery. Screenshots are written to
`test-results/`. A single workflow validates and builds the image; main-branch
publishing requires `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets.

## Reference Standards

Based on https://github.com/mayberryjp/coding_standards. Deliberate lightweight
adaptations: standard-library SQLite instead of Postgres/SQLAlchemy, a versioned
initial schema (`PRAGMA user_version=1`) instead of Alembic, a static TypeScript
page instead of Vue/Vuetify/router/store, one supervised Python process with
joined worker threads instead of supervisord, and UTC for time-service data.
Bottle/Waitress, settings validation, JSON errors, health/readiness, explicit
pagination, non-root Docker, source layout, and quality checks follow the reference.