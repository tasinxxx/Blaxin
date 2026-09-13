import React from 'react';
import { useAppStore } from '../utils/store';
import {
  FiMessageSquare, FiSettings, FiCpu, FiPower,
  FiTerminal, FiMonitor, FiShield, FiInfo,
  FiActivity, FiHeart, FiBarChart2, FiLink, FiDatabase, FiList,
} from 'react-icons/fi';

const navItems = [
  { id: 'chat', icon: FiMessageSquare, label: 'Chat' },
  { id: 'terminal', icon: FiTerminal, label: 'Terminal' },
  { id: 'metrics', icon: FiBarChart2, label: 'Metrics' },
  { id: 'journal', icon: FiList, label: 'Journal' },
  { id: 'diagnostics', icon: FiHeart, label: 'Diagnostics' },
  { id: 'system', icon: FiMonitor, label: 'System' },
  { id: 'memory', icon: FiDatabase, label: 'Memory' },
  { id: 'models', icon: FiCpu, label: 'Models' },
  { id: 'brain', icon: FiLink, label: 'Brain' },
];

export function Sidebar() {
  const { currentPage, setCurrentPage, setSettingsOpen, connected, agentState, activeModel } = useAppStore();

  return (
    <aside style={{
      width: 220,
      background: 'var(--bg-secondary)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
      zIndex: 2,
    }}>
      {/* Logo */}
      <div style={{
        padding: '20px 16px',
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <div style={{
            width: 36,
            height: 36,
            flexShrink: 0,
            borderRadius: 'var(--radius-md)',
            background: '#000',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 'var(--glow-primary)',
            overflow: 'hidden',
          }}>
            <img
              src="/blaxin-mark.png"
              alt="BLAXIN logo"
              width={26}
              height={26}
              draggable={false}
            />
          </div>
          <div>
            <div style={{
              fontSize: 18,
              fontWeight: 800,
              fontFamily: 'var(--font-mono)',
              letterSpacing: 2,
              background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}>
              BLAXIN
            </div>
            <div style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              letterSpacing: 1,
              textTransform: 'uppercase',
            }}>
              AI Desktop Agent
            </div>
          </div>
        </div>
      </div>

      {/* Status */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-subtle)',
        fontSize: 11,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 6,
        }}>
          <div style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: connected ? 'var(--accent-green)' : 'var(--accent-red)',
            boxShadow: connected 
              ? '0 0 8px var(--accent-green)' 
              : '0 0 8px var(--accent-red)',
          }} />
          <span style={{ color: 'var(--text-secondary)' }}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <FiCpu size={10} color="var(--accent-primary)" />
          <span style={{ 
            color: 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {activeModel || 'No model selected'}
          </span>
        </div>

        {agentState !== 'idle' && (
          <div style={{
            marginTop: 8,
            padding: '4px 8px',
            borderRadius: 'var(--radius-sm)',
            background: agentState === 'error' 
              ? 'rgba(255, 51, 85, 0.15)' 
              : 'rgba(0, 240, 255, 0.1)',
            color: agentState === 'error' ? 'var(--accent-red)' : 'var(--accent-primary)',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}>
            <FiActivity size={10} />
            {agentState}
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, padding: '8px 0' }}>
        {navItems.map(item => (
          <button
            key={item.id}
            onClick={() => setCurrentPage(item.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '10px 16px',
              background: currentPage === item.id ? 'var(--bg-active)' : 'transparent',
              color: currentPage === item.id ? 'var(--accent-primary)' : 'var(--text-secondary)',
              borderLeft: currentPage === item.id ? '2px solid var(--accent-primary)' : '2px solid transparent',
              fontSize: 13,
              fontWeight: currentPage === item.id ? 600 : 400,
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => {
              if (currentPage !== item.id) {
                e.currentTarget.style.background = 'var(--bg-hover)';
              }
            }}
            onMouseLeave={e => {
              if (currentPage !== item.id) {
                e.currentTarget.style.background = 'transparent';
              }
            }}
          >
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </nav>

      {/* Bottom */}
      <div style={{
        padding: '12px 16px',
        borderTop: '1px solid var(--border-subtle)',
      }}>
        <button
          onClick={() => setSettingsOpen(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            padding: '10px 12px',
            background: 'transparent',
            color: 'var(--text-secondary)',
            borderRadius: 'var(--radius-md)',
            fontSize: 13,
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <FiSettings size={16} />
          Settings
        </button>
        
        <div style={{
          marginTop: 8,
          padding: '6px 8px',
          textAlign: 'center',
          fontSize: 9,
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          letterSpacing: 1,
        }}>
          BLAXIN v1.4.0
        </div>
      </div>
    </aside>
  );
}
