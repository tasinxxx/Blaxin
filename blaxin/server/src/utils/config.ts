import { AppConfig } from '../types.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dataPath } from './paths.js';

const CONFIG_FILE = process.env.BLAXIN_CONFIG_FILE
  ? dataPath(process.env.BLAXIN_CONFIG_FILE)
  : dataPath('blaxin-config.json');

// getConfig() is called from the agent hot path (every tool call, every
// loop iteration). Parsing the config file from disk on each call was pure
// synchronous I/O on the critical path, so the parsed result is cached and
// only re-read after a short TTL or when saveConfig() invalidates it.
const CONFIG_CACHE_TTL_MS = 1000;
let cachedConfig: AppConfig | null = null;
let cachedAt = 0;

const defaultConfig: AppConfig = {
  server: {
    port: 3001,
    host: '0.0.0.0',
  },
  agent: {
    maxSteps: 20,
    maxRetries: 3,
    requireConfirmation: true,
    enableFastPath: true,
    enableParallelTools: true,
    // Specialist bounded-objective budgets (§6): how far a delegated
    // specialist may go on its own (actions, recoveries, re-plans, wall
    // clock) before it must settle honestly. Defaults mirror the ledger's
    // DEFAULT_SPECIALIST_CONFIG.
    specialist: {
      maxActions: 16,
      maxRecoveries: 8,
      maxReplans: 1,
      deadlineMs: 300_000,
    },
    // Deterministic recovery ladder budgets (§ recovery): attempts per
    // action, re-plans per task, backoff bounds. Defaults mirror
    // DEFAULT_RECOVERY_CONFIG.
    recovery: {
      maxRecoveryAttempts: 2,
      maxReplansPerTask: 1,
      baseBackoffMs: 300,
      maxBackoffMs: 2000,
    },
    confirmationPatterns: [
      'delete',
      'remove',
      'rm ',
      'drop',
      'send',
      'purchase',
      'pay',
      'transfer',
      'sudo',
      'chmod',
      'format',
    ],
  },
  tools: {
    'computer-control': true,
    'screenshot': true,
    'terminal': true,
    'file-system': true,
    'browser': true,
    'clipboard': true,
    'search': true,
    'system-info': true,
  },
  appearance: {
    theme: 'cyberpunk',
    accentColor: '#00f0ff',
  },
};

export function loadConfig(): AppConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      const stored = JSON.parse(raw);
      // Deep-merge each subsection so a config written by an older
      // BLAXIN version cannot silently drop newer defaults
      // (e.g. agent.requireConfirmation, agent.confirmationPatterns).
      return {
        ...defaultConfig,
        ...stored,
        server: { ...defaultConfig.server, ...(stored.server || {}) },
        agent: {
          ...defaultConfig.agent,
          ...(stored.agent || {}),
          // Budget subsections back-fill per-key so an older config file
          // (or a partial edit) can never silently drop a budget to
          // undefined — the honest defaults stay in force.
          specialist: { ...defaultConfig.agent.specialist, ...(stored.agent?.specialist || {}) },
          recovery: { ...defaultConfig.agent.recovery, ...(stored.agent?.recovery || {}) },
        },
        tools: { ...defaultConfig.tools, ...(stored.tools || {}) },
        appearance: { ...defaultConfig.appearance, ...(stored.appearance || {}) },
      };
    }
  } catch (e) {
    // Fall through to defaults
  }
  return defaultConfig;
}

export function saveConfig(config: AppConfig): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    // Config save failed silently
  }
  // Invalidate immediately so the next getConfig() sees the new values
  // (agent confirmation/step settings must never run stale).
  invalidateConfigCache();
}

/**
 * Cached accessor for the hot path. Falls back to a fresh disk read when
 * the cache is stale or was invalidated by saveConfig().
 */
export function getConfig(): AppConfig {
  const now = Date.now();
  if (cachedConfig && now - cachedAt < CONFIG_CACHE_TTL_MS) {
    return cachedConfig;
  }
  cachedConfig = loadConfig();
  cachedAt = now;
  return cachedConfig;
}

/** Invalidate the cache (call after saveConfig / external edits). */
export function invalidateConfigCache(): void {
  cachedConfig = null;
  cachedAt = 0;
}

/**
 * Case-insensitive substring match against a list of danger patterns.
 * Used to decide whether a terminal command needs user confirmation.
 */
export function matchesAnyPattern(text: string, patterns: string[]): boolean {
  if (!text || !patterns || patterns.length === 0) return false;
  const lowered = text.toLowerCase();
  return patterns.some((p) => p && lowered.includes(p.toLowerCase()));
}
