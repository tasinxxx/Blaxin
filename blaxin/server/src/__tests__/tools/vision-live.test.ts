// LIVE vision verification (env-gated: BLAXIN_LIVE_DESKTOP=1)
// =============================================================
// The full vision chain against the REAL display:
//   real screenshot tool → verified PNG pixels → budgetToolResultImages
//   → toOpenAICompatibleMessages → a real image_url data URL part.
// No LLM needed (no provider key here): the MODEL-FACING payload is the
// contract under test, and it is built from REAL captured pixels.
// Run:  BLAXIN_LIVE_DESKTOP=1 npx vitest run src/__tests__/tools/vision-live.test.ts
// =============================================================

import { describe, it, expect } from 'vitest';
import { ScreenshotTool } from '../../tools/screenshot.js';
import { budgetToolResultImages } from '../../utils/context-budget.js';
import { toOpenAICompatibleMessages, toAnthropicMessages } from '../../providers/messages.js';
import { ChatMessage } from '../../types.js';

const FLAG = !!process.env.BLAXIN_LIVE_DESKTOP;
const d = FLAG && process.env.DISPLAY ? it : it.skip;

function toolResultMessage(data: Record<string, unknown>): ChatMessage {
  return {
    id: 'm_live_1',
    role: 'tool',
    content: 'Tool result (screenshot): Screenshot captured successfully.',
    timestamp: Date.now(),
    toolCallId: 'call_live_1',
    name: 'screenshot',
    images: budgetToolResultImages(data),
  };
}

describe('LIVE vision chain on the real display', () => {
  d('captures REAL pixels and carries them into the model-facing payload', async () => {
    const tool = new ScreenshotTool();
    const result = await tool.execute({});

    // The screenshot itself must be honestly verified.
    expect(result.success).toBe(true);
    expect(result.data?.screenshotAvailable).toBe(true);
    expect(typeof result.data?.base64).toBe('string');

    // Budget step: the REAL base64 passes the size/mime bounds intact.
    const images = budgetToolResultImages(result.data);
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe('image/png');
    expect(images[0].base64).toBe(result.data?.base64);

    // OpenAI-compatible mapping: a real image_url data URL part.
    const openai = toOpenAICompatibleMessages([toolResultMessage(result.data!)]);
    const userTurn = openai.find((m) => m.role === 'user');
    expect(userTurn).toBeDefined();
    const imgPart = userTurn!.content.find((p: any) => p.type === 'image_url');
    expect(imgPart.image_url.url).toBe(`data:image/png;base64,${result.data!.base64}`);
    expect(imgPart.image_url.url.length).toBeGreaterThan(1000); // real pixels, not a stub

    // Anthropic mapping: a real base64 image source block.
    const { messages } = toAnthropicMessages([toolResultMessage(result.data!)]);
    const blocks = messages[0].content as Array<Record<string, unknown>>;
    const imgBlock = blocks.find((b) => b.type === 'image') as any;
    expect(imgBlock.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: result.data!.base64,
    });

    // The PNG signature is real (the payload is a genuine image).
    const b64 = result.data!.base64 as string;
    const prefix = Buffer.from(b64, 'base64').subarray(0, 8).toString('hex');
    expect(prefix).toBe('89504e470d0a1a0a'); // PNG magic
  }, 30000);
});
