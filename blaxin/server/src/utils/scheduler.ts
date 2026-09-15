// BLAXIN Jarvis Scheduler
// =============================================================
// Coordination layer between the TaskQueue, the Missions store and
// the agent orchestrator. The scheduler is the SINGLE path that
// feeds work to the orchestrator (embedded mode): queue tasks run
// one at a time, real task-complete events settle them, and mission
// steps advance only on verified completion (checkpoints).
//
// State truthfulness:
//   - a task is 'running' only while the orchestrator actually runs it
//   - completion/failure/cancellation is derived from REAL agent-state
//     transitions, never guessed
//   - missions resume from the first pending step (completed steps
//     keep checkpoints and are never re-executed)
// =============================================================

import { TaskQueue, QueueTask } from './task-queue.js';
import { MissionStore, Mission } from './missions.js';
import { logger } from './logger.js';

export interface SchedulerOrchestratorLike {
  isBusy(): boolean;
  processMessage(message: string): Promise<void>;
  stop(): void;
  clearHistory(): void;
  /** Optional Jarvis directive context for the task about to run. */
  setDirectiveContext?(directive: unknown | null): void;
}

export interface SchedulerDeps {
  queue: TaskQueue;
  missions: MissionStore;
  orchestrator: SchedulerOrchestratorLike;
  emit: (event: string, data: unknown) => void;
  /**
   * Mission-coordination hooks (all optional; absent = legacy behavior):
   *  - expandStep: real {{evidence:stepId}} template expansion for a step
   *    objective BEFORE it is enqueued (unresolvable → explicit marker);
   *  - missionContext: bounded shared-mission context for the step about
   *    to run (completed verified evidence + failed results);
   *  - enrichMissions: attach real per-mission verification to the
   *    mission-progress payload (HUD/JARVIS see honest state).
   */
  expandStep?: (text: string, missionId: string) => string;
  missionContext?: (missionId: string, stepId: string) => string;
  enrichMissions?: (missions: Mission[]) => Mission[];
  /** Coordinator task binding (mission coordination; optional). */
  bindCoordinatorTask?: (taskId: string | null) => void;
  /**
   * The step's REAL ingested verification level (mission coordination).
   * Derived from the specialist-result event that arrived while the
   * task was bound — undefined when no specialist evidence exists.
   */
  stepVerification?: (missionId: string, stepId: string) => 'VERIFIED' | 'PARTIAL' | 'UNVERIFIED' | undefined;
}

export class JarvisScheduler {
  private readonly queue: TaskQueue;
  private readonly missions: MissionStore;
  private readonly orchestrator: SchedulerOrchestratorLike;
  private readonly emit: (event: string, data: unknown) => void;
  private readonly expandStep?: (text: string, missionId: string) => string;
  private readonly missionContext?: (missionId: string, stepId: string) => string;
  private readonly enrichMissions?: (missions: Mission[]) => Mission[];

  /** Queue task id currently being executed by the orchestrator. */
  private runningTaskId: string | null = null;
  /** Coordinator task binding (mission coordination; optional). */
  private readonly bindCoordinatorTask?: (taskId: string | null) => void;
  /** Step verification lookup (mission coordination; optional). */
  private readonly stepVerification?: (missionId: string, stepId: string) => 'VERIFIED' | 'PARTIAL' | 'UNVERIFIED' | undefined;
  /** Last real agent-state seen while a task was running. */
  private lastState: string = 'idle';

  constructor(deps: SchedulerDeps) {
    this.queue = deps.queue;
    this.missions = deps.missions;
    this.orchestrator = deps.orchestrator;
    this.emit = deps.emit;
    this.expandStep = deps.expandStep;
    this.missionContext = deps.missionContext;
    this.enrichMissions = deps.enrichMissions;
    this.bindCoordinatorTask = deps.bindCoordinatorTask;
    this.stepVerification = deps.stepVerification;

    this.queue.onChange((tasks) => this.emit('queue-updated', { tasks }));
    // Real per-mission verification (mission coordination) rides on the
    // SAME event — one source of truth, no parallel event channel.
    this.missions.onChange((missions) =>
      this.emit('mission-progress', { missions: this.enrichMissions ? this.enrichMissions(missions) : missions }));
  }

  /** Feed a user request into the queue (the only entry point). */
  enqueueUserMessage(message: string, opts: { priority?: number } = {}): QueueTask {
    const task = this.queue.enqueue({
      objective: message,
      priority: opts.priority,
    });
    this.pump();
    return task;
  }

  /** Handle an orchestrator event (wired by index.ts). */
  onOrchestratorEvent(event: string, data: any): void {
    if (event === 'agent-state' && data?.state) {
      this.lastState = data.state;
    }
    if (event === 'task-complete') {
      this.onTaskComplete(data);
    }
  }

  private onTaskComplete(data: any): void {
    const id = this.runningTaskId;
    if (!id) return;
    this.runningTaskId = null;
    // Unbind the coordinator BEFORE settling: events after this point no
    // longer belong to the settled step (no stale attribution).
    this.bindCoordinatorTask?.(null);

    const task = this.queue.get(id);
    if (!task) return;

    // The last real agent-state decides the outcome: completed /
    // error / idle (stopped by the user). Never guess.
    const state = this.lastState;
    const result = data?.kind === 'direct'
      ? `Fast-path task done in ${data.totalMs}ms (${data.toolCalls ?? 0} tool call(s))`
      : `Task done in ${data.totalMs}ms (${data.modelCalls ?? 0} model call(s), ${data.toolCalls ?? 0} tool call(s))`;

    if (state === 'error') {
      this.queue.markFailed(id, 'The agent reported an error while executing this task');
      if (task.missionId && task.missionStepId) {
        this.missions.settleStep(task.missionId, task.missionStepId, {
          success: false,
          error: 'Agent task failed',
        });
      }
    } else if (state === 'idle') {
      this.queue.cancel(id);
      if (task.missionId && task.missionStepId) {
        this.missions.settleStep(task.missionId, task.missionStepId, {
          success: false,
          error: 'Task cancelled by user',
        });
      }
    } else {
      this.queue.markCompleted(id, result);
      if (task.missionId && task.missionStepId) {
        // The step's REAL verification level comes from the specialist
        // evidence ingested while THIS task was bound (mission
        // coordination). No evidence → UNVERIFIED — never upgraded.
        const v = this.stepVerification?.(task.missionId, task.missionStepId);
        const verification = v === 'VERIFIED' || v === 'PARTIAL' ? v : 'UNVERIFIED';
        this.missions.settleStep(task.missionId, task.missionStepId, {
          success: true,
          result,
          verification,
        });
      }
    }

    this.pump();
  }

  /**
   * Start the next unit of work when nothing is running: first advance
   * queued missions (each enqueues its next pending step), then run the
   * highest-priority eligible queue task.
   */
  pump(): void {
    if (this.runningTaskId) return;
    if (this.orchestrator.isBusy()) return;

    // 1) Advance missions that have work to do: enqueue their next
    //    pending step. Paused/terminal missions never auto-advance, and
    //    a step that is already in flight is never duplicated.
    for (const mission of this.missions.list()) {
      if (mission.status === 'paused' ||
          mission.status === 'completed' ||
          mission.status === 'failed' ||
          mission.status === 'cancelled') continue;
      if (mission.steps.some((s) => s.status === 'running')) continue; // step already in flight
      const started = this.missions.startOrResume(mission.id);
      if (!started) continue;
      const { step } = started;
      // Mission coordination (§ multi-specialist): the step objective is
      // template-expanded from REAL step evidence (unresolvable references
      // become explicit markers — never fabricated), and the bounded
      // shared mission context rides with the task's directive so the
      // executing specialist sees verified evidence as BACKGROUND data
      // (the current instruction still outranks it).
      const objective = this.expandStep ? this.expandStep(step.description, mission.id) : step.description;
      const contextBlock = this.missionContext ? this.missionContext(mission.id, step.id) : undefined;
      this.queue.enqueue({
        objective,
        priority: mission.priority,
        missionId: mission.id,
        missionStepId: step.id,
        ...(contextBlock ? {
          directive: {
            id: `mission_${mission.id.slice(0, 12)}`,
            complexity: 'standard',
            reason: 'mission step execution',
            source: 'mission',
            contextBlock,
          },
        } : {}),
      });
    }

    // 2) Run the next eligible queue task.
    const next = this.queue.nextEligible();
    if (!next) return;
    this.queue.markRunning(next.id);
    this.runningTaskId = next.id;
    // Mission coordination: bind the running queue task so real specialist
    // events attribute to the right mission step (serial execution = exact
    // correlation). Unbound when the task settles.
    this.bindCoordinatorTask?.(next.id);
    this.lastState = 'planning';
    this.emit('scheduler', { runningTaskId: next.id });
    logger.info('scheduler', `Running queue task ${next.id}: ${next.objective.slice(0, 80)}`);
    // Attach the directive context that traveled with THIS queue task
    // (or null — a mission step / plain enqueue never inherits a stale
    // directive from an earlier task).
    this.orchestrator.setDirectiveContext?.(next.directive ?? null);
    this.orchestrator.processMessage(next.objective).catch((error: any) => {
      logger.error('scheduler', `Queue task ${next.id} failed to start: ${error.message}`);
    });
  }

  /** Stop the currently running work (honored at the next loop boundary). */
  stop(): void {
    this.orchestrator.stop();
  }

  clearHistory(): void {
    this.orchestrator.clearHistory();
  }
}