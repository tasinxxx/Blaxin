# BLAXIN — AI Desktop Agent

A futuristic, production-quality AI desktop agent capable of understanding user instructions, planning tasks, interacting with the computer's GUI/desktop, using applications, working with files, using the browser, and completing multi-step tasks.

## Architecture```
BLAXIN UI (React + Vite)
    ↓
Jarvis Command Layer (v1.4.0): deterministic fast-path router →
  simple commands ("open example.com", "go to youtube", "take a
  screenshot", "list /tmp", browser back/forward/refresh, current URL,
  page title, list tabs) execute directly with ZERO model calls; slash
  commands (/status, /queue, /missions) run locally; ambiguous/complex
  goals escalate ↓. Every completed task reports its REAL route:
  DETERMINISTIC (fast path, no model), AI BRAIN (model reasoning), or
  HYBRID (fast path attempted + failed, then model recovery).
Agent Orchestrator (WebSocket)
    ↓
Provider Abstraction Layer
    ↓
Cloud Provider (OpenRouter/OpenAI/Anthropic/Google/Groq/Together)
                 or
Local Provider (Ollama — local daemon, or an Oracle Cloud node
                 tunneled to your loopback)
    ↓
Model
```

Supporting subsystems (all real, inspectable state — no simulated UI data):

- **Mission Control**: persistent multi-step missions with per-step
  checkpoints, pause/resume-from-checkpoint, retry-failed-only; a single
  scheduler feeds queued tasks + mission steps to the orchestrator and
  settles them from real agent-state events.
- **Agency Registry**: every actual tool execution becomes an observable
  worker (real runtime step ids, real lifecycle events) — the HUD agency
  panel can only show what really ran.
- **Layered Memory (v1.4.0)**: failure / environment / episodic / procedural
  stores with secret redaction and honest degradation; a relevance-gated,
  budget-capped advisor injects background context into the LLM system
  prompt (the current user instruction always outranks memory); at task end
  the orchestrator records one bounded episode per task, failure lessons
  from real failed tool steps, and environment observations only when
  browser verification produced real URL evidence. Inspectable via the
  Memory page and `GET /api/memory/layers`.
- **Verification-in-depth**: browser actions verify against the real page
  (URL/title/text/element/playback, tri-state — UNKNOWN never becomes
  SUCCESS); browser back/forward verify the real CDP history index AND the
  landing URL, refresh verifies the document was really replaced, and
  current URL / page title / tab list are real reads; terminal commands
  report real exit codes (a nonzero exit is a failure even with stdout);
  app launches are verified by aliveness read-back; mouse/window actions
  read the real pointer/active-window back; clipboard writes are verified
  by read-back; screenshots validate the capture is a real PNG. Where
  verification is impossible (e.g. Wayland pointer position), the result
  says so explicitly instead of implying it.

Since v1.2.0 BLAXIN also ships a **local model system** (real hardware
discovery, a curated model catalog, deterministic fit recommendation
and Ollama lifecycle management) and an **Oracle Cloud provisioning
engine** (signed OCI REST access, discovery, resumable provisioning,
reverse-tunnel inference). See [docs/models.md](docs/models.md) and
[docs/oci.md](docs/oci.md).

## Distributed Brain (external intelligence)

BLAXIN can run in a distributed topology: the **Body** (this desktop device: UI, tools, local execution, policy) connects to a **Brain** — a separate process that can run on another laptop, desktop, VM or server and owns the AI providers, reasoning and planning.

```
User → BLAXIN Body → secure Brain connection → BLAXIN Brain
        (executes tools)        ← structured actions →      (reasons/plans)
```

The Brain never executes commands on the Body — it sends structured, capability-checked action requests and the Body validates, optionally confirms with the user, executes through its own tool layer, and returns structured results. Includes persistent Ed25519 device identity (`BLX-BODY-…` / `BLX-BRAIN-…`), one-time 5-minute pairing codes, bidirectional challenge/response authentication, protocol negotiation (v1), capability exchange, heartbeats, reconnect with backoff, duplicate-execution protection and device revocation.

Default mode is unchanged (`embedded` = the local orchestrator acts as the Brain in-process). Enable external mode with `BLAXIN_BRAIN_MODE=external`. See **[docs/distributed-brain.md](docs/distributed-brain.md)** for the full architecture, pairing quick start, protocol and security model.

The standalone Brain runs the real LLM path: configure its provider and model with `BLAXIN_BRAIN_PROVIDER` / `BLAXIN_BRAIN_MODEL` plus the provider key env var (keys stay on the Brain device, never in the protocol), and it reasons by requesting structured actions from the Body. See the docs for the live-provider validation instructions.

**Multi-Body**: one Brain can serve many Bodies. The device registry is versioned and realtime-synced, routing is per-Body (capabilities are pre-checked before a task is targeted at a Body), and revocation of one Body never affects the others. Tasks follow a canonical lifecycle (`QUEUED → RUNNING → COMPLETED/FAILED/CANCELLED/…`); users can cancel a running task from the Body UI (`task_cancel` over the wire), the Brain unwinds the driver honestly (no fabricated results), and restarts/network breaks reconcile through reconnect + state sync with replay protection.

## Features

- **Multi-Provider AI Support**: OpenRouter (first-class), OpenAI, Anthropic, Google, Groq, Together, Ollama
- **Live Model Discovery**: Automatically discovers available models from configured providers
- **Free Model Detection**: Identifies and recommends free models
- **Local Models (v1.2.0)**: real hardware discovery (CPU/RAM/GPU/VRAM/disk/arch), a maintainable model catalog, and deterministic recommendation with honest warnings — BLAXIN never invents benchmarks or shows an unearned READY
- **Oracle Cloud Models (v1.2.0)**: connect an OCI account (RSA-SHA256 signed API, credentials encrypted at rest), discover real shapes/quotas/instances, and provision a resumable, cancellable inference node whose model endpoint reaches the Brain over a loopback SSH tunnel — never a public port
- **Agent Task Engine**: state machine, step tracking, retry/backoff, provider fallback, loop detection, confirmation gate for high-impact tool actions, and a persistent task queue with priorities, dependency gating and pause/resume/cancel (survives restarts)
- **Missions (v1.4.0)**: multi-step persistent missions with per-step checkpoints — pause and resume from the last completed checkpoint, retry only failed steps, real progress 0-1
- **Jarvis HUD (v1.4.0)**: the approved `design/blaxin_os.html` command-center interface, fully functional: boot overlay gated on the real backend connection, neural status, memory bank, live task queue with actions, 5-tab agent terminal (real event stream + slash-command composer), network hub (real RX/TX telemetry), security vault (real persisted security log), agency panel (real tool-execution workers), layered-memory panel, activity ticker, mission checkpoint reporting. Commands: `/help /status /clear /stop /memory /queue /missions /mission-new /version`
- **Task Memory**: persistent, searchable, deletable memory that never stores secrets
- **Layered Memory (v1.4.0)**: failure/environment/episodic/procedure stores, relevance-gated advisor read-back, task-end episode + failure recording, `GET /api/memory/layers` inspection
- **Desktop Control**: Mouse, keyboard, window management via xdotool/ydotool
- **File System**: Read, write, create, delete files and directories (protected against system/credential paths)
- **Terminal**: Execute shell commands with timeout protection and dangerous-command confirmation
- **Browser**: Open URLs, search the web
- **Screenshots**: Capture screen state for visual observation
- **Clipboard**: Read/write system clipboard
- **System Info**: CPU, memory, disk, network information
- **Secure Credentials**: AES-256-CBC encrypted API key storage
- **Cyberpunk UI**: Futuristic dark theme with neon accents, keyboard focus states and reduced-motion support
- **Error Diagnostics**: Detailed error categorization and resolution guidance

## Getting Started

### Prerequisites

- Node.js 18+
- Linux (for desktop control tools)

### Installation

```bash
cd blaxin

# Install server dependencies
cd server && npm install

# Install client dependencies
cd ../client && npm install
```

### Running

```bash
# Start the server (port 3001)
cd server && npm run dev

# Start the client (port 5173) in another terminal
cd client && npm run dev
```

Open http://localhost:5173 in your browser.

### Configuration

1. Open Settings in the BLAXIN UI
2. Select a provider (OpenRouter recommended for model variety)
3. Enter your API key
4. Click "Validate & Save"
5. Browse available models and select one
6. Start chatting!

## Provider Setup

### OpenRouter (Recommended)
1. Sign up at https://openrouter.ai
2. Create an API key at https://openrouter.ai/keys
3. Enter the key in BLAXIN Settings → Providers

### OpenAI
1. Sign up at https://platform.openai.com
2. Create an API key
3. Enter the key in BLAXIN Settings → Providers

### Anthropic
1. Sign up at https://console.anthropic.com
2. Create an API key
3. Enter the key in BLAXIN Settings → Providers

### Ollama (Local)
1. Install Ollama: https://ollama.ai (or click **Install** on the Models page — BLAXIN can install and start it for you)
2. Pull a model: `ollama pull llama3` (or use **PULL** on the Models page)
3. Start Ollama: `ollama serve` (or **START** on the Models page)
4. No API key needed — BLAXIN auto-detects it

The **Models** page shows your real machine (CPU/RAM/GPU/VRAM/disk), recommends the best catalog model that actually fits, and manages the runtime lifecycle with truthful status.

### Oracle Cloud (optional)

1. Create an OCI API key for your user
2. Models page → Oracle Cloud → *Verify & Connect*
3. Set `BLAXIN_TUNNEL_HOST` and install the shown tunnel public key (see [docs/oci.md](docs/oci.md))
4. Discover shapes → pick one → Deploy a catalog model

The provisioning state machine is resumable and cancellable; READY only appears after a real health check, a real inference round trip and a successful Brain connection.

## Tools

| Tool | Description |
|------|-------------|
| `terminal` | Execute shell commands |
| `filesystem` | Read/write/manage files |
| `computer-control` | Mouse, keyboard, window management |
| `screenshot` | Capture screen state |
| `browser` | Open URLs, search web |
| `clipboard` | System clipboard access |
| `search` | Web search |
| `system-info` | System information |

## Security

- API keys are encrypted with AES-256-CBC and stored with 0600 permissions
- Keys are never logged, exposed in errors, or sent to the frontend
- Secrets are masked in all logs and diagnostics, and refused by the memory store
- High-impact tool actions (deletes, destructive shell commands, installs, browser/desktop actions) pause the agent and require explicit user approval before execution
- Filesystem writes/deletes are hard-blocked on system-critical and credential paths (`/etc`, `/boot`, `~/.ssh`, key files, etc.)
- The backend validates the `Origin` of every WebSocket upgrade and state-changing HTTP request; only local/desktop origins are allowed by default (see `BLAXIN_ALLOWED_ORIGINS` below)
- The desktop app binds the bundled backend to `127.0.0.1` only

### Connection origin policy

Browsers always attach an `Origin` header to non-GET requests, so requests with no origin header are treated as trusted local tooling. Any browser-origin request must match:

- localhost / `127.0.0.1` / `[::1]` (any port)
- the Tauri desktop origin (`tauri://localhost`, `http(s)://tauri.localhost`)
- origins listed in `BLAXIN_ALLOWED_ORIGINS` (comma separated)

For a remote web deployment behind a public domain, set e.g. `BLAXIN_ALLOWED_ORIGINS=https://blaxin.example.com`.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default `3001`) |
| `BLAXIN_HOST` | Bind address (desktop sets `127.0.0.1`) |
| `BLAXIN_DATA_DIR` | Directory for config, encrypted credentials and session state (defaults to the working directory when writable, otherwise `~/.local/share/blaxin`) |
| `BLAXIN_ALLOWED_ORIGINS` | Extra allowed browser origins (comma separated) |
| `BLAXIN_SECRET` | Hex key (≥ 64 chars) for encrypting stored credentials; otherwise a machine-derived key is used |
| `BLAXIN_BRAIN_MODE` | `embedded` (default) or `external` (distributed Brain) |
| `BLAXIN_BRAIN_URL` | Brain WebSocket URL for external mode, e.g. `ws://127.0.0.1:3100/ws/brain` |
| `BLAXIN_BODY_NAME` | Display name of this Body when pairing |
| `BLAXIN_BRAIN_HOST` / `BLAXIN_BRAIN_PORT` | Brain bind address (Brain process; default `127.0.0.1:3100`) |
| `BLAXIN_BRAIN_DEFAULT_DRIVER` | Brain task driver: `llm` (default) or `deterministic` |
| `BLAXIN_BRAIN_PROVIDER` / `BLAXIN_BRAIN_MODEL` | Active AI provider/model on the standalone Brain (e.g. `openrouter` / `openrouter/auto`) |
| `BLAXIN_BRAIN_TLS_KEY` / `BLAXIN_BRAIN_TLS_CERT` | Brain PEM file paths — when both are set the Brain serves WSS only (remote Bodies must connect with `wss://`) |
| `BLAXIN_BRAIN_CA_FILE` | Body: PEM CA bundle that signed the Brain's TLS certificate (private/self-signed LAN setups) |
| `BLAXIN_BRAIN_ALLOW_INSECURE` | Body: `1` = explicit dev override allowing plaintext `ws://` off-loopback and skipping certificate checks (never default) |
| `BLAXIN_OLLAMA_HOST` / `BLAXIN_OLLAMA_PORT` | Local model runtime endpoint (default loopback `127.0.0.1:11434`) |
| `BLAXIN_TUNNEL_HOST` / `BLAXIN_TUNNEL_PORT` | SSH address of this machine that cloud instances dial back to (required for OCI model deployments) |
| `BLAXIN_TUNNEL_LOCAL_PORT` | Local loopback port where the tunneled cloud model endpoint appears (default `12345`) |

## Memory

BLAXIN keeps a persistent memory store (`.blaxin-state/memory.json` under the data directory) for user preferences, durable facts and failure lessons. Entries are capped in size/count, de-duplicated, and refused when they look like secrets. Manage it from the API: `GET /api/memory`, `DELETE /api/memory`.

## Installer

One-command installation for Linux x86_64 downloads the latest stable release, verifies its checksum and installs it with desktop integration:

```bash
curl -fsSL https://raw.githubusercontent.com/tasinxxx/Blaxin/main/blaxin/install.sh | bash
```

The installer is distro-aware:

- **Debian-family distros (Debian / Ubuntu / Kali / Mint / Pop!_OS)**: installs
the `.deb` package via `dpkg` (fixing dependencies with `apt-get install -f` if
needed). The `.deb` runs against the system WebKitGTK, which is the most
reliable configuration.
- **Other distros**: installs the portable AppImage to `/opt/blaxin` with a
launcher and desktop entry, as before.
- Force the AppImage on any distro with `--appimage`:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/tasinxxx/Blaxin/main/blaxin/install.sh | bash -s -- --appimage
  ```

## Linux distribution notes

- **Debian / Ubuntu / Kali and other Debian-family distros**: use the `.deb`
  package (`blaxin_<version>_amd64.deb` on the release page) — `install.sh`
  does this automatically. It declares its dependencies
  (`libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`) and runs
  against the distro's own WebKitGTK, which is the most reliable configuration.

  ```bash
  sudo apt install ./blaxin_1.2.0_amd64.deb   # or: sudo dpkg -i … && sudo apt-get install -f
  blaxin
  ```

- **AppImage caveat**: the AppImage bundles the WebKitGTK/GTK/GLib stack of the
  CI build machine. On some systems the bundled `WebKitWebProcess` cannot
  initialize EGL and aborts with
  `Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...`,
  which leaves the window blank (gray/black) even though the bundled backend
  starts fine (`[BLAXIN] Server is ready!` appears). This is a known upstream
  Tauri/WebKitGTK AppImage limitation (tauri#11988) and is not caused by
  BLAXIN's own code — the identical build renders correctly when it runs
  against the system WebKitGTK (e.g. via the `.deb`).

  If the AppImage shows a blank window, use the `.deb` package instead. The
  generic WebKit environment variables (`WEBKIT_DISABLE_DMABUF_RENDERER=1`,
  `WEBKIT_DISABLE_COMPOSITING_MODE=1`) do **not** fix this failure mode.

## Tech Stack

- **Server**: Node.js, TypeScript, Express, WebSocket
- **Client**: React 18, TypeScript, Vite, Zustand
- **Styling**: Custom cyberpunk CSS theme
- **AI**: Multi-provider abstraction (OpenRouter, OpenAI, Anthropic, Google, Groq, Together, Ollama)

## Branding

The official BLAXIN logo (geometric "B" mark) lives at
`brand/blaxin-logo-source.png`; all application icons (Tauri window/tray,
AppImage, `.deb`, favicon) and in-app brand marks are generated from it via
`python3 brand/generate-icons.py`. See [docs/branding.md](docs/branding.md).

## Documentation

- [docs/models.md](docs/models.md) — local model system: inventory, catalog, recommendation, runtime lifecycle, Brain integration
- [docs/oci.md](docs/oci.md) — Oracle Cloud: security model, discovery, provisioning state machine, secure tunneled endpoints
- [docs/distributed-brain.md](docs/distributed-brain.md) — distributed Brain/Body architecture, pairing, protocol, Multi-Body, task cancellation and recovery
- [docs/branding.md](docs/branding.md) — official logo asset, icon generation, packaging usage
