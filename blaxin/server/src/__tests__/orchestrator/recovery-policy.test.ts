// Deterministic recovery policy (§29/§30): failures classify from REAL
// evidence, strategies are safe and budgeted, re-plans mutate the plan.
// An UNCLASSIFIED failure never recovers deterministically — Brain only.

import { describe, it, expect } from 'vitest';
import {
  classifyFailure, selectStrategy, synthesizeAlternatePlan,
  backoffFor, correctiveActionFor, failureLabel,
  DEFAULT_RECOVERY_CONFIG,
} from '../../orchestrator/recovery-policy.js';

const cfg = DEFAULT_RECOVERY_CONFIG;

describe('failure classification from real evidence', () => {
  it('classifies real browser grounding failures as TARGET_NOT_FOUND', () => {
    // Exact string from web-agent.ts (web-agent-honesty suite pins it).
    const cls = classifyFailure('blaxin_web', { action: 'click' },
      'No confident match for "search button" — run action=snapshot to see real elements (grounding refused to guess).');
    expect(cls).toBe('TARGET_NOT_FOUND');
  });

  it('classifies real tool timeout strings as TRANSIENT_TIMEOUT', () => {
    // Exact string from the tool registry's race guard.
    const cls = classifyFailure('terminal', {}, 'Tool "terminal" timed out after 30s');
    expect(cls).toBe('TRANSIENT_TIMEOUT');
  });

  it('classifies real screenshot capability gaps as ENVIRONMENT_BLOCKED', () => {
    // Exact string from screenshot.ts.
    const cls = classifyFailure('screenshot', {},
      'Screenshot NOT captured: no screenshot tool available (X11 display is present). Install one: sudo apt install scrot');
    expect(cls).toBe('ENVIRONMENT_BLOCKED');
  });

  it('classifies real computer-control verification read-backs as STATE_MISMATCH', () => {
    const cls = classifyFailure('computer-control', { action: 'mouse_click' },
      'Click NOT verified: pointer is at (10, 10), not the requested (100, 200)');
    expect(cls).toBe('STATE_MISMATCH');
  });

  it('classifies real window-list misses as TARGET_NOT_FOUND', () => {
    const cls = classifyFailure('computer-control', { action: 'focus_window' }, 'Window not found: Firefox');
    expect(cls).toBe('TARGET_NOT_FOUND');
  });

  it('classifies filesystem not-found paths as TARGET_NOT_FOUND', () => {
    const cls = classifyFailure('filesystem', { operation: 'read', path: '/nope' }, 'File not found: /nope');
    expect(cls).toBe('TARGET_NOT_FOUND');
  });

  it('classifies browser observability loss as OBSERVATION_UNAVAILABLE', () => {
    const cls = classifyFailure('browser', { action: 'open_url' },
      'open_url NOT verified — could not read the page location');
    expect(cls).toBe('OBSERVATION_UNAVAILABLE');
  });

  it('classifies the real session-lost diagnostic as SESSION_DESYNC', () => {
    // Exact exhaustion string from browser-session.ts recover().
    const cls = classifyFailure('browser', { action: 'open_url' },
      'Browser session lost: 3 recovery attempts failed (reconnect, alternate page, relaunch). Human attention required — no fake success.');
    expect(cls).toBe('SESSION_DESYNC');
  });

  it('classifies terminal exit-code failures honestly as UNCLASSIFIED', () => {
    // A deterministic, reproducible command failure is NOT a transient
    // environment problem — no blind retry, Brain decides.
    const cls = classifyFailure('terminal', { command: 'grep -q pattern file' },
      'Command failed with exit code 1: no match');
    expect(cls).toBe('UNCLASSIFIED');
  });

  it('never classifies from empty evidence', () => {
    expect(classifyFailure('browser', {}, undefined)).toBe('UNCLASSIFIED');
    expect(classifyFailure('browser', {}, '')).toBe('UNCLASSIFIED');
    expect(classifyFailure('browser', {}, 'unknown error')).toBe('UNCLASSIFIED');
  });

  it('uses verification status/detail as corroborating evidence', () => {
    // "State did not change" means verification RAN and observed an
    // unchanged state — an honest STATE_MISMATCH, not an observability loss.
    const cls = classifyFailure('browser', { action: 'refresh' }, 'refresh NOT verified',
      { status: 'UNKNOWN', detail: 'State did not change through the 8000ms window' });
    expect(cls).toBe('STATE_MISMATCH');
  });
});

describe('strategy selection within the explicit budget', () => {
  it('attempt 1 for a transient failure is a bounded retry with backoff', () => {
    const sel = selectStrategy('TRANSIENT_TIMEOUT', 'terminal', 1, cfg);
    expect(sel.strategy).toBe('bounded-retry-backoff');
  });

  it('observation loss recovers by re-observing, not blind retrying', () => {
    const sel = selectStrategy('OBSERVATION_UNAVAILABLE', 'browser', 1, cfg);
    expect(sel.strategy).toBe('reobserve-then-retry');
  });

  it('target loss recovers through a tool-fitting alternate path', () => {
    const sel = selectStrategy('TARGET_NOT_FOUND', 'browser', 1, cfg);
    expect(sel.strategy).toBe('alternate-path');
    expect(sel.correctiveAction).toContain('re-ground');
  });

  it('computer-control alternate paths ground on the real window list', () => {
    const sel = selectStrategy('STATE_MISMATCH', 'computer-control', 1, cfg);
    expect(sel.correctiveAction).toContain('refocus');
  });

  it('UNCLASSIFIED failures never recover deterministically (Brain only)', () => {
    expect(selectStrategy('UNCLASSIFIED', 'terminal', 1, cfg).strategy).toBe('none');
  });

  it('ENVIRONMENT_BLOCKED failures never recover deterministically', () => {
    expect(selectStrategy('ENVIRONMENT_BLOCKED', 'screenshot', 1, cfg).strategy).toBe('none');
  });

  it('the per-action budget is hard: exhaustion returns none', () => {
    expect(selectStrategy('TRANSIENT_TIMEOUT', 'terminal', cfg.maxRecoveryAttempts + 1, cfg).strategy).toBe('none');
    expect(selectStrategy('TARGET_NOT_FOUND', 'browser', cfg.maxRecoveryAttempts + 2, cfg).strategy).toBe('none');
  });

  it('a tighter configured budget is honored', () => {
    const sel = selectStrategy('TRANSIENT_TIMEOUT', 'terminal', 2, { ...cfg, maxRecoveryAttempts: 1 });
    expect(sel.strategy).toBe('none');
  });
});

describe('corrective actions are real tool work', () => {
  it('browser/blaxin_web correction re-observes the page', () => {
    expect(correctiveActionFor('browser', 'TARGET_NOT_FOUND')).toContain('re-ground');
    expect(correctiveActionFor('blaxin_web', 'TARGET_NOT_FOUND')).toContain('snapshot');
  });

  it('computer-control correction grounds on real windows', () => {
    expect(correctiveActionFor('computer-control', 'TARGET_NOT_FOUND')).toContain('list real windows');
  });

  it('filesystem correction resolves the real path via the parent listing', () => {
    expect(correctiveActionFor('filesystem', 'TARGET_NOT_FOUND')).toContain('parent directory');
  });

  it('other tools get an honest generic observation step', () => {
    expect(correctiveActionFor('terminal', 'STATE_MISMATCH')).toContain('re-observe');
  });
});

describe('backoff is exponential and hard-capped', () => {
  it('grows exponentially from the base', () => {
    expect(backoffFor(1, cfg)).toBe(cfg.baseBackoffMs);
    expect(backoffFor(2, cfg)).toBe(cfg.baseBackoffMs * 2);
    expect(backoffFor(3, cfg)).toBe(cfg.baseBackoffMs * 4);
  });

  it('never exceeds maxBackoffMs', () => {
    expect(backoffFor(10, cfg)).toBe(cfg.maxBackoffMs);
    expect(backoffFor(10, { ...cfg, baseBackoffMs: 5000, maxBackoffMs: 2000 })).toBe(2000);
  });
});

describe('deterministic re-plan synthesis (real plan mutation)', () => {
  it('browser target loss → PLAN B: re-observe the real page, then re-run', () => {
    const plan = synthesizeAlternatePlan('browser', { action: 'click', target: 'login button' }, 'TARGET_NOT_FOUND');
    expect(plan).not.toBeNull();
    expect(plan!.planKey).toBe('observe-then-act');
    expect(plan!.corrective).toEqual({ tool: 'browser', args: { action: 'current_url' }, describe: expect.stringContaining('current_url') });
    expect(plan!.mutatedArgs.action).toBe('click'); // original action re-runs after observation
    expect(plan!.description).toContain('PLAN B');
  });

  it('blaxin_web target loss → PLAN B re-observes with a real snapshot', () => {
    const plan = synthesizeAlternatePlan('blaxin_web', { action: 'click' }, 'TARGET_NOT_FOUND');
    expect(plan!.corrective!.args).toEqual({ action: 'snapshot' });
  });

  it('computer-control window loss → PLAN B: list real windows, then re-run', () => {
    const plan = synthesizeAlternatePlan('computer-control', { action: 'focus_window', title: 'Terminal' }, 'TARGET_NOT_FOUND');
    expect(plan).not.toBeNull();
    expect(plan!.planKey).toBe('list-focus-then-act');
    expect(plan!.corrective!.args).toEqual({ action: 'list_windows' });
  });

  it('filesystem path miss → PLAN B: list the real parent, then re-run', () => {
    const plan = synthesizeAlternatePlan('filesystem', { operation: 'read', path: '/etc/hosts.bak' }, 'TARGET_NOT_FOUND');
    expect(plan).not.toBeNull();
    expect(plan!.planKey).toBe('list-parent-then-act');
    expect(plan!.corrective!.args).toEqual({ operation: 'list', path: '/etc' });
  });

  it('filesystem root paths do not synthesize a fake parent observation', () => {
    expect(synthesizeAlternatePlan('filesystem', { operation: 'read', path: '/' }, 'TARGET_NOT_FOUND')).toBeNull();
    // A top-level miss resolves its parent honestly — the real root listing.
    const topLevel = synthesizeAlternatePlan('filesystem', { operation: 'read', path: '/lost' }, 'TARGET_NOT_FOUND');
    expect(topLevel!.corrective!.args).toEqual({ operation: 'list', path: '/' });
  });

  it('returns null (honest) when no deterministic variant exists', () => {
    expect(synthesizeAlternatePlan('terminal', { command: 'ls' }, 'STATE_MISMATCH')).toBeNull();
    expect(synthesizeAlternatePlan('terminal', { command: 'grep -q x f' }, 'UNCLASSIFIED')).toBeNull();
    expect(synthesizeAlternatePlan('screenshot', {}, 'ENVIRONMENT_BLOCKED')).toBeNull();
  });

  it('class labels are human-readable for journal/HUD display', () => {
    expect(failureLabel('SESSION_DESYNC')).toContain('SESSION_DESYNC');
    expect(failureLabel('UNCLASSIFIED')).toContain('no deterministic strategy');
  });
});
