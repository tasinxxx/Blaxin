import React, { useEffect, useState } from 'react';
import { useAppStore } from '../../utils/store';
import { api, MemoryEntry } from '../../services/api';
import { Panel } from './Panel';

// MEMORY_BANK panel — REAL durable memory from the server: entry count
// drives the long-term bar, typed entries render as the recent list.
// The context bar reflects the actual conversation length.

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MemoryBankPanel() {
  const messageCount = useAppStore((s) => s.messages.length);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await api.getMemory();
        if (!cancelled) {
          setEntries(list);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const contextPercent = Math.min(100, Math.round((messageCount / 200) * 100));
  const ltmPercent = Math.min(100, entries.length * 2);
  const recent = entries.slice(0, 5);

  return (
    <Panel name="MEMORY_BANK" className="jh-memory" dot="green">
      <div className="jh-mem-row" aria-label={`Context: ${messageCount} messages`}>
        <div className="jh-mem-label">CONTEXT</div>
        <div className="jh-mem-track" aria-hidden="true">
          <div className="jh-mem-fill" style={{ width: `${contextPercent}%` }} />
        </div>
        <div className="jh-mem-val">{messageCount} msg</div>
      </div>
      <div className="jh-mem-row" aria-label={`Long-term memory: ${entries.length} entries`}>
        <div className="jh-mem-label">LONG TERM</div>
        <div className="jh-mem-track" aria-hidden="true">
          <div className="jh-mem-fill purple" style={{ width: `${ltmPercent}%` }} />
        </div>
        <div className="jh-mem-val">{entries.length}</div>
      </div>
      <div className="jh-mem-row">
        <div className="jh-mem-label">LESSONS</div>
        <div className="jh-mem-track">
          <div className="jh-mem-fill green" style={{ width: `${Math.min(100, entries.filter((e) => e.type === 'action-result').length * 10)}%` }} />
        </div>
        <div className="jh-mem-val">{entries.filter((e) => e.type === 'action-result').length}</div>
      </div>
      <hr className="jh-mem-divider" />
      <div className="jh-mem-hint">RECENT MEMORIES:</div>
      <div className="jh-mem-entries">
        {failed && <div className="jh-mem-entry">&gt; memory store unreachable</div>}
        {!failed && recent.length === 0 && <div className="jh-mem-entry">&gt; no durable memories yet</div>}
        {recent.map((e) => (
          <div key={e.id} className="jh-mem-entry">
            &gt; [{fmtTime(e.createdAt)}] {e.type}: {e.content.slice(0, 60)}
          </div>
        ))}
      </div>
    </Panel>
  );
}
