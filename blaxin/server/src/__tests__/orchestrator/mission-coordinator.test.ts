// MISSION COORDINATION — focused deterministic suite (§ multi-specialist)
// =============================================================
// Pins the MissionCoordinator contract with REAL MissionStore +
// TaskQueue instances (scratch files; the units under test are real):
//   - evidence intake attributes ONLY to the bound running task's step
//     (no binding → no attribution — never guessed);
//   - verification aggregation is honest: VERIFIED requires every
//     completed step to carry VERIFIED evidence; UNVERIFIED never
//     upgrades; NONE when nothing completed;
//   - template expansion resolves ONLY real verified evidence (unknown/
//     unverified references become explicit markers — never fabricated);
//   - shared context is bounded, real, and background-framed;
//   - cancellation propagation cancels the mission's queued/running
//     queue tasks (no orphan specialists) and leaves others untouched.
// =============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MissionCoordinator } from '../../orchestrator/mission-coordinator.js';
import { MissionStore } from '../../utils/missions.js';
import { TaskQueue } from '../../utils/task-queue.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blaxin-mission-coord-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function make() {
  const missions = new MissionStore({ file: join(dir, `m-${Math.random().toString(36).slice(2)}.json`) });
  const queue = new TaskQueue({ file: join(dir, `q-${Math.random().toString(36).slice(2)}.json`) });
  const coord = new MissionCoordinator(missions, queue);
  return { missions, queue, coord };
}

/** Enqueue a mission-step task, mark it running, and bind it (scheduler contract). */
function bindRunning(
  coord: MissionCoordinator,
  queue: TaskQueue,
  missionId: string,
  stepId: string,
): string {
  const task = queue.enqueue({ objective: `step ${stepId}`, priority: 3, missionId, missionStepId: stepId });
  queue.markRunning(task.id);
  coord.bindRunningTask(task.id);
  return task.id;
}

// ── 1. Evidence intake + attribution ────────────────────────────

describe('mission coordinator: evidence intake + attribution', () => {
  it('attributes a specialist result to the bound running task\'s step', () => {
    const { missions, queue, coord } = make();
    const m = missions.create({ objective: 'research mission', steps: ['find it', 'use it'] });

    bindRunning(coord, queue, m.id, m.steps[0].id);
    coord.onSpecialistResult({
      objectiveId: 'obj_a', role: 'BROWSER', status: 'COMPLETED_VERIFIED',
      verification: 'VERIFIED', summary: 'URL verified: http://x/',
    });

    expect(coord.evidenceFor(m.id, m.steps[0].id)?.objectiveId).toBe('obj_a');
    expect(coord.evidenceFor(m.id, m.steps[0].id)?.role).toBe('BROWSER');
    // The OTHER step got nothing — attribution is exact, not sprayed.
    expect(coord.evidenceFor(m.id, m.steps[1].id)).toBeNull();
  });

  it('no running-task binding → specialist events are NOT attributed (never guessed)', () => {
    const { missions, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1'] });
    coord.onSpecialistResult({
      objectiveId: 'obj_x', role: 'BROWSER', status: 'COMPLETED_VERIFIED',
      verification: 'VERIFIED', summary: 'somewhere',
    });
    expect(coord.evidenceFor(m.id, m.steps[0].id)).toBeNull();
    expect(coord.verificationOf(m.id)).toBe('NONE');
  });

  it('a non-mission task (no missionId/stepId) never receives attribution', () => {
    const { missions, queue, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1'] });
    const task = queue.enqueue({ objective: 'plain task', priority: 3 });
    queue.markRunning(task.id);
    coord.bindRunningTask(task.id);
    coord.onSpecialistResult({ objectiveId: 'obj_y', verification: 'VERIFIED', summary: 'x' });
    expect(coord.evidenceFor(m.id, m.steps[0].id)).toBeNull();
  });

  it('a result without objectiveId is ignored entirely', () => {
    const { missions, queue, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1'] });
    bindRunning(coord, queue, m.id, m.steps[0].id);
    coord.onSpecialistResult({ verification: 'VERIFIED', summary: 'no id' });
    expect(coord.evidenceFor(m.id, m.steps[0].id)).toBeNull();
  });

  it('an unparseable verification level stores UNVERIFIED — never upgraded', () => {
    const { missions, queue, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1'] });
    bindRunning(coord, queue, m.id, m.steps[0].id);
    coord.onSpecialistResult({ objectiveId: 'obj_u', verification: 'SOMETHING_ELSE', summary: 'ran' });
    expect(coord.evidenceFor(m.id, m.steps[0].id)?.verification).toBe('UNVERIFIED');
  });

  it('re-binding to the next step moves attribution forward (serial execution)', () => {
    const { missions, queue, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1', 's2'] });

    bindRunning(coord, queue, m.id, m.steps[0].id);
    coord.onSpecialistResult({ objectiveId: 'obj_1', verification: 'VERIFIED', summary: 'first' });
    coord.bindRunningTask(null); // settled

    bindRunning(coord, queue, m.id, m.steps[1].id);
    coord.onSpecialistResult({ objectiveId: 'obj_2', verification: 'UNVERIFIED', summary: 'second' });

    expect(coord.evidenceFor(m.id, m.steps[0].id)?.objectiveId).toBe('obj_1');
    expect(coord.evidenceFor(m.id, m.steps[1].id)?.objectiveId).toBe('obj_2');
  });
});

// ── 2. Verification aggregation (the core honesty contract) ─────

describe('mission coordinator: verification aggregation', () => {
  it('VERIFIED requires EVERY completed step to carry VERIFIED evidence', () => {
    const { missions, queue, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1', 's2'] });

    const t1 = bindRunning(coord, queue, m.id, m.steps[0].id);
    coord.onSpecialistResult({ objectiveId: 'obj_1', verification: 'VERIFIED', summary: 'first verified' });
    queue.markCompleted(t1, 'first verified');

    const t2 = bindRunning(coord, queue, m.id, m.steps[1].id);
    coord.onSpecialistResult({ objectiveId: 'obj_2', verification: 'VERIFIED', summary: 'second verified' });
    queue.markCompleted(t2, 'second verified');

    missions.settleStep(m.id, m.steps[0].id, { success: true, result: 'first verified', verification: 'VERIFIED' });
    missions.settleStep(m.id, m.steps[1].id, { success: true, result: 'second verified', verification: 'VERIFIED' });

    expect(missions.get(m.id)!.verification).toBe('VERIFIED');
    expect(coord.verificationOf(m.id)).toBe('VERIFIED');
  });

  it('one unverified step among verified ones → PARTIAL (never upgraded)', () => {
    const { missions, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1', 's2'] });
    missions.settleStep(m.id, m.steps[0].id, { success: true, result: 'v1', verification: 'VERIFIED' });
    missions.settleStep(m.id, m.steps[1].id, { success: true, result: 'no evidence', verification: 'UNVERIFIED' });
    expect(missions.get(m.id)!.verification).toBe('PARTIAL');
    expect(coord.verificationOf(m.id)).toBe('PARTIAL');
  });

  it('completed steps with NO verification evidence at all → UNVERIFIED', () => {
    const { missions, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1'] });
    missions.settleStep(m.id, m.steps[0].id, { success: true, result: 'done' }); // no verification
    expect(missions.get(m.id)!.verification).toBe('UNVERIFIED');
    expect(coord.verificationOf(m.id)).toBe('UNVERIFIED');
  });

  it('nothing completed → NONE (both store and coordinator)', () => {
    const { missions, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1'] });
    expect(missions.get(m.id)!.verification).toBeUndefined();
    expect(coord.verificationOf(m.id)).toBe('NONE');
  });

  it('PARTIAL step evidence yields a PARTIAL mission', () => {
    const { missions } = make();
    const m = missions.create({ objective: 'o', steps: ['s1'] });
    missions.settleStep(m.id, m.steps[0].id, { success: true, result: 'half', verification: 'PARTIAL' });
    expect(missions.get(m.id)!.verification).toBe('PARTIAL');
  });

  it('a failed step does not corrupt verification (completed-only aggregation)', () => {
    const { missions } = make();
    const m = missions.create({ objective: 'o', steps: ['ok', 'bad'] });
    const s1 = missions.startOrResume(m.id)!;
    missions.settleStep(m.id, s1.step.id, { success: true, result: 'done', verification: 'VERIFIED' });
    const s2 = missions.startOrResume(m.id)!;
    missions.settleStep(m.id, s2.step.id, { success: false, error: 'boom' });
    const after = missions.get(m.id)!;
    expect(after.status).toBe('failed');
    expect(after.verification).toBe('VERIFIED'); // the completed step IS verified
  });

  it('verification derives ONLY from real settlement — an undefined level on a fresh mission', () => {
    const { missions } = make();
    const fresh = missions.create({ objective: 'o2', steps: ['x'] });
    expect(missions.get(fresh.id)!.verification).toBeUndefined();
  });
});

// ── 3. Template expansion (real evidence only) ──────────────────

describe('mission coordinator: template expansion', () => {
  it('resolves {{evidence:stepId}} from REAL VERIFIED evidence', () => {
    const { missions, queue, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['find the page', 'use its title'] });
    const t = bindRunning(coord, queue, m.id, m.steps[0].id);
    coord.onSpecialistResult({ objectiveId: 'obj_1', verification: 'VERIFIED', summary: 'URL verified: http://x/ ("Title")' });
    queue.markCompleted(t, 'found');

    const expanded = coord.expandTemplate(`open {{evidence:${m.steps[0].id}}} and verify`, m.id);
    expect(expanded).toContain('URL verified: http://x/');
    expect(expanded).not.toContain('{{evidence:');
  });

  it('an UNKNOWN step reference resolves to an explicit marker — never fabricated', () => {
    const { coord } = make();
    const expanded = coord.expandTemplate('use {{evidence:step_nope}}', 'mission_none');
    expect(expanded).toBe('use {{evidence:step_nope — not available}}');
  });

  it('an UNVERIFIED reference stays explicit — the evidence never pretends to be verified', () => {
    const { missions, queue, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1', 's2'] });
    bindRunning(coord, queue, m.id, m.steps[0].id);
    coord.onSpecialistResult({ objectiveId: 'obj_1', verification: 'UNVERIFIED', summary: 'ran without proof' });

    const expanded = coord.expandTemplate(`continue from {{evidence:${m.steps[0].id}}}`, m.id);
    expect(expanded).toContain('UNVERIFIED');
    expect(expanded).not.toMatch(/\{\{evidence:[^}]*— not available/);
  });

  it('text without placeholders passes through unchanged', () => {
    const { coord } = make();
    expect(coord.expandTemplate('plain objective text', 'mission_none')).toBe('plain objective text');
  });
});

// ── 4. Shared mission context (bounded, real) ───────────────────

describe('mission coordinator: shared context', () => {
  it('contextFor returns bounded completed evidence + failed results + progress', () => {
    const { missions, queue, coord } = make();
    const m = missions.create({ objective: 'buy the parts', steps: ['s1', 's2', 's3'] });
    const t1 = bindRunning(coord, queue, m.id, m.steps[0].id);
    coord.onSpecialistResult({ objectiveId: 'obj_1', verification: 'VERIFIED', summary: 'evidence one' });
    queue.markCompleted(t1, 'evidence one');
    missions.settleStep(m.id, m.steps[0].id, { success: true, result: 'evidence one', verification: 'VERIFIED' });
    missions.settleStep(m.id, m.steps[1].id, { success: false, error: 'connection refused' });

    const ctx = coord.contextFor(m.id, m.steps[2].id);
    expect(ctx.missionObjective).toBe('buy the parts');
    expect(ctx.completedEvidence).toHaveLength(1);
    expect(ctx.completedEvidence[0]).toMatchObject({ stepId: m.steps[0].id, verified: true });
    expect(ctx.completedEvidence[0].summary).toBe('evidence one');
    expect(ctx.failedResults).toHaveLength(1);
    expect(ctx.failedResults[0]).toContain('connection refused');
    expect(ctx.progress).toBeGreaterThan(0);
  });

  it('renderContext returns empty for a step with no prior evidence (no filler)', () => {
    const { missions, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1'] });
    expect(coord.renderContext(coord.contextFor(m.id, m.steps[0].id))).toBe('');
  });

  it('renderContext frames evidence as background with honest verified labels', () => {
    const { missions, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1', 's2', 's3'] });
    missions.settleStep(m.id, m.steps[0].id, { success: true, result: 'found X', verification: 'VERIFIED' });
    missions.settleStep(m.id, m.steps[1].id, { success: false, error: 'the first approach failed' });
    const rendered = coord.renderContext(coord.contextFor(m.id, m.steps[2].id));
    expect(rendered).toContain('MISSION CONTEXT');
    expect(rendered).toContain('Mission objective: o');
    expect(rendered).toContain('[VERIFIED] found X');
    expect(rendered).toContain('Failed steps so far');
  });

  it('evidence detail is bounded (MAX_DETAIL respected)', () => {
    const { missions, queue, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1'] });
    bindRunning(coord, queue, m.id, m.steps[0].id);
    coord.onSpecialistResult({ objectiveId: 'obj_1', verification: 'VERIFIED', summary: 'x'.repeat(10_000) });
    expect(coord.evidenceFor(m.id, m.steps[0].id)!.detail!.length).toBeLessThanOrEqual(200);
  });
});

// ── 5. Cancellation propagation (no orphan specialists) ─────────

describe('mission coordinator: cancellation propagation', () => {
  it('cancelling a mission cancels ONLY its queued/running tasks', () => {
    // ONE coordinator + ITS OWN queue — cancelMission walks the queue the
    // coordinator was actually constructed with.
    const { missions, queue, coord } = make();
    const mine = missions.create({ objective: 'mine', steps: ['a', 'b'] });
    const other = missions.create({ objective: 'other', steps: ['c'] });

    const mineQueued = queue.enqueue({ objective: 'mine queued', priority: 3, missionId: mine.id, missionStepId: mine.steps[1].id });
    const mineRunning = queue.enqueue({ objective: 'mine running', priority: 3, missionId: mine.id, missionStepId: mine.steps[0].id });
    queue.markRunning(mineRunning.id);
    const otherQueued = queue.enqueue({ objective: 'other queued', priority: 3, missionId: other.id, missionStepId: other.steps[0].id });

    const cancelled = coord.cancelMission(mine.id);
    expect(cancelled.sort()).toEqual([mineQueued.id, mineRunning.id].sort());
    expect(queue.get(mineQueued.id)!.status).toBe('cancelled');
    expect(queue.get(mineRunning.id)!.status).toBe('cancelled');
    expect(queue.get(otherQueued.id)!.status).toBe('queued'); // untouched
  });

  it('terminal mission tasks are left alone (no double-cancel of history)', () => {
    const { queue, coord } = make();
    const done = queue.enqueue({ objective: 'already done', priority: 3, missionId: 'm_x', missionStepId: 's_x' });
    queue.markRunning(done.id);
    queue.markCompleted(done.id, 'finished');
    expect(coord.cancelMission('m_x')).toEqual([]);
    expect(queue.get(done.id)!.status).toBe('completed');
  });

  it('a mission with no tasks cancels nothing', () => {
    const { coord } = make();
    expect(coord.cancelMission('mission_ghost')).toEqual([]);
  });

  it('forget() drops the mission evidence maps (bounded memory)', () => {
    const { missions, queue, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1'] });
    bindRunning(coord, queue, m.id, m.steps[0].id);
    coord.onSpecialistResult({ objectiveId: 'obj_1', verification: 'VERIFIED', summary: 'x' });
    expect(coord.evidenceFor(m.id, m.steps[0].id)).not.toBeNull();
    coord.forget(m.id);
    expect(coord.evidenceFor(m.id, m.steps[0].id)).toBeNull();
    expect(coord.snapshot(m.id).steps).toHaveLength(0);
  });
});

// ── 6. Snapshot (HUD/REST view) ─────────────────────────────────

describe('mission coordinator: snapshot', () => {
  it('snapshot exposes only steps with real objective/verification data', () => {
    const { missions, queue, coord } = make();
    const m = missions.create({ objective: 'o', steps: ['s1', 's2'] });
    bindRunning(coord, queue, m.id, m.steps[0].id);
    coord.onSpecialistResult({ objectiveId: 'obj_1', status: 'COMPLETED_VERIFIED', verification: 'VERIFIED' });

    const snap = coord.snapshot(m.id);
    expect(snap.verification).toBe('NONE'); // nothing settled/completed yet
    expect(snap.steps).toHaveLength(1);
    expect(snap.steps[0]).toMatchObject({
      stepId: m.steps[0].id, objectiveId: 'obj_1', verification: 'VERIFIED', status: 'COMPLETED_VERIFIED',
    });
  });

  it('snapshot of an unknown mission is honest (NONE, no steps)', () => {
    const { coord } = make();
    const snap = coord.snapshot('mission_ghost');
    expect(snap.verification).toBe('NONE');
    expect(snap.steps).toHaveLength(0);
  });
});
