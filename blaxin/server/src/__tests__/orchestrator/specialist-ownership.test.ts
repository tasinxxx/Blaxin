// Specialist bounded-objective ownership (§6) — FOCUSED test suite.
// Covers the directive's 15 specialist-ownership areas:
//   1.  objective ownership (one objective per task, from a real activation)
//   2.  action budgets (hard limit, honest refusal)
//   3.  recovery limits (per-objective, escalation after exhaustion)
//   4.  replan limits (objective-bounded plan mutations)
//   5.  timeout handling (wall-clock deadline, honest TIMED_OUT)
//   6.  evidence requirements (tool invocation ≠ verification)
//   7.  structured results (terminal, honest status derivation)
//   8.  specialist assignment (real event, additive + backward compatible)
//   9.  result events (emitted exactly once, real evidence counts)
//   10. objectiveId propagation (bound to tool-execution events)
//   11. journal binding (DELEGATED + RESULT lines, objectiveId preserved)
//   12. honest verification (VERIFIED only from real SUCCESS evidence)
//   13. UNVERIFIED behavior (no inflation anywhere — Jarvis caps to PARTIAL)
//   14. blocked/cancelled honesty (denials and stops are real states)
//   15. client/state integration (snapshot carries the real specialist)

import { describe, it, expect } from 'vitest';
import { AgentOrchestrator } from '../../orchestrator/index.js';
import { buildFakes, FakeProvider } from '../helpers/orchestrator-fakes.js';
import type { ToolResult } from '../../types.js';
import { SpecialistLedger } from '../../orchestrator/specialist.js';
import { MissionJournal, JournalEntry } from '../../utils/mission-journal.js';
import { JarvisEngine, type JarvisDeps } from '../../jarvis/engine.js';

interface Ev { event: string; data: any }

class OwnershipStub {
  name: string;
  description: string;
  definition: any;
  executionMode: 'parallel' | 'serial' = 'serial';
  calls = 0;
  script: ToolResult[] = [];

  constructor(name: string) {
    this.name = name;
    this.description = `stub ${name}`;
    this.definition = {
      type: 'function' as const,
      function: { name, description: `stub ${name}`, parameters: { type: 'object' as const, properties: {}, required: [] } },
    };
  }

  requiresConfirmation() { return false; }

  async execute(_args?: Record<string, unknown>): Promise<ToolResult> {
    this.calls++;
    const next = this.script.shift() ?? { success: true, output: 'ok', data: {} };
    return next;
  }
}

const fail = (error: string): ToolResult => ({ success: false, output: '', error });

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

const toolEvents = (events: Ev[]) => events.filter((e) => e.event === 'tool-execution');
const assigned = (events: Ev[]) => events.filter((e) => e.event === 'specialist-assigned');
const results = (events: Ev[]) => events.filter((e) => e.event === 'specialist-result');

// ── 1. Objective ownership ──────────────────────────────────────

describe('1. objective ownership', () => {
  it('one objective per task from the first REAL tool activation — no specialist without tool work', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const tool = new OwnershipStub('own-tool');
    fakes.tools.register(tool);

    // A task with NO tool calls: no specialist objective may exist.
    provider.script.push({ content: 'Just an answer, no tools.' });
    await orch.processMessage('pure reasoning task, no tools');
    expect(assigned(events)).toHaveLength(0);
    expect(orch.getCurrentSpecialistObjective()).toBeNull();

    // A task WITH a tool call claims one objective.
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'own-tool', arguments: '{}' } }],
    });
    provider.script.push({ content: 'done' });
    await orch.processMessage('task that uses a tool');
    expect(assigned(events)).toHaveLength(1);
    // After settlement the CURRENT pointer is cleared by design (the
    // objective is no longer active) — ownership is proven by the settled
    // result, which carries the same objectiveId the assignment announced.
    expect(orch.getCurrentSpecialistObjective()).toBeNull();
    const settledResult = orch.getSpecialistResults(1)[0];
    expect(settledResult).toBeDefined();
    expect(settledResult.objectiveId).toBe(assigned(events)[0].data.objectiveId);
    expect(settledResult.objective).toBe('task that uses a tool');
  });

  it('ledger is idempotent per task: many actions never create a second objective or refresh budgets', async () => {
    const ledger = new SpecialistLedger();
    ledger.setConfig({ maxActions: 2 });
    const a = ledger.assign({ tool: 'browser', objective: 'own the work', taskId: 't1' });
    ledger.recordAction(a.id);
    const b = ledger.assign({ tool: 'terminal', objective: 'try to re-claim', taskId: 't1' });
    expect(b.id).toBe(a.id);            // SAME objective — no cycling
    expect(b.role).toBe(a.role);        // original activation keeps ownership
    expect(ledger.get(a.id)!.actionsUsed).toBe(1); // budget not refreshed
  });
});

// ── 2. Action budgets ───────────────────────────────────────────

describe('2. action budgets', () => {
  it('hard action limit: the budget-exhausted call is honestly REFUSED (skipped), never silently run', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator({ maxActions: 2 });
    const tool = new OwnershipStub('budget-tool');
    fakes.tools.register(tool);

    provider.script.push({
      content: '',
      toolCalls: [
        { id: 'c1', type: 'function', function: { name: 'budget-tool', arguments: '{"n":1}' } },
        { id: 'c2', type: 'function', function: { name: 'budget-tool', arguments: '{"n":2}' } },
        { id: 'c3', type: 'function', function: { name: 'budget-tool', arguments: '{"n":3}' } },
      ],
    });
    provider.script.push({ content: 'Budget was exhausted; stopping.' });

    await orch.processMessage('three actions against a budget of two');
    expect(tool.calls).toBe(2); // hard limit — third never ran

    const refused = toolEvents(events).find((e) => e.data.state === 'skipped' && String(e.data.result || '').includes('budget exhausted'));
    expect(refused).toBeDefined();
    expect(refused!.data.objectiveId).toBeTruthy();
    const resultEv = results(events)[0];
    expect(resultEv).toBeDefined();
    expect(resultEv.data.status).toBe('FAILED');
    expect(resultEv.data.summary).toContain('budget exhausted');
  });

  it('refused actions are attributable to the objective (objectiveId on the skipped event)', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator({ maxActions: 1 });
    const tool = new OwnershipStub('budget-tool-2');
    fakes.tools.register(tool);
    provider.script.push({
      content: '',
      toolCalls: [
        { id: 'c1', type: 'function', function: { name: 'budget-tool-2', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'budget-tool-2', arguments: '{}' } },
      ],
    });
    provider.script.push({ content: 'stopped' });
    await orch.processMessage('one action only');
    const refused = toolEvents(events).find((e) => e.data.state === 'skipped');
    expect(refused).toBeDefined();
    expect(refused!.data.objectiveId).toBe(assigned(events)[0].data.objectiveId);
  });
});

// ── 3. Recovery limits ──────────────────────────────────────────

describe('3. recovery limits', () => {
  it('objective recovery budget is hard: no ladder attempts beyond it, escalation reaches the Brain', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator({ maxRecoveries: 0 });
    const target = new OwnershipStub('rec-tool');
    target.script = [fail('No confident match for "login button" — run action=snapshot to see real elements (grounding refused to guess).')];
    fakes.tools.register(target);

    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'rec-tool', arguments: '{}' } }],
    });
    provider.script.push({ content: 'Recovery budget exhausted; escalating.' });

    await orch.processMessage('failed action with zero recovery budget');
    expect(target.calls).toBe(1); // NO deterministic recovery attempt
    const retryEvents = toolEvents(events).filter((e) => e.data.state === 'retrying' && e.data.failureClass);
    expect(retryEvents).toHaveLength(1); // classified + announced, but refused
    expect(retryEvents[0].data.recoveryDetail).toContain('budget exhausted');
    expect(provider.calls).toBe(2); // Brain decided AFTER exhaustion
  });

  it('recovery within budget still works (existing ladder preserved under the objective)', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator({ maxRecoveries: 8 });
    const target = new OwnershipStub('rec-tool-2');
    target.script = [
      fail('No confident match for "login button" — run action=snapshot to see real elements (grounding refused to guess).'),
      { success: true, output: 'clicked', data: {} },
    ];
    fakes.tools.register(target);
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'rec-tool-2', arguments: '{}' } }],
    });
    await orch.processMessage('one recovery is allowed');
    expect(target.calls).toBe(2);
    const states = toolEvents(events).map((e) => e.data.state);
    expect(states[states.length - 1]).toBe('completed');
  });
});

// ── 4. Replan limits ────────────────────────────────────────────

describe('4. replan limits', () => {
  it('objective replan budget is enforced: a zero-replan objective never mutates the plan', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator({ maxReplans: 0 });
    const target = new OwnershipStub('replan-tool');
    target.script = [fail('open_url NOT verified — could not read the page location')];
    fakes.tools.register(target);

    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'replan-tool', arguments: '{}' } }],
    });
    provider.script.push({ content: 'No deterministic re-plan; deciding.' });

    await orch.processMessage('failure with replan budget 0');
    const replanEvents = toolEvents(events).filter((e) => e.data.replanNumber);
    expect(replanEvents).toHaveLength(0);
    expect(provider.calls).toBe(2); // Brain escalated
  });
});

// ── 5. Timeout handling ─────────────────────────────────────────

describe('5. timeout handling', () => {
  it('wall-clock deadline aborts the loop and settles TIMED_OUT honestly', async () => {
    // The deadline is measured from the objective's real ASSIGNMENT (the
    // first tool activation) — so the test binds it mid-run: the first
    // action's 80ms execution consumes the 30ms budget, and the SECOND
    // loop turn is refused on the real wall clock.
    const { orch, events, fakes, provider } = makeOrchestrator({ deadlineMs: 30 });
    const tool = new OwnershipStub('slow-tool');
    tool.execute = async () => {
      await new Promise((r) => setTimeout(r, 80)); // real work past the deadline
      tool.calls++;
      return { success: true, output: 'slow but ok', data: {} };
    };
    fakes.tools.register(tool);

    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'slow-tool', arguments: '{}' } }],
    });
    // Second loop turn arrives after the deadline has really passed.
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c2', type: 'function', function: { name: 'slow-tool', arguments: '{}' } }],
    });
    provider.script.push({ content: 'deadline reached' });

    await orch.processMessage('task that should hit its deadline');
    const resultEv = results(events)[0];
    expect(resultEv).toBeDefined();
    expect(resultEv.data.status).toBe('TIMED_OUT');
    expect(resultEv.data.deadlineExceeded).toBe(true);
    expect(resultEv.data.summary).toContain('timed out');
  });
});

// ── 6. Evidence requirements ────────────────────────────────────

describe('6. evidence requirements', () => {
  it('tool invocation alone is NOT verification: success without evidence settles COMPLETED_UNVERIFIED', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const tool = new OwnershipStub('no-evidence-tool');
    fakes.tools.register(tool);
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'no-evidence-tool', arguments: '{}' } }],
    });
    await orch.processMessage('successful tool call, zero verification payload');
    expect(tool.calls).toBe(1);
    const resultEv = results(events)[0];
    expect(resultEv.data.status).toBe('COMPLETED_UNVERIFIED');
    expect(resultEv.data.verification).toBe('UNVERIFIED');
    expect(resultEv.data.completedCount).toBe(1);
    expect(resultEv.data.verifiedCount).toBe(0);
  });

  it('real SUCCESS verification evidence promotes the objective to COMPLETED_VERIFIED', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const tool = new OwnershipStub('verified-tool');
    tool.script = [{
      success: true,
      output: 'opened',
      data: { verification: { method: 'url-poll', status: 'SUCCESS', detail: 'landed on https://example.com/' } },
    }];
    fakes.tools.register(tool);
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'verified-tool', arguments: '{}' } }],
    });
    await orch.processMessage('tool call with real verification');
    const resultEv = results(events)[0];
    expect(resultEv.data.status).toBe('COMPLETED_VERIFIED');
    expect(resultEv.data.verification).toBe('VERIFIED');
    expect(resultEv.data.verifiedCount).toBe(1);
  });
});

// ── 7. Structured results ───────────────────────────────────────

describe('7. structured results', () => {
  it('the result event carries the full honest structure (counts, budgets, timing, summary)', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const tool = new OwnershipStub('structured-tool');
    tool.script = [{
      success: true, output: 'done',
      data: { verification: { method: 'read-back', status: 'SUCCESS', detail: 'content matched' } },
    }];
    fakes.tools.register(tool);
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'structured-tool', arguments: '{}' } }],
    });
    await orch.processMessage('structured result check');
    const data = results(events)[0].data;
    expect(data.objectiveId).toMatch(/^obj_/);
    expect(data.role).toBe('GENERAL');
    expect(data.objective).toBe('structured result check');
    expect(typeof data.taskId).toBe('string');
    expect(data.evidenceCount).toBe(1);
    expect(data.budgets).toEqual({
      maxActions: 16, maxRecoveries: 8, maxReplans: 1, deadlineMs: 300_000,
    });
    expect(data.actionsUsed).toBe(1);
    expect(typeof data.durationMs).toBe('number');
    expect(typeof data.startedAt).toBe('number');
    expect(typeof data.completedAt).toBe('number');
    expect(data.summary).toContain('verified evidence');
  });

  it('a failed action settles FAILED with the real failure count', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const tool = new OwnershipStub('failing-tool');
    tool.script = [fail('the file does not exist')];
    fakes.tools.register(tool);
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'failing-tool', arguments: '{}' } }],
    });
    provider.script.push({ content: 'It failed; stopping.' });
    await orch.processMessage('failing action');
    const data = results(events)[0].data;
    expect(data.status).toBe('FAILED');
    expect(data.verification).toBe('UNVERIFIED');
    expect(data.failedCount).toBe(1);
  });
});

// ── 8/9. Events: assignment + result emission exactly once ──────

describe('8/9. specialist-assigned + specialist-result events', () => {
  it('assignment event carries role/tool/budgets; result emitted EXACTLY once per task', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const tool = new OwnershipStub('event-tool');
    fakes.tools.register(tool);
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'event-tool', arguments: '{}' } }],
    });
    await orch.processMessage('event honesty check');
    const a = assigned(events)[0].data;
    expect(a.specialist).toBe('GENERAL');
    expect(a.tool).toBe('event-tool');
    expect(a.budgets.maxActions).toBe(16);
    expect(a.objective).toBe('event honesty check');
    expect(results(events)).toHaveLength(1); // exactly once
  });

  it('role derives from the REAL activating tool (browser → BROWSER)', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const tool = new OwnershipStub('browser');
    fakes.tools.register(tool);
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'browser', arguments: '{"action":"current_url"}' } }],
    });
    await orch.processMessage('browser role check');
    expect(assigned(events)[0].data.specialist).toBe('BROWSER');
    expect(results(events)[0].data.role).toBe('BROWSER');
  });
});

// ── 10. objectiveId propagation ─────────────────────────────────

describe('10. objectiveId propagation', () => {
  it('executing, retrying and settled tool-execution events carry the objectiveId', async () => {
    // A persistently failing action with a spent recovery budget produces
    // the full honest trail: executing → retrying (recovery announced,
    // refused on budget) → settled failed. Every event must stay bound
    // to the owning objective.
    const { orch, events, fakes, provider } = makeOrchestrator({ maxRecoveries: 0 });
    const tool = new OwnershipStub('prop-tool');
    tool.script = [fail('No confident match for "login button" — run action=snapshot to see real elements (grounding refused to guess).')];
    fakes.tools.register(tool);
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'prop-tool', arguments: '{}' } }],
    });
    provider.script.push({ content: 'failed once; stopping.' });
    await orch.processMessage('objectiveId propagation');

    const objId = assigned(events)[0].data.objectiveId;
    const executing = toolEvents(events).find((e) => e.data.state === 'executing');
    expect(executing!.data.objectiveId).toBe(objId);
    const retrying = toolEvents(events).filter((e) => e.data.state === 'retrying');
    expect(retrying.length).toBeGreaterThan(0);
    for (const r of retrying) expect(r.data.objectiveId).toBe(objId);
    const settled = toolEvents(events).filter((e) => e.data.state === 'failed');
    expect(settled.length).toBeGreaterThan(0);
    for (const s of settled) expect(s.data.objectiveId).toBe(objId);
  });
});

// ── 11. Journal binding ─────────────────────────────────────────

describe('11. journal binding', () => {
  it('DELEGATED line records the planned role + budgets; RESULT line records the honest verification', () => {
    const j = new MissionJournal({ filePath: '/dev/null' });
    j.ingest('specialist-assigned', {
      objectiveId: 'obj_test1',
      specialist: 'FILES',
      tool: 'filesystem',
      objective: 'list the contents of /tmp',
      taskId: 'task_9',
      budgets: { maxActions: 16, maxRecoveries: 8, maxReplans: 1, deadlineMs: 300000 },
      createdAt: Date.now(),
      expiresAt: Date.now() + 300000,
    });
    j.ingest('specialist-result', {
      objectiveId: 'obj_test1',
      role: 'FILES',
      objective: 'list the contents of /tmp',
      taskId: 'task_9',
      status: 'COMPLETED_UNVERIFIED',
      verification: 'UNVERIFIED',
      evidenceCount: 1,
      completedCount: 1,
      verifiedCount: 0,
      failedCount: 0,
      deniedCount: 0,
      durationMs: 12,
      summary: 'completed but UNVERIFIED — no real verification evidence (1 action(s))',
    });

    const entries: JournalEntry[] = j.list();
    const delegated = entries.find((e) => e.kind === 'DELEGATED')!;
    expect(delegated).toBeDefined();
    expect(delegated.specialist).toBe('FILES');          // planned role
    expect(delegated.objectiveId).toBe('obj_test1');
    expect(delegated.detail).toContain('16 action(s)');

    const resultLine = entries.find((e) => e.kind === 'RESULT' && e.objectiveId === 'obj_test1')!;
    expect(resultLine).toBeDefined();
    expect(resultLine.specialist).toBe('FILES');          // observed/result role
    expect(resultLine.status).toBe('UNVERIFIED');
    expect(resultLine.detail).toContain('UNVERIFIED');
  });

  it('objectiveId on a tool-execution event binds ACTION + OBSERVATION + VERIFICATION lines to the objective', () => {
    const j = new MissionJournal({ filePath: '/dev/null' });
    j.ingest('tool-execution', {
      toolName: 'filesystem', args: {}, state: 'executing', stepId: 's1', objectiveId: 'obj_bind1',
    });
    j.ingest('tool-execution', {
      toolName: 'filesystem', args: {}, state: 'completed', stepId: 's1', objectiveId: 'obj_bind1',
      result: 'file1, file2',
      verification: { method: 'list', status: 'SUCCESS', detail: '2 entries' },
    });
    const entries: JournalEntry[] = j.list();
    const action = entries.find((e) => e.kind === 'ACTION')!;
    const observation = entries.find((e) => e.kind === 'OBSERVATION')!;
    const verification = entries.find((e) => e.kind === 'VERIFICATION')!;
    expect(action.objectiveId).toBe('obj_bind1');
    expect(observation.objectiveId).toBe('obj_bind1');
    expect(verification.objectiveId).toBe('obj_bind1');
    // The existing specialist derivation from the ACTUAL tool is preserved.
    expect(action.specialist).toBe('FILES');
  });

  it('binding survives across events: an earlier objectiveId is remembered for later lines of the same step', () => {
    const j = new MissionJournal({ filePath: '/dev/null' });
    j.ingest('tool-execution', { toolName: 'browser', args: {}, state: 'executing', stepId: 's2', objectiveId: 'obj_bind2' });
    // Later line does NOT repeat the objectiveId — the binding must persist.
    j.ingest('tool-execution', { toolName: 'browser', args: {}, state: 'completed', stepId: 's2', result: 'https://example.com/' });
    const action = j.list().find((e) => e.kind === 'ACTION')!;
    expect(action.objectiveId).toBe('obj_bind2');
  });
});

// ── 12/13. Honest verification + UNVERIFIED capping in Jarvis ───

describe('12/13. honest verification + Jarvis UNVERIFIED capping', () => {
  function makeEngine(): { engine: JarvisEngine; emit: (event: string, data: any) => void; snapshots: any[] } {
    let listener: ((event: string, data: any) => void) | null = null;
    const snapshots: any[] = [];
    const deps: JarvisDeps = {
      events: { on(cb: (event: string, data: any) => void) { listener = cb; } },
      executeGoal: () => ({ taskId: 't_sp' }),
    };
    const engine = new JarvisEngine(deps);
    engine.onChange((snap) => snapshots.push(snap));
    const emit = (event: string, data: any) => listener?.(event, data);
    return { engine, emit, snapshots };
  }

  it('an UNVERIFIED specialist objective caps the Jarvis report at PARTIAL — never SUCCESS', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'do the thing', source: 'text' });
    emit('specialist-assigned', {
      objectiveId: 'obj_cap1', specialist: 'FILES', tool: 'filesystem', objective: 'do the thing', taskId: 't_sp',
      budgets: { maxActions: 16, maxRecoveries: 8, maxReplans: 1, deadlineMs: 300000 },
    });
    emit('agent-state', { state: 'completed', description: 'Done' });
    // REAL runtime order (probe-verified): the objective settles BEFORE
    // task-complete composes the report — the in-compose cap sees it.
    emit('specialist-result', {
      objectiveId: 'obj_cap1', role: 'FILES', objective: 'do the thing', taskId: 't_sp',
      status: 'COMPLETED_UNVERIFIED', verification: 'UNVERIFIED',
      completedCount: 1, verifiedCount: 0, failedCount: 0, deniedCount: 0,
      deadlineExceeded: false, durationMs: 10, summary: 'unverified',
    });
    emit('task-complete', { taskId: 't_sp', kind: 'llm', totalMs: 10, modelCalls: 1, toolCalls: 1, outcome: 'completed' });

    const snap = engine.snapshot();
    expect(snap.lastReport).not.toBeNull();
    expect(snap.lastReport!.status).toBe('PARTIAL'); // honest cap
    expect(snap.lastReport!.specialist!.verification).toBe('UNVERIFIED');
    expect(snap.lastReport!.specialist!.status).toBe('COMPLETED_UNVERIFIED');
  });

  it('a VERIFIED specialist result keeps a clean SUCCESS — verification is evidence-based, not punitive', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'verified work', source: 'text' });
    emit('specialist-assigned', {
      objectiveId: 'obj_cap2', specialist: 'BROWSER', tool: 'browser', objective: 'verified work', taskId: 't_sp',
      budgets: { maxActions: 16, maxRecoveries: 8, maxReplans: 1, deadlineMs: 300000 },
    });
    emit('agent-state', { state: 'completed', description: 'Done' });
    // REAL runtime order: result settles BEFORE task-complete composes.
    emit('specialist-result', {
      objectiveId: 'obj_cap2', role: 'BROWSER', objective: 'verified work', taskId: 't_sp',
      status: 'COMPLETED_VERIFIED', verification: 'VERIFIED',
      completedCount: 1, verifiedCount: 1, failedCount: 0, deniedCount: 0,
      deadlineExceeded: false, durationMs: 10, summary: 'verified',
    });
    emit('task-complete', { taskId: 't_sp', kind: 'llm', totalMs: 10, modelCalls: 1, toolCalls: 1, outcome: 'completed' });
    const snap = engine.snapshot();
    expect(snap.lastReport!.status).toBe('SUCCESS');
    expect(snap.lastReport!.specialist!.verification).toBe('VERIFIED');
  });

  it('the live snapshot carries the specialist block ONLY when a real event arrived (no decorative specialist)', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'no specialist here', source: 'text' });
    emit('agent-state', { state: 'thinking', description: 'Thinking' });
    expect(engine.snapshot().specialist).toBeUndefined();

    emit('specialist-assigned', {
      objectiveId: 'obj_snap1', specialist: 'TERMINAL', tool: 'terminal', objective: 'no specialist here',
      budgets: { maxActions: 16, maxRecoveries: 8, maxReplans: 1, deadlineMs: 300000 },
    });
    expect(engine.snapshot().specialist!.specialist).toBe('TERMINAL');
    expect(engine.snapshot().specialist!.status).toBe('ASSIGNED');
  });
});

// ── 14. Blocked / cancelled honesty ─────────────────────────────

describe('14. blocked/cancelled honesty', () => {
  it('denied actions record BLOCKED evidence; stop settles CANCELLED', () => {
    const ledger = new SpecialistLedger();
    const o = ledger.assign({ tool: 'browser', objective: 'open a page', taskId: 't_deny' });
    ledger.recordAction(o.id); // the action started (gate was pending)
    ledger.recordDenied(o.id, 'step_1', 'browser');
    const blocked = ledger.settle(o.id)!;
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.deniedCount).toBe(1);

    const o2 = ledger.assign({ tool: 'terminal', objective: 'long work', taskId: 't_cancel' });
    ledger.recordAction(o2.id);
    const cancelled = ledger.settle(o2.id, { stopped: true })!;
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('settle is idempotent: the first terminal result wins, later settles never change it', () => {
    const ledger = new SpecialistLedger();
    const o = ledger.assign({ tool: 'filesystem', objective: 'work', taskId: 't_once' });
    ledger.recordAction(o.id);
    const first = ledger.settle(o.id)!;
    const second = ledger.settle(o.id)!;
    expect(second).toBe(first);
    expect(ledger.settleTask('t_once')!.status).toBe(first.status);
  });
});

// ── 15. Client/state integration ────────────────────────────────

describe('15. client/state integration', () => {
  it('specialist snapshot fields mirror the real objective (budgets, usage, status) for the HUD', async () => {
    const { orch, fakes, provider } = makeOrchestrator({ maxActions: 3 });
    const tool = new OwnershipStub('snap-tool');
    fakes.tools.register(tool);
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'snap-tool', arguments: '{}' } }],
    });
    provider.script.push({ content: 'still working' });
    // A task must actually RUN for an objective to exist (no tool work →
    // no specialist — the ownership contract, not a fixture detail).
    await orch.processMessage('snapshot fields check');
    // After settlement the current pointer is cleared; the settled result
    // is the HUD-facing state (getSpecialistResults / getSpecialistSnapshot).
    const history = orch.getSpecialistResults(5);
    expect(history.length).toBe(1);
    expect(history[0].budgets.maxActions).toBe(3);
    expect(history[0].objective).toBe('snapshot fields check');
    expect(typeof history[0].actionsUsed).toBe('number');
    expect(history[0].actionsUsed).toBe(1);
    expect(history[0].status).toBe('COMPLETED_UNVERIFIED');
    expect(typeof history[0].durationMs).toBe('number');
    // The generic snapshot accessor mirrors the same real result.
    const snap = orch.getSpecialistSnapshot();
    expect(snap && 'objectiveId' in snap ? snap.objectiveId : null).toBe(history[0].objectiveId);
  });
});
