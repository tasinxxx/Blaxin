// Memory-driven procedure learning (B6, directive Phase 5):
//   PROMOTION — only a fully VERIFIED multi-step run becomes a reusable
//   procedure (the store refuses sensitive/short content; the advisor
//   already frames procedures as starting points, never replayed blindly).
//   FAILURE ACCOUNTING — a procedure the advisor selected loses confidence
//   when the run then failed with real step evidence; repeated failures
//   trip the store's auto-rollback, so stale procedures stop surfacing.
// These tests pin the ORCHESTRATOR-side loop closure (the honest gates
// inside ProceduralMemory have their own suite, memory-layers.test.ts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Isolated data dir per run — layered memory must never touch real state.
const DIR = mkdtempSync(join(tmpdir(), 'blaxin-proclearn-'));
process.env.BLAXIN_DATA_DIR = DIR;

import { AgentOrchestrator } from '../orchestrator/index.js';
import { LayeredMemory } from '../memory/layers.js';
import { MemoryAdvisor } from '../memory/advisor.js';
import { buildFakes, FakeProvider, makeToolCall } from './helpers/orchestrator-fakes.js';

interface Ev { event: string; data: any }

/** In-memory recording runtime with the full runtime shape. */
function makeRecordingRuntime() {
  const calls: Array<{ method: string; input: any }> = [];
  return {
    calls,
    failure(input: any) { calls.push({ method: 'failure', input }); return {}; },
    observeEnvironment(input: any) { calls.push({ method: 'observeEnvironment', input }); return {}; },
    recordEpisode(input: any) { calls.push({ method: 'recordEpisode', input }); return {}; },
    promoteProcedure(input: any, verified: boolean) { calls.push({ method: 'promoteProcedure', input: { ...input, verified } }); return {}; },
    procedureFailedById(id: string) { calls.push({ method: 'procedureFailedById', input: { id } }); return {}; },
  };
}

describe('orchestrator procedure learning loop (B6)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'blaxin-proclearn-t-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function makeOrch(fakes: ReturnType<typeof buildFakes>, runtime: any, advisor?: MemoryAdvisor) {
    const orch = new AgentOrchestrator({
      providers: fakes.providers,
      toolRegistry: fakes.tools,
      sessionState: fakes.session,
      memoryStore: fakes.memory,
      getConfig: () => fakes.config,
    });
    orch.setMemoryRuntime(runtime);
    if (advisor) orch.setMemoryAdvisor(advisor);
    return orch;
  }

  it('a verified multi-step run promotes a reusable procedure with real steps', async () => {
    const fakes = buildFakes();
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script.push({
      toolCalls: [makeToolCall('filesystem', { operation: 'list', path: '/tmp' })],
    });
    provider.script.push({
      toolCalls: [makeToolCall('search', { query: 'blaxin release notes' })],
    });

    const runtime = makeRecordingRuntime();
    const orch = makeOrch(fakes, runtime);
    await orch.processMessage('collect the release notes from the filesystem and the web');

    const promos = runtime.calls.filter((c) => c.method === 'promoteProcedure');
    expect(promos).toHaveLength(1);
    const input = promos[0].input;
    expect(input.verified).toBe(true);
    expect(input.name).toContain('collect the release notes');
    expect(input.steps.length).toBeGreaterThanOrEqual(2);
    expect(input.steps[0]).toContain('filesystem');
    expect(input.taskId).toBeTruthy();
    // The trigger tags are the REAL tools that ran.
    expect(input.triggerTags).toContain('filesystem');
  });

  it('a single-tool verified run does NOT promote (no trivial recipes)', async () => {
    const fakes = buildFakes();
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script.push({
      toolCalls: [makeToolCall('filesystem', { operation: 'list', path: '/tmp' })],
    });

    const runtime = makeRecordingRuntime();
    const orch = makeOrch(fakes, runtime);
    await orch.processMessage('list the contents of /tmp');

    expect(runtime.calls.some((c) => c.method === 'promoteProcedure')).toBe(false);
    // The episode is still recorded (existing behavior intact).
    expect(runtime.calls.some((c) => c.method === 'recordEpisode')).toBe(true);
  });

  it('a FAILED run never promotes a procedure', async () => {
    const fakes = buildFakes();
    const provider = fakes.providers.getProvider() as FakeProvider;
    const failing = fakes.tools.getTool('filesystem') as any;
    failing.fail = true;
    provider.script.push({
      toolCalls: [makeToolCall('filesystem', { operation: 'list', path: '/tmp' })],
    });
    provider.script.push({
      toolCalls: [makeToolCall('search', { query: 'fallback query' })],
    });

    const runtime = makeRecordingRuntime();
    const orch = makeOrch(fakes, runtime);
    await orch.processMessage('failing multi-step workflow attempt');

    expect(runtime.calls.some((c) => c.method === 'promoteProcedure')).toBe(false);
    expect(runtime.calls.some((c) => c.method === 'failure')).toBe(true);
  });

  it('a procedure the advisor selected is failure-accounted BY ID when the run fails', async () => {
    const fakes = buildFakes();
    const provider = fakes.providers.getProvider() as FakeProvider;

    // A procedure that will match the objective, planted in real memory.
    const layers = new LayeredMemory({ file: join(dir, 'proc.json') });
    layers.promoteProcedure({
      name: 'deploy the website build',
      purpose: 'build then upload then verify URL',
      steps: ['terminal: npm run build', 'filesystem: upload dist', 'browser: verify the live URL'],
      triggerTags: ['terminal', 'filesystem', 'browser'],
    }, true);
    const proc = layers.snapshot().procedures.find((p) => p.name === 'deploy the website build');
    expect(proc).toBeTruthy();
    expect(proc).toBeTruthy();

    const advisor = new MemoryAdvisor(layers);
    const runtime = makeRecordingRuntime();
    const orch = makeOrch(fakes, runtime, advisor);

    // The run FAILS with real step evidence.
    const failing = fakes.tools.getTool('filesystem') as any;
    failing.fail = true;
    provider.script.push({
      toolCalls: [makeToolCall('filesystem', { operation: 'list', path: '/tmp' })],
    });

    await orch.processMessage('deploy the website build again');

    const accounted = runtime.calls.filter((c) => c.method === 'procedureFailedById');
    expect(accounted).toHaveLength(1);
    expect(accounted[0].input.id).toBe(proc!.id);
  });

  it('a procedure is NOT failure-accounted when the run succeeds', async () => {
    const fakes = buildFakes();
    const provider = fakes.providers.getProvider() as FakeProvider;

    const layers = new LayeredMemory({ file: join(dir, 'proc-ok.json') });
    layers.promoteProcedure({
      name: 'deploy the website build',
      purpose: 'build then upload then verify URL',
      steps: ['terminal: npm run build', 'filesystem: upload dist', 'browser: verify the live URL'],
      triggerTags: ['terminal', 'filesystem', 'browser'],
    }, true);
    const advisor = new MemoryAdvisor(layers);
    const runtime = makeRecordingRuntime();
    const orch = makeOrch(fakes, runtime, advisor);

    provider.script.push({
      toolCalls: [makeToolCall('filesystem', { operation: 'list', path: '/tmp' })],
    });

    await orch.processMessage('deploy the website build again');

    expect(runtime.calls.some((c) => c.method === 'procedureFailedById')).toBe(false);
  });

  it('END-TO-END with the real store: repeated failures auto-rollback the procedure (advisor stops surfacing it)', async () => {
    const fakes = buildFakes();
    const provider = fakes.providers.getProvider() as FakeProvider;

    const layers = new LayeredMemory({ file: join(dir, 'rollback.json') });
    layers.promoteProcedure({
      name: 'deploy the website build',
      purpose: 'build then upload then verify URL',
      steps: ['terminal: npm run build', 'filesystem: upload dist', 'browser: verify the live URL'],
      triggerTags: ['terminal', 'filesystem', 'browser'],
    }, true);
    const advisor = new MemoryAdvisor(layers);

    const failing = fakes.tools.getTool('filesystem') as any;
    failing.fail = true;

    // TWO failed runs that both selected the procedure → failureCount 2
    // ≥ threshold AND > successCount → the store auto-rolls it back.
    for (let i = 0; i < 2; i++) {
      const runtime = {
        failure: (x: any) => layers.failure(x),
        observeEnvironment: (x: any) => layers.observeEnvironment(x),
        recordEpisode: (x: any) => layers.recordEpisode(x),
        promoteProcedure: (x: any, v: boolean) => layers.promoteProcedure(x, v),
        procedureFailedById: (id: string) => layers.procedureFailedById(id),
      };
      const orch = makeOrch(fakes, runtime, advisor);
      provider.script.length = 0;
      provider.script.push({
        toolCalls: [makeToolCall('filesystem', { operation: 'list', path: '/tmp' })],
      });
      await orch.processMessage('deploy the website build again');
    }

    const rolled = layers.snapshot().procedures.find((p) => p.name === 'deploy the website build');
    expect(rolled?.status).toBe('rolled_back');
    // The advisor no longer surfaces it (status filter: active only) —
    // the stored version history carries the honest rollback reason.
    expect(rolled?.versionHistory.some((h) => h.reason.includes('auto-disabled'))).toBe(true);
    const advisory = advisor.advise('deploy the website build again');
    expect(advisory.text).not.toContain('[procedure');
  });

  it('promoting through the REAL store then selecting: a future similar objective sees the verified procedure', async () => {
    const fakes = buildFakes();
    const provider = fakes.providers.getProvider() as FakeProvider;

    const layers = new LayeredMemory({ file: join(dir, 'reuse.json') });
    const advisor = new MemoryAdvisor(layers);

    // Run 1: verified multi-step run through the REAL store → promoted.
    const runtime = {
      failure: (x: any) => layers.failure(x),
      observeEnvironment: (x: any) => layers.observeEnvironment(x),
      recordEpisode: (x: any) => layers.recordEpisode(x),
      promoteProcedure: (x: any, v: boolean) => layers.promoteProcedure(x, v),
      procedureFailedById: (id: string) => layers.procedureFailedById(id),
    };
    const orch1 = makeOrch(fakes, runtime, advisor);
    provider.script.push({
      toolCalls: [makeToolCall('filesystem', { operation: 'list', path: '/tmp' })],
    });
    provider.script.push({
      toolCalls: [makeToolCall('search', { query: 'quarterly numbers' })],
    });
    await orch1.processMessage('gather the quarterly numbers from disk and the web');

    const stored = layers.snapshot().procedures;
    const proc = stored.find((p) => p.name.includes('gather the quarterly numbers'));
    expect(proc).toBeTruthy();
    expect(proc!.successCount).toBe(1);
    expect(proc!.status).toBe('active');

    // Run 2: a similar objective — the advisor must surface the procedure.
    const advisory = advisor.advise('gather the quarterly numbers from disk and the web');
    expect(advisory.text).toContain('[procedure');
    expect(advisory.text).toContain('v1');
    // The never-replay-blindly subordination framing is part of the block.
    expect(advisory.text).toContain('never replay blindly');
  });

  it('a throwing promotion path never breaks the task (memory safety rule)', async () => {
    const fakes = buildFakes();
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script.push({
      toolCalls: [makeToolCall('filesystem', { operation: 'list', path: '/tmp' })],
    });
    provider.script.push({
      toolCalls: [makeToolCall('search', { query: 'x' })],
    });

    const events: Ev[] = [];
    const orch = makeOrch(fakes, {
      failure: () => {},
      observeEnvironment: () => {},
      recordEpisode: () => {},
      promoteProcedure: () => { throw new Error('disk on fire'); },
      procedureFailedById: () => { throw new Error('disk on fire'); },
    });
    orch.setEventCallback((event, data) => events.push({ event, data }));
    await orch.processMessage('multi-step task with a broken memory disk');

    expect(events.some((e) => e.event === 'error')).toBe(false);
    expect(events.some((e) => e.event === 'agent-message')).toBe(true);
  });
});
