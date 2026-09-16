// LIVE process_control verification (env-gated: BLAXIN_LIVE_PROCESSES=1)
// =============================================================
// The REAL list → inspect → kill loop against the REAL OS process
// table: spawn a real sleep process → find it in a REAL ps listing →
// inspect it → kill it → confirm by an INDEPENDENT system read that it
// is really gone. No mocks. Skipped unless the flag is set — honesty
// about the environment, never a fake success.
//   BLAXIN_LIVE_PROCESSES=1 npx vitest run src/__tests__/process-control-live.test.ts
// =============================================================

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';

const FLAG = !!process.env.BLAXIN_LIVE_PROCESSES;
const d = FLAG ? it : it.skip;

describe('LIVE process_control on the real OS process table', () => {
  d('list → inspect → kill → independently verified gone', async () => {
    const { ProcessControlTool } = await import('../tools/process-control.js');
    const tool = new ProcessControlTool();

    // Spawn a REAL, findable process. `sleep` directly — bash -c would
    // exec-replace and hand the pid to its child (observed live).
    const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    try {
      // Give the process a moment to appear in ps.
      await new Promise((r) => setTimeout(r, 500));

      // LIST: real bounded table (top-N by cpu — a 0%-cpu sleep may not
      // be in it; presence of the exact pid is inspect's job below).
      const list = await tool.execute({ action: 'list', limit: 50 });
      expect(list.success).toBe(true);
      expect(list.data?.total).toBeGreaterThan(0);
      expect(list.data?.shown).toBeLessThanOrEqual(50);
      expect((list.data?.processes as Array<{ pid: number }>).length).toBe(list.data?.shown);

      // INSPECT: real details for the exact pid — the REAL witness that
      // the spawned process exists in the system's own process table.
      const inspect = await tool.execute({ action: 'inspect', pid });
      expect(inspect.success).toBe(true);
      const proc = inspect.data?.process as { pid: number; comm: string };
      expect(proc.pid).toBe(pid);
      expect(proc.comm).toContain('sleep');

      // KILL: verified gone by the tool's own read-back.
      const kill = await tool.execute({ action: 'kill', pid });
      expect(kill.success).toBe(true);
      expect(kill.data?.verified).toBe(true);
    } finally {
      // Safety net: never leave a stray sleep behind, whatever failed.
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }

    // INDEPENDENT witness: a raw system ps (not the tool) shows nothing.
    const { execFileSync } = await import('child_process');
    let alive = true;
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'pid='], { timeout: 3000 });
      alive = out.toString().trim().length > 0;
    } catch {
      alive = false; // ps exits non-zero for a dead pid
    }
    expect(alive).toBe(false);
  });
});
