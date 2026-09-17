import React, { useEffect, useRef, useState } from 'react';
import { api, NetworkTelemetry } from '../../services/api';
import { useAppStore } from '../../utils/store';
import { Panel } from './Panel';

// NETWORK_HUB — REAL network telemetry: the graph and stats come from
// the server's /api/system/network (actual /proc/net.dev RX/TX deltas).
// The connections list shows the real link states (backend, Brain).

const W = 200;
const H = 70;
const MAX_BYTES = 80_000; // ~80 KB/s scale for the graph

function fmtRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1_000) return `${(bytesPerSec / 1_000).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

function fmtBytes(total: number): string {
  if (total >= 1_000_000_000) return `${(total / 1_000_000_000).toFixed(2)} GB`;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(total / 1000)} KB`;
}

function toPoints(arr: number[]): string {
  return arr.map((v, i) => `${(i / (arr.length - 1)) * W},${H - Math.min(1, v / MAX_BYTES) * (H - 4) - 2}`).join(' ');
}

function toArea(arr: number[]): string {
  const pts = arr.map((v, i) => `${(i / (arr.length - 1)) * W},${H - Math.min(1, v / MAX_BYTES) * (H - 4) - 2}`);
  return `0,${H} ${pts.join(' ')} ${W},${H}`;
}

export function NetworkHubPanel() {
  const connected = useAppStore((s) => s.connected);
  const brainStatus = useAppStore((s) => s.brainStatus);
  const deviceId = useAppStore((s) => s.deviceId);
  const [telemetry, setTelemetry] = useState<NetworkTelemetry | null>(null);
  const rxData = useRef<number[]>(Array(30).fill(0));
  const txData = useRef<number[]>(Array(30).fill(0));
  const [, forceRender] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const t = await api.getNetworkTelemetry();
        if (cancelled) return;
        setTelemetry(t);
        rxData.current = [...rxData.current.slice(1), t.rxBytesPerSec];
        txData.current = [...txData.current.slice(1), t.txBytesPerSec];
        forceRender((n) => n + 1);
      } catch {
        /* telemetry endpoint unreachable — leave the last real values */
      }
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const rx = telemetry?.rxBytesPerSec ?? 0;
  const tx = telemetry?.txBytesPerSec ?? 0;

  const conns: Array<{ name: string; proto: string; active: boolean }> = [
    { name: `blaxin-backend (ws)${deviceId ? ` · ${deviceId}` : ''}`, proto: 'WS', active: connected },
    { name: brainStatus?.mode === 'external' ? `brain link${brainStatus.brain?.brainName ? ` · ${brainStatus.brain.brainName}` : ''}` : 'local mode', proto: brainStatus?.mode === 'external' ? (brainStatus.brain?.secure ? 'WSS' : 'WS') : '—', active: brainStatus?.mode === 'external' ? (brainStatus.brain?.state === 'connected') : true },
    ...((telemetry?.interfaces ?? [])
      .filter((i) => i.name !== 'lo')
      .slice(0, 4)
      .map((i) => ({ name: i.name, proto: 'NIC', active: i.rxBytes > 0 || i.txBytes > 0 }))),
  ];

  return (
    <Panel name="NETWORK_HUB" className="jh-network" dot={connected ? 'green' : 'amber'}>
      <svg className="jh-net-graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="jh-rxGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00d4ff" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#00d4ff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="jh-txGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00ff9f" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#00ff9f" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" y1="17" x2={W} y2="17" stroke="rgba(0,212,255,0.1)" strokeWidth="0.5" />
        <line x1="0" y1="35" x2={W} y2="35" stroke="rgba(0,212,255,0.1)" strokeWidth="0.5" />
        <line x1="0" y1="52" x2={W} y2="52" stroke="rgba(0,212,255,0.1)" strokeWidth="0.5" />
        <polyline fill="url(#jh-rxGrad)" stroke="none" points={toArea(rxData.current)} />
        <polyline fill="none" stroke="#00d4ff" strokeWidth="1.2" style={{ filter: 'drop-shadow(0 0 3px #00d4ff)' }} points={toPoints(rxData.current)} />
        <polyline fill="url(#jh-txGrad)" stroke="none" points={toArea(txData.current)} />
        <polyline fill="none" stroke="#00ff9f" strokeWidth="1" style={{ filter: 'drop-shadow(0 0 3px #00ff9f)' }} points={toPoints(txData.current)} />
      </svg>
      <div className="jh-net-stats" aria-label={`Network throughput: receive ${fmtRate(rx)}, transmit ${fmtRate(tx)}`}>
        <div className="jh-net-stat">RX: <span className="rx">{fmtRate(rx)}</span></div>
        <div className="jh-net-stat">TX: <span className="tx">{fmtRate(tx)}</span></div>
        <div className="jh-net-stat">TOTAL: <span>{fmtBytes(telemetry?.rxTotalBytes ?? 0)} in / {fmtBytes(telemetry?.txTotalBytes ?? 0)} out</span></div>
      </div>
      <hr className="jh-mem-divider" />
      <div className="jh-mem-hint">
        CONNECTIONS <span style={{ color: 'var(--accent-green)' }}>[{conns.filter((c) => c.active).length} ACTIVE]</span>
      </div>
      <div className="jh-conn-list">
        {conns.map((c, i) => (
          <div key={i} className="jh-conn-row" aria-label={`${c.name}: ${c.active ? 'active' : 'inactive'}`}>
            <div className="jh-conn-dot" style={c.active ? undefined : { background: 'var(--accent-amber)' }} />
            <div className="jh-conn-host">{c.name}</div>
            <div className="jh-conn-proto">{c.proto}</div>
            {c.active && <div className="jh-conn-flow" aria-hidden="true" />}
          </div>
        ))}
      </div>
    </Panel>
  );
}
