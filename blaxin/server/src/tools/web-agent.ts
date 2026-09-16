// BLAXIN web agent tool — grounded, verified browser actions
// =============================================================
// The agency's BROWSER worker surface: semantic targeting over the real
// DOM (CDP), observe→act→re-observe loop, adaptive scroll, and real
// verification (playback = video element state, NOT "play clicked").
// Coordinates are the actuator; semantic identity is the intent.
// Additive to the legacy browser tool, which stays untouched.
//
// Session + verification (directive §22/§23/§25/§27/§28):
//   - ALL page access goes through the ONE authoritative BrowserSession
//     (no per-action re-attach to "the first tab").
//   - Outcomes use tri-state verification primitives; UNKNOWN never
//     becomes SUCCESS, and failures carry the observed evidence.
//   - Navigation is verified with real URL evidence — a chrome-error
//     page or about:blank regression is an honest FAILURE, never success.
// =============================================================

import { Tool, ToolResult } from '../types.js';
import {
  PageEval, snapshotInteractives, findTarget, clickTarget, typeIntoSearch,
  adaptiveScroll, InteractiveElement, fillField, setCheckbox, pressEnter,
  launchWithCdp,
} from './cdp-browser.js';
import {
  verifyUrl, verifyPlaybackTri, VerifyStatus, Verification, verifyPageTransition,
} from './verification.js';
import { browserSession, desyncNote, withDesyncNote } from './browser-session.js';
import { logger } from '../utils/logger.js';

const YT_SEARCH_URL = 'https://www.youtube.com/results?search_query=';
const YT_URL = 'https://www.youtube.com/';

/**
 * Bounded wait windows (ms). Exported so deterministic tests can shorten
 * them WITHOUT touching the honesty logic — production values are what
 * real navigation/playback need.
 */
export const WEB_AGENT_TIMING = {
  navVerifyMs: 8000,
  playVerifyMs: 10000,
  verifyOnlyMs: 5000,
  clickSettleMs: 900,
  formSettleMs: 800,
  downloadTimeoutMs: 30000,
};

export class WebAgentTool implements Tool {
  name = 'blaxin_web';
  description =
    'Grounded web automation with real verification: open a page, list visible interactive elements, ' +
    'click/type by SEMANTIC description (real DOM grounding with confidence), adaptively scroll until a ' +
    'target is found or a boundary is reached, fill multi-field forms with per-field read-back verification, ' +
    'submit forms with real outcome verification, trigger and verify downloads (file exists on disk with ' +
    'read-back size match), and verify YouTube playback by real video state. ' +
    'Actions: open, snapshot, click, type, scroll, fill_form, form_submit, download, youtube_search, youtube_play, verify_playback, state.';

  definition = {
    type: 'function' as const,
    function: {
      name: 'blaxin_web',
      description:
        'Grounded browser automation: open pages, semantically click/type into the REAL page DOM, ' +
        'adaptively scroll, and verify YouTube playback by the actual video element state. ' +
        'Use this instead of blind computer-control clicks inside the browser.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open', 'snapshot', 'click', 'type', 'scroll', 'fill_form', 'form_submit', 'download', 'youtube_search', 'youtube_play', 'verify_playback', 'state'],
            description: 'The grounded web action to perform',
          },
          url: { type: 'string', description: 'URL to open (action=open)' },
          target: {
            type: 'string',
            description: 'Semantic description of the element (click/type/scroll), e.g. "Search" button or "video result 1"',
          },
          text: { type: 'string', description: 'Text to type (action=type or youtube_search)' },
          query: { type: 'string', description: 'Video/song to search on YouTube (youtube_search, youtube_play)' },
          fields: {
            type: 'array',
            description: 'Form fields for fill_form: [{ target, value, check? }] — semantic element descriptions with the value to enter (check = desired checkbox/radio state).',
            items: {
              type: 'object',
              properties: {
                target: { type: 'string', description: 'Semantic description of the field, e.g. "Email" input' },
                value: { type: 'string', description: 'Text to enter, or the option label/value for a <select>, or "true"/"false" for a checkbox' },
                check: { type: 'boolean', description: 'Desired checked state for checkbox/radio fields' },
              },
              required: ['target', 'value'],
            },
          },
          submit: { type: 'boolean', description: 'After fill_form, also press Enter/submit the form (default false)' },
          directory: { type: 'string', description: 'Directory for downloads (action=download); defaults to the user Downloads folder' },
          filename: { type: 'string', description: 'Expected filename for download verification (defaults to the suggested filename)' },
          confirm: { type: 'boolean', description: 'Force a confirm() dialog outcome (action=form_submit); default true' },
          direction: { type: 'string', enum: ['down', 'up'], description: 'Scroll direction (default down)' },
          maxSteps: { type: 'number', description: 'Max adaptive scroll steps (default 8)' },
          minConfidence: { type: 'number', description: 'Minimum grounding confidence 0-1 (default 0.55)' },
          pick: { type: 'number', description: 'Element index from the last snapshot (click/type fallback)' },
        },
        required: ['action'],
      },
    },
  };

  /** Bounded per-snapshot element cache (bounded per directive §27). */
  private lastSnapshot: InteractiveElement[] = [];
  private lastSnapshotAt = 0;

  private cacheSnapshot(els: InteractiveElement[]): void {
    this.lastSnapshot = els.slice(0, 200);
    this.lastSnapshotAt = Date.now();
  }

  /** Any navigation (verified or not) invalidates cached element identity. */
  private invalidateSnapshot(): void {
    this.lastSnapshot = [];
    this.lastSnapshotAt = 0;
  }

  private snapshotUsable(): boolean {
    return this.lastSnapshot.length > 0 && Date.now() - this.lastSnapshotAt < 15000;
  }

  /**
   * Ground a semantic target: prefer the current live DOM snapshot; fall
   * back to the bounded cache within its validity window (≤15s) since a
   * fresh snapshot is one extra page round-trip.
   */
  private async ground(
    cdp: PageEval,
    targetDesc: string,
    minConfidence: number,
  ): Promise<{ target: ReturnType<typeof findTarget>; source: 'live' | 'cache' }> {
    const live = await snapshotInteractives(cdp);
    this.cacheSnapshot(live);
    const liveTarget = findTarget(live, targetDesc, minConfidence);
    if (liveTarget) return { target: liveTarget, source: 'live' };
    if (this.snapshotUsable()) {
      const cached = findTarget(this.lastSnapshot, targetDesc, minConfidence);
      if (cached) return { target: cached, source: 'cache' };
    }
    return { target: null, source: 'live' };
  }

  /** Honest ToolResult from a tri-state verification (§28: carry the evidence). */
  private verificationResult(
    action: string,
    v: Verification<unknown>,
    successOutput: string,
  ): ToolResult {
    if (v.status === 'SUCCESS') {
      return { success: true, output: successOutput || v.detail, data: { verification: v } };
    }
    return {
      success: false,
      output: '',
      error: `${action} NOT verified — ${v.detail}`,
      data: { verification: { method: v.method, status: v.status, evidence: v.evidence, confidence: v.confidence } },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = String(args.action ?? '');
    const minConfidence = typeof args.minConfidence === 'number' ? args.minConfidence : 0.55;

    try {
      switch (action) {
        // ── Navigation + perception ────────────────────────────────
        case 'open': {
          const url = String(args.url ?? '');
          if (!url) return { success: false, output: '', error: 'url is required for open' };
          let parsed: URL;
          try { parsed = new URL(url.startsWith('http') ? url : `https://${url}`); } catch {
            return { success: false, output: '', error: 'Invalid URL format' };
          }
          const targetUrl = parsed.toString();
          const sinceTs = Date.now();
          const cdp = await browserSession.acquire();
          await cdp.send('Page.navigate', { url: targetUrl });
          browserSession.recordNavigation(targetUrl);
          this.invalidateSnapshot();
          // Load-settle IS verification: poll the real location; a
          // chrome-error page or mismatched URL is an honest FAILURE.
          const v = await verifyUrl(cdp, targetUrl, WEB_AGENT_TIMING.navVerifyMs);
          const desync = desyncNote(browserSession, sinceTs);
          if (v.status === 'SUCCESS') {
            const loc = v.evidence as { url: string; title: string };
            return withDesyncNote({
              success: true,
              // Explicit identity evidence: the URL we OBSERVED is the URL
              // we asked for — page/context identity, not tool-call success.
              output: `Navigated to ${targetUrl} — OBSERVED at ${loc.url}, title "${loc.title}" (URL verified). Run action=snapshot to see real clickable elements.`,
              data: { verification: v },
            }, desync);
          }
          // FAILURE or UNKNOWN — never a fabricated success (§68).
          return withDesyncNote(this.verificationResult('open', v, ''), desync);
        }

        case 'snapshot': {
          const cdp = await browserSession.acquire();
          const els = await snapshotInteractives(cdp);
          this.cacheSnapshot(els);
          const state = await this.readState(cdp);
          if (els.length === 0) {
            return { success: true, output: `No visible interactive elements on ${state.url}.`, data: { elements: [], ...state } };
          }
          const lines = els.slice(0, 40).map((e) =>
            `[${e.index}] ${e.role}${e.ariaLabel ? ` aria="${e.ariaLabel}"` : ''}${e.text ? ` text="${e.text.slice(0, 60)}"` : ''}${e.href ? ` → ${e.href.slice(0, 70)}` : ''}`
          );
          return {
            success: true,
            output: `${state.url} ("${state.title}") — ${els.length} visible interactive elements (first 40):\n${lines.join('\n')}`,
            data: { elements: els, ...state },
          };
        }

        case 'state': {
          const cdp = await browserSession.acquire();
          const state = await this.readState(cdp);
          return { success: true, output: `URL: ${state.url} — title: "${state.title}"`, data: state };
        }

        // ── Grounded actions ──────────────────────────────────────
        case 'click': {
          const desc = String(args.target ?? '');
          const idx = typeof args.pick === 'number' ? args.pick : null;
          if (!desc && idx === null) return { success: false, output: '', error: 'target (semantic description) or pick (index) is required' };
          const cdp = await browserSession.acquire();

          let target = desc ? (await this.ground(cdp, desc, minConfidence)).target : null;
          if (!target && idx !== null && this.snapshotUsable()) {
            const el = this.lastSnapshot.find((e) => e.index === idx);
            if (el) {
              target = {
                element: el,
                point: { x: Math.round(el.rect.x + el.rect.width / 2), y: Math.round(el.rect.y + el.rect.height / 2) },
                confidence: 1,
                reason: 'explicit snapshot index',
              };
            }
          }
          if (!target) {
            return {
              success: false,
              output: '',
              error: `No confident match for "${desc || `index ${idx}`}" — run action=snapshot to see real elements (grounding refused to guess).`,
            };
          }
          const ok = await clickTarget(cdp, target);
          if (!ok) return { success: false, output: '', error: 'Grounded element vanished before click (page changed) — re-run snapshot and retry.' };
          await new Promise((r) => setTimeout(r, WEB_AGENT_TIMING.clickSettleMs));
          const state = await this.readState(cdp);
          // TEMPORAL VERIFICATION: a click is a claim about a STATE
          // TRANSITION, not about the tool call returning. The REAL
          // observable transition is URL identity (most common effect of
          // a click on a link/button that navigates). Record the intended
          // URL as the navigation so the next acquire() revalidates
          // against the page we EXPECT — and report the observed URL
          // alongside the confidence, so the model can judge honestly.
          if (target.element.href) {
            browserSession.recordNavigation(target.element.href);
            this.invalidateSnapshot();
          }
          return {
            success: true,
            output: `Clicked "${target.element.text || target.element.ariaLabel || desc}" (confidence ${target.confidence.toFixed(2)}, ${target.reason}). Now at ${state.url} — "${state.title}".`,
            data: { confidence: target.confidence, reason: target.reason, ...state },
          };
        }

        case 'type': {
          const desc = String(args.target ?? '');
          const text = String(args.text ?? '');
          if (!desc || !text) return { success: false, output: '', error: 'target and text are required' };
          const cdp = await browserSession.acquire();
          const { target } = await this.ground(cdp, desc, minConfidence);
          if (!target) {
            return { success: false, output: '', error: `No confident match for "${desc}" — run action=snapshot.` };
          }
          const ok = await typeIntoSearch(cdp, target, text);
          if (!ok) return { success: false, output: '', error: 'Could not type into the grounded element.' };
          return { success: true, output: `Typed ${text.length} chars into "${desc}" (confidence ${target.confidence.toFixed(2)}).` };
        }

        case 'scroll': {
          const cdp = await browserSession.acquire();
          const desc = args.target ? String(args.target) : null;
          const steps = await adaptiveScroll(cdp, desc, {
            direction: args.direction === 'up' ? 'up' : 'down',
            maxSteps: typeof args.maxSteps === 'number' ? args.maxSteps : 8,
            minConfidence,
          });
          const last = steps[steps.length - 1];
          const total = steps.reduce((a, s) => a + (s.scrolledPx ?? 0), 0);
          return {
            success: true,
            output: `Adaptive scroll: ${steps.length} step(s), ${total}px total, outcome ${last?.outcome ?? 'UNKNOWN'}${last?.target ? ` — target found (confidence ${last.target.confidence.toFixed(2)})` : ''}.`,
            data: { steps, outcome: last?.outcome },
          };
        }

        // ── YouTube skill (deterministic + verified) ───────────────
        case 'youtube_search': {
          const query = String(args.query ?? args.text ?? '');
          if (!query) return { success: false, output: '', error: 'query is required' };
          const sinceTs = Date.now();
          const cdp = await browserSession.acquire();
          const searchUrl = YT_SEARCH_URL + encodeURIComponent(query);
          await cdp.send('Page.navigate', { url: searchUrl });
          browserSession.recordNavigation(searchUrl);
          this.invalidateSnapshot();
          const v = await verifyUrl(cdp, YT_URL, WEB_AGENT_TIMING.navVerifyMs);
          const desync = desyncNote(browserSession, sinceTs);
          if (v.status === 'FAILURE') return withDesyncNote(this.verificationResult('youtube_search', v, ''), desync);
          // UNKNOWN navigation still allowed a snapshot attempt below —
          // honest either way: no results ⇒ real failure, never a guess.
          const els = await snapshotInteractives(cdp);
          this.cacheSnapshot(els);
          const results = this.extractVideoResults(els);
          if (results.length === 0) {
            return { success: false, output: '', error: 'YouTube search results did not load any video links (page layout change or bot-wall) — honest failure, no guessing.' };
          }
          const lines = results.slice(0, 8).map((v2, i) => `[${i}] ${v2.title} (${v2.href})`);
          return withDesyncNote({ success: true, output: `Top results for "${query}":\n${lines.join('\n')}`, data: { results } }, desync);
        }

        case 'youtube_play': {
          const query = String(args.query ?? '');
          if (!query) return { success: false, output: '', error: 'query is required' };
          const sinceTs = Date.now();
          const cdp = await browserSession.acquire();
          const searchUrl = YT_SEARCH_URL + encodeURIComponent(query);
          await cdp.send('Page.navigate', { url: searchUrl });
          browserSession.recordNavigation(searchUrl);
          this.invalidateSnapshot();
          const navV = await verifyUrl(cdp, YT_URL, WEB_AGENT_TIMING.navVerifyMs);
          const desync = desyncNote(browserSession, sinceTs);
          if (navV.status === 'FAILURE') return withDesyncNote(this.verificationResult('youtube_play', navV, ''), desync);
          const els = await snapshotInteractives(cdp);
          this.cacheSnapshot(els);
          const results = this.extractVideoResults(els);
          if (results.length === 0) {
            return { success: false, output: '', error: 'No video results found — honest failure.' };
          }
          // The FIRST result is the semantic intent for a play request.
          const first = results[0];
          const target = findTarget(els, first.title, 0.5);
          if (!target) {
            return { success: false, output: '', error: 'Result element could not be grounded — honest failure.' };
          }
          const ok = await clickTarget(cdp, target);
          if (!ok) return withDesyncNote({ success: false, output: '', error: 'Click on the result did not land — honest failure.' }, desyncNote(browserSession, sinceTs));
          browserSession.recordNavigation(first.href);
          this.invalidateSnapshot();
          // TEMPORAL VERIFICATION (§26): the click's INTENDED state
          // transition is landing on the result's watch page. Observe the
          // real URL — a click that never navigated is an honest FAILURE
          // even before playback is checked.
          const urlV = await verifyUrl(cdp, first.href, WEB_AGENT_TIMING.navVerifyMs);
          if (urlV.status !== 'SUCCESS') {
            return withDesyncNote(
              this.verificationResult('youtube_play', {
                ...urlV,
                detail: `Click did not reach the video page (${urlV.detail})`,
              }, ''),
              desyncNote(browserSession, sinceTs),
            );
          }
          // VERIFY: playback = real video element state, never "we clicked".
          const v = await verifyPlaybackTri(cdp, WEB_AGENT_TIMING.playVerifyMs);
          return withDesyncNote(this.verificationResult('youtube_play', v, ''), desyncNote(browserSession, sinceTs));
        }

        // ── Form filling — per-field read-back verification ───────
        case 'fill_form': {
          const raw = args.fields;
          if (!Array.isArray(raw) || raw.length === 0) {
            return { success: false, output: '', error: 'fields array is required for fill_form ([{ target, value, check? }])' };
          }
          if (raw.length > 20) {
            return { success: false, output: '', error: `Too many form fields (${raw.length}) — the bounded cap is 20.` };
          }
          const fields = raw as Array<{ target?: unknown; value?: unknown; check?: unknown }>;
          const sinceTs = Date.now();
          const cdp = await browserSession.acquire();
          const results: Array<{ target: string; ok: boolean; observed: string; confidence?: number; reason?: string }> = [];
          let allOk = true;
          let failures = 0;
          for (let i = 0; i < fields.length; i++) {
            const f = fields[i];
            const desc = typeof f.target === 'string' ? f.target : '';
            const value = typeof f.value === 'string' ? f.value : String(f.value ?? '');
            if (!desc) {
              results.push({ target: `#${i}`, ok: false, observed: '', reason: 'missing target description' });
              allOk = false;
              failures++;
              continue;
            }
            try {
              const { target } = await this.ground(cdp, desc, minConfidence);
              if (!target) {
                results.push({ target: desc, ok: false, observed: '', reason: 'no confident grounding — run action=snapshot' });
                allOk = false;
                failures++;
                continue;
              }
              const isCheckable = /checkbox|radio/i.test(`${target.element.role} ${target.element.tag}`);
              if (isCheckable || typeof f.check === 'boolean') {
                const want = typeof f.check === 'boolean' ? f.check : value.toLowerCase() === 'true';
                const rb = await setCheckbox(cdp, target, want);
                if (!rb.ok || rb.checked !== want) {
                  results.push({ target: desc, ok: false, observed: String(rb.checked), confidence: target.confidence, reason: `read-back ${rb.checked} ≠ wanted ${want} (${rb.reason})` });
                  allOk = false;
                  failures++;
                  continue;
                }
                results.push({ target: desc, ok: true, observed: String(rb.checked), confidence: target.confidence });
                continue;
              }
              const rb = await fillField(cdp, target, value);
              if (!rb.ok) {
                results.push({ target: desc, ok: false, observed: rb.value, confidence: target.confidence, reason: rb.reason });
                allOk = false;
                failures++;
                continue;
              }
              const vNorm = value.replace(/\s+/g, ' ').trim();
              const oNorm = rb.value.replace(/\s+/g, ' ').trim();
              // A <select> has TWO real identities: the option's machine
              // value AND its visible label. The user may legitimately
              // name either ("Support" or "support"); the read-back must
              // match one of them EXACTLY — case is never normalized away.
              const labelNorm = rb.optionText !== null ? rb.optionText.replace(/\s+/g, ' ').trim() : null;
              const matched = oNorm === vNorm || (labelNorm !== null && (labelNorm === vNorm || rb.value === value));
              if (!matched) {
                results.push({ target: desc, ok: false, observed: rb.value, confidence: target.confidence, reason: `read-back mismatch: "${rb.value.slice(0, 80)}" ≠ wanted "${value.slice(0, 80)}"` });
                allOk = false;
                failures++;
                continue;
          }
              results.push({ target: desc, ok: true, observed: rb.value === value ? String(rb.value.length) + ' chars' : rb.optionText ? `option "${rb.optionText}"` : String(rb.value.length) + ' chars', confidence: target.confidence });
            } catch (e: any) {
              results.push({ target: desc, ok: false, observed: '', reason: `page evaluation failed: ${e?.message ?? e}` });
              allOk = false;
              failures++;
            }
          }
          await new Promise((r) => setTimeout(r, WEB_AGENT_TIMING.formSettleMs));
          const desync = desyncNote(browserSession, sinceTs);
          const summary = results.map((r) => `${r.ok ? '✓' : '✗'} "${r.target}" → ${r.ok ? r.observed : (r.reason ?? 'failed')}`).join('; ');
          if (!allOk) {
            return withDesyncNote({
              success: false,
              output: '',
              error: `fill_form NOT verified — ${failures}/${fields.length} field(s) failed read-back. ${summary}`,
              data: { fields: results },
            }, desync);
          }
          // Optional submit rides the SAME result (one honest outcome).
          if (args.submit === true) {
            const submitResult = await this.execute({ ...args, action: 'form_submit' });
            return {
              success: submitResult.success,
              output: `Form filled (${fields.length}/${fields.length} fields verified): ${summary}. ${submitResult.output || submitResult.error || ''}`.trim(),
              error: submitResult.success ? undefined : submitResult.error,
              data: { fields: results, submit: submitResult.data ?? null },
            };
          }
          return withDesyncNote({
            success: true,
            output: `Form filled and verified (${fields.length}/${fields.length} fields read back): ${summary}.`,
            data: { fields: results },
          }, desync);
        }

        // ── Form submission — real outcome verification ───────────
        case 'form_submit': {
          const desc = String(args.target ?? '');
          const sinceTs = Date.now();
          const cdp = await browserSession.acquire();
          const origin = await this.readState(cdp);
          let clicked = false;
          let clickDetail = '';
          if (desc) {
            const { target } = await this.ground(cdp, desc, minConfidence);
            if (!target) {
              return { success: false, output: '', error: `No confident match for submit button "${desc}" — run action=snapshot.` };
            }
            const ok = await clickTarget(cdp, target);
            if (!ok) return { success: false, output: '', error: 'Submit button vanished before click (page changed) — re-run snapshot and retry.' };
            clicked = true;
            clickDetail = `clicked "${target.element.text || target.element.ariaLabel || desc}" (confidence ${target.confidence.toFixed(2)})`;
          } else {
            // No button named: press Enter in the focused field (native
            // form submit for the enclosing form), as a human would.
            const ok = await pressEnter(cdp);
            if (!ok) return { success: false, output: '', error: 'Could not dispatch the form submit (Enter) — page unobservable.' };
            clicked = true;
            clickDetail = 'pressed Enter on the focused field';
          }
          browserSession.invalidate('form submission — page context may navigate');
          this.invalidateSnapshot();
          const cdpAfter = await browserSession.acquire();
          const v = await verifyPageTransition(cdpAfter, { originUrl: origin.url, waitMs: WEB_AGENT_TIMING.navVerifyMs });
          const desync = desyncNote(browserSession, sinceTs);
          if (v.status === 'SUCCESS') {
            const ev = v.evidence as { navigated: boolean; url: string | null; successText: string | null };
            return withDesyncNote({
              success: true,
              output: `Form submitted — ${clickDetail}. Outcome VERIFIED: ${v.detail}.`,
              data: { verification: v, evidence: ev, origin: origin.url },
            }, desync);
          }
          return withDesyncNote(this.verificationResult('form_submit', v, ''), desync);
    }

        // ── Downloads — trigger + filesystem read-back verification ──
        case 'download': {
          const desc = String(args.target ?? '');
          if (!desc) return { success: false, output: '', error: 'target (semantic description of the download link/button) is required' };
          const directory = typeof args.directory === 'string' && args.directory.trim() ? args.directory.trim() : defaultDownloadDir();
          const expectedName = typeof args.filename === 'string' && args.filename.trim() ? args.filename.trim() : null;
          const sinceTs = Date.now();
          const cdp = await browserSession.acquire();
          const { target } = await this.ground(cdp, desc, minConfidence);
          if (!target) {
            return { success: false, output: '', error: `No confident match for "${desc}" — run action=snapshot.` };
          }
          // The download directory must exist BEFORE the click — a missing
          // dir is an honest FAILURE, not a silent save to an unintended place.
          const mkdir = await this.makeDirViaFsTool(directory);
          if (!mkdir.ok) return { success: false, output: '', error: `Download directory ${directory} is not usable: ${mkdir.error}` };
          await this.enableCdpDownloads(cdp, directory);
          const pre = await this.scanDownloadDir(directory, 400);
          const before = new Set(pre.map((f) => f.name));
          const suggested = target.element.href ? this.filenameFromHref(target.element.href) : null;
          const ok = await clickTarget(cdp, target);
          if (!ok) return { success: false, output: '', error: 'Download trigger vanished before click (page changed) — re-run snapshot and retry.' };
          const clickDetail = `clicked "${target.element.text || target.element.ariaLabel || desc}" (confidence ${target.confidence.toFixed(2)})`;
          // NO invalidate here: the DevTools session owns the download
          // routing — closing it drops the override mid-download (observed
          // on real Chrome: the file lands in the default dir or nowhere).
          // A Content-Disposition download does not navigate; if a site
          // does navigate, the next acquire() revalidates honestly.
          this.invalidateSnapshot();
          // POLL THE REAL FILESYSTEM: the new file must REALLY appear and
          // grow into a stable size (read-back, not an event claim).
          const deadline = Date.now() + WEB_AGENT_TIMING.downloadTimeoutMs;
          let best: { name: string; path: string; size: number; stableMs: number } | null = null;
          let lastDetail = 'no new file appeared in the download directory';
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 600));
            const now = await this.scanDownloadDir(directory, 400);
            const fresh = now.filter((f) => !before.has(f.name));
            const named = expectedName ? fresh.filter((f) => f.name === expectedName) : fresh;
            if (named.length === 0) {
              lastDetail = expectedName
                ? `expected file "${expectedName}" not present yet (${fresh.length} new file(s) so far)`
                : `${fresh.length} new file(s) so far`;
              continue;
            }
            const pick = named[named.length - 1];
            if (pick.size > 0) {
              best = { ...pick, stableMs: 0 };
              break;
            }
            lastDetail = `"${pick.name}" is present but still 0 bytes`;
          }
          const desync = desyncNote(browserSession, sinceTs);
          if (!best) {
            return withDesyncNote({
              success: false, output: '',
              error: `download NOT verified — ${lastDetail} within ${WEB_AGENT_TIMING.downloadTimeoutMs / 1000}s (trigger: ${clickDetail || `"${desc}"`})`,
              data: { directory, suggestedFilename: suggested },
            }, desync);
          }
          // STABILITY: the size must hold through one more real poll —
          // an in-flight download grows; a finished one does not.
          await new Promise((r) => setTimeout(r, 800));
          const again = (await this.scanDownloadDir(directory, 400)).find((f) => f.name === best!.name);
          if (!again || again.size !== best.size) {
            return withDesyncNote({
              success: false, output: '',
              error: `download NOT verified — "${best.name}" is still changing in size (${best.size} → ${again?.size ?? 'gone'} bytes)`,
              data: { directory, suggestedFilename: suggested },
            }, desync);
          }
          logger.info('web-agent', `Download verified: ${best.path} (${best.size} bytes)`);
          return withDesyncNote({
            success: true,
            output: `Download VERIFIED: ${best.path} (${best.size} bytes, stable read-back) — trigger: ${clickDetail || `"${desc}"`}.`,
            data: {
              verification: {
                status: 'SUCCESS', method: 'download-file-verified',
                evidence: { path: best.path, name: best.name, size: best.size, directory }, confidence: 0.95,
                detail: `File ${best.name} exists with a stable non-zero size on disk`,
              },
              suggestedFilename: suggested,
            },
          }, desync);
        }

        case 'verify_playback': {
          const cdp = await browserSession.acquire();
          const v = await verifyPlaybackTri(cdp, WEB_AGENT_TIMING.verifyOnlyMs);
          return this.verificationResult('verify_playback', v, '');
        }

        default:
          return { success: false, output: '', error: `Unknown blaxin_web action: ${action}` };
      }
    } catch (error: any) {
      // A thrown CDP error means the session layer could not deliver a
      // usable page (or the page died mid-action). Surface the DIAGNOSTIC.
      return { success: false, output: '', error: `blaxin_web ${action} failed: ${error?.message ?? error}` };
    }
  }

  /** Real page state via the CDP — cheap, deterministic perception. */
  private async readState(cdp: PageEval): Promise<{ url: string; title: string }> {
    return cdp.eval<{ url: string; title: string }>(
      `(() => ({ url: location.href, title: document.title }))()`
    );
  }

  /** Real filename suggestion from a download link (never guessed later). */
  private filenameFromHref(href: string): string | null {
    try {
      const u = new URL(href, 'https://placeholder.invalid');
      const base = u.pathname.split('/').filter(Boolean).pop();
      return base ? decodeURIComponent(base) : null;
    } catch {
      return null;
    }
  }

  /**
   * Ensure the download directory exists via the REAL filesystem tool
   * (read-back verified create) — never a fabricated directory claim.
   */
  private async makeDirViaFsTool(dir: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const { FileSystemTool } = await import('./filesystem.js');
      const fs = new FileSystemTool();
      const r = await fs.execute({ operation: 'write', path: `${dir.replace(/\/+$/, '')}/.blaxin-download-probe`, content: '' });
      if (!r.success) return { ok: false, error: r.error ?? 'write probe failed' };
      // Read-back verified by the filesystem tool itself; remove the probe.
      await fs.execute({ operation: 'delete', path: `${dir.replace(/\/+$/, '')}/.blaxin-download-probe` });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  /** REAL directory scan for download verification (name, size, mtime). */
  private async scanDownloadDir(
    dir: string,
    maxEntries = 400,
  ): Promise<Array<{ name: string; path: string; size: number; mtimeMs: number }>> {
    try {
      const fsp = await import('fs/promises');
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const out: Array<{ name: string; path: string; size: number; mtimeMs: number }> = [];
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        if (out.length >= maxEntries) break;
        const full = `${dir.replace(/\/+$/, '')}/${ent.name}`;
        try {
          const st = await fsp.stat(full);
          out.push({ name: ent.name, path: full, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* vanished mid-scan — skip honestly */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Enable real CDP download routing into `dir` (Browser.setDownloadBehavior
   * with allowAndName). Best-effort: the filesystem verification below is
   * the actual proof; this only steers WHERE the file lands.
   */
  private async enableCdpDownloads(cdp: PageEval & { send?: (method: string, params?: Record<string, unknown>) => Promise<unknown> }, dir: string): Promise<void> {
    try {
      const send = cdp.send?.bind(cdp);
      if (!send) return;
      await send('Browser.setDownloadBehavior', {
        // 'allow' keeps the server's REAL suggested filename — the
        // filename the user was shown — so verification can name it.
        // ('allowAndName' would save GUID-named files.)
        behavior: 'allow',
        downloadPath: dir,
        eventsEnabled: true,
      });
      // Some Chromium builds only honor the PAGE-scoped method for the
      // attached page — set both; the filesystem read-back decides truth,
      // this only steers WHERE the bytes land.
      try {
        await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
      } catch { /* page-scoped method absent — Browser-level already set */ }
    } catch (e: any) {
      // Honest note only — the filesystem read-back below decides success.
      logger.info('web-agent', `CDP download routing unavailable (${e?.message ?? e}) — verification relies on the real filesystem scan`);
    }
  }

  /** Real video links from a snapshot (watch URLs only). */
  private extractVideoResults(els: InteractiveElement[]): Array<{ title: string; href: string }> {
    const seen = new Set<string>();
    const out: Array<{ title: string; href: string }> = [];
    for (const el of els) {
      if (!el.href || !el.href.includes('/watch?v=')) continue;
      if (seen.has(el.href)) continue;
      seen.add(el.href);
      const title = (el.ariaLabel || el.text || '').trim();
      if (!title) continue;
      out.push({ title: title.slice(0, 100), href: el.href.split('&')[0] });
      if (out.length >= 10) break;
    }
    return out;
  }

  requiresConfirmation(args: Record<string, unknown>): boolean {
    // Web actions act on the real machine (browser session) — the gate
    // decides; navigation + grounded clicks require approval by default.
    const action = String(args.action ?? '');
    return action !== 'snapshot' && action !== 'state' && action !== 'verify_playback';
  }
}

/** The user's real Downloads directory (honest fallback: home/Downloads). */
function defaultDownloadDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home ? `${home}/Downloads` : '/tmp/blaxin-downloads';
}
