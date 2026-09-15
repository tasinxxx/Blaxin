// system_audio — verified get→set→get volume control
// =============================================================
// Stonic parity gap from docs/capability-matrix.md ("control volume by
// asking"). Honesty rules under test:
//   · a SET is only SUCCESS when a fresh read-back confirms the level;
//   · unreadable state is FAILURE, never a guessed success;
//   · missing wpctl is an honest unavailability, never a fake result.
// All outcomes driven through the injectable runner seam (no real audio
// calls in unit tests); a LIVE test proves the real PipeWire read-back.
// =============================================================

import { describe, it, expect } from 'vitest';
import { SystemAudioTool, AudioRunner } from '../tools/system-audio.js';

/** Fake wpctl with a mutable backing volume (the "OS audio state"). */
function fakeOs(initial = { volumePct: 40, muted: false }) {
  const state = { ...initial };
  const runner: AudioRunner = async (cmd, args) => {
    if (cmd === 'which') {
      if (args[0] === 'wpctl') return { stdout: '/usr/bin/wpctl', stderr: '' };
      throw new Error('not found');
    }
    if (cmd !== 'wpctl') throw new Error(`unexpected cmd ${cmd}`);
    if (args[0] === 'status') {
      const vol = (state.volumePct / 100).toFixed(2);
      const mute = state.muted ? ' [audio_muted]' : '';
      return {
        stdout: `PipeWire\nAudio\n ├─ Sinks:\n │  *   55. Built-in Audio Analog Stereo        [vol: ${vol}]${mute}\n`,
        stderr: '',
      };
    }
    if (args[0] === 'set-volume') {
      const frac = Number(args[2]);
      state.volumePct = Math.round(frac * 100);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'set-mute') {
      state.muted = args[2] === '1';
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected wpctl args ${args.join(' ')}`);
  };
  return { runner, state };
}

describe('system_audio: get', () => {
  it('reads the live volume + mute state', async () => {
    const os = fakeOs({ volumePct: 65, muted: false });
    const tool = new SystemAudioTool(os.runner);
    const r = await tool.execute({ action: 'get' });
    expect(r.success).toBe(true);
    expect(r.data?.volumePct).toBe(65);
    expect(r.data?.verified).toBe(true);
    expect(r.output).toContain('65%');
  });

  it('FAILS honestly when no sink volume is readable', async () => {
    const runner: AudioRunner = async (cmd) => {
      if (cmd === 'which') return { stdout: '/usr/bin/wpctl', stderr: '' };
      return { stdout: 'PipeWire\n (no sinks)', stderr: '' };
    };
    const tool = new SystemAudioTool(runner);
    const r = await tool.execute({ action: 'get' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('unreadable');
  });
});

describe('system_audio: set (get→set→get verification)', () => {
  it('SUCCEEDS when read-back confirms the new level', async () => {
    const os = fakeOs({ volumePct: 30, muted: false });
    const tool = new SystemAudioTool(os.runner);
    const r = await tool.execute({ action: 'set', percent: 80 });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ requested: 80, before: 30, after: 80, verified: true });
    expect(os.state.volumePct).toBe(80);
    expect(r.output).toMatch(/verified by read-back/);
  });

  it('FAILS when read-back does NOT match the request (no fake success)', async () => {
    // A "buggy OS" that ignores the set: exit 0 but the level is unchanged.
    const os = fakeOs({ volumePct: 30, muted: false });
    const broken: AudioRunner = async (cmd, args, timeoutMs) => {
      if (cmd === 'wpctl' && args[0] === 'set-volume') return { stdout: '', stderr: '' }; // silently ignores
      return os.runner(cmd, args, timeoutMs);
    };
    const tool = new SystemAudioTool(broken);
    const r = await tool.execute({ action: 'set', percent: 80 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('NOT verified');
    expect(r.data?.verified).toBe(false);
  });

  it('rejects out-of-range and non-numeric percentages', async () => {
    const os = fakeOs();
    const tool = new SystemAudioTool(os.runner);
    for (const percent of [-5, 999, 'abc'] as unknown as number[]) {
      const r = await tool.execute({ action: 'set', percent });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Invalid volume percent/);
    }
    expect(os.state.volumePct).toBe(40); // nothing changed
  });
});

describe('system_audio: mute/unmute (read-back verified)', () => {
  it('mutes and verifies the mute marker', async () => {
    const os = fakeOs({ volumePct: 50, muted: false });
    const tool = new SystemAudioTool(os.runner);
    const r = await tool.execute({ action: 'mute' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ muted: true, verified: true });
    expect(os.state.muted).toBe(true);
  });

  it('FAILS when the mute does not take (no fake success)', async () => {
    const os = fakeOs({ volumePct: 50, muted: false });
    const broken: AudioRunner = async (cmd, args, timeoutMs) => {
      if (cmd === 'wpctl' && args[0] === 'set-mute') return { stdout: '', stderr: '' }; // ignores
      return os.runner(cmd, args, timeoutMs);
    };
    const tool = new SystemAudioTool(broken);
    const r = await tool.execute({ action: 'mute' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('NOT verified');
  });

  it('unmutes and verifies', async () => {
    const os = fakeOs({ volumePct: 50, muted: true });
    const tool = new SystemAudioTool(os.runner);
    const r = await tool.execute({ action: 'unmute' });
    expect(r.success).toBe(true);
    expect(r.data?.muted).toBe(false);
  });
});

describe('system_audio: honest unavailability', () => {
  it('FAILS with an install hint when wpctl does not exist (never fakes)', async () => {
    const runner: AudioRunner = async (cmd, args) => {
      if (cmd === 'which') throw new Error('not found');
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    };
    const tool = new SystemAudioTool(runner);
    const r = await tool.execute({ action: 'get' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('wpctl');
    expect(r.data?.available).toBe(false);
  });
});
