// Deterministic auto-recovery / re-planning (§29/§30) — ORCHESTRATOR level.
// Proves the ladder really runs inside one run, budgeted, event-visible,
// with zero EXTRA model calls, and that escalation happens exactly when
// the deterministic layers are exhausted.

import { describe, it, expect } from 'vitest';
import { AgentOrchestrator } from '../../orchestrator/index.js';
import { buildFakes, FakeProvider } from '../helpers/orchestrator-fakes.js';
import type { ToolResult } from '../../types.js';

interface Ev { event: string; data: any }

class RecoveryStub {
  name: string;
  description: string;
  definition: any;
  executionMode: 'parallel' | 'serial' = 'serial';
  calls = 0;
  script: ToolResult[] = [];
  onStop: (() => void) | null = null;

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
    this.onStop?.();
    const next = this.script.shift() ?? { success: true, output: 'ok', data: {} };
    return next;
  }
}

const GROUNDING_FAIL =
  'No confident match for "login button" — run action=snapshot to see real elements (grounding refused to guess).';
const fail = (error: string): ToolResult => ({ success: false, output: '', error });

function makeOrchestrator(recoveryOverrides: Partial<{ maxRecoveryAttempts: number; maxReplansPerTask: number; baseBackoffMs: number }> = {}) {
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
  orch.setRecoveryConfig({ baseBackoffMs: 1, ...recoveryOverrides });
  const provider = fakes.providers.getProvider() as FakeProvider;
  return { fakes, orch, events, provider };
}

const toolEvents = (events: Ev[]) => events.filter((e) => e.event === 'tool-execution');

describe('deterministic recovery ladder (per action)', () => {
  it('recovers a TARGET_NOT_FOUND through an alternate path and succeeds — zero EXTRA model calls', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const target = new RecoveryStub('target-tool');
    // Attempt 1: browser-style grounding failure. Attempt 2 (after the
    // corrective observation): success.
    target.script = [fail(GROUNDING_FAIL), { success: true, output: 'clicked', data: {} }];
    fakes.tools.register(target);

    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'target-tool', arguments: '{"x":1}' } }],
    });

    await orch.processMessage('trigger a recovery ladder run');
    // Baseline agent loop = tool turn + final reply turn; the recovery
    // ladder itself added ZERO model calls on top of that baseline.
    expect(provider.calls).toBe(2);

    const states = toolEvents(events).map((e) => e.data.state);
    expect(states).toContain('retrying');
    expect(states[states.length - 1]).toBe('completed');

    const retryEv = toolEvents(events).find((e) => e.data.state === 'retrying')!;
    expect(retryEv.data.failureClass).toBe('TARGET_NOT_FOUND');
    expect(retryEv.data.recoveryStrategy).toBe('alternate-path');
    expect(retryEv.data.recoveryAttempt).toBe(1);
    expect(retryEv.data.recoveryBudget).toBe(3); // maxRecoveryAttempts 2 + first action

    expect(target.calls).toBe(2); // original + one deterministic recovery attempt
  });

  it('budget is hard: after the last deterministic attempt it stops (no infinite loop) and the LLM decides', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const target = new RecoveryStub('target-tool');
    target.script = [fail(GROUNDING_FAIL), fail(GROUNDING_FAIL), fail(GROUNDING_FAIL)];
    fakes.tools.register(target);

    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'target-tool', arguments: '{}' } }],
    });
    provider.script.push({ content: 'The target genuinely does not exist; stopping.' });

    await orch.processMessage('trigger deterministic exhaustion');
    expect(target.calls).toBe(3); // 1 original + maxRecoveryAttempts(2) — hard stop
    expect(provider.calls).toBe(2); // Brain escalated AFTER exhaustion

    // The step settles honestly FAILED (never faked).
    const progress = events.filter((e) => e.event === 'task-progress');
    const lastSteps = progress[progress.length - 1]?.data.steps ?? [];
    expect(lastSteps[0]?.state).toBe('failed');

    // One real recovery event per real deterministic attempt (2).
    const retryEvents = toolEvents(events).filter((e) => e.data.state === 'retrying' && e.data.failureClass);
    expect(retryEvents.length).toBe(2);
    expect(retryEvents[0].data.recoveryAttempt).toBe(1);
    expect(retryEvents[1].data.recoveryAttempt).toBe(2);
  });

  it('re-observes on OBSERVATION_UNAVAILABLE (reobserve-then-retry)', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const obs = new RecoveryStub('obs-tool');
    obs.script = [
      fail('open_url NOT verified — could not read the page location'),
      { success: true, output: 'observed', data: {} },
    ];
    fakes.tools.register(obs);

    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'obs-tool', arguments: '{}' } }],
    });

    await orch.processMessage('trigger observability recovery');
    const retryEv = toolEvents(events).find((e) => e.data.state === 'retrying')!;
    expect(retryEv.data.failureClass).toBe('OBSERVATION_UNAVAILABLE');
    expect(retryEv.data.recoveryStrategy).toBe('reobserve-then-retry');
    expect(obs.calls).toBe(2);
  });

  it('TRANSIENT_TIMEOUT recovers through the bounded backoff strategy', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const t = new RecoveryStub('transient-tool');
    t.script = [fail('Tool "transient-tool" timed out after 30s'), { success: true, output: 'later', data: {} }];
    fakes.tools.register(t);

    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'transient-tool', arguments: '{}' } }],
    });

    await orch.processMessage('trigger transient recovery');
    const retryEv = toolEvents(events).find((e) => e.data.state === 'retrying')!;
    expect(retryEv.data.failureClass).toBe('TRANSIENT_TIMEOUT');
    expect(retryEv.data.recoveryStrategy).toBe('bounded-retry-backoff');
    expect(t.calls).toBe(2);
  });

  it('UNCLASSIFIED failures do NOT recover deterministically — straight to honest failure + Brain', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const u = new RecoveryStub('weird-tool');
    u.script = [fail('Command failed with exit code 1: no match')];
    fakes.tools.register(u);

    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'weird-tool', arguments: '{}' } }],
    });
    provider.script.push({ content: 'Handled the deterministic exit-code failure.' });

    await orch.processMessage('trigger unclassified failure');
    expect(u.calls).toBe(1); // no deterministic retries at all
    const retryEvents = toolEvents(events).filter((e) => e.data.state === 'retrying' && e.data.failureClass);
    expect(retryEvents.length).toBe(0);
  });

  it('a recovered run settles the step honestly COMPLETED exactly once (no synthetic success events)', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const target = new RecoveryStub('target-tool');
    target.script = [fail(GROUNDING_FAIL), { success: true, output: 'clicked', data: {} }];
    fakes.tools.register(target);

    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'target-tool', arguments: '{}' } }],
    });

    await orch.processMessage('recovery then honest completion');
    const completions = toolEvents(events).filter((e) => e.data.state === 'completed' && e.data.stepId === 'c1');
    expect(completions.length).toBe(1); // settleResult only
  });

  it('user STOP during the failure interrupts the recovery ladder (no ladder run after stop)', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    const target = new RecoveryStub('target-tool');
    target.script = [fail(GROUNDING_FAIL)];
    // The user hits STOP while the first (failing) attempt is in flight.
    target.onStop = () => orch.stop();
    fakes.tools.register(target);

    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'target-tool', arguments: '{}' } }],
    });

    await orch.processMessage('stop during the failing action');
    expect(target.calls).toBe(1); // no deterministic retries after STOP
    const retryEvents = toolEvents(events).filter((e) => e.data.state === 'retrying' && e.data.failureClass);
    expect(retryEvents.length).toBe(0);
  });
});

describe('deterministic re-plan (plan mutation, bounded per task)', () => {
  it('after the ladder exhausts, PLAN B runs a corrective observation + the action on fresh evidence', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator({ maxRecoveryAttempts: 1, baseBackoffMs: 1 });
    const web = new RecoveryStub('blaxin_web');
    web.script = [
      fail(GROUNDING_FAIL),                                        // plan A attempt 1
      fail(GROUNDING_FAIL),                                        // ladder attempt (budget 1) → exhausted
      { success: true, output: 'OBSERVED at https://x/', data: {} }, // PLAN B corrective observation (snapshot)
      { success: true, output: 'clicked', data: {} },              // PLAN B re-run — now succeeds
    ];
    fakes.tools.register(web);

    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'blaxin_web', arguments: '{"action":"click","target":"login button"}' } }],
    });

    await orch.processMessage('plan A fails, plan B succeeds');
    expect(web.calls).toBe(4); // 2 plan-A + 1 corrective + 1 plan-B re-run
    expect(provider.calls).toBe(2); // baseline only — re-plan is deterministic

    const replanEvents = toolEvents(events).filter((e) => e.data.replanNumber);
    expect(replanEvents.length).toBe(1);
    expect(replanEvents[0].data.recoveryStrategy).toBe('replan');
    expect(replanEvents[0].data.replanNumber).toBe(1);
    expect(replanEvents[0].data.replanBudget).toBe(1);
    expect(String(replanEvents[0].data.replanDescription)).toContain('PLAN B');
    expect(String(replanEvents[0].data.replanDescription)).toContain('re-observe');
  });

  it('re-plan budget is per task: a NEW task gets its own re-plan budget', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator({ maxRecoveryAttempts: 1, baseBackoffMs: 1 });
    const web = new RecoveryStub('blaxin_web');
    // Task 1: plan A fails twice → corrective ok → plan-B re-run STILL
    // fails → honest failure; Brain reports.
    web.script.push(fail(GROUNDING_FAIL), fail(GROUNDING_FAIL), { success: true, output: 'observed', data: {} }, fail(GROUNDING_FAIL));
    // Task 2: plan A fails twice → corrective ok → plan-B re-run succeeds.
    web.script.push(fail(GROUNDING_FAIL), fail(GROUNDING_FAIL), { success: true, output: 'observed', data: {} }, { success: true, output: 'clicked', data: {} });
    fakes.tools.register(web);

    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'blaxin_web', arguments: '{"action":"click"}' } }],
    });
    provider.script.push({ content: 'Task 1 failed honestly.' });
    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c2', type: 'function', function: { name: 'blaxin_web', arguments: '{"action":"click"}' } }],
    });

    await orch.processMessage('first task — re-plan exhausts');
    await orch.processMessage('second task — fresh budget');

    const replanEvents = toolEvents(events).filter((e) => e.data.replanNumber);
    expect(replanEvents.length).toBe(2); // one per task — budget resets per task
    expect(web.calls).toBe(8); // 4 per task
  });

  it('a corrective observation that fails stops the re-plan honestly (no blind retry)', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator({ maxRecoveryAttempts: 1, baseBackoffMs: 1 });
    const web = new RecoveryStub('blaxin_web');
    web.script = [
      fail(GROUNDING_FAIL),                     // plan A attempt 1
      fail(GROUNDING_FAIL),                     // ladder attempt → exhausted
      // PLAN B corrective observation: fails AND exhausts its own
      // bounded ladder (2 fails with budget 1) — the observation is
      // honestly failed, so the re-plan must stop.
      fail('could not read the page location'),
      fail('could not read the page location'),
    ];
    fakes.tools.register(web);

    provider.script.push({
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'blaxin_web', arguments: '{"action":"click"}' } }],
    });
    provider.script.push({ content: 'The page is gone; reporting honestly.' });

    await orch.processMessage('plan B observation fails honestly');
    expect(web.calls).toBe(4); // 2 plan-A + 2 corrective (own ladder), NO re-run
    const stopped = toolEvents(events).filter((e) => String(e.data.recoveryDetail ?? '').includes('re-plan stopped'));
    expect(stopped.length).toBe(1);
    // The Brain saw the honest failure and replied (no fake success).
    const stepStates = (events.filter((e) => e.event === 'task-progress').slice(-1)[0]?.data.steps ?? []).map((s: any) => s.state);
    expect(stepStates).toContain('failed');
  });

  it('direct-path failures also re-plan (the fast path does not skip recovery; zero model calls)', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator({ maxRecoveryAttempts: 0, maxReplansPerTask: 1 });
    const fs = new RecoveryStub('filesystem');
    fs.script = [
      fail('File not found: /etc/hostname'),
      { success: true, output: 'hostname.d  hosts  conf.d', data: {} }, // corrective parent listing
      { success: true, output: 'file content', data: {} },              // plan B re-run
    ];
    fakes.tools.register(fs);

    await orch.processMessage('read /etc/hostname'); // deterministic fast path
    expect(provider.calls).toBe(0); // ALL deterministic — no model call at all
    expect(fs.calls).toBe(3); // plan A + corrective + plan B

    const replanEvents = toolEvents(events).filter((e) => e.data.replanNumber);
    expect(replanEvents.length).toBe(1);
    expect(replanEvents[0].data.failureClass).toBe('TARGET_NOT_FOUND');
  });
});
