// BLAXIN Mission Coordination (§ multi-specialist coordination)
// =============================================================
// Evolves the sequential MissionStore into a bounded, evidence-driven
// mission coordinator WITHOUT replacing anything:
//
//   - MissionStore stays the source of truth for step lifecycle
//     (start/resume/checkpoint/retry/cancel — unchanged).
//   - THIS module adds what was missing:
//       1. verification AGGREGATION from real specialist-result events
//          (a mission is VERIFIED only when its step evidence is);
//       2. bounded SHARED MISSION CONTEXT: verified evidence from
//          completed steps is available to later steps (templated into
//          their objective via a real placeholder) — the current
//          instruction always outranks context;
//       3. step objective TEMPLATES referencing earlier evidence
//          ({{stepId}} placeholders resolve from REAL results);
//       4. CANCELLATION propagation: cancelling a mission cancels its
//          queued/running queue tasks (no orphan specialists);
//       5. honest RESULT derivation: completed-without-verification
//          missions are UNVERIFIED — never upgraded to SUCCESS.
//
// Hard rules (unchanged from the architecture):
//   - every field is derived from REAL events; nothing is invented;
//   - UNVERIFIED stays UNVERIFIED; specialist VERIFIED is necessary but
//     the mission-level check requires the step evidence to line up;
//   - budgets stay where they are (specialist budgets per objective;
//     the existing recovery ladder inside each action) — this module
//     adds NO new retry loops and NO infinite anything;
//   - policy/policy-gates/confirmation flows are untouched.
// =============================================================

import { logger } from '../utils/logger.js';
import type { MissionStore, Mission } from '../utils/missions.js';
import type { TaskQueue, QueueTask } from '../utils/task-queue.js';

/** Honest mission-level verification state (derived, never guessed). */
export type MissionVerification = 'VERIFIED' | 'PARTIAL' | 'UNVERIFIED' | 'NONE';

/** One step's real verification evidence (from the specialist ledger). */
export interface StepEvidence {
  stepId: string;
  /** The real specialist objectiveId that executed this step (if any). */
  objectiveId?: string;
  /** The real specialist role (BROWSER/FILES/…). */
  role?: string;
  /** Real specialist terminal status (COMPLETED_VERIFIED / …). */
  status?: string;
  /** Real verification level carried by the specialist result. */
  verification?: 'VERIFIED' | 'PARTIAL' | 'UNVERIFIED';
  /** Bounded observed evidence (e.g. the verified URL/title or file). */
  detail?: string;
  at: number;
}

/** Bounded shared context handed to a specialist objective before it runs. */
export interface MissionContext {
  missionId: string;
  missionObjective: string;
  /** Verification evidence of COMPLETED steps, in mission order (bounded 10). */
  completedEvidence: Array<{ stepId: string; summary: string; verified: boolean }>;
  /** Real results of failed steps (bounded 5) — what already did NOT work. */
  failedResults: string[];
  /** Real progress fraction (0..1) at delegation time. */
  progress: number;
}

const MAX_COMPLETED_EVIDENCE = 10;
const MAX_FAILED_RESULTS = 5;
const MAX_DETAIL = 200;

export class MissionCoordinator {
  /** missionId → stepId → real specialist evidence for that step. */
  private evidence = new Map<string, Map<string, StepEvidence>>();
  /** missionId → stepId → real objectiveId (bound at assignment). */
  private stepObjectives = new Map<string, Map<string, string>>();
  /**
   * The queue task currently executing (bound by the scheduler). Embedded
   * execution is strictly serial (one queue task at a time), so while the
   * binding holds, every real specialist event belongs to THIS task — the
   * exact correlation point between the orchestrator's internal task ids
   * and the queue/mission namespace.
   */
  private runningTaskId: string | null = null;

  constructor(
    private readonly missions: MissionStore,
    private readonly queue: TaskQueue,
  ) {}

  /**
   * Bind/unbind the queue task that is REALLY executing (scheduler call:
   * bound at markRunning, cleared when the task settles). No binding →
   * specialist events cannot be attributed to a mission step and are
   * honestly ignored (never guessed onto the wrong step).
   */
  bindRunningTask(taskId: string | null): void {
    this.runningTaskId = taskId;
  }

  /** The mission step (if any) the currently running queue task satisfies. */
  private currentStep(): { missionId: string; stepId: string } | null {
    if (!this.runningTaskId) return null;
    const task = this.queue.get(this.runningTaskId);
    if (!task?.missionId || !task.missionStepId) return null;
    return { missionId: task.missionId, stepId: task.missionStepId };
  }

  // ── Real evidence intake (from orchestrator specialist events) ──

  /**
   * Ingest a REAL specialist-assigned event: bind the objective to the
   * mission step whose queue task is running it. No objective, or no
   * running task binding → no record (a task that never touched a tool
   * has no specialist, and attribution is never guessed).
   */
  onSpecialistAssigned(data: {
    objectiveId?: string; taskId?: string; specialist?: string; objective?: string;
  }): void {
    if (!data?.objectiveId) return;
    const step = this.currentStep();
    if (!step) return;
    const perMission = this.stepObjectives.get(step.missionId) ?? new Map<string, string>();
    perMission.set(step.stepId, String(data.objectiveId));
    this.stepObjectives.set(step.missionId, perMission);
  }

  /**
   * Ingest a REAL specialist-result event: record the step's honest
   * verification evidence. UNVERIFIED is stored verbatim — never upgraded.
   */
  onSpecialistResult(data: {
    objectiveId?: string; taskId?: string; role?: string; status?: string;
    verification?: string; summary?: string;
  }): void {
    if (!data?.objectiveId) return;
    const step = this.currentStep();
    if (!step) return;

    const v = data.verification === 'VERIFIED' || data.verification === 'PARTIAL'
      ? data.verification
      : 'UNVERIFIED'; // honest default — never upgraded
    const perMission = this.evidence.get(step.missionId) ?? new Map<string, StepEvidence>();
    perMission.set(step.stepId, {
      stepId: step.stepId,
      objectiveId: String(data.objectiveId),
      role: data.role ? String(data.role) : undefined,
      status: data.status ? String(data.status) : undefined,
      verification: v,
      detail: data.summary ? String(data.summary).slice(0, MAX_DETAIL) : undefined,
      at: Date.now(),
    });
    this.evidence.set(step.missionId, perMission);
  }

  /** The step's real verification level as ingested (undefined = none). */
  stepVerification(missionId: string, stepId: string): 'VERIFIED' | 'PARTIAL' | 'UNVERIFIED' | undefined {
    return this.evidence.get(missionId)?.get(stepId)?.verification;
  }

  // ── Shared mission context (bounded, real) ──────────────────────

  /**
   * Build the bounded shared context for the step that is ABOUT to run.
   * Only real, settled evidence enters; the current instruction (already
   * the step objective) always outranks this background context.
   */
  contextFor(missionId: string, stepId: string): MissionContext {
    const mission = this.missions.get(missionId);
    if (!mission) {
      return { missionId, missionObjective: '', completedEvidence: [], failedResults: [], progress: 0 };
    }
    const perMission = this.evidence.get(missionId);
    const completedEvidence: MissionContext['completedEvidence'] = [];
    for (const step of mission.steps) {
      if (step.status !== 'completed') continue;
      const ev = perMission?.get(step.id);
      // Verification level: live intake first, then the store's persisted
      // step level (which the scheduler populated FROM that intake). One
      // truth chain — a restarted server still shows honest evidence.
      const level = ev?.verification ?? step.verification;
      completedEvidence.push({
        stepId: step.id,
        summary: (ev?.detail || step.checkpoint?.summary || step.result || step.description || '')
          .slice(0, MAX_DETAIL),
        verified: level === 'VERIFIED',
      });
      if (completedEvidence.length >= MAX_COMPLETED_EVIDENCE) break;
    }
    const failedResults = mission.steps
      .filter((s) => s.status === 'failed' && s.error)
      .slice(-MAX_FAILED_RESULTS)
      .map((s) => `${s.description}: ${(s.error || '').slice(0, MAX_DETAIL)}`);
    const done = mission.steps.filter((s) => s.status === 'completed').length;
    return {
      missionId,
      missionObjective: mission.objective,
      completedEvidence,
      failedResults,
      progress: mission.steps.length > 0 ? Math.round((done / mission.steps.length) * 1000) / 1000 : 0,
    };
  }

  /**
   * Render the shared context as a bounded prompt fragment (rendered via
   * setDirectiveContext; the orchestrator treats it as background data).
   */
  renderContext(ctx: MissionContext): string {
    if (ctx.completedEvidence.length === 0 && ctx.failedResults.length === 0) return '';
    const lines: string[] = [`MISSION CONTEXT (${ctx.missionId}):`, `- Mission objective: ${ctx.missionObjective}`];
    if (ctx.completedEvidence.length > 0) {
      lines.push('- Completed step evidence (verified = real verification evidence exists):');
      for (const e of ctx.completedEvidence) {
        lines.push(`  · [${e.verified ? 'VERIFIED' : 'UNVERIFIED'}] ${e.summary}`);
      }
    }
    if (ctx.failedResults.length > 0) {
      lines.push('- Failed steps so far (do not repeat them blindly):');
      for (const f of ctx.failedResults) lines.push(`  · ${f}`);
    }
    return `\n\n${lines.join('\n')}`;
  }

  // ── Mission-level verification (aggregation) ─────────────────────

  /**
   * Aggregate the mission's REAL verification state. The contract:
   *   - every completed step carries VERIFIED evidence → VERIFIED;
   *   - some steps verified, some completed without evidence → PARTIAL;
   *   - completed steps with no verification evidence at all → UNVERIFIED;
   *   - nothing completed (or no evidence ingested) → NONE.
   * SINGLE SOURCE OF TRUTH: the aggregation itself lives in MissionStore
   * (recomputed from per-step verification at every settlement, persisted,
   * restart-safe). THIS derivation reads the store — never a parallel
   * in-memory count that could diverge from it after a restart. The
   * coordinator's evidence map remains the LIVE INTAKE path (its result
   * is what the scheduler feeds into settleStep) and the source for
   * context/templates/detail — not a second aggregation.
   * FAILED/CANCELLED missions do not aggregate (they are already terminal
   * failures — the honest state is the mission's own status).
   */
  verificationOf(missionId: string): MissionVerification {
    const mission = this.missions.get(missionId);
    if (!mission) return 'NONE';
    const completed = mission.steps.filter((s) => s.status === 'completed');
    if (completed.length === 0) return 'NONE';
    // A mission completed before coordination existed (no stored level)
    // is honestly UNVERIFIED — absence of evidence is never upgraded.
    return mission.verification ?? 'UNVERIFIED';
  }

  /** The step's real evidence (null when none was ingested). */
  evidenceFor(missionId: string, stepId: string): StepEvidence | null {
    return this.evidence.get(missionId)?.get(stepId) ?? null;
  }

  /** Bounded snapshot for the HUD / REST (real data only). */
  snapshot(missionId: string): {
    verification: MissionVerification;
    steps: Array<{ stepId: string; objectiveId?: string; verification?: string; status?: string }>;
  } {
    const mission = this.missions.get(missionId);
    const perMission = this.evidence.get(missionId);
    const objectiveMap = this.stepObjectives.get(missionId);
    const steps = (mission?.steps ?? [])
      .map((s) => {
        const ev = perMission?.get(s.id);
        return {
          stepId: s.id,
          objectiveId: ev?.objectiveId ?? objectiveMap?.get(s.id),
          verification: ev?.verification,
          status: ev?.status,
        };
      })
      .filter((s) => s.objectiveId || s.verification);
    return { verification: this.verificationOf(missionId), steps };
  }

  // ── Cancellation propagation (no orphan specialists) ────────────

  /**
   * Cancel a mission AND its in-flight work: every queued/running queue
   * task belonging to the mission is cancelled, so no specialist objective
   * survives the mission's terminal state. Returns the cancelled task ids.
   */
  cancelMission(missionId: string): string[] {
    const cancelled: string[] = [];
    for (const task of this.queue.list()) {
      if (task.missionId !== missionId) continue;
      if (task.status === 'queued' || task.status === 'running') {
        if (this.queue.cancel(task.id)) cancelled.push(task.id);
      }
    }
    const mission = this.missions.get(missionId);
    if (mission) {
      logger.info('mission', `Mission ${missionId} cancelled — ${cancelled.length} queue task(s) cancelled with it`);
    }
    return cancelled;
  }

  /**
   * Drop a mission's evidence maps (bounded memory; called on delete/clear
   * or when the missions store evicts the mission).
   */
  forget(missionId: string): void {
    this.evidence.delete(missionId);
    this.stepObjectives.delete(missionId);
  }

  /**
   * Real objective template expansion: {{evidence:<stepId>}} placeholders
   * in a step description resolve from the step's REAL evidence. Unknown
   * or unverified references resolve to an explicit marker — never to a
   * fabricated value, never silently dropped.
   */
  expandTemplate(text: string, missionId: string): string {
    return text.replace(/\{\{evidence:([a-zA-Z0-9_-]+)\}\}/g, (_m, stepId: string) => {
      const ev = this.evidenceFor(missionId, stepId);
      if (!ev) return `{{evidence:${stepId} — not available}}`;
      if (ev.verification !== 'VERIFIED') return `{{evidence:${stepId} — UNVERIFIED}}`;
      return ev.detail ? String(ev.detail).slice(0, MAX_DETAIL) : `{{evidence:${stepId} — no detail}}`;
    });
  }
}

/** Mission id helper shared by the WS/API layers (single format). */
export function missionIdOf(m: Pick<Mission, 'id'>): string {
  return m.id;
}

/** Re-exported for the REST layer's types (no behavior). */
export type { QueueTask };
