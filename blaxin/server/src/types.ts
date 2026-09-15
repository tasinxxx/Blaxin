// BLAXIN Core Types
// =============================================

// AI Provider Types
export type ProviderId = 'openrouter' | 'openai' | 'anthropic' | 'google' | 'groq' | 'together' | 'ollama' | 'custom';

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  baseUrl: string;
  apiKeyRequired: boolean;
  apiKeyPrefix?: string;
  description: string;
  icon?: string;
}

export interface ProviderCredentials {
  providerId: ProviderId;
  apiKey: string;
  baseUrl?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderId;
  pricing?: {
    prompt: number;
    completion: number;
  };
  isFree: boolean;
  isAvailable: boolean;
  capabilities: ModelCapability[];
  contextWindow?: number;
  maxOutput?: number;
  description?: string;
}

export type ModelCapability =
  | 'chat'
  | 'completion'
  | 'vision'
  | 'function-calling'
  | 'code-generation'
  | 'reasoning'
  | 'multimodal';

// AI Request/Response Types
/**
 * An image attached to a message — e.g. a verified screenshot carried on
 * a tool result so a vision-capable model can SEE what the tool saw.
 * Always base64 + an explicit mime type; bounded by context-budget.
 */
export interface MessageImage {
  mimeType: string;
  base64: string;
}

export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  toolCallId?: string;
  name?: string;
  /**
   * Images carried on TOOL results (verified screenshots). Ephemeral:
   * replayed to the model for the current session, never persisted to
   * the session file (session-state strips them) — the state file and
   * replay window stay bounded.
   */
  images?: MessageImage[];
  /**
   * Tool calls produced by the assistant for this message.
   * Replayed to the provider so that tool results can be matched to
   * their originating tool calls (required by OpenAI-compatible APIs,
   * Anthropic tool_use blocks, and Gemini functionCall parts).
   */
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AIRequest {
  messages: ChatMessage[];
  model: string;
  provider: ProviderId;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface AIResponse {
  message: ChatMessage;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  provider: ProviderId;
}

// Tool Types
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  data?: Record<string, unknown>;
}

// Agent Types
// ── Risk + permission model ────────────────────────────────────
// Risk tiers classify how dangerous an action is; permission scopes
// describe how that step was (or must be) authorized. The Brain proposes,
// the Body validates — these fields make the decision visible at every
// step of a task instead of hiding it in a binary confirm/no-confirm.
export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type PermissionScope =
  | 'ALWAYS_ALLOW'   // safe by policy — runs without asking
  | 'ALLOW_ONCE'     // user approved this single action
  | 'ALLOW_TASK'     // approved for the remainder of this task
  | 'ALLOW_SESSION'  // approved for this session
  | 'DENY';          // denied by the user (never executed)

/** Scope chosen by the user when approving a confirmation request. */
export type GrantScope = 'once' | 'task' | 'session';

export type AgentState = 
  | 'idle'
  | 'thinking'
  | 'planning'
  | 'executing'
  | 'observing'
  | 'waiting'
  | 'completed'
  | 'error'
  | 'requires-confirmation';

export interface AgentTask {
  id: string;
  instruction: string;
  state: AgentState;
  steps: TaskStep[];
  currentStep: number;
  startTime: number;
  endTime?: number;
  result?: string;
  error?: string;
  /** Rendered Jarvis directive context attached to this run (real, from the directive). */
  directiveContext?: string;
  /** Skill runtime selections for THIS objective (real, from the registry; §14). */
  skillsSelected?: Array<{ id: string; name: string; score: number; reason: string }>;
}

export interface TaskStep {
  id: string;
  description: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  state: 'pending' | 'executing' | 'completed' | 'failed' | 'skipped' | 'retrying';
  result?: string;
  error?: string;
  /** Declared danger of this action (LOW/MEDIUM/HIGH/CRITICAL). */
  riskTier?: RiskTier;
  /** How this step was authorized (ALWAYS_ALLOW / ALLOW_ONCE / DENY). */
  permissionScope?: PermissionScope;
}

// WebSocket Event Types
export type WSEvent =
  | { type: 'user-message'; data: { content: string } }
  | { type: 'agent-message'; data: ChatMessage }
  | { type: 'agent-state'; data: { state: AgentState; description?: string } }
  | { type: 'tool-execution'; data: { toolName: string; args: Record<string, unknown>; state: string } }
  | { type: 'task-progress'; data: AgentTask }
  | { type: 'error'; data: { message: string; code?: string; details?: string } }
  | { type: 'models-list'; data: ModelInfo[] }
  | { type: 'provider-status'; data: { providerId: ProviderId; connected: boolean; error?: string } }
  | { type: 'confirmation-required'; data: { taskId: string; stepId: string; description: string; action: string } }
  | { type: 'health-check'; data: { status: string; uptime: number } };

// Configuration Types
export interface AppConfig {
  server: {
    port: number;
    host: string;
  };
  agent: {
    maxSteps: number;
    maxRetries: number;
    requireConfirmation: boolean;
    confirmationPatterns: string[];
    /** Run unambiguous safe tool requests through the deterministic fast path (no LLM round trip). */
    enableFastPath: boolean;
    /** Execute independent tool calls from one model response concurrently. */
    enableParallelTools: boolean;
    /**
     * Specialist bounded-objective budgets (§6). Optional for backward
     * compatibility with pre-existing config files; loadConfig() back-fills
     * the code defaults so getConfig() consumers always see values.
     */
    specialist?: {
      maxActions: number;
      maxRecoveries: number;
      maxReplans: number;
      deadlineMs: number;
    };
    /**
     * Deterministic recovery budgets (§ recovery ladder). Optional; loaded
     * defaults back-fill. NOTE: agent.recovery.maxReplansPerTask is the
     * authoritative per-task re-plan budget (it overrides the specialist's
     * own at assignment, mirroring the recovery ladder's contract).
     */
    recovery?: {
      maxRecoveryAttempts: number;
      maxReplansPerTask: number;
      baseBackoffMs: number;
      maxBackoffMs: number;
    };
  };
  tools: Record<string, boolean>;
  appearance: {
    theme: 'dark' | 'cyberpunk';
    accentColor: string;
  };
}

// Tool Interface
export interface Tool {
  name: string;
  description: string;
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
  requiresConfirmation?(args: Record<string, unknown>): boolean;
  /**
   * Whether the tool may run concurrently with other tools from the same
   * model response. Tools that touch a shared mutable resource (the X
   * display, the clipboard, the browser) must stay 'serial'. Defaults to
   * 'serial' so parallel safety is always an explicit opt-in.
   */
  executionMode?: 'parallel' | 'serial';
}
