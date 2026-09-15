import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { logger } from './logger.js';
import { dataPath } from './paths.js';
import { stripImages } from './context-budget.js';

// ── Session State Types ─────────────────────────────────────────

interface ConversationMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  toolCallId?: string;
  name?: string;
}

interface SessionState {
  sessionId: string;
  conversationHistory: ConversationMessage[];
  lastActivity: number;
  version: string;
  metadata: {
    totalMessages: number;
    totalToolCalls: number;
    lastProvider?: string;
    lastModel?: string;
  };
}

// ── State Manager ───────────────────────────────────────────────

const STATE_DIR = dataPath('.blaxin-state');
const STATE_FILE = dataPath('.blaxin-state', 'session.json');
const MAX_HISTORY_SIZE = 100; // Maximum messages to persist
const AUTO_SAVE_INTERVAL_MS = 30000; // Auto-save every 30 seconds
const MAX_STATE_FILE_SIZE = 10 * 1024 * 1024; // 10MB max state file

class SessionStateManager {
  private state: SessionState;
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private isDirty = false;

  constructor() {
    this.state = this.loadState();
  }

  private loadState(): SessionState {
    const defaultState: SessionState = {
      sessionId: `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversationHistory: [],
      lastActivity: Date.now(),
      version: '1.0.0',
      metadata: {
        totalMessages: 0,
        totalToolCalls: 0,
      },
    };

    try {
      if (!existsSync(STATE_DIR)) {
        mkdirSync(STATE_DIR, { recursive: true });
      }

      if (!existsSync(STATE_FILE)) {
        logger.info('session', 'No existing session state found, starting fresh');
        return defaultState;
      }

      // Check file size before reading
      const stats = statSync(STATE_FILE);
      if (stats.size > MAX_STATE_FILE_SIZE) {
        logger.warn('session', `State file too large (${stats.size} bytes), starting fresh`);
        return defaultState;
      }

      const raw = readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as SessionState;

      // Validate state structure
      if (!parsed.sessionId || !Array.isArray(parsed.conversationHistory)) {
        logger.warn('session', 'Invalid state structure, starting fresh');
        return defaultState;
      }

      // Trim history if too large
      if (parsed.conversationHistory.length > MAX_HISTORY_SIZE) {
        parsed.conversationHistory = parsed.conversationHistory.slice(-MAX_HISTORY_SIZE);
      }

      logger.info('session', `Restored session ${parsed.sessionId} with ${parsed.conversationHistory.length} messages`);
      return parsed;
    } catch (error: any) {
      logger.warn('session', `Failed to load state: ${error.message}, starting fresh`);
      return defaultState;
    }
  }

  saveState(): void {
    try {
      if (!existsSync(STATE_DIR)) {
        mkdirSync(STATE_DIR, { recursive: true });
      }

      this.state.lastActivity = Date.now();

      // Images are an in-memory replay concern only: never persist base64
      // payloads to the state file (keeps it text-only and bounded).
      const persistable = {
        ...this.state,
        conversationHistory: stripImages(this.state.conversationHistory),
      };

      const raw = JSON.stringify(persistable, null, 2);
      writeFileSync(STATE_FILE, raw, { mode: 0o600 });
      this.isDirty = false;
    } catch (error: any) {
      logger.error('session', `Failed to save state: ${error.message}`);
    }
  }

  startAutoSave(): void {
    if (this.autoSaveTimer) return;

    this.autoSaveTimer = setInterval(() => {
      if (this.isDirty) {
        this.saveState();
      }
    }, AUTO_SAVE_INTERVAL_MS);

    logger.info('session', 'Auto-save enabled');
  }

  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    // Save one final time
    if (this.isDirty) {
      this.saveState();
    }
  }

  addMessage(message: ConversationMessage): void {
    this.state.conversationHistory.push(message);
    this.state.metadata.totalMessages++;
    this.isDirty = true;

    // Trim if exceeding max size
    if (this.state.conversationHistory.length > MAX_HISTORY_SIZE) {
      const excess = this.state.conversationHistory.length - MAX_HISTORY_SIZE;
      this.state.conversationHistory.splice(0, excess);
    }
  }

  getHistory(): ConversationMessage[] {
    return [...this.state.conversationHistory];
  }

  setHistory(history: ConversationMessage[]): void {
    this.state.conversationHistory = history.slice(-MAX_HISTORY_SIZE);
    this.isDirty = true;
  }

  clearHistory(): void {
    this.state.conversationHistory = [];
    this.state.metadata.totalMessages = 0;
    this.state.metadata.totalToolCalls = 0;
    this.isDirty = true;
  }

  updateMetadata(data: { provider?: string; model?: string }): void {
    if (data.provider) this.state.metadata.lastProvider = data.provider;
    if (data.model) this.state.metadata.lastModel = data.model;
    this.isDirty = true;
  }

  getSessionId(): string {
    return this.state.sessionId;
  }

  getState(): SessionState {
    return { ...this.state };
  }

  forceSave(): void {
    this.saveState();
  }
}

export const sessionState = new SessionStateManager();
