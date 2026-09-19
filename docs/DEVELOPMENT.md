# Development Guide

How the repository is organized and how to work on BLAXIN from source. For user-facing docs, start at the [README](../README.md).

## Repository layout

```text
├── README.md                  # project landing page
├── LICENSE                    # MIT
├── CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md
├── .github/workflows/         # CI: E2E, release builds, Docker
└── blaxin/                    # the application
    ├── server/                # Node.js + TypeScript backend (agent, tools, providers)
    ├── client/                # React 18 + Vite HUD
    ├── e2e/                   # Playwright E2E over the real stack
    ├── src-tauri/             # Tauri 2 packaging (AppImage/.deb for Linux)
    ├── docs/                  # user-facing deep dives (models, OCI, brain, matrix)
    ├── install.sh             # one-command release installer
    ├── start.sh               # run from source (backend :3001 + client :5173)
    ├── docker-compose.yml     # self-hosted web deployment (nginx + server + client)
    ├── brand/                 # logo source + icon generation
    └── update/                # updater manifest + release notes
```

## Prerequisites

- Node.js 18+ (20 recommended)
- Linux for desktop-control features (the backend compiles anywhere; the tools need a Linux desktop)
- Google Chrome for browser automation and E2E tests
- For packaging: Rust toolchain + Tauri 2 system dependencies (see `blaxin/src-tauri/`)

## Run from source

```bash
cd blaxin
./start.sh
# backend  http://localhost:3001
# client   http://localhost:5173
```

`start.sh` installs dependencies if needed and runs both processes. Alternatively:

```bash
cd server && npm install && npm run dev   # tsx watch
cd client && npm install && npm run dev   # vite
```

The backend runs from TypeScript via `tsx` in dev; `npm run build` emits `dist/`.

## Tests

The server suite is the backbone of the project's verification doctrine — it pins real behavior (read-backs, honest failures, gate semantics), not implementation details:

```bash
cd blaxin/server
npm test        # vitest run — full suite (~900 tests)
npm run test:watch
```

A subset is env-gated LIVE tests that exercise the real machine (real `ps`, real PipeWire, a real X display). They skip silently unless explicitly enabled:

```bash
BLAXIN_LIVE_PROCESSES=1 npm test          # process-control live
BLAXIN_LIVE_DESKTOP=1 npm test            # desktop + vision live
```

## E2E (real stack)

```bash
cd blaxin/e2e
npm install
npm test        # real backend + vite + system Chrome, headless
```

Playwright starts both servers automatically (`PW_BACKEND_PORT` / `PW_VITE_PORT` override 3001/5173). The Chrome sandbox stays enabled; `BLAXIN_E2E_NO_SANDBOX=1` exists only for sandboxless container hosts.

## Runtime probes

`blaxin/scripts/` contains deterministic probes that run against the **compiled dist** and the real OS/Chrome/Xvfb — the same probes recorded in the v1.4.0 release notes (process-control, bulk-dedupe, browser-forms, browser-specialist, computer-use, model-routing). They are the release-gate verification harness.

## Screenshots

`blaxin/e2e/scripts/capture-screenshots.mjs` regenerates the README screenshots by driving the real stack (no mocks): boot → HUD → agent terminal → confirmation gate → verified mission. Output goes to `blaxin/docs/screenshots/`.

## Packaging

Desktop builds are produced by CI (`.github/workflows/release.yml`) on tag push: it bundles the server + a Node runtime into the Tauri app, signs the updater artifacts (`TAURI_SIGNING_PRIVATE_KEY` repo secret), and publishes the GitHub Release. Local builds: `cargo tauri build` from `blaxin/` (updater signing requires the key; the packages themselves build without it).

## Conventions

- **Zero fake state**: never fabricate success, benchmarks, or UI data. Verification is tri-state (SUCCESS / FAILURE / UNKNOWN) and UNKNOWN never upgrades.
- **Bounded everything**: buffers, scans, retries and budgets have explicit caps.
- **Secrets never stored**: the memory store refuses secret-looking content; keys live only in the encrypted credential store.
- Docs live next to what they document (`blaxin/docs/` for app features, root `docs/` for project-level docs).
