// Mission journal (§20): one bounded, persisted record of what REALLY ran.
// Every line must be traceable to a real runtime event — no decorative
// entries, no invented statuses, and an action is never left RUNNING after
// it has honestly settled.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MissionJournal, JournalEntry } from '../utils/mission-journal.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blaxin-journal-'));
  file = join(dir, 'journal.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const make = () => new MissionJournal({ filePath: file });
const kinds = (entries: JournalEntry[]) => entries.map((e) => e.kind);
const first = (entries: JournalEntry[], kind: string) => entries.find((e) => e.kind === kind);

describe('mission journal — real event ingestion', () => {
  it('records a full real run: COMMAND → ROUTER → PLAN → ACTION → OBSERVATION → RESULT', () => {
    const j = make();

    j.ingest('jarvis-event', {
      kind: 'directive-issued', directiveId: 'jd_1', taskId: 't1',
      complexity: 'standard', reason: 'default-agent-loop', source: 'text',
      goal: 'open youtube and search for lofi',
    });
    j.ingest('task-progress', {
      id: 't1', instruction: 'open youtube and search for lofi',
      steps: [{ id: 's1', description: 'Open YouTube', toolName: 'browser', state: 'pending' }],
    });
    j.ingest('tool-execution', { toolName: 'browser', args: {}, state: 'executing', stepId: 's1' });
    j.ingest('tool-execution', {
      toolName: 'browser', args: {}, state: 'completed', stepId: 's1',
      result: 'Opened URL: https://youtube.com — OBSERVED at https://youtube.com/ (URL verified).',
      verification: { method: 'url-match', status: 'SUCCESS', detail: 'URL verified: https://youtube.com/' },
    });
    j.ingest('task-complete', {
      taskId: 't1', kind: 'direct', executionMode: 'DETERMINISTIC', totalMs: 12, modelCalls: 0, toolCalls: 1,
    });

    const entries = j.list();
    const order = kinds(entries).reverse(); // list() is newest-first
    expect(order).toEqual(['COMMAND', 'ROUTER', 'PLAN', 'ACTION', 'OBSERVATION', 'VERIFICATION', 'RESULT']);

    // ONE action line per real action — updated in place, never duplicated.
    expect(entries.filter((e) => e.kind === 'ACTION')).toHaveLength(1);
    const action = first(entries, 'ACTION')!;
    expect(action.actionId).toBe('s1');
    expect(action.action).toBe('browser');
    expect(action.specialist).toBe('BROWSER');
    expect(action.status).toBe('COMPLETED');
    expect(action.intent).toBe('Open YouTube');
    expect(action.objective).toBe('open youtube and search for lofi');
    expect(action.observation).toContain('OBSERVED at');

    // Verification carries the REAL method/status from the tool.
    const v = first(entries, 'VERIFICATION')!;
    expect(v.verification).toEqual({
      method: 'url-match', status: 'SUCCESS', detail: 'URL verified: https://youtube.com/',
    });
    expect(v.status).toBe('COMPLETED');

    // The result line carries the real execution mode + metrics.
    const result = first(entries, 'RESULT')!;
    expect(result.status).toBe('COMPLETED');
    expect(result.detail).toContain('DETERMINISTIC');
    expect(result.detail).toContain('12ms');
  });

  it('records an honest UNVERIFIED line when verification could not observe reality', () => {
    const j = make();
    j.ingest('tool-execution', {
      toolName: 'browser', state: 'failed', stepId: 's9',
      error: 'open_url NOT verified — could not read the page location',
      verification: { method: 'url-match', status: 'UNKNOWN', detail: 'evaluation failed' },
    });
    const entries = j.list();
    expect(first(entries, 'ACTION')!.status).toBe('FAILED');
    expect(first(entries, 'ACTION')!.failure).toContain('NOT verified');
    expect(first(entries, 'VERIFICATION')!.status).toBe('UNVERIFIED');
  });

  it('records a bounded retry as an explicit RECOVERY line with the real retry count', () => {
    const j = make();
    j.ingest('tool-execution', { toolName: 'terminal', state: 'executing', stepId: 's1' });
    j.ingest('tool-execution', { toolName: 'terminal', state: 'retrying', stepId: 's1' });
    j.ingest('tool-execution', { toolName: 'terminal', state: 'retrying', stepId: 's1' });
    j.ingest('tool-execution', { toolName: 'terminal', state: 'completed', stepId: 's1', result: 'ok' });

    const entries = j.list();
    expect(entries.filter((e) => e.kind === 'RECOVERY')).toHaveLength(2);
    const action = first(entries, 'ACTION')!;
    expect(action.retries).toBe(2);
    expect(action.recovery).toBe('bounded retry with backoff');
    expect(action.status).toBe('COMPLETED');
  });

  it('records a real confirmation gate as BLOCKED with the tool from the gate payload', () => {
    const j = make();
    j.ingest('confirmation-required', {
      taskId: 't1', stepId: 'call_1', runtimeStepId: 's1',
      description: 'Execute browser: Opening https://example.com…',
      action: JSON.stringify({ tool: 'browser', args: { action: 'open_url' } }),
    });
    const blocked = first(j.list(), 'ACTION')!;
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.action).toBe('browser');
    expect(blocked.specialist).toBe('BROWSER');
    expect(blocked.intent).toContain('Opening');
    expect(blocked.failure).toContain('authorization');
  });

  it('never invents a tool from a malformed gate payload', () => {
    const j = make();
    j.ingest('confirmation-required', { stepId: 's1', action: '{not json' });
    const blocked = first(j.list(), 'ACTION')!;
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.action).toBe('unknown');
    expect(blocked.specialist).toBeUndefined();
  });

  it('records real browser session recovery events', () => {
    const j = make();
    j.ingest('browser-session', { event: { type: 'session-desync', detail: 'target vanished' } });
    j.ingest('browser-session', { event: { type: 'session-recovered', detail: 'adopted existing page' } });
    j.ingest('browser-session', { event: { type: 'session-lost', detail: 'recovery exhausted' } });

    const recs = j.list().filter((e) => e.kind === 'RECOVERY');
    expect(recs.map((r) => r.status)).toEqual(['FAILED', 'RECOVERED', 'RECOVERING']); // newest first
    expect(recs[0].failure).toContain('exhausted');
    expect(recs[2].recovery).toContain('bounded');
  });

  it('records memory selections and mission status transitions', () => {
    const j = make();
    j.ingest('memory-selected', {
      selections: [{ layer: 'episode', id: 'ep_1', reason: 'objective overlap' }],
      chars: 120,
    });
    j.ingest('mission-progress', {
      missions: [{ id: 'm1', objective: 'research task', status: 'running', steps: [{ status: 'completed' }, { status: 'pending' }] }],
    });
    j.ingest('mission-progress', {
      missions: [{ id: 'm1', objective: 'research task', status: 'completed', steps: [{ status: 'completed' }, { status: 'completed' }] }],
    });

    const entries = j.list();
    expect(first(entries, 'MEMORY')!.detail).toContain('episode/ep_1');
    const results = entries.filter((e) => e.kind === 'RESULT' && e.missionId === 'm1');
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('COMPLETED');
    expect(results[0].detail).toContain('2/2');
  });

  it('produces NO entries for events that carry no real information', () => {
    const j = make();
    j.ingest('agent-message', { role: 'assistant', content: 'hi' });
    j.ingest('tool-execution', {});
    j.ingest('jarvis-event', { kind: 'something-else' });
    j.ingest('memory-selected', { selections: [] });
    j.ingest('error', {});
    j.ingest('unknown-event', { whatever: true });
    expect(j.list()).toHaveLength(0);
  });
});

describe('mission journal — bounded + durable', () => {
  it('persists across a restart', () => {
    const a = make();
    a.ingest('jarvis-event', { kind: 'directive-issued', goal: 'list /tmp', taskId: 't1', complexity: 'fast', reason: 'deterministic-single-tool' });
    expect(existsSync(file)).toBe(true);

    const b = make();
    const loaded = b.list();
    expect(loaded).toHaveLength(2);
    expect(loaded[1].objective).toBe('list /tmp');
    // Sequence continues rather than restarting from zero.
    b.ingest('task-complete', { taskId: 't1', totalMs: 4, modelCalls: 0, toolCalls: 1, executionMode: 'DETERMINISTIC' });
    expect(b.list()[0].seq).toBeGreaterThan(loaded[0].seq);
  });

  it('stays bounded and drops the oldest lines only', () => {
    const j = make();
    for (let i = 0; i < 500; i++) {
      j.ingest('jarvis-event', {
        kind: 'directive-issued', goal: `command ${i}`, taskId: `t${i}`,
        complexity: 'fast', reason: 'deterministic-single-tool',
      });
    }
    const entries = j.list(1000);
    expect(entries.length).toBeLessThanOrEqual(400);
    // Newest kept, oldest dropped.
    expect(entries[0].objective).toBe('command 499');
    expect(entries.some((e) => e.objective === 'command 0')).toBe(false);
  });

  it('clear() empties the journal and the persisted file', () => {
    const j = make();
    j.ingest('error', { message: 'boom', code: 'TEST' });
    expect(j.list()).toHaveLength(1);
    j.clear();
    expect(j.list()).toHaveLength(0);
    expect(make().list()).toHaveLength(0);
  });
});
