// BLAXIN Context Budget
// =============================================================
// Guards how much text is stored in conversation history and replayed
// to the model. Unbounded tool outputs (terminal dumps, file reads)
// previously grew history without limit — bloating the state file and
// every subsequent model request payload. Truncation keeps the head and
// the tail (both are usually what matters) and marks the cut clearly.
// =============================================================

import { MessageImage } from '../types.js';

export const TOOL_RESULT_HISTORY_CAP = 12000; // chars per stored tool result
export const ASSISTANT_MESSAGE_CAP = 16000;   // chars per stored assistant message
export const MAX_HISTORY_MESSAGES = 30;       // messages replayed to the model
export const MAX_PERSISTED_MESSAGES = 100;    // messages kept in the session file

// Image budget for vision-carrying tool results (verified screenshots).
// A full-HD PNG screenshot is ~1–8 MB raw → ~1.4–11 MB base64; models
// accept up to ~20 MB of image payload per request, but BLAXIN bounds
// it far below that: ONE image per tool result, at most 4 MB base64.
export const MAX_IMAGES_PER_TOOL_RESULT = 1;   // images carried per tool result
export const MAX_IMAGE_BASE64_CHARS = 4_000_000; // ~4 MB base64 ≈ 3 MB PNG

/**
 * Extract a bounded image payload from a tool result's data field, for
 * verified screenshot tools. Returns at most MAX_IMAGES_PER_TOOL_RESULT
 * images, each hard-capped at MAX_IMAGE_BASE64_CHARS — an oversized or
 * malformed image is DROPPED (honest no-image beats a truncated corrupt
 * image). The text output still flows as before.
 */
export function budgetToolResultImages(data: unknown): MessageImage[] {
  const out: MessageImage[] = [];
  if (!data || typeof data !== 'object') return out;
  const record = data as Record<string, unknown>;
  const base64 = record.base64;
  if (typeof base64 !== 'string' || base64.length === 0) return out;
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType : '';
  if (!mimeType.startsWith('image/')) return out;
  if (base64.length > MAX_IMAGE_BASE64_CHARS) return out;
  out.push({ mimeType, base64 });
  return out;
}

/**
 * Strip images from messages before persistence: the session file stays
 * text-only and bounded. Images are an in-memory replay concern only.
 */
export function stripImages<T>(messages: T[]): T[] {
  if (messages.length === 0) return messages;
  const hasImages = messages.some(
    (m) => typeof m === 'object' && m !== null && (m as Record<string, unknown>).images !== undefined
  );
  if (!hasImages) return messages;
  return messages.map((m) => {
    const record = m as Record<string, unknown>;
    if (record.images === undefined) return m;
    const rest = { ...record };
    delete rest.images;
    return rest as T;
  });
}

/**
 * Bound `text` to at most `maxChars`, keeping the head and the tail so
 * truncation never hides either the beginning of the output or the end
 * (exit codes / final lines). Returns the original string when it fits.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';
  if (maxChars < 40) return text.slice(0, maxChars);

  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  const omitted = text.length - headChars - tailChars;
  return (
    text.slice(0, headChars) +
    `\n… [truncated ${omitted} chars] …\n` +
    text.slice(text.length - tailChars)
  );
}

/**
 * Bound a tool result before it enters conversation history. The full
 * result is still delivered to events/UI; only the persisted/replayed
 * copy is capped, so the context window and state file stay bounded.
 */
export function budgetToolResultOutput(output: string): string {
  return truncateText(output, TOOL_RESULT_HISTORY_CAP);
}

/** Bound a model/agent message body before persisting it. */
export function budgetAssistantMessage(content: string): string {
  return truncateText(content, ASSISTANT_MESSAGE_CAP);
}
