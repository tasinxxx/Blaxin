// BLAXIN deterministic recovery policy (§29/§30/§5)
// =============================================================
// When a tool action FAILS, the failure is classified from its REAL
// evidence (the tool's error text + verification payload + tool kind)
// and a SAFE, DETERMINISTIC recovery strategy is selected — no model
// call, no guessing. Every attempt is budgeted: recovery is bounded per
// action, and re-planning is bounded per task. When the budget is
// exhausted, the failure escalates to the Brain (the LLM loop) — which
// is exactly where reasoning becomes necessary.
//
// Hard rules:
//   - classification comes from the tool's own error evidence, never
//     invented (an unknown error classifies as UNCLASSIFIED and is NOT
//     retried deterministically — that is the Brain's job);
//   - a strategy never runs the exact same failed action unchanged;
//     every strategy either varies HOW the action runs or adds a
//     corrective action (re-observe / alternate path / bounded wait);
//   - budgets are explicit and configurable; exhaustion is honest.
// =============================================================

/** Failure classes derived from real evidence. */
export type FailureClass =
  | 'TRANSIENT_TIMEOUT'        // transient tool/transport timeout — bounded retry with backoff is the strategy
  | 'OBSERVATION_UNAVAILABLE'  // the page/environment was not observable (read failed, endpoint unreachable)
  | 'SESSION_DESYNC'           // browser session lost its real page identity (target vanished, about:blank regression, relaunch)
  | 'TARGET_NOT_FOUND'         // the grounded target did not exist or vanished (click/type grounding, window not found, file not found)
  | 'STATE_MISMATCH'           // the action ran but the environment did not reach the expected state (pointer, focus, clipboard, history)
  | 'ENVIRONMENT_BLOCKED'      // a real capability is missing on this machine (no screenshot tool, browser debugging endpoint)
  | 'UNCLASSIFIED';            // no deterministic strategy applies — Brain territory

/** Deterministic recovery strategies (each one really varies the retry). */
export type RecoveryStrategy =
  | 'bounded-retry-backoff'    // same action, after a real backoff interval (transient class only)
  | 'reobserve-then-retry'     // observe the real environment, then re-run the action on fresh evidence
  | 'alternate-path'           // run a corrective action first (reacquire/refocus/refresh/parent-dir), then the action
  | 'none';                    // no deterministic strategy — escalate

export interface RecoveryConfig {
  /** Deterministic attempts allowed per action (after the first real failure). */
  maxRecoveryAttempts: number;
  /** Deterministic re-plans allowed per task (plan mutations after repeated failures). */
  maxReplansPerTask: number;
  /** Base backoff (ms) for the bounded-retry strategy; doubles per attempt, hard-capped. */
  baseBackoffMs: number;
  /** Hard cap for the exponential backoff (never grows past this). */
  maxBackoffMs: number;
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  maxRecoveryAttempts: 2,
  maxReplansPerTask: 1,
  baseBackoffMs: 300,
  maxBackoffMs: 2000,
};

// ── Failure classification from REAL evidence ───────────────────
// Patterns match the ACTUAL error strings the tools emit (verified in
// tool-verification/browser-nav/web-agent-honesty suites). The
// classification is an honest reading of the evidence, not a guess.

interface ClassPattern {
  cls: FailureClass;
  patterns: RegExp[];
}

const CLASS_PATTERNS: ClassPattern[] = [
  {
    // Transient timeouts (tool-level or transport-level). Checked FIRST —
    // a timeout on a browser action is still transient at the transport
    // layer, but observability/desync errors describe a recoverable
    // environment instead, so those patterns win when both could match.
    cls: 'TRANSIENT_TIMEOUT',
    patterns: [
      /\btimed out after/i,
      /timeout/i,
      /\bECONN(RESET|REFUSED)\b/,
      /\bETIMEDOUT\b/,
      /\bEPIPE\b/,
      /did not complete/i,
    ],
  },
  {
    cls: 'OBSERVATION_UNAVAILABLE',
    patterns: [
      /not observable/i,
      /could not read the page/i,
      /could not plant a reload baseline/i,
      /debugging endpoint/i,
      /page is unobservable/i,
    ],
  },
  {
    cls: 'SESSION_DESYNC',
    patterns: [
      /browser session lost/i,
      /session desync/i,
      /recovery attempts failed/i,
      /relaunch/i,
    ],
  },
  {
    cls: 'TARGET_NOT_FOUND',
    patterns: [
      /no confident match/i,
      /target \(semantic description\)/i,
      /could not be grounded/i,
      /grounded element vanished/i,
      /window not found/i,
      /file not found/i,
      /path not found/i,
      /directory not found/i,
      /no video results/i,
      /did not load any video links/i,
      /unknown (browser|blaxin_web|computer|clipboard|info|operation) (action|type|:)/i,
      /unknown operation/i,
    ],
  },
  {
    cls: 'STATE_MISMATCH',
    patterns: [
      /not verified/i,
      /pointer is at/i,
      /active window is/i,
      /still present after/i,
      /survived the reload/i,
      /still present in the real page list/i,
      /state did not change/i,
      /did not land/i,
      /did not reach the video page/i,
      /does not match what was written/i,
      /could not be read back/i,
      /no earlier history entry/i,
      /no later history entry/i,
    ],
  },
  {
    cls: 'ENVIRONMENT_BLOCKED',
    patterns: [
      /no screenshot tool available/i,
      /no clipboard tool available/i,
      /all clipboard readers failed/i,
      /not found on path/i,
      /launch not verified/i,
      /install one/i,
    ],
  },
];

/**
 * Classify a tool failure from its real error evidence. `tool` and
 * `args` contextualize the class (e.g. a browser mutation that "did not
 * complete" is a session problem, not just a timeout).
 */
export function classifyFailure(
  tool: string,
  args: Record<string, unknown>,
  error: string | undefined,
  verification?: { status?: string; detail?: string } | null,
): FailureClass {
  const evidence = [
    String(error ?? ''),
    verification?.status ? `verification:${verification.status}` : '',
    verification?.detail ? String(verification.detail) : '',
  ].join(' | ');
  if (!evidence.trim() || evidence.trim() === 'unknown error') return 'UNCLASSIFIED';

  for (const { cls, patterns } of CLASS_PATTERNS) {
    if (patterns.some((p) => p.test(evidence))) {
      // Refine the timeout class: a browser/web timeout means the page
      // environment was mid-action — observation recovery applies too.
      if (cls === 'TRANSIENT_TIMEOUT' && (tool === 'browser' || tool === 'blaxin_web')) {
        return 'OBSERVATION_UNAVAILABLE';
      }
      return cls;
    }
  }
  return 'UNCLASSIFIED';
}

/**
 * The deterministic recovery strategy for a failure class, and the
 * attempt number it would be (1-based). Returns 'none' when the class
 * has no deterministic strategy or the budget is spent.
 */
export function selectStrategy(
  cls: FailureClass,
  tool: string,
  attempt: number,
  config: RecoveryConfig,
): { strategy: RecoveryStrategy; correctiveAction?: string } {
  if (attempt > config.maxRecoveryAttempts) return { strategy: 'none' };
  switch (cls) {
    case 'TRANSIENT_TIMEOUT':
      return { strategy: 'bounded-retry-backoff' };
    case 'OBSERVATION_UNAVAILABLE':
    case 'SESSION_DESYNC':
      // Observe the real environment (fresh acquire / re-read), then the
      // action re-runs against PROVEN-observable state.
      return { strategy: 'reobserve-then-retry' };
    case 'TARGET_NOT_FOUND':
      return { strategy: 'alternate-path', correctiveAction: correctiveActionFor(tool, cls) };
    case 'STATE_MISMATCH':
      return { strategy: 'alternate-path', correctiveAction: correctiveActionFor(tool, cls) };
    case 'ENVIRONMENT_BLOCKED':
    case 'UNCLASSIFIED':
      // Missing capability or unknown cause — reasoning territory.
      return { strategy: 'none' };
    default:
      return { strategy: 'none' };
  }
}

/**
 * The REAL corrective action that precedes the retry for an
 * alternate-path strategy. Every action here already exists in the
 * tools' own recovery contracts (browser-session reacquire,
 * computer-control window list/focus, filesystem parent listing).
 */
export function correctiveActionFor(tool: string, cls: FailureClass): string | undefined {
  switch (tool) {
    case 'browser':
    case 'blaxin_web':
      // Grounding failed or state did not transition: re-observe the page
      // and let the action's own UNKNOWN→reacquire→re-verify contract run.
      return cls === 'TARGET_NOT_FOUND' ? 're-snapshot page and re-ground the target' : 'reacquire page state, then re-verify';
    case 'computer-control':
      // Window/focus/pointer mismatch: list real windows and focus the
      // right one before the action re-runs (the tool verifies read-back).
      return cls === 'TARGET_NOT_FOUND' ? 'list real windows and refocus the target window' : 'refocus the expected window, then re-run with read-back verification';
    case 'filesystem':
      // Not-found paths: observe the parent directory for the real name.
      return 'list the parent directory and re-resolve the real path';
    default:
      return 're-observe the environment, then retry';
  }
}

/** Backoff for attempt n (1-based), exponential with a hard cap. */
export function backoffFor(attempt: number, config: RecoveryConfig): number {
  const raw = config.baseBackoffMs * Math.pow(2, attempt - 1);
  return Math.min(Math.round(raw), config.maxBackoffMs);
}

// ── Deterministic re-plan (plan mutation, not narration) ────────

/**
 * A deterministic re-plan: a NEW executable action sequence that
 * genuinely differs from the failed one. `planKey` names the variant so
 * the same variant is never synthesized twice, and `corrective` runs
 * BEFORE the original action re-runs.
 */
export interface AlternatePlan {
  planKey: string;
  description: string;
  /** Preparatory action that runs before the original tool re-runs. */
  corrective?: { tool: string; args: Record<string, unknown>; describe: string };
  /** Arguments for the retried original action (may be mutated). */
  mutatedArgs: Record<string, unknown>;
}

/**
 * Synthesize an alternate plan from REAL failure evidence. Returns null
 * when no honest deterministic variant exists — the caller escalates to
 * the Brain instead of pretending to re-plan.
 */
export function synthesizeAlternatePlan(
  tool: string,
  args: Record<string, unknown>,
  cls: FailureClass,
): AlternatePlan | null {
  switch (tool) {
    case 'browser':
    case 'blaxin_web': {
      // Target/page lost: re-observe the REAL page state (snapshot or
      // current_url) — the next grounding runs on fresh evidence, not on
      // a stale snapshot.
      if (cls === 'TARGET_NOT_FOUND' || cls === 'OBSERVATION_UNAVAILABLE' || cls === 'STATE_MISMATCH') {
        const observe = tool === 'blaxin_web'
          ? { tool, args: { action: 'snapshot' }, describe: 'blaxin_web snapshot (re-observe the real page state)' }
          : { tool, args: { action: 'current_url' }, describe: 'browser current_url (re-observe the real page state)' };
        return {
          planKey: 'observe-then-act',
          description: `PLAN B: re-observe the real page state, then re-run ${String(args.action ?? tool)} against fresh evidence`,
          corrective: observe,
          mutatedArgs: { ...args },
        };
      }
      return null;
    }
    case 'computer-control': {
      // Window gone / focus mismatch: enumerate real windows first, then
      // focus, then the action — grounded in the real window list.
      if (cls === 'TARGET_NOT_FOUND' || cls === 'STATE_MISMATCH') {
        return {
          planKey: 'list-focus-then-act',
          description: `PLAN B: list the real windows, focus the target window, then re-run ${String(args.action ?? 'action')} with read-back verification`,
          corrective: { tool, args: { action: 'list_windows' }, describe: 'computer-control list_windows (ground on the real window list)' },
          mutatedArgs: { ...args },
        };
      }
      return null;
    }
    case 'filesystem': {
      // Path not found: observe the parent directory, then re-run against
      // the real directory listing.
      const path = typeof args.path === 'string' ? args.path : '';
      if (cls === 'TARGET_NOT_FOUND' && path) {
        const parent = parentOf(path);
        if (parent !== null) {
          return {
            planKey: 'list-parent-then-act',
            description: `PLAN B: list the real contents of ${parent}, then re-run ${String(args.operation ?? 'operation')} on the resolved path`,
            corrective: { tool, args: { operation: 'list', path: parent }, describe: `filesystem list ${parent} (resolve the real path)` },
            mutatedArgs: { ...args },
          };
        }
      }
      return null;
    }
    default:
      // No honest deterministic variant for this tool — Brain territory.
      return null;
  }
}

function parentOf(path: string): string | null {
  if (!path || path === '/') return null;
  const idx = path.replace(/\/+$/, '').lastIndexOf('/');
  if (idx <= 0) return idx === 0 ? '/' : null;
  return path.slice(0, idx);
}

/** Human-readable failure-class label (journal/HUD). */
export function failureLabel(cls: FailureClass): string {
  switch (cls) {
    case 'TRANSIENT_TIMEOUT':       return 'TRANSIENT_TIMEOUT — transient tool/transport timeout';
    case 'OBSERVATION_UNAVAILABLE': return 'OBSERVATION_UNAVAILABLE — environment not observable';
    case 'SESSION_DESYNC':          return 'SESSION_DESYNC — browser session lost its page identity';
    case 'TARGET_NOT_FOUND':        return 'TARGET_NOT_FOUND — target missing or vanished';
    case 'STATE_MISMATCH':          return 'STATE_MISMATCH — environment did not reach the expected state';
    case 'ENVIRONMENT_BLOCKED':     return 'ENVIRONMENT_BLOCKED — real capability missing on this machine';
    case 'UNCLASSIFIED':            return 'UNCLASSIFIED — no deterministic strategy applies';
  }
}
