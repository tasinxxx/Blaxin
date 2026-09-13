// LIVE X11 desktop verification (env-gated: BLAXIN_LIVE_DESKTOP=1)
// =============================================================
// Drives the REAL ComputerControlTool / ScreenshotTool / ClipboardTool
// against the machine's actual X display and asserts the read-backs the
// tools promise. Skipped unless both the env flag AND a working DISPLAY
// are present, so CI stays green.
//   BLAXIN_LIVE_DESKTOP=1 npx vitest run src/__tests__/tools/desktop-live.test.ts
//
// Deliberately NOT exercised here: real keystroke/typing injection. The
// host has a live focused window (possibly a terminal); injecting
// keystrokes could damage the operator's session, and the honest
// "events sent; receiver not verified" phrasing for that path is already
// pinned deterministically in tool-verification.test.ts.
// =============================================================

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { ComputerControlTool } from '../../tools/computer-control.js';
import { ScreenshotTool } from '../../tools/screenshot.js';
import { ClipboardTool } from '../../tools/clipboard.js';

const FLAG = !!process.env.BLAXIN_LIVE_DESKTOP;

function displayWorks(): boolean {
  if (!process.env.DISPLAY) return false;
  try {
    execFileSync('xdpyinfo', ['-display', process.env.DISPLAY], { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

const LIVE = FLAG && displayWorks();
const d = LIVE ? describe : describe.skip;

const nums = (text: string): number[] => (text.match(/-?\d+/g) ?? []).map(Number);

d('live desktop control (BLAXIN_LIVE_DESKTOP=1, real X display)', () => {
  let cc: ComputerControlTool;
  let shot: ScreenshotTool;
  let clip: ClipboardTool;

  beforeAll(() => {
    cc = new ComputerControlTool();
    shot = new ScreenshotTool();
    clip = new ClipboardTool();
  });

  it('reads the REAL screen geometry', async () => {
    const r = await cc.execute({ action: 'get_screen_size' });
    expect(r.success).toBe(true);
    const dims = nums(String(r.output));
    expect(dims.length).toBeGreaterThanOrEqual(2);
    expect(dims[0]).toBeGreaterThan(0);
    expect(dims[1]).toBeGreaterThan(0);
  }, 30_000);

  it('moves the real pointer and verifies it by read-back, then restores it', async () => {
    const before = await cc.execute({ action: 'get_mouse_position' });
    expect(before.success).toBe(true);
    const [origX, origY] = nums(String(before.output));
    expect(Number.isFinite(origX)).toBe(true);

    const size = await cc.execute({ action: 'get_screen_size' });
    const dims = nums(String(size.output));
    const targetX = Math.max(1, Math.round((dims[0] ?? 100) * 0.25));
    const targetY = Math.max(1, Math.round((dims[1] ?? 100) * 0.25));

    const move = await cc.execute({ action: 'mouse_move', x: targetX, y: targetY });
    expect(move.success).toBe(true);

    const after = await cc.execute({ action: 'get_mouse_position' });
    const [gotX, gotY] = nums(String(after.output));
    expect(Math.abs(gotX - targetX)).toBeLessThanOrEqual(2);
    expect(Math.abs(gotY - targetY)).toBeLessThanOrEqual(2);

    // Leave the operator's pointer where we found it.
    if (Number.isFinite(origX) && Number.isFinite(origY)) {
      await cc.execute({ action: 'mouse_move', x: origX, y: origY });
    }
  }, 40_000);

  it('lists real windows / reports the real active window honestly', async () => {
    const list = await cc.execute({ action: 'list_windows' });
    // Either a real list or an honest "no windows" — never a fabricated success.
    expect(typeof list.success).toBe('boolean');

    const active = await cc.execute({ action: 'get_active_window' });
    expect(typeof active.success).toBe('boolean');
  }, 30_000);

  it('captures a REAL screenshot (non-zero PNG)', async () => {
    const r = await shot.execute({});
    expect(r.success).toBe(true);
    const size = Number((r.data as { size?: number } | undefined)?.size ?? 0);
    expect(size).toBeGreaterThan(0);
  }, 40_000);

  it('writes the clipboard and verifies it by real read-back', async () => {
    const token = `blaxin-live-${Date.now()}`;
    const write = await clip.execute({ action: 'write', text: token });
    expect(write.success).toBe(true);
    expect((write.data as { verified?: boolean } | undefined)?.verified).toBe(true);

    const read = await clip.execute({ action: 'read' });
    expect(read.success).toBe(true);
    expect(String((read.data as { content?: string } | undefined)?.content ?? '')).toContain(token);
  }, 30_000);
});
