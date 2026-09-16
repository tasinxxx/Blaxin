// BLAXIN Layered Memory Runtime (§20+ — memory phase)
// =============================================================
// The flat MemoryStore (utils/memory.ts) keeps user notes + failure
// lessons. This module adds the memory LAYERS the directive requires
// as first-class, persistent, inspectable stores:
//
//   FAILURE MEMORY      verified failures, causes, recoveries,
//                       recurrence counts (learning loop)
//   ENVIRONMENT MEMORY  observed computer/browser facts with
//                       volatility classes; FRESH OBSERVATIONS
//                       OVERRIDE STALE MEMORY (§24)
//   EPISODIC MEMORY     bounded past-task episodes (what worked,
//                       what failed, lessons) — never raw transcripts
//   PROCEDURAL MEMORY   reusable how-to procedures, VERSIONED and
//                       REVERSIBLE (rollback keeps the evidence)
//
// Safety rules (enforced here, not by callers):
//   - EVERY persisted string passes redactSecrets()/redactDeep() and a
//     final looksSensitive() gate BEFORE the write — passwords, API
//     keys, tokens, cookies, private keys and credentials never enter
//     memory. Secret-looking values are refused (never stored).
//   - Content is bounded per field and per store (no raw tool dumps).
//   - Provenance (where/when observed) + confidence (0..1, honest
//     defaults) ride on every record.
//   - Corrupted/invalid files degrade to an empty store with a warning
//     — memory failures never take the agent down.
// =============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dataPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';
import { looksSensitive, redactSecrets, redactDeep } from '../utils/memory.js';

// ── Shared record shape ─────────────────────────────────────────

export type MemorySource = 'agent' | 'user' | 'system' | 'mission' | 'browser-session';

export interface Provenance {
  source: MemorySource;
  /** Real runtime reference (task/mission/tool id) when one exists. */
  ref?: string;
  observedAt: number;
}

interface RecordBase {
  id: string;
  createdAt: number;
  updatedAt: number;
  confidence: number;
  provenance: Provenance;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Lowercase, digit-free, whitespace-collapsed similarity key. */
function simKey(text: string, max = 140): string {
  return String(text || '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^a-z#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanText(text: string, max: number): string {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(items: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((s) => cleanText(String(s ?? ''), maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

/** Distinct lowercase word tokens len>2 (for relevance matching). */
export function tokens(text: string): string[] {
  return [...new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  )];
}

/** Jaccard-style overlap count between two token sets. */
export function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  return a.filter((w) => setB.has(w)).length;
}

// ── Failure memory ──────────────────────────────────────────────

export interface FailureRecord extends RecordBase {
  kind: 'failure';
  /** e.g. the tool name ('browser', 'terminal') or 'task'. */
  category: string;
  /** What was attempted (normalized for similarity matching). */
  failedAction: string;
  /** Observed error/failure evidence, bounded. */
  observation: string;
  /** Probable cause, when diagnosed. */
  cause?: string;
  /** The recovery that worked, when one did. */
  recovery?: { description: string; at: number };
  finalResult: 'unresolved' | 'recovered';
  /** How many times this failure pattern recurred. */
  occurrences: number;
  lastSeenAt: number;
  taskId?: string;
}

export interface FailureInput {
  category: string;
  failedAction: string;
  observation: string;
  cause?: string;
  taskId?: string;
  source?: MemorySource;
  ref?: string;
}

const MAX_FAILURES = 100;
const MAX_FAILURE_RECURRENCE_SCORE = 0.9;

class FailureMemory {
  private records: FailureRecord[] = [];

  private find(input: FailureInput): FailureRecord | undefined {
    const key = simKey(input.failedAction);
    if (!key) return undefined;
    return this.records.find(
      (r) => r.category === input.category && simKey(r.failedAction) === key,
    );
  }

  /** Record (or reinforce) a failure pattern. Returns the stored record. */
  record(input: FailureInput, now = Date.now()): FailureRecord | null {
    const failedAction = cleanText(input.failedAction, 200);
    const observation = cleanText(input.observation, 300);
    if (!failedAction || !observation) return null;
    if (looksSensitive(`${failedAction} ${observation} ${input.cause ?? ''}`)) {
      logger.warn('memory-layers', 'Refusing failure record that looks like a secret');
      return null;
    }

    const category = cleanText(input.category, 60) || 'task';
    const existing = this.find(input);
    if (existing) {
      // Recurrence: keep the richer evidence, bump the counter.
      existing.occurrences += 1;
      existing.lastSeenAt = now;
      existing.updatedAt = now;
      existing.observation = observation || existing.observation;
      if (input.cause) existing.cause = cleanText(input.cause, 200);
      existing.confidence = clamp(existing.confidence + 0.05, 0, 0.95);
      return existing;
    }

    const record: FailureRecord = {
      id: newId('fail'),
      kind: 'failure',
      category,
      failedAction,
      observation,
      cause: input.cause ? cleanText(input.cause, 200) : undefined,
      finalResult: 'unresolved',
      occurrences: 1,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
      confidence: 0.5,
      provenance: { source: input.source ?? 'agent', ref: input.ref, observedAt: now },
      taskId: input.taskId,
    };
    this.records.push(record);
    if (this.records.length > MAX_FAILURES) {
      this.records.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      this.records.length = MAX_FAILURES;
    }
    return record;
  }

  /**
   * Learning loop: a recovery VERIFIED to work for a known failure
   * pattern raises confidence and marks it recovered (never hidden —
   * the failure evidence stays).
   */
  recoverySucceeded(input: FailureInput, recovery: string, now = Date.now()): FailureRecord | null {
    const record = this.record(input, now);
    if (!record) return null;
    const desc = cleanText(recovery, 300);
    if (!desc || looksSensitive(desc)) return record;
    record.recovery = { description: desc, at: now };
    record.finalResult = 'recovered';
    record.updatedAt = now;
    record.confidence = clamp(record.confidence + 0.15, 0, 0.95);
    return record;
  }

  /**
   * Failure patterns relevant to an objective, scored by recurrence
   * and recency. Prefer patterns with a KNOWN recovery — "what worked
   * last time" is the point (failure-memory SKILL.md).
   */
  relevant(objective: string, limit = 3, now = Date.now()): Array<FailureRecord & { score: number }> {
    const obj = tokens(objective);
    const scored = this.records
      .map((r) => {
        const overlap = tokenOverlap(obj, tokens(`${r.failedAction} ${r.observation} ${r.category}`));
        const daysSince = (now - r.lastSeenAt) / 86_400_000;
        const recency = Math.max(0, 1 - daysSince / 14);
        const score =
          Math.min(r.occurrences * 0.15, MAX_FAILURE_RECURRENCE_SCORE) * 0.5 +
          recency * 0.3 +
          Math.min(overlap * 0.1, 0.4);
        return { ...r, score: Math.round(score * 1000) / 1000 };
      })
      .filter((r) => r.score >= 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored;
  }

  /** Recurrence stats for diagnostics (category → total occurrences). */
  stats(): Array<{ category: string; patterns: number; occurrences: number }> {
    const byCat = new Map<string, { patterns: number; occurrences: number }>();
    for (const r of this.records) {
      const cur = byCat.get(r.category) ?? { patterns: 0, occurrences: 0 };
      cur.patterns += 1;
      cur.occurrences += r.occurrences;
      byCat.set(r.category, cur);
    }
    return [...byCat.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.occurrences - a.occurrences);
  }

  list(): FailureRecord[] {
    return [...this.records].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  remove(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    return this.records.length !== before;
  }

  /** Hydrate from (possibly corrupt) persisted data. */
  hydrate(raw: unknown): void {
    this.records = sanitizeArray(raw, MAX_FAILURES, (r) =>
      r && typeof r.failedAction === 'string' && typeof r.observation === 'string'
        ? {
            id: typeof r.id === 'string' ? r.id : newId('fail'),
            kind: 'failure' as const,
            category: cleanText(String(r.category ?? 'task'), 60) || 'task',
            failedAction: cleanText(r.failedAction, 200),
            observation: cleanText(r.observation, 300),
            cause: typeof r.cause === 'string' ? cleanText(r.cause, 200) : undefined,
            recovery:
              r.recovery && typeof r.recovery.description === 'string'
                ? { description: cleanText(r.recovery.description, 300), at: Number(r.recovery.at) || Date.now() }
                : undefined,
            finalResult: r.finalResult === 'recovered' ? ('recovered' as const) : ('unresolved' as const),
            occurrences: clamp(Math.floor(Number(r.occurrences)) || 1, 1, 10_000),
            lastSeenAt: Number(r.lastSeenAt) || Date.now(),
            taskId: typeof r.taskId === 'string' ? r.taskId : undefined,
            createdAt: Number(r.createdAt) || Date.now(),
            updatedAt: Number(r.updatedAt) || Date.now(),
            confidence: clamp(Number(r.confidence) || 0.5, 0, 0.95),
            provenance: sanitizeProvenance(r.provenance),
          }
        : null,
    );
  }

  dump(): FailureRecord[] {
    return this.records;
  }
}

// ── Environment memory ──────────────────────────────────────────

export type Volatility = 'stable' | 'semi-stable' | 'volatile';

export interface EnvironmentRecord extends RecordBase {
  kind: 'environment';
  key: string;
  value: string;
  volatility: Volatility;
  /** How many consecutive observations confirmed the same value. */
  confirmations: number;
}

export interface EnvironmentInput {
  key: string;
  value: string;
  volatility: Volatility;
  source?: MemorySource;
  ref?: string;
}

const MAX_ENVIRONMENT = 60;
/** Freshness windows per volatility class (§24). */
const FRESH_WINDOWS_MS: Record<Volatility, number> = {
  stable: 7 * 86_400_000,
  'semi-stable': 24 * 3_600_000,
  volatile: 5 * 60_000,
};

class EnvironmentMemory {
  private records: EnvironmentRecord[] = [];

  /**
   * Record a DIRECTLY OBSERVED environment fact. Fresh observations
   * always win over stored values (contradiction rule §24): the same
   * key with a different value REPLACES the stale entry; the same
   * value confirms and raises confidence.
   */
  observe(input: EnvironmentInput, now = Date.now()): EnvironmentRecord | null {
    const key = cleanText(input.key, 80).toLowerCase().replace(/\s+/g, '-');
    const value = cleanText(input.value, 300);
    if (!key || !value) return null;
    if (looksSensitive(`${key} ${value}`)) {
      logger.warn('memory-layers', `Refusing environment observation that looks like a secret (${key})`);
      return null;
    }
    const volatility: Volatility = FRESH_WINDOWS_MS[input.volatility] ? input.volatility : 'semi-stable';

    const existing = this.records.find((r) => r.key === key);
    if (existing) {
      if (existing.value === value) {
        // Re-confirmed: same value observed again → confidence rises.
        existing.confirmations += 1;
        existing.confidence = clamp(existing.confidence + 0.05, 0, 0.95);
        existing.updatedAt = now;
        existing.provenance = { source: input.source ?? 'agent', ref: input.ref, observedAt: now };
        return existing;
      }
      // FRESH OBSERVATION OVERRIDES STALE MEMORY.
      existing.value = value;
      existing.volatility = volatility;
      existing.confirmations = 1;
      existing.confidence = 0.6; // fresh single observation — honest, not inherited
      existing.updatedAt = now;
      existing.provenance = { source: input.source ?? 'agent', ref: input.ref, observedAt: now };
      return existing;
    }

    const record: EnvironmentRecord = {
      id: newId('env'),
      kind: 'environment',
      key,
      value,
      volatility,
      confirmations: 1,
      createdAt: now,
      updatedAt: now,
      confidence: 0.6,
      provenance: { source: input.source ?? 'agent', ref: input.ref, observedAt: now },
    };
    this.records.push(record);
    if (this.records.length > MAX_ENVIRONMENT) {
      this.records.sort((a, b) => b.updatedAt - a.updatedAt);
      this.records.length = MAX_ENVIRONMENT;
    }
    return record;
  }

  get(key: string): EnvironmentRecord | null {
    const k = cleanText(key, 80).toLowerCase().replace(/\s+/g, '-');
    return this.records.find((r) => r.key === k) ?? null;
  }

  /**
   * Freshness verdict for a stored fact: 'unknown' (not stored),
   * 'stale' (older than its volatility window — MUST re-observe
   * before relying on it) or 'fresh'.
   */
  freshness(key: string, now = Date.now()): 'unknown' | 'stale' | 'fresh' {
    const record = this.get(key);
    if (!record) return 'unknown';
    return now - record.provenance.observedAt > FRESH_WINDOWS_MS[record.volatility]
      ? 'stale'
      : 'fresh';
  }

  /** Explicit invalidation (obsolete memory must be droppable). */
  invalidate(key: string): boolean {
    const k = cleanText(key, 80).toLowerCase().replace(/\s+/g, '-');
    const before = this.records.length;
    this.records = this.records.filter((r) => r.key !== k);
    return this.records.length !== before;
  }

  /** Entries whose key/value shares tokens with the query. */
  relevant(query: string, limit = 4): EnvironmentRecord[] {
    const q = tokens(query);
    if (q.length === 0) return [];
    return this.records
      // The key is stored dash-joined ('browser-page'); tokens() keeps the
      // dash, so match on BOTH the raw key and its de-dashed form.
      .map((r) => ({ r, hits: tokenOverlap(q, [...tokens(`${r.key} ${r.value}`), ...tokens(r.key.replace(/-/g, ' '))]) }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit)
      .map((x) => x.r);
  }

  list(): EnvironmentRecord[] {
    return [...this.records];
  }

  remove(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    return this.records.length !== before;
  }

  hydrate(raw: unknown): void {
    this.records = sanitizeArray(raw, MAX_ENVIRONMENT, (r) =>
      r && typeof r.key === 'string' && typeof r.value === 'string'
        ? {
            id: typeof r.id === 'string' ? r.id : newId('env'),
            kind: 'environment' as const,
            key: cleanText(r.key, 80).toLowerCase().replace(/\s+/g, '-'),
            value: cleanText(r.value, 300),
            volatility: (['stable', 'semi-stable', 'volatile'] as Volatility[]).includes(r.volatility)
              ? r.volatility
              : 'semi-stable',
            confirmations: clamp(Math.floor(Number(r.confirmations)) || 1, 1, 10_000),
            createdAt: Number(r.createdAt) || Date.now(),
            updatedAt: Number(r.updatedAt) || Date.now(),
            confidence: clamp(Number(r.confidence) || 0.6, 0, 0.95),
            provenance: sanitizeProvenance(r.provenance),
          }
        : null,
    );
  }

  dump(): EnvironmentRecord[] {
    return this.records;
  }
}

// ── Episodic memory ─────────────────────────────────────────────

export interface EpisodeRecord extends RecordBase {
  kind: 'episode';
  objective: string;
  outcome: 'success' | 'failure' | 'partial';
  /** Stable environment context the episode depended on. */
  environment: string[];
  /** What worked / what failed, bounded — NEVER raw transcripts. */
  strategy: string;
  lessons: string[];
  verified: boolean;
  taskId?: string;
  missionId?: string;
}

export interface EpisodeInput {
  objective: string;
  outcome: 'success' | 'failure' | 'partial';
  environment?: string[];
  strategy?: string;
  lessons?: string[];
  verified?: boolean;
  taskId?: string;
  missionId?: string;
  source?: MemorySource;
  ref?: string;
}

const MAX_EPISODES = 60;

/** Drop lessons/strategy text that still looks sensitive after redaction. */
function sanitizeSensitiveStrings(items: string[]): string[] {
  return items
    .map((s) => redactSecrets(s))
    .filter((s) => s.trim().length > 0 && !looksSensitive(s));
}

class EpisodicMemory {
  private records: EpisodeRecord[] = [];

  record(input: EpisodeInput, now = Date.now()): EpisodeRecord | null {
    const objective = cleanText(input.objective, 300);
    if (!objective) return null;

    const environment = sanitizeSensitiveStrings(cleanList(input.environment, 5, 120));
    const strategyRaw = cleanText(input.strategy ?? '', 500);
    const strategy = sanitizeSensitiveStrings(strategyRaw ? [strategyRaw] : [])[0] ?? '';
    const lessons = sanitizeSensitiveStrings(cleanList(input.lessons, 3, 200));

    const episode: EpisodeRecord = {
      id: newId('ep'),
      kind: 'episode',
      objective,
      outcome: ['success', 'failure', 'partial'].includes(input.outcome) ? input.outcome : 'partial',
      environment,
      strategy,
      lessons,
      verified: input.verified === true,
      taskId: input.taskId,
      missionId: input.missionId,
      createdAt: now,
      updatedAt: now,
      // Confidence: verified outcomes are evidence; unverified ones are
      // weaker (episodic-memory SKILL.md).
      confidence: input.verified ? (input.outcome === 'success' ? 0.8 : 0.65) : 0.5,
      provenance: { source: input.source ?? 'agent', ref: input.ref ?? input.taskId, observedAt: now },
    };
    this.records.push(episode);
    if (this.records.length > MAX_EPISODES) {
      this.records = this.records.slice(-MAX_EPISODES);
    }
    return episode;
  }

  /** Episodes relevant to an objective by task similarity. */
  relevant(objective: string, limit = 2): Array<EpisodeRecord & { score: number }> {
    const obj = tokens(objective);
    return this.records
      .map((r) => ({
        ...r,
        score:
          tokenOverlap(obj, tokens(r.objective)) * 0.2 +
          tokenOverlap(obj, tokens(r.environment.join(' '))) * 0.1,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  list(): EpisodeRecord[] {
    return [...this.records];
  }

  remove(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    return this.records.length !== before;
  }

  hydrate(raw: unknown): void {
    this.records = sanitizeArray(raw, MAX_EPISODES, (r) =>
      r && typeof r.objective === 'string'
        ? {
            id: typeof r.id === 'string' ? r.id : newId('ep'),
            kind: 'episode' as const,
            objective: cleanText(r.objective, 300),
            outcome: ['success', 'failure', 'partial'].includes(r.outcome) ? r.outcome : 'partial',
            environment: cleanList(r.environment, 5, 120),
            strategy: typeof r.strategy === 'string' ? cleanText(r.strategy, 500) : '',
            lessons: cleanList(r.lessons, 3, 200),
            verified: r.verified === true,
            taskId: typeof r.taskId === 'string' ? r.taskId : undefined,
            missionId: typeof r.missionId === 'string' ? r.missionId : undefined,
            createdAt: Number(r.createdAt) || Date.now(),
            updatedAt: Number(r.updatedAt) || Date.now(),
            confidence: clamp(Number(r.confidence) || 0.5, 0, 0.95),
            provenance: sanitizeProvenance(r.provenance),
          }
        : null,
    );
  }

  dump(): EpisodeRecord[] {
    return this.records;
  }
}

// ── Procedural memory (versioned + reversible) ──────────────────

export interface ProcedureRecord extends RecordBase {
  kind: 'procedure';
  name: string;
  purpose: string;
  steps: string[];
  /** Words that should trigger retrieval for a similar objective. */
  triggerTags: string[];
  version: number;
  status: 'active' | 'rolled_back';
  successCount: number;
  failureCount: number;
  lastValidatedAt: number;
  versionHistory: Array<{ version: number; changedAt: number; reason: string }>;
}

export interface ProcedureInput {
  name: string;
  purpose: string;
  steps: string[];
  triggerTags?: string[];
  taskId?: string;
  source?: MemorySource;
  ref?: string;
}

export interface ProcedureOutcome {
  promoted: boolean;
  reason: string;
  procedure: ProcedureRecord | null;
}

const MAX_PROCEDURES = 40;
/** A procedure that failed more than it succeeded gets disabled —
 *  reversible, with the failure evidence preserved (skill-learning
 *  SKILL.md rollback rule). */
const ROLLBACK_THRESHOLD = 2;

class ProceduralMemory {
  private records: ProcedureRecord[] = [];

  private find(name: string): ProcedureRecord | undefined {
    const key = simKey(name, 80);
    return this.records.find((r) => simKey(r.name, 80) === key);
  }

  /**
   * Promotion pipeline gate: ONLY a VERIFIED successful workflow is
   * promoted (procedural-memory SKILL.md). A same-named procedure
   * gains confidence from repeated verified success.
   */
  recordIfVerified(input: ProcedureInput, verified: boolean, now = Date.now()): ProcedureOutcome {
    if (!verified) {
      return { promoted: false, reason: 'not verified — promotion requires verified success', procedure: null };
    }
    const name = cleanText(input.name, 120);
    const steps = cleanList(input.steps, 10, 200);
    if (!name || steps.length === 0) {
      return { promoted: false, reason: 'missing name or steps', procedure: null };
    }
    if (looksSensitive(`${name} ${input.purpose ?? ''} ${steps.join(' ')}`)) {
      logger.warn('memory-layers', 'Refusing procedure that looks like a secret');
      return { promoted: false, reason: 'content looks sensitive', procedure: null };
    }

    const existing = this.find(name);
    if (existing) {
      existing.successCount += 1;
      existing.lastValidatedAt = now;
      existing.updatedAt = now;
      existing.confidence = clamp(existing.confidence + 0.05, 0, 0.95);
      // A rolled-back procedure is NOT silently reactivated by a single
      // success — explicit reactivate() is required.
      return { promoted: true, reason: 'reinforced existing procedure', procedure: existing };
    }

    const triggerTags = cleanList(input.triggerTags, 8, 30)
      .map((t) => t.toLowerCase())
      .filter(Boolean);
    const record: ProcedureRecord = {
      id: newId('proc'),
      kind: 'procedure',
      name,
      purpose: cleanText(input.purpose, 300),
      steps,
      triggerTags,
      version: 1,
      status: 'active',
      successCount: 1,
      failureCount: 0,
      lastValidatedAt: now,
      versionHistory: [{ version: 1, changedAt: now, reason: 'promoted from verified success' }],
      createdAt: now,
      updatedAt: now,
      confidence: 0.6,
      provenance: { source: input.source ?? 'agent', ref: input.ref ?? input.taskId, observedAt: now },
    };
    this.records.push(record);
    if (this.records.length > MAX_PROCEDURES) {
      this.records.sort((a, b) => b.updatedAt - a.updatedAt);
      this.records.length = MAX_PROCEDURES;
    }
    return { promoted: true, reason: 'promoted new procedure', procedure: record };
  }

  /** Record a procedure failure; auto-disable beyond the threshold. */
  recordFailure(name: string, now = Date.now()): ProcedureRecord | null {
    const record = this.find(name);
    if (!record) return null;
    record.failureCount += 1;
    record.updatedAt = now;
    if (record.status === 'active' && record.failureCount >= ROLLBACK_THRESHOLD &&
        record.failureCount > record.successCount) {
      this.rollback(record.name, `auto-disabled after ${record.failureCount} failures vs ${record.successCount} successes`, now);
    }
    return record;
  }

  /**
   * Record a failure against a procedure by its REAL record id — the
   * caller (advisor selection) knows the id, not the name. Same honest
   * accounting + auto-rollback as recordFailure.
   */
  recordFailureById(id: string, now = Date.now()): ProcedureRecord | null {
    const record = this.records.find((r) => r.id === id);
    if (!record) return null;
    record.failureCount += 1;
    record.updatedAt = now;
    if (record.status === 'active' && record.failureCount >= ROLLBACK_THRESHOLD &&
        record.failureCount > record.successCount) {
      this.rollback(record.name, `auto-disabled after ${record.failureCount} failures vs ${record.successCount} successes`, now);
    }
    return record;
  }

  /** Reversible: keep the record + evidence, flip status, log the reason. */
  rollback(name: string, reason: string, now = Date.now()): ProcedureRecord | null {
    const record = this.find(name);
    if (!record || record.status === 'rolled_back') return record ?? null;
    record.status = 'rolled_back';
    record.version += 1;
    record.versionHistory.push({
      version: record.version,
      changedAt: now,
      reason: cleanText(reason, 200) || 'rolled back',
    });
    record.updatedAt = now;
    return record;
  }

  /** Manual re-enable after a fix (never automatic). */
  reactivate(name: string, now = Date.now()): ProcedureRecord | null {
    const record = this.find(name);
    if (!record) return null;
    record.status = 'active';
    record.version += 1;
    record.versionHistory.push({ version: record.version, changedAt: now, reason: 'reactivated after fix' });
    record.updatedAt = now;
    record.failureCount = 0;
    return record;
  }

  /** Active procedures relevant to an objective (never replayed blindly). */
  relevant(objective: string, limit = 2): Array<ProcedureRecord & { score: number }> {
    const obj = tokens(objective);
    if (obj.length === 0) return [];
    return this.records
      .filter((r) => r.status === 'active')
      .map((r) => ({
        ...r,
        score:
          tokenOverlap(obj, tokens(r.name)) * 0.25 +
          tokenOverlap(obj, r.triggerTags) * 0.2 +
          tokenOverlap(obj, tokens(r.purpose)) * 0.1,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  list(): ProcedureRecord[] {
    return [...this.records];
  }

  remove(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    return this.records.length !== before;
  }

  hydrate(raw: unknown): void {
    this.records = sanitizeArray(raw, MAX_PROCEDURES, (r) =>
      r && typeof r.name === 'string' && Array.isArray(r.steps)
        ? {
            id: typeof r.id === 'string' ? r.id : newId('proc'),
            kind: 'procedure' as const,
            name: cleanText(r.name, 120),
            purpose: typeof r.purpose === 'string' ? cleanText(r.purpose, 300) : '',
            steps: cleanList(r.steps, 10, 200),
            triggerTags: cleanList(r.triggerTags, 8, 30).map((t) => t.toLowerCase()),
            version: clamp(Math.floor(Number(r.version)) || 1, 1, 10_000),
            status: r.status === 'rolled_back' ? ('rolled_back' as const) : ('active' as const),
            successCount: clamp(Math.floor(Number(r.successCount)) || 0, 0, 10_000),
            failureCount: clamp(Math.floor(Number(r.failureCount)) || 0, 0, 10_000),
            lastValidatedAt: Number(r.lastValidatedAt) || Date.now(),
            versionHistory: Array.isArray(r.versionHistory)
              ? r.versionHistory
                  .filter((h: any) => h && typeof h.reason === 'string')
                  .slice(-20)
                  .map((h: any) => ({
                    version: clamp(Math.floor(Number(h.version)) || 1, 1, 10_000),
                    changedAt: Number(h.changedAt) || Date.now(),
                    reason: cleanText(h.reason, 200),
                  }))
              : [],
            createdAt: Number(r.createdAt) || Date.now(),
            updatedAt: Number(r.updatedAt) || Date.now(),
            confidence: clamp(Number(r.confidence) || 0.6, 0, 0.95),
            provenance: sanitizeProvenance(r.provenance),
          }
        : null,
    );
  }

  dump(): ProcedureRecord[] {
    return this.records;
  }
}

// ── Shared helpers ──────────────────────────────────────────────

function sanitizeArray<T>(raw: unknown, cap: number, map: (r: any) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      try {
        return map(item);
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null)
    .slice(-cap);
}

function sanitizeProvenance(raw: any): Provenance {
  const sources: MemorySource[] = ['agent', 'user', 'system', 'mission', 'browser-session'];
  return {
    source: sources.includes(raw?.source) ? raw.source : 'system',
    ref: typeof raw?.ref === 'string' ? raw.ref.slice(0, 120) : undefined,
    observedAt: Number(raw?.observedAt) || Date.now(),
  };
}

// ── Facade + persistence ────────────────────────────────────────

export interface LayeredMemoryFile {
  version: 1;
  failures: FailureRecord[];
  environment: EnvironmentRecord[];
  episodes: EpisodeRecord[];
  procedures: ProcedureRecord[];
}

const MAX_FILE_SIZE = 2 * 1024 * 1024;

export class LayeredMemory {
  readonly failures = new FailureMemory();
  readonly environment = new EnvironmentMemory();
  readonly episodes = new EpisodicMemory();
  readonly procedures = new ProceduralMemory();
  private readonly file: string;
  private loaded = false;

  constructor(opts: { file?: string } = {}) {
    this.file = opts.file ?? (process.env.BLAXIN_MEMORY_LAYERS_FILE
      ? dataPath(process.env.BLAXIN_MEMORY_LAYERS_FILE)
      : dataPath('.blaxin-state', 'memory-layers.json'));
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.file)) return;
      const stats = statSync(this.file);
      if (stats.size > MAX_FILE_SIZE) {
        logger.warn('memory-layers', 'Layered memory file too large, starting fresh');
        return;
      }
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as Partial<LayeredMemoryFile>;
      if (!parsed || typeof parsed !== 'object') {
        logger.warn('memory-layers', 'Layered memory file is not an object, starting fresh');
        return;
      }
      this.failures.hydrate(parsed.failures);
      this.environment.hydrate(parsed.environment);
      this.episodes.hydrate(parsed.episodes);
      this.procedures.hydrate(parsed.procedures);
    } catch (error: any) {
      // Corrupted memory NEVER takes the agent down: degrade to empty.
      logger.warn('memory-layers', `Failed to load layered memory (starting fresh): ${error.message}`);
    }
  }

  save(): void {
    this.load();
    try {
      const dir = dataPath('.blaxin-state');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const payload: LayeredMemoryFile = {
        version: 1,
        failures: this.failures.dump(),
        environment: this.environment.dump(),
        episodes: this.episodes.dump(),
        procedures: this.procedures.dump(),
      };
      // REDACT BEFORE PERSISTENCE — defense in depth on top of the
      // per-record gates above.
      const json = JSON.stringify(redactDeep(payload), null, 2);
      if (looksSensitive(json.replace(/\\"/g, ''))) {
        // Should be unreachable (records are gated individually); refuse
        // the write rather than risk persisting a secret.
        logger.error('memory-layers', 'Post-redaction persistence check failed — write REFUSED');
        return;
      }
      writeFileSync(this.file, json, { mode: 0o600 });
    } catch (error: any) {
      logger.error('memory-layers', `Failed to save layered memory: ${error.message}`);
    }
  }

  /** Every mutation funnels through this so disk always mirrors memory. */
  private persist(): void {
    this.save();
  }

  failure(input: FailureInput): FailureRecord | null {
    this.load();
    const r = this.failures.record(input);
    if (r) this.persist();
    return r;
  }

  failureRecovered(input: FailureInput, recovery: string): FailureRecord | null {
    this.load();
    const r = this.failures.recoverySucceeded(input, recovery);
    if (r) this.persist();
    return r;
  }

  observeEnvironment(input: EnvironmentInput): EnvironmentRecord | null {
    this.load();
    const r = this.environment.observe(input);
    if (r) this.persist();
    return r;
  }

  recordEpisode(input: EpisodeInput): EpisodeRecord | null {
    this.load();
    const r = this.episodes.record(input);
    if (r) this.persist();
    return r;
  }

  promoteProcedure(input: ProcedureInput, verified: boolean): ProcedureOutcome {
    this.load();
    const out = this.procedures.recordIfVerified(input, verified);
    if (out.promoted) this.persist();
    return out;
  }

  procedureFailed(name: string): ProcedureRecord | null {
    this.load();
    const r = this.procedures.recordFailure(name);
    if (r) this.persist();
    return r;
  }

  /** Failure accounting by REAL procedure id (see ProceduralMemory). */
  procedureFailedById(id: string): ProcedureRecord | null {
    this.load();
    const r = this.procedures.recordFailureById(id);
    if (r) this.persist();
    return r;
  }

  rollbackProcedure(name: string, reason: string): ProcedureRecord | null {
    this.load();
    const r = this.procedures.rollback(name, reason);
    if (r) this.persist();
    return r;
  }

  reactivateProcedure(name: string): ProcedureRecord | null {
    this.load();
    const r = this.procedures.reactivate(name);
    if (r) this.persist();
    return r;
  }

  remove(kind: 'failure' | 'environment' | 'episode' | 'procedure', id: string): boolean {
    this.load();
    let removed = false;
    if (kind === 'failure') removed = this.failures.remove(id);
    else if (kind === 'environment') removed = this.environment.remove(id);
    else if (kind === 'episode') removed = this.episodes.remove(id);
    else removed = this.procedures.remove(id);
    if (removed) this.persist();
    return removed;
  }

  /** Bounded snapshot for the memory API/UI. */
  snapshot(): { failures: FailureRecord[]; environment: EnvironmentRecord[]; episodes: EpisodeRecord[]; procedures: ProcedureRecord[] } {
    this.load();
    return {
      failures: this.failures.list().slice(0, 50),
      environment: this.environment.list().slice(0, 50),
      episodes: this.episodes.list().slice(-50).reverse(),
      procedures: this.procedures.list().slice(0, 50),
    };
  }
}

/** Default runtime singleton (tests construct their own instances). */
export const memoryLayers = new LayeredMemory();
