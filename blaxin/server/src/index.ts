import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { providers } from './providers/index.js';
import { toolRegistry } from './tools/index.js';
import { orchestrator } from './orchestrator/index.js';
import { handleTerminalWebSocket, terminateAllSessions } from './tools/terminal-stream.js';
import { logger } from './utils/logger.js';
import { loadConfig, saveConfig } from './utils/config.js';
import { credentialStore } from './utils/credentials.js';
import { runDiagnostics } from './utils/diagnostics.js';
import { sessionState } from './utils/session-state.js';
import { memoryStore, MemoryType, MemoryEntry, looksSensitive } from './utils/memory.js';
import { memoryLayers } from './memory/layers.js';

// Wire the REAL layered-memory runtime into the orchestrator (§20+):
// run outcomes (episodes/failures/verified environment observations)
// persist, and the advisor reads task-relevant slices back per task.
// The orchestrator singleton already defaults to memoryLayers; this makes
// the wiring explicit and survives future dependency-injection changes.
orchestrator.setMemoryRuntime(memoryLayers);

// Wire the REAL layered-memory runtime into the orchestrator (§20+):
// run outcomes (episodes/failures/verified environment observations)
// persist, and the advisor reads task-relevant slices back per task.
import { telemetry, parseMetricsLimit } from './utils/telemetry.js';
import {
  corsOriginValidator,
  getAllowedOriginsFromEnv,
  isOriginAllowed,
  isStateChangingRequestAllowed,
} from './utils/security.js';
import { isVersionNewer, isMajorVersionUpgrade } from './utils/semver.js';
import { isValidUserMessage, normalizeUserMessage } from './utils/validation.js';
import { APP_VERSION, GITHUB_REPO, GITHUB_RELEASES_URL } from './utils/version.js';
import { getSystemTelemetry, getNetworkTelemetry } from './utils/system-telemetry.js';
import { dataPath } from './utils/paths.js';
import { loadOrCreateIdentity } from './distributed/identity.js';
import { AgencyRegistry } from './agency/registry.js';
import { browserSession } from './tools/browser-session.js';
import { RemoteBrainDriver } from './distributed/remote-brain.js';
import { validateBrainUrl } from './distributed/transport-policy.js';
import { OllamaRuntime } from './models/ollama-runtime.js';
import { OciCloudProvider } from './cloud/oci/client.js';
import { resolveOciPlatformImageId } from './cloud/oci/client.js';
import { DeploymentEngine } from './cloud/deployment.js';
import { createInfrastructureRouter } from './api/infrastructure.js';
import { TaskQueue } from './utils/task-queue.js';
import { MissionStore } from './utils/missions.js';
import { securityLog } from './utils/security-log.js';
import { JarvisScheduler } from './utils/scheduler.js';
import { classifyCommand, commandHelpText } from './router/commands.js';
import { createJarvisHost } from './jarvis/host.js';
import type { JarvisDirective } from './jarvis/types.js';
import { ProviderId, AppConfig } from './types.js';

// ── External Brain mode ─────────────────────────────────────────
// BLAXIN runs in one of two modes:
//   embedded (default) — the local orchestrator + providers act as the
//                        Brain in the same process (classic desktop app)
//   external           — this device is the BODY; intelligence comes from
//                        a separate BLAXIN Brain process (see brain-main)
// In external mode the orchestrator is bypassed for user tasks: the
// Brain drives the task and the Body executes only structured actions
// it has validated against its own capability/policy layer.
const BRAIN_MODE: 'embedded' | 'external' =
  process.env.BLAXIN_BRAIN_MODE === 'external' ? 'external' : 'embedded';
const BRAIN_URL = process.env.BLAXIN_BRAIN_URL || '';

let remoteBrain: RemoteBrainDriver | null = null;

// ── Event hub ──────────────────────────────────────────────
// Every real agent event flows through here: broadcast to WS clients
// AND fed to the subscribers below (scheduler, Jarvis). One source of
// truth — nothing subscribes to a parallel copy of the truth.
type AgentEventListener = (event: string, data: any) => void;
const agentEventListeners: AgentEventListener[] = [];
function onAgentEvent(listener: AgentEventListener): void {
  agentEventListeners.push(listener);
}

// ── Jarvis task queue + missions (embedded mode) ───────────────
// Persistent user-level task queue and mission store. The scheduler
// is the single path that feeds work to the orchestrator, so queue
// tasks run one at a time and missions advance on verified completion.
const queue = new TaskQueue();
const missions = new MissionStore();

// ── Agency registry (REAL worker visibility) ─────────────────
// Tracks role activations of the EXISTING agent: every real tool
// execution becomes a worker keyed by its real step id. Lifecycle is
// driven ONLY by real events — nothing is ever activated decoratively.
const agency = new AgencyRegistry((snapshot) => broadcast('agency-updated', snapshot));
onAgentEvent((event, data) => {
  switch (event) {
    case 'agent-state':            agency.onAgentState(data); break;
    case 'tool-execution':         agency.onToolExecution(data); break;
    case 'confirmation-required':  agency.onConfirmationRequired(data); break;
    case 'task-progress':          agency.onTaskProgress(data); break;
    case 'task-complete':          agency.onTaskComplete(data); break;
    case 'queue-updated':          agency.onQueueUpdated(data?.tasks ?? []); break;
  }
});

/** Broadcast AND feed every hub subscriber (single source of truth). */
function emitAll(event: string, data: unknown): void {
  broadcast(event, data);
  for (const listener of agentEventListeners) {
    try {
      listener(event, data);
    } catch (error: any) {
      logger.warn('events', `Listener for ${event} failed: ${error.message}`);
    }
  }
}

const scheduler = new JarvisScheduler({
  queue,
  missions,
  orchestrator,
  emit: emitAll,
});

// ── JARVIS — the user-facing executive layer ──────────────
// Jarvis receives commands (text/voice), routes them (fast/standard/
// mission), issues a structured directive, and reports the honest
// outcome from real events. The agent path stays unchanged: queue →
// scheduler → orchestrator. Mission-routed directives create a
// persistent mission (checkpointed, resumable) instead of a one-shot
// queue task.
const jarvisHost = createJarvisHost({
  events: { on: onAgentEvent },
  executeGoal: (directive: JarvisDirective) => {
    if (directive.complexity === 'mission') {
      // Mission-routed: split into explicit steps when the directive
      // carries a plan; otherwise the objective decomposes at runtime.
      const mission = missions.create({
        objective: directive.goal,
        priority: directive.priority,
        steps: undefined,
      });
      scheduler.pump();
      return { taskId: mission.id, missionId: mission.id };
    }
    // Standard/fast: the existing single path — persistent queue task.
    const task = queue.enqueue({
      objective: directive.goal,
      priority: directive.priority,
      directive: {
        id: directive.id,
        complexity: directive.complexity,
        reason: directive.reason,
        successCondition: directive.successCondition,
        source: directive.source,
      },
    });
    scheduler.pump();
    return { taskId: task.id };
  },
  hasConversationHistory: () => sessionState.getHistory().length > 0,
  emit: broadcast,
});
// Mission-store changes flow through the scheduler's emit (emitAll), so
// the engine receives real 'mission-progress' events via the same hub.

/** The device's persistent public identity (BLX-BODY-…). */
function deviceIdentity() {
  return loadOrCreateIdentity({
    filePath: dataPath('body-identity.json'),
    role: 'body',
    name: process.env.BLAXIN_BODY_NAME || 'Blaxin Body',
  });
}

/** Reply to a deterministic /command with a real agent-message event. */
function handleCommand(cmd: { command: string; args: Record<string, unknown> }, ws: WebSocket): void {
  const reply = (content: string) => {
    ws.send(JSON.stringify({
      event: 'agent-message',
      data: {
        id: `cmd_${Date.now().toString(36)}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
    }));
  };

  switch (cmd.command) {
    case 'help':
      return reply(commandHelpText());
    case 'version':
      return reply(`BLAXIN ${APP_VERSION} — Jarvis build`);
    case 'stop':
      if (!isExternalMode()) scheduler.stop();
      return reply('Stopping the current task...');
    case 'clear':
      if (!isExternalMode()) scheduler.clearHistory();
      return reply('Conversation cleared. Memory and missions are kept.');
    case 'status': {
      const activeProvider = providers.getActiveProvider();
      const activeModel = providers.getActiveModel();
      const queued = queue.list().filter((t) => t.status === 'queued').length;
      const activeMissions = missions.list().filter((m) => m.status === 'running' || m.status === 'queued').length;
      const lines = [
        `AGENT STATE: ${orchestrator.getState().toUpperCase()}`,
        `MODEL: ${activeProvider && activeModel ? `${activeProvider} / ${activeModel}` : 'none configured'}`,
        `QUEUE: ${queued} queued task(s)`,
        `MISSIONS: ${activeMissions} active`,
        `MODE: ${BRAIN_MODE}`,
        `DEVICE: ${deviceIdentity().id}`,
      ];
      return reply(lines.join('\n'));
    }
    case 'memory': {
      const query = typeof cmd.args.query === 'string' && cmd.args.query ? cmd.args.query : undefined;
      const entries = memoryStore.search(query);
      if (entries.length === 0) return reply('Memory is empty.');
      const lines = entries.slice(-8).map((e) => `- [${e.type}] ${e.content}`);
      return reply(`MEMORY (${entries.length} matching):\n${lines.join('\n')}`);
    }
    case 'queue': {
      const tasks = queue.list();
      if (tasks.length === 0) return reply('The task queue is empty.');
      const lines = tasks.slice(-10).map((t) => `- #${t.id} [${t.status}] (p${t.priority}) ${t.objective.slice(0, 60)}`);
      return reply(`TASK QUEUE (${tasks.length}):\n${lines.join('\n')}`);
    }
    case 'missions': {
      const all = missions.list();
      if (all.length === 0) return reply('No missions yet. Create one with /mission-new <objective> | <step1> | <step2>.');
      const lines = all.slice(-8).map((m) => {
        const done = m.steps.filter((s) => s.status === 'completed').length;
        return `- ${m.id} [${m.status}] ${Math.round(m.progress * 100)}% (${done}/${m.steps.length}) ${m.objective.slice(0, 60)}`;
      });
      return reply(`MISSIONS (${all.length}):\n${lines.join('\n')}`);
    }
    case 'mission-new': {
      try {
        const mission = missions.create({
          objective: typeof cmd.args.objective === 'string' ? cmd.args.objective : '',
          steps: Array.isArray(cmd.args.steps) ? (cmd.args.steps as string[]) : undefined,
        });
        scheduler.pump();
        return reply(`Mission created: ${mission.id}\nObjective: ${mission.objective}\nSteps: ${mission.steps.length}\nProgress starts at checkpoint 0 and each completed step is checkpointed.`);
      } catch (error: any) {
        return reply(`Could not create mission: ${error.message}`);
      }
    }
    default:
      return reply(`Unknown command. ${commandHelpText()}`);
  }
}

/** PEM bundle of the CA that signed the Brain's TLS certificate
 * (BLAXIN_BRAIN_CA_FILE). Remote WSS Brains with a private/self-signed
 * certificate are verified against this — certificates are never skipped. */
function brainCaPem(): string | undefined {
  const file = process.env.BLAXIN_BRAIN_CA_FILE;
  if (!file || !file.trim()) return undefined;
  try {
    return readFileSync(file.trim(), 'utf8');
  } catch (error: any) {
    logger.warn('security', `Cannot read BLAXIN_BRAIN_CA_FILE "${file}": ${error.message}`);
    return undefined;
  }
}

/** Explicit development override: allow plaintext ws:// to non-loopback
 * Brains and skip TLS verification (BLAXIN_BRAIN_ALLOW_INSECURE=1). */
function brainAllowInsecure(): boolean {
  return process.env.BLAXIN_BRAIN_ALLOW_INSECURE === '1';
}

/** Lazily build the external-Brain driver (body identity + link). */
function getRemoteBrain(): RemoteBrainDriver | null {
  if (BRAIN_MODE !== 'external') return null;
  if (!remoteBrain) {
    const identity = loadOrCreateIdentity({
      filePath: dataPath('body-identity.json'),
      role: 'body',
      name: process.env.BLAXIN_BODY_NAME || 'Blaxin Body',
    });
    remoteBrain = new RemoteBrainDriver({
      identity,
      url: BRAIN_URL || 'ws://127.0.0.1:3100/ws/brain',
      ca: brainCaPem(),
      allowInsecure: brainAllowInsecure(),
      onEvent: broadcast,
    });
    // Auto-connect at boot only when a Brain URL was configured (the
    // pairing code, if any, is supplied later through /api/brain/connect).
    if (BRAIN_URL) {
      remoteBrain.connect();
    }
  }
  return remoteBrain;
}

function isExternalMode(): boolean {
  return BRAIN_MODE === 'external';
}

/** (Re)point the remote-Brain driver at a new Brain URL and connect.
 * Used by /api/brain/connect when the operator changes the Brain. */
function reconnectRemoteBrain(url: string, code?: string): void {
  if (BRAIN_MODE !== 'external') return;
  remoteBrain?.disconnect();
  const identity = loadOrCreateIdentity({
    filePath: dataPath('body-identity.json'),
    role: 'body',
    name: process.env.BLAXIN_BODY_NAME || 'Blaxin Body',
  });
  remoteBrain = new RemoteBrainDriver({
    identity,
    url,
    ca: brainCaPem(),
    allowInsecure: brainAllowInsecure(),
    onEvent: broadcast,
  });
  remoteBrain.connect(code);
}

const PORT = parseInt(process.env.PORT || '3001');
const HOST = process.env.BLAXIN_HOST || '0.0.0.0';
const EXTRA_ALLOWED_ORIGINS = getAllowedOriginsFromEnv();

// ── Local model runtime + OCI cloud (infrastructure) ───────────
const ollamaRuntime = new OllamaRuntime();
const ociProvider = new OciCloudProvider();
const deploymentEngine = new DeploymentEngine({
  provider: ociProvider,
  // The reverse tunnel: cloud instances dial back to THIS machine. When
  // BLAXIN_TUNNEL_HOST is unset the engine fails deployments honestly.
  brainSshHost: process.env.BLAXIN_TUNNEL_HOST || '',
  brainSshPort: Number(process.env.BLAXIN_TUNNEL_PORT || 22),
  tunnelPort: Number(process.env.BLAXIN_TUNNEL_LOCAL_PORT || 12345),
  resolveImageId: (arch) => resolveOciPlatformImageId(arch),
});

/** Point the Ollama provider at a loopback endpoint (loopback-only guard
 * lives in the provider itself). Used by cloud deployments once their
 * tunneled endpoint is verified. */
function setOllamaEndpoint(endpoint: string): boolean {
  const ollama = providers.getProvider('ollama') as unknown as { setEndpoint?(e: string): boolean };
  return typeof ollama?.setEndpoint === 'function' ? ollama.setEndpoint(endpoint) : false;
}

/** Make Ollama the active provider (and optionally the active model). */
function activateOllamaModel(modelId?: string): void {
  providers.setActiveProvider('ollama');
  if (modelId) providers.setActiveModel(modelId);
}

const app = express();

// CORS: allow only trusted origins (see utils/security.ts). Browsers from
// other origins cannot send state-changing requests or read responses.
app.use(cors({ origin: corsOriginValidator(EXTRA_ALLOWED_ORIGINS) }));
app.use(express.json({ limit: '5mb' }));

// Belt-and-braces origin check for state-changing requests (the CORS layer
// stops browsers from reading responses, this stops the request itself).
// See isStateChangingRequestAllowed in utils/security.ts for the policy.
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (isStateChangingRequestAllowed(req.method, origin, EXTRA_ALLOWED_ORIGINS)) {
    return next();
  }
  logger.warn('security', `Blocked ${req.method} ${req.path} from origin ${origin || '(none)'}`);
  securityLog.record('origin', `Blocked ${req.method} ${req.path} from origin ${origin || '(none)'}`);
  res.status(403).json({ error: 'Origin not allowed' });
});

// Infrastructure: local models, resource inventory, recommendations,
// runtime lifecycle and OCI cloud/deployments. Mounted behind the
// origin guard above (state-changing calls are rejected from untrusted
// browser origins).
app.use('/api', createInfrastructureRouter({
  runtime: ollamaRuntime,
  cloud: ociProvider,
  deployments: deploymentEngine,
  tunnel: {
    host: process.env.BLAXIN_TUNNEL_HOST || '',
    port: Number(process.env.BLAXIN_TUNNEL_PORT || 22),
    localPort: Number(process.env.BLAXIN_TUNNEL_LOCAL_PORT || 12345),
  },
  setOllamaEndpoint,
  activateOllamaModel,
}));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: APP_VERSION, uptime: process.uptime() });
});

// Version & Update check
app.get('/api/version', (_req, res) => {
  res.json({ version: APP_VERSION, repo: GITHUB_REPO });
});

app.get('/api/update/check', async (_req, res) => {
  try {
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: { 'User-Agent': `BLAXIN/${APP_VERSION}` },
    });
    
    if (!response.ok) {
      return res.json({ updateAvailable: false, error: 'Failed to check for updates' });
    }
    
    const release = await response.json() as any;
    const latestVersion = (release.tag_name || '').replace(/^v/, '');

    // Semantic comparison: an update is only offered when the remote
    // release is strictly newer than the running version (a local build
    // that is ahead of the last tag must not be told to "downgrade").
    const updateAvailable = !!latestVersion && isVersionNewer(latestVersion, APP_VERSION);
    const majorUpdate = updateAvailable && isMajorVersionUpgrade(latestVersion, APP_VERSION);
    
    // Find Linux assets (AppImage, .deb, .sig)
    const allAssets = release.assets || [];
    const linuxAssets = allAssets.filter((a: any) => 
      a.name?.endsWith('.AppImage') || a.name?.endsWith('.deb') || 
      a.name?.endsWith('.AppImage.tar.gz') || a.name?.endsWith('.sig')
    );
    
    // Find the primary download (AppImage preferred, then .deb)
    const appimage = linuxAssets.find((a: any) => a.name?.endsWith('.AppImage'));
    const deb = linuxAssets.find((a: any) => a.name?.endsWith('.deb'));
    const primaryDownload = appimage || deb;
    
    res.json({
      updateAvailable,
      currentVersion: APP_VERSION,
      latestVersion,
      majorUpdate,
      releaseName: release.name || `v${latestVersion}`,
      releaseNotes: release.body || '',
      releaseDate: release.published_at || '',
      releaseUrl: release.html_url || '',
      downloadUrl: primaryDownload?.browser_download_url || release.html_url || '',
      assets: linuxAssets.map((a: any) => ({
        name: a.name,
        size: a.size,
        downloadUrl: a.browser_download_url,
        contentType: a.content_type,
      })),
    });
  } catch (error: any) {
    logger.error('update', 'Failed to check for updates', error);
    res.json({ updateAvailable: false, error: error.message });
  }
});

// Performance metrics (persisted ring of completed tasks). The task
// list is bounded (?n= is clamped) and user prompts are never exposed.
app.get('/api/metrics', (req, res) => {
  const n = parseMetricsLimit(req.query.n);
  res.json({
    summary: telemetry.summary(n),
    tasks: telemetry.latest(n).map((t) => ({ ...t, message: undefined })),
  });
});

// Live system telemetry (real CPU/RAM/disk/uptime — see system-telemetry.ts)
app.get('/api/system/telemetry', async (_req, res) => {
  try {
    res.json(await getSystemTelemetry());
  } catch (error: any) {
    logger.error('telemetry', `Failed to read system telemetry: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Live network throughput (real /proc/net/dev deltas)
app.get('/api/agency', (_req, res) => {
  res.json(agency.snapshot());
});

app.get('/api/system/network', (_req, res) => {
  try {
    res.json(getNetworkTelemetry());
  } catch (error: any) {
    logger.error('telemetry', `Failed to read network telemetry: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Diagnostics
app.get('/api/diagnostics', async (_req, res) => {
  try {
    const result = await runDiagnostics();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Provider endpoints
app.get('/api/providers', (_req, res) => {
  const status = providers.getStatus();
  res.json(status);
});

app.post('/api/providers/:id/validate', async (req, res) => {
  const { id } = req.params;
  const { apiKey } = req.body;
  try {
    const result = await providers.validateKey(id as ProviderId, apiKey);
    res.json(result);
  } catch (error: any) {
    res.json({ valid: false, error: error.message, code: 'UNKNOWN' });
  }
});

app.post('/api/providers/:id/save-key', async (req, res) => {
  const { id } = req.params;
  const { apiKey, skipValidation } = req.body || {};
  try {
    const result = await providers.saveKey(id as ProviderId, apiKey, {
      skipValidation: skipValidation === true,
    });
    if (result.valid !== false) {
      securityLog.record('credentials', `API key saved for ${id}`);
    }
    res.json(result);
  } catch (error: any) {
    res.json({ valid: false, error: error.message, code: 'UNKNOWN' });
  }
});

app.delete('/api/providers/:id/key', (req, res) => {
  const { id } = req.params;
  providers.removeKey(id as ProviderId);
  securityLog.record('credentials', `API key removed for ${id}`);
  res.json({ success: true });
});

app.get('/api/providers/:id/models', async (req, res) => {
  const { id } = req.params;
  try {
    const models = await providers.fetchModels(id as ProviderId);
    res.json(models);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/models', async (_req, res) => {
  try {
    const models = await providers.fetchAllAvailableModels();
    res.json(models);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/models/active', (req, res) => {
  const { providerId, modelId } = req.body;
  if (providerId) providers.setActiveProvider(providerId);
  if (modelId) providers.setActiveModel(modelId);
  res.json({ 
    success: true, 
    activeProvider: providers.getActiveProvider(),
    activeModel: providers.getActiveModel(),
  });
});

// Tool endpoints
app.get('/api/tools', (_req, res) => {
  const tools = toolRegistry.getAllTools().map(t => ({
    name: t.name,
    description: t.description,
  }));
  res.json(tools);
});

app.get('/api/tools/status', (_req, res) => {
  res.json(toolRegistry.getEnabledStatus());
});

app.post('/api/tools/:name/toggle', (req, res) => {
  const { name } = req.params;
  const { enabled } = req.body;
  toolRegistry.setEnabled(name, enabled);
  res.json({ success: true, enabled });
});

// Config endpoints
app.get('/api/config', (_req, res) => {
  res.json(loadConfig());
});

app.put('/api/config', (req, res) => {
  const config = req.body as AppConfig;
  saveConfig(config);
  res.json({ success: true });
});

// Agent endpoints
app.post('/api/agent/message', async (req, res) => {
  const { message } = req.body;
  if (!isValidUserMessage(message)) {
    return res.status(400).json({ error: 'Message is required', code: 'EMPTY_MESSAGE' });
  }
  
  // Start processing in background, WebSocket will deliver updates
  if (isExternalMode()) {
    const brain = getRemoteBrain();
    if (!brain) return res.status(409).json({ error: 'External mode is not enabled', code: 'MODE' });
    brain.sendUserMessage(normalizeUserMessage(message));
    return res.json({ success: true, mode: 'external' });
  }
  orchestrator.processMessage(message).catch(err => {
    logger.error('api', 'Agent processing failed', err);
  });
  
  res.json({ success: true, taskId: orchestrator.getCurrentTask()?.id });
});

app.post('/api/agent/stop', (_req, res) => {
  if (isExternalMode()) {
    getRemoteBrain()?.stopTask();
    return res.json({ success: true, mode: 'external' });
  }
  orchestrator.stop();
  res.json({ success: true });
});

app.post('/api/agent/clear', (_req, res) => {
  if (isExternalMode()) {
    getRemoteBrain()?.clearHistory();
    return res.json({ success: true, mode: 'external' });
  }
  orchestrator.clearHistory();
  res.json({ success: true });
});

app.get('/api/agent/history', (_req, res) => {
  if (isExternalMode()) {
    return res.json([]); // conversation history lives on the Brain
  }
  res.json(orchestrator.getConversationHistory());
});

// ── Brain connection endpoints (external mode) ─────────────────
app.get('/api/brain/status', (_req, res) => {
  const brain = getRemoteBrain();
  res.json({
    mode: BRAIN_MODE,
    bodyId: brain?.status().bodyId ?? null,
    ...(brain ? brain.status() : {}),
  });
});

// Connect (optionally pairing with a fresh code) to a Brain.
app.post('/api/brain/connect', (req, res) => {
  if (!isExternalMode()) {
    return res.status(409).json({ error: 'External Brain mode is disabled (BLAXIN_BRAIN_MODE=external).', code: 'MODE_EMBEDDED' });
  }
  const { url, code } = req.body || {};
  if (typeof url === 'string' && url.trim()) {
    const parsedUrl = url.trim().replace(/\/+$/, '');
    // Transport policy: non-loopback Brains must be reached over wss
    // (unless BLAXIN_BRAIN_ALLOW_INSECURE=1 is set for development). This
    // rejects plaintext-to-remote up front with actionable guidance.
    const verdict = validateBrainUrl(parsedUrl, { allowInsecure: brainAllowInsecure() });
    if (!verdict.ok) {
      return res.status(400).json({ error: verdict.error, code: verdict.code });
    }
    // Point the driver at a new Brain (fresh RemoteBrainDriver).
    reconnectRemoteBrain(parsedUrl, typeof code === 'string' ? code : undefined);
  } else {
    getRemoteBrain()?.connect(typeof code === 'string' ? code : undefined);
  }
  res.json({ success: true });
});

app.post('/api/brain/disconnect', (_req, res) => {
  if (!isExternalMode()) return res.status(409).json({ error: 'Not in external mode', code: 'MODE_EMBEDDED' });
  getRemoteBrain()?.disconnect();
  res.json({ success: true });
});

app.post('/api/brain/reconnect', (_req, res) => {
  if (!isExternalMode()) return res.status(409).json({ error: 'Not in external mode', code: 'MODE_EMBEDDED' });
  const brain = getRemoteBrain();
  if (brain) {
    brain.disconnect();
    brain.connect();
  }
  res.json({ success: true });
});

// Forget the saved Brain pairing on this Body (does not touch the Brain).
app.post('/api/brain/unpair', (_req, res) => {
  if (!isExternalMode()) return res.status(409).json({ error: 'Not in external mode', code: 'MODE_EMBEDDED' });
  const brain = getRemoteBrain();
  if (brain) {
    brain.disconnect();
    brain.forgetPairing();
  }
  res.json({ success: true });
});

// ── Jarvis: task queue endpoints ─────────────────────────────
app.get('/api/queue', (_req, res) => {
  res.json({ tasks: queue.list() });
});

app.post('/api/queue', (req, res) => {
  const { objective, priority } = req.body || {};
  if (typeof objective !== 'string' || !objective.trim()) {
    return res.status(400).json({ error: 'objective is required', code: 'EMPTY_MESSAGE' });
  }
  const task = queue.enqueue({
    objective: objective.trim(),
    priority: typeof priority === 'number' ? priority : undefined,
  });
  scheduler.pump();
  res.json({ success: true, task });
});

app.post('/api/queue/:id/cancel', (req, res) => {
  const ok = queue.cancel(req.params.id);
  res.json({ success: ok });
});

app.post('/api/queue/:id/pause', (req, res) => {
  const ok = queue.pause(req.params.id);
  res.json({ success: ok });
});

app.post('/api/queue/:id/resume', (req, res) => {
  const ok = queue.resume(req.params.id);
  if (ok) scheduler.pump();
  res.json({ success: ok });
});

app.delete('/api/queue/:id', (req, res) => {
  res.json({ success: queue.remove(req.params.id) });
});

// ── Jarvis: mission endpoints ─────────────────────────────────
app.get('/api/missions', (_req, res) => {
  res.json({ missions: missions.list() });
});

app.get('/api/missions/:id', (req, res) => {
  const mission = missions.get(req.params.id);
  if (!mission) return res.status(404).json({ error: 'Mission not found', code: 'NOT_FOUND' });
  res.json({ mission });
});

app.post('/api/missions', (req, res) => {
  const { objective, description, steps, priority } = req.body || {};
  if (typeof objective !== 'string' || !objective.trim()) {
    return res.status(400).json({ error: 'objective is required', code: 'EMPTY_MESSAGE' });
  }
  const mission = missions.create({
    objective: objective.trim(),
    description: typeof description === 'string' ? description : undefined,
    steps: Array.isArray(steps) ? (steps as string[]) : undefined,
    priority: typeof priority === 'number' ? priority : undefined,
  });
  scheduler.pump();
  res.json({ success: true, mission });
});

app.post('/api/missions/:id/pause', (req, res) => {
  res.json({ success: missions.pause(req.params.id) });
});

app.post('/api/missions/:id/resume', (req, res) => {
  const ok = missions.resume(req.params.id);
  if (ok) scheduler.pump();
  res.json({ success: ok });
});

app.post('/api/missions/:id/cancel', (req, res) => {
  res.json({ success: missions.cancel(req.params.id) });
});

app.post('/api/missions/:id/retry', (req, res) => {
  const ok = missions.retry(req.params.id);
  if (ok) scheduler.pump();
  res.json({ success: ok });
});

app.delete('/api/missions/:id', (req, res) => {
  res.json({ success: missions.remove(req.params.id) });
});

app.get('/api/jarvis/state', (_req, res) => {
  res.json(jarvisHost.snapshot());
});

app.get('/api/security/events', (req, res) => {
  const limit = parseInt(String(req.query.limit || '50'), 10);
  res.json({ events: securityLog.list(Number.isFinite(limit) ? limit : 50) });
});

app.get('/api/status', (_req, res) => {
  const providerStatus = providers.getStatus();
  const keysConfigured = providerStatus.filter((p: any) => p.hasKey).length;
  res.json({
    version: APP_VERSION,
    mode: BRAIN_MODE,
    deviceId: deviceIdentity().id,
    uptime: process.uptime(),
    state: orchestrator.getState(),
    activeProvider: providers.getActiveProvider(),
    activeModel: providers.getActiveModel(),
    providers: providerStatus.map((p: any) => ({ id: p.id, hasKey: p.hasKey })),
    security: {
      encryption: 'AES-256-CBC',
      keysConfigured,
      originPolicy: 'local-origins-only',
    },
    queue: { count: queue.list().length },
    missions: { count: missions.list().length },
    tools: { count: toolRegistry.getAllTools().length },
  });
});

// Memory endpoints
app.get('/api/memory', (req, res) => {
  const query = (req.query.q as string) || undefined;
  const type = (req.query.type as string) || undefined;
  const entries = memoryStore.search(query, (type as any) || undefined);
  res.json(entries);
});

// Explicitly store a durable note (preference/fact/project/lesson). The
// store refuses secret-like content and never persists credentials.
app.post('/api/memory', (req, res) => {
  const { type, content, source, scope } = (req.body || {}) as Record<string, unknown>;
  const types: MemoryType[] = ['preference', 'fact', 'project', 'action-result'];
  if (typeof type !== 'string' || !types.includes(type as MemoryType)) {
    return res.status(400).json({ error: 'type must be one of preference, fact, project, action-result', code: 'BAD_TYPE' });
  }
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text || text.length > 2000) {
    return res.status(400).json({ error: 'content must be a non-empty string of at most 2000 characters', code: 'BAD_CONTENT' });
  }
  if (source !== undefined && source !== 'user' && source !== 'agent' && source !== 'system') {
    return res.status(400).json({ error: 'source must be user, agent or system', code: 'BAD_SOURCE' });
  }
  const cleanScope = typeof scope === 'string' && scope.trim() ? scope.trim().slice(0, 80) : undefined;

  if (looksSensitive(text)) {
    return res.status(422).json({
      error: 'That content looks like a secret (API key / token / private key) and was not stored.',
      code: 'SECRET_REFUSED',
    });
  }

  const entry = memoryStore.add(type as MemoryType, text, {
    source: (source as MemoryEntry['source']) || 'user',
    scope: cleanScope,
  });
  res.json({ success: true, entry });
});

app.delete('/api/memory/:id', (req, res) => {
  const removed = memoryStore.remove(req.params.id);
  res.json({ success: removed });
});

app.delete('/api/memory', (_req, res) => {
  memoryStore.clear();
  res.json({ success: true });
});

// Layered memory (§20+): the persistent failure/environment/episode/
// procedure stores, surfaced for INSPECTION (memory must be inspectable
// and governable — never a hidden influence).
app.get('/api/memory/layers', (_req, res) => {
  res.json(memoryLayers.snapshot());
});

app.delete('/api/memory/layers/:kind/:id', (req, res) => {
  const kinds = ['failure', 'environment', 'episode', 'procedure'] as const;
  const kind = kinds.find((k) => k === req.params.kind);
  if (!kind) {
    return res.status(400).json({ error: 'kind must be one of failure, environment, episode, procedure', code: 'BAD_KIND' });
  }
  const removed = memoryLayers.remove(kind, String(req.params.id || ''));
  if (!removed) return res.status(404).json({ error: 'record not found', code: 'NOT_FOUND' });
  res.json({ success: true });
});

app.delete('/api/memory/layers', (_req, res) => {
  const snap = memoryLayers.snapshot();
  for (const [kind, records] of [
    ['failure', snap.failures],
    ['environment', snap.environment],
    ['episode', snap.episodes],
    ['procedure', snap.procedures],
  ] as const) {
    for (const r of records) memoryLayers.remove(kind, r.id);
  }
  res.json({ success: true });
});

// JSON body / route error handling — always respond in JSON, never leak stacks.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed JSON body', code: 'BAD_JSON' });
  }
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    return res.status(413).json({ error: 'Request body too large', code: 'BODY_TOO_LARGE' });
  }
  const status = err?.status || err?.statusCode;
  if (status && status >= 400 && status < 500) {
    return res.status(status).json({ error: err.message || 'Bad request', code: 'BAD_REQUEST' });
  }
  logger.error('api', 'Unhandled request error', err);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
});

// 404 handler — unknown API paths return JSON, not HTML.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
});

// Create HTTP server
const server = createServer(app);

// WebSocket servers are upgrade-routed so we can validate the Origin of
// every connection BEFORE the 101 Switching Protocols handshake completes.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 10 * 1024 * 1024 });
const terminalWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 5 * 1024 * 1024 });

function handleUpgrade(
  target: WebSocketServer,
  request: import('http').IncomingMessage,
  socket: import('stream').Duplex,
  head: Buffer,
  label: string,
): void {
  const origin = (request.headers.origin as string | undefined) || undefined;
  if (!isOriginAllowed(origin, EXTRA_ALLOWED_ORIGINS)) {
    logger.warn('security', `Blocked ${label} WebSocket upgrade from origin ${origin || '(none)'}`);
    securityLog.record('transport', `Blocked ${label} WebSocket upgrade from origin ${origin || '(none)'}`);
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  target.handleUpgrade(request, socket, head, (ws) => {
    target.emit('connection', ws, request);
  });
}

server.on('upgrade', (request, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(request.url || '/', 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname === '/ws') {
    handleUpgrade(wss, request, socket, head, 'agent');
  } else if (pathname === '/ws/terminal') {
    handleUpgrade(terminalWss, request, socket, head, 'terminal');
  } else {
    socket.destroy();
  }
});

// Broadcast agent events to ALL connected clients. The event source is
// either the local orchestrator (embedded mode) or the remote Brain
// driver (external mode) — the wire format is identical.
function broadcast(event: string, data: unknown): void {
  const message = JSON.stringify({ event, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

orchestrator.setEventCallback((event, data) => {
  // One path: broadcast + all hub subscribers (Jarvis engine) see the
  // same real events. The scheduler keeps its explicit settlement hook.
  emitAll(event, data);
  if (!isExternalMode()) scheduler.onOrchestratorEvent(event, data);
});

securityLog.onChange((events) => broadcast('security-events', { events }));

// Browser-session lifecycle is REAL state (§22/§23): desyncs and losses
// are surfaced so the HUD shows the true connection state — never a
// fabricated healthy browser.
browserSession.setEventListener((event) => {
  // Through the real event hub (broadcast + Jarvis): a desync is a real
  // runtime transition the executive state must reflect (§5).
  emitAll('browser-session', { event, session: browserSession.snapshot() });
});

wss.on('connection', (ws) => {
  logger.info('websocket', 'Client connected');

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      switch (msg.type) {
        case 'user-message': {
          const content = msg.data?.content;
          if (!isValidUserMessage(content)) {
            ws.send(JSON.stringify({
              event: 'error',
              data: { message: 'Message content is required.', code: 'EMPTY_MESSAGE' },
            }));
            break;
          }
          if (isExternalMode()) {
            getRemoteBrain()?.sendUserMessage(normalizeUserMessage(content));
          } else {
            // Commands run deterministically (no LLM). Everything else
            // goes through JARVIS: intent assessment → structured
            // directive → queue/mission routing → honest reporting.
            const text = normalizeUserMessage(content);
            const cmd = classifyCommand(text);
            if (cmd) {
              handleCommand(cmd, ws);
            } else {
              try {
                jarvisHost.receiveCommand({ message: text, source: 'text' });
              } catch (error: any) {
                ws.send(JSON.stringify({
                  event: 'error',
                  data: { message: error.message, code: 'JARVIS_ERROR' },
                }));
              }
            }
          }
          break;
        }
        case 'command': {
          // Explicit command message — the client routes slash-commands
          // here with the raw text (e.g. "/mission-new fix | test").
          const cmd = classifyCommand(typeof msg.data?.text === 'string' ? msg.data.text : '');
          if (cmd) handleCommand(cmd, ws);
          break;
        }
        case 'queue-enqueue': {
          const text = typeof msg.data?.objective === 'string' ? msg.data.objective.trim() : '';
          if (!text) {
            ws.send(JSON.stringify({ event: 'error', data: { message: 'Queue objective is required.', code: 'EMPTY_MESSAGE' } }));
            break;
          }
          const task = queue.enqueue({
            objective: text,
            priority: typeof msg.data?.priority === 'number' ? msg.data.priority : undefined,
          });
          scheduler.pump();
          ws.send(JSON.stringify({ event: 'queue-task', data: { task } }));
          break;
        }
        case 'queue-cancel':
          queue.cancel(msg.data?.id);
          break;
        case 'queue-pause':
          queue.pause(msg.data?.id);
          break;
        case 'queue-resume':
          queue.resume(msg.data?.id);
          scheduler.pump();
          break;
        case 'mission-create': {
          try {
            const mission = missions.create({
              objective: typeof msg.data?.objective === 'string' ? msg.data.objective : '',
              description: typeof msg.data?.description === 'string' ? msg.data.description : undefined,
              steps: Array.isArray(msg.data?.steps) ? (msg.data.steps as string[]) : undefined,
              priority: typeof msg.data?.priority === 'number' ? msg.data.priority : undefined,
            });
            ws.send(JSON.stringify({ event: 'mission-created', data: { mission } }));
            scheduler.pump();
          } catch (error: any) {
            ws.send(JSON.stringify({ event: 'error', data: { message: error.message, code: 'BAD_MISSION' } }));
          }
          break;
        }
        case 'mission-pause':
          missions.pause(msg.data?.id);
          break;
        case 'mission-resume':
          missions.resume(msg.data?.id);
          scheduler.pump();
          break;
        case 'mission-cancel':
          missions.cancel(msg.data?.id);
          break;
        case 'mission-retry':
          missions.retry(msg.data?.id);
          scheduler.pump();
          break;
        case 'mission-delete':
          missions.remove(msg.data?.id);
          break;
        case 'stop':
          if (isExternalMode()) {
            getRemoteBrain()?.stopTask();
          } else {
            orchestrator.stop();
          }
          break;
        case 'clear':
          if (isExternalMode()) {
            getRemoteBrain()?.clearHistory();
          } else {
            orchestrator.clearHistory();
          }
          break;
        case 'ping':
          ws.send(JSON.stringify({ event: 'pong', data: { timestamp: Date.now() } }));
          break;
        case 'confirmation-response': {
          // The user may scope their approval: once (default), the rest of
          // the task, or the rest of the session. Anything unexpected is
          // treated as a plain one-shot approval.
          const scope = msg.data?.scope === 'task' || msg.data?.scope === 'session'
            ? msg.data.scope
            : 'once';
          if (isExternalMode()) {
            getRemoteBrain()?.respondToConfirmation(msg.data?.stepId, msg.data?.approved === true, scope);
          } else {
            orchestrator.respondToConfirmation(msg.data?.stepId, msg.data?.approved === true, scope);
          }
          break;
        }
      }
    } catch (error: any) {
      logger.error('websocket', 'Message handling error', error);
      ws.send(JSON.stringify({ 
        event: 'error', 
        data: { message: 'Invalid message format' } 
      }));
    }
  });

  ws.on('close', () => {
    logger.info('websocket', 'Client disconnected');
  });

  // Send initial state. The client mirrors this snapshot into its Brain
  // panel, so the payload matches the REST /api/brain/status shape
  // (mode + bodyId + the inner BrainLinkStatus object) — never the full
  // driver status wrapper nested one level too deep.
  const brain = getRemoteBrain();
  const connectedPayload: Record<string, unknown> = {
    state: orchestrator.getState(),
    activeProvider: providers.getActiveProvider(),
    activeModel: providers.getActiveModel(),
    description: orchestrator.getCurrentDescription(),
    mode: BRAIN_MODE,
    deviceId: deviceIdentity().id,
  };
  // Send the authoritative queue/mission/security snapshots on connect so
  // the HUD panels render real state immediately (no polling race).
  ws.send(JSON.stringify({ event: 'queue-updated', data: { tasks: queue.list() } }));
  ws.send(JSON.stringify({ event: 'mission-progress', data: { missions: missions.list() } }));
  ws.send(JSON.stringify({ event: 'security-events', data: { events: securityLog.list(50) } }));
  // Jarvis snapshot: phase + last honest report (never stale HUD state).
  ws.send(JSON.stringify({ event: 'jarvis-state', data: jarvisHost.snapshot() }));
  // Agency snapshot: the real worker roster at connect time.
  ws.send(JSON.stringify({ event: 'agency-updated', data: agency.snapshot() }));
  if (isExternalMode() && brain) {
    connectedPayload.bodyId = brain.status().bodyId;
    connectedPayload.brain = brain.status().brain ?? null;
  } else {
    connectedPayload.bodyId = null;
    connectedPayload.brain = null;
  }
  ws.send(JSON.stringify({
    event: 'connected',
    data: connectedPayload,
  }));
});

// Handle terminal WebSocket connections
terminalWss.on('connection', (ws) => {
  logger.info('terminal-ws', 'Terminal client connected');
  handleTerminalWebSocket(ws);
});

// Fail loudly and exit when the port is already in use or binding fails,
// instead of lingering as a zombie process.
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.error('server', `Port ${PORT} is already in use. Is another BLAXIN instance running?`);
  } else {
    logger.error('server', `Failed to start server: ${error.message}`);
  }
  process.exit(1);
});

// Start server
server.listen(PORT, HOST, async () => {
  logger.info('server', `BLAXIN server running on http://${HOST}:${PORT}`);
  
  // Initialize providers
  await providers.initializeAll();
  
  // Resume interrupted cloud deployments (restart-safe: each failure is
  // recorded honestly; non-idempotent steps are never replayed).
  void Promise.allSettled(deploymentEngine.resumeAll());
  
  // Start session state auto-save
  sessionState.startAutoSave();
  
  // Send ready event to any connected clients
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event: 'ready', data: {} }));
    }
  });
});

// Graceful shutdown
const shutdown = () => {
  logger.info('server', 'Shutting down...');
  sessionState.stopAutoSave();
  // Drop the Brain connection cleanly (no auto-reconnect during exit).
  remoteBrain?.disconnect();
  // Persist any unflushed telemetry (best-effort sync flush — this is the
  // shutdown path, not the agent hot path).
  telemetry.flushSync();
  // Kill any live terminal shells (and their children) so no processes
  // survive the backend exit.
  terminateAllSessions();
  wss.clients.forEach(client => {
    try { client.close(1001, 'Server shutting down'); } catch {}
  });
  terminalWss.clients.forEach(client => {
    try { client.close(1001, 'Server shutting down'); } catch {}
  });
  wss.close();
  terminalWss.close();
  server.close(() => {
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// Prevent crashes from unhandled errors
process.on('uncaughtException', (error) => {
  logger.error('server', 'Uncaught exception', error);
});
process.on('unhandledRejection', (reason) => {
  logger.error('server', 'Unhandled rejection', reason);
});
