// BLAXIN Lightweight Telemetry
// =============================================================
// Cheap in-memory per-task latency tracking with durable persistence.
// The in-memory ring is the hot path: `record()` is memory-only and the
// disk write happens on a debounced async writer (see telemetry-store.ts),
// so the agent loop never performs synchronous I/O.
//
// Exposed through GET /api/metrics. Instrumentation points are simple
// `Date.now()` deltas recorded at orchestrator phase boundaries.
// =============================================================

import { TelemetryStore } from './telemetry-store.js';

export interface ToolTiming {
  name: string;
  ms: number;
  attempts: number;
  state: string;
}

/**
 * Honest execution route for a task (directive §6):
 *   DETERMINISTIC — resolved by the deterministic fast path, zero model calls
 *   AI_BRAIN      — model reasoning all the way (no fast-path candidate)
 *   HYBRID        — the fast path was tried and FAILED, then the model
 *                   diagnosed/recovered (both layers really ran)
 */
export type ExecutionMode = 'DETERMINISTIC' | 'AI_BRAIN' | 'HYBRID';

/** Derive the execution mode; legacy records without it fall back to `kind`. */
export function executionModeOf(entry: Pick<TaskMetrics, 'kind' | 'executionMode'>): ExecutionMode {
  if (entry.executionMode) return entry.executionMode;
  return entry.kind === 'direct' ? 'DETERMINISTIC' : 'AI_BRAIN';
}

export interface TaskMetrics {
  taskId: string;
  /** How the task was executed: direct (no model) or llm. */
  kind: 'direct' | 'llm';
  /** Explicit three-way route (optional for backward compatibility). */
  executionMode?: ExecutionMode;
  message: string;
  startedAt: number;
  queueWaitMs: number;
  totalMs: number;
  modelCalls: number;
  modelMs: number;
  toolCalls: number;
  /** Total execution waves (incl. solo waves). */
  waves: number;
  /** Waves that ran more than one tool concurrently. */
  parallelWaves: number;
  tools: ToolTiming[];
  result: 'completed' | 'error' | 'stopped' | 'step-limit' | 'no-provider' | 'denied';
}

/** Hard cap for /api/metrics?n= so a single request can never ask for
 * (or receive) an unbounded payload. */
export const METRICS_MAX_TASKS = 200;
export const METRICS_DEFAULT_TASKS = 50;

/** Parse and clamp the ?n= query parameter for the metrics endpoint. */
export function parseMetricsLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return METRICS_DEFAULT_TASKS;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return METRICS_DEFAULT_TASKS;
  return Math.max(1, Math.min(n, METRICS_MAX_TASKS));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return Math.round(sorted[Math.max(0, idx)]);
}

class Telemetry {
  private store = new TelemetryStore();

  /** Record a completed task. Memory-only; persistence is deferred. */
  record(metrics: TaskMetrics): void {
    this.store.record(metrics);
  }

  /** Most recent N completed tasks (newest last). */
  latest(n = 50): TaskMetrics[] {
    return this.store.latest(n);
  }

  /** The slowest completed tasks (by total duration), newest first. */
  slowest(n = 5): TaskMetrics[] {
    return [...this.store.latest(Math.max(n * 5, 25))]
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, n);
  }

  /** Summary statistics over the ring (or the last `n` tasks). */
  summary(n = 50): Record<string, unknown> {
    const samples = this.store.latest(n);
    if (samples.length === 0) {
      return { samples: 0 };
    }

    const total = samples.map((s) => s.totalMs);
    const queue = samples.map((s) => s.queueWaitMs);
    const model = samples.map((s) => s.modelMs);
    const tool = samples.flatMap((s) => s.tools.map((t) => t.ms));

    const byKind = (kind: 'direct' | 'llm') => {
      const ks = samples.filter((s) => s.kind === kind).map((s) => s.totalMs);
      return { count: ks.length, medianMs: Math.round(median(ks)), p95Ms: p95(ks) };
    };

    return {
      samples: samples.length,
      totalMs: { median: Math.round(median(total)), p95: p95(total), min: Math.min(...total), max: Math.max(...total) },
      queueWaitMs: { median: Math.round(median(queue)), p95: p95(queue) },
      modelMs: { median: Math.round(median(model)), p95: p95(model) },
      toolMs: { median: Math.round(median(tool)), p95: p95(tool) },
      modelCalls: samples.reduce((a, s) => a + s.modelCalls, 0),
      toolCalls: samples.reduce((a, s) => a + s.toolCalls, 0),
      totalModelMs: samples.reduce((a, s) => a + s.modelMs, 0),
      totalToolMs: samples.reduce((a, s) => a + s.tools.reduce((x, t) => x + t.ms, 0), 0),
      waves: samples.reduce((a, s) => a + s.waves, 0),
      parallelWaves: samples.reduce((a, s) => a + s.parallelWaves, 0),
      direct: samples.filter((s) => s.kind === 'direct').length,
      llm: samples.filter((s) => s.kind === 'llm').length,
      errors: samples.filter((s) => s.result !== 'completed').length,
      byKind: { direct: byKind('direct'), llm: byKind('llm') },
      // Real route counts — deterministic fast paths vs model reasoning
      // vs the hybrid recovery path (directive §6/§21).
      executionModes: {
        DETERMINISTIC: samples.filter((s) => executionModeOf(s) === 'DETERMINISTIC').length,
        AI_BRAIN: samples.filter((s) => executionModeOf(s) === 'AI_BRAIN').length,
        HYBRID: samples.filter((s) => executionModeOf(s) === 'HYBRID').length,
      },
    };
  }

  /** Persist everything pending. Awaitable; never called from the hot path. */
  flush(): Promise<void> {
    return this.store.flush();
  }

  /** Best-effort synchronous flush for shutdown paths only. */
  flushSync(): void {
    this.store.flushSync();
  }

  reset(): void {
    this.store.reset();
  }
}

export const telemetry = new Telemetry();