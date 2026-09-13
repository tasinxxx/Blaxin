// Deterministic browser session actions (§6/§9/§10):
//   back / forward / refresh / current_url / page_title / list_tabs
// Every one of them must report the REAL outcome — an action that was
// merely SENT is never reported as succeeded. The fakes below are a
// stateful page: history navigation really mutates the index, a reload
// really replaces the document (clearing our marker) unless told not to.

import { describe, it, expect } from 'vitest';
import { BrowserTool } from '../../tools/browser.js';
import { BrowserSession, BrowserSessionDeps } from '../../tools/browser-session.js';
import type { CdpPage } from '../../tools/cdp-browser.js';

interface HistoryEntry {
  id: number;
  url: string;
}

// ── Stateful fake page (deterministic, no real browser) ─────────

class FakePage {
  url: string;
  title: string;
  entries: HistoryEntry[];
  currentIndex: number;
  /** Every evaluation throws (page unobservable). */
  evalFails = false;
  /** Planting the reload baseline marker fails. */
  plantFails = false;
  /** Simulate a reload that did NOT replace the document. */
  reloadWorks = true;
  /** Simulate navigateToHistoryEntry not moving the real index. */
  ignoreHistoryNav = false;
  sendCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  private marker: string | null = null;

  constructor(init: { url: string; title?: string; entries?: HistoryEntry[]; currentIndex?: number }) {
    this.url = init.url;
    this.title = init.title ?? 'Fake Page';
    this.entries = init.entries ?? [{ id: 1, url: init.url }];
    this.currentIndex = init.currentIndex ?? this.entries.length - 1;
  }

  getTargetId(): string { return 'target-fake'; }
  isOpen(): boolean { return true; }
  close(): void { /* no-op */ }

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    this.sendCalls.push({ method, params });
    switch (method) {
      case 'Page.getNavigationHistory':
        return {
          currentIndex: this.currentIndex,
          entries: this.entries.map((e) => ({ id: e.id, url: e.url, title: '' })),
        };
      case 'Page.navigateToHistoryEntry': {
        if (this.ignoreHistoryNav) return {};
        const idx = this.entries.findIndex((e) => e.id === params.entryId);
        if (idx >= 0) {
          this.currentIndex = idx;
          this.url = this.entries[idx].url;
        }
        return {};
      }
      case 'Page.reload':
        // A real reload replaces the document ⇒ our marker is gone.
        if (this.reloadWorks) this.marker = null;
        return {};
      default:
        return {};
    }
  }

  async eval<T>(expression: string): Promise<T> {
    if (expression.includes('window.__blaxinReloadMarker =')) {
      if (this.plantFails) throw new Error('renderer gone');
      const m = expression.match(/window\.__blaxinReloadMarker = ("[^"]*")/);
      this.marker = m ? (JSON.parse(m[1]) as string) : null;
      return true as unknown as T;
    }
    if (this.evalFails) throw new Error('evaluation failed');
    if (expression.includes('marker: window.__blaxinReloadMarker')) {
      return { marker: this.marker, url: this.url, title: this.title } as unknown as T;
    }
    return { url: this.url, title: this.title, errorPage: false } as unknown as T;
  }
}

function makeSession(page: FakePage): BrowserSession {
  const session = new BrowserSession();
  const deps: BrowserSessionDeps = {
    ensureCdpPage: async () => page as unknown as CdpPage,
    listPageTargets: async () => [{ targetId: 'target-fake', url: page.url, title: page.title }],
    attachToTargetId: async () => page as unknown as CdpPage,
  };
  session.useDeps(deps);
  return session;
}

/** Fast tool: tiny verification windows so failure tests stay quick. */
function makeTool(page: FakePage): BrowserTool {
  return new BrowserTool(makeSession(page), { navVerifyMs: 80, reloadVerifyMs: 120 });
}

// ── back / forward ───────────────────────────────────────────────

describe('browser back/forward — real history, real verification', () => {
  it('back navigates to the real previous entry and verifies index + URL', async () => {
    const page = new FakePage({
      url: 'https://b.test/',
      entries: [
        { id: 1, url: 'https://a.test/' },
        { id: 2, url: 'https://b.test/' },
      ],
      currentIndex: 1,
    });
    const r = await makeTool(page).execute({ action: 'back' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('Went back');
    expect(r.output).toContain('history index 0 + URL verified');
    expect(page.sendCalls.some((c) => c.method === 'Page.navigateToHistoryEntry')).toBe(true);
    // Never a blind keyboard navigation.
    expect(page.sendCalls.some((c) => c.method.startsWith('Input.'))).toBe(false);
  });

  it('forward navigates to the real next entry', async () => {
    const page = new FakePage({
      url: 'https://a.test/',
      entries: [
        { id: 1, url: 'https://a.test/' },
        { id: 2, url: 'https://b.test/' },
      ],
      currentIndex: 0,
    });
    const r = await makeTool(page).execute({ action: 'forward' });
    expect(r.success).toBe(true);
    expect(page.url).toBe('https://b.test/');
  });

  it('back at the start of history fails honestly (nothing to go back to)', async () => {
    const page = new FakePage({
      url: 'https://a.test/',
      entries: [{ id: 1, url: 'https://a.test/' }],
      currentIndex: 0,
    });
    const r = await makeTool(page).execute({ action: 'back' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('NOT possible');
    // No navigation was attempted at all.
    expect(page.sendCalls.some((c) => c.method === 'Page.navigateToHistoryEntry')).toBe(false);
  });

  it('back fails when the URL matches but the real history index did not move', async () => {
    const page = new FakePage({
      url: 'https://a.test/',
      entries: [
        { id: 1, url: 'https://a.test/' },
        { id: 2, url: 'https://a.test/' },
      ],
      currentIndex: 1,
    });
    page.ignoreHistoryNav = true;
    const r = await makeTool(page).execute({ action: 'back' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('history index');
  });

  it('back fails honestly when the page never lands on the entry URL', async () => {
    const page = new FakePage({
      url: 'https://b.test/',
      entries: [
        { id: 1, url: 'https://a.test/' },
        { id: 2, url: 'https://b.test/' },
      ],
      currentIndex: 1,
    });
    // The history entry exists but the page stays put (blocked redirect).
    page.ignoreHistoryNav = true;
    const r = await makeTool(page).execute({ action: 'back' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('NOT verified');
  });
});

// ── refresh ──────────────────────────────────────────────────────

describe('browser refresh — document replacement is the evidence', () => {
  it('verifies a real reload (pre-reload document marker cleared)', async () => {
    const page = new FakePage({ url: 'https://example.com/' });
    const r = await makeTool(page).execute({ action: 'refresh' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('fresh document observed');
    expect(page.sendCalls.some((c) => c.method === 'Page.reload')).toBe(true);
  });

  it('fails honestly when the document survived (reload did not happen)', async () => {
    const page = new FakePage({ url: 'https://example.com/' });
    page.reloadWorks = false;
    const r = await makeTool(page).execute({ action: 'refresh' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('NOT verified');
    expect(String(r.error)).toContain('survived the reload');
  });

  it('refuses to claim success without a baseline (page unobservable)', async () => {
    const page = new FakePage({ url: 'https://example.com/' });
    page.plantFails = true;
    const r = await makeTool(page).execute({ action: 'refresh' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('baseline');
  });
});

// ── observation actions ──────────────────────────────────────────

describe('browser observation actions — real reads only', () => {
  it('current_url returns the REAL observed location', async () => {
    const page = new FakePage({ url: 'https://example.com/page', title: 'Example' });
    const r = await makeTool(page).execute({ action: 'current_url' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('https://example.com/page');
    expect((r.data as { url: string }).url).toBe('https://example.com/page');
  });

  it('page_title returns the REAL observed title', async () => {
    const page = new FakePage({ url: 'https://example.com/', title: 'Hello Title' });
    const r = await makeTool(page).execute({ action: 'page_title' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('Hello Title');
  });

  it('list_tabs reports the REAL page-target list', async () => {
    const page = new FakePage({ url: 'https://example.com/', title: 'Example' });
    const r = await makeTool(page).execute({ action: 'list_tabs' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('1 open tab(s)');
    expect((r.data as { tabs: unknown[] }).tabs).toHaveLength(1);
  });

  it('list_tabs fails honestly when the debugging endpoint is unreachable', async () => {
    const session = new BrowserSession();
    session.useDeps({
      ensureCdpPage: async () => { throw new Error('no browser'); },
      listPageTargets: async () => { throw new Error('cdp dead'); },
      attachToTargetId: async () => { throw new Error('cannot attach'); },
    });
    const r = await new BrowserTool(session).execute({ action: 'list_tabs' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('could not reach');
  });
});

// ── policy: read-only actions do not gate ────────────────────────

describe('browser tool confirmation policy', () => {
  it('gates state-changing actions', async () => {
    const tool = new BrowserTool(makeSession(new FakePage({ url: 'https://example.com/' })));
    for (const action of ['open_url', 'search', 'back', 'forward', 'refresh', 'open_new_tab', 'close_tab']) {
      expect(tool.requiresConfirmation({ action }), action).toBe(true);
    }
  });

  it('does not gate pure observation actions', async () => {
    const tool = new BrowserTool(makeSession(new FakePage({ url: 'https://example.com/' })));
    for (const action of ['current_url', 'page_title', 'list_tabs']) {
      expect(tool.requiresConfirmation({ action }), action).toBe(false);
    }
  });
});
