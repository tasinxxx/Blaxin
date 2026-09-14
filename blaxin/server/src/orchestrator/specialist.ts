// BLAXIN Specialist bounded-objective ownership (§6)
// =============================================================
// A delegated specialist (the BROWSER/FILES/TERMINAL/… role derived from
// the REAL tool activation) owns a bounded OBJECTIVE: explicit budgets
// (actions, recoveries, re-plans, deadline), an evidence requirement,
// and a structured honest result. The specialist is NOT an unrestricted
// autonomous agent — every action stays attributable to its objective
// and every budget is hard.
//
// Hard rules (mirroring the recovery policy §29/§30):
//   - ownership is EXPLICIT: an objective is assigned from a real tool
//     activation, never decoratively; a task with no tool work has no
//     specialist;
//   - a tool invocation is NOT a successful outcome: the verification
//     level is derived ONLY from the tool's real verification evidence;
//   - an attempt is NOT completion, completion is NOT verification —
//     UNVERIFIED is a first-class honest state, never upgraded;
//   - budgets are explicit and configurable; exhaustion is honest
//     (FAILED/TIMED_OUT), never silently ignored;
//   - results are terminal and emitted exactly once.
// =============================================================

import { v4 as uuidv4 } from 'uuid';
import { roleForTool, WorkerRole } from '../agency/registry.js';

/** Honest lifecycle of a specialist objective. */
export type ObjectiveStatus =
  | 'ASSIGNED'              // owned by the specialist, no action yet
  | 'RUNNING'               // at least one real action started
  | 'COMPLETED_VERIFIED'    // finished; every completed action has real SUCCESS verification
  | 'COMPLETED_PARTIAL'     // finished; some completed actions verified, some not
  | 'COMPLETED_UNVERIFIED'  // finished; NO completed action carries verification evidence
  | 'FAILED'                // an action really failed / budget exhausted
  | 'TIMED_OUT'             // the objective's deadline passed before honest completion
  | 'BLOCKED'               // denied at the policy gate — the specialist could not act
  | 'CANCELLED';            // stopped by the user before honest completion

/** Verification level derived ONLY from real evidence (never upgraded). */
export type VerificationLevel = 'VERIFIED' | 'PARTIAL' | 'UNVERIFIED';

export interface SpecialistBudgets {
  /** Distinct actions this objective may execute (hard limit). */
  maxActions: number;
  /** Deterministic recovery attempts allowed ACROSS the objective. */
  maxRecoveries: number;
  /** Deterministic re-plans allowed for the objective. */
  maxReplans: number;
  /** Wall-clock deadline for the objective (ms from assignment). */
  deadlineMs: number;
}

export interface SpecialistConfig extends SpecialistBudgets {
  /** Bounded ledger size (oldest objectives are dropped, never unbounded). */
  maxTracked: number;
}

export const DEFAULT_SPECIALIST_CONFIG: SpecialistConfig = {
  maxActions: 16,
  maxRecoveries: 8,
  maxReplans: 1,
  deadlineMs: 300_000,
  maxTracked: 50,
};

/** One REAL piece of evidence: a settled action with its verification payload. */
export interface EvidenceRecord {
  at: number;
  stepId: string;
  tool: string;
  outcome: 'completed' | 'failed' | 'skipped';
  /** Why a skipped action never ran (denial vs cancellation vs budget refusal). */
  detail?: string;
  result?: string;
  error?: string;
  /** The tool's REAL verification payload, verbatim. Absent = unverified. */
  verification?: { method: string; status: string; detail: string };
}

export interface SpecialistObjective {
  id: string;
  role: WorkerRole;
  /** The tool that activated this specialist (real evidence of the role). */
  tool: string;
  /** The delegated goal — the user's own instruction, bounded. */
  objective: string;
  taskId?: string;
  createdAt: number;
  expiresAt: number;
  budgets: SpecialistBudgets;
  /** Live budget usage (real counts, enforced at admission). */
  actionsUsed: number;
  recoveriesUsed: number;
  replansUsed: number;
  deniedCount: number;
  status: ObjectiveStatus;
  /** True when the deadline passed before the objective settled. */
  deadlineExceeded: boolean;
  /** Honest, bounded evidence trail (real settled actions only). */
  evidence: EvidenceRecord[];
}

/** The structured result — terminal, emitted exactly once per objective. */
export interface SpecialistResult {
  objectiveId: string;
  role: WorkerRole;
  objective: string;
  taskId?: string;
  status: ObjectiveStatus;
  verification: VerificationLevel;
  /** Real evidence counts (what the status was derived from). */
  evidenceCount: number;
  completedCount: number;
  verifiedCount: number;
  failedCount: number;
  deniedCount: number;
  budgets: SpecialistBudgets;
  actionsUsed: number;
  recoveriesUsed: number;
  replansUsed: number;
  deadlineExceeded: boolean;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  /** Honest one-line summary — no success inflation. */
  summary: string;
}

export interface SettleOptions {
  /** The user stopped the run. */
  stopped?: boolean;
  /** Why the objective is settling early (budget/deadline refusals). */
  reason?: 'action-budget-exhausted' | 'deadline-exceeded';
}

const MAX_EVIDENCE = 30;
const OBJECTIVE_ID_PREFIX = 'obj_';

function clip(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export class SpecialistLedger {
  private config: SpecialistConfig = { ...DEFAULT_SPECIALIST_CONFIG };
  private objectives = new Map<string, SpecialistObjective>();
  private results = new Map<string, SpecialistResult>();
  /** taskId → objectiveId: ONE objective per task (no budget cycling). */
  private byTask = new Map<string, string>();
  /** The objective currently owned by the running task. */
  private currentId: string | null = null;

  /** Explicit, configurable budgets (tests + deployment tuning). */
  setConfig(partial: Partial<SpecialistConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  getConfig(): SpecialistConfig {
    return { ...this.config };
  }

  /**
   * Assign the current task's objective to the specialist activated by a
   * REAL tool call. Idempotent per task: the first real activation claims
   * ownership and the SAME objective answers every later call for that
   * task (one delegation per task — budgets cannot be cycled by starting
   * "new" objectives mid-task); a task with no tool activation never
   * gets an objective.
   */
  assign(input: {
    tool: string;
    objective: string;
    taskId?: string;
    /** Re-plan budget mirrors the recovery policy's per-task budget. */
    maxReplansOverride?: number;
  }): SpecialistObjective {
    if (input.taskId) {
      const existingId = this.byTask.get(input.taskId);
      if (existingId) {
        const existing = this.objectives.get(existingId);
        if (existing) return existing;
      }
    } else {
      const current = this.current();
      if (current && !current.taskId) return current;
    }

    const now = Date.now();
    const budgets: SpecialistBudgets = {
      maxActions: this.config.maxActions,
      maxRecoveries: this.config.maxRecoveries,
      maxReplans: input.maxReplansOverride ?? this.config.maxReplans,
      deadlineMs: this.config.deadlineMs,
    };
    const objective: SpecialistObjective = {
      id: `${OBJECTIVE_ID_PREFIX}${uuidv4().slice(0, 8)}`,
      role: roleForTool(input.tool),
      tool: input.tool,
      objective: clip(input.objective, 300) ?? 'delegated objective',
      taskId: input.taskId,
      createdAt: now,
      expiresAt: now + budgets.deadlineMs,
      budgets,
      actionsUsed: 0,
      recoveriesUsed: 0,
      replansUsed: 0,
      deniedCount: 0,
      status: 'ASSIGNED',
      deadlineExceeded: false,
      evidence: [],
    };
    this.objectives.set(objective.id, objective);
    if (objective.taskId) this.byTask.set(objective.taskId, objective.id);
    this.currentId = objective.id;
    this.trim();
    return objective;
  }

  /** The active objective (null when the running task delegated nothing). */
  current(): SpecialistObjective | null {
    return this.currentId ? this.objectives.get(this.currentId) ?? null : null;
  }

  get(id: string): SpecialistObjective | null {
    return this.objectives.get(id) ?? null;
  }

  result(id: string): SpecialistResult | null {
    return this.results.get(id) ?? null;
  }

  /** Terminal results, newest first (bounded). */
  listResults(limit = 20): SpecialistResult[] {
    return [...this.results.values()].slice(-limit).reverse();
  }

  // ── Budget enforcement (called at real admission points) ──────

  /** True when the objective may start ANOTHER real action. */
  actionAllowed(id: string): boolean {
    const o = this.objectives.get(id);
    if (!o || this.isTerminal(o.status)) return false;
    if (o.actionsUsed >= o.budgets.maxActions) return false;
    if (this.pastDeadline(o)) return false;
    return true;
  }

  /** True when the deterministic recovery ladder may make another attempt. */
  recoveryAllowed(id: string): boolean {
    const o = this.objectives.get(id);
    if (!o || this.isTerminal(o.status)) return false;
    return o.recoveriesUsed < o.budgets.maxRecoveries;
  }

  /** True when the deterministic re-plan layer may mutate the plan again. */
  replanAllowed(id: string): boolean {
    const o = this.objectives.get(id);
    if (!o || this.isTerminal(o.status)) return false;
    return o.replansUsed < o.budgets.maxReplans;
  }

  /** Count a real action start (called when the action really begins). */
  recordAction(id: string): void {
    const o = this.objectives.get(id);
    if (!o) return;
    o.actionsUsed++;
    if (o.status === 'ASSIGNED') o.status = 'RUNNING';
  }

  recordRecovery(id: string): void {
    const o = this.objectives.get(id);
    if (!o) return;
    o.recoveriesUsed++;
  }

  recordReplan(id: string): void {
    const o = this.objectives.get(id);
    if (!o) return;
    o.replansUsed++;
  }

  /** Record a policy-gate denial (the specialist was blocked, honestly). */
  recordDenied(id: string, stepId: string, tool: string, detail?: string): void {
    const o = this.objectives.get(id);
    if (!o) return;
    o.deniedCount++;
    this.recordEvidence(id, {
      at: Date.now(),
      stepId,
      tool,
      outcome: 'skipped',
      detail: detail ?? 'denied by user (policy gate)',
    });
  }

  /** Record one settled action's REAL outcome + verification payload. */
  recordEvidence(id: string, record: EvidenceRecord): void {
    const o = this.objectives.get(id);
    if (!o) return;
    o.evidence.push(record);
    if (o.evidence.length > MAX_EVIDENCE) o.evidence.shift();
  }

  /**
   * Settle the objective into a terminal state. Idempotent: the first
   * settle wins (results are emitted exactly once by the caller).
   * The status is derived from REAL evidence — never from optimism.
   */
  settle(id: string, opts: SettleOptions = {}): SpecialistResult | null {
    const o = this.objectives.get(id);
    if (!o || this.isTerminal(o.status)) return this.results.get(id) ?? null;

    const completedAt = Date.now();
    o.deadlineExceeded = o.deadlineExceeded || this.pastDeadline(o, completedAt);

    const failed = o.evidence.filter((e) => e.outcome === 'failed');
    const completed = o.evidence.filter((e) => e.outcome === 'completed');
    const verified = completed.filter((e) => e.verification?.status === 'SUCCESS');

    // Refusal evidence recorded by the runtime's honest admission gate —
    // a real state of the objective, not narrative (the runtime also
    // passes opts.reason; the evidence makes the ledger self-contained).
    const deadlineRefused = opts.reason === 'deadline-exceeded'
      || o.evidence.some((e) => e.outcome === 'skipped' && /deadline exceeded/i.test(e.detail ?? ''));
    const budgetRefused = opts.reason === 'action-budget-exhausted'
      || o.evidence.some((e) => e.outcome === 'skipped' && /budget exhausted/i.test(e.detail ?? ''));

    // Early-exit reasons are real states, not narrative. Ordering is the
    // honesty contract: the wall clock is absolute, the user's stop wins
    // over everything but it, real failure evidence is next, and budget
    // exhaustion FAILS the objective — but never erases genuine VERIFIED
    // work (verification stays evidence-based, not punitive).
    if (deadlineRefused || o.deadlineExceeded) {
      o.status = 'TIMED_OUT';
    } else if (opts.stopped) {
      o.status = 'CANCELLED';
    } else if (failed.length > 0) {
      o.status = 'FAILED';
    } else if (budgetRefused && verified.length === 0) {
      // Actions were honestly refused and nothing verified: the objective
      // outlived its budget — FAILED, never a silent UNVERIFIED completion.
      o.status = 'FAILED';
    } else if (o.deniedCount > 0 && completed.length === 0) {
      o.status = 'BLOCKED';
    } else if (verified.length === completed.length && completed.length > 0) {
      o.status = 'COMPLETED_VERIFIED';
    } else if (verified.length > 0) {
      o.status = 'COMPLETED_PARTIAL';
    } else {
      // Completed work with zero verification evidence stays UNVERIFIED —
      // a tool invocation is not a verified outcome.
      o.status = 'COMPLETED_UNVERIFIED';
    }

    const verification: VerificationLevel =
      o.status === 'COMPLETED_VERIFIED'
        ? 'VERIFIED'
        : o.status === 'COMPLETED_PARTIAL'
          ? 'PARTIAL'
          : 'UNVERIFIED';

    const result: SpecialistResult = {
      objectiveId: o.id,
      role: o.role,
      objective: o.objective,
      taskId: o.taskId,
      status: o.status,
      verification,
      evidenceCount: o.evidence.length,
      completedCount: completed.length,
      verifiedCount: verified.length,
      failedCount: failed.length,
      deniedCount: o.deniedCount,
      budgets: { ...o.budgets },
      actionsUsed: o.actionsUsed,
      recoveriesUsed: o.recoveriesUsed,
      replansUsed: o.replansUsed,
      deadlineExceeded: o.deadlineExceeded,
      startedAt: o.createdAt,
      completedAt,
      durationMs: completedAt - o.createdAt,
      summary: summarize(o.status, verification, {
        completed: completed.length,
        verified: verified.length,
        failed: failed.length,
        denied: o.deniedCount,
        actions: o.actionsUsed,
        maxActions: o.budgets.maxActions,
        recoveries: o.recoveriesUsed,
        deadlineExceeded: o.deadlineExceeded,
      }),
    };
    o.status = result.status;
    this.results.set(o.id, result);
    if (this.currentId === o.id) this.currentId = null;
    // byTask entry is KEPT after settlement: the task→objective binding is
    // the idempotency anchor — a later settleTask for the same task must
    // return the SAME terminal result (first settlement wins, exactly
    // once). The entry dies with its objective in trim(); no unbounded
    // growth.
    this.trim();
    return result;
  }

  /**
   * Settle the objective that belongs to a task (the normal end-of-task
   * path). Returns the result when one was really produced.
   */
  settleTask(taskId: string | undefined, opts: SettleOptions = {}): SpecialistResult | null {
    if (!taskId) return null;
    const id = this.byTask.get(taskId);
    if (!id) return null;
    return this.settle(id, opts);
  }

  /** Detach the current pointer without settling (rollback paths). */
  detachCurrent(): void {
    this.currentId = null;
  }

  /** Drop all state (history clear / task cancellation). */
  clear(): void {
    this.objectives.clear();
    this.results.clear();
    this.byTask.clear();
    this.currentId = null;
  }

  // ── internals ────────────────────────────────────────────────

  private isTerminal(status: ObjectiveStatus): boolean {
    return status !== 'ASSIGNED' && status !== 'RUNNING';
  }

  private pastDeadline(o: SpecialistObjective, now = Date.now()): boolean {
    return now > o.expiresAt;
  }

  private trim(): void {
    while (this.objectives.size > this.config.maxTracked) {
      const oldest = this.objectives.keys().next().value as string | undefined;
      if (!oldest) break;
      // An evicted objective takes its task binding with it (no stale or
      // unbounded byTask growth).
      for (const [taskId, objId] of this.byTask) {
        if (objId === oldest) this.byTask.delete(taskId);
      }
      this.objectives.delete(oldest);
    }
    while (this.results.size > this.config.maxTracked) {
      const oldest = this.results.keys().next().value as string | undefined;
      if (!oldest) break;
      this.results.delete(oldest);
    }
  }
}

/** Honest one-line summary for a specialist result (no inflation). */
function summarize(
  status: ObjectiveStatus,
  verification: VerificationLevel,
  c: {
    completed: number; verified: number; failed: number; denied: number;
    actions: number; maxActions: number; recoveries: number; deadlineExceeded: boolean;
  },
): string {
  const parts: string[] = [];
  switch (status) {
    case 'COMPLETED_VERIFIED':
      parts.push(`completed with verified evidence (${c.verified}/${c.completed} action(s))`);
      break;
    case 'COMPLETED_PARTIAL':
      parts.push(`completed with PARTIAL verification (${c.verified}/${c.completed} verified)`);
      break;
    case 'COMPLETED_UNVERIFIED':
      parts.push(`completed but UNVERIFIED — no real verification evidence (${c.completed} action(s))`);
      break;
    case 'FAILED':
      parts.push(c.failed > 0
        ? `failed — ${c.failed} action(s) failed`
        : `failed — action budget exhausted (${c.actions}/${c.maxActions})`);
      break;
    case 'TIMED_OUT':
      parts.push('timed out — the objective deadline passed before honest completion');
      break;
    case 'BLOCKED':
      parts.push(`blocked — ${c.denied} action(s) denied at the policy gate`);
      break;
    case 'CANCELLED':
      parts.push('cancelled — stopped before honest completion');
      break;
    default:
      parts.push(`settled as ${status}`);
  }
  parts.push(`verification ${verification}`);
  if (c.recoveries > 0) parts.push(`${c.recoveries} recovery attempt(s)`);
  if (c.deadlineExceeded) parts.push('deadline exceeded');
  return parts.join('; ');
}

export { roleForTool };
