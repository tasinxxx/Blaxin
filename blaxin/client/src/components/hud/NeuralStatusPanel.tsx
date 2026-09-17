import React from 'react';
import { useAppStore } from '../../utils/store';
import { Panel } from './Panel';

// NEURAL_STATUS panel — real agent state, real provider/model info and
// real task progress. Bars reflect actual session-derived values; the
// design's decorative arc ring is kept as presentation.

const STATE_LABELS: Record<string, string> = {
  idle: 'IDLE',
  thinking: 'THINKING',
  planning: 'PLANNING',
  executing: 'EXECUTING',
  observing: 'OBSERVING',
  waiting: 'WAITING',
  completed: 'COMPLETED',
  error: 'ERROR',
  'requires-confirmation': 'CONFIRM',
};

export function NeuralStatusPanel() {
  const agentState = useAppStore((s) => s.agentState);
  const agentDescription = useAppStore((s) => s.agentDescription);
  const currentTask = useAppStore((s) => s.currentTask);
  const activeModel = useAppStore((s) => s.activeModel);
  const activeProvider = useAppStore((s) => s.activeProvider);
  const connected = useAppStore((s) => s.connected);
  const queue = useAppStore((s) => s.queue);

  // Real progress: completed steps of the current task (0 when none).
  const steps = currentTask?.steps ?? [];
  const doneSteps = steps.filter((s) => s.state === 'completed').length;
  const taskPercent = steps.length > 0 ? Math.round((doneSteps / steps.length) * 100) : 0;
  const running = agentState !== 'idle' && agentState !== 'completed' && agentState !== 'error';

  // Real message count drives the "context" bar (bounded to 200 msgs).
  const messageCount = useAppStore((s) => s.messages.length);

  return (
    <Panel name="NEURAL_STATUS" className="jh-neural">
      <div className="jh-bar-row">
        <div className="jh-bar-label">
          NEURAL NET <span>{connected ? (running ? 'ACTIVE' : 'READY') : 'OFFLINE'}</span>
        </div>
        <div className="jh-bar-track">
          <div className="jh-bar-fill" style={{ width: connected ? (running ? '96%' : '62%') : '4%' }} />
        </div>
      </div>
      <div
        className="jh-bar-row"
        role="progressbar"
        aria-label="Task progress"
        aria-valuenow={steps.length > 0 ? taskPercent : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="jh-bar-label">
          TASK PROGRESS <span>{steps.length > 0 ? `${taskPercent}%` : '—'}</span>
        </div>
        <div className="jh-bar-track">
          <div className="jh-bar-fill purple" style={{ width: `${taskPercent}%` }} />
        </div>
      </div>
      <div className="jh-bar-row">
        <div className="jh-bar-label">
          CONTEXT <span>{messageCount > 0 ? `${Math.min(100, Math.round((messageCount / 200) * 100))}%` : '0%'}</span>
        </div>
        <div className="jh-bar-track">
          <div className="jh-bar-fill green" style={{ width: `${Math.min(100, Math.round((messageCount / 200) * 100))}%` }} />
        </div>
      </div>
      <div className="jh-neural-state">
        <div className="jh-arc-container">
          <div className="jh-arc-ring r1" />
          <div className="jh-arc-ring r2" />
          <div className="jh-arc-ring r3" />
          <div className="core" />
        </div>
        <div className="jh-state-text">{STATE_LABELS[agentState] || String(agentState).toUpperCase()}</div>
        <div className="jh-neural-metrics">
          {[
            activeProvider ? `PROV: ${activeProvider}` : null,
            activeModel ? `MODEL: ${activeModel}` : null,
            queue.filter((t) => t.status === 'running').length > 0 ? 'SCHEDULER: RUN' : 'SCHEDULER: IDLE',
            agentDescription ? agentDescription.slice(0, 60) : null,
          ]
            .filter(Boolean)
            .join(' | ') || 'STANDBY'}
        </div>
      </div>
    </Panel>
  );
}
