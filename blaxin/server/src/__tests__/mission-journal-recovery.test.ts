// Journal evidence for deterministic recovery (§29/§30): classification,
// strategy, attempt/budget and REAL re-plan lines — every field traceable
// to the runtime event payload, never invented.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MissionJournal, JournalEntry } from '../utils/mission-journal.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blaxin-journal-rec-'));
  file = join(dir, 'journal.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const make = () => new MissionJournal({ filePath: file });
const first = (entries: JournalEntry[], kind: string) => entries.find((e) => e.kind === kind);

describe('journal — deterministic recovery evidence', () => {
  it('records a classified recovery with strategy, attempt and budget', () => {
    const j = make();
    j.ingest('tool-execution', { toolName: 'blaxin_web', args: {}, state: 'executing', stepId: 's1' });
    j.ingest('tool-execution', {
      toolName: 'blaxin_web', args: {}, state: 'retrying', stepId: 's1',
      failureClass: 'TARGET_NOT_FOUND',
      failureLabel: 'TARGET_NOT_FOUND — target missing or vanished',
      recoveryStrategy: 'alternate-path',
      recoveryAttempt: 1,
      recoveryBudget: 3,
      recoveryDetail: 're-snapshot page and re-ground the target',
    });

    const rec = first(j.list(), 'RECOVERY')!;
    expect(rec).toBeDefined();
    expect(rec.status).toBe('RECOVERING'); // outcome comes from the settled action, never claimed here
    expect(rec.failureClass).toBe('TARGET_NOT_FOUND');
    expect(rec.recoveryStrategy).toBe('alternate-path');
    expect(rec.recoveryAttempt).toBe(1);
    expect(rec.recoveryBudget).toBe(3);
    expect(rec.recovery).toContain('re-ground');
    expect(rec.failure).toContain('TARGET_NOT_FOUND');
  });

  it('records a REPLAN with the real plan change (old → new)', () => {
    const j = make();
    j.ingest('tool-execution', {
      toolName: 'browser', args: {}, state: 'retrying', stepId: 's2',
      failureClass: 'OBSERVATION_UNAVAILABLE',
      recoveryStrategy: 'replan',
      replanNumber: 1,
      replanBudget: 1,
      replanPlanKey: 'observe-then-act',
      replanDescription: 'PLAN B: re-observe the real page state, then re-run click against fresh evidence',
      oldStrategy: 'direct action → deterministic recovery exhausted',
    });

    const replan = first(j.list(), 'REPLAN')!;
    expect(replan).toBeDefined();
    expect(replan.status).toBe('RUNNING');
    expect(replan.replanNumber).toBe(1);
    expect(replan.replanBudget).toBe(1);
    expect(replan.failureClass).toBe('OBSERVATION_UNAVAILABLE');
    expect(replan.planChange).toContain('direct action → deterministic recovery exhausted');
    expect(replan.planChange).toContain('PLAN B');
  });

  it('keeps the generic retry line for legacy transient retries (no failureClass payload)', () => {
    const j = make();
    j.ingest('tool-execution', { toolName: 'terminal', state: 'executing', stepId: 's1' });
    j.ingest('tool-execution', { toolName: 'terminal', state: 'retrying', stepId: 's1' });

    const entries = j.list();
    expect(entries.filter((e) => e.kind === 'RECOVERY')).toHaveLength(1);
    const rec = entries.find((e) => e.kind === 'RECOVERY')!;
    expect(rec.failureClass).toBeUndefined();
    expect(rec.recovery).toBe('retry with backoff');
  });

  it('the full honest arc: failure evidence → classified recovery → replan → verified success', () => {
    const j = make();
    // Plan A fails twice with real grounding evidence.
    j.ingest('tool-execution', { toolName: 'blaxin_web', args: {}, state: 'executing', stepId: 's3' });
    j.ingest('tool-execution', {
      toolName: 'blaxin_web', args: {}, state: 'retrying', stepId: 's3',
      failureClass: 'TARGET_NOT_FOUND', recoveryStrategy: 'alternate-path',
      recoveryAttempt: 1, recoveryBudget: 2,
      recoveryDetail: 're-snapshot page and re-ground the target',
    });
    j.ingest('tool-execution', {
      toolName: 'blaxin_web', args: {}, state: 'retrying', stepId: 's3',
      failureClass: 'TARGET_NOT_FOUND', recoveryStrategy: 'alternate-path',
      recoveryAttempt: 2, recoveryBudget: 2,
      recoveryDetail: 're-snapshot page and re-ground the target',
    });
    // Deterministic re-plan: PLAN B (the corrective observation and the
    // re-run then happen; the trail below records their settled results).
    j.ingest('tool-execution', {
      toolName: 'blaxin_web', args: {}, state: 'retrying', stepId: 's3',
      failureClass: 'TARGET_NOT_FOUND', recoveryStrategy: 'replan',
      replanNumber: 1, replanBudget: 1,
      replanDescription: 'PLAN B: re-observe the real page state, then re-run click against fresh evidence',
      oldStrategy: 'direct action → deterministic recovery exhausted',
    });
    // PLAN B succeeds and the action settles COMPLETED with real verification.
    j.ingest('tool-execution', {
      toolName: 'blaxin_web', args: {}, state: 'completed', stepId: 's3',
      result: 'clicked and OBSERVED at https://example.com/',
      verification: { method: 'url-match', status: 'SUCCESS', detail: 'URL verified' },
    });

    const entries = j.list().reverse(); // chronological
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toEqual(['ACTION', 'RECOVERY', 'RECOVERY', 'REPLAN', 'OBSERVATION', 'VERIFICATION']);

    // ONE action line per real action, honestly settled.
    const actions = entries.filter((e) => e.kind === 'ACTION');
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe('COMPLETED');
    expect(actions[0].verification?.status).toBe('SUCCESS');
  });
});
