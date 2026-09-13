import { Tool, ToolResult } from '../types.js';
import { browserSession, desyncNote, withDesyncNote, isBlankUrl } from './browser-session.js';
import { verifyUrl } from './verification.js';
import { logger } from '../utils/logger.js';

/** Structural shape of verifyUrl evidence (kept local — verification.ts owns the type). */
interface Located {
  url: string;
  title: string;
  errorPage: boolean;
}

/** Actions that only READ browser state — no navigation, no mutation. */
const READ_ONLY_ACTIONS = new Set(['current_url', 'page_title', 'list_tabs']);

/** Real navigation history (CDP) — the ground truth for back/forward. */
async function readHistory(
  cdp: { send: (method: string, params?: Record<string, unknown>) => Promise<any> },
): Promise<{ currentIndex: number; entries: any[] }> {
  const raw = await cdp.send('Page.getNavigationHistory');
  const index = Number(raw?.currentIndex);
  return {
    currentIndex: Number.isFinite(index) ? index : -1,
    entries: Array.isArray(raw?.entries) ? raw.entries : [],
  };
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BrowserTool implements Tool {
  name = 'browser';
  description = 'Open URLs in a web browser, search the web, navigate browser history, and interact with web content.';

  /** The authoritative session (injectable for deterministic tests). */
  private readonly session: typeof browserSession;
  /** Verification windows (injectable so tests stay fast + deterministic). */
  private readonly navVerifyMs: number;
  private readonly reloadVerifyMs: number;

  constructor(
    session: typeof browserSession = browserSession,
    opts: { navVerifyMs?: number; reloadVerifyMs?: number } = {},
  ) {
    this.session = session;
    this.navVerifyMs = opts.navVerifyMs ?? 6000;
    this.reloadVerifyMs = opts.reloadVerifyMs ?? 8000;
  }

  definition = {
    type: 'function' as const,
    function: {
      name: 'browser',
      description: 'Open a URL in the browser, search the web, or open a specific website.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'open_url', 'search', 'open_new_tab', 'close_tab',
              'back', 'forward', 'refresh', 'current_url', 'page_title', 'list_tabs',
            ],
            description: 'The browser action to perform',
          },
          url: {
            type: 'string',
            description: 'URL to open (for open_url and open_new_tab)',
          },
          query: {
            type: 'string',
            description: 'Search query (for search action)',
          },
        },
        required: ['action'],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;

    try {
      switch (action) {
        case 'open_url':
        case 'search': {
          let targetUrl: string;
          if (action === 'search') {
            const query = args.query as string;
            if (!query) return { success: false, output: '', error: 'Search query is required' };
            targetUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
          } else {
            const url = args.url as string;
            if (!url) return { success: false, output: '', error: 'URL is required' };
            try {
              new URL(url);
            } catch {
              return { success: false, output: '', error: 'Invalid URL format' };
            }
            targetUrl = url;
          }

          // ONE authoritative session for every navigation (§22). acquire()
          // revalidates reality (target alive, page observable, no
          // about:blank regression) and recovers bounded on desync.
          const sinceTs = Date.now();
          const cdp = await this.session.acquire();
          await cdp.send('Page.navigate', { url: targetUrl });
          this.session.recordNavigation(targetUrl);
          // Load-settle IS verification: poll the REAL location until it
          // matches or the window closes. chrome-error = definitive FAILURE.
          let v = await verifyUrl(cdp, targetUrl, 8000);
          // Desync contract (§22/§29): an UNKNOWN (unobservable page) is
          // exactly the SESSION_DESYNC trigger — reconnect, reacquire the
          // page, and OBSERVE+VERIFY again before reporting. A page that
          // becomes observable through recovery still yields the real
          // answer; UNKNOWN is only reported when reality stays hidden.
          if (v.status === 'UNKNOWN') {
            try {
              const cdp2 = await this.session.reacquire();
              v = await verifyUrl(cdp2, targetUrl, 4000);
            } catch (e: any) {
              v = {
                status: 'UNKNOWN', method: 'url-match', evidence: null, confidence: 0,
                detail: `Reacquire after desync failed: ${e?.message ?? e} — URL unverified`,
              };
            }
          }
          const desync = desyncNote(this.session, sinceTs);
          if (v.status === 'SUCCESS') {
            const loc = v.evidence as unknown as Located | null;
            if (!loc) {
              // Evidence is structurally absent — refuse to fabricate a URL.
              return withDesyncNote({
                success: false,
                output: '',
                error: `${action} NOT verified — verification reported success without location evidence`,
              }, desync);
            }
            return withDesyncNote({
              success: true,
              output: `Opened URL: ${targetUrl} — OBSERVED at ${loc.url}, title: "${loc.title}" (URL verified).`,
              data: { verification: v },
            }, desync);
          }
          return withDesyncNote({
            success: false,
            output: '',
            error: `${action} NOT verified — ${v.detail}`,
            data: { verification: { method: v.method, status: v.status, evidence: v.evidence, confidence: v.confidence } },
          }, desync);
        }

        case 'open_new_tab': {
          const url = (args.url as string) || 'about:blank';
          if (url !== 'about:blank') {
            try { new URL(url); } catch {
              return { success: false, output: '', error: 'Invalid URL format' };
            }
          }
          const sinceTs = Date.now();
          // Create a REAL new page target through CDP (Target.createTarget)
          // and then VERIFY it: the target must appear in the REAL /json
          // page list at the expected URL. No more shell `--new-tab` guess
          // whose failure was previously reported as success (§68).
          const cdp = await this.session.acquire();
          const created = await cdp.send('Target.createTarget', { url });
          const newTargetId = created?.targetId ? String(created.targetId) : null;
          if (!newTargetId) {
            return withDesyncNote({
              success: false,
              output: '',
              error: 'open_new_tab NOT verified — Target.createTarget returned no targetId',
            }, desyncNote(this.session, sinceTs));
          }
          // The session stays on the ORIGINAL page (open_new_tab is a
          // side action, not a navigation of the working context).
          // Verify the new target REALLY exists with the expected URL.
          const deadline = Date.now() + 5000;
          let observed: { targetId: string; url: string; title: string } | null = null;
          while (Date.now() < deadline) {
            const targets = await this.session.listTargets();
            observed = targets.find((t) => t.targetId === newTargetId) ?? null;
            if (observed && (url === 'about:blank' ? isBlankUrl(observed.url) || observed.url === '' : urlMatchesLocation(observed.url, url))) break;
            await new Promise((r) => setTimeout(r, 250));
            observed = null;
          }
          if (!observed) {
            return withDesyncNote({
              success: false,
              output: '',
              error: `open_new_tab NOT verified — target ${newTargetId} not present in the real page list within 5s`,
            }, desyncNote(this.session, sinceTs));
          }
          logger.info('browser', `New tab created and verified: ${newTargetId} at ${observed.url}`);
          return withDesyncNote({
            success: true,
            output: `Opened new tab: ${observed.url} (target ${newTargetId} verified in the real page list).`,
            data: { targetId: newTargetId, url: observed.url },
          }, desyncNote(this.session, sinceTs));
        }

        case 'close_tab': {
          const sinceTs = Date.now();
          // Close the CURRENT authoritative page target through CDP and
          // VERIFY the disappearance — xdotool keyboard guessing cannot
          // prove which tab closed (or whether one closed at all).
          const cdp = await this.session.acquire();
          const targetId = cdp.getTargetId();
          if (!targetId) {
            return { success: false, output: '', error: 'close_tab failed — no page target attached' };
          }
          try {
            await cdp.send('Target.closeTarget', { targetId });
          } catch (e: any) {
            // The transport dying here is EXPECTED (we killed our own
            // page). Recovery/snapshot below decides the truth.
            logger.info('browser', `closeTarget transport closed (expected): ${e?.message ?? e}`);
          }
          this.session.release(); // intentional teardown — not a desync
          // VERIFY: the target is really gone from the REAL page list.
          const deadline = Date.now() + 5000;
          let gone = false;
          while (Date.now() < deadline) {
            try {
              const targets = await this.session.listTargets();
              gone = !targets.some((t) => t.targetId === targetId);
              if (gone) break;
            } catch { /* endpoint may be restarting — retry */ }
            await new Promise((r) => setTimeout(r, 250));
          }
          if (!gone) {
            return withDesyncNote({
              success: false,
              output: '',
              error: `close_tab NOT verified — target ${targetId} still present after close (5s)`,
            }, desyncNote(this.session, sinceTs));
          }
          return {
            success: true,
            output: `Closed tab (target ${targetId} verified gone from the real page list).`,
            data: { closedTargetId: targetId },
          };
        }

        case 'back':
        case 'forward': {
          const sinceTs = Date.now();
          let cdp = await this.session.acquire();
          // REAL history from CDP — never a blind alt+left key event, and
          // never a claim the result cannot verify (§9/§10).
          const history = await readHistory(cdp);
          const targetIndex = action === 'back' ? history.currentIndex - 1 : history.currentIndex + 1;
          const targetEntry = history.entries[targetIndex];
          if (history.currentIndex < 0 || !targetEntry) {
            return withDesyncNote({
              success: false,
              output: '',
              error: `${action} NOT possible — no ${action === 'back' ? 'earlier' : 'later'} history entry (real index ${history.currentIndex}, ${history.entries.length} entries)`,
              data: {
                verification: {
                  status: 'FAILURE', method: 'history-index',
                  evidence: { currentIndex: history.currentIndex, entries: history.entries.length },
                  confidence: 0.9, detail: 'No history entry in that direction',
                },
              },
            }, desyncNote(this.session, sinceTs));
          }
          const expectedUrl = String(targetEntry.url ?? '');
          this.session.recordNavigation(expectedUrl);
          await cdp.send('Page.navigateToHistoryEntry', { entryId: targetEntry.id });
          // VERIFY the REAL outcome: the location must match the entry AND
          // the history index must actually have moved there (a same-URL
          // entry still has to prove movement).
          let v = await verifyUrl(cdp, expectedUrl, this.navVerifyMs);
          if (v.status === 'UNKNOWN') {
            // Desync contract: UNKNOWN → reacquire → observe → verify.
            try {
              cdp = await this.session.reacquire();
              v = await verifyUrl(cdp, expectedUrl, Math.min(this.navVerifyMs, 4000));
            } catch (e: any) {
              v = {
                status: 'UNKNOWN', method: 'url-match', evidence: null, confidence: 0,
                detail: `Reacquire after desync failed: ${e?.message ?? e} — URL unverified`,
              };
            }
          }
          let movedIndex: number | null = null;
          try { movedIndex = (await readHistory(cdp)).currentIndex; } catch { movedIndex = null; }
          const indexVerified = movedIndex === targetIndex;
          const desync = desyncNote(this.session, sinceTs);
          if (v.status === 'SUCCESS' && indexVerified) {
            const loc = v.evidence as unknown as Located | null;
            return withDesyncNote({
              success: true,
              output: `${action === 'back' ? 'Went back' : 'Went forward'} to ${loc?.url ?? expectedUrl} (history index ${targetIndex} + URL verified).`,
              data: { verification: v, historyIndex: targetIndex },
            }, desync);
          }
          const reason = v.status !== 'SUCCESS'
            ? v.detail
            : `URL matched but the real history index is ${movedIndex ?? 'unreadable'} (expected ${targetIndex})`;
          return withDesyncNote({
            success: false,
            output: '',
            error: `${action} NOT verified — ${reason}`,
            data: {
              verification: {
                status: v.status === 'SUCCESS' ? 'FAILURE' : v.status,
                method: 'history-navigation',
                evidence: {
                  url: (v.evidence as unknown as Located | null)?.url ?? null,
                  expectedUrl, currentIndex: movedIndex, targetIndex,
                },
                confidence: v.status === 'SUCCESS' ? 0.85 : v.confidence,
                detail: reason,
              },
            },
          }, desync);
        }

        case 'refresh': {
          const sinceTs = Date.now();
          const cdp = await this.session.acquire();
          // REAL reload evidence: a reload replaces the JS context, so a
          // marker planted beforehand MUST disappear. "Page.reload was
          // sent" is never reported as "the page reloaded" (§10).
          const marker = `blx_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          let planted = false;
          try {
            await cdp.eval<boolean>(
              `(() => { window.__blaxinReloadMarker = ${JSON.stringify(marker)}; return true; })()`,
            );
            planted = true;
          } catch { planted = false; }
          if (!planted) {
            return withDesyncNote({
              success: false, output: '',
              error: 'refresh NOT verified — could not plant a reload baseline (page unobservable)',
              data: {
                verification: {
                  status: 'UNKNOWN', method: 'reload-marker', evidence: null, confidence: 0,
                  detail: 'Pre-reload baseline marker could not be set',
                },
              },
            }, desyncNote(this.session, sinceTs));
          }
          await cdp.send('Page.reload', { ignoreCache: false });
          const deadline = Date.now() + this.reloadVerifyMs;
          let observed: { marker: string | null; url: string; title: string } | null = null;
          let reloaded = false;
          while (Date.now() < deadline) {
            try {
              const state = await cdp.eval<{ marker: string | null; url: string; title: string }>(
                `(() => ({ marker: window.__blaxinReloadMarker ?? null, url: location.href, title: document.title }))()`,
              );
              if (state && typeof state.url === 'string') {
                observed = state;
                // Fresh document ⇒ our marker is gone.
                if (state.marker !== marker) { reloaded = true; break; }
              }
            } catch { /* document being replaced — keep polling */ }
            await sleepMs(250);
          }
          const desync = desyncNote(this.session, sinceTs);
          if (!reloaded) {
            return withDesyncNote({
              success: false, output: '',
              error: `refresh NOT verified — the page context survived the reload (real URL ${observed?.url ?? 'unreadable'})`,
              data: {
                verification: {
                  status: 'FAILURE', method: 'reload-marker', evidence: observed, confidence: 0.85,
                  detail: 'Pre-reload marker still present after the reload window',
                },
              },
            }, desync);
          }
          return withDesyncNote({
            success: true,
            output: `Refreshed ${observed?.url ?? 'the page'} — fresh document observed (title: "${observed?.title ?? ''}").`,
            data: {
              verification: {
                status: 'SUCCESS', method: 'reload-marker', evidence: observed, confidence: 0.9,
                detail: 'Pre-reload marker cleared — the document really reloaded',
              },
            },
          }, desync);
        }

        case 'current_url':
        case 'page_title': {
          const sinceTs = Date.now();
          let cdp = await this.session.acquire();
          const read = async (): Promise<{ url: string; title: string } | null> => {
            try {
              const loc = await cdp.eval<{ url: string; title: string }>(
                '(() => ({ url: location.href, title: document.title }))()',
              );
              return loc && typeof loc.url === 'string' ? loc : null;
            } catch {
              return null;
            }
          };
          let loc = await read();
          if (!loc) {
            // Desync contract: UNKNOWN → reacquire → observe again.
            try {
              cdp = await this.session.reacquire();
              loc = await read();
            } catch { loc = null; }
          }
          const desync = desyncNote(this.session, sinceTs);
          if (!loc) {
            return withDesyncNote({
              success: false, output: '',
              error: `Could not read the page ${action === 'page_title' ? 'title' : 'URL'} — the page is not observable`,
            }, desync);
          }
          return withDesyncNote({
            success: true,
            output: action === 'current_url'
              ? `Current URL: ${loc.url}`
              : `Page title: "${loc.title}" (${loc.url})`,
            data: { url: loc.url, title: loc.title },
          }, desync);
        }

        case 'list_tabs': {
          // Read-only: query the REAL page-target list without launching or
          // navigating anything (no side effects when no browser is up).
          let targets;
          try {
            targets = await this.session.listTargets();
          } catch (e: any) {
            return {
              success: false, output: '',
              error: `list_tabs NOT verified — could not reach the browser's debugging endpoint: ${e?.message ?? e}`,
            };
          }
          if (targets.length === 0) {
            return { success: true, output: 'No open browser tabs found.', data: { tabs: [] } };
          }
          const lines = targets.map((t, i) => `${i + 1}. ${t.title ? `"${t.title}" — ` : ''}${t.url} (target ${t.targetId})`);
          return {
            success: true,
            output: `${targets.length} open tab(s):\n${lines.join('\n')}`,
            data: { tabs: targets },
          };
        }

        default:
          return { success: false, output: '', error: `Unknown browser action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, output: '', error: `Browser error: ${error.message}` };
    }
  }

  requiresConfirmation(args: Record<string, unknown>): boolean {
    // Navigation/state-changing actions are always gated. Read-only
    // observations (current URL, title, tab list) change nothing, so they
    // follow the same convention as the filesystem's read/list operations.
    return !READ_ONLY_ACTIONS.has(String(args.action ?? ''));
  }
}

/** Loose location match for tab verification (host + path). */
function urlMatchesLocation(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    return a.host === e.host && a.pathname === e.pathname;
  } catch {
    return actual === expected;
  }
}
