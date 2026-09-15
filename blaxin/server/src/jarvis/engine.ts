// BLAXIN Jarvis Engine
// =============================================================
// The user-facing executive layer. Jarvis receives commands (text or
// voice), maintains exchange continuity, issues a structured directive
// to the EXISTING agent, and composes an honest report from real
// orchestrator events.
//
// Hard rules (directive §46/§72):
//   - Every report field is derived from REAL events. A run is only
//     SUCCESS when the agent genuinely finished cleanly; anything less
//     is reported as PARTIAL/FAILED/STOPPED — never upgraded.
//   - Jarvis never rewrites the user's goal. It classifies routing,
//     attaches context, and reports truthfully.
//   - The agent remains the core engine; Jarvis delegates, never
//     executes tools itself.
// =============================================================

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import type {
  AgentReport,
  AgentReportStatus,
  CommandSource,
  JarvisDirective,
  ReportStep,
  JarvisPhase,
  JarvisSnapshot,
  JarvisSpecialistState,
} from './types.js';
import { defaultAssessIntent, normalizeGoal, type IntentAssessor } from './intent.js';

const MAX_REPORT_STEPS = 30;

/** Real, bounded step evidence (task-progress / mission steps). */
export type { ReportStep } from './types.js';

/**
 * Real agent events Jarvis subscribes to. Structural interface keeps
 * Jarvis decoupled from the orchestrator implementation — tests inject
 * fakes, production wires the orchestrator's event callback.
 */
export interface JarvisEventSource {
  on(listener: (event: string, data: any) => void): void;
}

export interface JarvisDeps {
  /** Real agent events (agent-state / task-progress / agent-message / task-complete). */
  events: JarvisEventSource;
  /**
   * The single execution entry point — the existing agent path
   * (queue→scheduler→orchestrator), or the mission creator for
   * mission-routed directives. Jarvis never executes tools itself.
   * Returns the queue/mission id so the directive can bind to real
   * execution state for reporting.
   */
  executeGoal: (directive: JarvisDirective) => { taskId: string; missionId?: string };
  /** Whether the agent currently has conversation history (follow-ups). */
  hasConversationHistory?: () => boolean;
  /** Optional custom assessor (tests / future model-backed routing). */
  assessor?: IntentAssessor;
}

export interface JarvisCommand {
  message: string;
  source: CommandSource;
  priority?: number;
}

/** What the host receives on every Jarvis state change (for the HUD). */
export type JarvisSnapshotListener = (snapshot: JarvisSnapshot) => void;

export class JarvisEngine {
  private phase: JarvisPhase = 'idle';
  private activeDirective: JarvisDirective | null = null;
  private lastReport: AgentReport | null = null;
  private lastExchange: { request: string; outcome: string } | null = null;
  private readonly events: JarvisEventSource;
  private readonly executeGoal: (directive: JarvisDirective) => { taskId: string; missionId?: string };
  private readonly hasConversationHistory: () => boolean;
  private readonly assess: IntentAssessor;
  private changeListeners: JarvisSnapshotListener[] = [];

  // Per-run collectors (reset after each report).
  private steps: Map<string, ReportStep> = new Map();
  private currentTaskId: string | null = null;
  private finalReply: string | null = null;
  private completionMetrics: AgentReport['metrics'] | null = null;
  /** Set when a terminal agent-state arrived; report composes on task-complete. */
  private pendingTerminalState: string | null = null;
  /** True when a real 'error' event arrived during the current run. */
  private sawError = false;
  /** Real recovery state of the CURRENT run (classification/strategy/budget). */
  private currentRecovery: JarvisSnapshot['recovery'] | null = null;
  /** Real specialist delegation of the CURRENT run (null = none delegated). */
  private currentSpecialist: JarvisSpecialistState | null = null;
  /** Real checkpoint state of a PAUSED mission (mission-control reporting). */
  private lastMissionCheckpoint: AgentReport['missionCheckpoint'] | null = null;
  /** Real aggregated verification of the mission that just terminated. */
  private lastMissionVerification: AgentReport['missionVerification'] | null = null;

  constructor(deps: JarvisDeps) {
    this.events = deps.events;
    this.executeGoal = deps.executeGoal;
    this.hasConversationHistory = deps.hasConversationHistory ?? (() => false);
    this.assess = deps.assessor ?? defaultAssessIntent;

    this.events.on((event, data) => this.onAgentEvent(event, data));
  }

  /** Register a snapshot listener (index.ts broadcasts to the HUD). */
  onChange(cb: JarvisSnapshotListener): void {
    this.changeListeners.push(cb);
  }

  /** Current snapshot (sent on WS connect so the HUD starts honest). */
  snapshot(): JarvisSnapshot {
    return {
      phase: this.phase,
      directive: this.activeDirective,
      lastReport: this.lastReport,
      recovery: this.currentRecovery ?? undefined,
      specialist: this.currentSpecialist ?? undefined,
    };
  }

  private setPhase(phase: JarvisPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emitChange();
  }

  private emitChange(): void {
    const snap = this.snapshot();
    for (const cb of this.changeListeners) {
      try {
        cb(snap);
      } catch (error: any) {
        logger.warn('jarvis', `Snapshot listener failed: ${error.message}`);
      }
    }
  }

  // ── Command intake ────────────────────────────────────────────

  /**
   * Receive a user command, understand it, and issue a structured
   * directive to the agent through the single execution entry point.
   * Execution itself is asynchronous (queue→scheduler→orchestrator).
   */
  receiveCommand(command: JarvisCommand): { directive: JarvisDirective; taskId: string } {
    const goal = normalizeGoal(command.message);
    if (!goal) throw new Error('Empty command');

    this.setPhase('understanding');

    const hasContext = this.hasConversationHistory();
    // A custom assessor may decline (null) — fall back to the
    // deterministic default so routing never has to guess.
    const assessment = this.assess({
      message: goal,
      source: command.source,
      hasConversationContext: hasContext,
      lastExchange: this.lastExchange,
    }) ?? defaultAssessIntent({
      message: goal,
      source: command.source,
      hasConversationContext: hasContext,
      lastExchange: this.lastExchange,
    });

    const directive: JarvisDirective = {
      id: `jd_${uuidv4().slice(0, 8)}`,
      goal,
      context: {
        previousExchange: hasContext ? this.lastExchange : null,
      },
      constraints: [],
      successCondition: assessment.successCondition,
      priority: command.priority ?? assessment.priority,
      complexity: assessment.complexity,
      reason: assessment.reason,
      source: command.source,
      issuedAt: Date.now(),
    };

    this.setPhase('routing');

    const { taskId, missionId } = this.executeGoal(directive);
    // Bind mission-routed directives to their real mission so reports
    // compose from mission-store state (not per-step task events).
    if (missionId) directive.context.missionId = missionId;

    this.activeDirective = directive;
    // Reset per-run collectors for the new run.
    this.steps = new Map();
    this.currentTaskId = null;
    this.finalReply = null;
    this.completionMetrics = null;
    this.pendingTerminalState = null;
    this.sawError = false;
    this.currentRecovery = null;
    this.currentSpecialist = null;

    this.setPhase('delegated');
    logger.info('jarvis', `Routed (${directive.complexity}/${directive.reason}) → task ${taskId}`);
    return { directive, taskId };
  }

  /** Explicit user control (STOP etc.) clears the active directive. */
  clearActive(): void {
    this.activeDirective = null;
    this.pendingTerminalState = null;
    this.sawError = false;
    this.setPhase('idle');
  }

  // ── Real event intake (report composition) ────────────────────

  private onAgentEvent(event: string, data: any): void {
    switch (event) {
      case 'task-progress':
        this.onTaskProgress(data);
        break;
      case 'agent-message':
        this.onAgentMessage(data);
        break;
      case 'error':
        this.sawError = true;
        break;
      case 'task-complete':
        // Arrives after the terminal agent-state and carries the real
        // run metrics — this is the honest "run is over" signal.
        // Mission-routed directives close on mission terminal state
        // instead (each step's task-complete is mid-mission).
        if (data && typeof data === 'object') {
          // The execution route is carried through verbatim when the
          // orchestrator reported one — never inferred here (§6).
          const mode = data.executionMode;
          this.completionMetrics = {
            totalMs: Number(data.totalMs ?? 0),
            modelCalls: Number(data.modelCalls ?? 0),
            toolCalls: Number(data.toolCalls ?? 0),
            kind: String(data.kind ?? 'unknown'),
            executionMode:
              mode === 'DETERMINISTIC' || mode === 'AI_BRAIN' || mode === 'HYBRID'
                ? mode
                : undefined,
          };
        }
        if (!this.isMissionDirective()) {
          this.composeReport(this.terminalFromTaskComplete(data));
        }
        break;
      case 'mission-progress': {
        // Synthetic event fed by the host (mission store changes).
        this.onMissionProgress(data);
        break;
      }
      case 'specialist-assigned':
        this.onSpecialistAssigned(data);
        break;
      case 'specialist-result':
        this.onSpecialistResult(data);
        break;
      default:
        break;
    }

    // ── Real runtime reflection (§5) ─────────────────────────────
    // While a directive of OURS is executing, the agent's ACTUAL state
    // drives the Jarvis phase. Every transition below comes from a real
    // event; nothing is animated independently of the task engine.
    if (this.activeDirective) {
      if (event === 'agent-state') {
        const mapped = this.runtimePhaseFor(String(data?.state ?? ''));
        if (mapped) this.setPhase(mapped);
      } else if (event === 'confirmation-required') {
        // The run is genuinely BLOCKED on user authorization.
        this.setPhase('blocked');
      } else if (event === 'tool-execution' && data?.state === 'retrying') {
        this.setPhase('recovering');
        // Real recovery bookkeeping: classification + strategy + where we
        // are in the explicit budget — never a decorative animation.
        if (data.failureClass || data.replanNumber) {
          this.currentRecovery = {
            failureClass: data.failureClass ? String(data.failureClass) : undefined,
            strategy: data.recoveryStrategy ? String(data.recoveryStrategy) : (data.replanNumber ? 'replan' : undefined),
            attempt: typeof data.recoveryAttempt === 'number' ? data.recoveryAttempt : undefined,
            budget: typeof data.recoveryBudget === 'number'
              ? data.recoveryBudget
              : typeof data.replanBudget === 'number' ? data.replanBudget : undefined,
            replan: data.replanNumber ? {
              number: Number(data.replanNumber),
              budget: Number(data.replanBudget ?? 0),
              planChange: data.replanDescription
                ? `${String(data.oldStrategy ?? 'original plan')} → ${String(data.replanDescription)}`
                : data.replanPlanKey ? String(data.replanPlanKey) : undefined,
            } : undefined,
          };
        }
      } else if (event === 'browser-session') {
        // A real browser desync puts the run into RECOVERING (the session
        // layer then reconnects/reacquires). Recovery is never a success
        // claim — the next real event advances the phase.
        if (data?.event?.type === 'session-desync') this.setPhase('recovering');
      }
    }

    // Terminal agent-state is remembered, not reported on yet. Recovery
    // state clears with the run — the HUD never shows stale recovering.
    if (event === 'agent-state' && data?.state && ['completed', 'error', 'idle'].includes(data.state)) {
      this.pendingTerminalState = data.state;
      this.currentRecovery = null;
    }
  }

  /** Real agent runtime state → Jarvis runtime phase (null = not a phase). */
  private runtimePhaseFor(state: string): JarvisPhase | null {
    switch (state) {
      case 'planning': return 'planning';
      case 'thinking': return 'thinking';
      case 'executing': return 'executing';
      case 'observing': return 'observing';
      case 'waiting': return 'waiting';
      case 'requires-confirmation': return 'blocked';
      default: return null;
    }
  }

  private isMissionDirective(): boolean {
    return this.activeDirective?.context.missionId != null;
  }

  /**
   * Resolve the terminal state for a one-shot task from REAL signals:
   * the last agent-state wins; the task-complete run outcome is the
   * fallback (e.g. 'no-provider' paths that never set a terminal state).
   */
  private terminalFromTaskComplete(data: any): string {
    if (this.pendingTerminalState) return this.pendingTerminalState;
    const outcome = String(data?.outcome || '');
    if (outcome === 'stopped') return 'idle';
    if (outcome === 'completed' || outcome === 'step-limit') return 'completed';
    if (outcome) return 'error';
    // No real signal at all: do not guess — report nothing.
    return '';
  }

  /**
   * Mission directives close on REAL mission-store state: evidence is
   * the mission's own steps/checkpoints, terminal mapping is completed
   * → success path, failed/cancelled → error path. Paused missions
   * never compose a report (the mission genuinely is not over).
   */
  private onMissionProgress(data: any): void {
    const directive = this.activeDirective;
    if (!directive) return;
    const missionId = directive.context.missionId;
    if (!missionId || !Array.isArray(data?.missions)) return;

    const mission = data.missions.find((m: any) => m?.id === missionId);
    if (!mission) return;

    if (mission.status === 'completed') {
      this.ingestMissionEvidence(mission);
      // The checkpoint truth of the TERMINAL snapshot is what the report
      // carries (mission-control contract: state where it stopped).
      this.lastMissionCheckpoint = this.extractCheckpoint(mission);
      // Mission coordination: the REAL aggregated verification travels
      // verbatim. An UNVERIFIED mission caps the report at PARTIAL in
      // composeReport (same honesty rule as an unverified specialist).
      const mv = mission.verification;
      this.lastMissionVerification =
        mv === 'VERIFIED' || mv === 'PARTIAL' || mv === 'UNVERIFIED' ? mv : undefined;
      this.composeReport('completed');
    } else if (mission.status === 'failed' || mission.status === 'cancelled') {
      this.ingestMissionEvidence(mission);
      this.lastMissionCheckpoint = this.extractCheckpoint(mission);
      const mv = mission.verification;
      this.lastMissionVerification =
        mv === 'VERIFIED' || mv === 'PARTIAL' || mv === 'UNVERIFIED' ? mv : undefined;
      this.composeReport('error');
    }
    // 'queued' | 'running' | 'paused': mission continues — no report.
    // But a PAUSE is a real checkpoint boundary: remember the mission's
    // last checkpoint so a later report can state WHERE it stopped and
    // what resuming would continue from (mission-control contract).
    if (mission.status === 'paused') {
      this.lastMissionCheckpoint = this.extractCheckpoint(mission);
    }
  }

  /**
   * REAL checkpoint extraction (mission-control): the last completed
   * step WITH a checkpoint record is where the mission can resume
   * from. Never invented — absent when no checkpoint exists.
   */
  private extractCheckpoint(mission: any): AgentReport['missionCheckpoint'] {
    const steps: any[] = Array.isArray(mission?.steps) ? mission.steps : [];
    const total = steps.length;
    const completed = steps.filter((s) => s?.status === 'completed').length;
    // The LAST checkpointed step in mission order.
    let last: { stepDescription: string; completedAt: number; summary: string } | null = null;
    for (const s of steps) {
      if (s?.status === 'completed' && s?.checkpoint?.completedAt) {
        last = {
          stepDescription: String(s.description ?? '').slice(0, 300),
          completedAt: Number(s.checkpoint.completedAt),
          summary: String(s.checkpoint.summary ?? s.result ?? '').slice(0, 500),
        };
      }
    }
    const pending = total - completed;
    const nextAction = last
      ? `Resume from after "${last.stepDescription}" — ${pending} step(s) pending`
      : total > 0
        ? `No checkpointed steps yet — ${pending} step(s) pending`
        : 'No steps defined';
    return {
      missionId: String(mission?.id ?? ''),
      objective: String(mission?.objective ?? '').slice(0, 500),
      completedSteps: completed,
      totalSteps: total,
      lastCheckpoint: last,
      nextAction,
    };
  }

  /** Copy real mission steps into the evidence collectors. */
  private ingestMissionEvidence(mission: any): void {
    if (Array.isArray(mission?.steps)) {
      for (const step of mission.steps) {
        if (step?.id && step?.description) {
          this.steps.set(String(step.id), {
            id: String(step.id),
            description: String(step.description).slice(0, 300),
            state: String(step.status),
            result: step.result ? String(step.result).slice(0, 500) : undefined,
            error: step.error ? String(step.error).slice(0, 500) : undefined,
          });
        }
      }
    }
    if (typeof mission?.id === 'string') this.currentTaskId = mission.id;
  }

  private onTaskProgress(data: any): void {
    if (data?.id) this.currentTaskId = data.id;
    const steps = Array.isArray(data?.steps) ? data.steps : [];
    for (const step of steps) {
      if (step?.id && step?.description) {
        this.steps.set(step.id, {
          id: String(step.id),
          description: String(step.description).slice(0, 300),
          state: String(step.state),
          result: step.result ? String(step.result).slice(0, 500) : undefined,
          error: step.error ? String(step.error).slice(0, 500) : undefined,
        });
      }
    }
  }

  private onAgentMessage(data: any): void {
    // The final assistant reply for the current run becomes the summary.
    if (data?.role === 'assistant' && typeof data.content === 'string') {
      this.finalReply = data.content.slice(0, 2000);
    }
  }

  // ── Real specialist intake (§6) ─────────────────────────────────

  /**
   * A real specialist-assigned event: a tool activation claimed the
   * task's objective under explicit budgets. No specialist block is
   * ever shown without this real event.
   */
  private onSpecialistAssigned(data: any): void {
    if (!data || typeof data !== 'object' || !data.objectiveId) return;
    this.currentSpecialist = {
      objectiveId: String(data.objectiveId),
      specialist: String(data.specialist ?? 'GENERAL'),
      objective: String(data.objective ?? '').slice(0, 300),
      taskId: data.taskId ? String(data.taskId) : undefined,
      status: String(data.status ?? 'ASSIGNED'),
      budgets: {
        maxActions: Number(data.budgets?.maxActions ?? 0),
        maxRecoveries: Number(data.budgets?.maxRecoveries ?? 0),
        maxReplans: Number(data.budgets?.maxReplans ?? 0),
        deadlineMs: Number(data.budgets?.deadlineMs ?? 0),
      },
      actionsUsed: typeof data.actionsUsed === 'number' ? data.actionsUsed : undefined,
      recoveriesUsed: typeof data.recoveriesUsed === 'number' ? data.recoveriesUsed : undefined,
      replansUsed: typeof data.replansUsed === 'number' ? data.replansUsed : undefined,
    };
    this.emitChange();
  }

  /**
   * A real specialist-result event: the objective settled into its
   * honest terminal state. The result REPLACES the live block — and its
   * verification level is carried verbatim: UNVERIFIED stays UNVERIFIED.
   */
  private onSpecialistResult(data: any): void {
    if (!data || typeof data !== 'object' || !data.objectiveId) return;
    const prev = this.currentSpecialist;
    this.currentSpecialist = {
      objectiveId: String(data.objectiveId),
      specialist: String(data.role ?? prev?.specialist ?? 'GENERAL'),
      objective: String(data.objective ?? prev?.objective ?? '').slice(0, 300),
      taskId: data.taskId ? String(data.taskId) : prev?.taskId,
      status: String(data.status ?? 'COMPLETED'),
      budgets: prev?.budgets ?? {
        maxActions: Number(data.budgets?.maxActions ?? 0),
        maxRecoveries: Number(data.budgets?.maxRecoveries ?? 0),
        maxReplans: Number(data.budgets?.maxReplans ?? 0),
        deadlineMs: Number(data.budgets?.deadlineMs ?? 0),
      },
      actionsUsed: typeof data.actionsUsed === 'number' ? data.actionsUsed : prev?.actionsUsed,
      recoveriesUsed: typeof data.recoveriesUsed === 'number' ? data.recoveriesUsed : prev?.recoveriesUsed,
      replansUsed: typeof data.replansUsed === 'number' ? data.replansUsed : prev?.replansUsed,
      result: {
        status: String(data.status ?? 'COMPLETED'),
        verification:
          data.verification === 'VERIFIED' || data.verification === 'PARTIAL' || data.verification === 'UNVERIFIED'
            ? data.verification
            : 'UNVERIFIED', // honest default when evidence is missing — never upgraded
        completedCount: Number(data.completedCount ?? 0),
        verifiedCount: Number(data.verifiedCount ?? 0),
        failedCount: Number(data.failedCount ?? 0),
        deniedCount: Number(data.deniedCount ?? 0),
        deadlineExceeded: data.deadlineExceeded === true,
        durationMs: Number(data.durationMs ?? 0),
        summary: String(data.summary ?? '').slice(0, 500),
      },
    };
    this.emitChange();
  }

  /**
   * Compose the report STRICTLY from collected real events. Order of
   * precedence for status: STOPPED (user stopped) > FAILED (agent
   * error) > PARTIAL (failed/skipped steps) > SUCCESS (clean finish).
   */
  private composeReport(terminalStateOverride?: string): void {
    const directive = this.activeDirective;
    const terminalState = terminalStateOverride ?? this.pendingTerminalState;
    // Nothing to report without an active directive AND a real terminal
    // state. task-complete without either is not evidence of anything.
    if (!directive || !terminalState) return;

    const steps = [...this.steps.values()].slice(-MAX_REPORT_STEPS);
    const failed = steps.filter((s) => s.state === 'failed');
    const skipped = steps.filter((s) => s.state === 'skipped');

    let status: AgentReportStatus;
    if (terminalState === 'idle') {
      status = 'STOPPED';
    } else {
      // HONEST verification capping (§6): a specialist objective whose
      // evidence is UNVERIFIED can never report SUCCESS — the best it
      // can honestly claim is PARTIAL. Tool invocation ≠ verification.
      const sp = this.currentSpecialist?.result;
      const unverifiedSpecialist = sp
        && sp.status !== 'FAILED' && sp.status !== 'TIMED_OUT' && sp.status !== 'CANCELLED'
        && sp.verification === 'UNVERIFIED';
      // Mission coordination: a completed mission whose aggregated step
      // evidence is UNVERIFIED is capped at PARTIAL for the same reason.
      const unverifiedMission = this.lastMissionVerification === 'UNVERIFIED';
      if (terminalState === 'error') {
        status = 'FAILED';
      } else if (failed.length > 0 || skipped.length > 0) {
        status = 'PARTIAL';
      } else if (unverifiedSpecialist || unverifiedMission) {
        status = 'PARTIAL';
      } else {
        status = 'SUCCESS';
      }
    }

    const blockers = [
      ...failed.map((s) => `Step failed: ${s.description}${s.error ? ` — ${s.error}` : ''}`),
      ...skipped.map((s) => `Step skipped: ${s.description}`),
    ].slice(0, 10);

    this.lastReport = {
      directiveId: directive.id,
      taskId: this.currentTaskId ?? undefined,
      status,
      evidence: steps,
      summary: this.finalReply ?? undefined,
      metrics: this.completionMetrics ?? undefined,
      blockers,
      reportedAt: Date.now(),
      // Mission-directive reports carry the REAL checkpoint state (the
      // mission store snapshot that just terminated). Nulls are honest:
      // a mission without checkpoints reports none.
      missionCheckpoint: this.lastMissionCheckpoint ?? undefined,
      // Real aggregated mission verification (mission coordination) —
      // verbatim, never upgraded.
      missionVerification: this.lastMissionVerification ?? undefined,
      // Real specialist delegation of THIS run (when one existed). The
      // verification level travels verbatim — UNVERIFIED is never
      // upgraded anywhere downstream.
      specialist: this.currentSpecialist
        ? {
            objectiveId: this.currentSpecialist.objectiveId,
            specialist: this.currentSpecialist.specialist,
            objective: this.currentSpecialist.objective,
            ...(this.currentSpecialist.result
              ? this.currentSpecialist.result
              : { status: this.currentSpecialist.status, verification: 'UNVERIFIED' as const, completedCount: 0, verifiedCount: 0, failedCount: 0, deniedCount: 0, deadlineExceeded: false, durationMs: 0, summary: 'objective did not settle' }),
          }
        : undefined,
    };
    this.lastMissionCheckpoint = null;

    // Continuity: remember the exchange for follow-ups.
    this.lastExchange = {
      request: directive.goal.slice(0, 500),
      outcome: status,
    };

    logger.info('jarvis', `Report ${status} for directive ${directive.id}`);

    this.setPhase('reporting');
    // Reset per-run collectors; the report stays visible in the snapshot.
    this.steps = new Map();
    this.currentTaskId = null;
    this.finalReply = null;
    this.completionMetrics = null;
    this.pendingTerminalState = null;
    this.sawError = false;
    this.currentRecovery = null;
    this.currentSpecialist = null;
    this.lastMissionCheckpoint = null;
    this.lastMissionVerification = null;
    this.activeDirective = null;
    this.setPhase('idle');
  }
}
