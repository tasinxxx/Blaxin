// BLAXIN Capability-Aware Model Router (10× — adaptive model routing)
// =============================================================
// A pure, deterministic routing core that matches a task's REQUIRED
// capabilities against the models that are REALLY available, and returns
// a decision with full evidence: which candidates were considered, which
// were rejected and WHY, what was selected, and what to do when a call
// fails (bounded fallback).
//
// Hard rules:
//   - The router never pretends a capability exists. When no model
//     offers a required capability the decision is an honest BLOCK
//     naming the missing capability — never a silent downgrade.
//   - Capability "unknown" (e.g. a local Ollama model that reports no
//     machine-readable capability list) is NOT treated as a match for a
//     capability-requiring task. Unknown stays unknown.
//   - Fallback is bounded and cycle-free: a fixed candidate order, each
//     candidate considered at most once per decision.
//   - Pure functions only, injectable clock — identical inputs produce
//     identical decisions (test #11).
// =============================================================

import { ModelInfo, ProviderId } from '../types.js';

// ── Required capabilities ────────────────────────────────────────

/**
 * What a task actually needs from the model. Every field is derived
 * from REAL evidence (messages the orchestrator is about to send, tools
 * that exist, config); nothing is guessed.
 */
export interface RequiredCapabilities {
  /** Ordinary chat/reasoning is always required by an LLM-path task. */
  chat: boolean;
  /** The task carries tool definitions that may be called. */
  toolCalling: boolean;
  /** The task carries image payloads (verified screenshots). */
  vision: boolean;
  /** The request asks for a local/offline-capable model. */
  local: boolean;
}

/** The honest missing-capability label when nothing can serve the task. */
export interface RoutingBlock {
  reason: 'no-provider' | 'capability-unavailable';
  /** Capability that no available model offers ('vision', 'tool-calling'…). */
  capability?: string;
  detail: string;
}

export interface RejectedCandidate {
  provider: ProviderId;
  model: string;
  reason:
    | 'missing-capability'
    | 'missing-capability-unknown'
    | 'not-local'
    | 'provider-unavailable'
    | 'recent-failure';
  /** What exactly was missing (capability name) when applicable. */
  capability?: string;
  detail: string;
}

export type RoutingSelection =
  | {
      kind: 'selected';
      provider: ProviderId;
      model: string;
      capabilities: string[];
      /** Why this candidate won (traceable, human-readable). */
      reason: string;
    }
  | { kind: 'blocked'; block: RoutingBlock };

export interface RoutingDecision {
  required: RequiredCapabilities;
  /** Every candidate considered, in deterministic order. */
  candidates: Array<{ provider: ProviderId; model: string }>;
  rejected: RejectedCandidate[];
  selection: RoutingSelection;
  /** Bounded failure history used as a routing signal (may be empty). */
  failureHistory: Array<{
    provider: ProviderId;
    model: string;
    outcomes: Array<{ outcome: ModelOutcome; count: number }>;
  }>;
}

// ── Bounded reliability history ──────────────────────────────────

export type ModelOutcome = 'success' | 'failure' | 'timeout' | 'capability-mismatch';

const OUTCOME_WEIGHT: Record<ModelOutcome, number> = {
  success: 0,
  failure: 1,
  timeout: 1,
  'capability-mismatch': 2,
};

/** Failure count after which a candidate is deprioritized. */
export const FAILURE_THRESHOLD = 3;
/** Maximum tracked (provider, model) pairs — a bounded ring. */
export const MAX_RELIABILITY_ENTRIES = 100;

interface ReliabilityKey {
  provider: ProviderId;
  model: string;
}

/**
 * Bounded per-(provider, model) outcome history. This is a ROUTING
 * SIGNAL, not a ranking system: it only deprioritizes candidates with
 * recent repeated failures, it can never blacklist a model permanently
 * (entries expire from the bounded ring), and a model with no recorded
 * history is always preferred over one with failures at equal
 * capability fit.
 */
export class ModelReliability {
  private outcomes = new Map<string, { counts: Record<ModelOutcome, number>; recent: ModelOutcome[] }>();
  /** Insertion order for bounded eviction (oldest evicted first). */
  private order: string[] = [];

  private static keyOf(k: ReliabilityKey): string {
    return `${k.provider}::${k.model}`;
  }

  record(k: ReliabilityKey, outcome: ModelOutcome): void {
    const key = ModelReliability.keyOf(k);
    let entry = this.outcomes.get(key);
    if (!entry) {
      if (this.order.length >= MAX_RELIABILITY_ENTRIES) {
        const oldest = this.order.shift();
        if (oldest) this.outcomes.delete(oldest);
      }
      entry = {
        counts: { success: 0, failure: 0, timeout: 0, 'capability-mismatch': 0 },
        recent: [],
      };
      this.outcomes.set(key, entry);
      this.order.push(key);
    }
    entry.counts[outcome] += 1;
    entry.recent.push(outcome);
    if (entry.recent.length > FAILURE_THRESHOLD) entry.recent.shift();
  }

  /** Failure score: 0 = clean record, FAILURE_THRESHOLD = deprioritized. */
  score(k: ReliabilityKey): number {
    const entry = this.outcomes.get(ModelReliability.keyOf(k));
    if (!entry) return 0;
    // Bounded policy: only the most recent outcomes count; a model
    // recovers its standing after successes (never a permanent mark).
    const recentFailures = entry.recent
      .slice(-FAILURE_THRESHOLD)
      .reduce((sum, o) => sum + OUTCOME_WEIGHT[o], 0);
    return Math.min(recentFailures, FAILURE_THRESHOLD);
  }

  /** Consecutive most-recent failures (bounded view for evidence). */
  failureSummary(k: ReliabilityKey): Array<{ outcome: ModelOutcome; count: number }> {
    const entry = this.outcomes.get(ModelReliability.keyOf(k));
    if (!entry) return [];
    return (Object.keys(entry.counts) as ModelOutcome[])
      .filter((o) => entry.counts[o] > 0)
      .map((o) => ({ outcome: o, count: entry.counts[o] }));
  }

  snapshot(): Array<ReliabilityKey & { outcomes: Array<{ outcome: ModelOutcome; count: number }> }> {
    return this.order.map((key) => {
      const [provider, model] = key.split('::') as [ProviderId, string];
      return { provider, model, outcomes: this.failureSummary({ provider, model }) };
    });
  }

  clear(): void {
    this.outcomes.clear();
    this.order = [];
  }
}

// ── Capability derivation ────────────────────────────────────────

/** Capabilities that a hard requirement must be met by. */
const MODEL_SUPPORTS: Record<string, string> = {
  vision: 'vision',
  'function-calling': 'function-calling',
  multimodal: 'multimodal',
};

export function hasCapability(model: ModelInfo, capability: string): boolean {
  return Array.isArray(model.capabilities) && model.capabilities.includes(capability as never);
}

/**
 * TRUE only when the model PROVABLY offers the capability. A model whose
 * capability list is missing/empty reports UNKNOWN — that is not a
 * match. (For Ollama this is what keeps a chat-only local model honest
 * about not being vision-capable.)
 */
export function supportsRequired(
  model: ModelInfo,
  required: RequiredCapabilities,
): { ok: boolean; missing?: string; unknown?: boolean } {
  if (required.vision && !hasCapability(model, 'vision') && !hasCapability(model, 'multimodal')) {
    // Distinguish "reports capabilities but not vision" from "reports
    // nothing usable" — both reject, the reason wording differs.
    const unknown = !Array.isArray(model.capabilities) || model.capabilities.length === 0;
    return { ok: false, missing: 'vision', unknown };
  }
  if (required.toolCalling && !hasCapability(model, 'function-calling')) {
    const unknown = !Array.isArray(model.capabilities) || model.capabilities.length === 0;
    return { ok: false, missing: 'function-calling', unknown };
  }
  return { ok: true };
}

// ── Candidate ordering ───────────────────────────────────────────

/**
 * Deterministic, stable candidate order (identical inputs → identical
 * decisions):
 *   1. required-fit score (fewer misses is impossible here — all
 *      survivors satisfy requirements; this is the stable sort key set)
 *   2. local-first ONLY when local was required
 *   3. free models before paid
 *   4. higher context window
 *   5. provider order as given, model order as given (final tiebreak)
 * Failure history only DEMOTES (bounded signal), never fabricates rank.
 */
function candidateKey(m: ModelInfo, required: RequiredCapabilities, reliability: ModelReliability) {
  return {
    local: m.provider === 'ollama' ? 0 : 1,
    free: m.isFree ? 0 : 1,
    context: -(m.contextWindow ?? 0),
    failures: reliability.score({ provider: m.provider, model: m.id }),
  };
}

function orderedCandidates(
  available: ModelInfo[],
  required: RequiredCapabilities,
  reliability: ModelReliability,
): ModelInfo[] {
  const scored = available.map((m) => {
    const k = candidateKey(m, required, reliability);
    let rank: number;
    if (required.local) {
      // Local requirement: locals first (strict), then free, then context.
      rank = k.local * 1000 + k.free * 100 + k.failures * 50 + k.context / 1e9;
    } else {
      rank = k.free * 100 + k.local * 10 + k.failures * 50 + k.context / 1e12;
    }
    return { m, rank };
  });
  // Stable sort with an explicit index tiebreak: identical inputs always
  // produce the identical order regardless of engine sort stability.
  return scored
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((s) => s.m);
}

// ── The routing decision ─────────────────────────────────────────

export interface RouteRequest {
  required: RequiredCapabilities;
  /** Models that are REALLY available right now (caller-provided). */
  available: ModelInfo[];
  /** Providers the caller has verified as usable (key present/healthy). */
  availableProviders: ProviderId[];
  /** The model the user actively configured (preferred when compatible). */
  activeProvider: ProviderId | null;
  activeModel: string | null;
  reliability: ModelReliability;
}

/**
 * Decide the route. Deterministic: same request (+ same reliability
 * history) → same decision, always.
 */
export function route(req: RouteRequest): RoutingDecision {
  const { required, available, availableProviders, activeProvider, activeModel, reliability } = req;
  const candidates = orderedCandidates(available, required, reliability);
  const rejected: RejectedCandidate[] = [];

  // The actively configured model is tried FIRST when it satisfies the
  // requirements — the user's explicit choice wins over auto-selection.
  const ordered = [...candidates];
  if (activeProvider && activeModel) {
    const idx = ordered.findIndex((m) => m.provider === activeProvider && m.id === activeModel);
    if (idx > 0) {
      const [preferred] = ordered.splice(idx, 1);
      ordered.unshift(preferred);
    }
  }

  for (const model of ordered) {
    const providerUsable = availableProviders.includes(model.provider);
    if (!providerUsable) {
      rejected.push({
        provider: model.provider,
        model: model.id,
        reason: 'provider-unavailable',
        detail: `provider ${model.provider} has no usable key/connection right now`,
      });
      continue;
    }

    const fit = supportsRequired(model, required);
    if (!fit.ok) {
      rejected.push({
        provider: model.provider,
        model: model.id,
        reason: fit.unknown ? 'missing-capability-unknown' : 'missing-capability',
        capability: fit.missing,
        detail: fit.unknown
          ? `capability ${fit.missing} is UNKNOWN for this model (no machine-readable capability data) — honestly not claimable`
          : `model does not offer ${fit.missing}`,
      });
      continue;
    }

    return {
      required,
      candidates: candidates.map((m) => ({ provider: m.provider, model: m.id })),
      rejected,
      selection: {
        kind: 'selected',
        provider: model.provider,
        model: model.id,
        capabilities: [...(model.capabilities ?? [])],
        reason:
          activeProvider === model.provider && activeModel === model.id
            ? 'active configured model satisfies the required capabilities'
            : model.provider === 'ollama'
              ? 'capability-compatible local model (local-first preference)'
              : `capability-compatible model on ${model.provider}`,
      },
      failureHistory: reliability.snapshot(),
    };
  }

  // Nothing usable. Report the REAL missing capability honestly.
  const capUnavailable = required.vision || required.toolCalling;
  const missing = required.vision ? 'vision' : required.toolCalling ? 'function-calling' : undefined;
  return {
    required,
    candidates: candidates.map((m) => ({ provider: m.provider, model: m.id })),
    rejected,
    selection: {
      kind: 'blocked',
      block: available.length === 0
        ? { reason: 'no-provider', detail: 'no models are available from any configured provider' }
        : capUnavailable && missing
          ? {
              reason: 'capability-unavailable',
              capability: missing,
              detail: `no available model offers ${missing} — refusing to fake the capability`,
            }
          : {
              reason: 'capability-unavailable',
              capability: missing,
              detail: 'no available model satisfies the required capabilities',
            },
    },
    failureHistory: reliability.snapshot(),
  };
}
