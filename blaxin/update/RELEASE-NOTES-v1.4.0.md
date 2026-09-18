# BLAXIN v1.4.0 — Jarvis HUD milestone

The Jarvis command layer: a real mission backend (TaskQueue, missions, scheduler, commands, security log) behind a functional HUD, plus the full Phase-B capability chain — every feature below verified on the real machine, not claimed.

## Highlights

- **Jarvis HUD** — real-time command surface backed by the real agent runtime (state reflection, mission journal, activity feed, task queue, neural status, network hub, memory bank, security vault).
- **Multi-specialist mission coordination** — bounded objective ownership, specialist delegation with honest settlement, deterministic auto-recovery and re-planning.
- **Verified filesystem writes** — every write proven by read-back compare; content-hash (SHA-256) duplicate detection and deterministic dedupe.
- **Closed-loop computer use** — screen-bounds grounding, smooth pointer travel, focused-window awareness, OCR grounding; verified screenshots carried to the model.
- **Process control** — list/inspect/kill with observe-first evidence, verified kills, protected-pid and self-kill guards (zero signals on refusal).
- **Browser agent** — verified form fill with per-field read-backs, honest submit outcomes via real page-transition verification, disk-verified downloads.
- **Adaptive model routing** — capability-aware selection from real model data, bounded reliability demotion, honest BLOCK when no model fits; system-awareness sensors.
- **Memory learning loop** — procedure promotion from verified multi-step runs, failure accounting by record id, auto-rollback of stale procedures.
- **System audio** — real PipeWire capture and verified volume control.
- **Accessibility + performance** — landmarks, tablists, live-region discipline, pause/stop for moving content; bounded client buffers, halved particle pair-scan.
- **Security** — production dependency audits clean (0/0); dead dependencies removed with byte-identical dist proof.

## Verification at this tag

- Server test suite: **921 passed / 16 skipped / 0 failed** (two consecutive green full runs)
- End-to-end (real backend + vite + Chrome): **10/10 PASS**
- Runtime probes on the real compiled dist: process-control 7/7 · bulk-dedupe 14/14 · browser-forms 10/10 (real Chrome) · browser-specialist 14/14 · computer-use 9/9 (real Xvfb) · model-routing 16/16 (real local inference)
- `npm audit --omit=dev`: **0 vulnerabilities** (server and client)
- Version 1.4.0 consistent across VERSION, tauri.conf.json, Cargo.toml, client, server

## Artifacts

| File | Size | SHA-256 |
|---|---|---|
| `BLAXIN_1.4.0_amd64.AppImage` | 116,615,672 B | `a644d5cc6d550cdf008f0a80ba637d024e68bc792ab5ebd55d069a5ec72336fe` |
| `BLAXIN_1.4.0_amd64.deb` | 43,155,586 B | `76a49d64ac535bf2c23ddd6199371b4e79cca6ca03f98ed9adc032cab5b8486f` |

Canonical release artifacts built and signed by GitHub Actions (run 35251870749) from exactly this commit on ubuntu-22.04, with `.sig` + `.sha256` sidecars and the signed `latest.json` updater manifest. Verified on disk (ELF static-pie / dpkg-deb) and by `sha256sum -c` after re-download; all seven assets on the release are byte-identical to the CI artifact set.

## Updater note

The v1.4.0 updater artifacts are signed in CI (GitHub Actions run 35251870749) with the repository's `TAURI_SIGNING_PRIVATE_KEY`, which is kept out of the repository by design. The in-app update manifest (`blaxin/update/latest.json`) points at the signed v1.4.0 assets; users on v1.3.0 receive the update in-app, or can install the `.deb` / AppImage below directly.

## Honest limitations

- The LLM decision stage in computer use remains `unverified-fallback` until a vision-capable model is available; routing selects one automatically when it exists.
- Voice physical round trip and a live screen-reader (NVDA/Orca) pass remain environment-blocked in this build environment.
