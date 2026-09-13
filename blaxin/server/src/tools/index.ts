import { Tool, ToolDefinition, ToolResult, RiskTier } from '../types.js';
import { matchesAnyPattern } from '../utils/config.js';
import type { AppConfig } from '../types.js';
import { TerminalTool } from './terminal.js';
import { FileSystemTool } from './filesystem.js';
import { ScreenshotTool } from './screenshot.js';
import { ComputerControlTool } from './computer-control.js';
import { BrowserTool } from './browser.js';
import { WebAgentTool } from './web-agent.js';
import { ClipboardTool } from './clipboard.js';
import { SearchTool } from './search.js';
import { SystemInfoTool } from './system-info.js';
import { logger } from '../utils/logger.js';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private enabledTools: Set<string> = new Set();

  constructor() {
    this.register(new TerminalTool());
    this.register(new FileSystemTool());
    this.register(new ScreenshotTool());
    this.register(new ComputerControlTool());
    this.register(new BrowserTool());
    this.register(new WebAgentTool());
    this.register(new ClipboardTool());
    this.register(new SearchTool());
    this.register(new SystemInfoTool());
  }

  private register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    this.enabledTools.add(tool.name);
    logger.info('tools', `Registered tool: ${tool.name}`);
  }

  getTool(name: string): Tool | undefined {
    if (!this.enabledTools.has(name)) return undefined;
    return this.tools.get(name);
  }

  getAllTools(): Tool[] {
    return Array.from(this.tools.values()).filter(t => this.enabledTools.has(t.name));
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.getAllTools().map(t => t.definition);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, output: '', error: `Unknown tool: ${name}` };
    }
    if (!this.enabledTools.has(name)) {
      return { success: false, output: '', error: `Tool "${name}" is disabled` };
    }

    logger.info('tools', `Executing tool: ${name}`, { args: this.sanitizeArgs(args) });

    try {
      const result = await Promise.race([
        tool.execute(args),
        new Promise<ToolResult>((_, reject) => 
          setTimeout(() => reject(new Error(`Tool "${name}" timed out after 30s`)), 30000)
        ),
      ]);
      
      logger.info('tools', `Tool ${name} completed: ${result.success ? 'success' : 'failed'}`);
      return result;
    } catch (error: any) {
      logger.error('tools', `Tool ${name} error: ${error.message}`);
      return { success: false, output: '', error: error.message };
    }
  }

  requiresConfirmation(name: string, args: Record<string, unknown>): boolean {
    const tool = this.tools.get(name);
    if (!tool?.requiresConfirmation) return false;
    return tool.requiresConfirmation(args);
  }

  /**
   * Whether a tool may run concurrently with other tools from the same
   * response. Conservative default: 'serial' (see Tool.executionMode).
   */
  getExecutionMode(name: string): 'parallel' | 'serial' {
    const tool = this.tools.get(name);
    return tool?.executionMode === 'parallel' ? 'parallel' : 'serial';
  }

  setEnabled(name: string, enabled: boolean): void {
    if (enabled) {
      this.enabledTools.add(name);
    } else {
      this.enabledTools.delete(name);
    }
  }

  getEnabledStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    for (const [name] of this.tools) {
      status[name] = this.enabledTools.has(name);
    }
    return status;
  }

  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length > 200) {
        sanitized[key] = value.slice(0, 200) + '...';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}

export const toolRegistry = new ToolRegistry();

// ── Risk classification ────────────────────────────────────────
// Declared base tier per capability; argument-level escalation happens in
// riskFor(). This is the single source of truth for step risk tiers.
const RISK_TIERS: Record<string, RiskTier> = {
  'system-info': 'LOW',
  search: 'LOW',
  clipboard: 'LOW',
  screenshot: 'MEDIUM', // captures the screen (privacy)
  browser: 'MEDIUM',
  blaxin_web: 'MEDIUM',
  filesystem: 'MEDIUM',
  terminal: 'MEDIUM',
  'computer-control': 'MEDIUM',
};

const DEFAULT_RISK_TIER: RiskTier = 'MEDIUM';

/**
 * Risk tier for a tool invocation. Base tier comes from the capability;
 * dangerous arguments escalate it (destructive filesystem ops, destructive
 * terminal commands matching the confirmation patterns).
 */
export function riskFor(name: string, args: Record<string, unknown>, config?: AppConfig): RiskTier {
  const base = RISK_TIERS[name] ?? DEFAULT_RISK_TIER;
  switch (name) {
    case 'filesystem': {
      const op = String(args.operation || '');
      if (op === 'delete' || op === 'rename') return 'HIGH';
      return base;
    }
    case 'browser': {
      // Pure observation (read the current URL/title, list tabs) changes
      // nothing — it is not a MEDIUM-risk browser manipulation.
      const action = String(args.action || '');
      if (action === 'current_url' || action === 'page_title' || action === 'list_tabs') return 'LOW';
      return base;
    }
    case 'terminal': {
      const command = String(args.command || '');
      if (config && matchesAnyPattern(command, config.agent.confirmationPatterns)) return 'CRITICAL';
      return base;
    }
    default:
      return base;
  }
}

/** All risk tiers in ascending danger order (for validation/UI). */
export const RISK_TIERS_ORDER: RiskTier[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export function isHigherRisk(a: RiskTier, b: RiskTier): boolean {
  return RISK_TIERS_ORDER.indexOf(a) > RISK_TIERS_ORDER.indexOf(b);
}
