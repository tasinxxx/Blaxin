// Agency HUD panel — REAL worker visibility (directive §5/§21/§29).
//
// Every row is a real role activation of the running agent (server
// `agency-updated` snapshot). Statuses come only from real events:
//   RUNNING  — a real tool-execution executing event for this step id
//   WAITING  — a real confirmation-required gate is pending
//   RETRYING — real retry events were observed
//   DONE/FAILED/SKIPPED/CANCELLED — real settled outcomes
// If the agent has not run anything, the panel shows an honest empty
// state — never a decorative roster.

import React from 'react';
import { useAppStore, WorkerRecord } from '../../utils/store';
import { Panel } from './Panel';

const STATE_LABEL: Record<string, string> = {
  running: 'RUNNING',
  waiting: 'WAITING',
  retrying: 'RETRYING',
  blocked: 'BLOCKED',
  queued: 'QUEUED',
  completed: 'DONE',
  failed: 'FAILED',
  skipped: 'SKIPPED',
  cancelled: 'CANCELLED',
};

const STATE_STYLE: Record<string, React.CSSProperties> = {
  running: { color: 'var(--jh-ok, #35e08f)' },
  retrying: { color: 'var(--jh-warn, #ffc857)' },
  waiting: { color: 'var(--jh-warn, #ffc857)' },
  failed: { color: 'var(--jh-danger, #ff5470)' },
  skipped: { color: 'var(--jh-dim, #7d8aa5)' },
  cancelled: { color: 'var(--jh-dim, #7d8aa5)' },
  completed: { color: 'var(--jh-dim, #7d8aa5)' },
};

function isWorkerState(v: unknown): v is WorkerRecord['state'] {
  return typeof v === 'string' && v in STATE_LABEL;
}

function WorkerRow({ w }: { w: WorkerRecord }) {
  const state = isWorkerState(w.state) ? w.state : 'blocked';
  const scopeTag =
    w.state === 'skipped' || w.permissionScope === 'DENY' ? 'DENIED' : null;
  return (
    // The real state is part of the accessible name so a screen reader
    // hears "role — description — RUNNING", not just the visible text.
    <div
      className="jh-agency-worker"
      data-testid="agency-worker"
      title={w.error || w.result || w.description}
      aria-label={`${w.role}: ${w.description || w.tool} — ${STATE_LABEL[state] ?? String(state).toUpperCase()}`}
    >
      <span className="jh-agency-role">{w.role}</span>
      <span className="jh-agency-desc">
        {w.description || w.tool}
        {w.attempts > 0 ? ` · ${w.attempts} retry` : ''}
        {scopeTag ? ` · ${scopeTag}` : ''}
      </span>
      <span className="jh-agency-state" style={STATE_STYLE[state] ?? undefined}>
        {STATE_LABEL[state] ?? String(state).toUpperCase()}
      </span>
    </div>
  );
}

export function AgencyPanel() {
  const agency = useAppStore((s) => s.agency);

  // No snapshot at all → the server never reported (or pre-feature).
  // Honest label, not a fake roster.
  if (!agency) {
    return (
      <Panel name="AGENCY" icon="◇">
        <div className="jh-agency-empty">NO DATA</div>
      </Panel>
    );
  }

  const active = agency.workers.filter((w) =>
    ['running', 'waiting', 'retrying', 'blocked'].includes(w.state)
  );
  const recent = agency.workers.filter((w) => !active.includes(w)).slice(0, 4);
  const idleAgent = agency.agentState === 'idle';

  return (
    <Panel name="AGENCY" icon="◇">
      {/* aria-label (NOT role=status): the two e2e-pinned [role=status]
          regions must stay first/second in the DOM. */}
      <div className="jh-agency-head" data-testid="agency-head" aria-label={`Agent state: ${String(agency.agentState).toUpperCase()}`}>
        <span>AGENT {String(agency.agentState).toUpperCase()}</span>
        {agency.queueWaiting > 0 && <span> · {agency.queueWaiting} QUEUED</span>}
        {agency.taskWaiting && <span style={{ color: 'var(--jh-warn, #ffc857)' }}> · AWAITING APPROVAL</span>}
      </div>

      {active.length === 0 && recent.length === 0 && (
        <div className="jh-agency-empty">
          {idleAgent ? 'AGENTS STANDBY' : 'NO ACTIVE WORKERS'}
        </div>
      )}

      {active.length > 0 && (
        <div className="jh-agency-list">
          {active.map((w) => <WorkerRow key={w.id} w={w} />)}
        </div>
      )}

      {recent.length > 0 && (
        <>
          <div className="jh-agency-subhead">RECENT</div>
          <div className="jh-agency-list">
            {recent.map((w) => <WorkerRow key={w.id} w={w} />)}
          </div>
        </>
      )}
    </Panel>
  );
}
