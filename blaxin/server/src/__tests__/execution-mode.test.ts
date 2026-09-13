// Honest execution-route reporting (§6):
//   DETERMINISTIC — the fast path handled it, zero model calls
//   AI_BRAIN      — model reasoning all the way
//   HYBRID        — the fast path really ran, failed, and the model
//                   recovered (both layers genuinely executed)
// The route is derived from REAL run signals, never inferred by the UI.

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentOrchestrator } from '../orchestrator/index.js';
import { telemetry, executionModeOf } from '../utils/telemetry.js';
import { buildFakes, FakeProvider, StubTool } from './helpers/orchestrator-fakes.js';

interface Ev { event: string; data: any }

function makeOrchestrator() {
  const fakes = buildFakes();
  const events: Ev[] = [];
  const orch = new AgentOrchestrator({
    providers: fakes.providers,
    toolRegistry: fakes.tools,
    sessionState: fakes.session,
    memoryStore: fakes.memory,
    getConfig: () => fakes.config,
  });
  // Layered memory is a real singleton with disk writes — not needed here.
  orch.setMemoryRuntime(null);
  orch.setEventCallback((event, data) => events.push({ event, data }));
  const provider = fakes.providers.getProvider() as FakeProvider;
  return { fakes, orch, events, provider };
}

const completion = (events: Ev[]) => events.find((e) => e.event === 'task-complete');

describe('honest execution mode (§6)', () => {
  beforeEach(() => {
    telemetry.reset();
  });

  it('reports DETERMINISTIC when the fast path handled the task (no model call)', async () => {
    const { orch, events, provider } = makeOrchestrator();
    await orch.processMessage('take a screenshot');

    const done = completion(events);
    expect(done).toBeDefined();
    expect(done!.data.kind).toBe('direct');
    expect(done!.data.executionMode).toBe('DETERMINISTIC');
    expect(done!.data.modelCalls).toBe(0);
    // The LLM was never invoked.
    expect(provider.calls).toBe(0);
    expect(telemetry.latest(1)[0].executionMode).toBe('DETERMINISTIC');
  });

  it('reports AI_BRAIN when model reasoning ran without a fast-path candidate', async () => {
    const { orch, events, provider } = makeOrchestrator();
    await orch.processMessage('summarize the history of computing');

    const done = completion(events);
    expect(done!.data.kind).toBe('llm');
    expect(done!.data.executionMode).toBe('AI_BRAIN');
    expect(provider.calls).toBeGreaterThan(0);
    expect(telemetry.latest(1)[0].executionMode).toBe('AI_BRAIN');
  });

  it('reports HYBRID when the fast path failed and the model recovered', async () => {
    const { orch, events, fakes, provider } = makeOrchestrator();
    // The deterministic action is attempted and genuinely fails.
    (fakes.tools.getTool('screenshot') as StubTool).fail = true;

    await orch.processMessage('take a screenshot');

    const done = completion(events);
    expect(done).toBeDefined();
    // Both layers really ran: the fast path was attempted, then the LLM.
    expect(done!.data.executionMode).toBe('HYBRID');
    expect(done!.data.kind).toBe('llm');
    expect(provider.calls).toBeGreaterThan(0);
    expect(telemetry.latest(1)[0].executionMode).toBe('HYBRID');
  });

  it('legacy telemetry records without an explicit mode still derive one', () => {
    expect(executionModeOf({ kind: 'direct' })).toBe('DETERMINISTIC');
    expect(executionModeOf({ kind: 'llm' })).toBe('AI_BRAIN');
    expect(executionModeOf({ kind: 'llm', executionMode: 'HYBRID' })).toBe('HYBRID');
  });
});
