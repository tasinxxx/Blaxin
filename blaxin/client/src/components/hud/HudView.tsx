import React, { useEffect, useState } from 'react';
import { useAppStore } from '../../utils/store';
import { BootOverlay } from './BootOverlay';
import { ParticleCanvas } from './ParticleCanvas';
import { HudHeader } from './HudHeader';
import { NeuralStatusPanel } from './NeuralStatusPanel';
import { JarvisPanel } from './JarvisPanel';
import { AgencyPanel } from './AgencyPanel';
import { MemoryBankPanel } from './MemoryBankPanel';
import { TaskQueuePanel } from './TaskQueuePanel';
import { MissionPanel } from './MissionPanel';
import { AgentTerminalPanel } from './AgentTerminalPanel';
import { NetworkHubPanel } from './NetworkHubPanel';
import { SecurityVaultPanel } from './SecurityVaultPanel';
import { ActivityTicker } from './ActivityTicker';
import { ActiveTaskPanel } from '../ActiveTaskPanel';
import { StatusBar } from '../StatusBar';

// HUD view — the approved blaxin_os.html layout, fully functional:
//   header / [left rail: neural, memory, tasks] / [center: agent
//   terminal] / [right rail: network, security] / bottom ticker.
//
// E2E/UX contract preserved:
// - StatusBar stays mounted above the HUD (first [role=status] live
//   region announcing real agent-state transitions).
// - ActiveTaskPanel stays mounted (renders inside the left column's
//   slot when a task is active) with data-testid="active-task-step".
// - AgentTerminalPanel carries the second [role=status] + composer
//   with aria-label "Message BLAXIN" and "Send message".

interface HudViewProps {
  sendMessage: (text: string) => void;
  stopAgent: () => void;
  clearHistory: () => void;
  queueAction: (id: string, action: 'cancel' | 'pause' | 'resume') => void;
}

export function HudView({ sendMessage, stopAgent, clearHistory, queueAction }: HudViewProps) {
  const currentTask = useAppStore((s) => s.currentTask);
  // Re-render once so the mission bar picks up the first snapshot.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => tick((n) => n + 1), 600);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="jh">
      <ParticleCanvas />
      <div className="jh-corner tl" /><div className="jh-corner tr" />
      <div className="jh-corner bl" /><div className="jh-corner br" />

      <HudHeader />

      <div className="jh-panels">
        {/* LEFT COLUMN */}
        <div className="jh-col">
          <NeuralStatusPanel />
          <JarvisPanel />
          <AgencyPanel />
          <MemoryBankPanel />
          <MissionPanel />
          <TaskQueuePanel onQueueAction={queueAction} />
        </div>

        {/* CENTER — agent terminal + active task steps (real task-progress) */}
        <div className="jh-col">
          <div style={{ display: currentTask ? 'block' : 'none' }}>
            <ActiveTaskPanel />
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <AgentTerminalPanel sendMessage={sendMessage} stopAgent={stopAgent} clearHistory={clearHistory} />
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div className="jh-col">
          <NetworkHubPanel />
          <SecurityVaultPanel />
        </div>
      </div>

      <ActivityTicker />

      {/* Boot overlay sits on top until the real backend is connected. */}
      <BootOverlay />
    </div>
  );
}
