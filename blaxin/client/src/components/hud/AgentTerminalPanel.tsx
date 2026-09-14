import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore, ActivityLine } from '../../utils/store';
import { useVoice } from '../../hooks/useVoice';

// AGENT_TERMINAL — the center panel. The event stream is REAL (store
// activityFeed lines fed by actual WS events: agent-message, agent-state,
// tool-execution, activity, error, task-complete, confirmation). Tabs
// filter the stream by kind; the composer sends real commands through
// the deterministic command router / agent pipeline.

type TabId = 'agent-core' | 'tool-calls' | 'reasoning' | 'output' | 'logs';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'agent-core', label: 'AGENT_CORE' },
  { id: 'tool-calls', label: 'TOOL_CALLS' },
  { id: 'reasoning', label: 'REASONING' },
  { id: 'output', label: 'OUTPUT' },
  { id: 'logs', label: 'LOGS' },
];

const TAB_KINDS: Record<TabId, ActivityLine['kind'][]> = {
  'agent-core': ['state', 'think', 'tool', 'reply', 'user', 'error', 'info'],
  'tool-calls': ['tool'],
  reasoning: ['think'],
  output: ['reply', 'user'],
  logs: ['state', 'error', 'info'],
};

const KIND_CLASS: Record<ActivityLine['kind'], string> = {
  state: 'jh-t-info',
  tool: 'jh-t-ok',
  think: 'jh-t-data',
  reply: 'jh-t-data',
  user: 'jh-t-user',
  error: 'jh-t-err',
  info: 'jh-t-ok',
  recovery: 'jh-t-data',
};

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function TerminalLine({ line }: { line: ActivityLine }) {
  const cls = KIND_CLASS[line.kind];
  if (line.kind === 'user') {
    return (
      <span className="jh-t-line">
        <span className="jh-t-prompt">usr@blaxin:~$ </span>
        <span className="jh-t-cmd">{line.text}</span>
      </span>
    );
  }
  return (
    <span className="jh-t-line">
      <span className="jh-t-info">&gt; [{fmtClock(line.time)}] </span>
      <span className={cls}>{line.text}</span>
    </span>
  );
}

interface AgentTerminalPanelProps {
  sendMessage: (text: string) => void;
  stopAgent: () => void;
  clearHistory: () => void;
}

export function AgentTerminalPanel({ sendMessage, stopAgent, clearHistory }: AgentTerminalPanelProps) {
  const activityFeed = useAppStore((s) => s.activityFeed);
  const agentState = useAppStore((s) => s.agentState);
  const queue = useAppStore((s) => s.queue);
  const messages = useAppStore((s) => s.messages);
  const toolExecutions = useAppStore((s) => s.toolExecutions);
  const [tab, setTab] = useState<TabId>('agent-core');
  const [input, setInput] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLSpanElement>(null);

  const { startListening, stopListening, isListening, isSupported, voiceError } = useVoice();

  const busy = agentState !== 'idle' && agentState !== 'completed' && agentState !== 'error';

  const lines = useMemo(() => {
    const kinds = TAB_KINDS[tab];
    return activityFeed.filter((l) => kinds.includes(l.kind)).slice(-120);
  }, [activityFeed, tab]);

  // Auto-scroll the stream.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Screen-reader live region: announce each new assistant/system line.
  const lastAnnounced = useRef<string | null>(null);
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role === 'user') return;
    if (lastAnnounced.current === last.id) return;
    lastAnnounced.current = last.id;
    const el = liveRef.current;
    if (el) el.textContent = `BLAXIN: ${last.content}`;
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    if (busy && !text.startsWith('/')) return;
    sendMessage(text);
    setInput('');
    if (isListening) stopListening();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const actions = toolExecutions.length;
  const tokens = messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0);
  const queued = queue.filter((t) => t.status === 'queued').length;

  return (
    <div className="jh-panel jh-center">
      <div className="jh-panel-title">
        <span className="jh-panel-icon">◈</span>
        <span className="jh-panel-name">AGENT_TERMINAL</span>
        <div
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: busy ? 'var(--accent-amber)' : 'var(--accent-green)',
            animation: busy ? 'jh-pulse-dot-amber 1s ease-in-out infinite' : 'jh-pulse-dot 2.5s ease-in-out infinite',
          }}
        />
      </div>
      <div className="jh-terminal-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`jh-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="jh-terminal-body" ref={bodyRef}>
        {/* Visually hidden polite live region (screen readers). Second
           [role=status] in the DOM after StatusBar's — the e2e contract
           depends on that order. */}
        <span
          ref={liveRef}
          role="status"
          style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' }}
        />
        {lines.length === 0 && (
          <span className="jh-t-line">
            <span className="jh-t-info">&gt; {TABS.find((t) => t.id === tab)?.label} stream empty — send a command below</span>
          </span>
        )}
        {lines.map((l) => (
          <TerminalLine key={l.id} line={l} />
        ))}
        <span className="jh-t-line">
          <span className="jh-t-prompt">usr@blaxin:~$ </span>
          <span className="jh-t-cursor" />
        </span>
      </div>
      <div className="jh-terminal-strip">
        <div>UPTIME: <span>{fmtClock(Date.now()).slice(0, 5)}</span></div>
        <div>ACTIONS: <span>{actions}</span></div>
        <div>MSG: <span>{messages.length}</span></div>
        <div>TOKENS: <span>{tokens.toLocaleString()}</span></div>
        <div>QUEUE: <span>{queued} tasks</span></div>
        {voiceError && <div style={{ color: 'var(--accent-red)' }}>{voiceError}</div>}
      </div>
      <div className="jh-composer">
        <input
          className="jh-composer-input"
          aria-label="Message BLAXIN"
          placeholder="/help · /status · /missions · or speak to the agent…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!isSupported ? false : false}
        />
        {isSupported && (
          <button
            type="button"
            className="jh-composer-btn"
            aria-label={isListening ? 'Stop listening' : 'Start voice input'}
            onClick={() => (isListening ? stopListening() : startListening())}
            style={isListening ? { borderColor: 'var(--accent-red)', color: 'var(--accent-red)' } : undefined}
          >
            {isListening ? '● REC' : 'MIC'}
          </button>
        )}
        {busy ? (
          <button type="button" className="jh-composer-btn" aria-label="Stop agent" onClick={stopAgent}>
            ■ STOP
          </button>
        ) : (
          <>
            <button type="button" className="jh-composer-btn" onClick={clearHistory} title="Reset conversation (memory kept)">
              CLR
            </button>
            <button type="button" className="jh-composer-btn" aria-label="Send message" onClick={handleSend} disabled={!input.trim()}>
              ▶ SEND
            </button>
          </>
        )}
      </div>
      <div className="jh-composer-hint">
        ENTER send · SHIFT+ENTER newline · commands: /help /status /clear /stop /memory /queue /missions /mission-new /version
      </div>
      <div className="jh-corner-br" />
    </div>
  );
}
