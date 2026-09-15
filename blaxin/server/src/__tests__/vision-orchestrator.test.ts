// Vision end-to-end (§8 parity gap: screen awareness)
// =============================================================
// A verified screenshot tool result must actually REACH the model as an
// image — the perception→action loop. Proven at the orchestrator level
// with a scripted provider: the provider's received message list carries
// the image on the tool result, bounded, and honest in the failure case
// (no image when no screenshot was captured).
// =============================================================

import { describe, it, expect } from 'vitest';
import { AgentOrchestrator } from '../orchestrator/index.js';
import { buildFakes, FakeProvider, StubTool } from './helpers/orchestrator-fakes.js';

const SCREENSHOT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
  orch.setMemoryRuntime(null);
  orch.setEventCallback((event, data) => events.push({ event, data }));
  const provider = fakes.providers.getProvider() as FakeProvider;
  return { fakes, orch, events, provider };
}

describe('vision end-to-end (screenshot reaches the model)', () => {
  it('carries the screenshot image on the tool result message the provider receives', async () => {
    const { fakes, orch, provider } = makeOrchestrator();
    // The screenshot tool REALLY captures: its result data carries base64.
    const shot = fakes.tools.getTool('screenshot') as StubTool;
    shot.execute = async () => ({
      success: true,
      output: 'Screenshot captured successfully (440 bytes).',
      data: { screenshotAvailable: true, size: 440, base64: SCREENSHOT_BASE64, mimeType: 'image/png' },
    });
    // Script: turn 1 calls the screenshot tool; turn 2 answers from it.
    provider.script = [
      { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }] },
      { content: 'I can see your desktop.', },
    ];

    await orch.processMessage('look at my screen and tell me what you see');

    // The SECOND model call must contain the image — the model SAW the screen.
    expect(provider.calls).toBeGreaterThanOrEqual(2);
    const secondCallMessages = provider.lastMessages;
    const toolMsg = secondCallMessages.find((m) => m.role === 'tool' && m.name === 'screenshot');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.images).toHaveLength(1);
    expect(toolMsg!.images![0]).toEqual({ mimeType: 'image/png', base64: SCREENSHOT_BASE64 });
  });

  it('adds NO image when the tool result carries none (honest, never fabricated)', async () => {
    const { orch, provider } = makeOrchestrator();
    provider.script = [
      { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'filesystem', arguments: '{"operation":"list"}' } }] },
      { content: 'Listed.' },
    ];
    await orch.processMessage('list my files');
    const toolMsg = provider.lastMessages.find((m) => m.role === 'tool' && m.name === 'filesystem');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.images).toBeUndefined();
  });

  it('drops oversized images (bounded context — no multi-MB blowups)', async () => {
    const { orch, provider } = makeOrchestrator();
    const huge = 'A'.repeat(5_000_000); // > MAX_IMAGE_BASE64_CHARS
    const shot = (orch as any).toolRegistry.getTool('screenshot') as StubTool;
    shot.execute = async () => ({
      success: true,
      output: 'Screenshot captured successfully.',
      data: { base64: huge, mimeType: 'image/png' },
    });
    provider.script = [
      { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }] },
      { content: 'I cannot see an image this time.' },
    ];
    await orch.processMessage('look at my screen');
    const toolMsg = provider.lastMessages.find((m) => m.role === 'tool' && m.name === 'screenshot');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.images).toBeUndefined(); // dropped, not truncated
  });

  it('a failed screenshot never carries an image', async () => {
    const { orch, provider } = makeOrchestrator();
    provider.script = [
      { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }] },
      { content: 'The screenshot failed.' },
    ];
    // StubTool.fail = true → error result without image data.
    (orch as any).toolRegistry.getTool('screenshot').fail = true;
    await orch.processMessage('look at my screen');
    const toolMsg = provider.lastMessages.find((m) => m.role === 'tool' && m.name === 'screenshot');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.images).toBeUndefined();
  });
});
