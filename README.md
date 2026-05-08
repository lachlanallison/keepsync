# KeepSync

> Sync tabs across Chrome and Firefox browsers with a self-hosted server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Go Version](https://img.shields.io/badge/Go-1.21+-blue.svg)](https://golang.org)
[![Node Version](https://img.shields.io/badge/Node-18+-green.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)

> **⚠ Beta — This software is still in active development and testing.
> Use at your own risk. APIs and data formats may change without notice.**

A **Manifest V3** browser extension and **Go server** for syncing tabs across
devices. Privacy-focused, self-hosted, and email-optional — bootstrap with a
CLI invite token, no SMTP required.

---

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quick Start (Local Testing)](#quick-start-local-testing)
  - [1. Install Go](#1-install-go)
  - [2. Configure the server](#2-configure-the-server)
  - [3. Run the server](#3-run-the-server)
  - [4. Build and load the extension](#4-build-and-load-the-extension)
  - [5. Pair a device](#5-pair-a-device)
- [Running the Test Suite](#running-the-test-suite)
- [Pairing Methods Explained](#pairing-methods-explained)
- [Configuration Reference](#configuration-reference)
- [Production Deployment](#production-deployment)
- [Roadmap / TODO](#roadmap--todo)

---

## Features

- **Real-time sync** — WebSocket/SSE with polling fallback
- **Cross-browser** — Chrome + Firefox (MV3), same server
- **Device management** — list, name, and revoke devices from the options page
- **Conflict resolution** — optimistic locking on snapshots, last-write-wins
  with stale-event drop on individual tab events
- **Self-hosted** — you own the data; no third party required
- **Multiple pairing methods** — CLI invite, device pairing code, or magic-link
- **Quotas & rate limiting** — prevent runaway storage and abuse

---

## Prerequisites

| Tool | Version | Required for |
|---|---|---|
| **Go** | 1.21+ | Server. Uses `modernc.org/sqlite` so **no CGO/gcc is required**. |
| **Node.js** | 18+ | *Only* needed to produce minified Web Store / AMO release zips. **Not required for development or testing.** |
| **Docker** | any | *Optional*, for production `docker-compose` deploys. |

No mail server needed to test locally (`DEV_MODE=true` returns tokens inline).
No npm needed to load the extension — npm is only for release packaging.

---

## Quick Start

Get a running server and extension in under 5 minutes.

### 1. Install Go

**Windows (PowerShell):**

```powershell
winget install --id GoLang.Go -e
# If Go is already installed but not on PATH for the current session:
$env:PATH += ";C:\Program Files\Go\bin"
go version  # should print go1.21+ 
```

**macOS:**

```bash
brew install go
go version
```

**Linux (Debian/Ubuntu):**

```bash
sudo apt install -y golang-go
# Or install the latest from https://go.dev/dl/
go version
```

### 2. Configure the server

From the repo root:

```powershell
# Copy the example env file
Copy-Item .env.example .env
```

Open `.env` and change the following for local testing:

```ini
DOMAIN=localhost:8787
ALLOWED_ORIGINS=*
JWT_SECRET=dev-secret-please-change-at-least-32-chars-long
DATABASE_URL=./data/keepsync.db

# Enable dev mode so /auth/magic-link returns the device token directly
# (no SMTP needed).
DEV_MODE=true
```

> **macOS/Linux:** `cp .env.example .env` instead of the PowerShell line.

### 3. Run the server

```powershell
# Option A — PowerShell helper (Windows, recommended)
.\run-server.ps1
```

```bash
# Option B — go run (cross-platform)
cd server && go run ./cmd
```

```bash
# Option C — build a binary
cd server && go build -o keepsync-server ./cmd && ./keepsync-server
```

On first boot (empty database) the server prints a banner with a **one-time
invite token** for pairing your first browser. Copy it — it won't be shown
again on subsequent restarts.

```
==============================================================
  KeepSync Server — FIRST-DEVICE BOOTSTRAP
==============================================================
  Paste this token into the extension's "Invite token" field:
  beac748c663d988d2bc570f0d4b4dee290cdb8087caf863d
==============================================================
```

Verify:

```powershell
curl http://localhost:8787/healthz
# {"status":"ok"}
```

Need a fresh invite later? `cd server && go run ./cmd invite --email admin@localhost`.

### 4. Load the extension

The `extension/` folder is a loadable unpacked extension — no build step, no
`npm install`. Edit any file and reload the extension card; there's no watcher
or bundler.

**Firefox:** Open `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on...** → select `extension/manifest.json`. Manifest is already Firefox.

**Chrome / Edge:** First swap the manifest, then load:
```powershell
Copy-Item extension\manifest.chrome.json extension\manifest.json -Force
```
`chrome://extensions` → **Developer mode** → **Load unpacked** → select
`extension/`. To restore Firefox: `git checkout -- extension/manifest.json`.

### 5. Pair a device

Extension icon → **Open Settings** → **Setup** tab.

#### CLI invite token (recommended)

Mint a single-use token and paste it into the extension:
```bash
cd server && go run ./cmd invite --email you@example.com --ttl 24h
```
No SMTP needed. Token is single-use.

#### Dev-mode magic-link
Set `DEV_MODE=true`, enter `http://localhost:8787` + any email, click **Send Magic Link**. Token returned inline.

#### Pairing code (second device)
From an already-paired device: **Devices** tab → **Generate Pairing Code**.
From the new device: paste the 6-character code.

#### Email magic-link *(not fully tested)*
Same as dev-mode magic-link, but requires configured SMTP. Token arrives via email.

---

## Running the Tests

```bash
cd server && go test ./...         # unit + integration
cd server && go test -v ./tests    # integration only
make test                          # both, via Makefile
```

---

## Pairing Methods Explained

| Method | Best for | Delivery |
|---|---|---|
| **Invite token (CLI)** | First device, no SMTP | Minted server-side, pasted into extension |
| **Pairing code** | Adding devices from an already-trusted one | 6-char code shown on Device A, typed into Device B |
| **Dev-mode magic-link** | Local testing | Token returned inline (`DEV_MODE=true`) |
| **Email magic-link** | Hosted deployments *(not fully tested)* | Requires SMTP config |

SMTP self-hosted means SPF/DKIM/DMARC, reverse DNS, and blocklist monitoring.
The invite-token and pairing-code flows work without any mail infrastructure.

---

## Configuration Reference

All settings are environment variables (see `.env.example` for the full list):

| Variable | Default | Purpose |
|---|---|---|
| `SERVER_ADDRESS` | `:8787` | Listen address |
| `DATABASE_URL` | `./data/keepsync.db` | SQLite path (or `postgres://...`) |
| `JWT_SECRET` | *(required, ≥32 chars)* | Signs device JWTs |
| `DOMAIN` | — | Public hostname, used in magic-link URLs |
| `ALLOWED_ORIGINS` | `*` | CORS allowlist (comma-separated) |
| `DEV_MODE` | `false` | Return tokens directly from `/auth/magic-link` |
| `QUOTA_LIMIT_MB` | `100` | Per-user storage cap |
| `TOKEN_TTL` | `720h` | Device JWT lifetime |
| `MAX_BODY_BYTES` | `2097152` | Max request body (2 MiB default) |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per-device cap on authed endpoints |
| `SMTP_HOST`/`PORT`/`USERNAME`/`PASSWORD`/`FROM` | — | Only needed if you want real magic-link emails |

---

## Packaging for Release

```bash
cd extension
npm install                  # one-time, pulls webpack + copy plugin
npm run build:chrome         # → extension/dist/ (Chrome build, minified)
npm run build:firefox        # → extension/dist/ (Firefox build, minified)
```

Webpack copies the target manifest, HTML, CSS, and shared scripts, then minifies
each JS file. There's no babel, TypeScript, or module bundling — the source has
no `import`/`require()`.

## Production Deployment

> **⚠ The Docker Compose and Caddy setup is not fully tested. Use at your own risk.**

```bash
cp .env.example .env         # set real JWT_SECRET, DOMAIN, SMTP (optional)
docker-compose up -d         # server + Caddy reverse proxy with HTTPS
```

---

## Roadmap / TODO

- **Tab opener tracking** — Record which parent tab opened a new tab (e.g. right-click "Open in new tab", middle-click, `window.open()`). This enables reconstructing a tree view of tab lineage across devices. See [Horse Browser](https://browser.horse/) for a visual reference of the desired tree UI.

---

## License

MIT — see [LICENSE](LICENSE).

**Questions?** Open an issue.
