// ═══════════════════════════════════════════════════════════════════════
// BLAXIN — platform abstraction layer
//
// One place that answers "what is this OS and which native commands do we
// use for X?" so the individual tools stay readable. Design rules:
//
//   1. LINUX BEHAVIOR IS UNCHANGED. Every candidate list below puts the
//      exact same commands BLAXIN v1.4.0 used on Linux first, in the same
//      order. The v1.4.0 Linux contract is frozen.
//   2. NO FAKE SUCCESS. A platform without a capability reports that
//      honestly (the tools keep their honest-unavailable error paths);
//      this module only supplies candidates — availability is still
//      probed at execution time.
//   3. Small surface, no dynamic imports, no IO — trivially testable.
// ═══════════════════════════════════════════════════════════════════════

import { release } from 'os';

export type Platform = 'linux' | 'darwin' | 'windows';

export function currentPlatform(): Platform {
  switch (process.platform) {
    case 'darwin': return 'darwin';
    case 'win32': return 'windows';
    default: return 'linux';
  }
}

/** True when the OS reports Windows (incl. WSL — win32 process platform). */
export function isWindows(): boolean {
  return process.platform === 'win32';
}

/** True on WSL (Windows process platform only; kernel reports microsoft). */
export function isWsl(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    return /microsoft/i.test(release());
  } catch {
    return false;
  }
}

// ── Shell for terminal sessions / commands ─────────────────────────────
// Linux/macOS keep the exact v1.4.0 behavior: $SHELL, then /bin/bash.
// Windows uses PowerShell when present (COMSPEC fallback), matching
// process.env semantics without spawning cmd.exe for every keystroke.

export function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

/** Default home/cwd for terminal sessions (v1.4.0 semantics on unix). */
export function defaultCwd(): string {
  if (process.platform === 'win32') {
    // Guard the fallback chain: HOMEDRIVE without HOMEPATH must not
    // concatenate `undefined` into the result ('C:' + undefined = "C:undefined").
    const profile = process.env.USERPROFILE;
    if (profile) return profile;
    const { HOMEDRIVE, HOMEPATH } = process.env;
    if (HOMEDRIVE && HOMEPATH) return HOMEDRIVE + HOMEPATH;
    return 'C:\\';
  }
  return process.env.HOME || '/tmp';
}

// ── Open-with-the-OS-handler (files, folders, URLs) ────────────────────
// Linux: xdg-open first (v1.4.0 contract); macOS: open; Windows: start
// (a cmd builtin, so it must go through the shell — documented, no user
// input is ever interpolated into it; callers pass argv, not strings).

export interface OpenWithHandler {
  cmd: string;
  /** Prepend argv (Windows `start` needs `cmd /c start`). */
  prefix: string[];
}

export function openHandler(): OpenWithHandler | null {
  switch (currentPlatform()) {
    case 'linux': return { cmd: 'xdg-open', prefix: [] };
    case 'darwin': return { cmd: 'open', prefix: [] };
    case 'windows': return { cmd: 'cmd.exe', prefix: ['/c', 'start', ''] };
  }
}

// ── Clipboard candidates (tried in order; first hit wins) ─────────────

export function clipboardReaders(): string[] {
  switch (currentPlatform()) {
    case 'linux': return ['xclip', 'xsel', 'wl-paste'];
    case 'darwin': return ['pbpaste'];
    case 'windows': return ['powershell.exe'];
  }
}

export function clipboardWriters(): string[] {
  switch (currentPlatform()) {
    case 'linux': return ['xclip', 'xsel', 'wl-copy'];
    case 'darwin': return ['pbcopy'];
    case 'windows': return ['powershell.exe'];
  }
}

/** Human-readable hint when no clipboard tool works on this platform. */
export function clipboardUnavailableHint(): string {
  switch (currentPlatform()) {
    case 'linux': return 'Install xclip, xsel, or wl-clipboard.';
    case 'darwin': return 'pbcopy/pbpaste are part of macOS and should always exist.';
    case 'windows': return 'Clipboard access uses PowerShell (Get-Clipboard / Set-Clipboard), bundled with Windows.';
  }
}

// ── Screenshot capture candidates ──────────────────────────────────────

export function screenshotTools(): Array<{ name: string; cmd: string; args: string[] }> {
  switch (currentPlatform()) {
    case 'linux':
      // Frozen v1.4.0 Linux order — do not reorder.
      return [
        { name: 'scrot', cmd: 'scrot', args: [] }, // path appended by caller
        { name: 'gnome-screenshot', cmd: 'gnome-screenshot', args: ['-f'] },
        { name: 'import', cmd: 'import', args: ['-window', 'root'] },
      ];
    case 'darwin': {
      // -x = no capture sound; the timestamp suffix keeps concurrent
      // captures from overwriting each other's file.
      return [{ name: 'screencapture', cmd: 'screencapture', args: ['-x'] }];
    }
    case 'windows':
      // Full-screen capture via PowerShell; the caller supplies the
      // -Command script (windowsScreenshotScript) as the final argv entry.
      return [{ name: 'powershell-screenshot', cmd: 'powershell.exe', args: [] }];
  }
}

/** PowerShell script (Windows) that captures the full screen to a PNG path. */
export function windowsScreenshotScript(destPath: string): string {
  return [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;',
    '$g = [System.Drawing.Graphics]::FromImage($bmp);',
    '$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size);',
    `$bmp.Save('${destPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    '$g.Dispose(); $bmp.Dispose();',
  ].join(' ');
}

// ── Browser binaries (CDP automation) ──────────────────────────────────

export function chromiumCandidates(): string[] {
  switch (currentPlatform()) {
    case 'linux':
      // Frozen v1.4.0 Linux order — do not reorder.
      return ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
    case 'darwin':
      return ['Google Chrome', 'Chromium'];
    case 'windows':
      return ['chrome.exe', 'msedge.exe'];
  }
}

/** Well-known absolute install paths probed before PATH lookup. */
export function chromiumAbsolutePaths(): string[] {
  switch (currentPlatform()) {
    case 'linux': return [];
    case 'darwin':
      return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    case 'windows': {
      const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
      const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      const lf = process.env['LOCALAPPDATA'] || '';
      return [
        `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
        `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
        `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ...(lf ? [`${lf}\\Google\\Chrome\\Application\\chrome.exe`] : []),
      ];
    }
  }
}

// ── Input automation / desktop control ─────────────────────────────────
// Desktop input on macOS/Windows needs an OS-specific automation stack
// (AppleScript / UI Automation). The tools report honest unavailability
// on those platforms; these helpers centralize the messaging.

export function computerUseUnsupportedReason(): string | null {
  if (currentPlatform() === 'linux') return null;
  if (currentPlatform() === 'darwin') {
    return 'Desktop input automation is not available on macOS in BLAXIN v1.4.0 (X11/xdotool tooling only). Browser, filesystem, process and terminal control remain available.';
  }
  return 'Desktop input automation is not available on Windows in BLAXIN v1.4.0 (X11/xdotool tooling only). Browser, filesystem, process and terminal control remain available.';
}
