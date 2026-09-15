import { describe, it, expect, vi } from 'vitest';
import { ChatMessage } from '../types.js';
import {
  toOpenAICompatibleMessages,
  toAnthropicMessages,
  toGeminiMessages,
  toOllamaMessages,
} from '../providers/messages.js';
import {
  budgetToolResultImages,
  budgetToolResultOutput,
  stripImages,
  MAX_IMAGES_PER_TOOL_RESULT,
  MAX_IMAGE_BASE64_CHARS,
} from '../utils/context-budget.js';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The session manager resolves paths via BLAXIN_DATA_DIR at module load,
// and vitest hoists static imports — so the persistence test re-imports
// the module AFTER pointing the env var at a scratch dir.
const SCRATCH = join(tmpdir(), `blaxin-session-vision-test-${process.pid}`);

// ── Fixtures ─────────────────────────────────────────────────────
function msg(partial: Partial<ChatMessage> & { id: string; role: ChatMessage['role']; content: string }): ChatMessage {
  return { timestamp: Date.now(), ...partial } as ChatMessage;
}

const SCREENSHOT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const textResult: ChatMessage = msg({
  id: 't1', role: 'tool', toolCallId: 'call_1', name: 'filesystem', content: '[DIR] home',
});

const visionResult: ChatMessage = msg({
  id: 't2', role: 'tool', toolCallId: 'call_2', name: 'screenshot',
  content: 'Tool result (screenshot): Screenshot captured successfully (440 bytes).',
  images: [{ mimeType: 'image/png', base64: SCREENSHOT_BASE64 }],
});

const assistantWithCall: ChatMessage = msg({
  id: 'a1', role: 'assistant', content: 'Taking a screenshot.',
  toolCalls: [{ id: 'call_2', type: 'function', function: { name: 'screenshot', arguments: '{}' } }],
});

// ── OpenAI-compatible mapping ────────────────────────────────────
describe('vision: toOpenAICompatibleMessages', () => {
  it('keeps plain tool results as text-only tool messages', () => {
    const out = toOpenAICompatibleMessages([assistantWithCall, textResult]);
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '[DIR] home' });
  });

  it('emits the tool message PLUS a user turn with image_url parts for image results', () => {
    const out = toOpenAICompatibleMessages([assistantWithCall, visionResult]);
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'call_2', content: expect.stringContaining('Screenshot') });
    expect(out[2].role).toBe('user');
    expect(out[2].content).toHaveLength(2);
    expect(out[2].content[0].type).toBe('text');
    expect(out[2].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${SCREENSHOT_BASE64}` },
    });
  });

  it('maps multiple images as multiple image_url parts', () => {
    const two: ChatMessage = {
      ...visionResult,
      images: [
        { mimeType: 'image/png', base64: SCREENSHOT_BASE64 },
        { mimeType: 'image/jpeg', base64: 'anVzdA==' },
      ],
    };
    const out = toOpenAICompatibleMessages([assistantWithCall, two]);
    expect(out[2].content[1].type).toBe('image_url');
    expect(out[2].content[2].type).toBe('image_url');
    expect(out[2].content[2].image_url.url).toContain('image/jpeg');
  });
});

// ── Anthropic mapping ────────────────────────────────────────────
describe('vision: toAnthropicMessages', () => {
  it('rides the image as an image source block next to the tool_result', () => {
    const { messages } = toAnthropicMessages([assistantWithCall, visionResult]);
    const userTurn = messages[1];
    expect(userTurn.role).toBe('user');
    const blocks = userTurn.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_2' });
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: SCREENSHOT_BASE64 },
    });
  });

  it('keeps text-only results as a single tool_result block', () => {
    const { messages } = toAnthropicMessages([assistantWithCall, textResult]);
    const blocks = messages[1].content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'tool_result' });
  });

  it('merges a text result and a vision result into one user turn', () => {
    const { messages } = toAnthropicMessages([assistantWithCall, textResult, visionResult]);
    const blocks = messages[1].content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(3); // tool_result + tool_result + image
  });
});

// ── Gemini mapping ───────────────────────────────────────────────
describe('vision: toGeminiMessages', () => {
  it('adds an inlineData part next to the functionResponse', () => {
    const { contents } = toGeminiMessages([assistantWithCall, visionResult]);
    const parts = contents[1].parts;
    expect(parts[0]).toMatchObject({ functionResponse: { name: 'screenshot' } });
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: SCREENSHOT_BASE64 } });
  });

  it('does not add parts for text-only results', () => {
    const { contents } = toGeminiMessages([assistantWithCall, textResult]);
    expect(contents[1].parts).toHaveLength(1);
  });
});

// ── Ollama mapping ───────────────────────────────────────────────
describe('vision: toOllamaMessages', () => {
  it('carries images as the native base64 string array', () => {
    const out = toOllamaMessages([assistantWithCall, visionResult]);
    expect(out[1]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_2',
      images: [SCREENSHOT_BASE64],
    });
  });

  it('omits the images field for text-only results', () => {
    const out = toOllamaMessages([assistantWithCall, textResult]);
    expect(out[1].images).toBeUndefined();
  });
});

// ── context budget: image extraction bounds ──────────────────────
describe('budgetToolResultImages', () => {
  it('extracts a single verified image from tool result data', () => {
    const imgs = budgetToolResultImages({ base64: SCREENSHOT_BASE64, mimeType: 'image/png' });
    expect(imgs).toHaveLength(MAX_IMAGES_PER_TOOL_RESULT);
    expect(imgs[0]).toEqual({ mimeType: 'image/png', base64: SCREENSHOT_BASE64 });
  });

  it('returns empty for non-object data, missing base64, or a non-image mime type', () => {
    expect(budgetToolResultImages(undefined)).toEqual([]);
    expect(budgetToolResultImages('nope')).toEqual([]);
    expect(budgetToolResultImages({ mimeType: 'image/png' })).toEqual([]);
    expect(budgetToolResultImages({ base64: SCREENSHOT_BASE64, mimeType: 'text/plain' })).toEqual([]);
  });

  it('DROPS an oversized image rather than truncating it (no corrupt images)', () => {
    const huge = 'A'.repeat(MAX_IMAGE_BASE64_CHARS + 1);
    expect(budgetToolResultImages({ base64: huge, mimeType: 'image/png' })).toEqual([]);
  });

  it('keeps an image exactly at the cap', () => {
    const atCap = 'A'.repeat(MAX_IMAGE_BASE64_CHARS);
    expect(budgetToolResultImages({ base64: atCap, mimeType: 'image/png' })).toHaveLength(1);
  });
});

describe('stripImages', () => {
  it('removes images while preserving every other field', () => {
    const out = stripImages([assistantWithCall, visionResult, textResult]);
    expect(out[0].toolCalls).toBeDefined();
    expect(out[1].images).toBeUndefined();
    expect(out[1].content).toContain('Screenshot');
    expect(out[1].toolCallId).toBe('call_2');
    expect(out[2]).toEqual(textResult);
  });

  it('returns the SAME array when no message carries images (identity, not copy)', () => {
    const arr = [assistantWithCall, textResult];
    expect(stripImages(arr)).toBe(arr);
  });
});

// ── persistence: session file stays text-only ────────────────────
describe('session persistence strips images', () => {
  it('writes a state file with NO base64 payloads after adding an image message', async () => {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
    process.env.BLAXIN_DATA_DIR = SCRATCH;
    vi.resetModules();
    const { sessionState: fresh } = await import('../utils/session-state.js');

    fresh.addMessage(visionResult);
    fresh.addMessage(assistantWithCall);
    fresh.saveState();

    const file = join(SCRATCH, '.blaxin-state', 'session.json');
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf-8');
    expect(raw).not.toContain(SCREENSHOT_BASE64);
    expect(raw).toContain('Screenshot captured');
    const parsed = JSON.parse(raw);
    const stored = parsed.conversationHistory as Array<ChatMessage>;
    expect(stored).toHaveLength(2);
    expect(stored.every((m) => m.images === undefined)).toBe(true);
    delete process.env.BLAXIN_DATA_DIR;
    vi.resetModules();
    rmSync(SCRATCH, { recursive: true, force: true });
  });
});

// ── text budget unchanged (regression guard) ─────────────────────
describe('text budgeting is untouched', () => {
  it('budgetToolResultOutput still truncates long text', () => {
    const long = 'x'.repeat(20000);
    expect(budgetToolResultOutput(long).length).toBeLessThan(long.length);
    expect(budgetToolResultOutput('short')).toBe('short');
  });
});
