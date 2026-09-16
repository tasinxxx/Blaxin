import { AIRequest, AIResponse, ModelInfo } from '../types.js';
import { AIProvider, parseToolCalls } from './base.js';
import { toOllamaMessages } from './messages.js';
import { logger } from '../utils/logger.js';
import http from 'node:http';
import https from 'node:https';

// ── Ollama capability probing (10× — adaptive model routing) ────
//
// Ollama reports each model's REAL capabilities in /api/tags
// ("capabilities": ["completion", "tools", "thinking", …] / "vision")
// and the same field via POST /api/show. We read it — never infer from
// the model NAME, never assume. A model that reports no machine-readable
// capability data is classified UNKNOWN (reported as chat-only with
// unknownVision), which the model router treats as "not proven": it can
// serve chat, but it is never claimed vision-capable.

/** Real capability labels Ollama reports. */
type OllamaCapability = 'completion' | 'tools' | 'thinking' | 'vision' | 'embedding';

interface OllamaTagsModel {
  name: string;
  size: number;
  modified_at: string;
  details?: {
    family?: string;
    families?: string[] | null;
    parameter_size?: string;
    quantization_level?: string;
    context_length?: number;
  };
  /** Present on recent Ollama: the model's real capability labels. */
  capabilities?: OllamaCapability[];
}

/** Map real Ollama capability labels onto BLAXIN ModelCapability values.
 * Unrecognized/absent data maps to chat only + unknownVision=true. */
export function capabilitiesFromOllama(
  raw: OllamaCapability[] | null | undefined,
  families: string[] | null | undefined,
): { capabilities: ModelInfo['capabilities']; unknownVision: boolean } {
  const caps: ModelInfo['capabilities'] = ['chat'];
  const list = Array.isArray(raw) ? raw : [];
  if (list.includes('tools')) caps.push('function-calling');
  if (list.includes('vision')) caps.push('vision');
  if (list.includes('thinking')) caps.push('reasoning');
  // Honest unknown: no capability data at all reported by this Ollama
  // version (older daemons). Family hints are NOT trusted as capability
  // proof (a llama-family projector model vs a plain llama chat model
  // differ only in real capability data) — vision stays unknown.
  const unknownVision = !list.includes('vision') && !Array.isArray(raw);
  void families; // read for provenance; never used to fabricate capability
  return { capabilities: caps, unknownVision };
}

/** Convert real /api/tags capability data into ModelInfo capabilities. */
export function capabilitiesFromTagsModel(m: OllamaTagsModel): { capabilities: ModelInfo['capabilities']; unknownVision: boolean } {
  if (Array.isArray(m.capabilities)) {
    return capabilitiesFromOllama(m.capabilities, m.details?.families);
  }
  // Older daemon without the capabilities field: fall back to POST
  // /api/show probing by the caller (fetchModels does this); here we
  // report the honest unknown.
  return { capabilities: ['chat'] as ModelInfo['capabilities'], unknownVision: true };
}

/** Per-model cached capability probe (bounded; entries expire by mtime). */
interface CapabilityProbe {
  capabilities: OllamaCapability[] | null;
  probedAt: number;
}
const CAPABILITY_PROBE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CAPABILITY_PROBE_MAX = 64;

export class OllamaProvider extends AIProvider {
  readonly id = 'ollama' as const;
  readonly name = 'Ollama (Local)';
  /** Overridable so a cloud deployment can point the provider at its
   * tunneled loopback endpoint (set via setEndpoint). Loopback-only:
   * non-loopback overrides are rejected (see setEndpoint). */
  private endpointOverride: string | null = null;
  readonly apiKeyRequired = false;

  get baseUrl(): string {
    return this.endpointOverride ?? 'http://localhost:11434';
  }

  /** Point this provider at a specific loopback endpoint (the reverse
   * SSH tunnel from a cloud deployment, or the local daemon). Only
   * loopback endpoints are accepted. Returns false on rejection. */
  setEndpoint(endpoint: string): boolean {
    try {
      const u = new URL(endpoint);
      const h = u.hostname;
      if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1' && h !== '[::1]') {
        logger.warn('ollama', 'Rejected non-loopback endpoint override');
        return false;
      }
      this.endpointOverride = `${u.protocol}//127.0.0.1:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
      return true;
    } catch {
      return false;
    }
  }

  clearEndpoint(): void {
    this.endpointOverride = null;
  }

  hasEndpointOverride(): boolean {
    return this.endpointOverride !== null;
  }

  async initialize(): Promise<void> {
    // Ollama doesn't need an API key
    logger.info('ollama', 'Ollama provider initialized (local)');
  }

  async validateKey(_apiKey?: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (response.ok) return { valid: true };
      return { valid: false, error: 'Ollama is not running. Start it with: ollama serve' };
    } catch {
      return { valid: false, error: 'Ollama is not running on localhost:11434. Start it with: ollama serve' };
    }
  }

  /** Bounded per-model capability probe cache (model name → probe). */
  private capabilityProbes = new Map<string, CapabilityProbe>();

  /** Clear the capability probe cache (tests; capability refresh). */
  clearCapabilityCache(): void {
    this.capabilityProbes.clear();
  }

  /**
   * Ask the daemon what THIS model can really do (POST /api/show).
   * Cached per model for CAPABILITY_PROBE_TTL_MS (bounded); a failed
   * probe is cached as null (unknown) so routing stays honest instead
   * of optimistic. Returns null when the probe fails.
   */
  private async probeCapabilities(name: string, modifiedAt: string): Promise<OllamaCapability[] | null> {
    const cached = this.capabilityProbes.get(name);
    const fresh = cached && (Date.now() - cached.probedAt) < CAPABILITY_PROBE_TTL_MS;
    if (cached && fresh) return cached.capabilities;
    try {
      const response = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
      });
      const caps = response.ok
        ? ((await response.json()) as { capabilities?: OllamaCapability[] }).capabilities ?? null
        : null;
      this.capabilityProbes.set(name, { capabilities: caps, probedAt: Date.now() });
      // Bounded cache: evict the oldest entry over the cap.
      if (this.capabilityProbes.size > CAPABILITY_PROBE_MAX) {
        const oldest = this.capabilityProbes.keys().next().value as string | undefined;
        if (oldest) this.capabilityProbes.delete(oldest);
      }
      return caps;
    } catch {
      this.capabilityProbes.set(name, { capabilities: null, probedAt: Date.now() });
      return null;
    }
  }

  async fetchModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) throw new Error('Ollama not running');

      const data = await response.json() as { models: OllamaTagsModel[] };

      const models: ModelInfo[] = [];
      for (const m of data.models || []) {
        // Real capability data straight from the daemon when present;
        // otherwise one bounded /api/show probe (older daemons only).
        const raw = Array.isArray(m.capabilities)
          ? m.capabilities
          : await this.probeCapabilities(m.name, m.modified_at);
        const { capabilities } = capabilitiesFromOllama(raw, m.details?.families);
        models.push({
          id: m.name,
          name: m.name,
          provider: 'ollama' as const,
          isFree: true,
          isAvailable: true,
          capabilities,
          // Real reported context length when the daemon provides it.
          ...(m.details?.context_length ? { contextWindow: m.details.context_length } : {}),
        });
      }
      return models;
    } catch (error: any) {
      logger.warn('ollama', 'Failed to fetch models - is Ollama running?');
      return [];
    }
  }

  /**
   * REAL chat call. Uses node:http directly, NOT the global fetch:
   * undici (Node's fetch) kills any request whose RESPONSE HEADERS have
   * not arrived within 300 s (headersTimeout default). A non-streaming
   * Ollama /api/chat delivers headers only when generation COMPLETES —
   * so a cold qwen3:4b / 8b inference on 8 GB CPU-only hardware (3–10
   * minutes is NORMAL for this machine) was being killed at exactly
   * 300 s and misreported as NETWORK_ERROR. Local inference latency is
   * machine reality, not a network failure; it must not be capped by a
   * library default. Timeout is generous and configurable.
   */
  private requestTimeoutMs(): number {
    const raw = Number(process.env.BLAXIN_OLLAMA_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000; // 15 min
  }

  private ollamaPost(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: any; text: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const mod = url.protocol === 'https:' ? https : http;
      const payload = JSON.stringify(body);
      const req = mod.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          // Kill undici-style header/body caps entirely: the ONLY limit
          // is our own explicit timeout below.
          timeout: 0,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            let json: any = null;
            try { json = JSON.parse(text); } catch { json = null; }
            resolve({ status: res.statusCode ?? 0, json, text });
          });
        },
      );
      // The honest timeout: real local inference takes what it takes.
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Ollama inference timed out after ${Math.round(timeoutMs / 1000)}s (BLAXIN_OLLAMA_TIMEOUT_MS can raise it)`));
      });
      req.on('error', (e) => reject(e));
      req.write(payload);
      req.end();
    });
  }

  async chat(request: AIRequest): Promise<AIResponse> {
    const body: any = {
      model: request.model,
      messages: toOllamaMessages(request.messages),
      stream: false,
      options: {
        num_predict: request.maxTokens || 4096,
      },
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(t => ({
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      }));
    }

    try {
      const response = await this.ollamaPost('/api/chat', body, this.requestTimeoutMs());

      if (response.status < 200 || response.status >= 300) {
        const msg = response.json?.error || `HTTP ${response.status}`;
        throw new Error(msg);
      }

      const data = response.json;
      if (!data || !data.message) {
        throw new Error('Ollama returned an empty or malformed response');
      }

      let content = data.message?.content || '';
      const toolCalls = parseToolCalls(content, data.message?.tool_calls);

      return {
        message: {
          id: `msg_${Date.now()}`,
          role: 'assistant',
          content,
          timestamp: Date.now(),
        },
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: data.prompt_eval_count ? {
          promptTokens: data.prompt_eval_count,
          completionTokens: data.eval_count || 0,
          totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
        } : undefined,
        model: request.model,
        provider: 'ollama',
      };
    } catch (error: any) {
      this.handleError(error, 'chat completion');
    }
  }
}
