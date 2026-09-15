// LIVE system_audio verification (env-gated: BLAXIN_LIVE_AUDIO=1)
// =============================================================
// The REAL get→set→get loop against the REAL PipeWire default sink:
//   read the live volume → set a new level → re-read → confirm the level
//   really changed → restore the original state (leave the machine as
//   it was found). No mocks. Skipped unless the flag is set AND wpctl
//   answers — honesty about the environment, never a fake success.
//   BLAXIN_LIVE_AUDIO=1 npx vitest run src/__tests__/system-audio-live.test.ts
// =============================================================

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';

const FLAG = !!process.env.BLAXIN_LIVE_AUDIO;

function wpctlAvailable(): boolean {
  try {
    execFileSync('which', ['wpctl'], { stdio: 'pipe' });
    execFileSync('wpctl', ['status'], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const d = FLAG && wpctlAvailable() ? it : it.skip;

describe('LIVE system_audio on the real PipeWire sink', () => {
  d('get → set → get confirms the level really changed, then restores', async () => {
    const { SystemAudioTool } = await import('../tools/system-audio.js');
    const tool = new SystemAudioTool();

    // GET: the live state must be readable.
    const before = await tool.execute({ action: 'get' });
    expect(before.success).toBe(true);
    const original = before.data?.volumePct as number;
    expect(typeof original).toBe('number');

    // SET to a different level (pick something distinct from the original).
    const target = original >= 45 ? 35 : 55;
    const set = await tool.execute({ action: 'set', percent: target });
    expect(set.success).toBe(true);
    expect(set.data).toMatchObject({ requested: target, after: target, verified: true });

    // GET again through a FRESH tool instance — the change is real system
    // state, not a cached value in the tool.
    const fresh = new SystemAudioTool();
    const after = await fresh.execute({ action: 'get' });
    expect(after.success).toBe(true);
    expect(after.data?.volumePct).toBe(target);

    // RESTORE the original state (leave the machine as found).
    const restore = await fresh.execute({ action: 'set', percent: original });
    expect(restore.success).toBe(true);
    expect(restore.data?.after).toBe(original);
  }, 30000);
});
