// BLAXIN CDP browser controller — REAL perception + grounded action
// =============================================================
// Gives the existing agent a real perception→action→verify loop inside
// a Chromium page using the Chrome DevTools Protocol over the remote-
// debugging WebSocket:
//
//   OBSERVE   snapshotInteractives() — real DOM: role/aria/text/geometry
//   GROUND    findTarget() — semantic description → real element rect
//             with an honest confidence (exact/normalized text, aria,
//             role+placeholder, href); null when nothing matches
//   ACT       Runtime.evaluate dispatched REAL trusted-like input paths
//             (el.click() on the grounded element / keyboard events)
//   OBSERVE   post-action snapshot + URL/title — VERIFY against the
//             expected resulting state, never assume success
//   SCROLL    adaptive: observe viewport/content height each step, stop
//             on TARGET_FOUND / BOUNDARY_REACHED / MAX_STEPS
//   VERIFY    verifyPlayback() — YouTube playback = REAL video element
//             state (currentTime advances, !paused) — not "we clicked"
//
// Connection model (deterministic, no shell): launch chromium with
// --remote-debugging-port if no CDP endpoint answers, then attach to
// the page target via the /json list + ws. Bare "open" behavior of the
// legacy browser tool is untouched — this layer is additive.
// =============================================================

import WebSocket from 'ws';
import { execFile } from 'child_process';
import { logger } from '../utils/logger.js';

const CDP_PORT = Number(process.env.BLAXIN_CDP_PORT || 9222);
const CDP_HOST = '127.0.0.1';

/** Dependency-free bounded GET (Node global fetch). */
async function httpGet(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

/**
 * Structural seam: anything that can evaluate JS in the page. The CdpPage
 * class satisfies it; tests inject fakes.
 */
export interface PageEval {
  eval<T>(expression: string): Promise<T>;
}

export interface InteractiveElement {
  index: number;
  role: string;
  text: string;
  ariaLabel: string | null;
  placeholder: string | null;
  href: string | null;
  tag: string;
  /** Real viewport geometry (bounding client rect, viewport-relative). */
  rect: { x: number; y: number; width: number; height: number };
  /** REAL: does the element currently intersect the viewport? */
  inViewport: boolean;
  /** Grounding confidence for THIS element against the last query. */
  matchScore?: number;
  matchReason?: string;
}

export interface GroundedTarget {
  element: InteractiveElement;
  /** Center point of the REAL rect — the actuator coordinate. */
  point: { x: number; y: number };
  confidence: number;
  reason: string;
}

export interface ScrollStep {
  step: number;
  scrolledPx: number | null;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  /** Real page state after the scroll step. */
  outcome: 'TARGET_FOUND' | 'BOUNDARY_REACHED' | 'MAX_STEPS' | 'SCROLLED';
  target?: GroundedTarget;
}

export interface PlaybackState {
  playing: boolean;
  currentTime: number;
  duration: number;
  videoTitle: string | null;
}

// ── CDP transport (single page target, sequential commands) ──

interface CdpMessage { id?: number; method?: string; params?: any; result?: any; error?: { message: string } }

export class CdpPage {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  /** The REAL CDP target this connection is attached to (set at attach). */
  private targetId: string | null = null;

  /** REAL socket liveness — the session layer revalidates before reuse. */
  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Stable identity of the attached page target (session tracking). */
  getTargetId(): string | null {
    return this.targetId;
  }

  static async attach(url: string | null, timeoutMs = 5000): Promise<CdpPage> {
    const list = JSON.parse(await httpGet(`http://${CDP_HOST}:${CDP_PORT}/json`, timeoutMs)) as any[];
    const page = list.find((t) => t.type === 'page' && (url ? String(t.url).includes(url) : true))
      ?? list.find((t) => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) {
      throw new Error('No CDP page target found — is Chrome running with --remote-debugging-port?');
    }
    const cdp = new CdpPage();
    cdp.targetId = String(page.id);
    await cdp.connect(page.webSocketDebuggerUrl, timeoutMs);
    return cdp;
  }

  /** Attach to a SPECIFIC page target (stable identity across actions). */
  static async attachToTargetId(targetId: string, timeoutMs = 5000): Promise<CdpPage> {
    const list = JSON.parse(await httpGet(`http://${CDP_HOST}:${CDP_PORT}/json`, timeoutMs)) as any[];
    const page = list.find((t) => t.type === 'page' && String(t.id) === targetId);
    if (!page?.webSocketDebuggerUrl) {
      throw new Error(`CDP page target ${targetId} no longer exists (tab closed or browser restarted).`);
    }
    const cdp = new CdpPage();
    cdp.targetId = String(page.id);
    await cdp.connect(page.webSocketDebuggerUrl, timeoutMs);
    return cdp;
  }

  private connect(wsUrl: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('CDP WebSocket connect timeout'));
      }, timeoutMs);
      ws.on('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.on('message', (buf: WebSocket.RawData) => {
        let msg: CdpMessage;
        try { msg = JSON.parse(String(buf)); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      });
      ws.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Sequential CDP command (transport-level ordering). */
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP not connected'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression and return the JSON-serializable value. */
  async eval<T>(expression: string): Promise<T> {
    const res = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (res?.exceptionDetails) {
      const detail = res.exceptionDetails?.exception?.description || 'page evaluation failed';
      throw new Error(detail.slice(0, 300));
    }
    return (res?.result?.value ?? undefined) as T;
  }

  close(): void {
    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = null;
  }
}

// ── Perception: the REAL interactive element snapshot ──

const SNAPSHOT_JS = `
(() => {
  const sel = 'a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], [aria-label]';
  const els = [...document.querySelectorAll(sel)];
  return JSON.stringify(els.slice(0, 200).map((el, i) => {
    const r = el.getBoundingClientRect();
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    return {
      index: i,
      role,
      text: (el.innerText || el.textContent || '').trim().slice(0, 120),
      ariaLabel: el.getAttribute('aria-label'),
      placeholder: el.getAttribute('placeholder') || null,
      href: el.getAttribute('href') ? el.href : null,
      tag: el.tagName.toLowerCase(),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      inViewport: r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth,
    };
  }));
})()
`;

export async function snapshotInteractives(cdp: PageEval): Promise<InteractiveElement[]> {
  const raw = await cdp.eval<string>(SNAPSHOT_JS);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as InteractiveElement[];
  // Only elements that are actually visible/clickable in the viewport
  // reality — zero-size or off-screen elements are not real targets.
  return parsed.filter((e) => e.rect.width > 1 && e.rect.height > 1);
}

// ── Grounding: semantic description → real element + honest confidence ──

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function scoreElement(el: InteractiveElement, desc: string): { score: number; reason: string } | null {
  const d = norm(desc);
  if (!d) return null;
  const texts = [
    el.ariaLabel ?? '', el.text ?? '', el.placeholder ?? '', el.href ?? '',
  ].map(norm).filter(Boolean);

  let best: { score: number; reason: string } | null = null;
  const consider = (score: number, reason: string) => {
    if (!best || score > best.score) best = { score, reason };
  };

  for (const t of texts) {
    if (!t) continue;
    if (t === d) consider(0.95, `exact ${el.ariaLabel === desc ? 'aria-label' : 'text'} match`);
    else if (t.includes(d) || d.includes(t)) consider(0.75, 'substring text match');
    else {
      // Word-overlap (handles minor transcription differences).
      const dw = new Set(d.split(' ').filter((w) => w.length > 2));
      const tw = new Set(t.split(' '));
      const hits = [...dw].filter((w) => tw.has(w)).length;
      if (dw.size > 0 && hits / dw.size >= 0.6) {
        consider(0.55 + 0.2 * (hits / dw.size), 'word-overlap match');
      }
    }
  }
  return best;
}

export function findTarget(
  elements: InteractiveElement[],
  description: string,
  minConfidence = 0.55,
): GroundedTarget | null {
  let best: GroundedTarget | null = null;
  for (const el of elements) {
    const m = scoreElement(el, description);
    if (!m) continue;
    if (!best || m.score > best.confidence) {
      best = {
        element: { ...el, matchScore: m.score, matchReason: m.reason },
        point: {
          x: Math.round(el.rect.x + el.rect.width / 2),
          y: Math.round(el.rect.y + el.rect.height / 2),
        },
        confidence: m.score,
        reason: m.reason,
      };
    }
  }
  return best && best.confidence >= minConfidence ? best : null;
}

// ── Action: real dispatch against the GROUNDED element ──

export async function clickTarget(cdp: PageEval, target: GroundedTarget): Promise<boolean> {
  // Re-resolve the element by index at click time (page may have shifted)
  // and click the element itself — the coordinate is the actuator, the
  // semantic identity is the intent.
  return cdp.eval<boolean>(`
    (() => {
      const el = document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], [aria-label]')[${target.element.index}];
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()
  `);
}

export async function typeIntoSearch(
  cdp: PageEval,
  target: GroundedTarget,
  text: string,
): Promise<boolean> {
  const safe = JSON.stringify(text);
  return cdp.eval<boolean>(`
    (() => {
      // Same selector as the snapshot so index identity is preserved
      // (indexing a separate input-only list would misaddress).
      const all = document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], [aria-label]');
      const el = all[${target.element.index}];
      if (!el || !/^(input|textarea)$/i.test(el.tagName)) return false;
      el.focus();
      // Native setter so React/Vue value bindings actually observe it.
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ${safe}); else el.value = ${safe};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
}

// ── Form filling (per-field read-back verification) ──
// The honest contract: a fill is a CLAIM about element state, so every
// fill reads the value back from the DOM and reports what is REALLY
// there. "The setter was called" is never reported as "the field holds
// the text" (same rule as typeIntoSearch's native-setter dispatch).

export interface FillReadback {
  /** The fill was dispatched AND the element accepted a value. */
  ok: boolean;
  /** The REAL post-fill value read back from the element (never assumed). */
  value: string;
  /** For <select>: the selected option's visible text (label matching). */
  optionText: string | null;
  reason: string;
}

export async function fillField(
  cdp: PageEval,
  target: GroundedTarget,
  text: string,
): Promise<FillReadback> {
  // Data travels as JS literals (JSON.stringify is always syntactically
  // safe), NOT inside comments — a value containing `*/` would otherwise
  // terminate a comment mid-expression and corrupt the evaluation.
  const raw = await cdp.eval<string>(`
    (() => {
      const IDX = ${target.element.index}, WANT = ${JSON.stringify(text)};
      /* __blaxinFill */
      const all = document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], [aria-label]');
      const el = all[IDX];
      if (!el || !/^(input|textarea|select)$/i.test(el.tagName)) {
        return JSON.stringify({ ok: false, value: '', optionText: null, reason: 'element-not-fillable' });
      }
      try { el.scrollIntoView({ block: 'center' }); } catch { /* detached */ }
      el.focus();
      let applied = true;
      let optionText = null;
      if (/^select$/i.test(el.tagName)) {
        const want = String(WANT);
        const opts = [...el.options];
        const opt = opts.find((o) => o.value === want)
          || opts.find((o) => (o.textContent || '').trim() === want)
          || opts.find((o) => o.value.toLowerCase() === want.toLowerCase())
          || opts.find((o) => (o.textContent || '').trim().toLowerCase() === want.toLowerCase());
        if (!opt) {
          applied = false;
        } else {
          el.value = opt.value;
          optionText = (opt.textContent || '').trim();
        }
      } else {
        // Native setter so React/Vue value bindings actually observe it.
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, WANT); else el.value = WANT;
      }
      if (applied) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return JSON.stringify({ ok: applied, value: String(el.value ?? ''), optionText, reason: applied ? 'set' : 'option-not-found' });
    })()
  `);
  return JSON.parse(raw) as FillReadback;
}

export interface CheckReadback {
  ok: boolean;
  /** The REAL post-set checked state read back from the element. */
  checked: boolean | null;
  reason: string;
}

export async function setCheckbox(
  cdp: PageEval,
  target: GroundedTarget,
  checked: boolean,
): Promise<CheckReadback> {
  const raw = await cdp.eval<string>(`
    (() => {
      const IDX = ${target.element.index}, WANT = ${checked ? 'true' : 'false'};
      /* __blaxinCheck */
      const all = document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [role=link], [role=tab], [aria-label]');
      const el = all[IDX];
      if (!el || !/^input$/i.test(el.tagName) || !/^(checkbox|radio)$/i.test(String(el.type || ''))) {
        return JSON.stringify({ ok: false, checked: null, reason: 'element-not-checkable' });
      }
      try { el.scrollIntoView({ block: 'center' }); } catch { /* detached */ }
      el.checked = WANT;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ ok: true, checked: !!el.checked, reason: 'set' });
    })()
  `);
  return JSON.parse(raw) as CheckReadback;
}

export async function pressEnter(cdp: PageEval): Promise<boolean> {
  return cdp.eval<boolean>(`
    (() => {
      const el = document.activeElement || document.body;
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      const form = el.closest('form');
      if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
      return true;
    })()
  `);
}

// ── Adaptive scroll (directive §15) ──

export async function adaptiveScroll(
  cdp: PageEval,
  targetDescription: string | null,
  opts: { direction?: 'down' | 'up'; maxSteps?: number; stepPx?: number; minConfidence?: number } = {},
): Promise<ScrollStep[]> {
  const direction = opts.direction ?? 'down';
  const maxSteps = Math.max(1, Math.min(opts.maxSteps ?? 8, 20));
  const stepPx = Math.max(120, Math.min(opts.stepPx ?? 480, 2000));
  const minConfidence = opts.minConfidence ?? 0.55;
  const steps: ScrollStep[] = [];

  for (let i = 1; i <= maxSteps; i++) {
    // OBSERVE first — real heights drive the decision.
    const before = await cdp.eval<{ top: number; height: number; vh: number }>(
      `(() => ({ top: window.scrollY, height: document.documentElement.scrollHeight, vh: window.innerHeight }))()`
    );
    const atBoundary = direction === 'down'
      ? before.top + before.vh >= before.height - 2
      : before.top <= 2;

    // Ground the target in the CURRENT viewport. Only an element that is
    // REALLY in the viewport counts as found — off-screen elements are
    // groundable for clicks (scrollIntoView), but scroll-until-found must
    // not claim success for something the user cannot see yet.
    let target: GroundedTarget | null = null;
    if (targetDescription) {
      const els = await snapshotInteractives(cdp);
      const found = findTarget(els, targetDescription, minConfidence);
      target = found?.element.inViewport ? found : null;
      if (target) {
        steps.push({ step: i, scrolledPx: 0, scrollTop: before.top, scrollHeight: before.height, viewportHeight: before.vh, outcome: 'TARGET_FOUND', target });
        return steps;
      }
    }
    if (atBoundary) {
      steps.push({ step: i, scrolledPx: null, scrollTop: before.top, scrollHeight: before.height, viewportHeight: before.vh, outcome: 'BOUNDARY_REACHED' });
      return steps;
    }

    const delta = direction === 'down' ? stepPx : -stepPx;
    await cdp.eval<boolean>(`window.scrollBy({ top: ${delta}, behavior: 'instant' })`);
    // OBSERVE AGAIN — real post-scroll state; overshoot correction.
    const after = await cdp.eval<{ top: number; height: number; vh: number }>(
      `(() => ({ top: window.scrollY, height: document.documentElement.scrollHeight, vh: window.innerHeight }))()`
    );
    const scrolled = Math.abs(after.top - before.top);
    steps.push({ step: i, scrolledPx: scrolled, scrollTop: after.top, scrollHeight: after.height, viewportHeight: after.vh, outcome: 'SCROLLED' });
    if (scrolled === 0) {
      // Real boundary: the page did not move — stop instead of repeating.
      steps[steps.length - 1].outcome = 'BOUNDARY_REACHED';
      return steps;
    }
    if (i === maxSteps) {
      // Hard bound reached: mark the last REAL step instead of appending
      // a synthetic one (bounded = exactly maxSteps entries max).
      steps[steps.length - 1].outcome = 'MAX_STEPS';
      return steps;
    }
  }
  return steps;
}

// ── Verification (directive §18): real playback, not "we clicked play" ──

export async function verifyPlayback(cdp: PageEval, waitMs = 5000): Promise<PlaybackState> {
  const deadline = Date.now() + waitMs;
  let last: PlaybackState | null = null;
  while (Date.now() < deadline) {
    last = await cdp.eval<string | null>(`
      (() => {
        const v = document.querySelector('video');
        if (!v) return null;
        return JSON.stringify({
          playing: !!(v.currentTime > 0 && !v.paused && !v.ended && v.readyState > 2),
          currentTime: v.currentTime,
          duration: v.duration,
          videoTitle: document.title,
        });
      })()
    `).then((raw) => (raw ? (JSON.parse(raw) as PlaybackState) : null)).catch(() => null);
    if (last?.playing) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  return last ?? { playing: false, currentTime: 0, duration: 0, videoTitle: null };
}

// ── Endpoint management (deterministic; no shell interpolation) ──

export interface PageTargetSummary {
  targetId: string;
  url: string;
  title: string;
}

/** REAL /json page-target list — the session's source of target truth. */
export async function listPageTargets(timeoutMs = 2000): Promise<PageTargetSummary[]> {
  const raw = await httpGet(`http://${CDP_HOST}:${CDP_PORT}/json`, timeoutMs);
  const list = JSON.parse(raw) as any[];
  return list
    .filter((t) => t.type === 'page')
    .map((t) => ({ targetId: String(t.id), url: String(t.url ?? ''), title: String(t.title ?? '') }));
}

export async function isCdpAlive(timeoutMs = 1200): Promise<boolean> {
  try {
    await httpGet(`http://${CDP_HOST}:${CDP_PORT}/json/version`, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/** Launch Chromium with remote debugging (single instance, real flags). */
export async function launchWithCdp(chromiumPath = 'chromium'): Promise<void> {
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
  await new Promise<void>((resolve, reject) => {
    const child = execFile(chromiumPath, [
      `--remote-debugging-port=${CDP_PORT}`,
      '--user-data-dir=/tmp/blaxin-cdp-profile',
      '--no-first-run', '--no-default-browser-check',
      'about:blank',
    ], { env }, (error) => {
      // The browser process exiting is fine (user closed it); launch
      // failure (ENOENT) must reject so the caller can try alternates.
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') reject(error);
    });
    child.on('error', reject);
    // Detach: the browser outlives this request.
    child.unref();
    setTimeout(resolve, 1500);
  });
}

/** Ensure a CDP endpoint exists; returns the page connection. */
export async function ensureCdpPage(url: string | null): Promise<CdpPage> {
  if (!(await isCdpAlive())) {
    for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
      try {
        await launchWithCdp(bin);
        break;
      } catch { /* try next */ }
    }
    // Poll briefly for the endpoint to come up.
    for (let i = 0; i < 10 && !(await isCdpAlive()); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!(await isCdpAlive())) {
      throw new Error('Could not start a Chromium with remote debugging (CDP) — browser grounding unavailable.');
    }
  }
  logger.info('cdp-browser', `Attaching to CDP page target${url ? ` for ${url}` : ''}`);
  return CdpPage.attach(url);
}
