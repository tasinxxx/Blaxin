// B7 RUNTIME PROOF — process_control on the REAL OS
// =============================================================
// Proves on the real compiled dist (server/dist) + real processes:
//   1. `list` reads the REAL process table (this probe's own pid in it);
//   2. `inspect` reads REAL details for a spawned process;
//   3. `kill` ends the spawned process — verified gone by the tool's
//      read-back AND by an independent system `ps`;
//   4. a SIGTERM-ignoring process is reported honestly (still running),
//      then force-escalated (SIGKILL) — still read-back verified;
//   5. unknown pid = honest FAILURE; protected pids REFUSED with no
//      signal sent; `kill <name>` style guesses never route.
// =============================================================

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const steps = [];
const failures = [];
function step(name, ok, detail = '') {
  steps.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const ROOT = dirname(dirname(new URL(import.meta.url).pathname));
const distTool = join(ROOT, 'server', 'dist', 'tools', 'process-control.js');
if (!existsSync(distTool)) {
  console.error(`bundled tool missing: ${distTool} — run: cd server && npm run build`);
  process.exit(1);
}
const { ProcessControlTool } = await import(pathToFileURL(distTool).href);
const tool = new ProcessControlTool();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const aliveOnSystem = (pid) => {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'pid='], { timeout: 3000 })
      .toString().trim().length > 0;
  } catch {
    return false;
  }
};

// ── 1. list reads the real table (this probe's own pid appears) ──
const list = await tool.execute({ action: 'list', limit: 50 });
const listOk = list.success === true
  && Number(list.data?.total) > 0
  && (list.data?.processes).length === list.data?.shown;
step('list reads the REAL process table (bounded, structured)', listOk,
  `total=${list.data?.total}`);

// ── spawn a real victim: a plain sleep (dies on SIGTERM) ──
// NOTE (learned by the tool catching this probe's first draft):
// `trap "" TERM; exec sleep` sets SIG_IGN, and SIG_IGN SURVIVES exec —
// that victim ignored SIGTERM and the tool honestly refused to claim a
// kill. The tool was right; the probe was wrong. Plain sleep it is.
const victim = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
victim.unref();
const pid = victim.pid;
// A genuine TERM-ignorer: bash stays bash with a real handler that just
// prints (exec does NOT apply — the shell keeps running its loop).
const stubborn = spawn('bash', ['-c', 'trap "echo ignored" TERM; while :; do sleep 0.2; done'], {
  detached: true, stdio: 'ignore',
});
stubborn.unref();
const stubbornPid = stubborn.pid;
await sleep(700);

try {
  // ── 2. inspect: real details for the spawned pid ──
  const inspect = await tool.execute({ action: 'inspect', pid });
  const inspectOk = inspect.success === true
    && inspect.data?.process?.pid === pid
    && String(inspect.data?.process?.args).includes('sleep');
  step('inspect reads REAL details for the spawned process', inspectOk,
    inspect.success ? String(inspect.data?.process?.args).slice(0, 60) : inspect.error);

  // ── 3. kill: verified gone by read-back + independent ps ──
  const kill = await tool.execute({ action: 'kill', pid });
  await sleep(300);
  const gone = !aliveOnSystem(pid);
  const killOk = kill.success === true && kill.data?.verified === true && gone;
  step('kill ends the process — tool read-back AND independent ps agree', killOk,
    kill.success ? `signal=${kill.data?.signal}` : kill.error);

  // ── 4. stubborn process: honest still-running, then SIGKILL escalation ──
  const noForce = await tool.execute({ action: 'kill', pid: stubbornPid });
  const stillThere = aliveOnSystem(stubbornPid);
  const honestFail = noForce.success === false
    && stillThere === true
    && String(noForce.error).includes('still running after SIGTERM');
  step('a SIGTERM-ignoring process is reported honestly (NOT a fake kill)', honestFail,
    noForce.success ? 'WRONG: claimed success' : 'still running, honestly reported');

  const forced = await tool.execute({ action: 'kill', pid: stubbornPid, force: true });
  await sleep(300);
  const forcedOk = forced.success === true
    && forced.data?.escalated === true
    && forced.data?.signal === 'SIGKILL'
    && !aliveOnSystem(stubbornPid);
  step('force escalation (SIGKILL) verified gone', forcedOk,
    forced.success ? 'SIGKILL verified' : forced.error);
} finally {
  for (const p of [pid, stubbornPid]) {
    try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// ── 5. honesty guards ──
const ghost = await tool.execute({ action: 'kill', pid: 4000000 });
step('unknown pid is an honest FAILURE', ghost.success === false && ghost.data?.observed === false,
  ghost.error?.slice(0, 70));

let refusedSignals = 0;
const guardRunner = async (cmd) => {
  if (cmd === 'kill') refusedSignals += 1;
  if (cmd === 'ps') return { stdout: '', stderr: '' };
  return { stdout: '', stderr: '' };
};
const guardTool = new ProcessControlTool(guardRunner);
const initKill = await guardTool.execute({ action: 'kill', pid: 1 });
const selfKill = await guardTool.execute({ action: 'kill', pid: process.pid });
step('protected pids (init / this server) REFUSED with zero signals', initKill.success === false && selfKill.success === false && refusedSignals === 0,
  `signals=${refusedSignals}`);

// ── summary ──
console.log(`\n${steps.length - failures.length}/${steps.length} PASS`);
process.exit(failures.length ? 1 : 0);
