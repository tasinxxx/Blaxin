// LIVE VERIFIED BROWSER SPECIALIST PROOF (real runtime, no mocks)
// =============================================================
// Drives the REAL server (node dist/index.js, scratch data dir) over a
// REAL WebSocket, with a deterministic LOOPBACK verification target:
//
//   user task: "open http://127.0.0.1:<port>/specialist-target"
//     → deterministic fast path classifies open_url
//     → Policy gate → this probe APPROVES (scope=task) like the UI would
//     → real Chrome launches + navigates
//     → verifyUrl polls the REAL page location (title read back from the page)
//     → tool result carries verification SUCCESS
//     → specialist ledger settles COMPLETED_VERIFIED
//     → specialist-result event: verification VERIFIED
//     → task-complete: DETERMINISTIC, SUCCESS evidence
//     → /api/journal shows DELEGATED → ACTION → OBSERVATION → VERIFICATION → RESULT
//
// Honesty: the probe asserts the VERIFIED level came from a matching
// title OBSERVED in the browser evidence (url-match payload), never
// from the intended action alone. Exit code 0 = proof, 1 = failure.
// =============================================================

import http from 'node:http';
import { createServer as mkHttp } from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import WebSocket from 'ws';


const PAGE_TITLE = 'BLAXIN Specialist Verification Target';
const MARKER = `blx-proof-${crypto.randomUUID()}`;

const events = [];
let ws;
let loopback;
let server;
let loopbackPort = 0;
let serverPort = 0;
const dataDir = mkdtempSync(join(tmpdir(), 'blaxin-browser-proof-'));
let steps = [];
let failures = [];
let serverLog = '';

function step(name, ok, detail) {
  steps.push({ name, ok, detail: detail ?? '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

function startLoopback() {
  return new Promise((resolve) => {
    loopback = mkHttp((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/specialist-target') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>${PAGE_TITLE}</title></head><body><h1 id="proof">${MARKER}</h1></body></html>`);
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    loopback.listen(0, '127.0.0.1', () => {
      loopbackPort = loopback.address().port;
      resolve();
    });
  });
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become healthy');
}

async function getJournal() {
  const res = await fetch(`http://127.0.0.1:${serverPort}/api/journal?limit=60`);
  const body = await res.json();
  return Array.isArray(body?.entries) ? body.entries : Array.isArray(body) ? body : [];
}

function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    const check = () => {
      const hit = events.find(pred);
      if (hit) {
        clearTimeout(t);
        resolve(hit);
      }
    };
    check();
    const iv = setInterval(check, 100);
    // keep interval alive until resolve/reject
    const clear = () => clearInterval(iv);
    Promise.resolve().then(() => { /* noop */ });
    // attach cleanup via wrapping resolve/reject
    const origResolve = resolve;
    resolve = (v) => { clear(); origResolve(v); };
    const origReject = reject;
    reject = (e) => { clear(); origReject(e); };
  });
}

async function main() {
  await startLoopback();
  serverPort = await getFreePort();
  console.log(`loopback target: http://127.0.0.1:${loopbackPort}/specialist-target`);
  console.log(`server port:     ${serverPort}`);
  console.log(`data dir:        ${dataDir}`);

  const serverDir = join(import.meta.dirname, '..');
  server = spawn(process.execPath, ['dist/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      // index.ts binds the HTTP port from the plain PORT env var.
      PORT: String(serverPort),
      BLAXIN_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.on('error', (e) => console.error(`[server spawn error] ${e.message}`));
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  server.on('exit', (code) => {
    console.log(`[server exited code=${code}]`);
    if (code !== null) console.log(`--- server log (tail) ---\n${serverLog.slice(-2500)}`);
  });

  const health = await waitForHealth(serverPort);
  console.log(`server healthy: ${JSON.stringify(health)}`);

  // Real WS client — no Origin header (a non-browser client; allowed by policy).
  await new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 10000);
    ws.on('open', () => { clearTimeout(t); resolve(); });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
  ws.on('message', (buf) => {
    try {
      const msg = JSON.parse(String(buf));
      events.push(msg);
    } catch { /* non-JSON frames ignored */ }
  });

  const TARGET_URL = `http://127.0.0.1:${loopbackPort}/specialist-target`;
  // A pure deterministic fast-path request (" and " would defer to the LLM).
  // The VERIFICATION is the browser tool's REAL load-settle: verifyUrl polls
  // the actual page location and returns the OBSERVED url+title as evidence.
  const TASK = `open ${TARGET_URL}`;

  // The Policy gate is part of the real path: approve like the UI would.
  const gateTimer = setInterval(() => {
    const gate = events.find((m) => m.event === 'confirmation-required');
    if (gate) {
      clearInterval(gateTimer);
      console.log(`gate: approving step ${gate.data?.runtimeStepId ?? gate.data?.stepId} (${gate.data?.description})`);
      ws.send(JSON.stringify({
        type: 'confirmation-response',
        data: { stepId: gate.data?.stepId, approved: true, scope: 'task' },
      }));
    }
  }, 50);

  ws.send(JSON.stringify({ type: 'user-message', data: { content: TASK } }));
  console.log(`task sent: "${TASK}"`);

  const complete = await waitFor((m) => m.event === 'task-complete', 90000, 'task-complete');
  clearInterval(gateTimer);
  console.log(`task-complete: ${JSON.stringify(complete.data)}`);

  const assignedEv = events.find((m) => m.event === 'specialist-assigned');
  const resultEv = events.find((m) => m.event === 'specialist-result');
  const toolEvents = events.filter((m) => m.event === 'tool-execution');
  const completedTool = toolEvents.find((m) => m.data?.state === 'completed');

  console.log('specialist-assigned:', JSON.stringify(assignedEv?.data ?? null));
  console.log('specialist-result:', JSON.stringify(resultEv?.data ?? null));
  console.log('completed tool-execution:', JSON.stringify(completedTool?.data ?? null));

  // ── Evidence chain assertions ─────────────────────────────────
  step('JARVIS → specialist-assigned (BROWSER objective)', !!assignedEv && assignedEv.data?.specialist === 'BROWSER' && !!assignedEv.data?.objectiveId);
  step('objective is bounded (budgets carried)', !!assignedEv?.data?.budgets?.maxActions > 0 && assignedEv.data?.budgets?.deadlineMs > 0);

  const objId = assignedEv?.data?.objectiveId;
  const completedAll = toolEvents.filter((m) => ['executing', 'completed'].includes(m.data?.state));
  step('objectiveId propagates through real browser tool-execution events', completedAll.length > 0 && completedAll.every((m) => m.data?.objectiveId === objId));

  const v = completedTool?.data?.verification;
  step('real browser observation captured (URL actually observed)', v?.status === 'SUCCESS' && typeof v?.evidence?.url === 'string' && v.evidence.url.startsWith(`http://127.0.0.1:${loopbackPort}/specialist-target`));
  step('verification is evidence-based (title read from the REAL page)', v?.method === 'url-match' && typeof v?.evidence?.title === 'string' && v.evidence.title === PAGE_TITLE, `title="${v?.evidence?.title}"`);

  step('specialist-result: COMPLETED_VERIFIED', resultEv?.data?.status === 'COMPLETED_VERIFIED', `status=${resultEv?.data?.status}`);
  step('specialist-result: verification VERIFIED (same objectiveId)', resultEv?.data?.verification === 'VERIFIED' && resultEv?.data?.objectiveId === objId);
  step('specialist-result: real evidence counts', resultEv?.data?.verifiedCount >= 1 && resultEv?.data?.completedCount >= 1);

  step('task-complete: DETERMINISTIC route, zero model calls', complete.data?.kind === 'direct' && complete.data?.modelCalls === 0 && complete.data?.executionMode === 'DETERMINISTIC', JSON.stringify({ kind: complete.data?.kind, modelCalls: complete.data?.modelCalls, executionMode: complete.data?.executionMode }));

  // Journal: real persisted audit trail.
  const journal = await getJournal();
  const jKinds = (kind) => journal.filter((e) => e.kind === kind);
  console.log('journal kinds:', journal.map((e) => `${e.kind}/${e.status ?? ''}`).join(' → '));
  step('journal records the DELEGATION', jKinds('DELEGATED').some((e) => e.objectiveId === objId));
  step('journal records the ACTION + OBSERVATION', jKinds('ACTION').length >= 1 && jKinds('OBSERVATION').length >= 1);
  step('journal records real VERIFICATION evidence', jKinds('VERIFICATION').some((e) => {
    const v = e.verification;
    const s = (typeof v === 'object' && v) ? String(v.status ?? '') : String(v ?? '');
    const d = String(e.detail ?? '');
    return s.toUpperCase().includes('SUCCESS') || d.toUpperCase().includes('SUCCESS');
  }));
  step('journal records the specialist RESULT VERIFIED', jKinds('RESULT').some((e) => e.objectiveId === objId && e.status === 'COMPLETED' && /verification VERIFIED/i.test(e.detail ?? '')));

  // Persistence proof: the journal file exists in the scratch data dir.
  const journalFile = join(dataDir, '.blaxin-state', 'journal.json');
  step('journal persisted to disk (evidence survives the process)', fs.existsSync(journalFile) && fs.statSync(journalFile).size > 0);

  console.log('\n==== PROOF SUMMARY ====');
  console.log(`objectiveId: ${objId}`);
  console.log(`observed url: ${v?.evidence?.url}`);
  console.log(`observed title: "${v?.evidence?.title}" (expected "${PAGE_TITLE}")`);
  console.log(`specialist: ${resultEv?.data?.status} / verification ${resultEv?.data?.verification}`);
  console.log(`journal lines: ${journal.length}`);
  for (const e of journal.slice().reverse()) {
    console.log(`  JOURNAL ${e.seq} ${e.kind}/${e.status ?? ''}${e.objectiveId ? ` obj=${e.objectiveId}` : ''}${e.detail ? ` — ${String(e.detail).slice(0, 140)}` : ''}`);
  }
  const passCount = steps.filter((s) => s.ok).length;
  console.log(`checks: ${passCount}/${steps.length} PASS`);
  if (failures.length > 0) {
    console.log(`FAILED checks: ${failures.join(', ')}`);
    console.log('--- server log tail ---');
    console.log(serverLog.slice(-3000));
  }
  return failures.length === 0 ? 0 : 1;
}

// ── teardown (bounded; keeps alive sockets from hanging the probe) ──
function teardown() {
  try { ws?.close(); } catch { /* already gone */ }
  try { server?.kill('SIGTERM'); } catch { /* already gone */ }
  try { loopback?.closeAllConnections?.(); loopback?.close(); } catch { /* already gone */ }
}

main()
  .then((code) => {
    teardown();
    setTimeout(() => process.exit(code), 300);
  })
  .catch((e) => {
    console.error('PROBE ERROR:', e?.message ?? e);
    teardown();
    setTimeout(() => process.exit(1), 300);
  });

// Safety: hard cap the whole probe at 3 minutes.
setTimeout(() => {
  console.error('PROBE HARD TIMEOUT');
  teardown();
  setTimeout(() => process.exit(1), 300);
}, 180_000);
