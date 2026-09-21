# BLAXIN cross-platform build & release — v1.4.0 overlay pack

**v1.4.0 stays the final numbered release.** The `v1.4.0` tag is never moved
or rewritten. This directory contains everything `.github/workflows/ci/build-platforms.yml`
needs to produce real native macOS and Windows artifacts **from the exact
v1.4.0 tag commit** and attach them to the **existing** v1.4.0 GitHub
Release, next to the original Linux artifacts.

## Contents

| File | Purpose |
|---|---|
| `lib.rs.patch` | The only source delta needed: (1) `find_bundled_node` probes `node.exe` on Windows in addition to the original `node` path; (2) a `#[cfg(not(unix))]` no-op `ignore_sighup()` so the unconditional call site in `run()` compiles on Windows. Applies cleanly to the v1.4.0 tag (verified with `git apply --check`). |
| `tauri.macos.conf.json` | Tauri CLI config overlay for macOS builds: adds the `dmg` + `app` bundle targets, updater endpoints/public key, and `minimumSystemVersion` 10.15. Overlaid with `--config`; `tauri.conf.json` in the tag is never modified. |
| `tauri.windows.conf.json` | Tauri CLI config overlay for Windows builds: NSIS target (per-user install, bundled WebView2 bootstrapper). Updater artifacts are intentionally disabled (`createUpdaterArtifacts: false`) until signed Windows artifacts are wired into `latest.json` — the manifest currently declares Linux platforms only, and no unverified update path is enabled. |

## Why nothing else is needed

- The **backend is pure-JS** (`ws`, `express`, `cors` — no native modules), so
  the bundled server is identical on every OS.
- `build.rs` and `lock.rs` are already cross-platform (`pid_alive` is
  `cfg`-guarded; the data dir resolution has a `HOME`/temp fallback).
- `terminate_server` / process-group handling are `#[cfg(unix)]` guarded with
  a working non-unix fallback (`kill` + `wait`), and the SIGHUP suppression
  in `lib.rs` now has a matching non-unix no-op.
- On Linux, the overlay is a no-op: CI builds the AppImage/deb exactly as
  `release.yml` did for v1.4.0, and the patch's non-Windows candidate order
  keeps the original `node` path first.

## How CI applies it

1. `checkout` at `refs/tags/v1.4.0` (never a branch, never the tag itself).
2. `git apply scripts/platform-overlay/v1.4.0/lib.rs.patch`.
3. `cargo tauri build --config scripts/platform-overlay/v1.4.0/tauri.<os>.conf.json …`
4. Upload artifacts to the existing v1.4.0 release via the GitHub Releases
   API (`uploads.github.com`, asset names carry the OS/arch). The workflow is
   `workflow_dispatch`-triggered; it never creates a release, tag, or
   version bump.
5. SHA-256 checksums are generated and uploaded for every artifact; the
   installers verify them before executing anything.
