import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../utils/store';
import { getWsUrl } from '../services/endpoints';
import type { BrainStatusResponse } from '../services/api';
import type { ActiveTask, ActivityLine } from '../utils/store';

const HEARTBEAT_INTERVAL_MS = 25000;
const RECONNECT_DELAY_MS = 3000;

/** Monotonic id for activity-feed lines (real events only). */
let activitySeq = 0;
function nextActivityId(): string {
  activitySeq += 1;
  return `act_${Date.now().toString(36)}_${activitySeq}`;
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const {
    setConnected,
    setAgentState,
    setAgentDescription,
    addMessage,
    addToolExecution,
    setCurrentTask,
    setProviders,
    setActiveProvider,
    setActiveModel,
    setModels,
    setLastError,
    setPendingConfirmation,
  } = useAppStore();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(getWsUrl('/ws'));
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        console.log('[BLAXIN] WebSocket connected');

        // Heartbeat keeps dead connections from lingering silently
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        heartbeatRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, HEARTBEAT_INTERVAL_MS);
      };

      ws.onclose = () => {
        setConnected(false);
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        console.log('[BLAXIN] WebSocket disconnected, reconnecting...');
        reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      ws.onerror = (error) => {
        console.error('[BLAXIN] WebSocket error:', error);
      };

      ws.onmessage = (event) => {
        try {
          const { event: eventType, data } = JSON.parse(event.data);

          switch (eventType) {
            case 'connected': {
              if (data.state) {
                setAgentState(data.state);
                setAgentDescription(data.description || null);
              }
              if (data.activeProvider) setActiveProvider(data.activeProvider);
              if (data.activeModel) setActiveModel(data.activeModel);
              // A fresh server session means the previous session's error
              // (if any) is stale — drop it so it cannot resurface later.
              setLastError(null);
              // The server includes the authoritative Brain snapshot
              // (mode + bodyId + link status) in the connected payload for
              // BOTH modes, so the badge never shows stale/contradictory
              // state across a reconnect.
              if (data.mode) {
                useAppStore.getState().setBrainStatus({
                  mode: data.mode === 'external' ? 'external' : 'embedded',
                  bodyId: data.bodyId ?? null,
                  brain: data.brain ?? null,
                });
              }
              // Jarvis HUD identity: the real persisted device id.
              if (typeof data.deviceId === 'string') {
                useAppStore.getState().setDeviceId(data.deviceId);
              }
              // A fresh server session has no active task.
              setCurrentTask(null);
              break;
            }

            case 'brain-status': {
              // Push update for the Brain link state (state changes are
              // authoritative server-side; the server may also include
              // phase/brainId/lastError). Merge into the current snapshot.
              // Only external mode emits these, so a push means EXTERNAL.
              const cur = useAppStore.getState().brainStatus;
              const merged: BrainStatusResponse = {
                mode: 'external',
                bodyId: cur?.bodyId ?? null,
                brain: { ...(cur?.brain ?? {}), ...(data ?? {}) },
                capabilities: cur?.capabilities,
                task: cur?.task ?? null,
              };
              useAppStore.getState().setBrainStatus(merged);
              break;
            }

            case 'agent-message':
              addMessage({
                id: data.id,
                role: data.role === 'assistant' ? 'assistant' : data.role === 'user' ? 'user' : 'system',
                content: data.content,
                timestamp: data.timestamp,
              });
              // Real conversation traffic feeds the HUD terminal + ticker.
              useAppStore.getState().addActivityLine({
                id: nextActivityId(),
                time: data.timestamp || Date.now(),
                kind: data.role === 'user' ? 'user' : 'reply',
                text: String(data.content || ''),
              });
              break;

            case 'agent-state':
              setAgentState(data.state);
              setAgentDescription(data.description || null);
              // Real agent state transitions drive the HUD neural core.
              useAppStore.getState().addActivityLine({
                id: nextActivityId(),
                time: Date.now(),
                kind: 'state',
                text: `${String(data.state).toUpperCase()}${data.description ? ` — ${data.description}` : ''}`,
              });
              // When the agent goes idle/completed/error, drop stale confirmations
              if (['idle', 'completed', 'error'].includes(data.state)) {
                setPendingConfirmation(null);
              }
              break;

            case 'tool-execution':
              addToolExecution({
                toolName: data.toolName,
                args: data.args,
                state: data.state,
                result: data.result,
              });
              useAppStore.getState().addActivityLine({
                id: nextActivityId(),
                time: Date.now(),
                kind: 'tool',
                text: `${data.toolName} ${data.state}${data.result ? ` :: ${String(data.result).slice(0, 160)}` : ''}`,
              });
              break;

            case 'activity':
              // Activity updates from the agent (thinking, executing, etc.)
              if (data && data.type && data.content) {
                addToolExecution({
                  toolName: data.type,
                  args: {},
                  state: 'executing',
                  result: data.content.slice(0, 200),
                });
                useAppStore.getState().addActivityLine({
                  id: nextActivityId(),
                  time: Date.now(),
                  kind: 'think',
                  text: `${data.type}: ${data.content}`,
                });
              }
              break;

            case 'task-progress':
              // Real agent task state (embedded mode): the current task with
              // its step list, updated on every settled tool call.
              setCurrentTask(data as ActiveTask);
              break;

            case 'task-complete': {
              // Real task settlement — log the summary into the HUD feed.
              const kind = data?.kind ? String(data.kind) : 'task';
              const ms = typeof data?.totalMs === 'number' ? `${data.totalMs}ms` : '';
              const tools = typeof data?.toolCalls === 'number' ? `${data.toolCalls} tool call(s)` : '';
              const summary = [kind.toUpperCase(), ms, tools].filter(Boolean).join(' · ');
              useAppStore.getState().addActivityLine({
                id: nextActivityId(),
                time: Date.now(),
                kind: 'info',
                text: summary ? `Task settled: ${summary}` : 'Task settled',
              });
              break;
            }

            case 'error':
              setLastError(data.message);
              useAppStore.getState().addActivityLine({
                id: nextActivityId(),
                time: Date.now(),
                kind: 'error',
                text: String(data.message || 'Unknown error'),
              });
              break;

            case 'models-list':
              setModels(data);
              break;

            case 'confirmation-required':
              if (data && data.description) {
                setPendingConfirmation({
                  taskId: data.taskId,
                  stepId: data.stepId,
                  description: data.description,
                  action: typeof data.action === 'string' ? data.action : JSON.stringify(data.action || {}),
                });
              }
              useAppStore.getState().addActivityLine({
                id: nextActivityId(),
                time: Date.now(),
                kind: 'info',
                text: `Confirmation required: ${String(data?.description || '').slice(0, 200)}`,
              });
              break;

            // ── Jarvis HUD snapshots (real server state over the wire) ──

            case 'queue-updated':
              if (data && Array.isArray(data.tasks)) {
                useAppStore.getState().setQueue(data.tasks);
              }
              break;

            case 'mission-progress':
              if (data && Array.isArray(data.missions)) {
                useAppStore.getState().setMissions(data.missions);
              }
              break;

            case 'security-events':
              if (data && Array.isArray(data.events)) {
                useAppStore.getState().setSecurityEvents(data.events);
              }
              break;

            case 'journal-updated':
              // Real mission journal: the server's bounded record of what
              // actually ran (COMMAND → ACTION → OBSERVATION → RESULT).
              if (data && Array.isArray(data.entries)) {
                useAppStore.getState().setJournal(data.entries);
              }
              break;

            case 'jarvis-state':
              // The Jarvis engine's real phase/directive/report snapshot.
              if (data && typeof data.phase === 'string') {
                useAppStore.getState().setJarvisSnapshot(data);
                // Real routing/report transitions belong in the feed.
                if (data.lastReport && data.phase === 'idle') {
                  const r = data.lastReport;
                  useAppStore.getState().addActivityLine({
                    id: nextActivityId(),
                    time: Date.now(),
                    kind: r.status === 'SUCCESS' ? 'reply' : 'error',
                    text: `JARVIS REPORT: ${r.status}${r.blockers?.length ? ` — ${r.blockers[0]}` : ''}`,
                  });
                }
              }
              break;

            case 'agency-updated':
              // Real worker activations of the running agent. Fields are
              // validated before display — nothing is shown on a shape
              // mismatch (no fabricated roster).
              if (
                data &&
                typeof data.agentState === 'string' &&
                Array.isArray(data.workers) &&
                typeof data.activeCount === 'number'
              ) {
                useAppStore.getState().setAgencySnapshot(data);
              }
              break;

            case 'skills-selected':
              // Skill runtime (§14/§58): which skills the orchestrator
              // selected for THIS objective, with real match reasons.
              if (data && Array.isArray(data.skills) && data.skills.length > 0) {
                const names = data.skills
                  .map((s: { name?: string }) => String(s.name || '?'))
                  .join(', ');
                useAppStore.getState().addActivityLine({
                  id: nextActivityId(),
                  time: Date.now(),
                  kind: 'think',
                  text: `SKILLS: ${names}`.slice(0, 200),
                });
              }
              break;

            case 'memory-selected':
              // Layered memory (§20+/§58): WHICH memories were selected
              // for THIS objective and WHY — inspectable, never opaque.
              if (data && Array.isArray(data.selections) && data.selections.length > 0) {
                const layers = data.selections
                  .map((s: { layer?: string; reason?: string }) =>
                    `${String(s.layer || '?')}(${String(s.reason || '').slice(0, 40)})`)
                  .slice(0, 4)
                  .join(', ');
                useAppStore.getState().addActivityLine({
                  id: nextActivityId(),
                  time: Date.now(),
                  kind: 'think',
                  text: `MEMORY: ${layers}`.slice(0, 200),
                });
              }
              break;

            case 'jarvis-event':
              // Real Jarvis routing decisions (directive issued).
              if (data?.kind === 'directive-issued') {
                useAppStore.getState().addActivityLine({
                  id: nextActivityId(),
                  time: Date.now(),
                  kind: 'state',
                  text: `JARVIS → AGENT (${String(data.complexity).toUpperCase()}/${String(data.reason)}) ${String(data.goal || '')}`.slice(0, 200),
                });
              }
              break;

            case 'browser-session':
              // REAL browser-session lifecycle (§22/§23): desyncs and
              // recoveries surface in the activity feed — the HUD shows
              // the true connection state, never a fabricated browser.
              {
                const ev = data?.event;
                if (ev && typeof ev.type === 'string' && typeof ev.detail === 'string') {
                  useAppStore.getState().addActivityLine({
                    id: nextActivityId(),
                    time: Date.now(),
                    kind: ev.type === 'session-lost' ? 'error' : 'state',
                    text: `BROWSER ${String(ev.type).toUpperCase()}: ${ev.detail}`.slice(0, 200),
                  });
                }
              }
              break;

            case 'provider-status':
            case 'pong':
            case 'ready':
            case 'queue-task':
            case 'mission-created':
              // Informational / immediately followed by a full snapshot —
              // no extra client state change required.
              break;
          }
        } catch (err) {
          console.error('[BLAXIN] Failed to parse message:', err);
        }
      };
    } catch (err) {
      console.error('[BLAXIN] Connection failed:', err);
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimerRef.current);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  // On the FIRST successful connect, mark the boot complete so the HUD
  // boot overlay gives way to the real panels (never a fake timer).
  useEffect(() => {
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.connected && !prev.connected && !useAppStore.getState().bootComplete) {
        // Small delay lets the first snapshots (queue/mission/security)
        // arrive so the HUD boots into real state, not empty panels.
        setTimeout(() => useAppStore.getState().setBootComplete(true), 400);
        unsub();
      }
    });
    return unsub;
  }, []);

  const send = useCallback((payload: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const sendMessage = useCallback((content: string) => {
    send({ type: 'user-message', data: { content } });
  }, [send]);

  /** Slash-commands and ordinary messages both flow through the agent
   * channel; the server classifies commands deterministically. */
  const sendCommand = useCallback((text: string) => {
    send({ type: 'command', data: { text } });
  }, [send]);

  const enqueueTask = useCallback((objective: string, priority?: number) => {
    send({ type: 'queue-enqueue', data: { objective, priority } });
  }, [send]);

  const queueAction = useCallback((id: string, action: 'cancel' | 'pause' | 'resume') => {
    send({ type: `queue-${action}`, data: { id } });
  }, [send]);

  const createMission = useCallback((input: { objective: string; description?: string; steps?: string[]; priority?: number }) => {
    send({ type: 'mission-create', data: input });
  }, [send]);

  const missionAction = useCallback((id: string, action: 'pause' | 'resume' | 'cancel' | 'retry') => {
    send({ type: `mission-${action}`, data: { id } });
  }, [send]);

  const stopAgent = useCallback(() => {
    send({ type: 'stop' });
  }, [send]);

  const clearHistory = useCallback(() => {
    send({ type: 'clear' });
    useAppStore.getState().clearMessages();
    useAppStore.getState().clearToolExecutions();
    useAppStore.getState().setCurrentTask(null);
  }, [send]);

  const respondToConfirmation = useCallback((approved: boolean, scope: 'once' | 'task' | 'session' = 'once') => {
    const conf = useAppStore.getState().pendingConfirmation;
    if (!conf) return;
    send({
      type: 'confirmation-response',
      data: {
        taskId: conf.taskId,
        stepId: conf.stepId,
        approved,
        // once (default) | task (rest of this task) | session (until restart)
        scope,
      },
    });
    useAppStore.getState().setPendingConfirmation(null);
  }, [send]);

  return {
    sendMessage,
    sendCommand,
    enqueueTask,
    queueAction,
    createMission,
    missionAction,
    stopAgent,
    clearHistory,
    respondToConfirmation,
  };
}

// Re-exported for HUD components that need the line type.
export type { ActivityLine };
