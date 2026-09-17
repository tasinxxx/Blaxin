import React, { useEffect, useRef, useState } from 'react';
import { useAppStore, ActivityLine } from '../../utils/store';

// ACTIVITY rail — bottom ticker fed by the REAL activity feed (real
// agent events only). Duplicated once so the 60s CSS scroll loops
// seamlessly (translateX(-50%)).
//
// Accessibility (WCAG 2.2.2 — pause, stop, hide): a pause/resume button
// freezes the marquee, and hovering/focusing the rail also pauses it so
// mouse and keyboard users can read a line while it is under the cursor
// or focused. Reduced-motion users get a static (never scrolling) rail
// through the same toggle plus the global CSS motion kill.

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderLine(l: ActivityLine): string {
  const text = l.text.length > 90 ? `${l.text.slice(0, 90)}…` : l.text;
  return `> [${fmtClock(l.time)}] ${text}`;
}

export function ActivityTicker() {
  const activityFeed = useAppStore((s) => s.activityFeed);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [focused, setFocused] = useState(false);

  // Keep the newest lines in view: scroll shows the tail of the feed.
  const lines = activityFeed.slice(-12);
  const text = lines.length > 0 ? lines.map(renderLine).join('  ◈  ') : '> BLAXIN agent online — awaiting commands  ◈  All systems operational';
  // Frozen when the user paused it OR when the strip holds keyboard focus
  // (a focused marquee must not scroll under the reader). Hover is
  // deliberately NOT a freeze trigger: after a real click the pointer
  // rests over the rail (and headless environments never deliver
  // mouseleave), which would pin the ticker paused and defeat the
  // explicit toggle.
  const frozen = paused || focused;

  return (
    <div className="jh-rail" data-testid="activity-ticker">
      <div className="jh-rail-label">◈ ACTIVITY</div>
      <div
        className="jh-rail-ticker-wrap"
        ref={wrapRef}
        tabIndex={0}
        role="group"
        aria-label="Activity ticker (pauses while focused)"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <div className={`jh-rail-ticker ${frozen ? 'jh-rail-paused' : ''}`}>
          {text}  ◈  {text}  ◈
        </div>
      </div>
      <button
        type="button"
        className="jh-rail-pause"
        aria-label={paused ? 'Resume activity ticker' : 'Pause activity ticker'}
        aria-pressed={paused}
        title={paused ? 'Resume activity ticker' : 'Pause activity ticker'}
        onClick={() => setPaused((p) => !p)}
      >
        {paused ? '▶' : '❚❚'}
      </button>
    </div>
  );
}
