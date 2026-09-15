// Provider message mapping
// =============================================================
// Different provider families represent tool calls and tool results
// differently in the conversation payload:
//
//   OpenAI-compatible (OpenAI, OpenRouter, Groq, Together)
//     assistant messages carry `tool_calls[]`; each result is a separate
//     `tool` message whose `tool_call_id` must match a preceding call.
//
//   Anthropic
//     assistant content is a block array with `tool_use` blocks; results
//     are `tool_result` blocks inside a following `user` message.
//
//   Google Gemini
//     assistant parts carry `functionCall`; results are `functionResponse`
//     parts inside a following `user` message.
//
//   Ollama (OpenAI-like)
//     assistant messages carry `tool_calls` (without the outer `type`),
//     results are `tool` role messages.
//
// The orchestrator stores a single uniform history (assistant messages
// may carry their tool calls; tool results are `tool` role messages with
// a matching `toolCallId`). These helpers translate that uniform history
// into each family's wire format.
// =============================================================

import { ChatMessage, ToolCall } from '../types.js';

/**
 * Vision mapping note (per family):
 *
 *   OpenAI-compatible: a `tool` message must be plain text, so a tool
 *     result carrying images becomes a `user` message with content parts
 *     (text + image_url data URLs) — the format the Chat Completions API
 *     expects for images following a tool call.
 *   Anthropic: tool_result blocks accept content arrays; images ride as
 *     `image` source blocks alongside the text.
 *   Gemini: functionResponse parts cannot carry binary data; the image
 *     rides as a sibling `inlineData` part in the same user turn.
 *   Ollama: messages accept a native `images` string array (base64).
 */

/** OpenAI-compatible wire messages. */
export function toOpenAICompatibleMessages(messages: ChatMessage[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      if (m.images && m.images.length > 0) {
        // Tool messages must be text-only, so images travel as a user
        // turn with content parts (the API-recognized image carrier).
        out.push({
          role: 'tool',
          tool_call_id: m.toolCallId || `call_${m.id}`,
          content: m.content || '',
        });
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: `[image attached from ${m.name || 'tool'} result]` },
            ...m.images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
            })),
          ],
        });
        continue;
      }
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId || `call_${m.id}`,
        content: m.content || '',
      });
      continue;
    }
    const base: any = { role: m.role, content: m.content };
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      base.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments || '{}',
        },
      }));
    }
    out.push(base);
  }
  return out;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

/** Split the system prompt from the message list for Anthropic. */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const system = systemMsgs.map((m) => m.content).join('\n\n') || undefined;

  const out: AnthropicMessage[] = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    out.push({
      role: 'user',
      content: pendingToolResults,
    });
    pendingToolResults = [];
  };

  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      const resultContent: Array<Record<string, unknown>> = [
        { type: 'tool_result', tool_use_id: m.toolCallId || `call_${m.id}`, content: m.content || '' },
      ];
      for (const img of m.images || []) {
        resultContent.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
        });
      }
      pendingToolResults.push(...resultContent);
      continue;
    }

    // A new user/assistant turn flushes any pending tool results.
    flushToolResults();

    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }

    if (m.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.content && m.content.trim()) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const tc of m.toolCalls || []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parseToolArguments(tc),
        });
      }
      out.push({
        role: 'assistant',
        content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }],
      });
    }
  }

  // Tool results may be the last entries in the history.
  flushToolResults();

  return { system, messages: out };
}

/** Google Gemini `contents` array plus a separate system instruction. */
export function toGeminiMessages(messages: ChatMessage[]): {
  systemInstruction?: string;
  contents: any[];
} {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const systemInstruction = systemMsgs.map((m) => m.content).join('\n\n') || undefined;

  const contents: any[] = [];
  let pendingUserParts: any[] = [];

  const flushUserParts = () => {
    if (pendingUserParts.length === 0) return;
    contents.push({ role: 'user', parts: pendingUserParts });
    pendingUserParts = [];
  };

  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      pendingUserParts.push({
        functionResponse: {
          name: m.name || 'tool',
          response: { result: m.content || '' },
        },
      });
      for (const img of m.images || []) {
        pendingUserParts.push({
          inlineData: { mimeType: img.mimeType, data: img.base64 },
        });
      }
      continue;
    }

    if (m.role === 'user') {
      flushUserParts();
      contents.push({ role: 'user', parts: [{ text: m.content }] });
      continue;
    }

    if (m.role === 'assistant') {
      flushUserParts();
      const parts: any[] = [];
      if (m.content && m.content.trim()) {
        parts.push({ text: m.content });
      }
      for (const tc of m.toolCalls || []) {
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: parseToolArguments(tc),
          },
        });
      }
      contents.push({
        role: 'model',
        parts: parts.length > 0 ? parts : [{ text: '' }],
      });
    }
  }

  flushUserParts();

  return { systemInstruction, contents };
}

/** Ollama messages (OpenAI-like, tool_calls without outer `type`). */
export function toOllamaMessages(messages: ChatMessage[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const entry: any = {
        role: 'tool',
        tool_call_id: m.toolCallId || `call_${m.id}`,
        content: m.content || '',
      };
      if (m.images && m.images.length > 0) {
        entry.images = m.images.map((img) => img.base64);
      }
      out.push(entry);
      continue;
    }
    const base: any = { role: m.role, content: m.content };
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      base.tool_calls = m.toolCalls.map((tc) => ({
        function: {
          name: tc.function.name,
          arguments: parseToolArguments(tc),
        },
      }));
    }
    out.push(base);
  }
  return out;
}

function parseToolArguments(tc: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tc.function.arguments || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
