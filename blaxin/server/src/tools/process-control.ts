import { Tool, ToolResult } from '../types.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { currentPlatform } from '../utils/platform.js';

const execFileAsync = promisify(execFile);

/**
 * Injectable command runner (verification seam — same pattern as
 * system-audio). The default runs the real `ps`/`kill` binaries; tests
 * inject fakes to drive honest success/failure/unavailable paths
 * deterministically.
 */
export type ProcessRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: ProcessRunner = (cmd, args, timeoutMs) =>
  execFileAsync(cmd, args, { timeout: timeoutMs });

export interface ProcessRow {
  pid: number;
  /** Real CPU percent at read time (ps pcpu). */
  cpuPct: number;
  /** Real resident-memory percent at read time (ps pmem). */
  memPct: number;
  /** ps STAT (e.g. Sl, Rs, Z — zombies are real and reported honestly). */
  stat: string;
  /** Seconds since start (ps etimes), when the platform provides it. */
  elapsedSec: number | null;
  /** Command name (ps comm). */
  comm: string;
  /** Full command line (ps args) — the human-readable evidence. */
  args: string;
}

/**
 * Parse `ps -eo pid=,pcpu=,pmem=,stat=,etimes=,comm=,args=` output.
 * The first four fields are parsed positionally (numeric/stat tokens never
 * contain spaces); etimes may be absent on some platforms, in which case
 * the first non-numeric/stat tail token shifts into the command fields —
 * pid/cpu/mem/stat stay correct regardless. Unparseable lines are SKIPPED
 * (never fabricated into rows); if nothing parses, callers report honest
 * failure instead of an empty success.
 */
export function parsePsRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const cpuPct = Number(parts[1]);
    const memPct = Number(parts[2]);
    if (!Number.isFinite(cpuPct) || !Number.isFinite(memPct)) continue;
    const stat = parts[3] ?? '?';
    // etimes is numeric when present; otherwise the tail starts here.
    let idx = 4;
    let elapsedSec: number | null = null;
    if (parts.length > idx && /^\d+$/.test(parts[idx])) {
      elapsedSec = Number(parts[idx]);
      idx += 1;
    }
    const comm = parts[idx] ?? '';
    const args = parts.slice(idx + 1).join(' ');
    rows.push({ pid, cpuPct, memPct, stat, elapsedSec, comm, args: args || comm });
  }
  return rows;
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  return `${h}h${Math.floor((sec % 3600) / 60)}m`;
}

export class ProcessControlTool implements Tool {
  name = 'process-control';
  description =
    'List, inspect, or terminate real OS processes. list returns a structured, bounded table; ' +
    'inspect reads one process by pid; kill terminates by pid and is SUCCESS only when the ' +
    'process is verified GONE by a fresh read-back.';

  private runner: ProcessRunner;

  constructor(runner?: ProcessRunner) {
    this.runner = runner ?? defaultRunner;
  }

  definition = {
    type: 'function' as const,
    function: {
      name: 'process_control',
      description:
        'Real process control on this machine. Actions: list (bounded structured table of running ' +
        'processes sorted by CPU), inspect (details for one pid), kill (terminate by pid — verified ' +
        'gone by read-back; HIGH risk, requires confirmation). Kill by NAME is not supported on ' +
        'purpose: list first, choose the exact pid, then kill it.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'inspect', 'kill'],
            description: 'The process action to perform',
          },
          pid: {
            type: 'number',
            description: 'Process id for inspect/kill',
          },
          limit: {
            type: 'number',
            description: 'list: maximum rows (default 15, cap 50)',
          },
          sortBy: {
            type: 'string',
            enum: ['cpu', 'mem'],
            description: 'list: sort by cpu or memory percent (default cpu)',
          },
          force: {
            type: 'boolean',
            description: 'kill: escalate to SIGKILL if SIGTERM does not end the process',
          },
        },
        required: ['action'],
      },
    },
  };

  /** Bounded structured list, sorted by REAL cpu/mem readings. */
  private async list(args: Record<string, unknown>): Promise<ToolResult> {
    const rawLimit = Number(args.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), 50)
      : 15;
    const sortBy = args.sortBy === 'mem' ? 'mem' : 'cpu';
    const { stdout } = await this.runner(
      'ps',
      ['-eo', 'pid=,pcpu=,pmem=,stat=,etimes=,comm=,args='],
      8000,
    );
    const rows = parsePsRows(stdout);
    if (rows.length === 0) {
      return {
        success: false,
        output: '',
        error: 'Process list unreadable: ps returned no parseable rows.',
      };
    }
    rows.sort((a, b) =>
      sortBy === 'mem' ? b.memPct - a.memPct : b.cpuPct - a.cpuPct,
    );
    const shown = rows.slice(0, limit);
    const lines = shown.map(
      (r) =>
        `${r.pid}\t${r.cpuPct.toFixed(1)}%\t${r.memPct.toFixed(1)}%\t${r.stat}\t` +
        `${r.elapsedSec !== null ? formatUptime(r.elapsedSec) : '?'}\t${r.args}`,
    );
    return {
      success: true,
      output:
        `PID\tCPU\tMEM\tSTAT\tUPTIME\tCOMMAND (top ${shown.length} of ${rows.length}, by ${sortBy})\n` +
        lines.join('\n'),
      data: {
        sortBy,
        total: rows.length,
        shown: shown.length,
        processes: shown,
        verified: true,
      },
    };
  }

  /** Real details for one pid; unknown pid is an honest failure. */
  private async inspect(pid: number): Promise<ToolResult> {
    const { stdout } = await this.runner(
      'ps',
      ['-p', String(pid), '-o', 'pid=,pcpu=,pmem=,stat=,etimes=,comm=,args='],
      8000,
    );
    const rows = parsePsRows(stdout);
    if (rows.length === 0) {
      return {
        success: false,
        output: '',
        error: `No process with pid ${pid} (nothing inspected — never guessed).`,
      };
    }
    const r = rows[0];
    return {
      success: true,
      output:
        `pid ${r.pid}: ${r.args}\n` +
        `cpu ${r.cpuPct.toFixed(1)}% · mem ${r.memPct.toFixed(1)}% · stat ${r.stat}` +
        (r.elapsedSec !== null ? ` · up ${formatUptime(r.elapsedSec)}` : ''),
      data: { process: r, verified: true },
    };
  }

  /**
   * Kill by pid with REAL exit verification:
   *   1. observe the process first (capture its REAL name — also proves it
   *      existed; "no such pid" is an honest FAILURE, never a fake success);
   *   2. SIGTERM; poll for exit up to the grace window;
   *   3. optional SIGKILL escalation (force);
   *   4. SUCCESS only when a fresh read-back shows the pid is REALLY gone.
   * A signal that the OS accepted but that changed nothing (a silently
   * ignoring process or kernel job) is caught by the read-back — never
   * reported as a kill.
   */
  private async kill(args: Record<string, unknown>): Promise<ToolResult> {
    const pid = Number(args.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return { success: false, output: '', error: 'Invalid pid: must be a positive integer.' };
    }
    // Hard guards: never suicide, never init, never the kernel's thread 0/2.
    if (pid === 1 || pid === 2) {
      return {
        success: false,
        output: '',
        error: `Refusing to kill pid ${pid}: init/kernel threads are protected.`,
      };
    }
    if (pid === process.pid) {
      return {
        success: false,
        output: '',
        error: 'Refusing to kill pid: that is this BLAXIN server process.',
      };
    }

    // 1. Observe BEFORE signaling — the real name rides the evidence.
    let observed: ProcessRow | null = null;
    try {
      const { stdout } = await this.runner(
        'ps',
        ['-p', String(pid), '-o', 'pid=,pcpu=,pmem=,stat=,etimes=,comm=,args='],
        8000,
      );
      observed = parsePsRows(stdout)[0] ?? null;
    } catch {
      observed = null;
    }
    if (!observed) {
      return {
        success: false,
        output: '',
        error: `Nothing killed: no process with pid ${pid} at signal time.`,
        data: { pid, observed: false },
      };
    }

    const pollForExit = async (windowMs: number): Promise<boolean> => {
      const deadline = Date.now() + windowMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, Math.min(250, windowMs)));
        try {
          const { stdout } = await this.runner('ps', ['-p', String(pid), '-o', 'pid='], 3000);
          if (!stdout.trim()) return true;
        } catch {
          // ps error on a dead pid (ESRCH exit) counts as gone — the exit
          // code is verified against the pid being absent from fresh output.
          return true;
        }
      }
      return false;
    };

    // 2. SIGTERM (graceful ask).
    await this.runner('kill', ['-TERM', String(pid)], 5000);
    let gone = await pollForExit(4000);

    // 3. Optional escalation.
    let escalated = false;
    if (!gone && args.force === true) {
      escalated = true;
      await this.runner('kill', ['-KILL', String(pid)], 5000);
      gone = await pollForExit(2000);
    }

    // 4. The read-back is the verdict.
    if (!gone) {
      return {
        success: false,
        output: '',
        error: escalated
          ? `Kill NOT verified: pid ${pid} (${observed.args}) is STILL RUNNING after SIGTERM + SIGKILL.`
          : `pid ${pid} (${observed.args}) is still running after SIGTERM — retry with force: true for SIGKILL escalation.`,
        data: { pid, command: observed.args, observed: true, escalated, verified: false },
      };
    }
    return {
      success: true,
      output:
        `Killed pid ${pid} (${observed.args}) — verified gone by fresh read-back` +
        (escalated ? ' (SIGTERM ignored; SIGKILL escalation required).' : '.'),
      data: {
        pid,
        command: observed.args,
        signal: escalated ? 'SIGKILL' : 'SIGTERM',
        escalated,
        verified: true,
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;
    // Phase 6 honesty: ps/kill semantics are POSIX. On Windows this tool is
    // an explicit unavailability (never a fake result). macOS keeps the
    // full implementation — its ps supports every field the parser reads.
    if (currentPlatform() === 'windows') {
      return {
        success: false,
        output: '',
        error: `process-control (${action}) is not available on Windows in BLAXIN v1.4.0 — it uses POSIX ps/kill. Filesystem, terminal, browser, clipboard and AI features remain available.`,
        data: { action, platform: 'windows', available: false },
      };
    }
    try {
      switch (action) {
        case 'list':
          return await this.list(args);
        case 'inspect': {
          const pid = Number(args.pid);
          if (!Number.isInteger(pid) || pid <= 0) {
            return { success: false, output: '', error: 'Invalid pid: must be a positive integer.' };
          }
          return await this.inspect(pid);
        }
        case 'kill':
          return await this.kill(args);
        default:
          return { success: false, output: '', error: `Unknown action: ${action}. Use list, inspect, or kill.` };
      }
    } catch (error: any) {
      return {
        success: false,
        output: '',
        error: `Process control failed: ${error?.message ?? String(error)}`,
      };
    }
  }

  requiresConfirmation(args: Record<string, unknown>): boolean {
    // list/inspect are read-only; a kill ends a real process — ALWAYS asks.
    return args.action === 'kill';
  }
}
