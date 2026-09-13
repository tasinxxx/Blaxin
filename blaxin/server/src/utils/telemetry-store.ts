// BLAXIN Persistent Telemetry Store
// =============================================================
// The in-memory telemetry ring (see telemetry.ts) is the hot path:
// `record()` only touches memory and enqueues. Persistence happens on a
// debounced, asynchronous writer so the agent loop NEVER performs
// synchronous disk I/O.
//
//   task completes → record() (memory only)
//                 → enqueue + debounce timer
//                 → async write to telemetry.json.tmp
//                 → atomic rename over telemetry.json
//
// Persisted records are sanitized (no user prompts, no secrets) and the
// file is bounded by a configurable record cap. Malformed storage is
// never fatal: the corrupt file is backed up and telemetry restarts
// cleanly so the agent keeps working.
// =============================================================

import { readFileSync, renameSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { writeFile, rename, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { dataPath } from './paths.js';
import { logger } from './logger.js';
import type { TaskMetrics, ToolTiming } from './telemetry.js';

export interface TelemetryStoreOptions {
  /** JSON file the ring is persisted to (default: data dir telemetry file). */
  filePath?: string;
  /** Maximum records kept in memory and on disk (default: env or 2000). */
  maxRecords?: number;
  /** Debounce window for the batched writer (default: env or 2000ms). */
  flushMs?: number;
}

const DEFAULT_MAX_RECORDS = 2000;
const DEFAULT_FLUSH_MS = 2000;
const CORRUPT_BACKUP_SUFFIX = '.corrupt';

/** The only fields ever written to disk — explicit allowlist, so no
 * prompt text, args, or anything added to TaskMetrics later can leak. */
const PERSISTED_FIELDS = [
  'taskId',
  'kind',
  'executionMode',
  'startedAt',
  'queueWaitMs',
  'totalMs',
  'modelCalls',
  'modelMs',
  'toolCalls',
  'waves',
  'parallelWaves',
  'tools',
  'result',
] as const;

function isToolTiming(value: unknown): value is ToolTiming {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return typeof t.name === 'string' && typeof t.ms === 'number' &&
    typeof t.attempts === 'number' && typeof t.state === 'string';
}

/** Sanitize one task for disk: keep only allowlisted, shape-checked fields. */
export function toPersistedTask(entry: TaskMetrics): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of PERSISTED_FIELDS) {
    const value = (entry as unknown as Record<string, unknown>)[field];
    if (value !== undefined) out[field] = value;
  }
  if (Array.isArray(out.tools)) {
    out.tools = out.tools.filter(isToolTiming);
  }
  return out;
}

/** Validate one decoded record — junk entries are dropped, never trusted. */
function sanitizeLoadedTask(value: unknown): TaskMetrics | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.taskId !== 'string' || typeof raw.startedAt !== 'number') return null;
  if (raw.kind !== 'direct' && raw.kind !== 'llm') return null;
  if (typeof raw.totalMs !== 'number') return null;

  const tools = Array.isArray(raw.tools) ? raw.tools.filter(isToolTiming) : [];
  const mode = raw.executionMode;
  const executionMode =
    mode === 'DETERMINISTIC' || mode === 'AI_BRAIN' || mode === 'HYBRID' ? mode : undefined;
  return {
    taskId: raw.taskId,
    kind: raw.kind,
    executionMode,
    // User prompts are never persisted (see PERSISTED_FIELDS); a loaded
    // record therefore has no message. The metrics API strips it anyway.
    message: '',
    startedAt: raw.startedAt,
    queueWaitMs: typeof raw.queueWaitMs === 'number' ? raw.queueWaitMs : 0,
    totalMs: raw.totalMs,
    modelCalls: typeof raw.modelCalls === 'number' ? raw.modelCalls : 0,
    modelMs: typeof raw.modelMs === 'number' ? raw.modelMs : 0,
    toolCalls: typeof raw.toolCalls === 'number' ? raw.toolCalls : 0,
    waves: typeof raw.waves === 'number' ? raw.waves : 0,
    parallelWaves: typeof raw.parallelWaves === 'number' ? raw.parallelWaves : 0,
    tools,
    result: (raw.result as TaskMetrics['result']) || 'completed',
  };
}

function defaultFile(): string {
  const override = process.env.BLAXIN_TELEMETRY_FILE;
  if (override && override.trim()) {
    return dataPath(override);
  }
  return dataPath('.blaxin-state', 'telemetry.json');
}

function defaultMaxRecords(): number {
  const raw = Number(process.env.BLAXIN_TELEMETRY_MAX_RECORDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_RECORDS;
}

function defaultFlushMs(): number {
  const raw = Number(process.env.BLAXIN_TELEMETRY_FLUSH_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_FLUSH_MS;
}

export class TelemetryStore {
  private ring: TaskMetrics[] = [];
  private pending: TaskMetrics[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  readonly filePath: string;
  readonly maxRecords: number;
  readonly flushMs: number;

  constructor(options: TelemetryStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultFile();
    this.maxRecords = options.maxRecords ?? defaultMaxRecords();
    this.flushMs = options.flushMs ?? defaultFlushMs();
    this.ring = this.load();
  }

  // ── Hot path ─────────────────────────────────────────────────

  /** Record a completed task. Memory-only; persistence is deferred. */
  record(entry: TaskMetrics): void {
    this.ring.push(entry);
    if (this.ring.length > this.maxRecords) {
      this.ring.splice(0, this.ring.length - this.maxRecords);
    }
    this.pending.push(entry);
    this.scheduleFlush();
  }

  /** Most recent N records (newest last). */
  latest(n = 50): TaskMetrics[] {
    const count = Math.max(1, Math.min(Math.floor(n) || 1, this.ring.length));
    return this.ring.slice(-count);
  }

  /** Drop everything in memory and cancel any pending write. The file is
   * left untouched; a later flush rewrites it from the (now empty) ring. */
  reset(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.ring = [];
    this.pending = [];
  }

  // ── Persistence (never called from the agent hot path) ───────

  /** Asynchronously persist everything recorded so far. Serialized via a
   * promise chain so concurrent flushes can never interleave writes. */
  flush(): Promise<void> {
    if (this.pending.length > 0) {
      this.writeChain = this.writeChain.then(() => this.drain());
    }
    return this.writeChain;
  }

  /** Best-effort synchronous flush, for shutdown paths only (SIGINT etc.).
   * Never used on the agent hot path. */
  flushSync(): void {
    try {
      this.drainSync();
    } catch (error: any) {
      logger.error('telemetry', `Failed to flush telemetry: ${error.message}`);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    // Batch threshold: many quick tasks (e.g. a burst) flush early instead
    // of waiting out the full debounce window.
    if (this.pending.length >= Math.max(10, Math.floor(this.maxRecords / 4))) {
      void this.flush();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushMs);
  }

  private async drain(): Promise<void> {
    if (this.pending.length === 0) return;
    this.pending = [];
    try {
      await this.writeRing();
    } catch (error: any) {
      // Persistence must never break task execution — log and move on.
      logger.error('telemetry', `Failed to persist telemetry: ${error.message}`);
    }
  }

  private drainSync(): void {
    if (this.pending.length === 0) return;
    this.pending = [];
    this.writeRingSync();
  }

  /** Atomic async write: temp file + rename. */
  private async writeRing(): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = await this.tempPath();
    await writeFile(tmp, JSON.stringify(this.ring.map(toPersistedTask)), { mode: 0o600 });
    await rename(tmp, this.filePath);
  }

  private writeRingSync(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `telemetry.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.ring.map(toPersistedTask)), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  /** Temp file in the same directory so rename() stays atomic (same fs). */
  private async tempPath(): Promise<string> {
    const dir = dirname(this.filePath);
    return join(dir, `telemetry.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  }

  // ── Startup load ─────────────────────────────────────────────

  private load(): TaskMetrics[] {
    try {
      if (!existsSync(this.filePath)) return [];
      const stats = statSync(this.filePath);
      // Defense in depth: never read an absurdly large file.
      if (stats.size > 50 * 1024 * 1024) {
        this.backupCorrupt('file exceeds 50MB safety cap');
        return [];
      }
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this.backupCorrupt('root value is not an array');
        return [];
      }
      const valid = parsed.map(sanitizeLoadedTask).filter((t): t is TaskMetrics => t !== null);
      if (valid.length !== parsed.length) {
        logger.warn('telemetry', `Dropped ${parsed.length - valid.length} malformed telemetry records during load`);
      }
      return valid.slice(-this.maxRecords);
    } catch (error: any) {
      this.backupCorrupt(error.message);
      return [];
    }
  }

  /** Preserve the unreadable file (never silently overwrite evidence) and
   * restart the ring cleanly. The agent keeps working either way. */
  private backupCorrupt(reason: string): void {
    logger.warn('telemetry', `Telemetry storage unreadable (${reason}); starting fresh`);
    try {
      if (existsSync(this.filePath)) {
        const backup = `${this.filePath}.${CORRUPT_BACKUP_SUFFIX}.${Date.now()}`;
        renameSync(this.filePath, backup);
      }
    } catch (error: any) {
      logger.error('telemetry', `Failed to back up corrupt telemetry file: ${error.message}`);
    }
  }
}