// Shared fakes for orchestrator tests + the benchmark harness.
// =============================================================
// The orchestrator was refactored to accept narrow structural
// dependencies, so tests can drive the full agent loop with a scripted
// "brain" (no network) and stub tools (no real side effects). This is
// what makes the before/after benchmark possible offline.

import { v4 as uuidv4 } from 'uuid';
import {
  AIResponse, AppConfig, ChatMessage, ModelInfo, ProviderId, Tool,
  ToolCall, ToolDefinition, ToolResult,
} from '../../types.js';
import { MemoryEntry } from '../../utils/memory.js';
import { AIProvider } from '../../providers/base.js';
import { ToolRegistryLike, SessionStateLike, MemoryStoreLike, ProviderRegistryLike } from '../../orchestrator/index.js';

export interface ScriptedTurn {
  content?: string;
  toolCalls?: ToolCall[];
}

export function makeToolCall(name: string, args: Record<string, unknown>, index = 0): ToolCall {
  return {
    id: `call_${Date.now()}_${index}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

export function makeConfig(overrides: Partial<AppConfig['agent']> = {}): AppConfig {
  return {
    server: { port: 3001, host: '127.0.0.1' },
    agent: {
      maxSteps: 10,
      maxRetries: 2,
      requireConfirmation: true,
      enableFastPath: true,
      enableParallelTools: true,
      confirmationPatterns: ['delete', 'rm ', 'sudo', 'chmod'],
      ...overrides,
    },
    tools: {},
    appearance: { theme: 'dark', accentColor: '#00f0ff' },
  };
}

export class FakeProvider extends AIProvider {
  readonly id: ProviderId = 'custom';
  readonly name = 'Fake Provider';
  readonly baseUrl = 'http://fake.local';
  readonly apiKeyRequired = false;

  script: ScriptedTurn[] = [];
  calls = 0;
  latencyMs = 0;
  /** Messages from the most recent chat() call (for prompt assertions). */
  lastMessages: ChatMessage[] = [];

  constructor(latencyMs = 0) {
    super();
    this.latencyMs = latencyMs;
    // The real credential store is bypassed for fakes.
    (this as unknown as { apiKey: string | null }).apiKey = 'fake-key';
  }

  async fetchModels(): Promise<ModelInfo[]> {
    return [{
      id: 'fake-model',
      name: 'fake-model',
      provider: 'custom',
      isFree: true,
      isAvailable: true,
      capabilities: ['chat', 'function-calling'],
    }];
  }

  async chat(request: {
    messages: ChatMessage[];
    model: string;
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<AIResponse> {
    this.calls++;
    this.lastMessages = request.messages;
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs));
    }
    const turn = this.script.shift();
    if (!turn) {
      // Default: polite completion so loops always terminate.
      return {
        message: { id: uuidv4(), role: 'assistant', content: 'Done.', timestamp: Date.now() },
        model: request.model,
        provider: this.id,
      };
    }
    return {
      message: {
        id: uuidv4(),
        role: 'assistant',
        content: turn.content ?? '',
        timestamp: Date.now(),
      },
      toolCalls: turn.toolCalls,
      model: request.model,
      provider: this.id,
    };
  }
}

export class FakeProviderRegistry implements ProviderRegistryLike {
  private provider: FakeProvider;
  activeProvider: ProviderId = 'custom';
  activeModel = 'fake-model';

  constructor(latencyMs = 0) {
    this.provider = new FakeProvider(latencyMs);
  }

  getActiveProvider(): ProviderId | null { return this.activeProvider; }
  getActiveModel(): string | null { return this.activeModel; }
  getProvider(): AIProvider { return this.provider; }
  getFallbackProvider(): AIProvider | null { return null; }
  getFallbackModel(): string | null { return null; }
}

/** Stub tool with an optional latency and canned behavior. */
export class StubTool implements Tool {
  name: string;
  description: string;
  definition: ToolDefinition;
  executionMode: 'parallel' | 'serial' = 'serial';
  latencyMs = 0;
  output = 'ok';
  fail = false;
  needsConfirmation = false;
  calls = 0;

  constructor(name: string, options: Partial<{
    latencyMs: number;
    output: string;
    fail: boolean;
    needsConfirmation: boolean;
    executionMode: 'parallel' | 'serial';
  }> = {}) {
    this.name = name;
    this.description = `Stub ${name}`;
    this.definition = {
      type: 'function',
      function: {
        name,
        description: this.description,
        parameters: { type: 'object', properties: {}, required: [] },
      },
    };
    Object.assign(this, options);
  }

  requiresConfirmation(_args?: Record<string, unknown>): boolean {
    return this.needsConfirmation;
  }

  async execute(_args?: Record<string, unknown>): Promise<ToolResult> {
    this.calls++;
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs));
    }
    if (this.fail) {
      return { success: false, output: '', error: 'stub failure' };
    }
    return { success: true, output: this.output, data: {} };
  }
}

export class FakeToolRegistry implements ToolRegistryLike {
  /** Any Tool-shaped fake may register (tests use specialized stubs). */
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { success: false, output: '', error: `Unknown tool: ${name}` };
    return tool.execute(args);
  }

  requiresConfirmation(name: string, args: Record<string, unknown>): boolean {
    const tool = this.tools.get(name);
    if (!tool?.requiresConfirmation) return false;
    return tool.requiresConfirmation(args);
  }

  getExecutionMode(name: string): 'parallel' | 'serial' {
    return this.tools.get(name)?.executionMode ?? 'serial';
  }
}

export class FakeSession implements SessionStateLike {
  history: ChatMessage[] = [];
  addMessage(message: ChatMessage): void { this.history.push(message); }
  getHistory(): ChatMessage[] { return [...this.history]; }
  setHistory(history: ChatMessage[]): void { this.history = [...history]; }
  clearHistory(): void { this.history = []; }
}

export class FakeMemory implements MemoryStoreLike {
  entries: Array<{ type: string; content: string; source?: string; scope?: string; lastUsedAt?: number }> = [];
  add(type: string, content: string): unknown {
    this.entries.push({ type, content, lastUsedAt: Date.now() });
    return null;
  }
  search(): MemoryEntry[] {
    return this.entries as unknown as MemoryEntry[];
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build the standard fake environment with a couple of stub tools. */
export function buildFakes(options: {
  providerLatencyMs?: number;
  fastPath?: boolean;
  parallelTools?: boolean;
  requireConfirmation?: boolean;
} = {}) {
  const providers = new FakeProviderRegistry(options.providerLatencyMs ?? 0);
  const tools = new FakeToolRegistry();
  const session = new FakeSession();
  const memory = new FakeMemory();
  const config = makeConfig({
    enableFastPath: options.fastPath ?? true,
    enableParallelTools: options.parallelTools ?? true,
    requireConfirmation: options.requireConfirmation ?? true,
  });

  // Register common stub tools.
  tools.register(new StubTool('screenshot', { executionMode: 'serial' }));
  tools.register(new StubTool('filesystem', { executionMode: 'parallel' }));
  tools.register(new StubTool('system-info', { executionMode: 'parallel' }));
  tools.register(new StubTool('clipboard', { executionMode: 'serial' }));
  tools.register(new StubTool('search', { executionMode: 'parallel' }));
  tools.register(new StubTool('computer-control', { needsConfirmation: true, executionMode: 'serial' }));
  const browser = new StubTool('browser', { needsConfirmation: true, executionMode: 'serial' });
  tools.register(browser);

  return { providers, tools, session, memory, config, browser };
}
