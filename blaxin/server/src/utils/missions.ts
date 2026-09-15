// BLAXIN Missions
// =============================================================
// Persistent multi-step work containers. A mission owns an
// objective, an ordered list of steps, and a checkpoint per
// completed step. Running a mission enqueues each pending step as a
// task in the TaskQueue; when that task completes the scheduler
// records the checkpoint and advances.
//
// Checkpointing / recovery contract:
//   - completed steps keep a checkpoint (when + what was done) and are
//     NEVER re-executed on resume
//   - pause stops enqueuing; resume continues from the first pending
//     step — never from zero
//   - a failed step stays failed; retry resets only failed steps
//   - state survives process restarts (persisted on every mutation)
// =============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dataPath } from './paths.js';
import { logger } from './logger.js';

export type MissionStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type MissionStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface MissionStep {
  id: string;
  description: string;
  status: MissionStepStatus;
  result?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  /** Real checkpoint: when this step finished and what it produced. */
  checkpoint?: {
    completedAt: number;
    summary: string;
  };
  /**
   * The step's REAL verification level (mission coordination), carried
   * from the specialist result that executed it. Absent = no evidence.
   */
  verification?: 'VERIFIED' | 'PARTIAL' | 'UNVERIFIED';
  /** Queue task id that executed this step (filled when enqueued). */
  taskId?: string;
}

export interface Mission {
  id: string;
  objective: string;
  description?: string;
  /** 1..5 — higher priority missions enqueue first. */
  priority: number;
  status: MissionStatus;
  /** 0..1 — completed steps / total steps. */
  progress: number;
  steps: MissionStep[];
  currentStepIndex: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Bounded event log (real events only). */
  history: string[];
  /** Bounded error log. */
  errors: string[];
  /**
   * Honest mission-level verification (mission coordination): derived
   * ONLY from real specialist evidence ingested per step — VERIFIED
   * requires every completed step to carry real verification evidence.
   * Absent/undefined = no evidence ingested yet (honest NONE).
   */
  verification?: 'VERIFIED' | 'PARTIAL' | 'UNVERIFIED';
}

export interface MissionOptions {
  /** Override the persistence file (tests use a scratch path). */
  file?: string;
}

const MAX_MISSIONS = 100;
const MAX_STEPS = 50;
const MAX_LOG = 50;
const MAX_FILE_SIZE = 4 * 1024 * 1024;

const TERMINAL: MissionStatus[] = ['completed', 'failed', 'cancelled'];

function newId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class MissionStore {
  private missions: Mission[] = [];
  private loaded = false;
  private readonly file: string;
  private listener: ((missions: Mission[]) => void) | null = null;

  constructor(opts: MissionOptions = {}) {
    this.file = opts.file ?? (process.env.BLAXIN_MISSIONS_FILE
      ? dataPath(process.env.BLAXIN_MISSIONS_FILE)
      : dataPath('.blaxin-state', 'missions.json'));
  }

  onChange(cb: (missions: Mission[]) => void): void {
    this.listener = cb;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.file)) return;
      const stats = statSync(this.file);
      if (stats.size > MAX_FILE_SIZE) {
        logger.warn('missions', 'Missions file too large, starting fresh');
        return;
      }
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as Mission[];
      if (Array.isArray(parsed)) {
        this.missions = parsed
          .filter((m) => m && typeof m.objective === 'string' && Array.isArray(m.steps))
          .map((m) => ({
            ...m,
            // Mid-flight missions are paused on restart: their completed
            // step checkpoints survive and resume continues from them.
            status: m.status === 'running' ? 'paused' : m.status,
            history: Array.isArray(m.history) ? m.history : [],
            errors: Array.isArray(m.errors) ? m.errors : [],
          }))
          .slice(-MAX_MISSIONS);
      }
    } catch (error: any) {
      logger.warn('missions', `Failed to load missions: ${error.message}`);
    }
  }

  private save(): void {
    try {
      const dir = dataPath('.blaxin-state');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(this.missions, null, 2), { mode: 0o600 });
    } catch (error: any) {
      logger.error('missions', `Failed to save missions: ${error.message}`);
    }
  }

  private changed(): void {
    this.save();
    this.listener?.([...this.missions]);
  }

  private log(m: Mission, message: string, kind: 'history' | 'errors' = 'history'): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    if (kind === 'errors') {
      m.errors.push(line);
      if (m.errors.length > MAX_LOG) m.errors = m.errors.slice(-MAX_LOG);
    } else {
      m.history.push(line);
      if (m.history.length > MAX_LOG) m.history = m.history.slice(-MAX_LOG);
    }
  }

  private recomputeProgress(m: Mission): void {
    if (m.steps.length === 0) {
      m.progress = m.status === 'completed' ? 1 : 0;
      return;
    }
    const done = m.steps.filter((s) => s.status === 'completed').length;
    m.progress = Math.round((done / m.steps.length) * 1000) / 1000;
  }

  list(): Mission[] {
    this.load();
    return [...this.missions];
  }

  get(id: string): Mission | undefined {
    this.load();
    return this.missions.find((m) => m.id === id);
  }

  /** Create a mission. Steps may be empty (auto-decomposed at runtime). */
  create(opts: {
    objective: string;
    description?: string;
    steps?: string[];
    priority?: number;
  }): Mission {
    this.load();
    const objective = String(opts.objective || '').trim().slice(0, 1000);
    if (!objective) throw new Error('Objective is required');
    const mission: Mission = {
      id: newId(),
      objective,
      description: opts.description ? String(opts.description).slice(0, 2000) : undefined,
      priority: Math.max(1, Math.min(5, Math.round(opts.priority ?? 3))),
      status: 'queued',
      progress: 0,
      steps: (opts.steps ?? [])
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, MAX_STEPS)
        .map((s) => ({ id: newId(), description: s.slice(0, 500), status: 'pending' })),
      currentStepIndex: 0,
      createdAt: Date.now(),
      history: [],
      errors: [],
    };
    if (mission.steps.length === 0) {
      // No explicit decomposition: the single step is the objective
      // itself, executed by the agent (which decomposes at runtime).
      mission.steps.push({ id: newId(), description: objective.slice(0, 500), status: 'pending' });
    }
    this.missions.push(mission);
    if (this.missions.length > MAX_MISSIONS) this.missions = this.missions.slice(-MAX_MISSIONS);
    this.changed();
    return mission;
  }

  /** The first pending step of a mission, or null when nothing remains. */
  nextPendingStep(m: Mission): MissionStep | null {
    return m.steps.find((s) => s.status === 'pending') ?? null;
  }

  /** Mark the mission running and return the step to execute now. */
  startOrResume(id: string): { mission: Mission; step: MissionStep } | null {
    this.load();
    const m = this.missions.find((x) => x.id === id);
    if (!m) return null;
    if (TERMINAL.includes(m.status) || m.status === 'paused') return null;
    if (m.status !== 'running') {
      const wasQueued = m.status === 'queued';
      m.status = 'running';
      m.startedAt = m.startedAt ?? Date.now();
      this.log(m, wasQueued ? 'Mission started' : 'Mission resumed');
    }
    const step = this.nextPendingStep(m);
    if (!step) {
      m.status = 'completed';
      m.completedAt = Date.now();
      this.recomputeProgress(m);
      this.log(m, 'Mission completed');
      this.changed();
      return null;
    }
    step.status = 'running';
    step.startedAt = Date.now();
    m.currentStepIndex = m.steps.findIndex((s) => s.id === step.id);
    this.changed();
    return { mission: m, step };
  }

  /**
   * Record a checkpoint for a step. `success: true` marks the step
   * completed and advances; `false` marks it failed (retryable).
   * `verification` attaches the step's REAL verification level (mission
   * coordination); undefined keeps the existing mission-level value.
   */
  settleStep(
    id: string,
    stepId: string,
    outcome: { success: boolean; result?: string; error?: string; verification?: 'VERIFIED' | 'PARTIAL' | 'UNVERIFIED' },
  ): void {
    this.load();
    const m = this.missions.find((x) => x.id === id);
    if (!m) return;
    const step = m.steps.find((s) => s.id === stepId);
    if (!step) return;
    if (outcome.success) {
      step.status = 'completed';
      step.result = (outcome.result || '').slice(0, 2000);
      step.endedAt = Date.now();
      // Mission coordination: the step's REAL verification level is stored
      // ON the step — the mission-level aggregation below reads exactly
      // this field, so an ingested level must never be dropped here.
      if (outcome.verification) step.verification = outcome.verification;
      step.checkpoint = {
        completedAt: Date.now(),
        summary: (outcome.result || step.description).slice(0, 500),
      };
      this.log(m, `Step completed: ${step.description}`);
    } else {
      step.status = 'failed';
      step.error = (outcome.error || 'unknown error').slice(0, 2000);
      step.endedAt = Date.now();
      this.log(m, `Step failed: ${step.description} — ${step.error}`, 'errors');
    }

    this.recomputeProgress(m);

    // Mission-level verification (mission coordination): recomputed from
    // the per-step REAL verification levels at every step settlement.
    // UNVERIFIED stays UNVERIFIED — never upgraded.
    const completedSteps = m.steps.filter((s) => s.status === 'completed');
    if (completedSteps.length === 0) {
      delete m.verification;
    } else if (completedSteps.every((s) => s.verification === 'VERIFIED')) {
      m.verification = 'VERIFIED';
    } else if (completedSteps.some((s) => s.verification === 'VERIFIED' || s.verification === 'PARTIAL')) {
      m.verification = 'PARTIAL';
    } else {
      m.verification = 'UNVERIFIED';
    }

    // Completion check.
    const remaining = m.steps.filter((s) => s.status === 'pending' || s.status === 'running');
    if (remaining.length === 0) {
      const failed = m.steps.some((s) => s.status === 'failed');
      m.status = failed ? 'failed' : 'completed';
      if (m.status === 'completed') m.completedAt = Date.now();
      this.log(m, `Mission ${m.status}${m.verification ? ` — verification ${m.verification}` : ''}`);
    }
    this.changed();
  }

  pause(id: string): boolean {
    this.load();
    const m = this.missions.find((x) => x.id === id);
    if (!m || TERMINAL.includes(m.status)) return false;
    m.status = 'paused';
    this.log(m, 'Mission paused (completed steps are checkpointed)');
    this.changed();
    return true;
  }

  resume(id: string): boolean {
    this.load();
    const m = this.missions.find((x) => x.id === id);
    if (!m || m.status !== 'paused') return false;
    m.status = 'queued';
    this.log(m, 'Mission resumed — continuing from last checkpoint');
    this.changed();
    return true;
  }

  /** Reset failed steps back to pending so the mission can be retried. */
  retry(id: string): boolean {
    this.load();
    const m = this.missions.find((x) => x.id === id);
    if (!m) return false;
    let touched = false;
    for (const step of m.steps) {
      if (step.status === 'failed') {
        step.status = 'pending';
        step.error = undefined;
        step.endedAt = undefined;
        step.taskId = undefined;
        touched = true;
      }
    }
    if (touched) {
      m.status = 'queued';
      this.recomputeProgress(m);
      this.log(m, 'Mission retried — failed steps requeued');
      this.changed();
    }
    return touched;
  }

  cancel(id: string): boolean {
    this.load();
    const m = this.missions.find((x) => x.id === id);
    if (!m || TERMINAL.includes(m.status)) return false;
    m.status = 'cancelled';
    m.completedAt = Date.now();
    this.log(m, 'Mission cancelled');
    this.changed();
    return true;
  }

  remove(id: string): boolean {
    this.load();
    const before = this.missions.length;
    this.missions = this.missions.filter((m) => m.id !== id);
    if (this.missions.length !== before) {
      this.changed();
      return true;
    }
    return false;
  }

  clear(): void {
    this.load();
    this.missions = [];
    this.changed();
  }
}