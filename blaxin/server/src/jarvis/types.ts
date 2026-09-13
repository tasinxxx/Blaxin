// BLAXIN Jarvis Layer — Contract Types
// =============================================================
// JARVIS is the user-facing executive layer: it receives commands
// (text or voice), maintains conversation continuity, decides how a
// request should be executed, hands the EXISTING BLAXIN agent a
// structured directive, and reports the honest outcome back.
//
// Jarvis is NOT a replacement for the agent and NOT a UI theme. The
// orchestrator remains the core reasoning/execution engine; Jarvis
// adds the structured contract between the user and that engine.
//
// Design rules enforced here:
//   - Every field is derived from REAL inputs (the user's message,
//     real orchestrator events). No invented confidence, no fake
//     progress. `confidence` only exists where it can be computed.
//   - The directive is plain data — model-agnostic, framework-free.
// =============================================================

/** How the command reached Jarvis. */
export type CommandSource = 'text' | 'voice';

/**
 * Execution route chosen for a directive.
 *   fast     — unambiguous single-tool request; deterministic path, no model call
 *   standard — normal agent loop (LLM reasoning + tools)
 *   mission  — multi-step/long-horizon work; executed as a persistent mission
 */
export type ExecutionComplexity = 'fast' | 'standard' | 'mission';

/** Why Jarvis picked a route (kept honest and human-readable). */
export type RoutingReason =
  | 'deterministic-single-tool'
  | 'multi-step-request'
  | 'explicit-mission-request'
  | 'follow-up-context'
  | 'default-agent-loop';

/** Structured goal handed from Jarvis to the agent (directive §7). */
export interface JarvisDirective {
  id: string;
  /** The user's goal, in their own words (never rewritten by Jarvis). */
  goal: string;
  /** Conversation/project context relevant to this execution. */
  context: {
    /** Bounded summary of the immediately preceding exchange. */
    previousExchange?: { request: string; outcome: string } | null;
    /** Mission this directive belongs to, when continuation of one. */
    missionId?: string;
    missionObjective?: string;
    /** Real step count when routing chose a mission plan (0 = agent decomposes). */
    plannedSteps?: number;
  };
  /** Explicit constraints (empty — the agent's own policy still applies). */
  constraints: string[];
  /** What counts as done, when it can be stated concretely. */
  successCondition?: string;
  /** 1..5 — mirrors queue priority semantics. */
  priority: number;
  complexity: ExecutionComplexity;
  reason: RoutingReason;
  source: CommandSource;
  issuedAt: number;
}

/** Terminal status of an agent execution, from REAL events only. */
export type AgentReportStatus =
  | 'SUCCESS'      // agent reached completed with no failed steps
  | 'PARTIAL'      // finished, but some steps failed or were skipped
  | 'FAILED'       // agent reported error state
  | 'STOPPED'      // user stopped the run (idle state)
  | 'NOT_EXECUTED';// never started (queue full, rejected, etc.)

/**
 * Structured result returned from the agent to Jarvis. Composed ONLY
 * from real orchestrator events (agent-state / task-progress /
 * agent-message / task-complete). No fabricated evidence or confidence.
 */
/**
 * Real, per-step outcome from the agent run. `id` is the runtime's own
 * stable step identity (orchestrator TaskStep.id / mission step id) —
 * never generated for display.
 */
export interface ReportStep {
  id: string;
  description: string;
  state: string;
  result?: string;
  error?: string;
}

export interface AgentReport {
  directiveId: string;
  taskId?: string;
  status: AgentReportStatus;
  /** Real, per-step outcomes (bounded). */
  evidence: ReportStep[];
  /** Real final assistant reply text, when one was produced. */
  summary?: string;
  /** Real timing from the task-complete event. */
  metrics?: {
    totalMs: number;
    modelCalls: number;
    toolCalls: number;
    kind: string;
    /** Honest route (§6): DETERMINISTIC / AI_BRAIN / HYBRID. */
    executionMode?: 'DETERMINISTIC' | 'AI_BRAIN' | 'HYBRID';
  };
  blockers: string[];
  reportedAt: number;
  /**
   * Mission-directive reports only: the mission's REAL checkpoint state
   * (mission-control contract). Present when the terminating evidence
   * comes from a mission store snapshot — never fabricated.
   */
  missionCheckpoint?: {
    missionId: string;
    objective: string;
    completedSteps: number;
    totalSteps: number;
    /** The last REAL checkpoint (completedAt + what was done), if any. */
    lastCheckpoint: { stepDescription: string; completedAt: number; summary: string } | null;
    /** Honest next action for a non-terminal mission (pause/resume paths). */
    nextAction: string;
  };
}

/** Jarvis's own visible phase (drives the HUD; always real). */
export type JarvisPhase =
  | 'idle'
  | 'understanding'
  | 'routing'
  | 'delegated'
  | 'reporting';

/** Snapshot broadcast on connect so the HUD never shows stale state. */
export interface JarvisSnapshot {
  phase: JarvisPhase;
  directive: JarvisDirective | null;
  lastReport: AgentReport | null;
}
