import { describe, it, expect, beforeEach } from 'vitest';
import { AgentOrchestrator } from '../orchestrator/index.js';
import { riskFor, isHigherRisk, RISK_TIERS_ORDER } from '../tools/index.js';
import { telemetry } from '../utils/telemetry.js';
import {
  buildFakes, FakeProvider, StubTool, makeToolCall, sleep, makeConfig,
} from './helpers/orchestrator-fakes.js';

interface Ev { event: string; data: any }

beforeEach(() => {
  telemetry.reset();
});

// ── riskFor(): deterministic risk classification ───────────────

describe('riskFor', () => {
  it('declares a base tier per capability', () => {
    expect(riskFor('system-info', {})).toBe('LOW');
    expect(riskFor('search', {})).toBe('LOW');
    expect(riskFor('clipboard', {})).toBe('LOW');
    expect(riskFor('screenshot', {})).toBe('MEDIUM');
    expect(riskFor('browser', {})).toBe('MEDIUM');
    expect(riskFor('computer-control', {})).toBe('MEDIUM');
    expect(riskFor('terminal', {})).toBe('MEDIUM');
  });

  it('treats read-only browser observation as LOW risk (§6)', () => {
    expect(riskFor('browser', { action: 'current_url' })).toBe('LOW');
    expect(riskFor('browser', { action: 'page_title' })).toBe('LOW');
    expect(riskFor('browser', { action: 'list_tabs' })).toBe('LOW');
    // Navigation/manipulation stays MEDIUM.
    expect(riskFor('browser', { action: 'open_url' })).toBe('MEDIUM');
    expect(riskFor('browser', { action: 'back' })).toBe('MEDIUM');
    expect(riskFor('browser', { action: 'refresh' })).toBe('MEDIUM');
  });

  it('escalates destructive filesystem operations to HIGH', () => {
    expect(riskFor('filesystem', { operation: 'read', path: '/tmp/a' })).toBe('MEDIUM');
    expect(riskFor('filesystem', { operation: 'write', path: '/tmp/a' })).toBe('MEDIUM');
    expect(riskFor('filesystem', { operation: 'delete', path: '/tmp/a' })).toBe('HIGH');
    expect(riskFor('filesystem', { operation: 'rename', path: '/tmp/a' })).toBe('HIGH');
  });

  it('escalates destructive terminal commands to CRITICAL via config patterns', () => {
    const config = makeConfig({ confirmationPatterns: ['rm ', 'sudo', 'shutdown', 'mkfs'] });
    expect(riskFor('terminal', { command: 'rm -rf /tmp/x' }, config)).toBe('CRITICAL');
    expect(riskFor('terminal', { command: 'sudo apt install foo' }, config)).toBe('CRITICAL');
    expect(riskFor('terminal', { command: 'ls -la' }, config)).toBe('MEDIUM');
    expect(riskFor('terminal', { command: 'cat file.txt' }, config)).toBe('MEDIUM');
  });

  it('orders tiers ascending and compares correctly', () => {
    expect(RISK_TIERS_ORDER).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
    expect(isHigherRisk('CRITICAL', 'LOW')).toBe(true);
    expect(isHigherRisk('HIGH', 'HIGH')).toBe(false);
    expect(isHigherRisk('LOW', 'CRITICAL')).toBe(false);
  });
});

// ── Orchestrator: every settled step carries risk + scope ──────

function makeOrchestrator(fakes: ReturnType<typeof buildFakes>, events: Ev[]) {
  const orch = new AgentOrchestrator({
    providers: fakes.providers,
    toolRegistry: fakes.tools,
    sessionState: fakes.session,
    memoryStore: fakes.memory,
    getConfig: () => fakes.config,
  });
  orch.setEventCallback((event, data) => events.push({ event, data }));
  return orch;
}

async function respondToNextConfirmation(orch: AgentOrchestrator, events: Ev[], approved: boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const ev = events.find((e) => e.event === 'confirmation-required');
    if (ev) {
      orch.respondToConfirmation(ev.data.stepId, approved);
      return;
    }
    await sleep(10);
  }
  throw new Error('No confirmation-required event was emitted');
}

function lastProgress(events: Ev[]): any {
  const progress = events.filter((e) => e.event === 'task-progress');
  return progress[progress.length - 1]?.data;
}

describe('per-step risk + permission scope', () => {
  it('marks a destructive terminal step CRITICAL + ALLOW_ONCE and gates it', async () => {
    const fakes = buildFakes();
    fakes.tools.register(new StubTool('terminal', { executionMode: 'serial' }));
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script.push({ toolCalls: [makeToolCall('terminal', { command: 'rm -rf /tmp/x' })] });
    provider.script.push({ content: 'Done.' });

    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);
    const run = orch.processMessage('please handle this task');
    await respondToNextConfirmation(orch, events, true);
    await run;

    const step = lastProgress(events)?.steps?.[0];
    expect(step).toBeDefined();
    expect(step.riskTier).toBe('CRITICAL');
    expect(step.permissionScope).toBe('ALLOW_ONCE');
    expect(events.some((e) => e.event === 'confirmation-required')).toBe(true);
  });

  it('marks a denied step DENY (never executed)', async () => {
    const fakes = buildFakes();
    fakes.tools.register(new StubTool('terminal', { executionMode: 'serial' }));
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script.push({ toolCalls: [makeToolCall('terminal', { command: 'sudo rm -rf /home' })] });
    provider.script.push({ content: 'Skipped as requested.' });

    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);
    const run = orch.processMessage('please handle this task');
    await respondToNextConfirmation(orch, events, false);
    await run;

    const step = lastProgress(events)?.steps?.[0];
    expect(step).toBeDefined();
    expect(step.riskTier).toBe('CRITICAL');
    expect(step.permissionScope).toBe('DENY');
    expect(step.state).toBe('skipped');
  });

  it('marks a safe search step LOW + ALWAYS_ALLOW without gating', async () => {
    const fakes = buildFakes();
    const provider = fakes.providers.getProvider() as FakeProvider;
    provider.script.push({ toolCalls: [makeToolCall('search', { query: 'weather' })] });
    provider.script.push({ content: 'Done.' });

    const events: Ev[] = [];
    const orch = makeOrchestrator(fakes, events);
    await orch.processMessage('please handle this task');

    const step = lastProgress(events)?.steps?.[0];
    expect(step).toBeDefined();
    expect(step.riskTier).toBe('LOW');
    expect(step.permissionScope).toBe('ALWAYS_ALLOW');
    expect(events.some((e) => e.event === 'confirmation-required')).toBe(false);
  });
});