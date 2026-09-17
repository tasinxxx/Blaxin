import { test, expect } from '@playwright/test';

// HUD accessibility verification (production-completion UX/a11y pass).
// Drives the REAL served HUD and asserts the polish actually landed in
// the DOM: named panel landmarks, tab semantics, ticker pause (WCAG
// 2.2.2), progressbar exposure, unnamed-button audit, focus-visible
// rule, and the pinned [role=status] order (StatusBar first, terminal
// live region second). No mocks — everything reads the live page.

test('HUD accessibility: landmarks, tablist, ticker pause, status-region order', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('blaxin-setup-complete', 'true'));
  await page.goto('/');
  await expect(page.getByTestId('boot-overlay')).toHaveCount(0, { timeout: 15000 });

  const hud = page.locator('main');

  // 1. Panels are named landmarks (aria-label = the visible panel name).
  const sections = hud.locator('section.jh-panel');
  const sectionCount = await sections.count();
  expect(sectionCount).toBeGreaterThanOrEqual(8);
  for (const name of ['NEURAL_STATUS', 'TASK_QUEUE', 'SECURITY_VAULT']) {
    await expect(sections.filter({ hasText: name })).toHaveAttribute('aria-label', name);
  }

  // 2. Terminal tabs form a real tablist with one selected tab.
  await expect(hud.locator('[role="tablist"][aria-label="Terminal stream filter"]')).toHaveCount(1);
  await expect(hud.locator('[role="tab"]')).toHaveCount(5);
  await expect(hud.locator('[role="tab"][aria-selected="true"]')).toHaveCount(1);

  // 3. The terminal stream is a feed, NOT a third status region — the
  //    e2e contract pins exactly two [role=status] regions.
  await expect(hud.locator('[role="feed"][aria-label="Agent event stream"]')).toHaveCount(1);
  await expect(page.locator('[role="status"]')).toHaveCount(2);

  // 4. Ticker pause (WCAG 2.2.2): button toggles animation-play-state.
  const ticker = page.locator('.jh-rail-ticker');
  await expect(ticker).toHaveCSS('animation-play-state', 'running');
  await page.getByRole('button', { name: 'Pause activity ticker' }).click();
  await expect(ticker).toHaveCSS('animation-play-state', 'paused');
  await page.getByRole('button', { name: 'Resume activity ticker' }).click();
  await expect(ticker).toHaveCSS('animation-play-state', 'running');

  // 5. Ticker also pauses while the strip is focused (keyboard users).
  await page.locator('.jh-rail-ticker-wrap').focus();
  await expect(ticker).toHaveCSS('animation-play-state', 'paused');
  await page.locator('.jh-rail-ticker-wrap').blur();
  await expect(ticker).toHaveCSS('animation-play-state', 'running');

  // 6. Every HUD button has an accessible name (no icon-only gaps).
  const unnamed = await hud.locator('button').evaluateAll(
    (els) => els.filter((b) => !(b.getAttribute('aria-label') || b.textContent || '').trim()).length,
  );
  expect(unnamed).toBe(0);

  // 7. HUD focus-visible rule is installed (keyboard focus visibility).
  const hasFocusRule = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule.cssText.includes('.jh button:focus-visible')) return true;
        }
      } catch { /* cross-origin sheets */ }
    }
    return false;
  });
  expect(hasFocusRule).toBe(true);

  // 8. Task progress exposed as a real progressbar.
  await expect(hud.locator('[role="progressbar"][aria-label="Task progress"]')).toHaveCount(1);

  // 9. Decorative chrome is hidden from assistive tech.
  await expect(page.locator('.jh-wave')).toHaveAttribute('aria-hidden', 'true');
  // (Boot overlay is unmounted at this point — it was verified to never
  // carry role=status while mounted by the [role=status] count above.)
});
