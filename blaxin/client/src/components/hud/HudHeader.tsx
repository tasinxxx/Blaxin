import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../utils/store';

// HUD header — faithful port of the approved design header bar.
// Brand, version, wave, live status pill, real session timer and the
// real persisted device id. The glitch is a periodic cosmetic accent.

function formatHMS(seconds: number): string {
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

const STATE_LABELS: Record<string, string> = {
  idle: 'IDLE',
  thinking: 'THINKING',
  planning: 'PLANNING',
  executing: 'EXECUTING',
  observing: 'OBSERVING',
  waiting: 'WAITING',
  completed: 'COMPLETED',
  error: 'ERROR',
  'requires-confirmation': 'AWAITING APPROVAL',
};

export function HudHeader() {
  const connected = useAppStore((s) => s.connected);
  const agentState = useAppStore((s) => s.agentState);
  const deviceId = useAppStore((s) => s.deviceId);
  const queue = useAppStore((s) => s.queue);
  const activeModel = useAppStore((s) => s.activeModel);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [glitch, setGlitch] = useState(false);

  // Real session timer — starts when the HUD header mounts.
  useEffect(() => {
    const t = setInterval(() => setSessionSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Periodic cosmetic glitch on the brand (design element).
  useEffect(() => {
    let alive = true;
    const schedule = () => {
      const t = setTimeout(() => {
        if (!alive) return;
        setGlitch(true);
        setTimeout(() => alive && setGlitch(false), 220);
        schedule();
      }, 11000 + Math.random() * 5000);
      return t;
    };
    const t = schedule();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);

  const waveBars = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => {
        const h1 = Math.floor(Math.random() * 6 + 4);
        const h2 = Math.floor(Math.random() * 22 + 8);
        const dur = (0.7 + Math.random() * 0.8).toFixed(2);
        return { h1, h2, dur, delay: (i * 0.1).toFixed(1) };
      }),
    [],
  );

  const queued = queue.filter((t) => t.status === 'queued').length;
  const running = queue.some((t) => t.status === 'running');
  const audioEnabled = useAppStore((s) => s.audioEnabled);
  const audioVolume = useAppStore((s) => s.audioVolume);
  const setAudioEnabled = useAppStore((s) => s.setAudioEnabled);
  const setAudioVolume = useAppStore((s) => s.setAudioVolume);

  return (
    <header className="jh-header">
      <div className={`jh-brand ${glitch ? 'glitch' : ''}`}>BLAXIN</div>
      <div className="jh-header-divider">//</div>
      <div className="jh-header-sub">AI_AGENT_OS</div>
      {/* Decorative wave: hidden from AT; the bars are pure animation. */}
      <div className="jh-wave" aria-hidden="true">
        {waveBars.map((b, i) => (
          <div
            key={i}
            className="jh-wave-bar"
            style={{
              ['--h1' as string]: `${b.h1}px`,
              ['--h2' as string]: `${b.h2}px`,
              ['--d' as string]: `${b.dur}s`,
              height: `${b.h1}px`,
              animationDelay: `${b.delay}s`,
            }}
          />
        ))}
      </div>
      <div className="jh-header-right">
        <div className={`jh-status-pill ${connected ? '' : 'offline'}`}>
          <div className="jh-status-dot" />
          {connected ? 'ONLINE' : 'OFFLINE'}
        </div>
        <div className="jh-header-stat" aria-label={`Neural state: ${STATE_LABELS[agentState] || String(agentState).toUpperCase()}`}>
          NEURAL: <span>{STATE_LABELS[agentState] || String(agentState).toUpperCase()}</span>
        </div>
        <div className="jh-header-stat" aria-label={`Session duration ${formatHMS(sessionSeconds)}`}>
          SESSION: <span className="jh-session-timer">{formatHMS(sessionSeconds)}</span>
        </div>
        <div className="jh-header-stat" aria-label={`Device id ${deviceId || 'pending'}`}>
          ID: <span>{deviceId || '—'}</span>
        </div>
        <div className="jh-header-stat" aria-label={`Queue: ${queued} waiting${running ? ', one running' : ''}`}>
          QUEUE: <span>{queued}{running ? ' · RUN' : ''}</span>
        </div>
        {activeModel && (
          <div className="jh-header-stat">
            MODEL: <span>{activeModel}</span>
          </div>
        )}
        {/* JARVIS audio identity — mute + volume (persisted preferences). */}
        <button
          type="button"
          className="jh-composer-btn"
          aria-label={audioEnabled ? 'Mute JARVIS sounds' : 'Unmute JARVIS sounds'}
          aria-pressed={audioEnabled}
          title={audioEnabled ? 'Mute JARVIS sounds' : 'Unmute JARVIS sounds'}
          onClick={() => setAudioEnabled(!audioEnabled)}
          style={{ padding: '0 8px', height: 22 }}
        >
          {audioEnabled ? '🔊' : '🔇'}
        </button>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(audioVolume * 100)}
          onChange={(e) => setAudioVolume(Number(e.target.value) / 100)}
          aria-label="JARVIS sound volume"
          title="JARVIS sound volume"
          style={{ width: 56, accentColor: 'var(--border-primary)', height: 'auto' }}
        />
      </div>
    </header>
  );
}
