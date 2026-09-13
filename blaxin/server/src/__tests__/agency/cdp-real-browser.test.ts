// REAL-Chromium CDP verification (env-gated: BLAXIN_REAL_CHROME=1)
// =============================================================
// Proves the grounding/scroll/verification layer against a REAL
// headless Chromium over the real DevTools Protocol — deterministic
// data: pages, no network dependency. Skipped silently in normal runs
// (CI/headless suites stay green); run explicitly with:
//   BLAXIN_REAL_CHROME=1 npx vitest run src/__tests__/agency/cdp-real-browser.test.ts
// Live YouTube end-to-end (network + bot-walls) stays a manual probe,
// NOT an automated claim.
// =============================================================

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { createServer } from 'http';

const REAL = !!process.env.BLAXIN_REAL_CHROME;
const d = REAL ? describe : describe.skip;
const PORT = 9333 + Math.floor(Math.random() * 400);

// env must be set BEFORE the module import reads BLAXIN_CDP_PORT.
process.env.BLAXIN_CDP_PORT = String(PORT);
const { CdpPage, snapshotInteractives, findTarget, clickTarget, adaptiveScroll, verifyPlayback, isCdpAlive } = await import('../../tools/cdp-browser.js');

const CHILDREN: ReturnType<typeof execFile>[] = [];

async function launchHeadlessChrome(): Promise<void> {
  const bins = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  const extraSandbox = process.env.BLAXIN_E2E_NO_SANDBOX ? ['--no-sandbox'] : [];
  for (const bin of bins) {
    const ok = await new Promise<boolean>((resolve) => {
      execFile('which', [bin], (error) => resolve(!error));
    });
    if (!ok) continue;
    const child = execFile(bin, [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=/tmp/blaxin-cdp-test-${PORT}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      ...extraSandbox,
      'about:blank',
    ], () => undefined);
    child.on('error', () => undefined);
    child.unref();
    CHILDREN.push(child);
    // Wait for the CDP endpoint (bounded).
    for (let i = 0; i < 20; i++) {
      if (await isCdpAlive()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('No Chromium/Chrome with CDP could be started');
}

/**
 * Tiny loopback server for REAL navigations (no external network): two
 * distinct pages give genuine history entries and clean URL matching.
 */
function startLoopbackServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const isB = (req.url || '/').startsWith('/b');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(isB
      ? '<html><head><title>Page B</title></head><body><h1>B</h1></body></html>'
      : '<html><head><title>Page A</title></head><body><h1>A</h1></body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((r) => {
          // Chrome holds keep-alive sockets: close() alone would wait for
          // them. Force them shut, and never let teardown hang the test.
          server.closeAllConnections?.();
          server.close(() => r());
          setTimeout(r, 1000);
        }),
      });
    });
  });
}

const PAGE_WITH_LINKS = 'data:text/html,' + encodeURIComponent(`
  <html><head><title>Grounding Test Page</title></head><body>
    <h1>Real page</h1>
    <a href="#next" aria-label="More information">More information</a>
    <button aria-label="Accept">Accept</button>
    <input placeholder="Search here" />
    <div id="result" style="display:none">CLICKED</div>
    <script>
      document.querySelector('a').addEventListener('click', () => {
        const r = document.getElementById('result');
        r.style.display = 'block';
        r.textContent = 'CLICKED-LINK';
      });
    </script>
  </body></html>
`);

const TALL_PAGE = 'data:text/html,' + encodeURIComponent(`
  <html><head><title>Tall Page</title></head><body style="margin:0">
    ${Array.from({ length: 60 }, (_, i) => `<div style="height:200px">filler ${i}</div>`).join('')}
    <button id="bottom" aria-label="Load more comments">Load more comments</button>
  </body></html>
`);

d('real Chromium CDP (BLAXIN_REAL_CHROME=1)', () => {
  let cdp: InstanceType<typeof CdpPage>;

  afterAll(() => {
    cdp?.close();
  });

  it('launches headless Chrome with CDP and attaches', async () => {
    await launchHeadlessChrome();
    cdp = await CdpPage.attach(null);
    expect(await isCdpAlive()).toBe(true);
  }, 30_000);

  it('grounds a semantic target in the real DOM and verifies the click landed', async () => {
    await cdp.send('Page.navigate', { url: PAGE_WITH_LINKS });
    await new Promise((r) => setTimeout(r, 800));

    const els = await snapshotInteractives(cdp);
    expect(els.length).toBeGreaterThanOrEqual(3); // a, button, input are REAL

    const target = findTarget(els, 'More information', 0.5);
    expect(target).not.toBeNull();
    expect(target!.element.tag).toBe('a');
    expect(target!.confidence).toBeGreaterThanOrEqual(0.9);

    const ok = await clickTarget(cdp, target!);
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    // VERIFY with real page state — the click really landed.
    const clicked = await cdp.eval<string>(
      `document.getElementById('result').textContent`
    );
    expect(clicked).toBe('CLICKED-LINK');
  }, 20_000);

  it('refuses to ground a target that does not exist — honest failure', async () => {
    const els = await snapshotInteractives(cdp);
    expect(findTarget(els, 'totally absent thing', 0.5)).toBeNull();
  }, 20_000);

  it('adaptively scrolls a real tall page until the bottom target is found', async () => {
    await cdp.send('Page.navigate', { url: TALL_PAGE });
    await new Promise((r) => setTimeout(r, 800));

    const steps = await adaptiveScroll(cdp, 'Load more comments', { stepPx: 900, maxSteps: 15 });
    expect(steps.at(-1)!.outcome).toBe('TARGET_FOUND');
    // The button is at the real bottom (~12,000px page): several REAL
    // scroll steps must have happened, each verified by real scrollY.
    expect(steps.filter((s) => s.outcome === 'SCROLLED').length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('reports playback honestly: no video on the page → NOT playing', async () => {
    const pb = await verifyPlayback(cdp, 800);
    expect(pb.playing).toBe(false);
  }, 20_000);

  it('real session control: back/forward/refresh observe REAL history + document (§6)', async () => {
    const server = await startLoopbackServer();
    try {
      const { BrowserSession } = await import('../../tools/browser-session.js');
      const { BrowserTool } = await import('../../tools/browser.js');
      const session = new BrowserSession();
      const tool = new BrowserTool(session, { navVerifyMs: 5000, reloadVerifyMs: 6000 });

      const a = `http://127.0.0.1:${server.port}/a`;
      const b = `http://127.0.0.1:${server.port}/b`;
      expect((await tool.execute({ action: 'open_url', url: a })).success).toBe(true);
      expect((await tool.execute({ action: 'open_url', url: b })).success).toBe(true);

      // Real reads from the real page.
      const cur = await tool.execute({ action: 'current_url' });
      expect(cur.success).toBe(true);
      expect(String((cur.data as { url: string }).url)).toContain('/b');
      const title = await tool.execute({ action: 'page_title' });
      expect(title.success).toBe(true);
      expect(String((title.data as { title: string }).title)).toContain('Page B');

      // back → the REAL previous entry; index AND URL verified.
      const back = await tool.execute({ action: 'back' });
      expect(back.success).toBe(true);
      expect(String(back.output)).toContain('history index');
      const afterBack = await tool.execute({ action: 'current_url' });
      expect(String((afterBack.data as { url: string }).url)).toContain('/a');

      // forward → back to the real next entry.
      const forward = await tool.execute({ action: 'forward' });
      expect(forward.success).toBe(true);
      const afterForward = await tool.execute({ action: 'current_url' });
      expect(String((afterForward.data as { url: string }).url)).toContain('/b');

      // refresh → the document REALLY reloaded (pre-reload marker cleared).
      const refresh = await tool.execute({ action: 'refresh' });
      expect(refresh.success).toBe(true);
      expect(String(refresh.output)).toContain('fresh document observed');

      // list_tabs → the REAL page-target list.
      const tabs = await tool.execute({ action: 'list_tabs' });
      expect(tabs.success).toBe(true);
      expect((tabs.data as { tabs: unknown[] }).tabs.length).toBeGreaterThanOrEqual(1);
    } finally {
      await server.close();
    }
  }, 60_000);
}, 60_000);
