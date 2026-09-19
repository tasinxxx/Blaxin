# BLAXIN Capabilities

What BLAXIN v1.4.0 can actually do. Every claim below is grounded in the source tree and the test suite; per-claim verification evidence lives in [blaxin/docs/capability-matrix.md](../blaxin/docs/capability-matrix.md). Where a capability depends on your environment (display server, audio stack, model hardware), that dependency is stated.

BLAXIN can execute verified multi-step computer workflows with bounded recovery — not "anything you imagine". The distinction matters: actions are checked against reality, failures are reported as failures, and where verification is impossible the result says so.

## At a glance

| Area | Capability | Grounding |
|---|---|---|
| Desktop | Mouse, keyboard, window management (X11 + partial Wayland) | `tools/computer-control.ts` |
| Desktop | Screen capture with OCR perception; screenshots carried to vision models | `tools/screenshot.ts`, `scripts/computer-use/perceive.py` |
| Desktop | Launch / focus / close apps with aliveness read-back | `tools/computer-control.ts` |
| Processes | List, inspect, kill by explicit pid — kills verified gone | `tools/process-control.ts` |
| Files | Read/write with read-back verification; organize, batch rename, move/copy/delete | `tools/filesystem.ts`, `tools/bulk-files.ts` |
| Files | Content-hash (SHA-256) duplicate detection and dedupe | `tools/bulk-files.ts` |
| Browser | Real Chrome via CDP: navigate, tabs, search, YouTube playback verification | `tools/browser.ts`, `tools/cdp-browser.ts` |
| Browser | Multi-field form fill with per-field read-back; verified submission; downloads | `tools/web-agent.ts`, `tools/verification.ts` |
| Terminal | Shell commands with timeouts; real exit codes as verdicts | `tools/terminal.ts` |
| System | Volume get/set/mute via PipeWire | `tools/system-audio.ts` |
| System | CPU / RAM / disk / network / battery telemetry | `utils/system-telemetry.ts`, `tools/system-info.ts` |
| Clipboard | Read/write with read-back verification | `tools/clipboard.ts` |
| Agents | Multi-step missions with checkpoints; bounded specialist agents | `utils/missions.ts`, `orchestrator/specialist.ts` |
| Agents | Deterministic recovery ladder and re-planning | `orchestrator/recovery-policy.ts` |
| Memory | Layered memory; verified runs become reusable procedures | `memory/layers.ts`, `memory/advisor.ts` |
| Models | Multi-provider cloud AI; local Ollama with hardware-fit recommendation | `providers/*`, `models/*` |
| Safety | Risk-tiered approval gate; protected paths; encrypted credentials | `utils/permission.ts`, `utils/security.ts` |
| Voice | Browser speech recognition + synthesis (feature-detected) | `client/src/hooks/useVoice.ts` |

## Computer control

- Mouse click / double-click / right-click / move / drag with pointer read-back (±2px where the display server reports it)
- **Screen-bounds grounding**: off-screen click/move/drag points are refused *before* any input is synthesized
- Keyboard typing, key presses, and combos with focus awareness (the real active window is read first)
- Window management: focus / close / minimize / maximize, verified against the real window list
- Closed-loop example proven at runtime: screenshot → OCR grounding → decision → smooth cursor travel → real click → observed teardown

*Environment note*: on Wayland, some read-backs (e.g. pointer position) are unavailable — the tool reports the action as not bounds-checked rather than guessing.

## Browser automation

BLAXIN drives real Google Chrome over the Chrome DevTools Protocol:

- Open URLs, session navigation (back/forward verified by the real CDP history index **and** the landing URL), refresh verified by document replacement
- Tabs: list, switch; current URL and page title are real reads
- **Form fill**: up to 20 fields per call, each verified by read-back after filling (inputs, selects matched by label or value, checkboxes)
- **Form submission**: the *outcome* is verified — navigation away from the origin, or the page's own confirmation text. "We clicked submit" is never evidence of success.
- **Downloads**: routed into a real directory and verified by filesystem read-back (file exists with a stable, non-zero size)
- YouTube search/play with playback-state verification

*Environment note*: requires Google Chrome installed on the system.

## Files & dedupe

- Read / write / create / delete / rename with **read-back verification** on every write
- Protected-path guardrails: system-critical and credential paths are hard-blocked
- `bulk-files`: organize-by-extension, batch move/copy/delete, bulk rename (prefix/suffix/replace)
- **Content-hash dedupe**: identity is the real SHA-256 of file bytes, never the filename; report mode is read-only; delete mode keeps one deterministic survivor per group and verifies every deletion
- Bounded scans: oversized or ambiguous operations are refused rather than truncated silently

## Process control

- `list`: structured table from real `ps` data (pid, cpu%, mem%, stat, uptime, command), bounded and sorted by real readings
- `inspect`: real details for one pid; unknown pids fail honestly
- `kill`: **explicit pid only** — observe first (real command line as evidence), SIGTERM with a bounded exit poll, optional SIGKILL escalation. SUCCESS only when a fresh read-back shows the process really gone. init/kernel and BLAXIN's own process are refused with zero signals. Name-based kills ("kill the browser") are never routed — the LLM loop lists first, inspects, then kills by pid.

## Terminal & system

- Shell commands with timeout protection and dangerous-command confirmation; a nonzero exit code is a failure even when stdout looks fine
- Volume control through PipeWire with get→set→get read-back verification
- Real telemetry: CPU (tick-delta), memory, disk, network rates, uptime, battery (when `/sys/class/power_supply` exists)
- Clipboard read/write verified by read-back

## Missions, specialists & recovery

- **Missions**: persistent multi-step missions with per-step checkpoints — pause and resume from the last completed checkpoint, retry only failed steps, real progress reporting, cancellation propagates to queued/running tasks
- **Specialist ownership**: the first real tool activation claims the task as a bounded specialist objective (browser/files/terminal/…) with explicit action/recovery/replan budgets and a wall-clock deadline; results are terminal, emitted exactly once, and honest
- **Mission coordination**: specialist evidence binds to mission steps; `{{evidence:stepId}}` templates resolve only from *verified* evidence; mission-level verification is VERIFIED only when every completed step verified
- **Recovery**: a deterministic ladder — retry/backoff → re-observe → alternate path → one re-plan → model escalation only after budgets are exhausted

## Memory & learning

- Layered stores: failures, environment, episodes, procedures — with secret redaction (secrets are refused, never stored)
- A relevance-gated, budget-capped advisor injects background context into the system prompt; the current instruction always outranks memory
- **Learning loop**: verified multi-step runs (≥2 steps, no failures) promote reusable procedures; procedures the advisor selected are failure-accounted by record id on failed runs; repeated failures trip auto-rollback so stale procedures stop surfacing
- Everything inspectable: Memory page in the HUD and `GET /api/memory/layers`

## Models & routing

- Cloud providers: OpenRouter (first-class), OpenAI, Anthropic, Google, Groq, Together
- **Local-first**: Ollama with real hardware discovery (CPU/RAM/GPU/VRAM/disk), a curated catalog, and a deterministic recommendation that fits your machine — no invented benchmarks, no unearned READY status
- **Adaptive routing**: capability-aware model selection from real model data, bounded reliability demotion, honest BLOCK when no model fits the task
- Optional Oracle Cloud inference node with a loopback SSH tunnel (never a public port)

## Safety & security

- Risk-tiered permission gate (LOW → CRITICAL); high-impact actions pause the agent and require explicit approval (once / per-task / per-session scopes)
- Confirmation gate UI with deny as the safe default (Escape denies)
- Filesystem writes/deletes hard-blocked on system-critical and credential paths
- AES-256-CBC encrypted credential storage with `0600` permissions; keys never logged, never sent to the frontend
- Origin-checked WebSocket/HTTP APIs; desktop backend binds to `127.0.0.1` only
- See [SECURITY.md](../SECURITY.md) for the full model

## Voice

- Speech recognition and synthesis through browser APIs, feature-detected with an honest state machine
- *Environment note*: physical microphone/speaker behavior depends on your browser and audio hardware

## What BLAXIN deliberately does not do

- No messaging-platform automation (e.g. WhatsApp) — a documented non-goal
- No widgets that pretend to show data BLAXIN does not really have
- No fabricated benchmarks, simulated success states, or unverified claims — `UNKNOWN` never becomes `SUCCESS`

## Verification evidence

The capability matrix in [blaxin/docs/capability-matrix.md](../blaxin/docs/capability-matrix.md) maps every capability to its source location and pinned tests. The v1.4.0 release notes ([blaxin/update/RELEASE-NOTES-v1.4.0.md](../blaxin/update/RELEASE-NOTES-v1.4.0.md)) record the real-machine verification run: 921 passed / 16 skipped / 0 failed server suite, 10/10 E2E, and runtime probes on the compiled dist (process-control 7/7, bulk-dedupe 14/14, browser-forms 10/10 on real Chrome, browser-specialist 14/14, computer-use 9/9 on real Xvfb, model-routing 16/16 with real local inference).
