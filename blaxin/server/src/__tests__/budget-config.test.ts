import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// SPECIALIST/RECOVERY BUDGET CONFIG SURFACE (§6 + § recovery)
// =============================================================
// The specialist ledger and recovery ladder had explicit setters used
// only by tests; production ran on code constants. Now the persisted
// AppConfig carries agent.specialist / agent.recovery, loadConfig()
// back-fills them per-key (an older config file can never silently drop
// a budget to undefined), and index.ts applies them to the orchestrator
// at startup. This suite pins the CONFIG side of that chain: defaults,
// per-key back-fill, save/load round-trip, and honest degradation.
// (The orchestrator-side application is a one-line setter call in
// index.ts, covered by the existing setter suites.)
// =============================================================

const tmpDirs: string[] = [];

function freshEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'blaxin-budget-cfg-'));
  tmpDirs.push(dir);
  process.env.BLAXIN_DATA_DIR = dir;
  return dir;
}

afterEach(() => {
  delete process.env.BLAXIN_DATA_DIR;
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

async function freshConfig() {
  vi.resetModules();
  return await import('../utils/config.js');
}

describe('budget config surface', () => {
  it('a missing config file yields the honest budget defaults', async () => {
    freshEnv();
    const { loadConfig } = await freshConfig();
    const cfg = loadConfig();
    expect(cfg.agent.specialist).toEqual({
      maxActions: 16, maxRecoveries: 8, maxReplans: 1, deadlineMs: 300_000,
    });
    expect(cfg.agent.recovery).toEqual({
      maxRecoveryAttempts: 2, maxReplansPerTask: 1, baseBackoffMs: 300, maxBackoffMs: 2000,
    });
  });

  it('an OLDER config file (no budget subsections) back-fills every budget — never undefined', async () => {
    const dir = freshEnv();
    // Simulate a pre-feature config: agent exists, budgets do not.
    writeFileSync(join(dir, 'blaxin-config.json'), JSON.stringify({
      agent: { maxSteps: 42, requireConfirmation: false },
    }));
    const { loadConfig } = await freshConfig();
    const cfg = loadConfig();
    expect(cfg.agent.maxSteps).toBe(42);               // user value kept
    expect(cfg.agent.requireConfirmation).toBe(false);  // user value kept
    expect(cfg.agent.specialist).toEqual({              // budgets defaulted
      maxActions: 16, maxRecoveries: 8, maxReplans: 1, deadlineMs: 300_000,
    });
    expect(cfg.agent.recovery?.maxRecoveryAttempts).toBe(2);
  });

  it('a PARTIAL budget subsection back-fills only the missing keys', async () => {
    const dir = freshEnv();
    writeFileSync(join(dir, 'blaxin-config.json'), JSON.stringify({
      agent: { specialist: { maxActions: 4 } },
    }));
    const { loadConfig } = await freshConfig();
    const cfg = loadConfig();
    expect(cfg.agent.specialist).toEqual({
      maxActions: 4, maxRecoveries: 8, maxReplans: 1, deadlineMs: 300_000,
    });
  });

  it('user-tuned budgets survive a save/load round-trip', async () => {
    const dir = freshEnv();
    const { loadConfig, saveConfig } = await freshConfig();
    const cfg = loadConfig();
    cfg.agent.specialist = { ...cfg.agent.specialist!, maxActions: 7, deadlineMs: 60_000 };
    cfg.agent.recovery = { ...cfg.agent.recovery!, maxRecoveryAttempts: 3, baseBackoffMs: 100 };
    saveConfig(cfg);
    expect(existsSync(join(dir, 'blaxin-config.json'))).toBe(true);

    const reloaded = loadConfig();
    expect(reloaded.agent.specialist?.maxActions).toBe(7);
    expect(reloaded.agent.specialist?.deadlineMs).toBe(60_000);
    expect(reloaded.agent.recovery?.maxRecoveryAttempts).toBe(3);
    expect(reloaded.agent.recovery?.baseBackoffMs).toBe(100);
  });

  it('saveConfig persists budgets to disk and invalidates the cache', async () => {
    const dir = freshEnv();
    const { loadConfig, saveConfig, getConfig } = await freshConfig();
    const cfg = loadConfig();
    cfg.agent.specialist = { ...cfg.agent.specialist!, maxActions: 5 };
    saveConfig(cfg);

    const fromDisk = JSON.parse(readFileSync(join(dir, 'blaxin-config.json'), 'utf-8'));
    expect(fromDisk.agent.specialist.maxActions).toBe(5);

    // getConfig() must see the new value after the invalidation (hot path).
    expect(getConfig().agent.specialist?.maxActions).toBe(5);
  });

  it('a corrupt config file falls back to the budget defaults (honest degradation)', async () => {
    const dir = freshEnv();
    writeFileSync(join(dir, 'blaxin-config.json'), '{ not json');
    const { loadConfig } = await freshConfig();
    const cfg = loadConfig();
    expect(cfg.agent.specialist?.maxActions).toBe(16);
    expect(cfg.agent.recovery?.maxRecoveryAttempts).toBe(2);
  });

  it('a non-object budget subsection is replaced by defaults (never a crash)', async () => {
    const dir = freshEnv();
    writeFileSync(join(dir, 'blaxin-config.json'), JSON.stringify({ agent: { specialist: 7 } }));
    const { loadConfig } = await freshConfig();
    const cfg = loadConfig();
    expect(cfg.agent.specialist).toEqual({
      maxActions: 16, maxRecoveries: 8, maxReplans: 1, deadlineMs: 300_000,
    });
  });
});
