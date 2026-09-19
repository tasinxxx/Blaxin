# Troubleshooting

Known issues and fixes for BLAXIN v1.4.0. If your problem isn't here, please [open a bug report](https://github.com/tasinxxx/Blaxin/issues/new?template=bug_report.yml) — including the Mission Journal excerpt (Journal page in the HUD) makes diagnosis much faster.

## AppImage shows a blank window

**Symptom**: the AppImage launches, `[BLAXIN] Server is ready!` appears in the logs (the bundled backend is fine), but the window stays gray/black.

**Cause**: the AppImage bundles the WebKitGTK/GTK/GLib stack of the CI build machine. On some hosts the bundled `WebKitWebProcess` cannot initialize EGL and aborts with `Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...`. This is a known upstream Tauri/WebKitGTK AppImage limitation (tauri#11988), not caused by BLAXIN's own code — the identical build renders correctly against the system WebKitGTK.

**Fix**: on Debian-family distros use the `.deb` package instead — it runs against your system WebKitGTK and is the most reliable configuration:

```bash
sudo apt install ./blaxin_1.4.0_amd64.deb
```

The generic WebKit environment variables (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`) do **not** fix this failure mode. On non-Debian distros, running from source (`./start.sh`) is the workaround.

## Wrong BLAXIN binary runs after installing the .deb

The `.deb` installs `/usr/bin/blaxin`. A previously installed AppImage wrapper at `/usr/local/bin/blaxin` can shadow it. Re-running the installer fixes this automatically (it moves the stale launcher aside); to fix manually:

```bash
readlink -f /usr/local/bin/blaxin   # should match /usr/bin/blaxin
sudo rm /usr/local/bin/blaxin       # if it points to /opt/blaxin instead
```

## Wayland: pointer position / bounds checks unavailable

Desktop control works on Wayland via xdotool where supported, but some display servers do not report the pointer position back. BLAXIN treats this honestly: mouse actions proceed but are reported as **not bounds-checked / not read-back-verified** instead of claiming success. For full verification support, use an X11 session.

## Chrome automation does not start

Browser automation drives real Chrome over CDP.

- Install Google Chrome (`google-chrome` on PATH)
- Check that Chrome launches normally outside BLAXIN
- Closed Chrome instances with stale debugging profiles can block CDP launch — close all Chrome windows and retry

## Ollama not detected

1. Confirm the daemon is up: `ollama serve` (default loopback `127.0.0.1:11434`)
2. If you run Ollama elsewhere, set `BLAXIN_OLLAMA_HOST` / `BLAXIN_OLLAMA_PORT` and restart
3. The Models page shows truthful runtime status — if it says not ready, the round trip really has not succeeded yet

## Model recommendations look wrong for my hardware

Recommendations come from real hardware discovery (CPU/RAM/GPU/VRAM/disk). If the detected specs look wrong, the Models page is reading real system data — check that your hardware is visible to the OS (e.g. GPU drivers installed). BLAXIN never invents benchmark numbers; it recommends from the catalog against what your machine reports.

## Provider key rejected

- OpenRouter keys live at https://openrouter.ai/keys — copy the full key
- Make sure the key has credit/quota available for the selected model
- Free models exist on OpenRouter; BLAXIN detects and recommends them
- Keys are stored encrypted locally; if a validation round trip fails, the provider will say why — BLAXIN shows the real provider error, not a generic one

## The agent is waiting for approval

High-impact actions (deletes, destructive shell commands, installs, browser/desktop actions) pause the agent and open the confirmation dialog. The dialog's safe default is **Deny** — Escape denies and the step is recorded as DENIED + SKIPPED, never executed. If you do not see the dialog, check the agent terminal and task queue for state.

## A task failed — what actually happened?

Open the **Journal** page in the HUD (or `GET /api/journal`): every command, plan, action, observation, verification result, and recovery attempt is recorded as it really happened, including honest FAILURES and UNVERIFIED states. Failed missions can be retried from the last completed checkpoint (retry only failed steps).

## Still stuck?

- [Search existing issues](https://github.com/tasinxxx/Blaxin/issues)
- [Open a bug report](https://github.com/tasinxxx/Blaxin/issues/new?template=bug_report.yml) — include your distro, display server (X11/Wayland), how you installed, and the journal excerpt
