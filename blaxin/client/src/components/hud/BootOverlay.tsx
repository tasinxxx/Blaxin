import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../utils/store';

// Jarvis HUD boot sequence — faithful port of the approved design
// (design/blaxin_os.html). Progress is driven by REAL state: the overlay
// leaves only when the WebSocket connect has completed and the first
// server snapshots arrived (see useWebSocket bootComplete wiring). The
// animation timeline below is presentation only.

const BOOT_LINES = [
  { text: '> NEURAL_ENGINE .............', ok: '[OK]' },
  { text: '> MEMORY_PROTOCOL ...........', ok: '[OK]' },
  { text: '> TASK_SCHEDULER ............', ok: '[OK]' },
  { text: '> NETWORK_BRIDGE ............', ok: '[OK]' },
  { text: '> SECURITY_LAYER ............', ok: '[OK]' },
  { text: '> AGENT_CORE ................', ok: '[ONLINE]' },
];

export function BootOverlay() {
  const bootComplete = useAppStore((s) => s.bootComplete);
  const connected = useAppStore((s) => s.connected);
  const [visibleLines, setVisibleLines] = useState(0);
  const [phase, setPhase] = useState<'sweep' | 'arc' | 'ready' | 'leaving' | 'gone'>('sweep');

  // Animation timeline (presentation only; dismissal is state-driven):
  // boot lines appear one by one, then the arc/ready milestones flip.
  useEffect(() => {
    if (phase === 'leaving' || phase === 'gone') return;
    const iv = setInterval(() => {
      setVisibleLines((n) => (n < BOOT_LINES.length ? n + 1 : n));
    }, 180);
    const t1 = setTimeout(() => setPhase((p) => (p === 'sweep' ? 'arc' : p)), 1400);
    const t2 = setTimeout(() => setPhase((p) => (p === 'arc' ? 'ready' : p)), 2700);
    return () => {
      clearInterval(iv);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [phase]);

  // Real state gate: connected (server reached) + bootComplete (first
  // snapshots landed) → play the exit transition, then unmount. The
  // leaving→gone timer lives in its own effect keyed ONLY on the phase,
  // so nothing cancels it mid-flight.
  useEffect(() => {
    if (phase === 'leaving') {
      const t = setTimeout(() => setPhase('gone'), 650);
      return () => clearTimeout(t);
    }
  }, [phase]);

  useEffect(() => {
    if (bootComplete && connected) {
      setPhase((p) => (p === 'leaving' || p === 'gone' ? p : 'leaving'));
    }
  }, [bootComplete, connected]);

  if (phase === 'gone') return null;

  return (
    // role=progressbar (NOT role=status/alert): the boot overlay is
    // transient chrome — it must never enter the two e2e-pinned
    // [role=status] regions or steal screen-reader focus from the app.
    <div
      className={`jh-boot ${phase === 'leaving' ? 'leaving' : 'sweeping'}`}
      data-testid="boot-overlay"
      role="progressbar"
      aria-label="BLAXIN boot sequence"
    >
      <div className="jh-boot-scanline" aria-hidden="true" />
      <div className="jh-boot-title">INITIALIZING BLAXIN CORE...</div>
      <div className="jh-boot-lines">
        {BOOT_LINES.slice(0, visibleLines).map((line, i) => (
          <div key={i} className="jh-boot-line visible">
            {line.text} <span className="ok">{line.ok}</span>
          </div>
        ))}
      </div>
      <div className={`jh-boot-arc ${phase === 'arc' || phase === 'ready' ? 'visible' : ''}`}>
        <div className="jh-arc-ring r1" />
        <div className="jh-arc-ring r2" />
        <div className="jh-arc-ring r3" />
        <div className="jh-arc-core" />
      </div>
      <div className={`jh-boot-ready ${phase === 'ready' ? 'visible' : ''}`}>BLAXIN ONLINE</div>
      {!connected && phase !== 'leaving' && (
        <div className="jh-boot-line visible" style={{ marginTop: 4 }}>
          &gt; CONNECTING_TO_BACKEND ...<span className="ok"> WAITING</span>
        </div>
      )}
    </div>
  );
}
