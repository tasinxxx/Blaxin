import { create } from 'zustand';
import type { BrainStatusResponse } from '../services/api';

export type AgentState = 'idle' | 'thinking' | 'planning' | 'executing' | 'observing' | 'waiting' | 'completed' | 'error' | 'requires-confirmation';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ToolExecution {
  toolName: string;
  args: Record<string, unknown>;
  state: string;
  result?: string;
}

/** Mirrors the server's AgentTask/TaskStep shapes (task-progress events). */
export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type PermissionScope = 'ALWAYS_ALLOW' | 'ALLOW_ONCE' | 'ALLOW_TASK' | 'ALLOW_SESSION' | 'DENY';

export interface ActiveTaskStep {
  id: string;
  description: string;
  toolName?: string;
  state: 'pending' | 'executing' | 'completed' | 'failed' | 'skipped' | 'retrying';
  result?: string;
  error?: string;
  /** Declared danger of this action (server-computed). */
  riskTier?: RiskTier;
  /** How this step was authorized (server-computed). */
  permissionScope?: PermissionScope;
}

export interface ActiveTask {
  id: string;
  instruction: string;
  state: string;
  steps: ActiveTaskStep[];
  currentStep: number;
  startTime: number;
  endTime?: number;
}

// ── Jarvis HUD state (real server state mirrored over the wire) ──

export type QueueTaskStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface QueueTask {
  id: string;
  objective: string;
  priority: number;
  status: QueueTaskStatus;
  dependsOn: string[];
  missionId?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  result?: string;
  error?: string;
}

export type MissionStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface MissionStep {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  result?: string;
  error?: string;
  checkpoint?: { completedAt: number; summary: string };
}

export interface Mission {
  id: string;
  objective: string;
  description?: string;
  priority: number;
  status: MissionStatus;
  progress: number;
  steps: MissionStep[];
  currentStepIndex: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  history: string[];
  errors: string[];
}

export interface SecurityEvent {
  id: string;
  time: number;
  category: string;
  message: string;
}

// ── Jarvis layer state (real server state mirrored over the wire) ──

export type JarvisPhase = 'idle' | 'understanding' | 'routing' | 'delegated' | 'reporting';

export interface JarvisDirective {
  id: string;
  goal: string;
  context: {
    previousExchange?: { request: string; outcome: string } | null;
    missionId?: string;
    missionObjective?: string;
    plannedSteps?: number;
  };
  constraints: string[];
  successCondition?: string;
  priority: number;
  complexity: 'fast' | 'standard' | 'mission';
  reason: string;
  source: 'text' | 'voice';
  issuedAt: number;
}

export interface AgentReport {
  directiveId: string;
  taskId?: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'STOPPED' | 'NOT_EXECUTED';
  /** Real per-step outcomes (bounded). `id` is the runtime's own step identity. */
  evidence: Array<{ id: string; description: string; state: string; result?: string; error?: string }>;
  summary?: string;
  metrics?: {
    totalMs: number;
    modelCalls: number;
    toolCalls: number;
    kind: string;
    /** Honest execution route (§6): DETERMINISTIC / AI_BRAIN / HYBRID. */
    executionMode?: 'DETERMINISTIC' | 'AI_BRAIN' | 'HYBRID';
  };
  blockers: string[];
  reportedAt: number;
}

export interface JarvisSnapshot {
  phase: JarvisPhase;
  directive: JarvisDirective | null;
  lastReport: AgentReport | null;
}

// ── Agency layer (real worker activations of the existing agent) ──

export type WorkerState =
  | 'queued' | 'running' | 'waiting' | 'blocked'
  | 'completed' | 'failed' | 'skipped' | 'retrying' | 'cancelled';

export interface WorkerRecord {
  /** REAL id — the runtime step id (never generated for display). */
  id: string;
  taskId?: string;
  role: string;
  tool: string;
  toolKnown: boolean;
  description: string;
  state: WorkerState;
  startedAt?: number;
  endedAt?: number;
  result?: string;
  error?: string;
  attempts: number;
  permissionScope?: string;
}

export interface AgencySnapshot {
  agentState: string;
  agentDescription: string | null;
  taskWaiting: boolean;
  workers: WorkerRecord[];
  activeCount: number;
  queueWaiting: number;
  queuedTasks: Array<{ id: string; status: string; objective: string }>;
}

export type VoiceState =
  | 'MIC_OFF'
  | 'LISTENING'
  | 'VOICE_DETECTED'
  | 'TRANSCRIBING'
  | 'UNDERSTANDING'
  | 'SPEAKING'
  | 'ERROR';

/** A single line in the HUD terminal / activity feed (real events only). */
export interface ActivityLine {
  id: string;
  time: number;
  kind: 'state' | 'tool' | 'think' | 'reply' | 'user' | 'error' | 'info';
  text: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  isFree: boolean;
  isAvailable: boolean;
  capabilities: string[];
  contextWindow?: number;
  maxOutput?: number;
  description?: string;
  pricing?: { prompt: number; completion: number };
}

export interface ProviderStatus {
  id: string;
  name: string;
  hasKey: boolean;
  maskedKey?: string;
}

interface AppState {
  // Connection
  connected: boolean;
  setConnected: (connected: boolean) => void;

  // Agent
  agentState: AgentState;
  setAgentState: (state: AgentState) => void;
  agentDescription: string | null;
  setAgentDescription: (desc: string | null) => void;
  messages: ChatMessage[];
  addMessage: (msg: ChatMessage) => void;
  clearMessages: () => void;

  // Confirmation requests from the agent (high-impact tool actions)
  pendingConfirmation: {
    taskId?: string;
    stepId?: string;
    description: string;
    action: string;
  } | null;
  setPendingConfirmation: (conf: {
    taskId?: string;
    stepId?: string;
    description: string;
    action: string;
  } | null) => void;

  // Current agent task (real task-progress events from the server)
  currentTask: ActiveTask | null;
  setCurrentTask: (task: ActiveTask | null) => void;

  // Tools
  toolExecutions: ToolExecution[];
  addToolExecution: (exec: ToolExecution) => void;
  clearToolExecutions: () => void;

  // Providers & Models
  providers: ProviderStatus[];
  setProviders: (providers: ProviderStatus[]) => void;
  activeProvider: string | null;
  setActiveProvider: (id: string | null) => void;
  activeModel: string | null;
  setActiveModel: (id: string | null) => void;
  models: ModelInfo[];
  setModels: (models: ModelInfo[]) => void;

  // UI State
  currentPage: string;
  setCurrentPage: (page: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  // Voice
  voiceEnabled: boolean;
  setVoiceEnabled: (enabled: boolean) => void;
  ttsEnabled: boolean;
  setTtsEnabled: (enabled: boolean) => void;
  isListening: boolean;
  setIsListening: (listening: boolean) => void;
  voiceTranscript: string;
  setVoiceTranscript: (transcript: string) => void;

  // JARVIS audio identity (event sounds)
  audioEnabled: boolean;
  setAudioEnabled: (enabled: boolean) => void;
  audioVolume: number;
  setAudioVolume: (volume: number) => void;

  // Distributed Brain (external mode) — snapshot of the authoritative
  // server status (the server owns the connection state machine; the UI
  // only mirrors it).
  brainStatus: BrainStatusResponse | null;
  setBrainStatus: (status: BrainStatusResponse | null) => void;

  // Error
  lastError: string | null;
  setLastError: (error: string | null) => void;

  // Jarvis HUD
  queue: QueueTask[];
  setQueue: (tasks: QueueTask[]) => void;
  missions: Mission[];
  setMissions: (missions: Mission[]) => void;
  securityEvents: SecurityEvent[];
  setSecurityEvents: (events: SecurityEvent[]) => void;
  activityFeed: ActivityLine[];
  addActivityLine: (line: ActivityLine) => void;
  clearActivityFeed: () => void;
  bootComplete: boolean;
  setBootComplete: (complete: boolean) => void;
  deviceId: string | null;
  setDeviceId: (id: string | null) => void;

  // JARVIS executive layer (real server snapshot via jarvis-state)
  jarvis: JarvisSnapshot;
  setJarvisSnapshot: (snapshot: JarvisSnapshot) => void;

  // Agency: real worker activations (server-driven; empty until the
  // agent really runs something).
  agency: AgencySnapshot | null;
  setAgencySnapshot: (snapshot: AgencySnapshot) => void;

  // Voice state (REAL: derived from actual mic/STT/submit transitions)
  voiceState: VoiceState;
  setVoiceState: (state: VoiceState) => void;
}

// JARVIS audio identity preferences (persisted locally).
const AUDIO_ENABLED_KEY = 'blaxin-audio-enabled';
const AUDIO_VOLUME_KEY = 'blaxin-audio-volume';

function loadAudioEnabled(): boolean {
  try {
    return localStorage.getItem(AUDIO_ENABLED_KEY) !== '0';
  } catch {
    return true;
  }
}

function loadAudioVolume(): number {
  try {
    const v = Number(localStorage.getItem(AUDIO_VOLUME_KEY));
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
  } catch {
    return 0.5;
  }
}

export const useAppStore = create<AppState>((set) => ({
  connected: false,
  setConnected: (connected) => set({ connected }),

  agentState: 'idle',
  setAgentState: (state) => set({ agentState: state }),
  agentDescription: null,
  setAgentDescription: (desc) => set({ agentDescription: desc }),
  messages: [],
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  clearMessages: () => set({ messages: [] }),

  pendingConfirmation: null,
  setPendingConfirmation: (conf) => set({ pendingConfirmation: conf }),

  currentTask: null,
  setCurrentTask: (task) => set({ currentTask: task }),

  toolExecutions: [],
  addToolExecution: (exec) => set((s) => ({
    toolExecutions: [...s.toolExecutions.slice(-20), exec],
  })),
  clearToolExecutions: () => set({ toolExecutions: [] }),

  providers: [],
  setProviders: (providers) => set({ providers }),
  activeProvider: null,
  setActiveProvider: (id) => set({ activeProvider: id }),
  activeModel: null,
  setActiveModel: (id) => set({ activeModel: id }),
  models: [],
  setModels: (models) => set({ models }),

  currentPage: 'chat',
  setCurrentPage: (page) => set({ currentPage: page }),
  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  voiceEnabled: false,
  setVoiceEnabled: (enabled) => set({ voiceEnabled: enabled }),
  ttsEnabled: true,
  setTtsEnabled: (enabled) => set({ ttsEnabled: enabled }),
  isListening: false,
  setIsListening: (listening) => set({ isListening: listening }),
  voiceTranscript: '',
  setVoiceTranscript: (transcript) => set({ voiceTranscript: transcript }),

  audioEnabled: loadAudioEnabled(),
  setAudioEnabled: (enabled) => {
    try { localStorage.setItem(AUDIO_ENABLED_KEY, enabled ? '1' : '0'); } catch { /* private mode */ }
    set({ audioEnabled: enabled });
  },
  audioVolume: loadAudioVolume(),
  setAudioVolume: (volume) => {
    const clamped = Math.max(0, Math.min(1, volume));
    try { localStorage.setItem(AUDIO_VOLUME_KEY, String(clamped)); } catch { /* private mode */ }
    set({ audioVolume: clamped });
  },

  brainStatus: null,
  setBrainStatus: (status) => set({ brainStatus: status }),

  lastError: null,
  setLastError: (error) => set({ lastError: error }),

  queue: [],
  setQueue: (tasks) => set({ queue: tasks }),
  missions: [],
  setMissions: (missions) => set({ missions }),
  securityEvents: [],
  setSecurityEvents: (events) => set({ securityEvents: events }),
  activityFeed: [],
  addActivityLine: (line) => set((s) => ({
    activityFeed: [...s.activityFeed.slice(-200), line],
  })),
  clearActivityFeed: () => set({ activityFeed: [] }),
  bootComplete: false,
  setBootComplete: (complete) => set({ bootComplete: complete }),
  deviceId: null,
  setDeviceId: (id) => set({ deviceId: id }),

  jarvis: { phase: 'idle', directive: null, lastReport: null },
  setJarvisSnapshot: (snapshot) => set({ jarvis: snapshot }),

  agency: null,
  setAgencySnapshot: (snapshot) => set({ agency: snapshot }),

  voiceState: 'MIC_OFF',
  setVoiceState: (state) => set({ voiceState: state }),
}));
