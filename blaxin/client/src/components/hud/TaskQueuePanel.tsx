import React from 'react';
import { useAppStore } from '../../utils/store';
import { Panel } from './Panel';

// TASK_QUEUE panel — the REAL persistent queue mirrored from the server
// (queue-updated events). Every row is a real task; actions send real
// queue-cancel/pause/resume messages. No simulated rows, ever.

function fmtElapsed(startedAt?: number, endedAt?: number): string {
  if (!startedAt) return '—';
  const end = endedAt ?? Date.now();
  const s = Math.max(0, Math.floor((end - startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const STATUS_CELL: Record<string, { cls: string; label: string }> = {
  running: { cls: 'running', label: '▶ RUN' },
  completed: { cls: 'done', label: '◉ DONE' },
  queued: { cls: 'queued', label: '⏳ WAIT' },
  paused: { cls: 'paused', label: '⏸ HOLD' },
  failed: { cls: 'failed', label: '✕ FAIL' },
  cancelled: { cls: 'cancelled', label: '○ CUT' },
};

export function TaskQueuePanel({ onQueueAction }: { onQueueAction: (id: string, action: 'cancel' | 'pause' | 'resume') => void }) {
  const queue = useAppStore((s) => s.queue);

  // Newest first; show at most 6 rows in the panel.
  const rows = [...queue].reverse().slice(0, 6);

  return (
    <Panel name="TASK_QUEUE" className="jh-tasks" dot={rows.some((r) => r.status === 'running') ? 'amber' : 'green'}>
      <table className="jh-task-table">
        <thead>
          <tr>
            <th scope="col" style={{ textAlign: 'left' }}>TASK</th>
            <th scope="col" style={{ textAlign: 'left' }}>STATUS</th>
            <th scope="col" style={{ textAlign: 'right' }}>T</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td className="jh-task-id" colSpan={3}>queue empty</td>
            </tr>
          )}
          {rows.map((t) => {
            const cell = STATUS_CELL[t.status] || { cls: 'queued', label: t.status.toUpperCase() };
            const short = t.objective.length > 26 ? `${t.objective.slice(0, 26)}…` : t.objective;
            const idShort = t.id.length > 8 ? t.id.slice(0, 8) : t.id;
            return (
              <tr key={t.id} className={t.status === 'running' ? 'jh-task-row-active' : ''}>
                <td>
                  <div className="jh-task-name" title={t.objective}>{short}</div>
                  <div className="jh-task-id">#{idShort}{t.priority <= 2 ? ' ·P!' : ''}</div>
                </td>
                <td className="jh-task-status">
                  <span className={cell.cls}>{cell.label}</span>
                  {t.status === 'queued' && (
                    <div className="jh-task-actions">
                      <button type="button" className="jh-task-act" title={`Cancel queued task ${idShort}`} aria-label={`Cancel queued task: ${t.objective}`} onClick={() => onQueueAction(t.id, 'cancel')}>× CANC</button>
                    </div>
                  )}
                  {t.status === 'paused' && (
                    <div className="jh-task-actions">
                      <button type="button" className="jh-task-act" title={`Resume paused task ${idShort}`} aria-label={`Resume paused task: ${t.objective}`} onClick={() => onQueueAction(t.id, 'resume')}>▶ RES</button>
                    </div>
                  )}
                  {t.status === 'running' && (
                    <div className="jh-task-actions">
                      <button type="button" className="jh-task-act" title={`Pause running task ${idShort}`} aria-label={`Pause running task: ${t.objective}`} onClick={() => onQueueAction(t.id, 'pause')}>⏸ HOLD</button>
                    </div>
                  )}
                </td>
                <td className="jh-task-time">{fmtElapsed(t.startedAt, t.endedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
