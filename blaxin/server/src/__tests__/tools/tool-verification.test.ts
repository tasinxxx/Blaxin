import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ScreenshotTool, ScreenshotRunner } from '../../tools/screenshot.js';
import { ComputerControlTool, ControlRunner } from '../../tools/computer-control.js';
import { ClipboardTool, ClipboardRunner } from '../../tools/clipboard.js';

// ── Fakes ──────────────────────────────────────────────────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Records every (cmd, args) and returns scripted stdout or throws. */
function makeControlFake(script: (cmd: string, args: string[]) => string): {
  runner: ControlRunner;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: ControlRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: script(cmd, args), stderr: '' };
  };
  return { runner, calls };
}

/** Runner that throws for every command (nothing installed / display dead). */
const failingRunner = async (): Promise<never> => {
  throw new Error('not found');
};

// ── Screenshot ─────────────────────────────────────────────────

describe('ScreenshotTool verification-in-depth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blaxin-shot-test-'));

  it('FAILS when no screenshot tool exists — even when an X display is present (fake-success eliminated)', async () => {
    // xdotool succeeds (display present) but no capture tool exists.
    const runner: ScreenshotRunner = async (cmd) => {
      if (cmd === 'xdotool') return { stdout: 'SomeWindow' };
      throw new Error('not found');
    };
    const tool = new ScreenshotTool(runner);
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Screenshot NOT captured');
    expect(result.data?.screenshotAvailable).toBe(false);
  });

  it('FAILS honestly when a capture tool exits 0 but writes NO file (fabricated success eliminated)', async () => {
    const runner: ScreenshotRunner = async (cmd) => {
      if (cmd === 'scrot') return { stdout: '' }; // exit 0, wrote nothing
      throw new Error('not found');
    };
    const tool = new ScreenshotTool(runner);
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('created no file');
  });

  it('FAILS honestly when the capture is a 0-byte file', async () => {
    const runner: ScreenshotRunner = async (cmd, args) => {
      if (cmd === 'scrot') {
        writeFileSync(args[0], Buffer.alloc(0)); // tool's own path, empty
        return { stdout: '' };
      }
      throw new Error('not found');
    };
    const tool = new ScreenshotTool(runner);
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('0-byte');
  });

  it('FAILS honestly when the capture is not a valid PNG (e.g. dead display wrote garbage)', async () => {
    // The tool writes to tmpdir with its own timestamped name; we can't
    // pre-plant it, but a runner that writes a non-PNG file exercises the
    // validation path. Instead: monkey-patch by writing after the runner.
    const runner: ScreenshotRunner = async (cmd, args) => {
      if (cmd === 'scrot') {
        writeFileSync(args[0], Buffer.from('<html>not a png</html>'));
        return { stdout: '' };
      }
      throw new Error('not found');
    };
    const tool = new ScreenshotTool(runner);
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('did not produce a valid PNG');
  });

  it('SUCCEEDS only with a real PNG capture (verified content)', async () => {
    const runner: ScreenshotRunner = async (cmd, args) => {
      if (cmd === 'scrot') {
        // Minimal valid PNG header + padding.
        const png = Buffer.concat([PNG_MAGIC, Buffer.alloc(64)]);
        writeFileSync(args[0], png);
        return { stdout: '' };
      }
      throw new Error('not found');
    };
    const tool = new ScreenshotTool(runner);
    const result = await tool.execute({});
    expect(result.success).toBe(true);
    expect(result.data?.screenshotAvailable).toBe(true);
    expect(result.data?.mimeType).toBe('image/png');
  });
});

// ── Computer control ───────────────────────────────────────────

describe('ComputerControlTool verification-in-depth', () => {
  it('launch_app: process verified alive after startup window', async () => {
    const { runner } = makeControlFake((cmd, args) => {
      if (cmd === 'pgrep' && args[0] === '-x' && args[1] === 'firefox') return '12345';
      return '';
    });
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'launch_app', app: 'firefox' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('verified');
    expect(result.data?.verified).toBe(true);
  });

  it('launch_app: FAILS honestly when the process dies immediately (was fake success + 5s kill)', async () => {
    const { runner } = makeControlFake(() => ''); // pgrep/pidof find nothing
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'launch_app', app: 'crashy-app' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Launch NOT verified');
    expect(result.error).toContain('crashy-app');
  });

  it('launch_app: falls back to xdg-open when the app is not on PATH', async () => {
    const runner: ControlRunner = async (cmd, args) => {
      if (cmd === 'xdg-open') return { stdout: '', stderr: '' };
      if (cmd === 'pgrep' && args[1] === 'definitely-not-a-real-app-xyz') return { stdout: '777', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const tool = new ComputerControlTool(runner);
    // spawn('definitely-not-a-real-app-xyz') fails with ENOENT -> the tool
    // falls back to xdg-open; the aliveness check then matches a process
    // named after the requested app basename.
    const result = await tool.execute({ action: 'launch_app', app: 'definitely-not-a-real-app-xyz' });
    expect(result.success).toBe(true);
    expect(result.data?.verified).toBe(true);
  });

  it('mouse_click: verifies pointer position read-back', async () => {
    const { runner } = makeControlFake((cmd, args) => {
      if (cmd === 'xdotool') {
        if (args[0] === 'getmouselocation') return 'x:150 y:250 screen:0 window:123';
        return '';
      }
      return '';
    });
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'mouse_click', x: 150, y: 250 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('verified');
    expect((result.data?.actual as { x: number; y: number })).toEqual({ x: 150, y: 250 });
  });

  it('mouse_click: FAILS when the pointer is NOT at the requested position', async () => {
    const { runner } = makeControlFake((cmd, args) => {
      if (cmd === 'xdotool' && args[0] === 'getmouselocation') return 'x:999 y:999 screen:0';
      return '';
    });
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'mouse_click', x: 10, y: 20 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Click NOT verified');
    expect(result.error).toContain('(999, 999)');
  });

  it('mouse_move: reports honestly when read-back is unavailable (no fabricated verification)', async () => {
    const { runner } = makeControlFake((cmd, args) => {
      if (cmd === 'xdotool' && args[0] === 'getmouselocation') {
        throw new Error('read-back failed'); // simulated inside makeControlFake via rejection
      }
      return ''; // move/which succeed
    });
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'mouse_move', x: 5, y: 6 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('read-back unavailable');
    expect(result.data?.verified).toBe(false);
  });

  it('focus_window: FAILS when the active window does not match the request', async () => {
    const { runner } = makeControlFake((cmd, args) => {
      if (cmd === 'xdotool' && args[0] === 'search') return '0x111\n0x222';
      if (cmd === 'xdotool' && args[0] === 'windowactivate') return '';
      if (cmd === 'xdotool' && args[0] === 'getactivewindow') return 'Terminal';
      return '';
    });
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'focus_window', windowTitle: 'Firefox' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Focus NOT verified');
    expect(result.error).toContain('Terminal');
  });

  it('focus_window: SUCCEEDS when read-back confirms the focused title', async () => {
    const { runner } = makeControlFake((cmd, args) => {
      if (cmd === 'xdotool' && args[0] === 'search') return '0x111';
      if (cmd === 'xdotool' && args[0] === 'windowactivate') return '';
      if (cmd === 'xdotool' && args[0] === 'getactivewindow') return 'Mozilla Firefox';
      return '';
    });
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'focus_window', windowTitle: 'Firefox' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('verified');
  });

  it('close_window: verifies the window is gone from the real window list', async () => {
    let searchCount = 0;
    const { runner } = makeControlFake((cmd, args) => {
      if (cmd === 'xdotool' && args[0] === 'search') {
        searchCount++;
        return searchCount === 1 ? '0x111' : ''; // gone after close
      }
      if (cmd === 'xdotool' && args[0] === 'windowclose') return '';
      return '';
    });
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'close_window', windowTitle: 'Sticky' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('verified gone');
  });

  it('close_window: FAILS honestly when the window survives the close', async () => {
    const { runner } = makeControlFake((cmd, args) => {
      if (cmd === 'xdotool' && args[0] === 'search') return '0x111';
      if (cmd === 'xdotool' && args[0] === 'windowclose') return '';
      return '';
    });
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'close_window', windowTitle: 'Zombie' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Close NOT verified');
  });

  it('key_press: rejects unsafe key names (guard intact)', async () => {
    const tool = new ComputerControlTool(failingRunner);
    const result = await tool.execute({ action: 'key_press', key: 'bad key; rm -rf' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid key name');
  });

  it('type_text: honest phrasing — events sent, receiver NOT verified', async () => {
    const { runner } = makeControlFake(() => '');
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'type_text', text: 'hello' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('not verified');
    expect(result.data?.verified).toBe(false);
  });

  // ── B4.3 polish: bounds, smooth travel, focus awareness ──────

  it('mouse_click: REFUSES off-screen coordinates before synthesizing input', async () => {
    const { runner, calls } = makeControlFake((cmd, args) => {
      if (cmd === 'xdpyinfo') return 'dimensions: 1920x1080 pixels';
      return '';
    });
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'mouse_click', x: 5000, y: 300 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the real screen (1920x1080)');
    expect(result.data?.grounded).toBe(false);
    // NO input synthesis happened: no mousemove/click was issued.
    expect(calls.filter((c) => c.cmd === 'xdotool' && c.args[0] === 'mousemove')).toHaveLength(0);
    expect(calls.filter((c) => c.cmd === 'xdotool' && c.args[0] === 'click')).toHaveLength(0);
  });

  it('mouse_move: negative coordinates are refused (bounds-checked)', async () => {
    const { runner } = makeControlFake((cmd) => (cmd === 'xdpyinfo' ? 'dimensions: 1024x768 pixels' : ''));
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'mouse_move', x: -5, y: 100 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the real screen');
  });

  it('mouse actions stay honest when screen bounds are unknown (no fabricated refusal)', async () => {
    const { runner } = makeControlFake((cmd, args) => {
      if (cmd === 'xdotool' && args[0] === 'getmouselocation') return 'x:150 y:250 screen:0';
      return ''; // xdpyinfo fails/absent → bounds unknown
    });
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'mouse_click', x: 150, y: 250 });
    expect(result.success).toBe(true); // proceeds, honestly not bounds-checked
    expect(result.data?.boundsChecked).toBe(false);
  });

  it('smooth travel: long moves interpolate through bounded waypoints and land on target', async () => {
    const waypoints: Array<{ x: number; y: number }> = [];
    let current = { x: 0, y: 0 };
    const { runner } = makeControlFake((cmd, args) => {
      if (cmd === 'xdpyinfo') return 'dimensions: 1920x1080 pixels';
      if (cmd === 'xdotool' && args[0] === 'getmouselocation') return `x:${current.x} y:${current.y} screen:0`;
      if (cmd === 'xdotool' && args[0] === 'mousemove') {
        current = { x: Number(args[1]), y: Number(args[2]) };
        waypoints.push({ ...current });
        return '';
      }
      return '';
    });
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'mouse_move', x: 600, y: 0 });
    expect(result.success).toBe(true);
    // Bounded waypoint count, intermediate points, correct landing.
    expect(waypoints.length).toBeGreaterThan(2);
    expect(waypoints.length).toBeLessThanOrEqual(12);
    const last = waypoints[waypoints.length - 1];
    expect(last).toEqual({ x: 600, y: 0 });
    // Intermediate waypoints are BETWEEN start and target (real path).
    const mid = waypoints[Math.floor(waypoints.length / 2)];
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(600);
  });

  it('short moves skip interpolation (no needless waypoints)', async () => {
    let moves = 0;
    const { runner } = makeControlFake((cmd, args) => {
      if (cmd === 'xdotool' && args[0] === 'getmouselocation') return 'x:100 y:100 screen:0';
      if (cmd === 'xdotool' && args[0] === 'mousemove') { moves++; return ''; }
      return '';
    });
    const tool = new ComputerControlTool(runner);
    await tool.execute({ action: 'mouse_move', x: 120, y: 110 });
    expect(moves).toBe(1); // single synchronous move, no interpolation
  });

  it('type_text: reports the REAL focused window (focus awareness)', async () => {
    const { runner } = makeControlFake((cmd, args) => {
      if (cmd === 'xdotool' && args[0] === 'getactivewindow') return 'My Terminal';
      return '';
    });
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'type_text', text: 'hello' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('My Terminal');
    expect(result.data?.focusedWindow).toBe('My Terminal');
    expect(result.data?.verified).toBe(false); // receiver still not verified
  });

  it('key_press: reports the REAL focused window when readable', async () => {
    const { runner } = makeControlFake((cmd, args) => {
      if (cmd === 'xdotool' && args[0] === 'getactivewindow') return 'Firefox';
      return '';
    });
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'key_press', key: 'Return' });
    expect(result.success).toBe(true);
    expect(result.data?.focusedWindow).toBe('Firefox');
  });

  it('key_press: stays honest when the focused window is unreadable', async () => {
    const { runner } = makeControlFake(() => '');
    const tool = new ComputerControlTool(runner);
    const result = await tool.execute({ action: 'key_press', key: 'Return' });
    expect(result.success).toBe(true);
    expect(result.data?.focusedWindow).toBeUndefined();
    expect(result.output).toContain('not verified');
  });
});

// ── Clipboard ──────────────────────────────────────────────────

describe('ClipboardTool verification-in-depth', () => {
  it('read: SUCCEEDS with empty content when the clipboard is EMPTY (no wrong diagnosis)', async () => {
    const runner: ClipboardRunner = async (cmd) => {
      if (cmd === 'xclip') return { stdout: '', stderr: '' }; // exit 0, empty
      throw new Error('not found');
    };
    const tool = new ClipboardTool(runner);
    const result = await tool.execute({ action: 'read' });
    expect(result.success).toBe(true);
    expect(result.data?.empty).toBe(true);
  });

  it('read: FAILS with the BOTH-causes message when every reader fails', async () => {
    const runner: ClipboardRunner = async () => {
      throw new Error('not found');
    };
    const tool = new ClipboardTool(runner);
    const result = await tool.execute({ action: 'read' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('none of the clipboard readers');
    expect(result.error).toContain('empty/unowned');
  });

  it('write: verifies content by reading it back', async () => {
    const runner: ClipboardRunner = async (cmd, args, _t, input) => {
      if (input !== undefined) return { stdout: '', stderr: '' }; // write ok
      if (cmd === 'xclip' && args.includes('-o')) return { stdout: 'typed text', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const tool = new ClipboardTool(runner);
    const result = await tool.execute({ action: 'write', text: 'typed text' });
    expect(result.success).toBe(true);
    expect(result.data?.verified).toBe(true);
  });

  it('write: FAILS when read-back does not match (selection lost / owner replaced)', async () => {
    const runner: ClipboardRunner = async (cmd, args, _t, input) => {
      if (input !== undefined) return { stdout: '', stderr: '' };
      if (cmd === 'xclip' && args.includes('-o')) return { stdout: 'something else', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const tool = new ClipboardTool(runner);
    const result = await tool.execute({ action: 'write', text: 'typed text' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('NOT verified');
  });

  it('write: FAILS when the clipboard cannot be read back at all', async () => {
    const runner: ClipboardRunner = async (cmd, args, _t, input) => {
      if (input !== undefined) return { stdout: '', stderr: '' };
      throw new Error('no reader');
    };
    const tool = new ClipboardTool(runner);
    const result = await tool.execute({ action: 'write', text: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('NOT verified');
  });
});
