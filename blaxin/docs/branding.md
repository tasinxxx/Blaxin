# BLAXIN Branding

This document describes the official BLAXIN brand assets, where they live,
how the application icon set is generated, and how production packaging
consumes them.

## Official logo (source of truth)

The official BLAXIN brand mark — the geometric letter "B" (white mark on a
black square) — is stored in the repository so builds never depend on a file
on any individual machine:

```
blaxin/brand/blaxin-logo-source.png
```

The current asset is the user-supplied `blaxinlogo2.png` (integrated
2026-09-15). When the official asset is updated on a machine, copy the file
into the path above (never reference the filesystem path directly) and
regenerate the derived assets per the instructions below.

All derived assets are generated from this single file. The logo design is
never redrawn or altered; derived assets only scale it, composite it on
brand black, or add padding.

## Generated assets

Run from the repository root (requires Pillow):

```bash
python3 blaxin/brand/generate-icons.py
```

This produces:

| Asset | Purpose |
|-------|---------|
| `blaxin/brand/blaxin-mark.png` | 1024px master brand mark (RGBA) |
| `blaxin/brand/blaxin-mark-dark.png` | mark composited on brand black |
| `blaxin/brand/blaxin-wordmark.png` | mark + BLAXIN wordmark lockup (README/docs) |
| `blaxin/src-tauri/icons/32x32.png` | Tauri window/taskbar icon |
| `blaxin/src-tauri/icons/128x128.png` | Tauri window/taskbar icon |
| `blaxin/src-tauri/icons/128x128@2x.png` | Tauri window/taskbar icon (HiDPI) |
| `blaxin/src-tauri/icons/icon.png` | Tauri bundle/installer icon (512px) |
| `blaxin/client/public/blaxin-mark.png` | frontend favicon + in-app brand mark |

## How packaging consumes the icons

- **Tauri**: `src-tauri/tauri.conf.json` lists the four icons under
  `bundle.icon`. Tauri embeds them into the window icon, tray icon,
  AppImage and `.deb` packages (`.desktop` launcher + hicolor icon set).
- **Frontend**: `client/index.html` references `/blaxin-mark.png` as the
  favicon; the Sidebar, Setup Wizard welcome screen and Chat empty state
  import the same mark from `client/public/`.
- **Installer**: `install.sh` extracts the bundled icon from the AppImage
  into `/usr/share/pixmaps/blaxin.png` for the `blaxin.desktop` launcher.
- **CI**: `.github/workflows/release.yml` regenerates nothing (assets are
  committed) but converts all icons to 8-bit RGBA PNG32 before building,
  which the generated set already satisfies.

## Updating the brand assets

1. Replace `blaxin/brand/blaxin-logo-source.png` with the new official
   asset (same design intent: square, mark on black).
2. Run `python3 blaxin/brand/generate-icons.py`.
3. Commit the refreshed source + generated assets together.
