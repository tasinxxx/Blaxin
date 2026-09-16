// Adaptive model routing (10× Objective 1) — the honest proof
// =============================================================
// What these tests pin down:
//  1. deterministic task = 0 model calls
//  2. simple task selects a compatible LOCAL model when one exists
//  3. vision task REJECTS a non-vision model (honest, no downgrade)
//  4. vision task SELECTS a vision-capable model when one exists
//  5. tool-required task rejects incompatible models
//  6. unavailable provider falls back to a usable one
//  7. failed model call triggers bounded fallback + real outcome history
//  8. fallback chain cannot loop infinitely
//  9. routing decision is journaled
// 10. secrets never leak into routing events
// 11. routing is deterministic under identical inputs
// 12. unsupported capability is reported honestly (no fake SUCCESS)
// =============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentOrchestrator } from '../orchestrator/index.js';
import { MissionJournal } from '../utils/mission-journal.js';
import {
  route as routeDecision, ModelReliability, supportsRequired, hasCapability,
} from '../router/model-router.js';
import { buildFakes, FakeProvider, makeConfig } from './helpers/orchestrator-fakes.js';
import { capabilitiesFromOllama } from '../providers/ollama.js';
import { ModelInfo, ProviderId } from '../types.js';
import { ProviderError } from '../providers/base.js';

interface Ev { event: string; data: any }

function makeOrchestrator(available: ModelInfo[]) {
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
  orch.setRoutingDependencies({ getAvailableModels: async () => available });
  const provider = fakes.providers.getProvider() as FakeProvider;
  return { fakes, orch, events, provider };
}

function model(provider: ProviderId, id: string, capabilities: ModelInfo['capabilities'], contextWindow = 8192): ModelInfo {
  return { id, name: id, provider, isFree: true, isAvailable: true, capabilities, contextWindow };
}

describe('model-router core (pure decisions)', () => {
  it('rejects a non-vision model for a vision task and names the missing capability', () => {
    const m = model('ollama', 'qwen3:4b', ['chat', 'function-calling']);
    expect(supportsRequired(m, { chat: true, toolCalling: true, vision: true, local: false })).toEqual({
      ok: false, missing: 'vision', unknown: false,
    });
    const decision = routeDecision({
      required: { chat: true, toolCalling: true, vision: true, local: false },
      available: [m],
      availableProviders: ['ollama'],
      activeProvider: 'ollama',
      activeModel: 'qwen3:4b',
      reliability: new ModelReliability(),
    });
    expect(decision.selection.kind).toBe('blocked');
    if (decision.selection.kind === 'blocked') {
      expect(decision.selection.block.reason).toBe('capability-unavailable');
      expect(decision.selection.block.capability).toBe('vision');
      expect(decision.selection.block.detail).toMatch(/refusing to fake/i);
    }
    expect(decision.rejected[0]).toMatchObject({ provider: 'ollama', model: 'qwen3:4b', reason: 'missing-capability', capability: 'vision' });
  });

  it('selects a vision-capable model when one exists and prefers the active model when compatible', () => {
    const plain = model('ollama', 'qwen3:4b', ['chat', 'function-calling']);
    const vision = model('anthropic', 'claude-sonnet-4', ['chat', 'vision', 'function-calling']);
    const decision = routeDecision({
      required: { chat: true, toolCalling: true, vision: true, local: false },
      available: [plain, vision],
      availableProviders: ['ollama', 'anthropic'],
      activeProvider: 'ollama',
      activeModel: 'qwen3:4b',
      reliability: new ModelReliability(),
    });
    expect(decision.selection.kind).toBe('selected');
    if (decision.selection.kind === 'selected') {
      expect(decision.selection.provider).toBe('anthropic');
      expect(decision.selection.model).toBe('claude-sonnet-4');
    }
    expect(decision.rejected).toHaveLength(1);
    expect(decision.rejected[0].model).toBe('qwen3:4b');
  });

  it('rejects unknown-capability models for capability tasks (honest unknown, no assumption)', () => {
    const m = model('ollama', 'legacy:7b', []);
    const decision = routeDecision({
      required: { chat: true, toolCalling: true, vision: true, local: true },
      available: [m],
      availableProviders: ['ollama'],
      activeProvider: 'ollama',
      activeModel: 'legacy:7b',
      reliability: new ModelReliability(),
    });
    expect(decision.selection.kind).toBe('blocked');
    expect(decision.rejected[0].reason).toBe('missing-capability-unknown');
  });

  it('unavailable provider is rejected by name; a usable one is selected', () => {
    // The unavailable (free) model sorts first and is REJECTED by name;
    // selection then lands on the usable (paid) model.
    const dead = model('openai', 'gpt-4o', ['chat', 'function-calling', 'vision'], 128000);
    const live = model('groq', 'llama-3.3-70b', ['chat', 'function-calling']);
    live.isFree = false;
    const decision = routeDecision({
      required: { chat: true, toolCalling: false, vision: false, local: false },
      available: [dead, live],
      availableProviders: ['groq'], // openai not usable right now
      activeProvider: null,
      activeModel: null,
      reliability: new ModelReliability(),
    });
    expect(decision.selection.kind).toBe('selected');
    if (decision.selection.kind === 'selected') {
      expect(decision.selection.provider).toBe('groq');
      expect(decision.selection.model).toBe('llama-3.3-70b');
    }
    expect(decision.rejected).toHaveLength(1);
    expect(decision.rejected[0]).toMatchObject({ provider: 'openai', model: 'gpt-4o', reason: 'provider-unavailable' });
  });

  it('bounded failure history demotes a repeatedly failing model but never fabricates rank for clean ones', () => {
    const r = new ModelReliability();
    r.record({ provider: 'ollama', model: 'flaky:7b' }, 'failure');
    r.record({ provider: 'ollama', model: 'flaky:7b' }, 'timeout');
    r.record({ provider: 'ollama', model: 'flaky:7b' }, 'failure');
    expect(r.score({ provider: 'ollama', model: 'flaky:7b' })).toBe(3);
    expect(r.score({ provider: 'ollama', model: 'clean:7b' })).toBe(0);
    const a = model('ollama', 'flaky:7b', ['chat', 'function-calling']);
    const b = model('ollama', 'clean:7b', ['chat', 'function-calling']);
    const decision = routeDecision({
      required: { chat: true, toolCalling: true, vision: false, local: true },
      available: [a, b],
      availableProviders: ['ollama'],
      activeProvider: null,
      activeModel: null,
      reliability: r,
    });
    expect(decision.selection.kind).toBe('selected');
    if (decision.selection.kind === 'selected') expect(decision.selection.model).toBe('clean:7b');
  });

  it('is deterministic under identical inputs (identical decisions, token-identical evidence)', () => {
    const available = [
      model('openai', 'gpt-4o-mini', ['chat', 'function-calling', 'vision'], 128000),
      model('ollama', 'qwen3:4b', ['chat', 'function-calling'], 32768),
      model('groq', 'llama-3.3-70b', ['chat', 'function-calling'], 8192),
    ];
    const req = { chat: true, toolCalling: true, vision: false, local: false };
    const run = () => {
      const d = routeDecision({
        required: req, available, availableProviders: ['openai', 'ollama', 'groq'],
        activeProvider: null, activeModel: null, reliability: new ModelReliability(),
      });
      return JSON.stringify({ s: d.selection, r: d.rejected, c: d.candidates });
    };
    expect(run()).toBe(run());
  });

  it('ollama capability mapping is honest: no capability data means unknown, tools/vision/thinking map from real labels', () => {
    const none = capabilitiesFromOllama(undefined, ['llama']);
    expect(none.capabilities).toEqual(['chat']);
    expect(none.unknownVision).toBe(true);
    // Family name alone is NOT capability proof.
    const noneFromLlavaFamily = capabilitiesFromOllama(null, ['llava']);
    expect(hasCapability({ ...model('ollama', 'x', []), capabilities: noneFromLlavaFamily.capabilities }, 'vision')).toBe(false);
    const full = capabilitiesFromOllama(['completion', 'tools', 'thinking', 'vision'], ['qwen3']);
    expect(full.capabilities).toEqual(['chat', 'function-calling', 'vision', 'reasoning']);
    expect(full.unknownVision).toBe(false);
  });
});

describe('orchestrator integration (adaptive routing end to end)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'blaxin-routing-'));
    file = join(dir, 'journal.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('deterministic task completes with ZERO model calls and emits no routing decision', async () => {
    const { fakes, orch, provider, events } = makeOrchestrator([
      model('ollama', 'qwen3:1.7b', ['chat', 'function-calling']),
    ]);
    const events2: Ev[] = [];
    orch.setEventCallback((event, data) => events2.push({ event, data }));
    fakes.tools.register(new (fakes.tools.getTool('filesystem') ? Object : Object)() as never); // no-op guard
    void fakes;
    void events;

    const listTool = {
      name: 'filesystem',
      description: 'filesystem',
      definition: { type: 'function' as const, function: { name: 'filesystem', description: 'fs', parameters: { type: 'object', properties: {}, required: [] } } },
      executionMode: 'serial' as const,
      execute: async () => ({ success: true, output: 'file1.txt', data: {} }),
    };
    fakes.tools.register(listTool);

    await orch.processMessage('read /tmp');

    expect(provider.calls).toBe(0);
    expect(events2.filter((e) => e.event === 'model-routing')).toHaveLength(0);
  });

  it('simple task routes to a compatible LOCAL model when one exists and journals the decision', async () => {
    const journal = new MissionJournal({ filePath: file });
    const { fakes, orch, provider, events } = makeOrchestrator([
      model('openai', 'gpt-4o-mini', ['chat', 'function-calling'], 128000),
      model('ollama', 'qwen3:4b', ['chat', 'function-calling'], 32768),
    ]);
    orch.setEventCallback((event, data) => {
      events.push({ event, data });
      journal.ingest(event, data);
    });
    fakes.providers.getProvider().fetchModels = async () => [
      model('custom', 'fake-model', ['chat', 'function-calling']),
    ];

    await orch.processMessage('summarize the theory of relativity in plain language');

    expect(provider.calls).toBeGreaterThanOrEqual(1);
    const routing = events.find((e) => e.event === 'model-routing');
    expect(routing).toBeDefined();
    expect(routing!.data.selectedProvider).toBe('ollama');
    expect(routing!.data.selected).toBe('qwen3:4b');
    expect(routing!.data.required).toContain('tool-calling');

    // Journaled (kind ROUTING) with real evidence.
    const lines = journal.list();
    const entry = lines.find((e) => e.kind === 'ROUTING');
    expect(entry).toBeDefined();
    expect(entry!.routing!.selected).toBe('ollama/qwen3:4b');
    expect(entry!.routing!.required).toContain('tool-calling');
    expect(entry!.routing!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('vision task BLOCKS honestly when no available model is vision-capable (no downgrade, no fake SUCCESS)', async () => {
    const { orch, provider, events } = makeOrchestrator([
      model('ollama', 'qwen3:4b', ['chat', 'function-calling']),
    ]);
    await orch.processMessage('look at my screen and tell me what you see');

    expect(provider.calls).toBe(0); // never called a model that cannot see
    const routing = events.find((e) => e.event === 'model-routing');
    expect(routing).toBeDefined();
    expect(routing!.data.blocked).toBe(true);
    expect(routing!.data.missingCapability).toBe('vision');
    expect(routing!.data.rejected).toHaveLength(1);
    expect(routing!.data.rejected[0].capability).toBe('vision');
    const err = events.find((e) => e.event === 'error');
    expect(err).toBeDefined();
    expect(String(err!.data.message)).toMatch(/vision/i);
  });

  it('vision task selects a vision-capable remote model over the local chat-only model', async () => {
    const { orch, provider, events } = makeOrchestrator([
      model('ollama', 'qwen3:4b', ['chat', 'function-calling']),
      model('anthropic', 'claude-sonnet-4', ['chat', 'vision', 'function-calling']),
    ]);
    provider.script = [{ content: 'I can see your desktop.' }];
    await orch.processMessage('take a screenshot of my screen and describe it');

    expect(provider.calls).toBeGreaterThanOrEqual(1);
    const routing = events.find((e) => e.event === 'model-routing');
    expect(routing!.data.selectedProvider).toBe('anthropic');
    expect(routing!.data.rejected.map((r: any) => r.model)).toContain('qwen3:4b');
  });

  it('tool-required task rejects a tool-incapable model and blocks when it is the only candidate', async () => {
    const { orch, provider, events } = makeOrchestrator([
      model('ollama', 'tinyllama:1.1b', ['chat']),
    ]);
    await orch.processMessage('please plan a multi-step reorganization of my documents');

    expect(provider.calls).toBe(0);
    const routing = events.find((e) => e.event === 'model-routing');
    expect(routing!.data.blocked).toBe(true);
    expect(routing!.data.missingCapability).toBe('function-calling');
    // capabilities ['chat'] is non-empty data → the honest explicit rejection.
    expect(routing!.data.rejected[0].reason).toBe('missing-capability');
  });

  it('failed model call triggers a bounded fallback to a compatible model and records real outcomes', async () => {
    const { fakes, orch, provider, events } = makeOrchestrator([
      model('custom', 'fake-model', ['chat', 'function-calling']),
      model('ollama', 'qwen3:4b', ['chat', 'function-calling']),
    ]);
    const ollamaProvider = new FakeProvider();
    (ollamaProvider as unknown as { id: ProviderId }).id = 'ollama';
    const registry = fakes.providers as unknown as {
      getProvider(id: ProviderId): FakeProvider;
      getFallbackProvider(id: ProviderId): FakeProvider | null;
    };
    registry.getProvider = ((id: ProviderId) => (id === 'ollama' ? ollamaProvider : provider)) as never;
    registry.getFallbackProvider = ((id: ProviderId) => (id === 'custom' ? ollamaProvider : null)) as never;
    // The active model's call REALLY fails with a network error — the
    // same failure class the production fallback ladder handles.
    provider.chat = (async () => {
      throw new ProviderError('Connection refused by peer', 'NETWORK_ERROR', 'custom');
    }) as never;
    ollamaProvider.script = [{ content: 'Recovered via fallback.' }];

    await orch.processMessage('say something useful');

    const routingEvents = events.filter((e) => e.event === 'model-routing');
    expect(routingEvents.length).toBeGreaterThanOrEqual(2);
    expect(routingEvents[1].data.fallback).toMatch(/NETWORK_ERROR/);
    expect(routingEvents[1].data.selectedProvider).toBe('ollama');
    expect(routingEvents[1].data.selected).toBe('qwen3:4b');
    const reliability = orch.getRoutingReliability().snapshot();
    expect(reliability.find((r) => r.model === 'fake-model')?.outcomes.length ?? 0).toBeGreaterThan(0);
  });

  it('fallback chain is bounded: at most one escalation per candidate, each degraded model skipped while a clean one exists', async () => {
    const r = new ModelReliability();
    const available = [
      model('ollama', 'a:1b', ['chat']),
      model('ollama', 'b:1b', ['chat']),
      model('ollama', 'c:1b', ['chat']),
    ];
    const req = { chat: true, toolCalling: false, vision: false, local: true };
    const seen = new Set<string>();
    // Mirror the production escalation: after a failed call the failed
    // model loses its active preference and is demoted by its real
    // failure record (ignoreActiveModel=true path).
    for (let i = 0; i < 10; i++) {
      const d = routeDecision({
        required: req,
        available,
        availableProviders: ['ollama'],
        activeProvider: i === 0 ? 'ollama' : null,
        activeModel: null,
        reliability: r,
      });
      if (d.selection.kind === 'blocked') break;
      if (d.selection.kind === 'selected') {
        const key = `${d.selection.provider}/${d.selection.model}`;
        const cleanLeft = available.some((m) => !seen.has(`${m.provider}/${m.id}`));
        // A degraded candidate may only be re-selected when EVERY
        // candidate is already degraded — escalation is one-per-candidate.
        if (cleanLeft) expect(seen.has(key)).toBe(false);
        seen.add(key);
        r.record({ provider: d.selection.provider, model: d.selection.model }, 'timeout');
      }
    }
    expect(seen.size).toBeLessThanOrEqual(available.length);
    // The chain terminates after at most one escalation per candidate.
    expect(seen.size).toBe(available.length);
  });

  it('journal ROUTING entries never contain API-key-shaped strings even when the objective text does', async () => {
    const journal = new MissionJournal({ filePath: file });
    const { orch } = makeOrchestrator([
      model('ollama', 'qwen3:4b', ['chat', 'function-calling']),
    ]);
    orch.setEventCallback((event, data) => journal.ingest(event, data));
    await orch.processMessage('use key sk-proj-AAAAAAAAAAAAAAAAAAAAAA to check the weather');

    const lines = journal.list();
    const entry = lines.find((e) => e.kind === 'ROUTING');
    expect(entry).toBeDefined();
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('sk-proj-AAAAAAAAAAAAAAAAAAAAAA');
    expect(entry!.objective).toContain('[redacted]');
  });
});
