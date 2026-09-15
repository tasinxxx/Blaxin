// BLAXIN Task Queue
// =============================================================
// Persistent queue of user goals waiting to be executed by the
// agent. The queue owns *what* should run and *when*; the scheduler
// (index.ts) pumps eligible tasks into the orchestrator one at a
// time and marks them done on real task-complete events.
//
// Semantics:
//   - priority 1..5 (higher runs first), stable ordering within a
//     priority (FIFO by createdAt)
//   - dependencies: a task only becomes eligible when every
//     dependsOn id is in a terminal state (completed/failed/cancelled)
//   - pause/resume per task; a paused task never runs until resumed
//   - state is persisted to disk on every mutation so a restart
//     requeues anything that was queued (running tasks return to
//     'queued' — real progress is preserved by missions/checkpoints)
// =============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dataPath } from './paths.js';
import { logger } from './logger.js';

export type QueueTaskStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface QueueTask {
  id: string;
  objective: string;
  /** 1..5 — higher priority runs first. */
  priority: number;
  status: QueueTaskStatus;
  /** Task ids that must reach a terminal state first. */
  dependsOn: string[];
  /** Optional link back to a mission that spawned this task. */
  missionId?: string;
  /** Optional link to the mission step this task satisfies. */
  missionStepId?: string;
  /** Structured directive context carried from the Jarvis layer. */
  directive?: {
    id: string;
    complexity: string;
    reason: string;
    successCondition?: string;
    source: string;
    /** Bounded shared-mission context (mission coordination; background data). */
    contextBlock?: string;
  };
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** Final assistant reply for completed tasks. */
  result?: string;
  error?: string;
}

export interface TaskQueueOptions {
  /** Override the persistence file (tests use a scratch path). */
  file?: string;
}

const MAX_TASKS = 200;
const MAX_OBJECTIVE = 1000;
const MAX_FILE_SIZE = 4 * 1024 * 1024;

const TERMINAL: QueueTaskStatus[] = ['completed', 'failed', 'cancelled'];

function newId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class TaskQueue {
  private tasks: QueueTask[] = [];
  private loaded = false;
  private readonly file: string;
  private listener: ((tasks: QueueTask[]) => void) | null = null;

  constructor(opts: TaskQueueOptions = {}) {
    this.file = opts.file ?? (process.env.BLAXIN_QUEUE_FILE
      ? dataPath(process.env.BLAXIN_QUEUE_FILE)
      : dataPath('.blaxin-state', 'queue.json'));
  }

  /** Register the single change listener (the scheduler broadcasts). */
  onChange(cb: (tasks: QueueTask[]) => void): void {
    this.listener = cb;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.file)) return;
      const stats = statSync(this.file);
      if (stats.size > MAX_FILE_SIZE) {
        logger.warn('queue', 'Queue file too large, starting fresh');
        return;
      }
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as QueueTask[];
      if (Array.isArray(parsed)) {
        this.tasks = parsed
          .filter((t) => t && typeof t.objective === 'string')
          .map((t) => ({
            ...t,
            // A task that was mid-flight when the process died must not
            // be reported as running forever — requeue it honestly.
            status: t.status === 'running' ? 'queued' : t.status,
            dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
          }))
          .slice(-MAX_TASKS);
      }
    } catch (error: any) {
      logger.warn('queue', `Failed to load queue: ${error.message}`);
    }
  }

  private save(): void {
    try {
      const dir = dataPath('.blaxin-state');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(this.tasks, null, 2), { mode: 0o600 });
    } catch (error: any) {
      logger.error('queue', `Failed to save queue: ${error.message}`);
    }
  }

  private changed(): void {
    this.save();
    this.listener?.([...this.tasks]);
  }

  list(): QueueTask[] {
    this.load();
    return [...this.tasks];
  }

  get(id: string): QueueTask | undefined {
    this.load();
    return this.tasks.find((t) => t.id === id);
  }

  /** Add a task to the queue. Returns the created task. */
  enqueue(opts: {
    objective: string;
    priority?: number;
    dependsOn?: string[];
    missionId?: string;
    missionStepId?: string;
    directive?: QueueTask['directive'];
  }): QueueTask {
    this.load();
    const objective = String(opts.objective || '').trim().slice(0, MAX_OBJECTIVE);
    if (!objective) throw new Error('Objective is required');
    const priority = Math.max(1, Math.min(5, Math.round(opts.priority ?? 3)));
    const task: QueueTask = {
      id: newId(),
      objective,
      priority,
      status: 'queued',
      dependsOn: [...(opts.dependsOn ?? [])],
      missionId: opts.missionId,
      missionStepId: opts.missionStepId,
      directive: opts.directive,
      createdAt: Date.now(),
    };
    this.tasks.push(task);
    if (this.tasks.length > MAX_TASKS) {
      // Drop oldest terminal tasks to keep the file bounded.
      const terminals = this.tasks
        .filter((t) => TERMINAL.includes(t.status))
        .sort((a, b) => a.createdAt - b.createdAt);
      if (terminals.length > 0) this.tasks = this.tasks.filter((t) => t.id !== terminals[0].id);
    }
    this.changed();
    return task;
  }

  /**
   * The next task that may run: queued, all dependencies terminal,
   * highest priority first, oldest within a priority.
   */
  nextEligible(): QueueTask | null {
    this.load();
    const terminalIds = new Set(this.tasks.filter((t) => TERMINAL.includes(t.status)).map((t) => t.id));
    const eligible = this.tasks
      .filter((t) => t.status === 'queued')
      .filter((t) => t.dependsOn.every((d) => terminalIds.has(d)))
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    return eligible[0] ?? null;
  }

  markRunning(id: string): boolean {
    this.load();
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return false;
    task.status = 'running';
    task.startedAt = Date.now();
    this.changed();
    return true;
  }

  markCompleted(id: string, result?: string): boolean {
    this.load();
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return false;
    task.status = 'completed';
    task.result = (result || '').slice(0, 2000);
    task.endedAt = Date.now();
    this.changed();
    return true;
  }

  markFailed(id: string, error?: string): boolean {
    this.load();
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return false;
    task.status = 'failed';
    task.error = (error || 'unknown error').slice(0, 2000);
    task.endedAt = Date.now();
    this.changed();
    return true;
  }

  /** Cancel a queued/running task. Running tasks stop at the next boundary. */
  cancel(id: string): boolean {
    this.load();
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return false;
    if (TERMINAL.includes(task.status)) return false;
    task.status = 'cancelled';
    task.error = 'Cancelled by user';
    task.endedAt = Date.now();
    this.changed();
    return true;
  }

  /** Pause a queued task (running tasks cannot be paused mid-flight). */
  pause(id: string): boolean {
    this.load();
    const task = this.tasks.find((t) => t.id === id);
    if (!task || task.status !== 'queued') return false;
    task.status = 'paused';
    this.changed();
    return true;
  }

  resume(id: string): boolean {
    this.load();
    const task = this.tasks.find((t) => t.id === id);
    if (!task || task.status !== 'paused') return false;
    task.status = 'queued';
    this.changed();
    return true;
  }

  /** Remove a terminal task entirely. */
  remove(id: string): boolean {
    this.load();
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length !== before) {
      this.changed();
      return true;
    }
    return false;
  }

  clear(): void {
    this.load();
    this.tasks = [];
    this.changed();
  }
}