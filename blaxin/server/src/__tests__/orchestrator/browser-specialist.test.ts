// LIVE VERIFIED BROWSER SPECIALIST — focused deterministic suite (§6/§27/§28)
// =============================================================
// The runtime counterpart of this suite is the REAL runtime proof
// (server/scripts/probe-browser-specialist.mjs): real server, real WS,
// real Chrome via CDP, verification VERIFIED from real observed state.
//
// This suite pins the PRODUCTION CONTRACT deterministically (no real
// browser needed): a BROWSER specialist objective is assigned from the
// real tool activation, objectiveId travels on every event, the
// settlement derives VERIFIED ONLY from the tool's real verification
// payload (never from the intended action), and every negative case
// stays honest (FAILURE/UNKNOWN/no-payload → never VERIFIED).
// =============================================================

import { describe, it, expect } from 'vitest';
import { AgentOrchestrator } from '../../orchestrator/index.js';
import { buildFakes, FakeProvider } from '../helpers/orchestrator-fakes.js';
import type { ToolResult } from '../../types.js';
import { MissionJournal, JournalEntry } from '../../utils/mission-journal.js';
import { JarvisEngine, type JarvisDeps } from '../../jarvis/engine.js';

interface Ev { event: string; data: any }

/** A browser-shaped stub whose script replays REAL BrowserTool result shapes. */
class BrowserStub {
  name = 'browser';
  description = 'stub browser';
  definition: any;
  executionMode: 'parallel' | 'serial' = 'serial';
  calls = 0;
  latencyMs = 0;
  script: ToolResult[] = [];

  constructor() {
    this.definition = {
      type: 'function' as const,
      function: {
        name: 'browser',
        description: 'stub browser',
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
    };
  }

  // The confirmation-gate matrix is pinned by risk-permission + recovery
  // suites; this suite focuses on specialist ownership + verification
  // honesty, so the stub is gate-free to keep every case deterministic.
  requiresConfirmation() { return false; }

  async execute(_args?: Record<string, unknown>): Promise<ToolResult> {
    this.calls++;
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const next = this.script.shift();
    // An exhausted script is an HONEST failure — a fake success here would
    // let the deterministic recovery ladder "complete" an unplanned action.
    if (!next) return { success: false, output: '', error: 'browser stub: no scripted result' };
    return next;
  }
}

const verifiedOpen = (url: string, title: string): ToolResult => ({
  success: true,
  output: `Opened URL: ${url} — OBSERVED at ${url}, title: "${title}" (URL verified).`,
  data: {
    verification: {
      status: 'SUCCESS', method: 'url-match',
      evidence: { url, title, errorPage: false }, confidence: 0.95,
      detail: `URL verified: ${url} ("${title}")`,
    },
  },
});

const failedOpen = (detail: string, status: 'FAILURE' | 'UNKNOWN' = 'FAILURE'): ToolResult => ({
  success: false,
  output: '',
  error: `open_url NOT verified — ${detail}`,
  data: {
    verification: {
      status, method: 'url-match',
      evidence: status === 'FAILURE' ? { url: 'http://other.example/', title: 'Other', errorPage: false } : null,
      confidence: status === 'FAILURE' ? 0.9 : 0,
      detail,
    },
  },
});

const unverifiedOpen = (): ToolResult => ({
  // A completed action WITHOUT a verification payload — the honest
  // "tool ran but nothing was verified" case.
  success: true,
  output: 'Opened URL: http://127.0.0.1:1/ (no verification evidence available).',
  data: {},
});

function makeOrchestrator(specialistOverrides: Partial<{ maxActions: number; maxRecoveries: number; maxReplans: number; deadlineMs: number }> = {}) {
  const fakes = buildFakes();
  const events: Ev[] = [];
  const orch = new AgentOrchestrator({
    providers: fakes.providers,
    toolRegistry: fakes.tools,
    sessionState: fakes.session,
    memoryStore: fakes.memory,
    getConfig: () => fakes.config,
  });
  orch.setMemoryRuntime(null);
  orch.setEventCallback((event, data) => events.push({ event, data }));
  orch.setSpecialistConfig({ maxActions: 16, maxRecoveries: 8, maxReplans: 1, deadlineMs: 300_000, ...specialistOverrides });
  const provider = fakes.providers.getProvider() as FakeProvider;
  return { fakes, orch, events, provider };
}

/** An orchestrator whose events feed a real MissionJournal (production wiring). */
function makeJournalOrchestrator(journal: MissionJournal) {
  const fakes = buildFakes();
  const events: Ev[] = [];
  const orch = new AgentOrchestrator({
    providers: fakes.providers,
    toolRegistry: fakes.tools,
    sessionState: fakes.session,
    memoryStore: fakes.memory,
    getConfig: () => fakes.config,
  });
  orch.setMemoryRuntime(null);
  orch.setEventCallback((event, data) => {
    events.push({ event, data });
    journal.ingest(event, data);
  });
  const provider = fakes.providers.getProvider() as FakeProvider;
  return { fakes, orch, events, provider };
}

const assigned = (events: Ev[]) => events.filter((e) => e.event === 'specialist-assigned');
const results = (events: Ev[]) => events.filter((e) => e.event === 'specialist-result');
const toolEvents = (events: Ev[]) => events.filter((e) => e.event === 'tool-execution');

/** Drive a real browser task through the orchestrator (one tool turn). */
async function runBrowserTask(
  orch: AgentOrchestrator,
  provider: FakeProvider,
  fakes: ReturnType<typeof buildFakes>,
  browser: BrowserStub,
  task: string,
) {
  fakes.tools.register(browser);
  provider.script.push({
    content: '',
    toolCalls: [{ id: 'c1', type: 'function', function: { name: 'browser', arguments: JSON.stringify({ action: 'open_url', url: 'http://127.0.0.1:9/x' }) } }],
  });
  provider.script.push({ content: 'done' });
  await orch.processMessage(task);
}

// ── 1. Assignment + objectiveId propagation ─────────────────────

describe('browser specialist assignment + objectiveId propagation', () => {
  it('the first REAL browser activation assigns a bounded BROWSER objective and announces it once', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const browser = new BrowserStub();
    browser.script.push(verifiedOpen('http://127.0.0.1:9/x', 'Example'));

    await runBrowserTask(orch, provider, fakes, browser, 'open http://127.0.0.1:9/x');

    const a = assigned(events);
    expect(a).toHaveLength(1);
    expect(a[0].data.specialist).toBe('BROWSER');
    expect(a[0].data.tool).toBe('browser');
    expect(a[0].data.objectiveId).toMatch(/^obj_/);
    expect(a[0].data.budgets.maxActions).toBeGreaterThan(0);
    expect(a[0].data.budgets.deadlineMs).toBeGreaterThan(0);
  });

  it('objectiveId travels on EVERY tool-execution event of the specialist action', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const browser = new BrowserStub();
    browser.script.push(verifiedOpen('http://127.0.0.1:9/x', 'Example'));

    await runBrowserTask(orch, provider, fakes, browser, 'open http://127.0.0.1:9/x');

    const objId = assigned(events)[0].data.objectiveId;
    const own = toolEvents(events).filter((e) => e.data?.state === 'executing' || e.data?.state === 'completed');
    expect(own.length).toBeGreaterThanOrEqual(2);
    for (const e of own) expect(e.data.objectiveId).toBe(objId);
  });

  it('no browser objective exists for a task with no tool work', async () => {
    const { orch, events, provider } = makeOrchestrator();
    provider.script.push({ content: 'just words' });
    await orch.processMessage('reasoning only, no browser');
    expect(assigned(events)).toHaveLength(0);
    expect(results(events)).toHaveLength(0);
  });
});

// ── 2. Verification honesty (the core contract) ─────────────────

describe('browser verification honesty — VERIFIED only from real observed state', () => {
  it('real SUCCESS verification evidence (observed url+title) settles COMPLETED_VERIFIED / VERIFIED', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const browser = new BrowserStub();
    // The payload mirrors the REAL BrowserTool open_url shape: evidence
    // carries the OBSERVED location read back from the page.
    browser.script.push(verifiedOpen('http://127.0.0.1:9/x', 'Example Domain'));

    await runBrowserTask(orch, provider, fakes, browser, 'specialist browser objective one');

    const r = results(events);
    expect(r).toHaveLength(1);
    expect(r[0].data.status).toBe('COMPLETED_VERIFIED');
    expect(r[0].data.verification).toBe('VERIFIED');
    expect(r[0].data.verifiedCount).toBe(1);
    expect(r[0].data.completedCount).toBe(1);
    // The evidence chain: the completed tool-execution carried the payload.
    const completed = toolEvents(events).find((e) => e.data?.state === 'completed');
    expect(completed!.data.verification.status).toBe('SUCCESS');
    expect(completed!.data.verification.evidence.title).toBe('Example Domain');
  });

  it('FAILURE verification evidence (observed wrong page) NEVER settles VERIFIED', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const browser = new BrowserStub();
    browser.script.push(failedOpen('URL is http://other.example/ — does not match the expectation'));

    await runBrowserTask(orch, provider, fakes, browser, 'specialist browser objective two');

    const r = results(events)[0].data;
    expect(r.status).toBe('FAILED');           // the action really failed
    expect(r.verification).toBe('UNVERIFIED'); // and it is NOT verified
    expect(r.verifiedCount).toBe(0);
  });

  it('UNKNOWN verification evidence (page unobservable) NEVER settles VERIFIED', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const browser = new BrowserStub();
    browser.script.push(failedOpen('Could not read the page location (evaluation failed)', 'UNKNOWN'));

    await runBrowserTask(orch, provider, fakes, browser, 'specialist browser objective three');

    const r = results(events)[0].data;
    expect(r.status).toBe('FAILED');
    expect(r.verification).toBe('UNVERIFIED');
  });

  it('a completed browser action WITHOUT a verification payload stays COMPLETED_UNVERIFIED — no inflation', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const browser = new BrowserStub();
    browser.script.push(unverifiedOpen());

    await runBrowserTask(orch, provider, fakes, browser, 'specialist browser objective four');

    const r = results(events)[0].data;
    expect(r.status).toBe('COMPLETED_UNVERIFIED');
    expect(r.verification).toBe('UNVERIFIED');
    expect(r.completedCount).toBe(1);
    expect(r.verifiedCount).toBe(0);
  });

  it('settlement is idempotent: the first result wins and is emitted exactly once', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const browser = new BrowserStub();
    browser.script.push(verifiedOpen('http://127.0.0.1:9/x', 'Example'));

    await runBrowserTask(orch, provider, fakes, browser, 'specialist browser objective five');

    expect(results(events)).toHaveLength(1);
    // A second settle attempt for the same task returns the SAME result
    // (already terminal — the ledger returns the stored result, and the
    // orchestrator emits nothing new).
    const taskId = results(events)[0].data.taskId;
    const again = (orch as any).emitSpecialistResult(taskId, {});
    expect(again).toBeNull();
    expect(results(events)).toHaveLength(1);
  });
});

// ── 3. Budgets / deadline honesty ────────────────────────────────

describe('browser specialist budgets + deadline', () => {
  it('action-budget exhaustion refuses further browser actions honestly (no fake completion)', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator({ maxActions: 1 });
    const browser = new BrowserStub();
    browser.script.push(verifiedOpen('http://127.0.0.1:9/x', 'Example'));
    browser.script.push(verifiedOpen('http://127.0.0.1:9/y', 'Example 2'));

    fakes.tools.register(browser);
    // Two browser turns: the second must be refused by the budget gate.
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'browser', arguments: '{"action":"open_url","url":"http://127.0.0.1:9/x"}' } }],
    });
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c2', type: 'function', function: { name: 'browser', arguments: '{"action":"open_url","url":"http://127.0.0.1:9/y"}' } }],
    });
    provider.script.push({ content: 'done' });
    await orch.processMessage('specialist browser objective six');

    const skipped = toolEvents(events).filter((e) => e.data?.state === 'skipped');
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(String(skipped[0].data.result ?? '')).toMatch(/budget|objective/i);
    // Documented contract: budget exhaustion never erases genuine VERIFIED
    // work (verification stays evidence-based, not punitive). The refusal
    // itself is the honest evidence — carried on the objective.
    const r = results(events)[0].data;
    expect(r.actionsUsed).toBeGreaterThanOrEqual(1);
    expect(r.verification).toBe(results(events)[0].data.verifiedCount > 0 ? 'VERIFIED' : 'UNVERIFIED');
  });

  it('a mid-run deadline stops the loop and settles TIMED_OUT — never a plain completion', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator({ deadlineMs: 30 });
    const slow = new BrowserStub();
    // The ACTION is slower than the deadline: the loop's NEXT step hits
    // the wall-clock boundary deterministically (60ms > 30ms).
    slow.latencyMs = 60;
    slow.script.push({
      success: true, output: 'opened',
      data: { verification: { status: 'SUCCESS', method: 'url-match', evidence: { url: 'http://x/', title: 'x', errorPage: false }, confidence: 0.95, detail: 'ok' } },
    });

    fakes.tools.register(slow);
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'browser', arguments: '{"action":"open_url","url":"http://127.0.0.1:9/x"}' } }],
    });
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c2', type: 'function', function: { name: 'browser', arguments: '{"action":"open_url","url":"http://127.0.0.1:9/y"}' } }],
    });
    await orch.processMessage('specialist browser objective seven');

    const r = results(events)[0]?.data;
    expect(r).toBeDefined();
    expect(r.status).toBe('TIMED_OUT');
    expect(r.deadlineExceeded).toBe(true);
  });
});

// ── 4. Jarvis consumes the VERIFIED result ───────────────────────

describe('Jarvis report consumes the real browser specialist result', () => {
  function makeEngine() {
    const listeners: Array<(event: string, data: any) => void> = [];
    const events = { on: (cb: (e: string, d: any) => void) => { listeners.push(cb); } };
    const engine = new JarvisEngine({
      events,
      executeGoal: () => ({ taskId: 't_b1' }),
      hasConversationHistory: () => false,
    } as JarvisDeps);
    const emit = (event: string, data: any) => listeners.forEach((l) => l(event, data));
    return { engine, emit };
  }

  it('VERIFIED browser result keeps a clean SUCCESS report with the real objectiveId', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'open the verification page', source: 'text' });

    emit('specialist-assigned', {
      objectiveId: 'obj_browser1', specialist: 'BROWSER', tool: 'browser',
      objective: 'open the verification page', taskId: 't_b1',
      budgets: { maxActions: 16, maxRecoveries: 8, maxReplans: 1, deadlineMs: 300000 },
    });
    emit('specialist-result', {
      objectiveId: 'obj_browser1', role: 'BROWSER', objective: 'open the verification page', taskId: 't_b1',
      status: 'COMPLETED_VERIFIED', verification: 'VERIFIED',
      completedCount: 1, verifiedCount: 1, failedCount: 0, deniedCount: 0,
      deadlineExceeded: false, durationMs: 1712, summary: 'completed with verified evidence (1/1 action(s)); verification VERIFIED',
    });
    emit('agent-state', { state: 'completed' });
    emit('task-complete', { taskId: 't_b1', kind: 'direct', totalMs: 1712, modelCalls: 0, toolCalls: 1, outcome: 'completed' });

    const report = engine.snapshot().lastReport!;
    expect(report.status).toBe('SUCCESS');
    expect(report.specialist!.objectiveId).toBe('obj_browser1');
    expect(report.specialist!.verification).toBe('VERIFIED');
    expect(report.specialist!.status).toBe('COMPLETED_VERIFIED');
  });

  it('an UNVERIFIED browser result caps the report at PARTIAL — UNVERIFIED never becomes SUCCESS', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'open the page', source: 'text' });

    emit('specialist-assigned', {
      objectiveId: 'obj_browser2', specialist: 'BROWSER', tool: 'browser',
      objective: 'open the page', taskId: 't_b2',
      budgets: { maxActions: 16, maxRecoveries: 8, maxReplans: 1, deadlineMs: 300000 },
    });
    emit('specialist-result', {
      objectiveId: 'obj_browser2', role: 'BROWSER', objective: 'open the page', taskId: 't_b2',
      status: 'COMPLETED_UNVERIFIED', verification: 'UNVERIFIED',
      completedCount: 1, verifiedCount: 0, failedCount: 0, deniedCount: 0,
      deadlineExceeded: false, durationMs: 900, summary: 'completed but UNVERIFIED — no real verification evidence (1 action(s))',
    });
    emit('agent-state', { state: 'completed' });
    emit('task-complete', { taskId: 't_b2', kind: 'direct', totalMs: 900, modelCalls: 0, toolCalls: 1, outcome: 'completed' });

    const report = engine.snapshot().lastReport!;
    expect(report.status).toBe('PARTIAL');
    expect(report.specialist!.verification).toBe('UNVERIFIED');
  });
});

// ── 5. Mission Journal evidence ──────────────────────────────────

describe('mission journal records the real browser specialist trail', () => {
  it('DELEGATED → ACTION → OBSERVATION → VERIFICATION → RESULT with the objectiveId preserved', async () => {
    const journal = new MissionJournal({
      filePath: `/tmp/blaxin-test-browser-journal-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    });
    const mirror: JournalEntry[] = [];
    journal.onChange((all) => mirror.splice(0, mirror.length, ...all));

    const { orch, events, fakes, provider } = makeJournalOrchestrator(journal);
    const browser = new BrowserStub();
    browser.script.push(verifiedOpen('http://127.0.0.1:9/x', 'Example Domain'));
    await runBrowserTask(orch, provider, fakes, browser, 'open http://127.0.0.1:9/x');

    const entries = journal.list();
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain('DELEGATED');
    expect(kinds).toContain('ACTION');
    expect(kinds).toContain('OBSERVATION');
    expect(kinds).toContain('VERIFICATION');
    expect(kinds).toContain('RESULT');

    const objId = assigned(events)[0].data.objectiveId;
    const delegated = entries.find((e) => e.kind === 'DELEGATED');
    expect(delegated!.objectiveId).toBe(objId);
    expect(delegated!.specialist).toBe('BROWSER');

    const verification = entries.find((e) => e.kind === 'VERIFICATION');
    expect(JSON.stringify(verification)).toContain('url-match');

    const resultLine = entries.filter((e) => e.kind === 'RESULT' && e.objectiveId === objId)[0];
    expect(resultLine).toBeDefined();
    expect(resultLine!.status).toBe('COMPLETED');
    expect(resultLine!.detail).toMatch(/verification VERIFIED/);
    void mirror;
    journal.clear();
  });

  it('an UNVERIFIED browser result journal line stays UNVERIFIED — no upgrade', async () => {
    const journal = new MissionJournal({
      filePath: `/tmp/blaxin-test-browser-journal2-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    });

    const { orch, events, fakes, provider } = makeJournalOrchestrator(journal);
    const browser = new BrowserStub();
    browser.script.push(unverifiedOpen());
    await runBrowserTask(orch, provider, fakes, browser, 'specialist browser journal two');

    const objId = assigned(events)[0].data.objectiveId;
    const entries = journal.list();
    const resultLine = entries.filter((e) => e.kind === 'RESULT' && e.objectiveId === objId)[0];
    expect(resultLine).toBeDefined();
    expect(resultLine!.status).toBe('UNVERIFIED');
    expect(resultLine!.detail).toMatch(/verification UNVERIFIED/);
    journal.clear();
  });
});
