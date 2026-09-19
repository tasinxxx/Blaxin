# Getting Started with BLAXIN

A walkthrough from install to your first verified task. For the one-command install and downloads, see the [README](../README.md#installation-linux-x86_64).

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/tasinxxx/Blaxin/main/blaxin/install.sh | bash
```

The installer resolves the latest stable release (v1.4.0 — the final public release), verifies the SHA-256 checksum, and installs the right package for your distro:

- **Debian / Ubuntu / Kali / Mint / Pop!_OS** → the `.deb` package (runs against your system WebKitGTK — the most reliable configuration)
- **Other distros** → the portable AppImage in `/opt/blaxin` plus a desktop entry
- Force the AppImage anywhere: append `-s -- --appimage` to the command

<details>
<summary>Verify the download manually</summary>

Every release ships `.sha256` sidecars:

```bash
sha256sum -c BLAXIN_1.4.0_amd64.AppImage.sha256
```

</details>

## 2. First launch

Start BLAXIN from your application menu, or run:

```bash
blaxin
```

The boot overlay disappears once the HUD connects to the real backend (both are bundled in the desktop app). The setup wizard then walks you through provider configuration.

## 3. Configure an AI provider

BLAXIN needs a model to reason with. Two paths:

### Local (no API key, no cloud)

1. Install [Ollama](https://ollama.ai) — or click **Install** on the Models page and BLAXIN will install and start it for you
2. Pull a model (e.g. `ollama pull llama3`, or use **PULL** on the Models page)
3. BLAXIN auto-detects the daemon, shows your real machine specs (CPU/RAM/GPU/VRAM/disk), and recommends the catalog model that actually fits

### Cloud

1. Pick a provider in **Settings → Providers**:
   - **OpenRouter** (recommended — one key, many models, free-tier detection)
   - OpenAI, Anthropic, Google, Groq, Together
2. Create an API key on the provider's site
3. Paste the key, click **Validate & Save** — keys are AES-256-CBC encrypted at rest and never logged or sent to the UI

> **No provider configured?** Deterministic commands still work — try `/status` or `list /tmp`. The full reasoning loop needs a model.

## 4. Your first task

Type a plain-language instruction into the composer:

```text
list the contents of /tmp
```

Watch the flow: the deterministic fast path executes it with zero model calls and reports the real route (DETERMINISTIC). The agent terminal shows the event stream: route → action → observation → result.

Now something multi-step:

```text
organize ~/Downloads by type
```

This runs as a mission with real steps. If anything is high-impact (deleting, moving files), the **confirmation gate** appears first — approve once, for the task, for the session, or deny. After completion, the Mission panel shows per-step verification and the Mission Journal records what actually happened.

## 5. Everyday commands

| Say / type | What happens |
|---|---|
| `open https://github.com` | Real Chrome opens the URL (gated) |
| `organize ~/Downloads by type` | Mission: files sorted into extension folders, verified |
| `find duplicate files in ~/Pictures` | SHA-256 dedupe report (read-only) |
| `what processes are running` | Bounded process table from real `ps` data |
| `kill 4321` | Observe → SIGTERM → verified-gone confirmation (gated) |
| `set volume to 40` | PipeWire volume change, read-back verified |
| `take a screenshot` | Real capture, validated as PNG |
| `/status` `/queue` `/missions` `/memory` `/help` | Slash commands for runtime introspection |

## 6. Where your data lives

| Data | Location |
|---|---|
| Config, encrypted credentials | `~/.local/share/blaxin` (or the app's data dir) |
| Session state, memory, journal | under the same data dir (`.blaxin-state/`) |
| API keys | encrypted with AES-256-CBC, `0600` permissions, never logged |

Nothing is sent anywhere except to the AI provider you configured (or your local Ollama). There is no telemetry.

## 7. Troubleshooting & next steps

- Problems installing or launching → [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- What the tools actually verify → [CAPABILITIES.md](CAPABILITIES.md)
- How the pieces fit together → [ARCHITECTURE.md](ARCHITECTURE.md)
- Remote/self-hosted deployment → `blaxin/docker-compose.yml` and `blaxin/.env.example`
- Still stuck → [open an issue](https://github.com/tasinxxx/Blaxin/issues/new?template=bug_report.yml)
