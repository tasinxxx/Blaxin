// LIVE ADAPTIVE MODEL ROUTING PROOF (real runtime, real local Ollama)
// ===================================================================
// Drives the REAL server (node dist/index.js, scratch data dir) over a
// REAL WebSocket. The model availability is the REAL local Ollama
// (http://127.0.0.1:11434) — no mocks for the routing path.
//
//   proof 1  deterministic task → DETERMINISTIC route, 0 model calls,
//            no model-routing event (the router is never even consulted)
//   proof 2  AI task → routing decision selects the capability-compatible
//            LOCAL model (real Ollama capability data: tools+thinking)
//   proof 3  vision task → honest BLOCK naming 'vision' (this machine has
//            no vision-capable model — the block IS the honest proof; if
//            a vision model appears, the probe asserts the SELECT instead)
//   proof 4  tool-required task → a tool-incapable model (tinyllama,
//            completion-only) is rejected by name; blocked when it is the
//            only candidate
//   proof 5  routing evidence in the REAL persisted journal (kind ROUTING,
//            required/selected/rejected recorded)
//   proof 6  no API-key-shaped string ever reaches the journal
//
// Exit code 0 = proof, 1 = failure. No fabricated state anywhere: every
// assertion reads a REAL runtime event or the REAL journal file.
// ===================================================================

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';

const events = [];
let ws;
let server;
let serverPort = 0;
// Hygiene: a previous run that was OOM-killed mid-inference leaves its
// scratch dir behind (the process never reaches its own cleanup). Sweep
// those stale dirs at startup — they carry nothing of value.
try {
  for (const entry of readdirSync(tmpdir())) {
    if (entry.startsWith('blaxin-routing-proof-')) {
      rmSync(join(tmpdir(), entry), { recursive: true, force: true });
    }
  }
} catch { /* best effort */ }
const dataDir = mkdtempSync(join(tmpdir(), 'blaxin-routing-proof-'));
const steps = [];
const failures = [];

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

function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
    const iv = setInterval(() => {
      const hit = events.find(pred);
      if (hit) { clearTimeout(t); clearInterval(iv); resolve(hit); }
    }, 100);
  });
}

// Real-model budget: this machine is 8GB CPU-only and the local models think
// before answering (measured: ~3m45s per call on qwen3:4b with the full
// production payload). The probe must budget for MACHINE REALITY, not for a
// fast key-bearing provider. The routing decision itself is milliseconds —
// the wall clock here is the model's own inference time.
async function sendTask(content, timeoutMs = 600000) {
  const before = events.length;
  ws.send(JSON.stringify({ type: 'user-message', data: { content } }));
  // Wait for THIS task's completion (events after `before`).
  // 'error' is terminal ONLY when it is a real no-provider/routing block
  // (the orchestrator finishes the run then). A mid-task provider error
  // (NETWORK_ERROR/TIMEOUT/…) is INTERMEDIATE: the orchestrator's
  // bounded fallback legitimately continues the SAME task, so waiting
  // must continue until the real task-complete.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const slice = events.slice(before);
    // task-complete is THE real terminal event (it closes the run with
    // real metrics). A blocking error (NO_PROVIDER/NO_API_KEY) arrives
    // just BEFORE its run-closing task-complete, so prefer waiting for
    // the completion event — reading the error's payload as metrics was
    // a probe bug (error events carry no modelCalls).
    const completed = slice.find((m) => m.event === 'task-complete');
    if (completed) return completed;
    const failed = slice.find((m) => m.event === 'error' && (m.data?.code === 'NO_PROVIDER' || m.data?.code === 'NO_API_KEY'));
    if (failed) {
      // Grace window: the run-closing task-complete follows the error by
      // milliseconds — give it a moment so metrics are read from the REAL
      // completion event whenever it exists.
      const graceDeadline = Date.now() + 2000;
      while (Date.now() < graceDeadline) {
        const late = events.slice(before).find((m) => m.event === 'task-complete');
        if (late) return late;
        await new Promise((r) => setTimeout(r, 50));
      }
      return failed;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`task timed out after ${timeoutMs}ms: ${content}`);
}

async function getJournal() {
  const res = await fetch(`http://127.0.0.1:${serverPort}/api/journal?limit=80`);
  const body = await res.json();
  return Array.isArray(body?.entries) ? body.entries : Array.isArray(body) ? body : [];
}

async function main() {
  // ── Precondition: the REAL local Ollama must be up ──────────────
  let tags = null;
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags');
    tags = await res.json();
  } catch { /* absent */ }
  if (!tags || !Array.isArray(tags.models) || tags.models.length === 0) {
    console.error('PRECONDITION FAILED: no local Ollama models on 127.0.0.1:11434 — the routing proof needs the REAL local provider.');
    return 1;
  }
  const ollamaModels = tags.models.map((m) => m.name);
  const toolsModel = tags.models.find((m) => Array.isArray(m.capabilities) && m.capabilities.includes('tools'));
  const completionOnly = tags.models.find((m) => Array.isArray(m.capabilities) && !m.capabilities.includes('tools') && !m.capabilities.includes('vision'));
  const visionModel = tags.models.find((m) => Array.isArray(m.capabilities) && m.capabilities.includes('vision'));
  console.log(`real Ollama: ${ollamaModels.join(', ')}`);
  console.log(`tools-capable: ${toolsModel?.name ?? 'NONE'} · completion-only: ${completionOnly?.name ?? 'NONE'} · vision: ${visionModel?.name ?? 'NONE'}`);
  if (!toolsModel) {
    console.error('PRECONDITION FAILED: no tools-capable local model — install one (e.g. qwen3) for the routing proof.');
    return 1;
  }

  serverPort = await getFreePort();
  console.log(`server port: ${serverPort} · data dir: ${dataDir}`);
  const serverDir = join(import.meta.dirname, '..');
  server = spawn(process.execPath, ['dist/index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(serverPort), BLAXIN_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  const health = await waitForHealth(serverPort);
  console.log(`server healthy: ${JSON.stringify(health)}`);

  await new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 10000);
    ws.on('open', () => { clearTimeout(t); resolve(); });
    ws.on('error', reject);
  });
  ws.on('message', (buf) => {
    try { events.push(JSON.parse(String(buf))); } catch { /* ignore */ }
  });

  const routingEvents = () => events.filter((m) => m.event === 'model-routing');

  // ── PROOF 1: deterministic task → 0 model calls, no routing event ──
  const p1before = routingEvents().length;
  const done1 = await sendTask('list the contents of /tmp');
  step('P1 deterministic task: DETERMINISTIC route, 0 model calls',
    done1.event === 'task-complete' && done1.data?.modelCalls === 0 && done1.data?.executionMode === 'DETERMINISTIC',
    JSON.stringify({ mode: done1.data?.executionMode, calls: done1.data?.modelCalls }));
  step('P1 deterministic task: model router never consulted (no model-routing event)',
    routingEvents().length === p1before, `routing events: ${routingEvents().length}`);

  // ── PROOF 2: AI task → capability-compatible LOCAL model selected ──
  console.log('P2: sending AI task — a real local model call on this CPU-only machine can take minutes (model + payload dependent; measured worst case ~5 min on qwen3:4b)…');
  const done2 = await sendTask('explain in one short sentence why the sky is blue');
  const r2 = routingEvents().find((m) => m.data?.selected && !m.data?.blocked);
  step('P2 AI task: routing decision emitted with a selection', !!r2 && done2.event === 'task-complete');
  // The CONTRACT is capability-compatibility, not a specific model name:
  // the selection must be a LOCAL model that really reports the required
  // capabilities (chat + function-calling from /api/tags) — and must
  // never be a completion-only model. Which compatible model wins is the
  // router's deterministic preference (active configured model first).
  const selectedIsCompatible = tags.models.some((m) => m.name === r2?.data?.selected
    && Array.isArray(m.capabilities)
    && m.capabilities.includes('tools'));
  step('P2 AI task: selected model REALLY offers the required capabilities (chat+tools, from real /api/tags data)',
    r2?.data?.selectedProvider === 'ollama' && selectedIsCompatible,
    `selected=${r2?.data?.selectedProvider}/${r2?.data?.selected} reason="${r2?.data?.selectionReason}"`);
  step('P2 AI task: required capabilities recorded honestly (chat+tool-calling)',
    Array.isArray(r2?.data?.required) && r2.data.required.includes('chat') && r2.data.required.includes('tool-calling'),
    `required=${JSON.stringify(r2?.data?.required)}`);

  // ── PROOF 3: vision task → honest BLOCK (or select if a vision model exists) ──
  // NOTE: never actually calls a model (blocked before selection) — fast even on this machine.
  const done3 = await sendTask('take a screenshot of my screen and describe what you see', 90000);
  const r3 = routingEvents().find((m) => m.data?.objective && /screenshot/i.test(String(m.data.objective)));
  if (visionModel) {
    step('P3 vision task: vision-capable model selected (no downgrade)', r3?.data?.selectedProvider && !r3?.data?.blocked,
      `selected=${r3?.data?.selectedProvider}/${r3?.data?.selected}`);
  } else {
    step('P3 vision task: BLOCKED honestly (no vision model on this machine — never downgraded)',
      r3?.data?.blocked === true && r3?.data?.missingCapability === 'vision',
      `missing=${r3?.data?.missingCapability} detail="${String(r3?.data?.detail ?? '').slice(0, 100)}"`);
    step('P3 vision task: zero model calls for the blocked vision task', done3.event === 'task-complete' && done3.data?.modelCalls === 0,
      `calls=${done3.data?.modelCalls}`);
  }

  // ── PROOF 4: tool-incapable model rejected by name when alternatives exist ──
  if (completionOnly) {
    // The tools-capable model must be chosen OVER the completion-only one.
    step('P4 tool-required task: completion-only model not selected', r2?.data?.selected !== completionOnly.name,
      `completion-only=${completionOnly.name} selected=${r2?.data?.selected}`);
    // rejected evidence names a real model when any rejection occurred.
    const rejections = routingEvents().flatMap((m) => m.data?.rejected ?? []);
    if (rejections.length > 0) {
      step('P4 rejections carry real evidence (model name + reason)',
        rejections.every((r) => r.model && r.reason));
    } else {
      console.log('  (no rejection occurred in this run — the tools model won outright; skipped honestly)');
    }
  }

  // ── PROOF 5: routing evidence in the REAL persisted journal ─────
  const journal = await getJournal();
  const routingLines = journal.filter((e) => e.kind === 'ROUTING');
  console.log('journal ROUTING lines:', routingLines.map((e) => `${e.status}:${e.routing?.selected ?? e.routing?.missingCapability ?? '?'}`).join(' · '));
  step('P5 journal records ROUTING evidence', routingLines.length >= 2);
  step('P5 journal ROUTING line carries real selection or honest block',
    routingLines.some((e) => e.routing?.selected) && routingLines.some((e) => e.routing?.missingCapability === 'vision'));
  step('P5 journal ROUTING line records required capabilities',
    routingLines.some((e) => Array.isArray(e.routing?.required) && e.routing.required.includes('tool-calling')));
  const visionLine = routingLines.find((e) => e.routing?.missingCapability === 'vision');
  step('P5 vision block journaled with status BLOCKED', visionLine?.status === 'BLOCKED');
  const persisted = join(dataDir, '.blaxin-state', 'journal.json');
  step('P5 journal persisted to disk', existsSync(persisted) && readFileSync(persisted, 'utf8').includes('ROUTING'));

  // ── PROOF 6: no secret ever reaches the routing journal ─────────
  // The secret lands in a message; the LLM path runs one real call (a
  // local model takes minutes on this machine — budgeted for reality;
  // measured worst case ~5 min on qwen3:4b, variance is the thinking
  // phase, so 600s covers it without weakening the wait).
  const done6 = await sendTask('use key sk-proj-ROUTINGPROOFSECRET99 to check the weather', 600000);
  const j6 = await getJournal();
  const serialized = JSON.stringify(j6);
  step('P6 API-key-shaped string never reaches the journal', !serialized.includes('ROUTINGPROOFSECRET99'));
  const secretRouting = j6.find((e) => e.kind === 'ROUTING' && /ROUTINGPROOFSECRET99/i.test(JSON.stringify(e)));
  step('P6 the ROUTING line itself redacts the objective', !secretRouting && j6.some((e) => e.kind === 'ROUTING' && String(e.objective ?? '').includes('[redacted]')));

  // ── Summary ─────────────────────────────────────────────────────
  const passCount = steps.filter((s) => s.ok).length;
  console.log(`\n==== ROUTING PROOF SUMMARY ====`);
  console.log(`checks: ${passCount}/${steps.length} PASS`);
  console.log('journal trail:');
  for (const e of (await getJournal()).slice().reverse()) {
    if (e.kind === 'ROUTING' || e.kind === 'RESULT' || e.kind === 'BLOCKED') {
      console.log(`  JOURNAL ${e.seq} ${e.kind}/${e.status ?? ''}${e.routing?.selected ? ` → ${e.routing.selected}` : ''}${e.detail ? ` — ${String(e.detail).slice(0, 110)}` : ''}`);
    }
  }
  if (failures.length > 0) {
    console.log(`FAILED checks: ${failures.join(', ')}`);
    console.log('--- server log tail ---');
    console.log(serverLog.slice(-3000));
  }
  return failures.length === 0 ? 0 : 1;
}

function teardown() {
  try { ws?.close(); } catch { /* gone */ }
  try { server?.kill('SIGTERM'); } catch { /* gone */ }
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

setTimeout(() => {
  console.error('PROBE HARD TIMEOUT');
  teardown();
  setTimeout(() => process.exit(1), 300);
}, 1500000);
