// JARVIS HUD panel — the executive layer made visible.
//
// Zero fake state (directive §46–§68): every value rendered here comes
// from the real `jarvis-state` snapshot (phase, directive, lastReport).
// When the server has no data for a field, the field is not shown —
// never invented.

import React from 'react';
import { useAppStore } from '../../utils/store';
import { Panel } from './Panel';

const PHASE_LABEL: Record<string, string> = {
  idle: 'IDLE',
  understanding: 'UNDERSTANDING REQUEST',
  routing: 'ROUTING',
  delegated: 'DELEGATED TO AGENT',
  reporting: 'COMPOSING REPORT',
};

const STATUS_STYLE: Record<string, React.CSSProperties> = {
  SUCCESS: { color: 'var(--jh-ok, #35e08f)' },
  PARTIAL: { color: 'var(--jh-warn, #ffc857)' },
  FAILED: { color: 'var(--jh-danger, #ff5470)' },
  STOPPED: { color: 'var(--jh-dim, #7d8aa5)' },
  NOT_EXECUTED: { color: 'var(--jh-dim, #7d8aa5)' },
};

/** Honest execution route labels (§6) — no invented values. */
const EXEC_MODE_LABEL: Record<string, string> = {
  DETERMINISTIC: 'DETERMINISTIC',
  AI_BRAIN: 'AI BRAIN',
  HYBRID: 'HYBRID (fast path + recovery)',
};

const STEP_GLYPH: Record<string, string> = {
  completed: '✓',
  failed: '✗',
  skipped: '⊘',
  running: '→',
  executing: '→',
  retrying: '↻',
  pending: '○',
};

export function JarvisPanel() {
  const jarvis = useAppStore((s) => s.jarvis);
  const { phase, directive, lastReport } = jarvis;

  const routeLabel = directive
    ? `${directive.complexity.toUpperCase()} · ${directive.reason}`
    : null;

  // Real run metrics: which route actually executed (fall back to `kind`
  // for records that predate executionMode — never invented).
  const metrics = lastReport?.metrics;
  const execMode = metrics
    ? (metrics.executionMode ?? (metrics.kind === 'direct' ? 'DETERMINISTIC' : 'AI_BRAIN'))
    : null;

  return (
    <Panel name="JARVIS" icon="◆">
      {/* Real phase — always present, always the server's value. */}
      <div className="jh-jarvis-phase" data-testid="jarvis-phase">
        <span
          className={`jh-dot ${phase !== 'idle' ? 'jh-dot-live' : ''}`}
          aria-hidden="true"
        />
        {PHASE_LABEL[phase] ?? String(phase).toUpperCase()}
      </div>

      {/* Current directive — only when one actually exists. */}
      {directive && (
        <div className="jh-jarvis-directive" data-testid="jarvis-directive">
          <div className="jh-jarvis-goal" title={directive.goal}>
            {directive.goal}
          </div>
          <div className="jh-jarvis-meta">
            <span>{routeLabel}</span>
            <span> · {directive.source === 'voice' ? 'VOICE' : 'TEXT'}</span>
            {directive.context.missionId && <span> · MISSION</span>}
          </div>
          {directive.successCondition && (
            <div className="jh-jarvis-success">
              EXPECTED: {directive.successCondition}
            </div>
          )}
        </div>
      )}

      {/* Last honest report — only when one exists. */}
      {lastReport && (
        <div className="jh-jarvis-report" data-testid="jarvis-report">
          <div className="jh-jarvis-status" style={STATUS_STYLE[lastReport.status] ?? undefined}>
            {lastReport.status}
          </div>

          {lastReport.evidence.length > 0 && (
            <ul className="jh-jarvis-evidence">
              {lastReport.evidence.slice(-5).map((step, i) => (
                <li key={`${step.id}-${i}`} title={step.error || step.result || step.description}>
                  <span aria-hidden="true">{STEP_GLYPH[step.state] ?? '•'}</span>{' '}
                  {step.description}
                </li>
              ))}
            </ul>
          )}

          {lastReport.blockers.length > 0 && (
            <div className="jh-jarvis-blockers">
              {lastReport.blockers.slice(0, 2).map((b, i) => (
                <div key={i} className="jh-jarvis-blocker">⚠ {b}</div>
              ))}
            </div>
          )}

          {metrics && (
            <div className="jh-jarvis-metrics" data-testid="jarvis-execution-mode">
              {metrics.totalMs}ms · {metrics.modelCalls} model call(s) · {metrics.toolCalls} tool call(s)
              {' · '}{EXEC_MODE_LABEL[execMode ?? ''] ?? execMode}
            </div>
          )}
        </div>
      )}

      {/* Honest empty state: Jarvis has nothing to show yet this session. */}
      {phase === 'idle' && !directive && !lastReport && (
        <div className="jh-jarvis-empty">NO ACTIVE DIRECTIVE</div>
      )}
    </Panel>
  );
}
