// process_control — verified list / inspect / kill
// =============================================================
// Phase B 10× candidate: process/app control verbs on the real machine.
// Honesty rules under test:
//   · list/inspect report REAL ps data; unparseable ps output is an
//     honest FAILURE, never a fabricated empty success;
//   · a kill is SUCCESS only when a fresh read-back shows the pid GONE;
//   · a process that ignores SIGTERM is reported honestly (and force
//     escalates to SIGKILL — still read-back verified);
//   · protected pids (init, this server) are REFUSED before any signal;
//   · no-such-pid at signal time is an honest FAILURE, never a fake
//     "killed" answer.
// All outcomes driven through the injectable runner seam (no real
// signals in unit tests); a LIVE test proves the real read-back.
// =============================================================

import { describe, it, expect } from 'vitest';
import { ProcessControlTool, ProcessRunner, parsePsRows } from '../tools/process-control.js';

const PS_OPTS = 'pid=,pcpu=,pmem=,stat=,etimes=,comm=,args=';

/** A fake "OS" with real processes that can die (or ignore signals). */
function fakeOs(initial: Array<{ pid: number; comm: string; args?: string; cpu?: number; mem?: number; stat?: string; elapsed?: number; ignoresTerm?: boolean }>) {
  const procs = new Map(initial.map((p) => [p.pid, { ...p }]));
  let signals = 0;
  const runner: ProcessRunner = async (cmd, args) => {
    if (cmd === 'ps') {
      // Real ps uses the combined '-eo' flag for listings and '-p PID -o'
      // for single-process reads; both carry the same column spec.
      const eoIdx = args.findIndex((a) => a === '-eo' || a === '-o');
      const opts = eoIdx >= 0 ? args[eoIdx + 1] : '';
      const pidFlag = args.indexOf('-p') >= 0 ? args[args.indexOf('-p') + 1] : null;
      const rows = [...procs.values()]
        .filter((p) => (pidFlag === null ? true : p.pid === Number(pidFlag)))
        .map(
          (p) =>
            `${p.pid} ${p.cpu ?? 1.2} ${p.mem ?? 0.8} ${p.stat ?? 'Sl'} ${p.elapsed ?? 120} ${p.comm} ${p.args ?? p.comm}`,
        );
      if (opts !== PS_OPTS && opts !== 'pid=') throw new Error(`unexpected -o ${opts}`);
      // A dead pid: ps -p prints nothing but exits 0 (real behavior).
      return { stdout: rows.join('\n') + (rows.length ? '\n' : ''), stderr: '' };
    }
    if (cmd === 'kill') {
      signals += 1;
      const sig = args[0];
      const pid = Number(args[1]);
      const proc = procs.get(pid);
      if (!proc) throw Object.assign(new Error('no such process'), { code: 1 });
      if (sig === '-KILL' || !proc.ignoresTerm) procs.delete(pid);
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected cmd ${cmd}`);
  };
  return { runner, procs, signalCount: () => signals };
}

describe('process_control: list', () => {
  it('lists REAL processes sorted by cpu, bounded by the limit', async () => {
    const os = fakeOs([
      { pid: 100, comm: 'chrome', args: 'chrome --render', cpu: 12.5, mem: 3.1 },
      { pid: 200, comm: 'node', args: 'node server.js', cpu: 40.2, mem: 8.4 },
      { pid: 300, comm: 'vim', args: 'vim notes.txt', cpu: 0.1, mem: 0.2 },
    ]);
    const tool = new ProcessControlTool(os.runner);
    const r = await tool.execute({ action: 'list', limit: 2 });
    expect(r.success).toBe(true);
    expect(r.data?.verified).toBe(true);
    expect(r.data?.total).toBe(3);
    expect(r.data?.shown).toBe(2);
    const procs = r.data?.processes as Array<{ pid: number; cpuPct: number }>;
    // Sorted by REAL cpu: node (40.2) first, chrome (12.5) second.
    expect(procs[0]).toMatchObject({ pid: 200, cpuPct: 40.2 });
    expect(procs[1].pid).toBe(100);
    expect(r.output).toContain('node server.js');
  });

  it('sorts by memory when asked', async () => {
    const os = fakeOs([
      { pid: 100, comm: 'a', cpu: 1, mem: 1 },
      { pid: 200, comm: 'b', cpu: 2, mem: 9 },
    ]);
    const tool = new ProcessControlTool(os.runner);
    const r = await tool.execute({ action: 'list', sortBy: 'mem' });
    expect((r.data?.processes as Array<{ pid: number }>)[0].pid).toBe(200);
  });

  it('FAILS honestly when ps output parses to nothing (never an empty success)', async () => {
    const runner: ProcessRunner = async (cmd) => {
      if (cmd === 'ps') return { stdout: 'garbage line\n\n???', stderr: '' };
      throw new Error(`unexpected ${cmd}`);
    };
    const tool = new ProcessControlTool(runner);
    const r = await tool.execute({ action: 'list' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('unreadable');
  });

  it('caps the limit at 50 (bounded scans only)', async () => {
    const os = fakeOs(
      Array.from({ length: 80 }, (_, i) => ({ pid: 1000 + i, comm: `p${i}`, cpu: 0.1 })),
    );
    const tool = new ProcessControlTool(os.runner);
    const r = await tool.execute({ action: 'list', limit: 99999 });
    expect(r.data?.shown).toBe(50);
    expect((r.data?.processes as Array<unknown>).length).toBe(50);
  });
});

describe('process_control: inspect', () => {
  it('inspects one real pid', async () => {
    const os = fakeOs([{ pid: 4242, comm: 'node', args: 'node /srv/app.js', cpu: 7.7, mem: 2.2, elapsed: 3730 }]);
    const tool = new ProcessControlTool(os.runner);
    const r = await tool.execute({ action: 'inspect', pid: 4242 });
    expect(r.success).toBe(true);
    expect(r.data?.process).toMatchObject({ pid: 4242, comm: 'node' });
    expect(r.output).toContain('1h2m');
  });

  it('an unknown pid is an honest FAILURE (never guessed)', async () => {
    const os = fakeOs([{ pid: 1, comm: 'init' }]);
    const tool = new ProcessControlTool(os.runner);
    const r = await tool.execute({ action: 'inspect', pid: 987654 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('987654');
  });
});

describe('process_control: kill', () => {
  it('kills by pid and verifies the process is REALLY gone', async () => {
    const os = fakeOs([{ pid: 555, comm: 'loop', args: 'loop --forever', ignoresTerm: false }]);
    const tool = new ProcessControlTool(os.runner);
    const r = await tool.execute({ action: 'kill', pid: 555 });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ pid: 555, signal: 'SIGTERM', escalated: false, verified: true });
    expect(os.procs.has(555)).toBe(false);
    expect(r.output).toContain('verified gone');
  });

  it('reports SIGTERM-ignoring processes honestly and escalates ONLY with force', async () => {
    const os = fakeOs([{ pid: 666, comm: 'stubborn', args: 'stubborn --no-die', ignoresTerm: true }]);
    const tool = new ProcessControlTool(os.runner);

    const noForce = await tool.execute({ action: 'kill', pid: 666 });
    expect(noForce.success).toBe(false);
    expect(noForce.error).toContain('still running after SIGTERM');
    expect(noForce.error).toContain('force: true'); // the retry path is named
    expect(os.procs.has(666)).toBe(true); // still alive — reported, not faked

    const forced = await tool.execute({ action: 'kill', pid: 666, force: true });
    expect(forced.success).toBe(true);
    expect(forced.data).toMatchObject({ signal: 'SIGKILL', escalated: true, verified: true });
    expect(os.procs.has(666)).toBe(false);
  });

  it('nothing on disk... rather: no-such-pid at signal time is an honest FAILURE', async () => {
    const os = fakeOs([{ pid: 1, comm: 'init' }]);
    const tool = new ProcessControlTool(os.runner);
    const r = await tool.execute({ action: 'kill', pid: 31337 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('no process with pid 31337');
    expect(r.data?.observed).toBe(false);
  });

  it('REFUSES protected pids before any signal is sent', async () => {
    const os = fakeOs([{ pid: 1, comm: 'init' }]);
    const tool = new ProcessControlTool(os.runner);
    for (const pid of [1, 2]) {
      const r = await tool.execute({ action: 'kill', pid });
      expect(r.success).toBe(false);
      expect(r.error).toContain('protected');
    }
    expect(os.signalCount()).toBe(0); // never signaled
  });

  it('refuses to kill the BLAXIN server itself', async () => {
    const os = fakeOs([{ pid: 1, comm: 'init' }]);
    const tool = new ProcessControlTool(os.runner);
    const r = await tool.execute({ action: 'kill', pid: process.pid });
    expect(r.success).toBe(false);
    expect(r.error).toContain('BLAXIN server');
    expect(os.signalCount()).toBe(0);
  });

  it('rejects invalid pids without touching the OS', async () => {
    const os = fakeOs([]);
    const tool = new ProcessControlTool(os.runner);
    for (const pid of [0, -5, 1.5, Number.NaN]) {
      const r = await tool.execute({ action: 'kill', pid });
      expect(r.success).toBe(false);
    }
    expect(os.signalCount()).toBe(0);
  });

  it('kill requires confirmation (the gate always asks)', async () => {
    const tool = new ProcessControlTool(fakeOs([]).runner);
    expect(tool.requiresConfirmation?.({ action: 'kill', pid: 100 })).toBe(true);
    expect(tool.requiresConfirmation?.({ action: 'list' })).toBe(false);
    expect(tool.requiresConfirmation?.({ action: 'inspect', pid: 100 })).toBe(false);
  });
});

describe('parsePsRows (parser contract)', () => {
  it('parses real ps -eo output', () => {
    const rows = parsePsRows(
      '  918  1.5  2.3 Sl 3600 firefox-bin /usr/lib/firefox/firefox\n' +
        '    1  0.0  0.1 Ss  999999 systemd /sbin/init splash\n',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pid: 918, cpuPct: 1.5, memPct: 2.3, stat: 'Sl', elapsedSec: 3600, comm: 'firefox-bin' });
    expect(rows[0].args).toContain('/usr/lib/firefox/firefox');
    expect(rows[1].comm).toBe('systemd');
  });

  it('skips unparseable lines instead of fabricating rows', () => {
    const rows = parsePsRows('not a process\n   ?  x y\n  42 0.5 0.2 Zs 10 zombie \n');
    expect(rows).toHaveLength(1);
    expect(rows[0].pid).toBe(42);
    expect(rows[0].stat).toBe('Zs'); // zombies are real and reported honestly
  });
});
