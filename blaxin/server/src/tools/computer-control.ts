import { Tool, ToolResult } from '../types.js';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { currentPlatform, openHandler, computerUseUnsupportedReason } from '../utils/platform.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

type DisplayServer = 'x11' | 'wayland' | 'unknown';

// Keys are never passed through a shell; this charset guard simply
// prevents nonsense input from reaching xdotool/ydotool.
const KEY_SAFE_PATTERN = /^[A-Za-z0-9_+\-.]{1,40}$/;

// ── Smooth-travel bounds (polish: real motion, never a jump-cut; and
// never a click at a point that cannot exist on the real screen) ──
const SMOOTH_STEP_PX = 60;        // max distance per interpolated waypoint
const SMOOTH_MAX_WAYPOINTS = 12;  // hard bound: bounded motion, no runaway
const SMOOTH_WAYPOINT_DELAY_MS = 12;
const BOUNDS_CACHE_TTL_MS = 30_000;

/**
 * Injectable command runner (verification seam). The default runs the real
 * commands; tests inject fakes to drive honest-success / honest-failure
 * paths deterministically.
 */
export type ControlRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number
) => Promise<{ stdout: string; stderr: string }>;

export class ComputerControlTool implements Tool {
  name = 'computer-control';
  description = 'Control the computer: mouse clicks, keyboard input, window management, application launching, and scrolling. Supports both X11 and Wayland.';

  private displayServer: DisplayServer = 'unknown';
  /** Cached real screen geometry (xdpyinfo); re-read after the TTL. */
  private boundsCache: { w: number; h: number; at: number } | null = null;

  definition = {
    type: 'function' as const,
    function: {
      name: 'computer-control',
      description: 'Control the desktop GUI: click, type, scroll, manage windows, launch applications. Works on both X11 and Wayland.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'mouse_click', 'mouse_move', 'mouse_double_click', 'mouse_right_click',
              'mouse_drag', 'type_text', 'key_press', 'key_combo',
              'scroll', 'scroll_up', 'scroll_down',
              'launch_app', 'focus_window', 'close_window', 'minimize_window', 'maximize_window',
              'list_windows', 'get_active_window',
              'get_mouse_position', 'get_screen_size',
            ],
            description: 'The action to perform',
          },
          x: { type: 'number', description: 'X coordinate for mouse actions' },
          y: { type: 'number', description: 'Y coordinate for mouse actions' },
          text: { type: 'string', description: 'Text to type (for type_text action)' },
          key: { type: 'string', description: 'Key name (for key_press/key_combo, e.g., "Return", "ctrl+c")' },
          app: { type: 'string', description: 'Application name or command (for launch_app)' },
          windowTitle: { type: 'string', description: 'Window title for window management actions' },
          amount: { type: 'number', description: 'Scroll amount (for scroll actions)' },
          endX: { type: 'number', description: 'End X for drag operations' },
          endY: { type: 'number', description: 'End Y for drag operations' },
        },
        required: ['action'],
      },
    },
  };

  constructor(private runner: ControlRunner = (cmd, args, timeoutMs) => execFileAsync(cmd, args, { timeout: timeoutMs, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } })) {}

  private async detectDisplayServer(): Promise<DisplayServer> {
    if (this.displayServer !== 'unknown') return this.displayServer;

    if (process.env.WAYLAND_DISPLAY) {
      this.displayServer = 'wayland';
    } else if (process.env.DISPLAY) {
      this.displayServer = 'x11';
    } else {
      // Try to detect
      try {
        await this.runner('which', ['xdotool'], 2000);
        this.displayServer = 'x11';
      } catch {
        try {
          await this.runner('which', ['ydotool'], 2000);
          this.displayServer = 'wayland';
        } catch {
          this.displayServer = 'x11'; // Default fallback
        }
      }
    }

    return this.displayServer;
  }

  /** Run a command with explicit argv — no shell interpolation. */
  private async runTool(args: string[], timeout = 10000): Promise<string> {
    try {
      const { stdout } = await this.runner(args[0], args.slice(1), timeout);
      return stdout.trim();
    } catch (error: any) {
      throw new Error(`${args[0]} failed: ${error.message}`);
    }
  }

  /** Run a fixed, literal shell pipeline (no user input involved). */
  private async runLiteral(cmd: string, timeout = 5000): Promise<string> {
    const { stdout } = await execAsync(cmd, { timeout });
    return stdout.trim();
  }

  private num(value: unknown, label: string): number {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${label} must be a valid number`);
    return Math.round(n);
  }

  // ── X11 (xdotool) methods ─────────────────────────────────

  private xdotoolMove(x: number, y: number): Promise<string> {
    return this.runTool(['xdotool', 'mousemove', String(x), String(y)]);
  }

  private xdotoolClick(button = 1): Promise<string> {
    return this.runTool(['xdotool', 'click', String(button)]);
  }

  private xdotoolDoubleClick(x: number, y: number): Promise<string> {
    return this.runTool(['xdotool', 'mousemove', String(x), String(y), 'click', '--repeat', '2', '1']);
  }

  private xdotoolType(text: string): Promise<string> {
    return this.runTool(['xdotool', 'type', '--clearmodifiers', text]);
  }

  private xdotoolKey(key: string): Promise<string> {
    return this.runTool(['xdotool', 'key', key]);
  }

  private xdotoolSearch(query: string): Promise<string[]> {
    return this.runTool(['xdotool', 'search', '--name', query])
      .then((output) => output.split('\n').filter(Boolean));
  }

  private xdotoolGetActiveWindow(): Promise<string> {
    return this.runTool(['xdotool', 'getactivewindow', 'getwindowname']);
  }

  private async xdotoolWindowAction(windowId: string, action: string, key: string): Promise<string> {
    if (/^0x[0-9a-fA-F]+$/.test(windowId)) {
      return this.runTool(['xdotool', action, windowId]);
    }
    return this.runTool(['xdotool', 'key', key]);
  }

  // ── Wayland (ydotool) methods ──────────────────────────────

  private ydotoolMove(x: number, y: number): Promise<string> {
    return this.runTool(['ydotool', 'mousemove', '--absolute', String(x), String(y)]);
  }

  private ydotoolClick(button = 1): Promise<string> {
    // ydotool button: 0x110=left, 0x111=right, 0x112=middle
    const buttonMap: Record<number, string> = { 1: '0x110', 2: '0x112', 3: '0x111' };
    return this.runTool(['ydotool', 'click', buttonMap[button] || '0x110']);
  }

  private ydotoolDoubleClick(x: number, y: number): Promise<string> {
    return this.ydotoolMove(x, y).then(() =>
      this.runTool(['ydotool', 'click', '--next-delay', '50', '0x110', '0x110'])
    );
  }

  private ydotoolType(text: string): Promise<string> {
    return this.runTool(['ydotool', 'type', '--', text]);
  }

  private ydotoolKey(key: string): Promise<string> {
    // Map common xdotool key names to ydotool names
    const keyMap: Record<string, string> = {
      'Return': 'KP_Enter', 'enter': 'KP_Enter',
      'Tab': 'Tab', 'tab': 'Tab',
      'space': 'Space', 'BackSpace': 'BackSpace',
      'Delete': 'Delete', 'Escape': 'Escape',
      'ctrl+c': 'LEFTCTRL+c', 'ctrl+v': 'LEFTCTRL+v',
      'ctrl+a': 'LEFTCTRL+a', 'ctrl+x': 'LEFTCTRL+x',
      'ctrl+z': 'LEFTCTRL+z', 'alt+F4': 'LEFTALT+F4',
      'alt+F9': 'LEFTALT+F9', 'super+Up': 'SUPER+Up',
    };
    const ykey = keyMap[key] || key;
    return this.runTool(['ydotool', 'key', ykey]);
  }

  private ydotoolScroll(direction: 'up' | 'down', clicks = 1): Promise<string> {
    const args = ['ydotool', 'scroll', '--'];
    for (let i = 0; i < clicks; i++) {
      args.push(direction === 'up' ? '-5' : '5');
    }
    return this.runTool(args);
  }

  // ── Unified interface ──────────────────────────────────────

  private async moveMouse(x: number, y: number): Promise<void> {
    const ds = await this.detectDisplayServer();
    if (ds === 'wayland') {
      await this.ydotoolMove(x, y);
    } else {
      await this.xdotoolMove(x, y);
    }
  }

  /** Real cursor position read (same seam as the verification read-back). */
  private async currentPointer(): Promise<{ x: number; y: number } | null> {
    return this.readMousePosition();
  }

  private async clickMouse(button = 1): Promise<void> {
    const ds = await this.detectDisplayServer();
    if (ds === 'wayland') {
      await this.ydotoolClick(button);
    } else {
      await this.xdotoolClick(button);
    }
  }

  /**
   * Verification read-back for mouse motion: xdotool getmouselocation
   * returns "x:100 y:200 screen:0 ..." — compare against the requested
   * coordinates. Returns the real position, or null when the read-back
   * itself is unavailable (e.g. Wayland).
   */
  private async readMousePosition(): Promise<{ x: number; y: number } | null> {
    try {
      const pos = await this.runTool(['xdotool', 'getmouselocation']);
      const mx = /x:(\d+)/.exec(pos);
      const my = /y:(\d+)/.exec(pos);
      if (mx && my) return { x: Number(mx[1]), y: Number(my[1]) };
      return null;
    } catch {
      return null;
    }
  }

  /**
   * REAL screen geometry from xdpyinfo ("dimensions: 1920x1080 pixels").
   * Cached briefly (one spawn per interaction burst, bounded). Returns
   * null when unknown (Wayland, xdpyinfo absent) — the caller must stay
   * honest that the check could not run, never invent a limit.
   */
  private async readScreenBounds(): Promise<{ w: number; h: number } | null> {
    if (this.boundsCache && Date.now() - this.boundsCache.at < BOUNDS_CACHE_TTL_MS) {
      return { w: this.boundsCache.w, h: this.boundsCache.h };
    }
    try {
      const out = await this.runner('xdpyinfo', [], 3000);
      const m = /dimensions:\s+(\d+)x(\d+)/.exec(out.stdout || '');
      if (!m) return null;
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
      this.boundsCache = { w, h, at: Date.now() };
      return { w, h };
    } catch {
      return null;
    }
  }

  /**
   * Grounding precondition: a coordinate outside the REAL screen can
   * never be a grounded point — clicking there is a random guess. When
   * the bounds are known, off-screen coordinates are REFUSED before any
   * input is synthesized. Unknown bounds (no xdpyinfo) stay honest: the
   * action may proceed, reported as not bounds-checked.
   */
  private async checkOnScreen(points: Array<{ x: number; y: number }>): Promise<{ ok: true; checked: boolean; bounds?: { w: number; h: number } } | { ok: false; bounds: { w: number; h: number } }> {
    const bounds = await this.readScreenBounds();
    if (!bounds) return { ok: true, checked: false };
    for (const p of points) {
      if (p.x < 0 || p.y < 0 || p.x > bounds.w || p.y > bounds.h) {
        return { ok: false, bounds };
      }
    }
    return { ok: true, checked: true, bounds };
  }

  /**
   * REAL smooth cursor travel: interpolate the path from the current
   * pointer position to the target in bounded waypoints (xdotool --sync
   * per step, tiny delays) instead of a jump-cut move. Bounded hard:
   * at most SMOOTH_MAX_WAYPOINTS steps regardless of distance. Falls
   * back to a single synchronous move when the current position is
   * unreadable (nothing to interpolate FROM).
   */
  private async moveMouseSmooth(x: number, y: number): Promise<void> {
    const from = await this.readMousePosition();
    if (!from) {
      // No honest start point → single synchronous move (still verified
      // afterwards by the caller's read-back).
      await this.moveMouse(x, y);
      return;
    }
    const dist = Math.hypot(x - from.x, y - from.y);
    if (dist <= SMOOTH_STEP_PX) {
      await this.moveMouse(x, y);
      return;
    }
    const steps = Math.min(SMOOTH_MAX_WAYPOINTS, Math.ceil(dist / SMOOTH_STEP_PX));
    for (let i = 1; i <= steps; i++) {
      const wx = Math.round(from.x + ((x - from.x) * i) / steps);
      const wy = Math.round(from.y + ((y - from.y) * i) / steps);
      await this.moveMouse(wx, wy);
      if (i < steps) await new Promise((r) => setTimeout(r, SMOOTH_WAYPOINT_DELAY_MS));
    }
  }

  /**
   * Best-effort REAL active-window read (focus awareness for keyboard
   * and click actions). Returns null when unavailable — never a guess.
   */
  private async readActiveWindow(): Promise<string | null> {
    try {
      const name = await this.xdotoolGetActiveWindow();
      return name || null;
    } catch {
      return null;
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;

    // Platform honesty (Phase 6 rule): desktop input/window automation is
    // X11/Wayland-only in v1.4.0. On other platforms every action is an
    // honest unavailability — never a fake success, never a crash. The
    // exception is launch_app, which has a real Windows implementation.
    const unsupported = computerUseUnsupportedReason();
    if (unsupported && action !== 'launch_app') {
      return {
        success: false,
        output: '',
        error: `${action} is unavailable on this platform: ${unsupported}`,
        data: { action, platform: currentPlatform(), available: false },
      };
    }

    try {
      switch (action) {
        case 'mouse_click': {
          const x = this.num(args.x, 'x');
          const y = this.num(args.y, 'y');
          // Grounding precondition (polish): off-screen points are refused
          // BEFORE any input is synthesized — a click off the real screen
          // cannot land on anything.
          const bounds = await this.checkOnScreen([{ x, y }]);
          if (!bounds.ok) {
            return {
              success: false,
              output: '',
              error: `Click refused: (${x}, ${y}) is outside the real screen (${bounds.bounds.w}x${bounds.bounds.h}) — refusing an ungrounded click`,
              data: { requested: { x, y }, screenBounds: bounds.bounds, grounded: false },
            };
          }
          await this.moveMouseSmooth(x, y);
          await this.clickMouse(1);
          // Verification-in-depth: read the REAL pointer position back and
          // compare with what was requested. Exit 0 alone only proves the X
          // server accepted the request, not that the pointer is there.
          const real = await this.readMousePosition();
          if (real) {
            if (Math.abs(real.x - x) > 2 || Math.abs(real.y - y) > 2) {
              return {
                success: false,
                output: '',
                error: `Click NOT verified: pointer is at (${real.x}, ${real.y}), not the requested (${x}, ${y})`,
                data: { requested: { x, y }, actual: real, boundsChecked: bounds.checked },
              };
            }
            return { success: true, output: `Clicked at (${x}, ${y}) — verified pointer at (${real.x}, ${real.y})${bounds.checked ? ' (bounds-checked)' : ''}`, data: { requested: { x, y }, actual: real, boundsChecked: bounds.checked } };
          }
          // No read-back available (e.g. Wayland): honest about what is known.
          return { success: true, output: `Click requested at (${x}, ${y}) — executed (position read-back unavailable)`, data: { requested: { x, y }, verified: false, boundsChecked: bounds.checked } };
        }

        case 'mouse_double_click': {
          const x = this.num(args.x, 'x');
          const y = this.num(args.y, 'y');
          const bounds = await this.checkOnScreen([{ x, y }]);
          if (!bounds.ok) {
            return {
              success: false,
              output: '',
              error: `Double-click refused: (${x}, ${y}) is outside the real screen (${bounds.bounds.w}x${bounds.bounds.h}) — refusing an ungrounded click`,
              data: { requested: { x, y }, screenBounds: bounds.bounds, grounded: false },
            };
          }
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolDoubleClick(x, y);
          } else {
            await this.xdotoolDoubleClick(x, y);
          }
          const real = await this.readMousePosition();
          if (real && (Math.abs(real.x - x) > 2 || Math.abs(real.y - y) > 2)) {
            return {
              success: false,
              output: '',
              error: `Double-click NOT verified: pointer is at (${real.x}, ${real.y}), not the requested (${x}, ${y})`,
              data: { requested: { x, y }, actual: real },
            };
          }
          return real
            ? { success: true, output: `Double-clicked at (${x}, ${y}) — verified pointer at (${real.x}, ${real.y})`, data: { requested: { x, y }, actual: real } }
            : { success: true, output: `Double-click requested at (${x}, ${y}) — executed (position read-back unavailable)`, data: { requested: { x, y }, verified: false } };
        }

        case 'mouse_right_click': {
          const x = this.num(args.x, 'x');
          const y = this.num(args.y, 'y');
          const bounds = await this.checkOnScreen([{ x, y }]);
          if (!bounds.ok) {
            return {
              success: false,
              output: '',
              error: `Right-click refused: (${x}, ${y}) is outside the real screen (${bounds.bounds.w}x${bounds.bounds.h}) — refusing an ungrounded click`,
              data: { requested: { x, y }, screenBounds: bounds.bounds, grounded: false },
            };
          }
          await this.moveMouseSmooth(x, y);
          await this.clickMouse(3);
          const real = await this.readMousePosition();
          if (real && (Math.abs(real.x - x) > 2 || Math.abs(real.y - y) > 2)) {
            return {
              success: false,
              output: '',
              error: `Right-click NOT verified: pointer is at (${real.x}, ${real.y}), not the requested (${x}, ${y})`,
              data: { requested: { x, y }, actual: real },
            };
          }
          return real
            ? { success: true, output: `Right-clicked at (${x}, ${y}) — verified pointer at (${real.x}, ${real.y})`, data: { requested: { x, y }, actual: real } }
            : { success: true, output: `Right-click requested at (${x}, ${y}) — executed (position read-back unavailable)`, data: { requested: { x, y }, verified: false } };
        }

        case 'mouse_move': {
          const x = this.num(args.x, 'x');
          const y = this.num(args.y, 'y');
          const bounds = await this.checkOnScreen([{ x, y }]);
          if (!bounds.ok) {
            return {
              success: false,
              output: '',
              error: `Mouse move refused: (${x}, ${y}) is outside the real screen (${bounds.bounds.w}x${bounds.bounds.h})`,
              data: { requested: { x, y }, screenBounds: bounds.bounds },
            };
          }
          await this.moveMouseSmooth(x, y);
          const real = await this.readMousePosition();
          if (real && (Math.abs(real.x - x) > 2 || Math.abs(real.y - y) > 2)) {
            return {
              success: false,
              output: '',
              error: `Mouse move NOT verified: pointer is at (${real.x}, ${real.y}), not the requested (${x}, ${y})`,
              data: { requested: { x, y }, actual: real },
            };
          }
          return real
            ? { success: true, output: `Moved mouse to (${x}, ${y}) — verified`, data: { requested: { x, y }, actual: real } }
            : { success: true, output: `Mouse move requested to (${x}, ${y}) — executed (position read-back unavailable)`, data: { requested: { x, y }, verified: false } };
        }

        case 'mouse_drag': {
          const x = this.num(args.x, 'x');
          const y = this.num(args.y, 'y');
          const endX = this.num(args.endX, 'endX');
          const endY = this.num(args.endY, 'endY');
          const bounds = await this.checkOnScreen([{ x, y }, { x: endX, y: endY }]);
          if (!bounds.ok) {
            return {
              success: false,
              output: '',
              error: `Drag refused: (${x}, ${y}) → (${endX}, ${endY}) leaves the real screen (${bounds.bounds.w}x${bounds.bounds.h})`,
              data: { from: { x, y }, requestedEnd: { x: endX, y: endY }, screenBounds: bounds.bounds, grounded: false },
            };
          }
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolMove(x, y);
            await this.runTool(['ydotool', 'mousedown', '0x110']);
            await this.ydotoolMove(endX, endY);
            await this.runTool(['ydotool', 'mouseup', '0x110']);
          } else {
            await this.runTool(['xdotool', 'mousemove', String(x), String(y), 'mousedown', '1',
              'mousemove', String(endX), String(endY), 'mouseup', '1']);
          }
          const real = await this.readMousePosition();
          if (real && (Math.abs(real.x - endX) > 2 || Math.abs(real.y - endY) > 2)) {
            return {
              success: false,
              output: '',
              error: `Drag NOT verified: pointer ended at (${real.x}, ${real.y}), not the requested end (${endX}, ${endY})`,
              data: { from: { x, y }, requestedEnd: { x: endX, y: endY }, actual: real },
            };
          }
          return real
            ? { success: true, output: `Dragged from (${x}, ${y}) to (${endX}, ${endY}) — verified`, data: { from: { x, y }, end: { x: endX, y: endY }, actual: real } }
            : { success: true, output: `Drag requested from (${x}, ${y}) to (${endX}, ${endY}) — executed (position read-back unavailable)`, data: { from: { x, y }, end: { x: endX, y: endY }, verified: false } };
        }

        case 'type_text': {
          const text = String(args.text ?? '');
          // Focus awareness (polish): read the REAL active window before
          // synthesizing keystrokes. The events always go to whatever the
          // window manager has focused — knowing WHICH window that is makes
          // the report honest instead of hopeful. Never guesses.
          const focused = await this.readActiveWindow();
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolType(text);
          } else {
            await this.xdotoolType(text);
          }
          // Honest phrasing: exit 0 proves the synthetic-key events were sent;
          // whether a focused window received them cannot be read back
          // without a display-specific observation (screenshot is the
          // observation layer for that).
          return focused
            ? { success: true, output: `Typed text (${text.length} chars) — sent to focused window "${focused}" (receiver not verified)`, data: { chars: text.length, focusedWindow: focused, verified: false } }
            : { success: true, output: `Typed text (${text.length} chars) — events sent to the focused window (receiver not verified)`, data: { chars: text.length, verified: false } };
        }

        case 'key_press':
        case 'key_combo': {
          const key = String(args.key ?? '');
          if (!KEY_SAFE_PATTERN.test(key)) {
            return { success: false, output: '', error: 'Invalid key name. Use names like "Return", "ctrl+c", "alt+F4".' };
          }
          const focused = await this.readActiveWindow();
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolKey(key);
          } else {
            await this.xdotoolKey(key);
          }
          return focused
            ? { success: true, output: `Pressed key: ${key} — sent to focused window "${focused}" (receiver not verified)`, data: { key, focusedWindow: focused, verified: false } }
            : { success: true, output: `Pressed key: ${key} (event sent; receiver not verified)`, data: { key, verified: false } };
        }

        case 'scroll': {
          const amount = this.num(args.amount ?? 3, 'amount');
          if (amount === 0) return { success: true, output: 'Scrolled 0 clicks' };
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolScroll(amount > 0 ? 'down' : 'up', Math.abs(amount));
          } else {
            const btn = amount > 0 ? '5' : '4';
            for (let i = 0; i < Math.abs(amount); i++) {
              await this.xdotoolClick(Number(btn));
            }
          }
          return { success: true, output: `Scrolled ${amount} clicks (events sent; scroll effect not verified)` };
        }

        case 'scroll_up': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolScroll('up');
          } else {
            await this.xdotoolClick(4);
          }
          return { success: true, output: 'Scrolled up (events sent; scroll effect not verified)' };
        }

        case 'scroll_down': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolScroll('down');
          } else {
            await this.xdotoolClick(5);
          }
          return { success: true, output: 'Scrolled down (events sent; scroll effect not verified)' };
        }

        case 'launch_app': {
          const app = String(args.app ?? '').trim();
          if (!app) return { success: false, output: '', error: 'App name is required' };
          const openWith = openHandler();
          if (currentPlatform() === 'windows') {
            // Windows path: spawn the app directly, fall back to the OS
            // shell handler. Same verification read-back discipline as Linux.
            try {
              await new Promise<void>((resolve, reject) => {
                const child = spawn(app, [], { detached: true, stdio: 'ignore', shell: false });
                child.once('spawn', () => { child.unref(); resolve(); });
                child.once('error', (err) => reject(err));
              });
            } catch {
              try {
                if (openWith) await this.runner(openWith.cmd, [...openWith.prefix, app], 10000);
              } catch (startError: any) {
                return {
                  success: false,
                  output: '',
                  error: `Failed to launch ${app}: not found and the shell handler failed (${startError.message})`,
                };
              }
            }
            const wbase = app.split(/[\\/]/).pop() || app;
            let walive = false;
            try {
              await new Promise((r) => setTimeout(r, 700));
              const { stdout } = await this.runner('tasklist.exe', ['/FI', `IMAGENAME eq ${wbase}`], 3000);
              walive = new RegExp(`^${wbase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'im').test(stdout);
            } catch { walive = false; }
            if (!walive) {
              return {
                success: false,
                output: '',
                error: `Launch NOT verified: no running process named "${wbase}" after startup window`,
                data: { app, verified: false },
              };
            }
            return { success: true, output: `Launched: ${app} — verified running process "${wbase}"`, data: { app, process: wbase, verified: true } };
          }
          // macOS shares the Linux path below with open(1) as the OS handler.
          // Never pass the app string through a shell; resolve it like a PATH
          // executable. Launch DETACHED so the app outlives this tool call —
          // the old execFileAsync('nohup', [app], { timeout: 5000 }) version
          // SIGTERM-killed the freshly launched app after 5 seconds and then
          // claimed "Launched: app" (fake success + real damage).
          const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
          // spawn() does NOT throw synchronously for ENOENT — it emits an
          // async 'error' event, so the launch attempt must be awaited via
          // the 'spawn' (success) / 'error' (failure) events.
          try {
            await new Promise<void>((resolve, reject) => {
              const child = spawn(app, [], { detached: true, stdio: 'ignore', env });
              child.once('spawn', () => { child.unref(); resolve(); });
              child.once('error', (err) => reject(err));
            });
          } catch {
            // ENOENT etc.: not launchable directly — try the OS open handler
            // (xdg-open on Linux — the frozen v1.4.0 behavior — / open on
            // macOS) through the runner seam before giving up.
            try {
              await this.runner(openWith ? openWith.cmd : 'xdg-open', [app], 10000);
            } catch (xdgError: any) {
              return {
                success: false,
                output: '',
                error: `Failed to launch ${app}: not found on PATH and xdg-open failed (${xdgError.message})`,
              };
            }
          }

          // Verification read-back: is the process actually alive after a
          // short startup window? Uses the shared runner seam so tests can
          // drive both outcomes. pidof/pgrep match the basename of the app.
          // For the xdg-open path the handler's process name is unknown, so
          // the same check runs against the basename — if it does not match
          // anything, the launch stays UNVERIFIED (never a silent success).
          const base = app.split('/').pop() || app;
          let alive = false;
          try {
            await new Promise((r) => setTimeout(r, 700));
            const { stdout } = await this.runner('pgrep', ['-x', base], 3000);
            alive = stdout.trim().length > 0;
          } catch {
            try {
              // Fallback: pidof (not all systems ship pgrep semantics for -x)
              const { stdout } = await this.runner('pidof', [base], 3000);
              alive = stdout.trim().length > 0;
            } catch {
              alive = false;
            }
          }

          if (!alive) {
            return {
              success: false,
              output: '',
              error: `Launch NOT verified: no running process named "${base}" after startup window (it may have crashed immediately, been dispatched by xdg-open under a different process name, or the name differs from "${app}")`,
              data: { app, verified: false },
            };
          }
          return { success: true, output: `Launched: ${app} — verified running process "${base}"`, data: { app, process: base, verified: true } };
        }

        case 'focus_window': {
          const title = String(args.windowTitle ?? '');
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.runLiteral('xdg-activate focus 2>/dev/null || true', 3000);
            return { success: true, output: `Attempted to focus: ${title} (Wayland limited — focus not verified)` };
          }
          const windowIds = await this.xdotoolSearch(title);
          if (windowIds.length > 0) {
            await this.xdotoolWindowAction(windowIds[0], 'windowactivate', '');
            // Verification read-back: getactivewindow returns the REAL active
            // window name; a focus that did not take effect is a failure.
            let active = '';
            try {
              active = await this.xdotoolGetActiveWindow();
            } catch { /* read-back unavailable */ }
            if (active && !active.toLowerCase().includes(title.toLowerCase())) {
              return {
                success: false,
                output: '',
                error: `Focus NOT verified: active window is "${active}", expected it to match "${title}"`,
                data: { requested: title, actualActiveWindow: active },
              };
            }
            return { success: true, output: `Focused window: ${title}${active ? ` — verified (active: "${active}")` : ' (focus read-back unavailable)'}`, data: { requested: title, actualActiveWindow: active || undefined } };
          }
          return { success: false, output: '', error: `Window not found: ${title}` };
        }

        case 'close_window': {
          const ds = await this.detectDisplayServer();
          const title = String(args.windowTitle ?? '');
          if (ds === 'wayland') {
            await this.ydotoolKey('alt+F4');
            return { success: true, output: 'Sent close shortcut (Wayland) — window teardown not verified' };
          }
          if (title) {
            const windowIds = await this.xdotoolSearch(title);
            if (windowIds.length > 0) {
              const before = windowIds.length;
              await this.runTool(['xdotool', 'windowclose', windowIds[0]]);
              // Verification read-back: the closed window must be GONE from
              // the real window list (bounded re-check).
              for (let i = 0; i < 5; i++) {
                await new Promise((r) => setTimeout(r, 300));
                try {
                  const after = await this.xdotoolSearch(title);
                  if (after.length < before) {
                    return { success: true, output: `Closed window: ${title} — verified gone from window list`, data: { requested: title, verified: true } };
                  }
                } catch { /* search failed; treat as unverifiable */ break; }
              }
              return {
                success: false,
                output: '',
                error: `Close NOT verified: window "${title}" still present after windowclose`,
                data: { requested: title, verified: false },
              };
            }
          }
          await this.xdotoolKey('alt+F4');
          return { success: true, output: 'Sent alt+F4 to active window — teardown not verified' };
        }

        case 'minimize_window': {
          const ds = await this.detectDisplayServer();
          const title = String(args.windowTitle ?? '');
          if (ds === 'wayland') {
            await this.ydotoolKey('alt+F9');
            return { success: true, output: 'Minimized active window (Wayland) — not verified' };
          }
          if (title) {
            const windowIds = await this.xdotoolSearch(title);
            if (windowIds.length > 0) {
              await this.runTool(['xdotool', 'windowminimize', windowIds[0]]);
              return { success: true, output: `Minimized window: ${title}`, data: { requested: title } };
            }
          }
          await this.xdotoolKey('alt+F9');
          return { success: true, output: 'Minimized active window (not verified)' };
        }

        case 'maximize_window': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            await this.ydotoolKey('super+Up');
            return { success: true, output: 'Maximized window (Wayland) — not verified' };
          }
          await this.xdotoolKey('super+Up');
          return { success: true, output: 'Maximized active window (not verified)' };
        }

        case 'list_windows': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            try {
              const { stdout } = await execAsync('wmctrl -l 2>/dev/null || swaymsg -t get_tree 2>/dev/null || true', { timeout: 3000 });
              return { success: true, output: stdout.trim() || 'Window listing limited on Wayland', data: {} };
            } catch {
              return { success: true, output: 'Window listing not available on this Wayland session', data: {} };
            }
          }
          const windows = await this.xdotoolSearch('');
          const windowNames: string[] = [];
          for (const id of windows.slice(0, 20)) {
            try {
              const name = await this.runTool(['xdotool', 'getwindowname', id]);
              windowNames.push(`${id}: ${name}`);
            } catch { /* skip unreadable windows */ }
          }
          return {
            success: true,
            output: windowNames.length > 0 ? windowNames.join('\n') : 'No windows found',
            data: { windows: windowNames },
          };
        }

        case 'get_active_window': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            return { success: true, output: 'Active window detection limited on Wayland', data: {} };
          }
          const name = await this.xdotoolGetActiveWindow();
          return { success: true, output: `Active window: ${name}`, data: { windowName: name } };
        }

        case 'get_mouse_position': {
          const ds = await this.detectDisplayServer();
          if (ds === 'wayland') {
            return { success: true, output: 'Mouse position detection limited on Wayland', data: {} };
          }
          const pos = await this.runTool(['xdotool', 'getmouselocation']);
          return { success: true, output: pos, data: { position: pos } };
        }

        case 'get_screen_size': {
          try {
            const { stdout } = await execAsync('xdpyinfo | grep dimensions 2>/dev/null || wlr-randr 2>/dev/null || echo "Unable to determine"', {
              timeout: 3000,
              env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
            });
            return { success: true, output: stdout.trim(), data: { screenInfo: stdout.trim() } };
          } catch {
            return { success: true, output: 'Unable to determine screen size', data: {} };
          }
        }

        default:
          return { success: false, output: '', error: `Unknown action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, output: '', error: `Computer control failed: ${error.message}` };
    }
  }

  requiresConfirmation(args: Record<string, unknown>): boolean {
    const action = args.action as string;
    return ['close_window', 'launch_app'].includes(action);
  }
}
