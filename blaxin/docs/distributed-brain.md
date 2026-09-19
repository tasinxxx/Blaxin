# BLAXIN Body + Brain — distributed architecture

BLAXIN is split into two roles connected by a versioned, authenticated
protocol:

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  BLAXIN BODY                │        │  BLAXIN BRAIN                │
│  (the desktop device)       │        │  (a separate device/VM/VPS)  │
│                             │        │                              │
│  UI, Tauri shell            │  wss   │  AI providers & models       │
│  terminal / filesystem      │◄──────►│  reasoning / planning        │
│  browser / screenshots      │ secure │  memory / model routing      │
│  computer control           │  link  │  task orchestration          │
│  local policy + execution   │        │                              │
└─────────────────────────────┘        └──────────────────────────────┘
        user                                          intelligence
```

The **Brain is the intelligence**, the **Body is the executor**. The
Brain NEVER runs arbitrary commands on the Body: it sends *structured
action requests* and the Body validates each one against its own
capability + policy layer before executing it locally.

```
User → BODY → (task_start) → BRAIN → reason/plan
                                    → (task_action) → BODY validates
                                                      → BODY executes tool
                                    ← (action_result) ← BODY
                              → verify → next action / (task_complete)
```

## Modes

| Mode | When | What runs where |
|------|------|-----------------|
| `embedded` (default) | classic single-device desktop app | orchestrator + providers + tools in one process (unchanged behavior) |
| `external` | distributed Brain on another device | the Body server forwards user tasks to the Brain; the Brain reasons and requests actions |

```bash
# Body (this device):
BLAXIN_BRAIN_MODE=external BLAXIN_BRAIN_URL=wss://brain-host:3100/ws/brain npm run dev

# Brain (the other device):
cd server && npm run brain        # listens on 127.0.0.1:3100 by default
```

## Quick start (pairing)

1. **Start the Brain** on its own device:

   ```bash
   cd blaxin/server && npm run brain
   ```

   The Brain persists its identity (`BLX-BRAIN-XXXX`) in its data dir.

2. **Generate a pairing code** (loopback only by default):

   ```bash
   curl -X POST http://127.0.0.1:3100/pairing/start
   # → { "brainId": "BLX-BRAIN-XXXX", "code": "AB7K-92QX", "expiresInSec": 300 }
   ```

   Or restart the Brain with `BLAXIN_BRAIN_AUTO_PAIRING=1` to print a
   fresh code at boot. Codes are cryptographically random, expire after
   5 minutes, are single-use, rate-limited, never logged and never
   persisted. The code is ONLY the initial trust bootstrap — it never
   becomes the permanent credential.

3. **Start the Body** in external mode (its own device / the desktop):

   ```bash
   BLAXIN_BRAIN_MODE=external BLAXIN_BRAIN_URL=wss://<brain-host>:3100/ws/brain npm run dev
   ```

4. **Pair** from the Body's API (loopback):

   ```bash
   curl -X POST http://127.0.0.1:3001/api/brain/connect \
     -H 'Content-Type: application/json' \
     -d '{"url":"wss://<brain-host>:3100/ws/brain","code":"AB7K-92QX"}'
   ```

   Watch the status until connected:

   ```bash
   curl http://127.0.0.1:3001/api/brain/status
   # → { "mode":"external", "bodyId":"BLX-BODY-XXXX",
   #      "brain": { "state":"CONNECTED", "brainId":"BLX-BRAIN-XXXX", ... } }
   ```

After pairing, the Body stores the Brain's **public key only** and every
future connection authenticates both directions with Ed25519
challenge/response signatures — no code required.

## Brain AI providers (the real LLM path)

The Brain owns the AI providers. Provider credentials stay on the Brain
device (encrypted credential store or environment variables) and never
enter the Brain↔Body protocol. To give the standalone Brain a real
model:

```bash
# Brain process — pick the active provider/model up front:
OPENROUTER_API_KEY=sk-or-... \
BLAXIN_BRAIN_PROVIDER=openrouter \
BLAXIN_BRAIN_MODEL=openrouter/auto \
npm run brain
```

Supported key env vars: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`,
`TOGETHER_API_KEY` (`ollama` needs no key). Keys can alternatively live
in the encrypted credential store on the Brain device. At boot the Brain
loads keys, honours `BLAXIN_BRAIN_PROVIDER` / `BLAXIN_BRAIN_MODEL`, and
otherwise auto-selects the first provider that is ready. If no
provider/model is configured, LLM tasks fail **honestly**
(`NO_PROVIDER` / `NO_MODEL`) — the Brain never guesses a model.

Operator control plane (loopback admin only, same gating as `/pairing`;
the Body never reaches these):

```
GET  /ai/status    # active provider/model + per-provider key/health
POST /ai/select    # { providerId, modelId? }
```

LLM reasoning runs as the `llm` task driver (the default). The driver
only ever *requests* structured actions and waits (bounded, honest
timeout) for the Body's result; it never executes anything itself, never
touches provider keys after configuration, and refuses to treat "the
model wanted a tool the Body does not offer" as a final answer
(`UNKNOWN_TOOL`, no fake completion).

## Device identity

- Every device generates a persistent Ed25519 keypair on first run.
- Identity ids are derived from the public key:
  `BLX-BRAIN-XXXX` / `BLX-BODY-XXXX` (a device cannot claim an id it
  does not own the key for).
- Private keys stay on their device (mode `0600` files under the data
  dir), never leave it, and are never logged, transmitted, put in
  telemetry, or committed.
- Identity files are validated on load; a tampered file is rejected and
  a fresh keypair is generated (rotation) rather than trusting the
  corrupted record.

## Protocol (Brain Protocol v1)

Every frame is a versioned envelope:

```
{ v, type, id, ts, from, deviceId, req?, payload? }
```

Message types: `hello`, `pair_request`, `pair_accept`, `pair_reject`,
`auth_challenge`, `auth_response`, `auth_result`, `ready`,
`capabilities`, `state_sync`, `state_sync_ack`, `ack`, `ping`, `pong`,
`task_start`, `task_update`, `task_action`, `action_result`,
`approval_required`, `approval_result`, `task_complete`,
`task_failed`, `error`, `revoked`.

Validation on every inbound frame:

- malformed envelopes, unknown types and direction-forbidden types are
  rejected (each role may only send its own message types)
- unsupported protocol versions are rejected
- protocol ranges are negotiated: `Body [1,2]` + `Brain [2,3]` → `2`;
  no intersection → `INCOMPATIBLE`, nothing executes
- payload/frame size caps (512 KB frames, 200 KB payload, bounded
  nesting depth)
- replay protection (duplicate message ids within a window are dropped)
- clock-skew rejection (frames more than 5 minutes from local time)

### Handshake order

1. Body dials the Brain (`/ws/brain`) and sends `hello` with its
   identity, protocol range and capabilities.
2. The Brain replies `hello` with its identity + the required mode:
   `auth` (already paired) or `pair` (unknown device).
3. `pair` → Body sends `pair_request` with the one-time code and its
   public key; the Brain validates the code, registers the device and
   answers `pair_accept` with its own public key. `revoked` is answered
   with rejection.
4. Authentication is bidirectional, every connection:
   - Body proves its key to the Brain (challenge → signature)
   - Brain proves its key to the Body (challenge → signature)
   Signatures bind both device ids and the fresh challenge, so a
   captured handshake cannot be replayed.
5. The Brain sends `ready`; the Body advertises its **tool schemas** and
   sends `state_sync`.

## Capabilities

The Body advertises only capabilities it can actually execute
(`filesystem`, `terminal`, `browser`, `screenshot`, `computer-control`,
`clipboard`, `search`, `system-info`, …). The Brain checks the
advertised set before requesting an action and the Body **re-checks on
every action**. An unsupported action is rejected safely — nothing is
ever assumed.

## Action execution (the security boundary)

When the Brain wants the Body to do something it sends `task_action`
with a structured action. The Body:

1. validates the message
2. checks the tool exists + is enabled (capability gate)
3. consults its executed-action ledger (duplicate protection)
4. applies replay safety (a non-idempotent action whose outcome is not
   recorded is refused, never blindly re-run)
5. runs the confirmation gate (same policy as the local orchestrator:
   high-impact tools / dangerous command patterns require user approval;
   timeout defaults to DENY)
6. executes through the existing `ToolRegistry` abstraction (never raw
   `child_process` from a Brain message)
7. persists the outcome to its ledger, then returns `action_result`

The Brain only ever receives the structured result.

## Reconnect & state

- Connection states: `DISCONNECTED`, `CONNECTING`, `AUTHENTICATING`,
  `CONNECTED`, `DEGRADED`, `RECONNECTING`, `REVOKED`, `INCOMPATIBLE`,
  `ERROR`.
- Heartbeats run both directions; a silent peer is detected and the
  link reconnects with exponential backoff + jitter
  (1s → 2s → 4s → 8s → 16s → 30s → 60s cap, reset after a stable
  connection). No reconnect storms; auth rejections stop retrying after
  a few attempts instead of hammering.
- The Body persists an **executed-action ledger** (bounded). If the
  Brain ever re-sends an action after a reconnect, the Body answers
  from the ledger instead of executing twice. Actions whose outcome
  cannot be proven are never guessed at.
- A task interrupted by a connection loss is reported honestly (never
  faked as complete). The Brain marks it interrupted; on reconnect the
  Body tells the user and the task can be re-sent.

## Revocation

- `POST /devices/:id/revoke` (loopback admin) permanently revokes a
  Body on the Brain. A revoked device is rejected on every future
  connection — its public key is no longer accepted. Revocation
  survives the disconnect handler and process restarts (persisted
  registry).
- The Body can also clear its saved pairing locally
  (`POST /api/brain/unpair`).

## Offline behavior

If the Brain disappears the Body reports `brain.state = RECONNECTING /
ERROR` honestly. Sending a task while offline returns
`BRAIN_OFFLINE` — no fake AI completion, no silent local fallback for
tasks that require reasoning. Safe deterministic local operations that
do not require the Brain remain available through the embedded fast
path when configured.

## Transport & security

- The transport is an abstraction (currently WebSocket / WSS). The Brain
  serves `/ws/brain` with the same origin validation as the main control
  plane (no-Origin non-browser clients allowed, browser origins
  allowlisted). WebSocket servers keep `perMessageDeflate` disabled and
  payload caps enforced.
- **WSS (TLS) on the Brain**: give the Brain a PEM key + certificate and
  it serves WSS *only* — a TLS-configured port never speaks plaintext,
  so a downgrade attempt dies at the TLS handshake:

  ```bash
  # generate a key + certificate (here self-signed for a LAN/private
  # deployment; include every DNS/IP name Bodies will use, e.g.
  # DNS:brain.local,IP:192.168.0.106):
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
    -keyout brain.key -out brain.crt -days 365 \
    -subj "/CN=brain.local" \
    -addext "subjectAltName=DNS:brain.local,DNS:localhost,IP:127.0.0.1,IP:192.168.0.106" \
    -addext "extendedKeyUsage=serverAuth"

  BLAXIN_BRAIN_TLS_KEY=brain.key BLAXIN_BRAIN_TLS_CERT=brain.crt npm run brain
  ```

- **Plaintext policy on the Body (the MITM fix)**: the Body *refuses*
  `ws://` to any non-loopback Brain address before a single byte is
  sent. A remote Brain must be reached over `wss://`. The explicit
  development override `BLAXIN_BRAIN_ALLOW_INSECURE=1` re-enables
  plaintext and skips certificate checks — it is logged on every use and
  never enabled by default.
- **Certificate validation is mandatory**: the Body always verifies the
  Brain's TLS certificate. A certificate signed by a private CA is
  provided to the Body with `BLAXIN_BRAIN_CA_FILE` (PEM bundle); with a
  publicly-trusted certificate nothing extra is needed. A certificate
  the Body does not trust fails CLOSED with actionable state (`ERROR`)
  — never a silent downgrade, never an endless reconnect loop.
- Brain HTTP surface: `GET /health`, `/version`, `/protocol`,
  `/capabilities`, `/pairing`, `POST /pairing/start`, `/pairing/cancel`,
  `GET /devices`, `GET /devices/:id`, `GET /registry/status`,
  `POST /devices/:id/revoke`, `DELETE /devices/:id`,
  `GET /ai/status`, `POST /ai/select` (present when an AI control-plane
  handle is attached). Admin endpoints default to loopback-only; they
  are served over the same TLS channel when WSS is enabled.
- **Registry realtime channel** `GET /ws/admin` (same origin policy as
  `/ws/brain`): on connect the Brain sends an authoritative `snapshot`;
  afterwards it pushes only meaningful registry changes — `body-added`,
  `body-updated`, `body-status`, `body-capabilities-updated`,
  `body-revoked`, `body-removed`. Heartbeats are sparse JSON pings; no
  per-heartbeat event spam.
- Provider/API keys live on the Brain device only and never enter the
  protocol. GitHub credentials are never part of pairing, the protocol,
  telemetry or logs.

### Transport env vars

| Variable | Purpose |
|----------|---------|
| `BLAXIN_BRAIN_TLS_KEY` / `BLAXIN_BRAIN_TLS_CERT` | Brain PEM file paths — when both are set the Brain serves WSS only |
| `BLAXIN_BRAIN_CA_FILE` | Body: PEM CA bundle that signed the Brain's certificate (private CAs / self-signed LAN) |
| `BLAXIN_BRAIN_ALLOW_INSECURE` | Body: `1` = explicit dev override permitting plaintext ws:// off-loopback and skipping cert checks |

### Threat model (what this closes)

- Message *authentication* is per-connection Ed25519 challenge/response
  (fresh nonces, both directions). Message *confidentiality/integrity*
  on the wire comes from TLS.
- **Plaintext MITM is closed**: the previously documented TOFU exposure
  (an attacker hijacking an unpaired `ws://` LAN connection could
  substitute their own key) is addressed two ways: the Body refuses
  plaintext to any non-loopback Brain, and over WSS the Brain's
  certificate is always verified — an impostor cannot present the
  Brain's key material or a certificate for its name. The remaining
  trust anchor for a *private* CA is installing that CA on the Body
  (`BLAXIN_BRAIN_CA_FILE`), the same trust model as any private PKI;
  with a publicly-trusted certificate no extra trust is needed.
- The full pairing UX over WSS (code generation over https, pairing,
  identity auth, reconnect, revocation) plus the certificate-rejection
  path is exercised by `wss-transport.test.ts` (in-process, real TLS)
  and `wss-e2e.test.ts` (two real processes over the machine's LAN
  address).

## Multi-Body Registry (B4)

The Brain keeps the **authoritative device registry** (one Brain → many
Bodies) and every management surface — the Desktop Brain Page today, a
future Web Console tomorrow — consumes the *same* Brain API and
realtime boundary. There is never a second registry on the UI side.

### Registry data & persistence

- Per Body: `bodyId`, `name`, public key (identity exchange), capability
  set, protocol range, connection status, `lastSeen`, `pairedAt`,
  `revokedAt`. **No private keys, pairing secrets or credentials ever
  enter the registry or the wire shape** (`toPublicBody` exposes public
  metadata only).
- Persisted atomically (tmp + rename) under the Brain data dir; a
  corrupt or partially-written file starts the registry empty (warned,
  never crashed). Duplicate body ids collapse to a single record.
- A **monotonic registry version** is incremented on every mutation and
  persisted with the records. Snapshots and events both carry it.

### Realtime synchronization

```
UI opens → GET /devices (authoritative snapshot + version)
        → GET /ws/admin (realtime events)
        → apply events only when event.version > last seen version
reconnect → GET /devices snapshot → reconcile → resume events
```

The version guard is the ordering rule: a stale event (older than the
last applied snapshot/event) can never overwrite newer state. The client
implementation lives in `client/src/utils/registry-sync.ts` and is
tested deterministically. The Brain never emits an event older than the
snapshot a reconnecting client receives — the registry is the single
source of truth.

### Routing & targeting safety

- Tasks are owned by the Body that starts them; `task_action` frames go
  only to that Body's connection and `action_result` frames are only
  accepted from the Body that owns the pending action (a forged result
  from another Body is dropped).
- The Brain pre-checks the selected Body's advertised capabilities
  before any frame leaves it (the Body's own capability/policy gate
  remains authoritative).
- A task whose Body drops mid-run fails honestly with `CONNECTION_LOST`
  — it is never silently rerouted to another Body.
- A second live connection for the same body id replaces the first
  without flipping the registry offline; the registry keeps one record.

### Revocation

Revocation is unchanged and terminal: a revoked Body stays revoked in
the registry, rejects authenticated traffic, cannot re-pair as trusted,
and renders as REVOKED in the management UI. The realtime channel pushes
`body-revoked` and every subsequent snapshot reflects it.

## Running the tests

```bash
cd server
npm test                       # full suite (embedded + distributed)
npx vitest run src/__tests__/distributed            # distributed layer
npx vitest run src/__tests__/distributed/two-process-e2e.test.ts   # 2 real processes, ws
npx vitest run src/__tests__/distributed/wss-e2e.test.ts           # 2 real processes, WSS+TLS
npx vitest run src/__tests__/distributed/llm-driver.test.ts         # LLM driver unit tests
npm run bench                  # performance guard rails
```

The distributed E2E spawns a real Brain process and a real Body server,
pairs them, executes a real filesystem action, restarts both processes
and verifies revocation. `brain-llm-integration.test.ts` drives the full
LLM task loop over real sockets with a scripted model and a real
filesystem tool (no credentials needed).

### Live provider validation (opt-in)

The full real-provider loop — real user task → real Brain process →
actual AI provider → action request → Body execution → final answer —
is covered by an opt-in two-process test that is **skipped by default**
and runs only when you supply a Brain-side provider key in your shell
(the key is never written to disk or committed):

```bash
cd server
OPENROUTER_API_KEY=sk-or-... \
BLAXIN_BRAIN_PROVIDER=openrouter \
BLAXIN_BRAIN_MODEL=openrouter/auto \
BLAXIN_LIVE_BRAIN_E2E=1 \
  npx vitest run src/__tests__/distributed/live-llm-brain.test.ts
```

Keyless local providers work too (`BLAXIN_BRAIN_PROVIDER=ollama`).
Verified in practice with `BLAXIN_BRAIN_MODEL=llama3.2:3b`: the model
called the Body's filesystem tool for real and the marker content came
back in its final answer (the printed `[live-e2e]` transcript shows
`thinking -> executing -> thinking -> completed`). Use a model with
tool-calling support and allow generous time — CPU inference takes ~30s
per reasoning step, which is why the test budget is 4 minutes. The live
test fails loudly on provider/model/key problems — it never fabricates
a result.

## Task cancellation & lifecycle (B5)

Tasks follow a canonical, Brain-authoritative lifecycle:
`QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED |
CONNECTION_LOST | UNKNOWN_OUTCOME | RECOVERING` (see
`distributed/types.ts` for the mapping used by registry, REST and UI
surfaces).

### Cancellation over the wire

The user can stop a running task from the Body UI. The Body sends a
dedicated `task_cancel` message (payload `{ taskId }`, Body→Brain
only). The Brain:

1. marks the task session `CANCELLED` immediately (`cancelRequested`),
2. sends a truthful `task_update { state: 'cancelled' }` to the Body,
3. resolves every still-pending `task_action` as a rejection with the
   explicit `CANCELLED_BY_USER` marker (never a fabricated result),
4. wakes the driver: the LLM driver races its in-flight provider call
   against a cancel sentinel, so cancellation is immediate — it does
   not wait for a full model turn,
5. answers with `task_failed { code: 'CANCELLED' }`, which the Body
   surfaces as a clean "Task stopped", not an error.

Cancellation is idempotent: a `task_cancel` for an unknown/finished
 task is acknowledged and ignored; a mismatched task id is an error.

### Duplicate `task_start` handling

A `task_start` while a task is already active on the same Body is
rejected (one task per Body at a time); the Brain answers honestly
instead of queueing a second concurrent task.

### Restart synchronization & recovery

After a Body reconnects (network blip, Body restart), the Brain
reconciles per-Body task sessions: interrupted tasks become
`CONNECTION_LOST`/`UNKNOWN_OUTCOME` rather than silently "running", and
recovery re-drives them through the normal driver path. Task ids are
replay-protected by the existing replay guard, so a reconnected Body
cannot re-deliver an already-completed task outcome.

## Design space (not implemented in v1.4.0)

Model router, Brain-owned memory store, LAN discovery, QR pairing,
relay transport, coordinated signed releases and update compatibility
are documented design space, not implemented features. v1.4.0 is the
final public release of BLAXIN, so these are recorded here as design
notes rather than planned work; the backend architecture (one Brain →
many Bodies, persistent device registry, protocol negotiation,
revocation) already supports them. Local models + Oracle Cloud
inference (implemented in v1.2.0 — see `docs/models.md` and
`docs/oci.md`) supply the Brain's model from the local machine or a
cloud shape.

### Multi-body test files

- `src/__tests__/distributed/multi-body-registry.test.ts` — two Bodies
  against one in-process Brain: routing isolation, capability
  pre-check, cross-body result integrity, duplicate identity,
  disconnect/reconnect, revocation, realtime events with monotonic
  versions, REST snapshot recovery (real sockets).
- `src/__tests__/distributed/multi-body-e2e.test.ts` — one Brain + two
  real Body processes: pairing, per-Body tasks, admin realtime events,
  revoking one Body without affecting the other.
- `registry-sync.test.ts` (server root) — the client's version-guarded
  reconcile/apply module, exercised from the server suite.
