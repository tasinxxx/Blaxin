// Jarvis engine tests — REAL event-driven reporting only.
// Fakes inject events; the engine must compose honest reports and
// never upgrade partial progress into success.

import { describe, it, expect, vi } from 'vitest';
import { JarvisEngine, type JarvisDeps } from '../../jarvis/engine.js';
import type { JarvisDirective, JarvisSnapshot } from '../../jarvis/types.js';

type Emit = (event: string, data: any) => void;

function makeEngine(overrides: Partial<JarvisDeps> = {}): {
  engine: JarvisEngine;
  emit: Emit;
  executed: JarvisDirective[];
  snapshots: JarvisSnapshot[];
} {
  let listener: ((event: string, data: any) => void) | null = null;
  const executed: JarvisDirective[] = [];
  const snapshots: JarvisSnapshot[] = [];
  const deps: JarvisDeps = {
    events: {
      on(cb: (event: string, data: any) => void) {
        listener = cb;
      },
    },
    executeGoal: (directive) => {
      executed.push(directive);
      // Mirror the real host: mission-routed directives create a
      // mission and bind its id; everything else gets a queue task.
      if (directive.complexity === 'mission') {
        return { taskId: `m_${executed.length}`, missionId: `m_${executed.length}` };
      }
      return { taskId: `t_${executed.length}` };
    },
    ...overrides,
  };
  const engine = new JarvisEngine(deps);
  engine.onChange((snap) => snapshots.push(snap));
  const emit: Emit = (event, data) => listener?.(event, data);
  return { engine, emit, executed, snapshots };
}

/** Drive one full standard run through real events. */
function runStandardTask(
  emit: Emit,
  opts: {
    steps?: Array<{ id: string; description: string; state: string; error?: string; result?: string }>;
    terminal: 'completed' | 'error' | 'idle';
    reply?: string;
    outcome?: string;
  },
): void {
  emit('agent-state', { state: 'planning', description: 'Planning the approach...' });
  if (opts.steps?.length) {
    emit('task-progress', {
      id: 'task_1',
      steps: opts.steps,
    });
  }
  if (opts.reply) {
    emit('agent-message', { role: 'assistant', content: opts.reply, timestamp: Date.now() });
  }
  emit('agent-state', { state: opts.terminal, description: 'Done' });
  emit('task-complete', {
    taskId: 'task_1',
    kind: 'llm',
    totalMs: 1234,
    modelCalls: 2,
    toolCalls: opts.steps?.length ?? 0,
    outcome: opts.outcome,
  });
}

describe('Jarvis intent routing', () => {
  it('routes a multi-step request as a mission', () => {
    const { engine, executed } = makeEngine();
    engine.receiveCommand({
      message: 'Research this technology, then implement it, then run the tests',
      source: 'text',
    });
    expect(executed).toHaveLength(1);
    expect(executed[0].complexity).toBe('mission');
    expect(executed[0].reason).toBe('multi-step-request');
  });

  it('routes an explicit mission request as a mission', () => {
    const { engine, executed } = makeEngine();
    engine.receiveCommand({ message: 'Start a mission to organize my downloads folder', source: 'text' });
    expect(executed[0].complexity).toBe('mission');
    expect(executed[0].reason).toBe('explicit-mission-request');
  });

  it('routes targeted execution (play X) through the standard loop with a success condition when stated', () => {
    const { engine, executed } = makeEngine();
    engine.receiveCommand({ message: 'Play bohemian rhapsody on YouTube and make sure it is playing', source: 'voice' });
    expect(executed[0].complexity).toBe('standard');
    expect(executed[0].successCondition).toBeTruthy();
    expect(executed[0].successCondition!.toLowerCase()).toContain('playing');
    expect(executed[0].source).toBe('voice');
  });

  it('keeps trivially simple commands fast-path eligible', () => {
    const { engine, executed } = makeEngine();
    engine.receiveCommand({ message: 'Open youtube', source: 'text' });
    expect(executed[0].complexity).toBe('fast');
    expect(executed[0].reason).toBe('deterministic-single-tool');
  });

  it('routes a follow-up with conversation context as a standard run', () => {
    const { engine, emit, executed } = makeEngine({
      hasConversationHistory: () => true,
    });
    // Establish continuity: first run completes.
    engine.receiveCommand({ message: 'List the contents of /tmp', source: 'text' });
    runStandardTask(emit, { terminal: 'completed', reply: 'Listed /tmp contents.' });
    // Follow-up referring to the prior exchange.
    engine.receiveCommand({ message: 'Now delete the oldest file from that listing', source: 'text' });
    expect(executed).toHaveLength(2);
    expect(executed[1].reason).toBe('follow-up-context');
    expect(executed[1].context.previousExchange?.request).toBe('List the contents of /tmp');
    expect(executed[1].context.previousExchange?.outcome).toBe('SUCCESS');
  });

  it('never routes a follow-up as fast-path even when it looks single-tool', () => {
    const { engine, emit, executed } = makeEngine({
      hasConversationHistory: () => true,
    });
    engine.receiveCommand({ message: 'Take a screenshot', source: 'text' });
    runStandardTask(emit, { terminal: 'completed' });
    engine.receiveCommand({ message: 'Take another one of that window', source: 'text' });
    expect(executed[1].complexity).not.toBe('fast');
  });

  it('strips a wake word from voice commands without changing the goal', () => {
    const { engine, executed } = makeEngine();
    engine.receiveCommand({ message: 'Hey BLAXIN, take a screenshot', source: 'voice' });
    expect(executed[0].goal).toBe('take a screenshot');
  });
});

describe('Jarvis honest reporting', () => {
  it('reports SUCCESS only for a clean completed run', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'List the contents of /tmp', source: 'text' });
    runStandardTask(emit, {
      steps: [{ id: 's1', description: 'File list: /tmp', state: 'completed', result: 'bin etc home' }],
      terminal: 'completed',
      reply: 'The contents are listed.',
    });
    const snap = engine.snapshot();
    expect(snap.phase).toBe('idle');
    expect(snap.lastReport?.status).toBe('SUCCESS');
    expect(snap.lastReport?.evidence).toHaveLength(1);
    expect(snap.lastReport?.metrics?.totalMs).toBe(1234);
    expect(snap.lastReport?.summary).toBe('The contents are listed.');
    expect(snap.lastReport?.blockers).toHaveLength(0);
  });

  it('reports PARTIAL when steps failed — never upgrades to success', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'Fix the build', source: 'text' });
    runStandardTask(emit, {
      steps: [
        { id: 's1', description: 'Run build', state: 'completed' },
        { id: 's2', description: 'Apply fix', state: 'failed', error: 'compile error' },
      ],
      terminal: 'completed',
      reply: 'Tried to fix it.',
    });
    expect(engine.snapshot().lastReport?.status).toBe('PARTIAL');
    expect(engine.snapshot().lastReport?.blockers.some((b) => b.includes('compile error'))).toBe(true);
  });

  it('reports PARTIAL when steps were skipped (denied permissions)', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'Clean the downloads folder', source: 'text' });
    runStandardTask(emit, {
      steps: [
        { id: 's1', description: 'Delete old files', state: 'skipped' },
      ],
      terminal: 'completed',
    });
    expect(engine.snapshot().lastReport?.status).toBe('PARTIAL');
  });

  it('reports FAILED when the agent errored', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'Do the impossible', source: 'text' });
    runStandardTask(emit, { terminal: 'error', reply: 'Could not.' });
    expect(engine.snapshot().lastReport?.status).toBe('FAILED');
  });

  it('reports STOPPED when the user stopped the run', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'Long task', source: 'text' });
    runStandardTask(emit, { terminal: 'idle' });
    expect(engine.snapshot().lastReport?.status).toBe('STOPPED');
  });

  it('never reports without a real terminal signal', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'List /tmp', source: 'text' });
    // Steps arrive, but the run never terminates: no report may exist.
    emit('task-progress', { id: 'task_1', steps: [{ id: 's1', description: 'x', state: 'executing' }] });
    expect(engine.snapshot().lastReport).toBeNull();
    expect(engine.snapshot().phase).toBe('delegated');
  });

  it('does not report on a task-complete that arrives before any terminal state and has no outcome', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'List /tmp', source: 'text' });
    emit('task-complete', { taskId: 'task_1', totalMs: 5 });
    expect(engine.snapshot().lastReport).toBeNull();
  });

  it('uses the real task-complete outcome as terminal fallback (no-provider path)', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'List /tmp', source: 'text' });
    emit('error', { message: 'No AI provider configured', code: 'NO_PROVIDER' });
    emit('task-complete', { taskId: 'task_1', totalMs: 3, outcome: 'no-provider' });
    expect(engine.snapshot().lastReport?.status).toBe('FAILED');
  });
});

describe('Jarvis phases', () => {
  it('walks real phases: understanding → routing → delegated → idle', () => {
    const { engine, emit, snapshots } = makeEngine();
    engine.receiveCommand({ message: 'Open youtube', source: 'text' });
    const afterDelegate = engine.snapshot().phase;
    expect(afterDelegate).toBe('delegated');
    runStandardTask(emit, { terminal: 'completed' });
    // Every broadcast phase was a real engine state, in order.
    const phases = snapshots.map((s) => s.phase);
    expect(phases[0]).toBe('understanding');
    expect(phases).toContain('routing');
    expect(phases).toContain('delegated');
    expect(phases).toContain('reporting');
    expect(phases[phases.length - 1]).toBe('idle');
  });
});

describe('Jarvis runtime state reflection (§5)', () => {
  it('real agent states drive the phase while the directive executes', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'Do a long thing', source: 'text' });

    emit('agent-state', { state: 'planning' });
    expect(engine.snapshot().phase).toBe('planning');
    emit('agent-state', { state: 'thinking' });
    expect(engine.snapshot().phase).toBe('thinking');
    emit('agent-state', { state: 'executing' });
    expect(engine.snapshot().phase).toBe('executing');
    emit('agent-state', { state: 'observing' });
    expect(engine.snapshot().phase).toBe('observing');
    emit('agent-state', { state: 'waiting' });
    expect(engine.snapshot().phase).toBe('waiting');
  });

  it('a real confirmation gate reports BLOCKED', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'Delete the file', source: 'text' });
    emit('confirmation-required', { stepId: 'c1', description: 'Execute terminal: rm x' });
    expect(engine.snapshot().phase).toBe('blocked');
  });

  it('a real retry reports RECOVERING', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'Open the site', source: 'text' });
    emit('tool-execution', { toolName: 'browser', state: 'executing', stepId: 's1' });
    emit('tool-execution', { toolName: 'browser', state: 'retrying', stepId: 's1' });
    expect(engine.snapshot().phase).toBe('recovering');
  });

  it('a real browser session desync reports RECOVERING', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'Open the site', source: 'text' });
    emit('browser-session', { event: { type: 'session-desync', detail: 'target vanished' } });
    expect(engine.snapshot().phase).toBe('recovering');
  });

  it('real events never move the phase when no directive is active', () => {
    const { engine, emit } = makeEngine();
    emit('agent-state', { state: 'planning' });
    emit('agent-state', { state: 'executing' });
    emit('confirmation-required', { stepId: 'c1' });
    emit('tool-execution', { toolName: 'browser', state: 'retrying' });
    emit('browser-session', { event: { type: 'session-desync' } });
    expect(engine.snapshot().phase).toBe('idle');
  });

  it('runtime phases still settle to idle through reporting after a real terminal state', () => {
    const { engine, emit, snapshots } = makeEngine();
    engine.receiveCommand({ message: 'Do a long thing', source: 'text' });
    runStandardTask(emit, { terminal: 'completed' });
    const phases = snapshots.map((s) => s.phase);
    expect(phases).toContain('planning');
    expect(phases).toContain('reporting');
    expect(phases[phases.length - 1]).toBe('idle');
  });
});

describe('Jarvis mission-routed reporting', () => {
  function makeMission(id: string, status: string, stepStates: Array<[string, string]>) {
    return {
      id,
      status,
      steps: stepStates.map(([desc, st], i) => ({
        id: `ms_${i}`,
        description: desc,
        status: st,
        result: st === 'completed' ? 'checkpoint ok' : undefined,
        error: st === 'failed' ? 'step blew up' : undefined,
      })),
    };
  }

  it('reports from real mission state and only when the mission terminates', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'Mission: audit the reports then email the summary', source: 'text' });
    // A mission directive executes as a mission (host side), so the
    // directive carries the missionId in context after host wiring.
    // Simulate that the host attached it:
    const directive = engine.snapshot().directive;
    expect(directive).toBeTruthy();

    // Mid-mission: individual step tasks complete — no report yet.
    emit('agent-state', { state: 'completed' });
    emit('task-complete', { taskId: 'q1', totalMs: 10, outcome: 'completed' });
    expect(engine.snapshot().lastReport).toBeNull();

    // Mission terminates successfully with real step checkpoints.
    emit('mission-progress', {
      missions: [makeMission('m_1', 'completed', [
        ['Audit the reports', 'completed'],
        ['Email the summary', 'completed'],
      ])],
    });
    const snap = engine.snapshot();
    expect(snap.lastReport?.status).toBe('SUCCESS');
    expect(snap.lastReport?.evidence).toHaveLength(2);
    expect(snap.lastReport?.evidence[0].result).toBe('checkpoint ok');
  });

  it('reports mission failure with real failed steps', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'Mission: deploy the app', source: 'text' });
    emit('mission-progress', {
      missions: [makeMission('m_1', 'failed', [
        ['Build', 'completed'],
        ['Deploy', 'failed'],
      ])],
    });
    expect(engine.snapshot().lastReport?.status).toBe('FAILED');
    expect(engine.snapshot().lastReport?.blockers.some((b) => b.includes('step blew up'))).toBe(true);
  });

  it('keeps no report while the mission is paused', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'Mission: long research', source: 'text' });
    emit('mission-progress', {
      missions: [makeMission('m_3', 'paused', [['Research phase 1', 'completed']])],
    });
    expect(engine.snapshot().lastReport).toBeNull();
  });

  it('mission reports carry the REAL checkpoint state (mission-control contract)', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'Mission: audit then email', source: 'text' });
    const mission = makeMission('m_1', 'completed', [
      ['Audit the reports', 'completed'],
      ['Email the summary', 'completed'],
    ]);
    // Real checkpoint records on the completed steps (mission store shape).
    (mission.steps[0] as any).checkpoint = { completedAt: 1111, summary: 'audit done: 12 files' };
    (mission.steps[1] as any).checkpoint = { completedAt: 2222, summary: 'email sent' };
    (mission as any).objective = 'audit then email';

    emit('mission-progress', { missions: [mission] });
    const report = engine.snapshot().lastReport;
    expect(report?.missionCheckpoint).toBeTruthy();
    expect(report?.missionCheckpoint?.missionId).toBe('m_1');
    expect(report?.missionCheckpoint?.completedSteps).toBe(2);
    expect(report?.missionCheckpoint?.totalSteps).toBe(2);
    // The LAST checkpoint in mission order wins (this is where resume
    // would continue from).
    expect(report?.missionCheckpoint?.lastCheckpoint?.summary).toBe('email sent');
    expect(report?.missionCheckpoint?.lastCheckpoint?.completedAt).toBe(2222);
  });

  it('a mission with no checkpoints reports an honest null checkpoint (no fabrication)', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'Mission: fresh start', source: 'text' });
    // Pause fires on a mission with zero completed steps — no report yet.
    emit('mission-progress', {
      missions: [makeMission('m_1', 'paused', [['Step A', 'pending']])],
    });
    expect(engine.snapshot().lastReport).toBeNull();
    // The mission later fails with zero checkpointed steps: the report
    // must say so honestly — not invent a checkpoint.
    emit('mission-progress', {
      missions: [makeMission('m_1', 'failed', [['Step A', 'pending']])],
    });
    const report = engine.snapshot().lastReport;
    expect(report?.status).toBe('FAILED');
    expect(report?.missionCheckpoint?.lastCheckpoint).toBeNull();
    expect(report?.missionCheckpoint?.nextAction).toContain('No checkpointed steps yet');
  });

  it('non-mission reports carry no checkpoint block (no fabrication)', () => {
    const { engine, emit } = makeEngine();
    engine.receiveCommand({ message: 'list the contents of /tmp', source: 'text' });
    runStandardTask(emit, { terminal: 'completed' });
    const report = engine.snapshot().lastReport;
    expect(report).toBeTruthy();
    expect(report?.missionCheckpoint).toBeUndefined();
  });
});
