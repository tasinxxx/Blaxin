import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { JournalEntry, JournalKind } from '../services/api';
import { useAppStore } from '../utils/store';
import { FiClock, FiRefreshCw, FiTrash2, FiFilter } from 'react-icons/fi';

// MISSION JOURNAL (§20) — the real record of what the system actually did.
//
// Every line comes from the server's bounded journal, which is derived
// exclusively from real runtime events (commands, routing decisions, plans,
// actions, observations, verification evidence, recoveries, memory picks,
// results). Nothing here is generated in the UI — when the journal is
// empty, the page says so.

const STATUS_COLOR: Record<string, string> = {
  INFO: 'var(--text-secondary)',
  RUNNING: 'var(--accent-primary)',
  COMPLETED: 'var(--accent-green)',
  FAILED: 'var(--accent-red)',
  SKIPPED: 'var(--text-muted)',
  BLOCKED: 'var(--accent-yellow)',
  RECOVERING: 'var(--accent-yellow)',
  RECOVERED: 'var(--accent-green)',
  UNVERIFIED: 'var(--accent-yellow)',
};

const KIND_COLOR: Record<string, string> = {
  COMMAND: 'var(--accent-primary)',
  ROUTER: 'var(--accent-secondary)',
  PLAN: 'var(--accent-secondary)',
  ACTION: 'var(--text-primary)',
  OBSERVATION: 'var(--text-secondary)',
  VERIFICATION: 'var(--accent-green)',
  RECOVERY: 'var(--accent-yellow)',
  MEMORY: 'var(--accent-secondary)',
  RESULT: 'var(--text-primary)',
};

const ALL_KINDS: JournalKind[] = [
  'COMMAND', 'ROUTER', 'PLAN', 'ACTION', 'OBSERVATION',
  'VERIFICATION', 'RECOVERY', 'MEMORY', 'RESULT',
];

function timeString(at: number): string {
  return new Date(at).toLocaleTimeString();
}

function Field({ label, value }: { label: string; value?: React.ReactNode }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div style={{ display: 'flex', gap: 6, fontSize: 11, lineHeight: 1.5 }}>
      <span style={{ color: 'var(--text-muted)', minWidth: 68 }}>{label}</span>
      <span style={{ color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

export function JournalPage() {
  const journal = useAppStore((s) => s.journal);
  const setJournal = useAppStore((s) => s.setJournal);
  const [filter, setFilter] = useState<JournalKind | 'ALL'>('ALL');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.getJournal(200);
      setJournal(data.entries);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load the mission journal');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Live updates arrive over the WS 'journal-updated' event; no polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clear = async () => {
    try {
      await api.clearJournal();
      setJournal([]);
    } catch (err: any) {
      setError(err?.message || 'Could not clear the journal');
    }
  };

  const entries: JournalEntry[] = filter === 'ALL'
    ? journal
    : journal.filter((e) => e.kind === filter);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Mission Journal</h1>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          real runtime history — {journal.length} line(s)
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            onClick={load}
            disabled={loading}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
              borderRadius: 'var(--radius-md)', background: 'var(--bg-hover)',
              color: 'var(--text-secondary)', fontSize: 12,
            }}
          >
            <FiRefreshCw size={12} /> {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button
            onClick={clear}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
              borderRadius: 'var(--radius-md)', background: 'var(--bg-hover)',
              color: 'var(--accent-red)', fontSize: 12,
            }}
          >
            <FiTrash2 size={12} /> Clear
          </button>
        </div>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>
        Every line is derived from a real event: command and routing, the plan, each action (with its
        real runtime step id), the observation, verification evidence, bounded recovery, memory
        selections and the final result. Nothing is invented for display.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        <FiFilter size={12} color="var(--text-muted)" />
        {(['ALL', ...ALL_KINDS] as const).map((k) => (
          <button
            key={k}
            onClick={() => setFilter(k as JournalKind | 'ALL')}
            aria-pressed={filter === k}
            style={{
              padding: '3px 9px',
              borderRadius: 'var(--radius-sm)',
              fontSize: 10,
              letterSpacing: 0.5,
              background: filter === k ? 'var(--bg-active)' : 'var(--bg-hover)',
              color: filter === k ? (KIND_COLOR[k] || 'var(--accent-primary)') : 'var(--text-muted)',
            }}
          >
            {k}
          </button>
        ))}
      </div>

      {error && (
        <div style={{
          padding: 12, marginBottom: 16, borderRadius: 'var(--radius-md)',
          background: 'rgba(255, 51, 85, 0.1)', color: 'var(--accent-red)', fontSize: 12,
        }}>
          {error}
        </div>
      )}

      {entries.length === 0 && !loading && (
        <div style={{
          padding: 24, borderRadius: 'var(--radius-md)', border: '1px dashed var(--border-subtle)',
          color: 'var(--text-muted)', fontSize: 12, textAlign: 'center',
        }}>
          NO JOURNAL ENTRIES YET — run a command and the real history appears here.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {entries.map((e) => (
          <div
            key={e.id}
            data-testid="journal-entry"
            style={{
              padding: 12,
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-subtle)',
              borderLeft: `3px solid ${KIND_COLOR[e.kind] || 'var(--border-subtle)'}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, letterSpacing: 1, fontWeight: 700, color: KIND_COLOR[e.kind] }}>
                {e.kind}
              </span>
              <span style={{ fontSize: 10, letterSpacing: 1, color: STATUS_COLOR[e.status] || 'var(--text-muted)' }}>
                {e.status}
              </span>
              {e.specialist && (
                <span style={{ fontSize: 10, color: 'var(--accent-secondary)' }}>[{e.specialist}]</span>
              )}
              {e.retries !== undefined && e.retries > 0 && (
                <span style={{ fontSize: 10, color: 'var(--accent-yellow)' }}>retries: {e.retries}</span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <FiClock size={10} /> {timeString(e.at)}
              </span>
            </div>

            <Field label="objective" value={e.objective} />
            <Field label="intent" value={e.intent} />
            <Field label="action" value={e.action} />
            <Field label="observed" value={e.observation} />
            <Field
              label="verified"
              value={e.verification
                ? `${e.verification.status} via ${e.verification.method}${e.verification.detail ? ` — ${e.verification.detail}` : ''}`
                : undefined}
            />
            <Field label="failure" value={e.failure} />
            <Field label="recovery" value={e.recovery} />
            <Field label="detail" value={e.detail} />
            <Field
              label="ids"
              value={[
                e.missionId ? `mission:${e.missionId}` : null,
                e.taskId ? `task:${e.taskId}` : null,
                e.actionId ? `action:${e.actionId}` : null,
              ].filter(Boolean).join(' · ') || undefined}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
