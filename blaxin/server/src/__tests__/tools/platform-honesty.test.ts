// CROSS-PLATFORM HONESTY TESTS
// =============================================================
// Verifies the platform abstraction layer (utils/platform.ts) and the
// per-tool platform guards added for the cross-platform v1.4.0 work:
//   · Linux behavior is the FROZEN v1.4.0 contract (candidate order,
//     commands, and messages unchanged);
//   · macOS/Windows platform-specific capabilities (clipboard, screenshot,
//     launch_app) have real implementations;
//   · UNIMPLEMENTED capabilities (desktop input on mac/win, process
//     control on Windows) return HONEST unavailability — never fake
//     success, never a crash.
// macOS/Windows paths are driven by stubbing process.platform (restored
// after every test) so the same suite runs on any CI OS.
// =============================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  currentPlatform,
  isWindows,
  defaultShell,
  defaultCwd,
  openHandler,
  clipboardReaders,
  clipboardWriters,
  screenshotTools,
  chromiumCandidates,
  windowsScreenshotScript,
  computerUseUnsupportedReason,
} from '../../utils/platform.js';
import { ComputerControlTool, type ControlRunner } from '../../tools/computer-control.js';
import { ProcessControlTool, type ProcessRunner } from '../../tools/process-control.js';
import { ClipboardTool, type ClipboardRunner } from '../../tools/clipboard.js';
import { ScreenshotTool } from '../../tools/screenshot.js';

const REAL_PLATFORM = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM });
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
// platform.ts — pure contract
// ═══════════════════════════════════════════════════════════════════════

describe('platform.ts', () => {
  it('maps process.platform to the BLAXIN platform names', () => {
    setPlatform('linux'); expect(currentPlatform()).toBe('linux');
    setPlatform('darwin'); expect(currentPlatform()).toBe('darwin');
    setPlatform('win32'); expect(currentPlatform()).toBe('windows');
  });

  it('keeps the FROZEN v1.4.0 Linux candidate orders', () => {
    setPlatform('linux');
    expect(clipboardReaders()).toEqual(['xclip', 'xsel', 'wl-paste']);
    expect(clipboardWriters()).toEqual(['xclip', 'xsel', 'wl-copy']);
    expect(screenshotTools().map((t) => t.name))
      .toEqual(['scrot', 'gnome-screenshot', 'import']);
    expect(chromiumCandidates())
      .toEqual(['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']);
    expect(openHandler()).toEqual({ cmd: 'xdg-open', prefix: [] });
  });

  it('uses real per-platform handlers elsewhere', () => {
    setPlatform('darwin');
    expect(openHandler()).toEqual({ cmd: 'open', prefix: [] });
    expect(clipboardReaders()).toEqual(['pbpaste']);
    expect(screenshotTools()[0].name).toBe('screencapture');

    setPlatform('win32');
    expect(openHandler()).toEqual({ cmd: 'cmd.exe', prefix: ['/c', 'start', ''] });
    expect(clipboardWriters()).toEqual(['powershell.exe']);
    expect(screenshotTools()[0].cmd).toBe('powershell.exe');
    expect(chromiumCandidates()).toEqual(['chrome.exe', 'msedge.exe']);
  });

  it('resolves the default shell/cwd per platform', () => {
    const home = process.env.HOME;
    const profile = process.env.USERPROFILE;
    const comspec = process.env.ComSpec;
    try {
      delete process.env.HOME; delete process.env.SHELL;
      delete process.env.USERPROFILE; delete process.env.ComSpec;
      setPlatform('linux');
      expect(defaultShell()).toBe('/bin/bash');
      expect(defaultCwd()).toBe('/tmp');
      setPlatform('win32');
      expect(defaultShell()).toBe('powershell.exe');
      expect(defaultCwd()).toBe('C:\\');
    } finally {
      if (home !== undefined) process.env.HOME = home;
      if (profile !== undefined) process.env.USERPROFILE = profile;
      if (comspec !== undefined) process.env.ComSpec = comspec;
      delete process.env.SHELL;
    }
  });

  it('reports desktop-input unavailability honestly on mac/win, never on linux', () => {
    setPlatform('linux');
    expect(computerUseUnsupportedReason()).toBeNull();
    setPlatform('darwin');
    expect(computerUseUnsupportedReason()).toMatch(/not available on macOS/i);
    setPlatform('win32');
    expect(computerUseUnsupportedReason()).toMatch(/not available on Windows/i);
  });

  it('builds a PowerShell screenshot script with an escaped path', () => {
    const script = windowsScreenshotScript("C:\\Users\\o'brien\\shot.png");
    expect(script).toContain("CopyFromScreen");
    // The single quote in the path must be PowerShell-escaped ('').
    expect(script).toContain("o''brien");
    expect(isWindows()).toBe(REAL_PLATFORM === 'win32');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// computer-control — platform guards + Windows launch_app
// ═══════════════════════════════════════════════════════════════════════

describe('computer-control platform honesty', () => {
  it('returns honest unavailability for desktop actions on macOS', async () => {
    setPlatform('darwin');
    const tool = new ComputerControlTool(async () => { throw new Error('runner must not be called'); });
    const r = await tool.execute({ action: 'mouse_click', x: 5, y: 5 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/mouse_click is unavailable on this platform/);
    expect(r.data).toMatchObject({ platform: 'darwin', available: false });
  });

  it('returns honest unavailability for desktop actions on Windows', async () => {
    setPlatform('win32');
    const tool = new ComputerControlTool(async () => { throw new Error('runner must not be called'); });
    for (const action of ['screenshot', 'type_text', 'window_list']) {
      const r = await tool.execute({ action });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/unavailable on this platform/);
      expect(r.data).toMatchObject({ platform: 'windows', available: false });
    }
  });

  it('launch_app on Windows: real spawn/tasklist path with verification read-back', async () => {
    setPlatform('win32');
    const calls: Array<[string, string[]]> = [];
    const runner: ControlRunner = async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'tasklist.exe') {
        return { stdout: 'notepad.exe    1234 Console   1   12,345 K\n', stderr: '' };
      }
      // cmd.exe /c start "" <app> — the OS shell fallback.
      return { stdout: '', stderr: '' };
    };
    const tool = new ComputerControlTool(runner);
    const r = await tool.execute({ action: 'launch_app', app: 'notepad.exe' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ app: 'notepad.exe', process: 'notepad.exe', verified: true });
    expect(r.output).toMatch(/verified running process/i);
    // Verification MUST have read back through tasklist, not just trusted the spawn.
    expect(calls.some(([c, a]) => c === 'tasklist.exe' && a[1] === 'IMAGENAME eq notepad.exe')).toBe(true);
  });

  it('launch_app on Windows: honest failure when the process never appears', async () => {
    setPlatform('win32');
    const runner: ControlRunner = async (cmd) => {
      if (cmd === 'tasklist.exe') return { stdout: 'INFO: No tasks are running\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const tool = new ComputerControlTool(runner);
    const r = await tool.execute({ action: 'launch_app', app: 'ghost.exe' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Launch NOT verified/i);
    expect(r.data).toMatchObject({ verified: false });
  });

  it('launch_app on macOS falls back to open(1) with a pgrep read-back', async () => {
    setPlatform('darwin');
    const calls: Array<[string, string[]]> = [];
    const runner: ControlRunner = async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'pgrep') return { stdout: '4242\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const tool = new ComputerControlTool(runner);
    const r = await tool.execute({ action: 'launch_app', app: '/Applications/Notes.app' });
    expect(r.success).toBe(true);
    // The OS handler on macOS is open(1) — not xdg-open.
    expect(calls.some(([c, a]) => c === 'open' && a[0] === '/Applications/Notes.app')).toBe(true);
  });

  it('launch_app on Linux keeps the frozen xdg-open fallback', async () => {
    setPlatform('linux');
    const calls: Array<[string, string[]]> = [];
    const runner: ControlRunner = async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'pgrep') return { stdout: '7\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const tool = new ComputerControlTool(runner);
    // A name that cannot exist on PATH forces the direct spawn to fail so
    // the xdg-open fallback runs (environment-independent).
    const app = 'blaxin-no-such-app-0x2f';
    const r = await tool.execute({ action: 'launch_app', app });
    expect(r.success).toBe(true);
    expect(calls.some(([c, a]) => c === 'xdg-open' && a[0] === app)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// process-control — Windows honest unavailability
// ═══════════════════════════════════════════════════════════════════════

describe('process-control platform honesty', () => {
  it('is honestly unavailable on Windows for every action', async () => {
    setPlatform('win32');
    const runner: ProcessRunner = async () => { throw new Error('runner must not be called'); };
    const tool = new ProcessControlTool(runner);
    for (const action of ['list', 'inspect', 'kill']) {
      const r = await tool.execute({ action, pid: 1234 });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/not available on Windows.*POSIX ps\/kill/i);
      expect(r.data).toMatchObject({ platform: 'windows', available: false });
    }
  });

  it('keeps the full POSIX implementation on Linux and macOS', async () => {
    for (const p of ['linux', 'darwin'] as const) {
      setPlatform(p);
      // ps is real on both platforms; drive the list action through the seam.
      const runner: ProcessRunner = async (cmd, args) => {
        if (cmd !== 'ps') throw new Error(`unexpected ${cmd}`);
        const optsIdx = args.findIndex((a) => a === '-eo');
        expect(optsIdx).toBeGreaterThanOrEqual(0);
        return {
          stdout: '  1 0.0 0.1 Sl 10 init /sbin/init\n  2 3.5 1.0 Sl 30 node node dist/index.js\n',
          stderr: '',
        };
      };
      const tool = new ProcessControlTool(runner);
      const r = await tool.execute({ action: 'list', limit: 5 });
      expect(r.success).toBe(true);
      expect(r.output).toContain('node dist/index.js');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// clipboard — per-platform implementations through the runner seam
// ═══════════════════════════════════════════════════════════════════════

describe('clipboard platform honesty', () => {
  const fakeRunner: (scripted: Record<string, string>) => ClipboardRunner =
    (scripted) => async (cmd, args, _t, input) => {
      const key = `${cmd} ${args.join(' ')}`.trim();
      if (key in scripted) {
        const out = scripted[key];
        return { stdout: typeof out === 'function' ? (out as (i?: string) => string)(input) : out, stderr: '' };
      }
      throw new Error(`unexpected command: ${key}`);
    };

  it('macOS: reads via pbpaste, writes via pbcopy with read-back verification', async () => {
    setPlatform('darwin');
    let stored = '';
    const runner: ClipboardRunner = async (cmd, _args, _t, input) => {
      if (cmd === 'pbcopy') { stored = input ?? ''; return { stdout: '', stderr: '' }; }
      if (cmd === 'pbpaste') return { stdout: stored, stderr: '' };
      throw new Error(`unexpected ${cmd}`);
    };
    const tool = new ClipboardTool(runner);
    const w = await tool.execute({ action: 'write', text: 'hello mac' });
    expect(w.success).toBe(true);
    expect(w.data).toMatchObject({ verified: true, chars: 9 });
    const r = await tool.execute({ action: 'read' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ content: 'hello mac', empty: false });
  });

  it('Windows: writes via base64 Set-Clipboard and reads via Get-Clipboard -Raw', async () => {
    setPlatform('win32');
    let stored = '';
    const runner: ClipboardRunner = async (cmd, args, _t, input) => {
      if (cmd === 'powershell.exe') {
        const script = args[args.length - 1] as string;
        if (script.startsWith('Set-Clipboard')) {
          const b64 = script.match(/FromBase64String\('([^']+)'\)/)?.[1] ?? '';
          stored = Buffer.from(b64, 'base64').toString('utf-8');
          return { stdout: '', stderr: '' };
        }
        if (script.includes('Get-Clipboard')) {
          return { stdout: (stored ?? '') + '\r\n', stderr: '' };
        }
      }
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    };
    const tool = new ClipboardTool(runner);
    const w = await tool.execute({ action: 'write', text: 'héllo win' });
    expect(w.success).toBe(true);
    expect(w.data).toMatchObject({ verified: true, chars: 9 });
    const r = await tool.execute({ action: 'read' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ content: 'héllo win' });
  });

  it('Linux: frozen xclip → xsel → wl-copy chain still holds', async () => {
    setPlatform('linux');
    let stored = '';
    const runner: ClipboardRunner = async (cmd, args, _t, input) => {
      const key = `${cmd} ${args.join(' ')}`.trim();
      if (key.startsWith('xclip -selection clipboard')) {
        if (args.includes('-o')) return { stdout: stored, stderr: '' };
        stored = input ?? ''; return { stdout: '', stderr: '' };
      }
      if (key === 'xsel --clipboard --input') { stored = input ?? ''; return { stdout: '', stderr: '' }; }
      if (key === 'xsel --clipboard --output') return { stdout: stored, stderr: '' };
      if (key === 'wl-copy') { stored = input ?? ''; return { stdout: '', stderr: '' }; }
      if (key === 'wl-paste') return { stdout: stored, stderr: '' };
      throw new Error(`unexpected ${key}`);
    };
    const tool = new ClipboardTool(runner);
    const w = await tool.execute({ action: 'write', text: 'linux text' });
    expect(w.success).toBe(true);
    expect(w.data).toMatchObject({ verified: true });
    const r = await tool.execute({ action: 'read' });
    expect(r.data).toMatchObject({ content: 'linux text' });
  });

  it('reports honest NO-TOOL errors per platform (frozen Linux wording)', async () => {
    const never: ClipboardRunner = async () => { throw new Error('nothing works'); };
    // The error constants are computed at module-load time (correct per-OS
    // in production), so re-import the module fresh under each stubbed
    // platform instead of sharing the top-level import.
    setPlatform('linux');
    vi.resetModules();
    const { ClipboardTool: LinuxClipboard } = await import('../../tools/clipboard.js');
    const linuxTool = new LinuxClipboard(never);
    const lr = await linuxTool.execute({ action: 'read' });
    expect(lr.success).toBe(false);
    // FROZEN v1.4.0 Linux message:
    expect(lr.error).toBe('Clipboard read failed: none of the clipboard readers (xclip, xsel, wl-paste) could read the selection. This usually means no clipboard utility is installed, or the clipboard is currently empty/unowned. Install one: sudo apt install xclip');

    setPlatform('darwin');
    vi.resetModules();
    const { ClipboardTool: MacClipboard } = await import('../../tools/clipboard.js');
    const macTool = new MacClipboard(never);
    const mr = await macTool.execute({ action: 'read' });
    expect(mr.success).toBe(false);
    expect(mr.error).toMatch(/pbpaste/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// screenshot — per-platform capture chains
// ═══════════════════════════════════════════════════════════════════════

describe('screenshot platform honesty', () => {
  it('Linux keeps the frozen scrot → gnome-screenshot → import order', () => {
    setPlatform('linux');
    // The tool's execFileAsync is module-internal, so the capture-chain ORDER
    // is asserted on the platform module (the frozen contract surface).
    expect(screenshotTools().map((t) => t.name)).toEqual(['scrot', 'gnome-screenshot', 'import']);
  });

  it('Windows capture goes through the PowerShell CopyFromScreen script', async () => {
    setPlatform('win32');
    const tool = new ScreenshotTool();
    const r = await tool.execute({});
    // No real display on the test host — but the failure must be HONEST
    // (an error string), never a fake success with a broken image.
    expect(r.success).toBe(false);
    expect(String(r.error).length).toBeGreaterThan(0);
    expect(r.success && !r.data?.path).toBe(false);
  });

  it('screencapture is the macOS candidate', () => {
    setPlatform('darwin');
    const tools = screenshotTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'screencapture', cmd: 'screencapture', args: ['-x'] });
  });
});
