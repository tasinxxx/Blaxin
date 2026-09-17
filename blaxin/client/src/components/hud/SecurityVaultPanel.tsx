import React from 'react';
import { useAppStore } from '../../utils/store';
import { Panel } from './Panel';

// SECURITY_VAULT — the REAL persisted security event log (origin blocks,
// WS upgrade blocks, key save/remove, denied confirmations) mirrored
// from the server via security-events events. Status rows reflect the
// actual /api/status security snapshot.

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `[${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}]`;
}

function severityFor(category: string): '' | 'warn' | 'crit' {
  const c = category.toLowerCase();
  if (c.includes('denied') || c.includes('blocked') || c.includes('forbidden')) return 'crit';
  if (c.includes('warn') || c.includes('fail')) return 'warn';
  return '';
}

export function SecurityVaultPanel() {
  const securityEvents = useAppStore((s) => s.securityEvents);
  const deviceId = useAppStore((s) => s.deviceId);
  const connected = useAppStore((s) => s.connected);

  const rows = securityEvents.slice(0, 6);
  const blocked = securityEvents.filter((e) => severityFor(e.category) === 'crit').length;

  return (
    <Panel name="SECURITY_VAULT" className="jh-security" dot={blocked > 0 ? 'amber' : 'green'}>
      <div className="jh-sec-row" aria-label={`Authentication status: ${connected ? 'verified' : 'offline'}`}>
        <div className="jh-sec-label">AUTH STATUS</div>
        <div className="jh-sec-bar-track" aria-hidden="true">
          <div className="jh-sec-bar-fill" style={{ width: connected ? '100%' : '20%' }} />
        </div>
        <div className="jh-sec-val">{connected ? 'VERIFIED' : 'OFFLINE'}</div>
      </div>
      <div className="jh-sec-row">
        <div className="jh-sec-label">EVENTS</div>
        <div className="jh-sec-body">{securityEvents.length} recorded (persisted ring)</div>
        <div className="jh-sec-val dim">{blocked > 0 ? `${blocked} BLOCKED` : 'CLEAN'}</div>
      </div>
      <div className="jh-sec-row">
        <div className="jh-sec-label">SESSION</div>
        <div className="jh-sec-body">{deviceId || '—'}</div>
        <div className="jh-sec-val" style={{ fontSize: 8 }}>{deviceId ? 'VALID' : 'PENDING'}</div>
      </div>
      <hr className="jh-sec-divider" />
      <div className="jh-mem-hint">SECURITY LOG</div>
      <div className="jh-sec-log">
        {rows.length === 0 && <div className="jh-sec-entry"><span className="sec-msg">no security events yet</span></div>}
        {rows.map((e) => (
          <div key={e.id} className={`jh-sec-entry ${severityFor(e.category)}`}>
            <span className="sec-time">{fmtClock(e.time)}</span>
            <span className="sec-msg" title={`${e.category}: ${e.message}`}>{e.message}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
