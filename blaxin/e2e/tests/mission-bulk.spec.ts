import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// B4.2 — bulk results surface in the Mission Panel through the REAL
// pipeline: composer → WebSocket → orchestrator (deterministic fast
// path) → confirmation gate → bulk-files action → mission settlement →
// mission-progress → MissionPanel render. No mocks anywhere: the files
// are real, the confirmation click is real, the panel numbers are the
// server's own.

// The e2e backend runs with BLAXIN_DATA_DIR=e2e/.runtime/data — the
// scratch dir this test stages must live under it so the server can
// see it (both processes run on the same machine).
const DATA_DIR = new URL('../.runtime/data', import.meta.url).pathname;

test('bulk-files result surfaces in the Mission Panel', async ({ page }) => {
  test.setTimeout(90_000);

  // Stage a REAL directory with REAL files to organize by extension.
  const work = mkdtempSync(join(DATA_DIR, 'bulk-e2e-'));
  const docs = join(work, 'docs');
  mkdirSync(docs);
  writeFileSync(join(work, 'report.pdf'), 'PDF-DATA');
  writeFileSync(join(work, 'photo.png'), 'PNG-DATA');
  writeFileSync(join(work, 'notes.txt'), 'TXT-DATA');
  writeFileSync(join(docs, 'ignored.txt'), 'target is the parent');

  await page.addInitScript(() => { localStorage.setItem('blaxin-setup-complete', 'true'); });
  await page.goto('/');
  await expect(page.getByTestId('boot-overlay')).toHaveCount(0, { timeout: 15000 });

  // The mission is created through the REST surface (the same create the
  // JARVIS mission route uses) — the panel then mirrors its REAL state.
  const mission = {
    objective: `organize ${work}`,
    steps: [`organize the files in ${work} by type`],
  };

  // Create via the API (real backend, real persistence) using page.request.
  const created = await page.request.post('/api/missions', { data: mission });
  expect(created.ok()).toBeTruthy();
  const { mission: createdMission } = await created.json();
  expect(createdMission?.id).toBeTruthy();

  // The scheduler pumps the step: the deterministic router classifies
  // "organize the files in <dir> by type" → bulk-files → the confirmation
  // gate opens (HIGH risk verb, always gated).
  const dialog = page.getByRole('dialog', { name: 'BLAXIN needs your approval' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();

  // The bulk action really runs; the mission settles. The MissionPanel
  // shows the REAL mission row with the real verification badge and the
  // REAL bulk summary line (server-derived numbers, not client-computed).
  // Our mission is the NEWEST one: the panel shows newest first and our
  // row is the first (other persisted missions may exist below it).
  const row = page.getByTestId('mission-row').first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText('organize');
  await expect(row).toContainText('completed', { ignoreCase: true });

  // The bulk summary line carries the server's own aggregate (3 affected
  // items) — proven on the panel, derived from the tool result.
  const bulk = row.getByTestId('mission-bulk');
  await expect(bulk).toBeVisible();
  await expect(bulk).toContainText('organize');
  await expect(bulk).toContainText('3/3');

  // The filesystem state is the REAL proof the work happened: the
  // extension folders exist and the sources are gone.
  expect(existsSync(join(work, 'pdf', 'report.pdf'))).toBe(true);
  expect(existsSync(join(work, 'png', 'photo.png'))).toBe(true);
  expect(existsSync(join(work, 'txt', 'notes.txt'))).toBe(true);
  expect(existsSync(join(work, 'report.pdf'))).toBe(false);

  rmSync(work, { recursive: true, force: true });
});
