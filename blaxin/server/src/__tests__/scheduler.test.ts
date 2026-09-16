import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskQueue } from '../utils/task-queue.js';
import { MissionStore } from '../utils/missions.js';
import { JarvisScheduler, SchedulerOrchestratorLike } from '../utils/scheduler.js';

/** Fake orchestrator that records what it is asked to run and lets the
 * test drive real completion events through the scheduler. */
class FakeOrchestrator implements SchedulerOrchestratorLike {
  ran: string[] = [];
  running = false;
  isBusy(): boolean { return this.running; }
  async processMessage(message: string): Promise<void> {
    this.running = true;
    this.ran.push(message);
  }
  stop(): void { this.running = false; }
  clearHistory(): void { /* no-op */ }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blaxin-scheduler-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const queue = new TaskQueue({ file: join(dir, 'q.json') });
  const missions = new MissionStore({ file: join(dir, 'm.json') });
  const orchestrator = new FakeOrchestrator();
  const events: Array<{ event: string; data: unknown }> = [];
  const scheduler = new JarvisScheduler({
    queue,
    missions,
    orchestrator,
    emit: (event, data) => events.push({ event, data }),
  });
  return { queue, missions, orchestrator, scheduler, events };
}

/** Simulate the orchestrator finishing the current run with a real
 * terminal agent-state + task-complete pair (what index.ts wires). */
function finishRun(scheduler: JarvisScheduler, orchestrator: FakeOrchestrator, state: 'completed' | 'error' | 'idle') {
  orchestrator.running = false;
  scheduler.onOrchestratorEvent('agent-state', { state });
  scheduler.onOrchestratorEvent('task-complete', { kind: 'direct', totalMs: 5, modelCalls: 0, toolCalls: 1 });
}

describe('scheduler: queue execution', () => {
  it('runs the first queued message and settles it on completion', () => {
    const { queue, orchestrator, scheduler } = setup();
    const task = scheduler.enqueueUserMessage('list /tmp');
    expect(orchestrator.ran).toEqual(['list /tmp']);
    expect(queue.get(task.id)?.status).toBe('running');

    finishRun(scheduler, orchestrator, 'completed');
    expect(queue.get(task.id)?.status).toBe('completed');
    expect(queue.get(task.id)?.result).toContain('Fast-path task done');
  });

  it('runs queued messages sequentially, one at a time', () => {
    const { queue, orchestrator, scheduler } = setup();
    const a = scheduler.enqueueUserMessage('task a');
    const b = scheduler.enqueueUserMessage('task b');
    // Only the first runs; b waits in the queue.
    expect(orchestrator.ran).toEqual(['task a']);
    expect(queue.get(b.id)?.status).toBe('queued');

    finishRun(scheduler, orchestrator, 'completed');
    expect(orchestrator.ran).toEqual(['task a', 'task b']);
    expect(queue.get(a.id)?.status).toBe('completed');
    expect(queue.get(b.id)?.status).toBe('running');
  });

  it('marks a task failed when the agent ends in error state', () => {
    const { queue, orchestrator, scheduler } = setup();
    const task = scheduler.enqueueUserMessage('risky');
    finishRun(scheduler, orchestrator, 'error');
    expect(queue.get(task.id)?.status).toBe('failed');
  });

  it('cancels the task when the user stops the agent', () => {
    const { queue, orchestrator, scheduler } = setup();
    const task = scheduler.enqueueUserMessage('long run');
    scheduler.stop(); // orchestrator.stop() → agent ends idle
    finishRun(scheduler, orchestrator, 'idle');
    expect(queue.get(task.id)?.status).toBe('cancelled');
  });

  it('emits real queue-updated events', () => {
    const { scheduler, events } = setup();
    scheduler.enqueueUserMessage('hello');
    expect(events.some((e) => e.event === 'queue-updated')).toBe(true);
  });

  it('carries the REAL bulk aggregate onto the settled mission step (no synthesis)', () => {
    const { queue, missions, orchestrator, scheduler } = setup();
    missions.create({ objective: 'Organize downloads', steps: ['organize the files by type'] });
    scheduler.pump();
    const stepTask = queue.list().find((t) => t.missionId)!;

    // The orchestrator really settled a bulk action while THIS task ran:
    // a completed tool-execution carrying the tool's own aggregate block.
    scheduler.onOrchestratorEvent('tool-execution', {
      toolName: 'bulk-files',
      state: 'completed',
      stepId: 'runtime-step-1',
      resultData: {
        operation: 'organize-by-extension',
        requested: 12,
        verified: 12,
        failed: 0,
        skippedByGuard: 2,
      },
    });
    finishRun(scheduler, orchestrator, 'completed');

    const step = missions.get(stepTask.missionId!)!.steps[0];
    expect(step.status).toBe('completed');
    expect(step.bulk).toEqual({
      operation: 'organize-by-extension',
      affected: 12,
      succeeded: 12,
      failed: 0,
      skipped: 2,
      duplicateGroups: undefined,
    });
  });

  it('carries duplicate-group counts for a dedupe step and resets between tasks', () => {
    const { queue, missions, orchestrator, scheduler } = setup();
    missions.create({ objective: 'Clean disk', steps: ['find duplicate files', 'report free space'] });
    scheduler.pump();
    const t1 = queue.list().find((t) => t.missionId)!;

    scheduler.onOrchestratorEvent('tool-execution', {
      toolName: 'bulk-files',
      state: 'completed',
      resultData: { operation: 'dedupe', requested: 9, verified: 4, failed: 0, duplicateGroups: 2, skippedByGuard: 1 },
    });
    finishRun(scheduler, orchestrator, 'completed');
    const step1 = missions.get(t1.missionId!)!.steps[0];
    expect(step1.bulk?.duplicateGroups).toBe(2);
    expect(step1.bulk?.succeeded).toBe(4);

    // Step 2 runs — a NON-bulk task must not inherit the previous block.
    const t2 = queue.list().find((t) => t.missionId && t.id !== t1.id)!;
    expect(t2.status).toBe('running');
    scheduler.onOrchestratorEvent('tool-execution', {
      toolName: 'system-info',
      state: 'completed',
      resultData: { operation: 'whatever' },
    });
    finishRun(scheduler, orchestrator, 'completed');
    const step2 = missions.get(t1.missionId!)!.steps[1];
    expect(step2.status).toBe('completed');
    expect(step2.bulk).toBeUndefined();
  });

  it('carries a FAILED bulk batch honestly (failed counts on the failed step)', () => {
    const { queue, missions, orchestrator, scheduler } = setup();
    missions.create({ objective: 'Risky cleanup', steps: ['delete duplicate files'] });
    scheduler.pump();
    const stepTask = queue.list().find((t) => t.missionId)!;

    scheduler.onOrchestratorEvent('tool-execution', {
      toolName: 'bulk-files',
      state: 'failed',
      resultData: { operation: 'dedupe', mode: 'delete_duplicates', requested: 5, verified: 2, failed: 3 },
    });
    // The overall task still completes (the agent reported the failed
    // action honestly and finished) — the step shows the real counts.
    finishRun(scheduler, orchestrator, 'completed');

    const step = missions.get(stepTask.missionId!)!.steps[0];
    expect(step.bulk?.failed).toBe(3);
    expect(step.bulk?.succeeded).toBe(2);
    expect(step.bulk?.affected).toBe(5);
  });

  it('never fabricates a bulk block from a malformed or non-bulk payload', () => {
    const { queue, missions, orchestrator, scheduler } = setup();
    missions.create({ objective: 'Clean disk', steps: ['organize files'] });
    scheduler.pump();
    const stepTask = queue.list().find((t) => t.missionId)!;

    // Malformed resultData and a non-bulk tool: nothing is invented.
    scheduler.onOrchestratorEvent('tool-execution', {
      toolName: 'bulk-files',
      state: 'completed',
      resultData: 'garbage',
    });
    scheduler.onOrchestratorEvent('tool-execution', {
      toolName: 'filesystem',
      state: 'completed',
      resultData: { operation: 'organize-by-extension', requested: 3, verified: 3 },
    });
    finishRun(scheduler, orchestrator, 'completed');
    expect(missions.get(stepTask.missionId!)!.steps[0].bulk).toBeUndefined();
  });
});

describe('scheduler: missions', () => {
  it('executes every mission step in order with checkpoints', () => {
    const { queue, missions, orchestrator, scheduler } = setup();
    const m = missions.create({ objective: 'Fix build', steps: ['run tests', 'fix failures', 're-run tests'] });

    scheduler.pump();
    expect(orchestrator.ran).toEqual(['run tests']);
    const t1 = queue.list().find((t) => t.missionId === m.id)!;
    expect(t1.status).toBe('running');

    finishRun(scheduler, orchestrator, 'completed');
    expect(queue.get(t1.id)?.status).toBe('completed');
    expect(missions.get(m.id)!.steps[0].status).toBe('completed');
    expect(missions.get(m.id)!.steps[0].checkpoint?.summary).toBeTruthy();

    // step 2 runs next automatically
    expect(orchestrator.ran).toEqual(['run tests', 'fix failures']);
    const t2 = queue.list().find((t) => t.missionId === m.id && t.id !== t1.id)!;
    finishRun(scheduler, orchestrator, 'completed');
    expect(missions.get(m.id)!.steps[1].status).toBe('completed');

    expect(orchestrator.ran).toEqual(['run tests', 'fix failures', 're-run tests']);
    const t3 = queue.list().find((t) => t.missionId === m.id && t.id !== t1.id && t.id !== t2.id)!;
    finishRun(scheduler, orchestrator, 'completed');

    const done = missions.get(m.id)!;
    expect(done.status).toBe('completed');
    expect(done.progress).toBe(1);
    expect(done.steps.every((s) => s.status === 'completed')).toBe(true);
  });

  it('a failed step ends the mission failed; retry requeues only it', () => {
    const { queue, missions, orchestrator, scheduler } = setup();
    const m = missions.create({ objective: 'o', steps: ['good', 'bad'] });
    scheduler.pump();
    const t1 = queue.list().find((t) => t.missionId === m.id)!;
    finishRun(scheduler, orchestrator, 'completed');

    const t2 = queue.list().find((t) => t.missionId === m.id && t.id !== t1.id)!;
    finishRun(scheduler, orchestrator, 'error');

    const failed = missions.get(m.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.steps[0].status).toBe('completed');
    expect(failed.steps[1].status).toBe('failed');

    expect(missions.retry(m.id)).toBe(true);
    scheduler.pump();
    // Only the failed step is re-executed, from a fresh queue task.
    const retriedTasks = queue.list().filter((t) => t.missionId === m.id && t.status === 'running');
    expect(retriedTasks).toHaveLength(1);
    expect(orchestrator.ran).toContain('bad');
  });

  it('pause stops the mission at its checkpoint; resume continues after it', () => {
    const { queue, missions, orchestrator, scheduler } = setup();
    const m = missions.create({ objective: 'o', steps: ['s1', 's2', 's3'] });

    scheduler.pump();
    const t1 = queue.list().find((t) => t.missionId === m.id)!;
    finishRun(scheduler, orchestrator, 'completed');
    // s2 auto-started by the pump right after s1 completed
    expect(orchestrator.ran).toEqual(['s1', 's2']);
    const t2 = queue.list().find((t) => t.missionId === m.id && t.id !== t1.id)!;

    missions.pause(m.id);
    finishRun(scheduler, orchestrator, 'completed');
    // while paused, the mission must NOT advance to s3
    expect(queue.list().filter((t) => t.missionId === m.id)).toHaveLength(2);
    expect(orchestrator.ran).toEqual(['s1', 's2']);

    missions.resume(m.id);
    scheduler.pump();
    // resumes from the last checkpoint: s3, never s1 again
    const t3 = queue.list().find((t) => t.missionId === m.id && t.id !== t1.id && t.id !== t2.id);
    expect(t3).toBeDefined();
    expect(t3!.objective).toBe('s3');
    finishRun(scheduler, orchestrator, 'completed');
    expect(missions.get(m.id)!.status).toBe('completed');
    expect(missions.get(m.id)!.steps[0].status).toBe('completed'); // checkpoint survived
  });
});