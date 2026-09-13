// BLAXIN Mission Journal (§20)
// =============================================================
// The journal is the honest record of what the system actually did: one
// bounded, persisted ring of typed entries derived EXCLUSIVELY from real
// runtime events (no decorative lines, no invented statuses).
//
// Line model (directive §20): timestamp, mission/task id, real runtime
// action id, specialist (the ACTUAL role derived from the executed tool),
// kind (COMMAND/ROUTER/PLAN/ACTION/OBSERVATION/VERIFICATION/RECOVERY/
// MEMORY/RESULT), intended vs actual action, real observation excerpt,
// real verification evidence, retry count, failure reason, recovery, and
// an explicit final status.
//
// Lifecycle rules:
//   - an ACTION entry is CREATED when a tool really starts executing and
//     UPDATED in place when it settles — one line per real action.
//   - a failed action keeps its honest failure reason; a retry adds a
//     RECOVERY line (never a silent retry).
//   - a completed action whose result carries real verification evidence
//     gets a VERIFICATION line with the ACTUAL method/status/detail.
//   - terminal `task-complete` closes the run with a RESULT line carrying
//     the real execution mode and metrics.
// =============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dataPath } from './paths.js';
import { logger } from './logger.js';
import { roleForTool } from '../agency/registry.js';

export type JournalKind =
  | 'COMMAND'
  | 'ROUTER'
  | 'PLAN'
  | 'ACTION'
  | 'OBSERVATION'
  | 'VERIFICATION'
  | 'RECOVERY'
  | 'MEMORY'
  | 'RESULT';

export type JournalStatus =
  | 'INFO'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'
  | 'BLOCKED'
  | 'RECOVERING'
  | 'RECOVERED'
  | 'UNVERIFIED';

export interface JournalVerification {
  method: string;
  status: string;
  detail: string;
}

export interface JournalEntry {
  id: string;
  /** Monotonic sequence — stable ordering even within the same ms. */
  seq: number;
  at: number;
  kind: JournalKind;
  status: JournalStatus;
  /** Real objective/instruction for the run this belongs to. */
  objective?: string;
  missionId?: string;
  taskId?: string;
  /** REAL runtime step id (orchestrator TaskStep.id) — never generated. */
  actionId?: string;
  /** Specialist role derived from the ACTUAL tool that ran. */
  specialist?: string;
  /** Intended action (the real step description). */
  intent?: string;
  /** Actual tool invoked. */
  action?: string;
  /** Real tool output / observed state excerpt. */
  observation?: string;
  /** Real verification evidence when the action produced one. */
  verification?: JournalVerification;
  /** Real retry count observed for this action. */
  retries?: number;
  /** Real failure reason (tool error), when the action failed. */
  failure?: string;
  /** Real recovery action taken after a failure/desync. */
  recovery?: string;
  /** Additional honest detail (routing reason, metrics, counts). */
  detail?: string;
}

const MAX_ENTRIES = 400;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
/** Bounded description cache (step id → real description/objective). */
const MAX_STEP_CACHE = 300;

function newId(): string {
  return `jnl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clip(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

interface StepInfo {
  description: string;
  tool?: string;
  taskId?: string;
  objective?: string;
}

export class MissionJournal {
  private entries: JournalEntry[] = [];
  private byId = new Map<string, JournalEntry>();
  /** actionId (real step id) → the ACTION entry recording it. */
  private actionEntries = new Map<string, string>();
  private steps = new Map<string, StepInfo>();
  private seq = 0;
  private loaded = false;
  private readonly file: string;
  private listener: ((entries: JournalEntry[]) => void) | null = null;

  constructor(options: { filePath?: string } = {}) {
    this.file = options.filePath
      ?? (process.env.BLAXIN_JOURNAL_FILE
        ? dataPath(process.env.BLAXIN_JOURNAL_FILE)
        : dataPath('.blaxin-state', 'journal.json'));
  }

  onChange(cb: (entries: JournalEntry[]) => void): void {
    this.listener = cb;
  }

  // ── Persistence ──────────────────────────────────────────────

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.file)) return;
      if (statSync(this.file).size > MAX_FILE_SIZE) return;
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as JournalEntry[];
      if (!Array.isArray(parsed)) return;
      this.entries = parsed
        .filter((e) => e && typeof e.kind === 'string' && typeof e.at === 'number')
        .slice(-MAX_ENTRIES);
      for (const e of this.entries) this.byId.set(e.id, e);
      this.seq = this.entries.reduce((max, e) => Math.max(max, Number(e.seq) || 0), 0);
    } catch (error: any) {
      logger.warn('journal', `Failed to load journal: ${error.message}`);
    }
  }

  private save(): void {
    try {
      const dir = dataPath('.blaxin-state');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(this.entries), { mode: 0o600 });
    } catch (error: any) {
      logger.error('journal', `Failed to save journal: ${error.message}`);
    }
  }

  private fire(): void {
    if (!this.listener) return;
    try {
      this.listener(this.list());
    } catch (error: any) {
      logger.warn('journal', `Journal listener failed: ${error.message}`);
    }
  }

  // ── Core ─────────────────────────────────────────────────────

  private append(entry: Omit<JournalEntry, 'id' | 'seq' | 'at'>): JournalEntry {
    this.load();
    const full: JournalEntry = {
      id: newId(),
      seq: ++this.seq,
      at: Date.now(),
      ...entry,
    };
    this.entries.push(full);
    this.byId.set(full.id, full);
    if (this.entries.length > MAX_ENTRIES) {
      const dropped = this.entries.shift();
      if (dropped) {
        this.byId.delete(dropped.id);
        for (const [k, v] of this.actionEntries) {
          if (v === dropped.id) this.actionEntries.delete(k);
        }
      }
    }
    this.save();
    this.fire();
    return full;
  }

  private patch(entryId: string, patch: Partial<JournalEntry>): void {
    const entry = this.byId.get(entryId);
    if (!entry) return;
    Object.assign(entry, patch);
    this.save();
    this.fire();
  }

  private rememberStep(id: string, info: StepInfo): void {
    this.steps.set(id, info);
    if (this.steps.size > MAX_STEP_CACHE) {
      const oldest = this.steps.keys().next().value as string | undefined;
      if (oldest) this.steps.delete(oldest);
    }
  }

  /** Newest-first bounded view. */
  list(limit = MAX_ENTRIES): JournalEntry[] {
    this.load();
    const n = Math.max(1, Math.min(Math.floor(limit) || MAX_ENTRIES, MAX_ENTRIES));
    return [...this.entries].reverse().slice(0, n);
  }

  clear(): void {
    this.load();
    this.entries = [];
    this.byId.clear();
    this.actionEntries.clear();
    this.save();
    this.fire();
  }

  // ── Real event ingestion ─────────────────────────────────────

  /**
   * Ingest one real runtime event. Never produces an entry for an event
   * that carries no real information.
   */
  ingest(event: string, data: any): void {
    if (!data || typeof data !== 'object') return;
    switch (event) {
      case 'jarvis-event':          this.onJarvisEvent(data); break;
      case 'task-progress':         this.onTaskProgress(data); break;
      case 'tool-execution':        this.onToolExecution(data); break;
      case 'confirmation-required': this.onConfirmationRequired(data); break;
      case 'memory-selected':       this.onMemorySelected(data); break;
      case 'browser-session':       this.onBrowserSession(data); break;
      case 'mission-progress':      this.onMissionProgress(data); break;
      case 'error':                 this.onError(data); break;
      case 'task-complete':         this.onTaskComplete(data); break;
      default: break;
    }
  }

  /** The REAL routing decision Jarvis made for a user command. */
  private onJarvisEvent(data: any): void {
    if (String(data.kind ?? '') !== 'directive-issued') return;
    const objective = clip(data.goal, 300);
    if (!objective) return;
    this.append({
      kind: 'COMMAND',
      status: 'INFO',
      objective,
      taskId: data.taskId ? String(data.taskId) : undefined,
      detail: data.source === 'voice' ? 'voice' : 'text',
    });
    this.append({
      kind: 'ROUTER',
      status: 'INFO',
      objective,
      taskId: data.taskId ? String(data.taskId) : undefined,
      intent: objective,
      action: clip(data.complexity, 40),
      detail: clip(data.reason, 120),
    });
  }

  /**
   * REAL plan sighting: the first task-progress for a task records the
   * plan and its real step descriptions; those descriptions are what
   * later ACTION lines report as the *intended* action.
   */
  private onTaskProgress(data: any): void {
    const taskId = data.id ? String(data.id) : undefined;
    const objective = clip(data.instruction, 300);
    const steps = Array.isArray(data.steps) ? data.steps : [];
    for (const step of steps) {
      if (step?.id) {
        this.rememberStep(String(step.id), {
          description: clip(step.description, 300) ?? 'action',
          tool: step.toolName ? String(step.toolName) : undefined,
          taskId,
          objective,
        });
      }
    }
    if (taskId && !this.plannedTasks.has(taskId) && steps.length > 0) {
      this.plannedTasks.add(taskId);
      if (this.plannedTasks.size > MAX_STEP_CACHE) {
        const oldest = this.plannedTasks.values().next().value as string | undefined;
        if (oldest) this.plannedTasks.delete(oldest);
      }
      this.append({
        kind: 'PLAN',
        status: 'INFO',
        objective,
        taskId,
        detail: `${steps.length} step(s)`,
      });
    }
  }

  /** Bounded set of tasks whose PLAN line was already recorded. */
  private plannedTasks = new Set<string>();

  private onToolExecution(data: any): void {
    const actionId = data.stepId ? String(data.stepId) : undefined;
    const tool = String(data.toolName ?? 'unknown');
    const state = String(data.state ?? '');
    const info = actionId ? this.steps.get(actionId) : undefined;

    if (state === 'executing') {
      const entry = this.append({
        kind: 'ACTION',
        status: 'RUNNING',
        actionId,
        action: tool,
        specialist: roleForTool(tool),
        taskId: info?.taskId,
        objective: info?.objective,
        intent: info?.description ?? clip(data.description, 300),
        retries: 0,
      });
      if (actionId) this.actionEntries.set(actionId, entry.id);
      return;
    }

    if (state === 'retrying') {
      // A retry is a REAL recovery action — never silent.
      const existing = actionId ? this.actionEntries.get(actionId) : undefined;
      if (existing) {
        const current = this.byId.get(existing);
        this.patch(existing, {
          status: 'RECOVERED',
          retries: (current?.retries ?? 0) + 1,
          recovery: 'bounded retry with backoff',
        });
      }
      this.append({
        kind: 'RECOVERY',
        status: 'RECOVERED',
        actionId,
        action: tool,
        specialist: roleForTool(tool),
        taskId: info?.taskId,
        objective: info?.objective,
        intent: info?.description,
        failure: clip(data.error, 300) ?? 'transient tool error',
        recovery: 'retry with backoff',
      });
      return;
    }

    if (state === 'completed' || state === 'failed' || state === 'skipped') {
      const status: JournalStatus =
        state === 'completed' ? 'COMPLETED' : state === 'failed' ? 'FAILED' : 'SKIPPED';
      const verification = this.readVerification(data.verification);
      const patch: Partial<JournalEntry> = {
        status,
        observation: clip(data.result, 500),
        failure: state === 'completed' ? undefined : clip(data.error, 400),
        verification,
      };
      const existing = actionId ? this.actionEntries.get(actionId) : undefined;
      if (existing) this.patch(existing, patch);
      else {
        // Settled without an observed start (e.g. direct fast path): the
        // real action still belongs in the journal.
        this.append({
          kind: 'ACTION',
          status,
          actionId,
          action: tool,
          specialist: roleForTool(tool),
          taskId: info?.taskId,
          objective: info?.objective,
          intent: info?.description,
          ...patch,
        });
      }
      // A settled action that really returned output IS an observation of
      // the environment — recorded verbatim (bounded), never paraphrased.
      if (patch.observation) {
        this.append({
          kind: 'OBSERVATION',
          status: state === 'completed' ? 'COMPLETED' : 'FAILED',
          actionId,
          action: tool,
          specialist: roleForTool(tool),
          taskId: info?.taskId,
          objective: info?.objective,
          intent: info?.description,
          observation: patch.observation,
        });
      }
      if (verification) {
        this.append({
          kind: 'VERIFICATION',
          status: verification.status === 'SUCCESS' ? 'COMPLETED' : verification.status === 'UNKNOWN' ? 'UNVERIFIED' : 'FAILED',
          actionId,
          action: tool,
          specialist: roleForTool(tool),
          taskId: info?.taskId,
          objective: info?.objective,
          intent: info?.description,
          detail: `${verification.method}: ${verification.detail}`.slice(0, 500),
          verification,
        });
      }
      return;
    }
  }

  /** Read REAL verification evidence off a tool result (never invented). */
  private readVerification(raw: any): JournalVerification | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const method = clip(raw.method, 80);
    const status = clip(raw.status, 20);
    if (!method || !status) return undefined;
    return { method, status, detail: clip(raw.detail, 400) ?? '' };
  }

  private onConfirmationRequired(data: any): void {
    const actionId = data.runtimeStepId ? String(data.runtimeStepId) : (data.stepId ? String(data.stepId) : undefined);
    const info = actionId ? this.steps.get(actionId) : undefined;
    // The real intended action + tool come from the gate payload.
    let tool: string | undefined;
    try {
      const parsed = JSON.parse(String(data.action ?? '{}'));
      if (parsed?.tool) tool = String(parsed.tool);
    } catch { /* malformed payload — recorded without a tool, never guessed */ }
    this.append({
      kind: 'ACTION',
      status: 'BLOCKED',
      actionId,
      action: tool ?? 'unknown',
      specialist: tool ? roleForTool(tool) : undefined,
      taskId: info?.taskId ?? (data.taskId ? String(data.taskId) : undefined),
      objective: info?.objective,
      intent: info?.description ?? clip(data.description, 300),
      failure: 'awaiting user authorization (policy gate)',
    });
  }

  private onMemorySelected(data: any): void {
    const selections = Array.isArray(data.selections) ? data.selections : [];
    if (selections.length === 0) return;
    this.append({
      kind: 'MEMORY',
      status: 'INFO',
      detail: selections
        .slice(0, 6)
        .map((s: any) => `${s.layer ?? '?'}/${s.id ?? '?'} (${s.reason ?? 'relevance'})`)
        .join(', ')
        .slice(0, 400),
    });
  }

  private onBrowserSession(data: any): void {
    const ev = data?.event;
    const type = String(ev?.type ?? '');
    if (type === 'session-desync') {
      this.append({
        kind: 'RECOVERY',
        status: 'RECOVERING',
        specialist: 'BROWSER',
        action: 'browser',
        failure: clip(ev?.detail, 300) ?? 'browser session desync',
        recovery: 'reconnect → reacquire → relaunch (bounded)',
      });
    } else if (type === 'session-recovered') {
      this.append({
        kind: 'RECOVERY',
        status: 'RECOVERED',
        specialist: 'BROWSER',
        action: 'browser',
        recovery: clip(ev?.detail, 300) ?? 'session recovered',
      });
    } else if (type === 'session-lost') {
      this.append({
        kind: 'RECOVERY',
        status: 'FAILED',
        specialist: 'BROWSER',
        action: 'browser',
        failure: clip(ev?.detail, 300) ?? 'browser session lost',
        recovery: 'exhausted — human attention required',
      });
    }
  }

  private onMissionProgress(data: any): void {
    const list = Array.isArray(data.missions) ? data.missions : [];
    for (const mission of list) {
      if (!mission?.id) continue;
      const status = String(mission.status ?? '');
      const last = this.missionStatus.get(String(mission.id));
      if (last === status) continue;
      this.missionStatus.set(String(mission.id), status);
      if (this.missionStatus.size > MAX_STEP_CACHE) {
        const oldest = this.missionStatus.keys().next().value as string | undefined;
        if (oldest) this.missionStatus.delete(oldest);
      }
      const steps = Array.isArray(mission.steps) ? mission.steps : [];
      const done = steps.filter((s: any) => s?.status === 'completed').length;
      this.append({
        kind: 'RESULT',
        status: status === 'completed' ? 'COMPLETED' : status === 'failed' ? 'FAILED' : status === 'cancelled' ? 'SKIPPED' : 'RUNNING',
        missionId: String(mission.id),
        objective: clip(mission.objective, 300),
        detail: `mission ${status} — ${done}/${steps.length} step(s)`,
      });
    }
  }

  private missionStatus = new Map<string, string>();

  private onError(data: any): void {
    const message = clip(data.message, 400);
    if (!message) return;
    this.append({
      kind: 'RESULT',
      status: 'FAILED',
      failure: message,
      detail: clip(data.code, 60),
    });
  }

  private onTaskComplete(data: any): void {
    const mode = data.executionMode ? String(data.executionMode) : undefined;
    const metrics = [
      data.totalMs !== undefined ? `${data.totalMs}ms` : null,
      `${Number(data.modelCalls ?? 0)} model call(s)`,
      `${Number(data.toolCalls ?? 0)} tool call(s)`,
      mode ?? null,
    ].filter(Boolean).join(' · ');
    this.append({
      kind: 'RESULT',
      status: String(data.outcome ?? '') === 'error' ? 'FAILED' : 'COMPLETED',
      taskId: data.taskId ? String(data.taskId) : undefined,
      detail: metrics,
    });
  }
}

export const missionJournal = new MissionJournal();
