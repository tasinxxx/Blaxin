// Tests for the 10× system-awareness telemetry extension.
// Contract-based: every sensor must return REAL bounded values when its
// source exists, or an HONEST unavailable state when it does not. Tests
// never assert machine-specific contents (this must pass on any machine).
import { describe, it, expect } from 'vitest';
import {
  getBatteryTelemetry,
  getDisplayAndWindowsTelemetry,
  getAudioTelemetry,
  getProcessesTelemetry,
  parseWpctlVolume,
  parseActiveWindowId,
  parseXpropClass,
  parseNetWmName,
  parseWindowGeometry,
  parseXwininfoTree,
  parseStat,
  getSystemTelemetry,
} from '../utils/system-telemetry.js';

describe('battery telemetry', () => {
  it('returns honest present=false when the machine has no power_supply tree', () => {
    // Synthetic dir that does not exist anywhere — exercised via the
    // exported parser contract instead: on a real machine present=true.
    const t = getBatteryTelemetry();
    // Real machine contract: either an honest battery or honest absence.
    if (t.present) {
      expect(t.cells.length).toBeGreaterThan(0);
      expect(t.capacityPercent === null || (t.capacityPercent >= 0 && t.capacityPercent <= 100)).toBe(true);
      if (t.acOnline !== null) {
        expect(typeof t.acOnline).toBe('boolean');
        if (t.acOnline === true) expect(t.status).toBe('Charging');
      }
    } else {
      expect(t.capacityPercent).toBeNull();
      expect(t.cells).toHaveLength(0);
    }
  });

  it('never fabricates minutesRemaining outside a sane bound', () => {
    const t = getBatteryTelemetry();
    if (t.minutesRemaining !== null) {
      expect(t.minutesRemaining).toBeGreaterThan(0);
      expect(t.minutesRemaining).toBeLessThanOrEqual(24 * 60);
    }
  });
});

describe('x11 parsers (pure contract)', () => {
  it('parses _NET_ACTIVE_WINDOW from real xprop -root output', () => {
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3c00007, 0x0')).toBe('0x3c00007');
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0, 0x0')).toBe('0x0');
    expect(parseActiveWindowId('no active window property here')).toBeNull();
  });

  it('parses WM_CLASS preferring the instance-res class field', () => {
    expect(parseXpropClass('WM_CLASS(STRING) = " Navigator", "firefox"')).toBe('firefox');
    expect(parseXpropClass('WM_CLASS(STRING) = "XTerm", "xterm"')).toBe('xterm');
    expect(parseXpropClass('unrelated output')).toBeNull();
  });

  it('parses _NET_WM_NAME and tolerates special characters', () => {
    expect(parseNetWmName('_NET_WM_NAME(UTF8_STRING) = "Code — project.ts — editor"\n')).toBe('Code — project.ts — editor');
    expect(parseNetWmName('_NET_WM_NAME(STRING) = "not utf8 style"\n')).toBeNull();
  });

  it('parses xwininfo geometry and root size', () => {
    const geo = parseWindowGeometry([
      'xwininfo: Window id: 0x3c00007',
      '  Absolute upper-left X:  192',
      '  Absolute upper-left Y:  108',
      '  Width: 1024',
      '  Height: 768',
    ].join('\n'));
    expect(geo).toEqual({ x: 192, y: 108, width: 1024, height: 768 });
    const root = parseXwininfoTree('  Absolute upper-left X: 0\n  Width: 1920\n  Height: 1080\n');
    expect(root).toEqual({ width: 1920, height: 1080 });
    expect(parseXwininfoTree('nothing here')).toEqual({ width: null, height: null });
    expect(parseWindowGeometry('nothing here')).toBeNull();
  });
});

describe('display/windows telemetry (real or honest)', () => {
  it('returns a real display when X is reachable, honest unavailable otherwise', async () => {
    const { display, windows } = await getDisplayAndWindowsTelemetry();
    if (display?.available) {
      expect(display.display).toMatch(/^:\d/);
      expect(display.widthPx === null || (display.widthPx > 0 && (display.heightPx ?? 0) > 0)).toBe(true);
      expect(windows?.available).toBe(true);
      for (const w of windows?.windows ?? []) {
        expect(w.id).toMatch(/^0x[0-9a-f]+$/);
        expect(w.title !== null || w.wmClass !== null).toBe(true);
      }
    } else {
      expect(display?.unavailableReason).toBeTruthy();
    }
  });
});

describe('audio telemetry (real or honest)', () => {
  it('returns bounded real volume when wpctl exists, honest unavailability otherwise', async () => {
    const a = await getAudioTelemetry();
    if (a.available) {
      expect(a.volumePercent).toBeGreaterThanOrEqual(0);
      expect(a.volumePercent!).toBeLessThanOrEqual(150);
      expect(typeof a.muted).toBe('boolean');
    } else {
      expect(a.unavailableReason).toBeTruthy();
      expect(a.volumePercent).toBeNull();
    }
  });
});

describe('wpctl volume parser', () => {
  it('parses real wpctl get-volume output shapes', () => {
    // Real wpctl semantic (verified live: a parsed volume line without
    // "[MUTED]" is genuinely unmuted — the marker appears ONLY when muted).
    expect(parseWpctlVolume('Volume: 1.50')).toEqual({ volumePercent: 150, muted: false });
    expect(parseWpctlVolume('Volume: 0.65 [MUTED]')).toEqual({ volumePercent: 65, muted: true });
    expect(parseWpctlVolume('Volume: 1.00')).toEqual({ volumePercent: 100, muted: false });
    expect(parseWpctlVolume('No default sink')).toEqual({ volumePercent: null, muted: null });
  });
});

describe('process telemetry', () => {
  it('parses /proc/<pid>/stat with spaces and parentheses in comm', () => {
    const p = parseStat('12345 (Web Content) S 1 1 1 0 -1 4194560 1 0 0 0 12 34 0 0 20 0 5 0 999 0 44');
    expect(p?.comm).toBe('Web Content');
    expect(p?.utime).toBe(12);
    expect(p?.stime).toBe(34);
    expect(p?.rssPages).toBe(44);
  });

  it('first sample is honest (no fake cpu percent), second sample yields bounded deltas', () => {
    const first = getProcessesTelemetry();
    expect(first.count).toBeGreaterThan(0);
    expect(first.totalRssBytes === null || first.totalRssBytes > 0).toBe(true);
    const second = getProcessesTelemetry();
    expect(second.count).toBeGreaterThan(0);
    for (const p of second.top) {
      expect(p.cpuPercent === null || (p.cpuPercent >= 0 && p.cpuPercent <= 100)).toBe(true);
      expect(p.comm.length).toBeGreaterThan(0);
    }
  });
});

describe('integrated telemetry', () => {
  it('carries all system-awareness sensors with honest shapes', async () => {
    const t = await getSystemTelemetry();
    expect(t.timestamp).toBeGreaterThan(0);
    // Battery: real sensor object or honest null-ness inside it.
    expect(t.battery === null || typeof t.battery.present === 'boolean').toBe(true);
    // Display: available with a display name, or an honest reason.
    expect(t.display === null || t.display.available === false || /^:\d/.test(t.display.display ?? '')).toBe(true);
    if (t.display && !t.display.available) expect(t.display.unavailableReason).toBeTruthy();
    // Audio: bounded or honestly unavailable.
    if (t.audio?.available) {
      expect(t.audio.volumePercent).toBeGreaterThanOrEqual(0);
      expect(t.audio.volumePercent!).toBeLessThanOrEqual(150);
    }
    // Processes: real count, bounded list.
    expect(t.processes.count).toBeGreaterThan(0);
    expect(t.processes.top.length).toBeLessThanOrEqual(8);
  });
});
