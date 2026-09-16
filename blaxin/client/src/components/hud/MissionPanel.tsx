import React from 'react';
import { useAppStore, MissionStepBulk } from '../../utils/store';
import { Panel } from './Panel';

// MISSIONS panel — REAL multi-specialist missions mirrored from the server
// (mission-progress events). Every row is a real mission with real step
// state; verification badges come from the server's aggregated mission
// verification (mission coordination) — never computed or faked here.
// A blocked step shows BLOCKED; a completed step awaiting evidence shows
// UNVERIFIED. Progress is the real step fraction the server reports.

const VERIFY_LABEL: Record<string, { label: string; cls: string }> = {
  VERIFIED: { label: '✓ VERIFIED', cls: 'jh-mission-v-verified' },
  PARTIAL: { label: '◐ PARTIAL', cls: 'jh-mission-v-partial' },
  UNVERIFIED: { label: '◌ UNVERIFIED', cls: 'jh-mission-v-unverified' },
};

function StepRow({ step, index }: { step: { id: string; description: string; status: string; verification?: string; error?: string; bulk?: MissionStepBulk }; index: number }) {
  const statusLabel =
    step.status === 'completed' && !step.verification ? 'VERIFYING'
      : step.status === 'failed' ? 'FAILED'
        : step.status.toUpperCase();
  const cls =
    step.status === 'completed' ? (step.verification === 'VERIFIED' ? 'done' : 'queued')
      : step.status === 'failed' ? 'failed'
        : step.status === 'running' ? 'running'
          : 'queued';
  return (
    <div className="jh-mission-step" title={`${step.description}${step.error ? ` — ${step.error}` : ''}`}>
      <span className="jh-mission-step-n">{index + 1}</span>
      <span className="jh-mission-step-d">
        {step.description.length > 34 ? `${step.description.slice(0, 34)}…` : step.description}
        {step.bulk ? <BulkSummary bulk={step.bulk} failed={step.status === 'failed'} /> : null}
      </span>
      <span className={`jh-mission-step-s ${cls}`}>{statusLabel}</span>
    </div>
  );
}

/**
 * REAL bulk-result line (server-derived numbers, rendered verbatim — no
 * client-side computation). A failed batch shows the honest failure
 * counts instead of a success-style summary.
 */
function BulkSummary({ bulk, failed }: { bulk: MissionStepBulk; failed: boolean }) {
  if (bulk.duplicateGroups != null && bulk.duplicateGroups > 0) {
    return (
      <span className="jh-mission-bulk" data-testid="mission-bulk">
        {' — '}{bulk.operation ?? 'bulk'}: {bulk.duplicateGroups} dup group(s)
        {bulk.failed ? `, ${bulk.failed} failed` : ''}
      </span>
    );
  }
  if (bulk.affected != null) {
    return (
      <span className={`jh-mission-bulk ${failed ? 'jh-mission-bulk-failed' : ''}`} data-testid="mission-bulk">
        {' — '}{bulk.operation ?? 'bulk'}: {failed ? bulk.succeeded ?? 0 : bulk.affected}/{bulk.affected}
        {failed ? ' (failed)' : ''}
      </span>
  );
  }
  return null;
}

export function MissionPanel() {
  const missions = useAppStore((s) => s.missions);

  // No mission-progress yet → the server never reported (or pre-feature).
  if (missions.length === 0) {
    return (
      <Panel name="MISSIONS" icon="◈">
        <div className="jh-mission-empty">NO ACTIVE MISSIONS</div>
      </Panel>
    );
  }

  // Newest first; bounded like every panel.
  const rows = [...missions].reverse().slice(0, 3);

  return (
    <Panel name="MISSIONS" icon="◈" dot={rows.some((m) => m.status === 'running') ? 'amber' : 'green'}>
      {rows.map((m) => {
        const v = m.verification ? VERIFY_LABEL[m.verification] : null;
        const active = m.status === 'running' || m.status === 'queued';
        return (
          <div key={m.id} className="jh-mission" data-testid="mission-row">
            <div className="jh-mission-head">
              <span className="jh-mission-obj" title={m.objective}>
                {m.objective.length > 40 ? `${m.objective.slice(0, 40)}…` : m.objective}
              </span>
              {v ? <span className={`jh-mission-v ${v.cls}`}>{v.label}</span> : null}
            </div>
            <div className="jh-mission-meta">
              <span>{m.status.toUpperCase()}</span>
              <span> · {Math.round(m.progress * 100)}%</span>
              {active && <span> · ACTIVE</span>}
            </div>
            {m.steps.slice(0, 4).map((s, i) => (
              <StepRow key={s.id} step={s} index={i} />
            ))}
            {m.steps.length > 4 && (
              <div className="jh-mission-more">+{m.steps.length - 4} more step(s)</div>
            )}
          </div>
        );
      })}
    </Panel>
  );
}
