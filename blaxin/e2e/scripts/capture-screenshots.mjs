// Capture REAL BLAXIN screenshots for the repository README.
//
// Same topology as the e2e suite (see ../playwright.config.ts):
//   Google Chrome ─▶ vite dev server ─▶ real BLAXIN backend (tsx from src).
// No mocks, no fake UI: every pixel is the running v1.4.0 application.
//
// Usage:  node scripts/capture-screenshots.mjs   (from blaxin/e2e/)
// Output: ../docs/screenshots/*.png (gitignored .runtime/ is used for scratch data)

import { spawn } from 'child_process';
import { chromium } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(HERE, '..');
const BACKEND_PORT = Number(process.env.PW_BACKEND_PORT || 3001);
const VITE_PORT = Number(process.env.PW_VITE_PORT || 5173);
const DATA_DIR = join(E2E_DIR, '.runtime', 'data');
const OUT_DIR = join(E2E_DIR, '..', 'docs', 'screenshots');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, label, timeoutMs = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) { console.log(`  ✓ ${label} is up`); return; }
    } catch { /* not up yet */ }
    await wait(500);
  }
  throw new Error(`${label} did not become ready: ${url}`);
}

function start(cmd, args, cwd, env, label) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr.on('data', (d) => { if (String(d).trim()) console.log(`  [${label}] ${String(d).trim().split('\n').pop()}`); });
  return p;
}

const server = start('npx', ['tsx', 'src/index.ts'], join(E2E_DIR, '..', 'server'),
  { PORT: String(BACKEND_PORT), BLAXIN_HOST: '127.0.0.1', BLAXIN_DATA_DIR: DATA_DIR, BROWSER: 'none' }, 'server');
const client = start('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'],
  join(E2E_DIR, '..', 'client'), {}, 'client');

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await waitFor(`http://127.0.0.1:${BACKEND_PORT}/api/health`, 'backend');
  await waitFor(`http://127.0.0.1:${VITE_PORT}/`, 'vite client');
  await wait(1500);

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.addInitScript(() => { localStorage.setItem('blaxin-setup-complete', 'true'); });

  const shot = async (name) => {
    await page.screenshot({ path: join(OUT_DIR, name), animations: 'disabled' });
    const kb = Math.round(statSync(join(OUT_DIR, name)).size / 1024);
    console.log(`  📸 ${name} (${kb} KB)`);
  };

  // ── 1. Main HUD ────────────────────────────────────────────────────
  await page.goto(`http://127.0.0.1:${VITE_PORT}/`);
  await page.getByTestId('boot-overlay').waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
  await page.getByTestId('boot-overlay').waitFor({ state: 'detached', timeout: 20_000 });
  await expectVisible(page, page.locator('.jh-status-pill'), 'ONLINE');
  await expectVisible(page, page.getByText('NETWORK_HUB'), '');
  await wait(2500); // telemetry + particles settle
  await shot('hud-main.png');

  // ── 2. Real deterministic task through the agent terminal ──────────
  await page.getByLabel('Message BLAXIN').fill('/status');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expectVisible(page, page.locator('[role="status"]').nth(1), 'BLAXIN:');
  await expectVisible(page, page.locator('.jh-terminal-body'), 'AGENT STATE');
  await wait(1200);
  await shot('hud-agent-terminal.png');

  // ── 3. Confirmation gate (real HIGH-risk bulk-files mission) ───────
  const work = mkdtempSync(join(DATA_DIR, 'shot-bulk-'));
  mkdirSync(join(work, 'docs'));
  writeFileSync(join(work, 'report.pdf'), 'PDF-DATA');
  writeFileSync(join(work, 'photo.png'), 'PNG-DATA');
  writeFileSync(join(work, 'notes.txt'), 'TXT-DATA');
  const created = await page.request.post(`http://127.0.0.1:${VITE_PORT}/api/missions`, {
    data: { objective: `organize ${work}`, steps: [`organize the files in ${work} by type`] },
  });
  if (!created.ok()) throw new Error(`mission create failed: ${created.status()}`);
  const dialog = page.getByRole('dialog', { name: 'BLAXIN needs your approval' });
  await dialog.waitFor({ state: 'visible', timeout: 20_000 });
  await wait(600);
  await shot('confirmation-gate.png');
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();

  // ── 4. Mission settled with real verified bulk results ─────────────
  const row = page.getByTestId('mission-row').first();
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  await expectVisible(page, row, 'completed');
  await expectVisible(page, row.getByTestId('mission-bulk'), '3/3');
  // filesystem is the real witness
  for (const f of ['pdf/report.pdf', 'png/photo.png', 'txt/notes.txt']) {
    if (!existsSync(join(work, f))) throw new Error(`expected real organized file: ${f}`);
  }
  await wait(1500);
  await shot('mission-verified.png');

  await browser.close();
  rmSync(work, { recursive: true, force: true });
  console.log('DONE: 4 real screenshots captured');
}

async function expectVisible(page, locator, text) {
  if (text) await locator.filter({ hasText: text }).first().waitFor({ state: 'visible', timeout: 20_000 });
  else await locator.first().waitFor({ state: 'visible', timeout: 20_000 });
}

main()
  .then(() => process.exitCode = 0)
  .catch((err) => { console.error('CAPTURE FAILED:', err); process.exitCode = 1; })
  .finally(() => {
    server.kill('SIGTERM'); client.kill('SIGTERM');
    setTimeout(() => { server.kill('SIGKILL'); client.kill('SIGKILL'); process.exit(process.exitCode || 0); }, 3000);
  });
