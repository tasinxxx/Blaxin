import { getApiBase } from './endpoints';

// BLAXIN API client.
//
// Error handling contract:
// - Never surface raw engine-level parse errors (WebKitGTK throws
//   "The string did not match the expected pattern." when response.json()
//   meets an empty/non-JSON body). We always read the body as text and
//   parse it ourselves, translating failures into human-readable errors.
// - Never echo secrets. Server responses already avoid keys, but the
//   error message shown to the user must stay useful even on failure.

export interface MetricsToolTiming {
  name: string;
  ms: number;
  attempts: number;
  state: string;
}

/** Honest execution route for a task (§6). */
export type ExecutionMode = 'DETERMINISTIC' | 'AI_BRAIN' | 'HYBRID';

export interface MetricsTask {
  taskId: string;
  kind: 'direct' | 'llm';
  /** Present on new records; legacy records predate the field. */
  executionMode?: ExecutionMode;
  startedAt: number;
  queueWaitMs: number;
  totalMs: number;
  modelCalls: number;
  modelMs: number;
  toolCalls: number;
  waves: number;
  parallelWaves: number;
  tools: MetricsToolTiming[];
  result: string;
}

export interface MetricsSummary {
  samples: number;
  totalMs: { median: number; p95: number; min: number; max: number };
  queueWaitMs: { median: number; p95: number };
  modelMs: { median: number; p95: number };
  toolMs: { median: number; p95: number };
  modelCalls: number;
  toolCalls: number;
  totalModelMs: number;
  totalToolMs: number;
  waves: number;
  parallelWaves: number;
  direct: number;
  llm: number;
  errors: number;
  executionModes?: { DETERMINISTIC: number; AI_BRAIN: number; HYBRID: number };
  byKind: {
    direct: { count: number; medianMs: number; p95Ms: number };
    llm: { count: number; medianMs: number; p95Ms: number };
  };
}

export interface MetricsResponse {
  summary: MetricsSummary;
  tasks: MetricsTask[];
}

// ── Mission journal (§20): the real record of what ran ────────

export type JournalStatus =
  | 'INFO' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED'
  | 'BLOCKED' | 'RECOVERING' | 'RECOVERED' | 'UNVERIFIED';

export type JournalKind =
  | 'COMMAND' | 'ROUTER' | 'PLAN' | 'ACTION' | 'OBSERVATION'
  | 'VERIFICATION' | 'RECOVERY' | 'MEMORY' | 'RESULT';

export interface JournalEntry {
  id: string;
  seq: number;
  at: number;
  kind: JournalKind;
  status: JournalStatus;
  objective?: string;
  missionId?: string;
  taskId?: string;
  actionId?: string;
  specialist?: string;
  intent?: string;
  action?: string;
  observation?: string;
  verification?: { method: string; status: string; detail: string };
  retries?: number;
  failure?: string;
  recovery?: string;
  detail?: string;
}

// ── Live system telemetry ─────────────────────────────────────

export interface SystemTelemetry {
  timestamp: number;
  cpu: {
    usagePercent: number;
    cores: number;
    model: string | null;
    loadAvg: { one: number; five: number; fifteen: number };
  };
  memory: { totalBytes: number; usedBytes: number; freeBytes: number; percent: number };
  disk: { totalBytes: number; usedBytes: number; percent: number; mount: string } | null;
  uptimeSec: number;
  os: { platform: string; release: string; arch: string; hostname: string };
  nodeVersion: string;
}

export interface CapabilityInfo {
  name: string;
  description: string;
  enabled: boolean;
}

export type MemoryType = 'preference' | 'fact' | 'project' | 'action-result';

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

export interface SystemStatus {
  version: string;
  mode: 'embedded' | 'external';
  deviceId: string;
  uptime: number;
  state: string;
  activeProvider: string | null;
  activeModel: string | null;
  providers: Array<{ id: string; hasKey: boolean }>;
  security: { encryption: string; keysConfigured: number; originPolicy: string };
  queue: { count: number };
  missions: { count: number };
  tools: { count: number };
}

export interface NetworkTelemetry {
  timestamp: number;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  interfaces: Array<{ name: string; rxBytes: number; txBytes: number }>;
  rxTotalBytes: number;
  txTotalBytes: number;
}

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  source: 'user' | 'agent' | 'system';
  createdAt: number;
  lastUsedAt: number;
  scope?: string;
}

/** Layered-memory snapshot (§20+) — mirrors server memory/layers.ts. */
export interface LayeredMemorySnapshot {
  failures: Array<{
    id: string; category: string; failedAction: string; observation: string;
    cause?: string; recovery?: { description: string; at: number };
    finalResult: string; occurrences: number; lastSeenAt: number; confidence: number;
  }>;
  environment: Array<{
    id: string; key: string; value: string; volatility: string;
    confirmations: number; confidence: number; updatedAt: number;
  }>;
  episodes: Array<{
    id: string; objective: string; outcome: string; strategy: string;
    lessons: string[]; verified: boolean; confidence: number; createdAt: number;
  }>;
  procedures: Array<{
    id: string; name: string; purpose: string; steps: string[];
    version: number; status: string; successCount: number; failureCount: number;
    confidence: number;
  }>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function httpStatusLabel(status: number): string {
  if (status === 0) return 'Network error';
  if (status === 400) return 'Bad request (HTTP 400)';
  if (status === 401) return 'Unauthorized (HTTP 401)';
  if (status === 403) return 'Forbidden (HTTP 403)';
  if (status === 404) return 'Not found (HTTP 404)';
  if (status === 429) return 'Rate limited (HTTP 429)';
  if (status >= 500) return `Server error (HTTP ${status})`;
  return `HTTP ${status}`;
}

// ── Distributed Brain (external mode) ─────────────────────────

export interface BrainLinkStatus {
  state: string;
  phase: string;
  brainId: string | null;
  brainName: string | null;
  protocol: number | null;
  sessionId: string | null;
  connectedAt: number | null;
  lastError: string | null;
  url?: string;
  transport?: 'ws' | 'wss';
  secure?: boolean;
}

export interface BrainStatusResponse {
  mode: 'embedded' | 'external';
  bodyId: string | null;
  brain?: BrainLinkStatus | null;
  capabilities?: string[];
  task?: {
    id: string;
    state: string;
    instruction: string;
    steps?: Array<{ id: string; description: string; state: string }>;
  } | null;
}

export interface BrainDevice {
  bodyId: string;
  name: string;
  capabilities: string[];
  status: 'online' | 'offline' | 'revoked' | string;
  lastSeen?: number | null;
  pairedAt?: number | null;
  revokedAt?: number | null;
  protocol?: { min: number; max: number };
}

export interface BrainRegistrySnapshot {
  version: number;
  devices: BrainDevice[];
}

export interface BrainRegistryStatus {
  version: number;
  total: number;
  online: number;
  offline: number;
  revoked: number;
}

export interface BrainPairingCode {
  brainId: string;
  code: string;
  expiresInSec: number;
}

/** The Brain serves its HTTP admin plane on the same port as its WebSocket
 * endpoint, so a wss://brain URL implies https://admin on that host:port. */
export function adminBaseFromBrainUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const m = /^(wss|ws):\/\/([^/]+)(\/|$)/.exec(url.trim());
  if (!m) return null;
  const scheme = m[1] === 'wss' ? 'https' : 'http';
  return `${scheme}://${m[2]}`;
}

async function fetchUrl<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      `Could not reach ${url} (${reason}). Check that it is running and reachable from this browser.`,
      0,
    );
  }

  const text = await response.text().catch(() => '');

  let data: any = null;
  let bodyIsJson = false;
  if (text) {
    try {
      data = JSON.parse(text);
      bodyIsJson = true;
    } catch {
      bodyIsJson = false;
    }
  }

  if (!response.ok) {
    const serverMessage = data && (data.error || data.message);
    const message = typeof serverMessage === 'string' && serverMessage
      ? serverMessage
      : `${httpStatusLabel(response.status)} while contacting ${url}.`;
    throw new ApiError(message, response.status, data?.code);
  }
  if (!bodyIsJson && text.trim().length > 0) {
    throw new ApiError('The server returned an unexpected (non-JSON) response. It may not be the expected service.', response.status, 'INVALID_RESPONSE');
  }
  if (!bodyIsJson && text.trim().length === 0) {
    throw new ApiError('The server returned an empty response.', response.status, 'EMPTY_RESPONSE');
  }
  return data as T;
}

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${getApiBase()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      `Could not reach the BLAXIN backend (${reason}). Check that the backend is running.`,
      0,
    );
  }

  // Read as text first so we never hand a broken body to response.json().
  const text = await response.text().catch(() => '');

  let data: any = null;
  let bodyIsJson = false;
  if (text) {
    try {
      data = JSON.parse(text);
      bodyIsJson = true;
    } catch {
      bodyIsJson = false;
    }
  }

  if (!response.ok) {
    const serverMessage = data && (data.error || data.message);
    const message = typeof serverMessage === 'string' && serverMessage
      ? serverMessage
      : `${httpStatusLabel(response.status)} while contacting the BLAXIN backend.`;
    throw new ApiError(message, response.status, data?.code);
  }

  // A 2xx with a non-JSON (or empty) body means the request hit the wrong
  // server (e.g. an asset server instead of the backend). Report that
  // explicitly instead of letting the engine throw a cryptic parse error.
  if (!bodyIsJson && text.trim().length > 0) {
    throw new ApiError(
      'The BLAXIN backend returned an unexpected response. The server may be misconfigured.',
      response.status,
      'INVALID_RESPONSE',
    );
  }
  if (!bodyIsJson && text.trim().length === 0) {
    throw new ApiError(
      'The BLAXIN backend returned an empty response. Check that the backend is running.',
      response.status,
      'EMPTY_RESPONSE',
    );
  }

  return data as T;
}

/** Call the Brain's OWN loopback/allowlisted admin HTTP plane (pairing
 * code generation, device registry, revocation). The Brain's origin
 * policy decides whether this browser may — remote Brains require the
 * operator to allow the origin; same-machine/desktop Brains are allowed
 * by default. The Body API never proxies these (Bodies are not
 * privileged over other Bodies). */
/** Convert an admin base URL (http/https) to its WebSocket URL for the
 * registry realtime channel (the Brain serves both on the same port). */
export function registryWsUrl(base: string): string {
  const trimmed = trimBase(base);
  return `${trimmed.replace(/^http/, 'ws')}/ws/admin`;
}

export const brainAdmin = {
  startPairing: (base: string) =>
    fetchUrl<BrainPairingCode>(`${trimBase(base)}/pairing/start`, { method: 'POST', body: '{}' }),

  /** Authoritative registry snapshot (with the monotonic version). */
  listDevices: (base: string) =>
    fetchUrl<BrainRegistrySnapshot>(`${trimBase(base)}/devices`),

  /** Single Body details (selected-Body panel). */
  getDevice: (base: string, bodyId: string) =>
    fetchUrl<{ version: number; body: BrainDevice }>(`${trimBase(base)}/devices/${encodeURIComponent(bodyId)}`),

  /** Lightweight registry status summary. */
  registryStatus: (base: string) =>
    fetchUrl<BrainRegistryStatus>(`${trimBase(base)}/registry/status`),

  revokeDevice: (base: string, bodyId: string) =>
    fetchUrl<{ success: boolean; bodyId: string }>(`${trimBase(base)}/devices/${encodeURIComponent(bodyId)}/revoke`, { method: 'POST', body: '{}' }),
};

function trimBase(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

export const api = {
  // Health
  health: () => fetchAPI<{ status: string; version: string; uptime: number }>('/health'),

  // Update check
  updateCheck: () =>
    fetchAPI<{
      updateAvailable: boolean;
      currentVersion?: string;
      latestVersion?: string;
      majorUpdate?: boolean;
      releaseName?: string;
      releaseNotes?: string;
      releaseDate?: string;
      downloadUrl?: string;
      assets?: Array<{ name: string; size: number; downloadUrl: string; contentType: string }>;
      error?: string;
    }>('/update/check'),

  // Diagnostics
  diagnostics: () => fetchAPI<any>('/diagnostics'),

  // Mission journal (§20)
  getJournal: (limit?: number) =>
    fetchAPI<{ entries: JournalEntry[] }>(`/journal?limit=${limit ?? 200}`),
  clearJournal: () => fetchAPI<{ success: boolean }>('/journal', { method: 'DELETE' }),

  // Live system telemetry
  getSystemTelemetry: () => fetchAPI<SystemTelemetry>('/system/telemetry'),

  // Capabilities (tools + enabled state)
  getCapabilities: async (): Promise<CapabilityInfo[]> => {
    const [tools, status] = await Promise.all([
      fetchAPI<Array<{ name: string; description: string }>>('/tools'),
      fetchAPI<Record<string, boolean>>('/tools/status'),
    ]);
    return tools.map((t) => ({ name: t.name, description: t.description, enabled: status[t.name] ?? false }));
  },

  // Performance metrics
  metrics: (n?: number) =>
    fetchAPI<MetricsResponse>(`/metrics?n=${n ?? 50}`),

  // Providers
  getProviders: () => fetchAPI<Array<{ id: string; name: string; hasKey: boolean; maskedKey?: string }>>('/providers'),

  validateKey: (providerId: string, apiKey: string) =>
    fetchAPI<{ valid: boolean; error?: string; code?: string }>(`/providers/${providerId}/validate`, {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    }),

  saveKey: (providerId: string, apiKey: string, opts?: { skipValidation?: boolean }) =>
    fetchAPI<{ valid: boolean; error?: string; code?: string }>(`/providers/${providerId}/save-key`, {
      method: 'POST',
      body: JSON.stringify({ apiKey, skipValidation: opts?.skipValidation }),
    }),

  removeKey: (providerId: string) =>
    fetchAPI(`/providers/${providerId}/key`, { method: 'DELETE' }),

  // Models
  getModels: (providerId: string) =>
    fetchAPI<Array<any>>(`/providers/${providerId}/models`),

  getAllModels: () => fetchAPI<Array<any>>('/models'),

  setActiveModel: (providerId: string, modelId: string) =>
    fetchAPI('/models/active', {
      method: 'POST',
      body: JSON.stringify({ providerId, modelId }),
    }),

  // Tools
  getTools: () => fetchAPI<Array<{ name: string; description: string }>>('/tools'),

  getToolStatus: () => fetchAPI<Record<string, boolean>>('/tools/status'),

  toggleTool: (name: string, enabled: boolean) =>
    fetchAPI(`/tools/${name}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  // Memory
  getMemory: (q?: string) => fetchAPI<MemoryEntry[]>(`/memory${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  addMemory: (input: { type: string; content: string; scope?: string }) =>
    fetchAPI<{ success: boolean; entry?: MemoryEntry }>('/memory', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteMemory: (id: string) =>
    fetchAPI<{ success: boolean }>(`/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearMemory: () => fetchAPI<{ success: boolean }>('/memory', { method: 'DELETE' }),

  // Layered memory (§20+): failure/environment/episode/procedure stores
  getMemoryLayers: () => fetchAPI<LayeredMemorySnapshot>('/memory/layers'),
  deleteMemoryLayer: (kind: string, id: string) =>
    fetchAPI<{ success: boolean }>(`/memory/layers/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearMemoryLayers: () => fetchAPI<{ success: boolean }>('/memory/layers', { method: 'DELETE' }),

  // Jarvis: queue, missions, security, status
  getQueue: () => fetchAPI<{ tasks: QueueTask[] }>('/queue'),

  enqueueTask: (objective: string, priority?: number) =>
    fetchAPI<{ success: boolean; task: QueueTask }>('/queue', {
      method: 'POST',
      body: JSON.stringify({ objective, priority }),
    }),

  queueAction: (id: string, action: 'cancel' | 'pause' | 'resume') =>
    fetchAPI<{ success: boolean }>(`/queue/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: '{}',
    }),

  getMissions: () => fetchAPI<{ missions: Mission[] }>('/missions'),

  createMission: (input: { objective: string; description?: string; steps?: string[]; priority?: number }) =>
    fetchAPI<{ success: boolean; mission: Mission }>('/missions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  missionAction: (id: string, action: 'pause' | 'resume' | 'cancel' | 'retry') =>
    fetchAPI<{ success: boolean }>(`/missions/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: '{}',
    }),

  getSecurityEvents: (limit = 50) =>
    fetchAPI<{ events: SecurityEvent[] }>(`/security/events?limit=${limit}`),

  getStatus: () => fetchAPI<SystemStatus>('/status'),

  getNetworkTelemetry: () => fetchAPI<NetworkTelemetry>('/system/network'),

  // Agent
  sendMessage: (message: string) =>
    fetchAPI('/agent/message', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  stopAgent: () =>
    fetchAPI('/agent/stop', { method: 'POST' }),

  clearAgent: () =>
    fetchAPI('/agent/clear', { method: 'POST' }),

  getHistory: () => fetchAPI<Array<any>>('/agent/history'),

  // Distributed Brain (external mode)
  getBrainStatus: () => fetchAPI<BrainStatusResponse>('/brain/status'),

  connectBrain: (url?: string, code?: string) =>
    fetchAPI<{ success: boolean }>('/brain/connect', {
      method: 'POST',
      body: JSON.stringify({ url: url?.trim() || undefined, code: code?.trim() || undefined }),
    }),

  disconnectBrain: () =>
    fetchAPI<{ success: boolean }>('/brain/disconnect', { method: 'POST', body: '{}' }),

  reconnectBrain: () =>
    fetchAPI<{ success: boolean }>('/brain/reconnect', { method: 'POST', body: '{}' }),

  unpairBrain: () =>
    fetchAPI<{ success: boolean }>('/brain/unpair', { method: 'POST', body: '{}' }),

  // ── Infrastructure: local models + Oracle Cloud ────────────

  getResources: () => fetchAPI<any>('/resources'),

  getCatalog: () => fetchAPI<any>('/catalog'),

  recommend: (opts: {
    capabilities?: string[];
    preferLargest?: boolean;
    scope?: 'local' | 'cloud';
    compartmentId?: string;
    shapeId?: string;
  }) =>
    fetchAPI<any>('/recommend', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  getRuntimeStatus: () => fetchAPI<any>('/runtime/status'),

  getRuntimeLogs: (lines = 100) =>
    fetchAPI<any>(`/runtime/logs?lines=${lines}`),

  runtimeAction: (action: 'install' | 'start' | 'stop' | 'restart') =>
    fetchAPI<any>(`/runtime/${action}`, { method: 'POST', body: '{}' }),

  pullModel: (modelId: string) =>
    fetchAPI<any>('/runtime/pull', {
      method: 'POST',
      body: JSON.stringify({ modelId }),
    }),

  getCloudStatus: () => fetchAPI<any>('/cloud/status'),

  getCloudTopology: () => fetchAPI<any>('/cloud/topology'),

  getCloudShapes: (compartmentId: string) =>
    fetchAPI<any>(`/cloud/shapes?compartmentId=${encodeURIComponent(compartmentId)}`),

  getCloudInstances: (compartmentId: string) =>
    fetchAPI<any>(`/cloud/instances?compartmentId=${encodeURIComponent(compartmentId)}`),

  getCloudQuota: (compartmentId: string) =>
    fetchAPI<any>(`/cloud/quota?compartmentId=${encodeURIComponent(compartmentId)}`),

  getTunnelInfo: () => fetchAPI<any>('/cloud/tunnel'),

  connectOci: (creds: {
    tenancy: string;
    user: string;
    fingerprint: string;
    privateKey: string;
    region: string;
  }) =>
    fetchAPI<any>('/cloud/oci/connect', {
      method: 'POST',
      body: JSON.stringify(creds),
    }),

  disconnectOci: () =>
    fetchAPI<any>('/cloud/oci', { method: 'DELETE' }),

  getDeployments: () => fetchAPI<any>('/cloud/deployments'),

  deploy: (input: {
    shapeId: string;
    compartmentId: string;
    availabilityDomain: string;
    modelId: string;
    runtimeId: string;
    ocpus?: number | null;
    memoryInGbs?: number | null;
  }) =>
    fetchAPI<any>('/cloud/deploy', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  cancelDeployment: (id: string) =>
    fetchAPI<any>(`/cloud/deployments/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: '{}',
    }),
};
