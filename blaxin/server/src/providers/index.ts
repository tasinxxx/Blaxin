import { ProviderId, ModelInfo } from '../types.js';
import { AIProvider, ProviderError, ProviderHealth } from './base.js';
import { OpenRouterProvider } from './openrouter.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { GroqProvider } from './groq.js';
import { TogetherProvider } from './together.js';
import { OllamaProvider } from './ollama.js';
import { credentialStore } from '../utils/credentials.js';
import { logger } from '../utils/logger.js';

export { AIProvider, ProviderError } from './base.js';

// ── API Key Format Check ────────────────────────────────────────

/**
 * Basic structural validation for an API key. Deliberately permissive:
 * provider keys evolve (OpenRouter sk-or-v1-..., Anthropic sk-ant-...,
 * Google AIza..., Groq gsk_..., OpenAI sk-...). We only reject input that
 * is clearly not a key, so legitimate keys are never refused on format
 * grounds — the provider server is the authority during validation.
 */
export function basicKeyCheck(providerId: ProviderId, rawKey: unknown): { ok: boolean; error?: string } {
  // Local provider: no key required, the "key" field may hold a base URL.
  if (providerId === 'ollama') {
    return { ok: true };
  }

  if (typeof rawKey !== 'string' || rawKey.trim().length === 0) {
    return { ok: false, error: 'API key is required.' };
  }

  const key = rawKey.trim();

  if (key.length < 8) {
    return { ok: false, error: 'The key looks too short to be a valid API key. Check that you copied the whole key.' };
  }
  if (key.length > 1024) {
    return { ok: false, error: 'The key is unusually long. Check that you did not paste extra text.' };
  }
  if (/\s/.test(key)) {
    return { ok: false, error: 'The key contains spaces. API keys do not contain spaces — check that you copied it correctly.' };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    return { ok: false, error: 'The key contains invisible control characters. Paste the key again without extra whitespace.' };
  }

  return { ok: true };
}

// ── Env-Var API Keys (container/web deployments) ───────────────

/**
 * Environment variable name that can supply a provider's API key
 * (see .env.example). The encrypted credential store always takes
 * precedence; the env var is only a fallback during initialization.
 */
export function envVarForProvider(providerId: ProviderId): string | null {
  const mapping: Partial<Record<ProviderId, string>> = {
    'openrouter': 'OPENROUTER_API_KEY',
    'openai': 'OPENAI_API_KEY',
    'anthropic': 'ANTHROPIC_API_KEY',
    'google': 'GOOGLE_API_KEY',
    'groq': 'GROQ_API_KEY',
    'together': 'TOGETHER_API_KEY',
  };
  return mapping[providerId] || null;
}

// ── Fallback Order ──────────────────────────────────────────────

const FALLBACK_ORDER: ProviderId[] = [
  'openrouter', 'openai', 'anthropic', 'google', 'groq', 'together', 'ollama',
];

// ── Health Check Interval ───────────────────────────────────────

const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Provider Registry ───────────────────────────────────────────

class ProviderRegistry {
  private providers: Map<ProviderId, AIProvider> = new Map();
  private modelsCache: Map<ProviderId, ModelInfo[]> = new Map();
  private activeProvider: ProviderId | null = null;
  private activeModel: string | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.register(new OpenRouterProvider());
    this.register(new OpenAIProvider());
    this.register(new AnthropicProvider());
    this.register(new GoogleProvider());
    this.register(new GroqProvider());
    this.register(new TogetherProvider());
    this.register(new OllamaProvider());
  }

  private register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
    logger.info('providers', `Registered provider: ${provider.name}`);
  }

  getProvider(id: ProviderId): AIProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    return provider;
  }

  getAllProviders(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  async initializeAll(): Promise<void> {
    for (const provider of this.providers.values()) {
      try {
        await provider.initialize();

        // Fallback: when no encrypted credential exists, accept a key
        // supplied through the environment (container/web deployments).
        const envKey = envVarForProvider(provider.id);
        if (!provider.hasApiKey() && envKey) {
          const value = process.env[envKey];
          if (value && value.trim()) {
            provider.setApiKey(value.trim());
            logger.info('providers', `API key for ${provider.name} loaded from environment (${envKey})`);
          }
        }
      } catch (error) {
        logger.warn('providers', `Failed to initialize ${provider.name}`, error);
      }
    }

    // Start periodic health checks
    this.startHealthChecks();
  }

  private startHealthChecks(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(async () => {
      for (const provider of this.providers.values()) {
        if (!provider.apiKeyRequired || provider.hasApiKey()) {
          try {
            await provider.healthCheck();
          } catch {}
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    logger.info('providers', 'Periodic health checks enabled');
  }

  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  async validateKey(providerId: ProviderId, apiKey: string): Promise<{ valid: boolean; error?: string; code?: string }> {
    const format = basicKeyCheck(providerId, apiKey);
    if (!format.ok) {
      return { valid: false, error: format.error, code: 'BAD_FORMAT' };
    }
    const provider = this.getProvider(providerId);
    const result = await provider.validateKey(apiKey.trim());
    return { ...result };
  }

  async saveKey(
    providerId: ProviderId,
    apiKey: string,
    options: { skipValidation?: boolean } = {},
  ): Promise<{ valid: boolean; error?: string; code?: string }> {
    const format = basicKeyCheck(providerId, apiKey);
    if (!format.ok) {
      return { valid: false, error: format.error, code: 'BAD_FORMAT' };
    }

    const trimmed = apiKey.trim();

    // Remote validation is the default. `skipValidation` is only honoured
    // for structurally valid keys, and is intended for the case where the
    // provider is unreachable (network failure) — the key still gets
    // verified live the first time it is used.
    if (!options.skipValidation) {
      const validation = await this.validateKey(providerId, trimmed);
      if (!validation.valid) {
        return validation;
      }
    }

    credentialStore.save(providerId, trimmed);
    const provider = this.getProvider(providerId);
    (provider as any).apiKey = trimmed;
    this.availableModelsCache = null;
    logger.info('providers', `API key saved for ${provider.name}`);
    return { valid: true };
  }

  removeKey(providerId: ProviderId): void {
    credentialStore.remove(providerId);
    const provider = this.getProvider(providerId);
    (provider as any).apiKey = null;
    this.availableModelsCache = null;
    logger.info('providers', `API key removed for ${provider.name}`);
  }

  getKeyStatus(): Record<string, { hasKey: boolean; maskedKey?: string }> {
    return credentialStore.getAll();
  }

  async fetchModels(providerId: ProviderId): Promise<ModelInfo[]> {
    const provider = this.getProvider(providerId);
    try {
      const models = await provider.fetchModels();
      this.modelsCache.set(providerId, models);
      this.availableModelsCache = null;
      return models;
    } catch (error: any) {
      logger.error('providers', `Failed to fetch models for ${provider.name}`, error);
      throw error;
    }
  }

  /**
   * Models REALLY available right now across usable providers (10×
   * adaptive routing): keyless providers are skipped, Ollama is always
   * probed, failing providers contribute nothing. Bounded TTL cache so
   * the routing hot path stays light (8GB CPU-only target).
   */
  private availableModelsCache: { models: ModelInfo[]; at: number } | null = null;
  private static readonly AVAILABLE_MODELS_TTL_MS = 60_000;

  async getAvailableModels(): Promise<ModelInfo[]> {
    const cached = this.availableModelsCache;
    if (cached && (Date.now() - cached.at) < ProviderRegistry.AVAILABLE_MODELS_TTL_MS) {
      return cached.models;
    }
    const models = await this.fetchAllAvailableModels();
    this.availableModelsCache = { models, at: Date.now() };
    return models;
  }

  async fetchAllAvailableModels(): Promise<ModelInfo[]> {
    const allModels: ModelInfo[] = [];
    const statuses = this.getKeyStatus();

    for (const provider of this.providers.values()) {
      if (provider.apiKeyRequired && !statuses[provider.id]?.hasKey) continue;
      if (provider.id === 'ollama') {
        try {
          const models = await provider.fetchModels();
          allModels.push(...models);
        } catch {}
        continue;
      }
      try {
        const models = await provider.fetchModels();
        allModels.push(...models);
      } catch {
        // Skip providers that fail
      }
    }

    return allModels;
  }

  /**
   * Pick a model id that `providerId` actually offers. Keeps the active
   * model when it is in that provider's cached model list; otherwise
   * falls back to the provider's first (preferably free) model. Without
   * this, provider fallback reused the failed provider's model id, which
   * the fallback provider would reject (e.g. "gpt-4o" sent to Groq).
   */
  getFallbackModel(providerId: ProviderId): string | null {
    const cached = this.modelsCache.get(providerId);
    return pickFallbackModel(this.activeModel, cached);
  }

  /**
   * Get fallback provider when active provider fails.
   * Returns the next healthy provider in the fallback chain.
   */
  getFallbackProvider(failedProviderId: ProviderId): AIProvider | null {
    const candidates = FALLBACK_ORDER.filter(id => id !== failedProviderId);
    
    for (const id of candidates) {
      const provider = this.providers.get(id);
      if (provider && provider.hasApiKey() && provider.isHealthy()) {
        logger.info('providers', `Fallback from ${failedProviderId} to ${provider.name}`);
        return provider;
      }
    }

    // If no healthy fallback, try any provider with a key
    for (const id of candidates) {
      const provider = this.providers.get(id);
      if (provider && provider.hasApiKey()) {
        logger.info('providers', `Fallback (unverified) from ${failedProviderId} to ${provider.name}`);
        return provider;
      }
    }

    return null;
  }

  /**
   * Get health status for all providers.
   */
  async getHealthStatus(): Promise<Array<{ id: ProviderId; name: string; health: ProviderHealth }>> {
    const statuses: Array<{ id: ProviderId; name: string; health: ProviderHealth }> = [];
    
    for (const provider of this.providers.values()) {
      const health = provider.getHealth();
      statuses.push({
        id: provider.id,
        name: provider.name,
        health,
      });
    }

    return statuses;
  }

  setActiveProvider(providerId: ProviderId): void {
    this.activeProvider = providerId;
    logger.info('providers', `Active provider set to ${providerId}`);
  }

  setActiveModel(modelId: string): void {
    this.activeModel = modelId;
    logger.info('providers', `Active model set to ${modelId}`);
  }

  getActiveProvider(): ProviderId | null {
    return this.activeProvider;
  }

  getActiveModel(): string | null {
    return this.activeModel;
  }

  getStatus(): Array<{ id: ProviderId; name: string; hasKey: boolean; maskedKey?: string; healthy?: boolean }> {
    return this.getAllProviders().map(p => {
      const keyStatus = credentialStore.get(p.id);
      return {
        id: p.id,
        name: p.name,
        hasKey: keyStatus !== null,
        maskedKey: keyStatus ? credentialStore.maskKey(keyStatus) : undefined,
        healthy: p.isHealthy(),
      };
    });
  }
}

export const providers = new ProviderRegistry();

/**
 * Pure model-picking logic for provider fallback (testable without a
 * live registry): keep the active model when the fallback provider offers
 * it, otherwise pick its first free model, then its first model.
 */
export function pickFallbackModel(
  activeModel: string | null,
  cachedModels: ModelInfo[] | undefined,
): string | null {
  if (!cachedModels || cachedModels.length === 0) {
    return activeModel;
  }
  if (activeModel && cachedModels.some((m) => m.id === activeModel)) {
    return activeModel;
  }
  const preferred = cachedModels.find((m) => m.isFree) || cachedModels[0];
  return preferred?.id || null;
}
