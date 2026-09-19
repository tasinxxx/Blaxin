# Security Policy

## Supported version

| Version | Supported |
|---|---|
| 1.4.0 | ✅ Current and final public release |
| < 1.4.0 | ❌ Please update via the in-app updater or the [release page](https://github.com/tasinxxx/Blaxin/releases) |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, open a **private security advisory** via [GitHub's security advisories](https://github.com/tasinxxx/Blaxin/security/advisories/new). Include:

- A description of the issue and its impact
- Step-by-step reproduction instructions (proof-of-concept code welcome)
- Affected version(s) and component(s)

You will receive a response as soon as possible, and — once a fix is ready — full credit in the advisory if you wish. Please allow reasonable time for a fix before any public disclosure.

## Security model

BLAXIN is an agent that executes actions on a real computer, so its security posture is part of the product:

### Approval gates

- Every tool action is classified into a **risk tier** (LOW → CRITICAL) by `blaxin/server/src/utils/permission.ts`
- High-impact actions (deletes, destructive shell commands, installs, browser/desktop actions) **pause the agent** and require explicit user approval: once, for the task, or for the session
- The confirmation dialog's safe default is **Deny**; Escape denies; denying never executes the action (the step is recorded DENIED + SKIPPED)

### Filesystem guardrails

- Writes and deletes are **hard-blocked** on system-critical and credential paths (`/etc`, `/boot`, `~/.ssh`, key files, etc.)
- File writes are verified by read-back compare; deletes by verified absence
- Bulk operations are bounded — oversized scans are refused, not truncated silently

### Credential protection

- API keys are encrypted with **AES-256-CBC** and stored with `0600` permissions
- Keys are never logged, never included in errors, and never sent to the frontend
- The memory store **refuses** secret-looking content; secrets are masked in logs and diagnostics
- Process `kill` refuses protected pids (init/kernel, BLAXIN itself) with zero signals

### Network posture

- The desktop app binds the bundled backend to **`127.0.0.1` only**
- Every WebSocket upgrade and state-changing HTTP request is **origin-checked**: localhost, the Tauri desktop origin, and any extra origins listed in `BLAXIN_ALLOWED_ORIGINS`
- For self-hosted web deployments, set `BLAXIN_ALLOWED_ORIGINS` explicitly — see `blaxin/.env.example` and `blaxin/docker-compose.yml`
- The optional Distributed Brain uses Ed25519 device identities, one-time pairing codes, bidirectional challenge/response auth, and (optionally) TLS; provider API keys stay on the Brain device and never travel the protocol

### Updater integrity

Release artifacts are built and signed by CI (minisign-based Tauri updater signatures), with SHA-256 sidecars; the installer verifies checksums before installing. `blaxin/update/latest.json` points only at the canonical release URLs.

## Known limitations (honest disclosure)

- BLAXIN grants an AI agent real control of your desktop — the approval gate is the safety boundary. Review what you approve.
- A self-hosted web deployment exposes the agent's API to network clients by design; the origin allow-list plus TLS termination is your boundary there.
- Browser automation drives your real Chrome profile; use the confirmation gate rather than blanket session approvals on untrusted content.
- The updater signature verifies artifacts, not the model outputs you feed it — prompt content from web pages can influence an agent mid-task; keep approvals task-scoped on sensitive machines.

## Scope notes

The Docker images are scanned by CI (Trivy, results in the GitHub Security tab). If you find an issue in a dependency rather than BLAXIN's code, a standard issue is fine after checking it is not already tracked upstream.
