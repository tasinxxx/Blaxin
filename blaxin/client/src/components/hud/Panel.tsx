import React from 'react';

// Panel base — faithful port of the approved design panel chrome
// (title bar, icon, status dot, corner brackets, scanline overlay).

interface PanelProps {
  name: string;
  icon?: string;
  dot?: 'green' | 'amber' | 'none';
  className?: string;
  children: React.ReactNode;
  bodyStyle?: React.CSSProperties;
  bodyClassName?: string;
}

export function Panel({ name, icon = '◈', dot = 'green', className, children, bodyStyle, bodyClassName }: PanelProps) {
  return (
    // Named region: every HUD panel is a screen-reader landmark carrying
    // its real title (aria-label matches the visible panel name).
    <section className={`jh-panel ${className || ''}`} aria-label={name}>
      <div className="jh-panel-title">
        <span className="jh-panel-icon" aria-hidden="true">{icon}</span>
        <span className="jh-panel-name">{name}</span>
        {dot !== 'none' && <div className={`jh-panel-dot ${dot === 'amber' ? 'amber' : ''}`} aria-hidden="true" />}
      </div>
      <div className={`jh-panel-body ${bodyClassName || ''}`} style={bodyStyle}>
        {children}
      </div>
      <div className="jh-corner-br" aria-hidden="true" />
    </section>
  );
}
