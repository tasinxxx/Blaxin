// BLAXIN verification engine — reusable, honest, tri-state (directive §27/§28)
// =============================================================
// Every primitive returns SUCCESS / FAILURE / UNKNOWN and NEVER converts
// UNKNOWN into SUCCESS. The distinction is evidence-based:
//   SUCCESS  — the expected state was actually observed
//   FAILURE  — the page was observably NOT in the expected state
//              (definitive negative evidence: element absent, state
//              unchanged after the full window, URL provably different)
//   UNKNOWN  — reality could not be observed at all (evaluation errors,
//              dead connection) — the honest answer when we do not know
// Each result carries the method used, the raw evidence, and a confidence
// so callers can report HOW they know, not just WHAT they claim.
// =============================================================

import { PageEval, snapshotInteractives, findTarget } from './cdp-browser.js';

export type VerifyStatus = 'SUCCESS' | 'FAILURE' | 'UNKNOWN';

export interface Verification<T = unknown> {
  status: VerifyStatus;
  /** How truth was determined (e.g. "url-match", "video-state"). */
  method: string;
  /** The last REAL observation, or null when nothing could be observed. */
  evidence: T | null;
  /** 0..1 — quality of the evidence behind the status. */
  confidence: number;
  /** Human-readable, honest summary (goes to model + HUD). */
  detail: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Normalized URL comparator: host (www-stripped) + pathname prefix.
 * A root-path expectation matches any page on the same host (host-level
 * verification for bare-domain navigations). When the expectation carries
 * query params (e.g. ?v=VIDEO_ID) they must ALL be present with equal
 * values — otherwise verifying one video could "succeed" on another
 * (false-success guard for the §24 playback benchmark).
 */
export function urlMatches(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual);
    const e = new URL(expected.startsWith('http') ? expected : `https://${expected}`);
    const host = (h: string) => h.replace(/^www\./, '');
    if (host(a.host) !== host(e.host)) return false;
    const path = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
    const want = path(e.pathname);
    if (!(want === '/' || a.pathname === want || a.pathname.startsWith(want))) return false;
    if (e.search) {
      const wanted = new URLSearchParams(e.search);
      const got = new URLSearchParams(a.search);
      for (const [k, v] of wanted) {
        if (got.get(k) !== v) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

interface PageLocation {
  url: string;
  title: string;
  errorPage: boolean;
}

/** REAL top-page location + error-page detection (chrome-error pages lie about nothing — they ARE the failure). */
async function readLocation(cdp: PageEval): Promise<PageLocation | null> {
  try {
    const loc = await cdp.eval<PageLocation | null>(`
      (() => ({
        url: location.href,
        title: document.title,
        errorPage: location.protocol === 'chrome-error:'
      }))()
    `);
    return loc && typeof loc.url === 'string' ? loc : null;
  } catch {
    return null;
  }
}

// ── verifyUrl ──────────────────────────────────────────────────────

export interface UrlExpectation {
  /** Substring/URL the location must match (normalized), or a RegExp over the full URL. */
  match: string | RegExp;
}

/**
 * Verify the page reached the expected URL. Polls until the wait window
 * closes; a chrome-error:// page is definitive FAILURE evidence.
 */
export async function verifyUrl(
  cdp: PageEval,
  expected: string | RegExp,
  waitMs = 4000,
): Promise<Verification<PageLocation>> {
  const deadline = Date.now() + waitMs;
  let last: PageLocation | null = null;
  let observedOnce = false;

  while (Date.now() < deadline) {
    last = await readLocation(cdp);
    if (last) {
      observedOnce = true;
      const hit = typeof expected === 'string' ? urlMatches(last.url, expected) : expected.test(last.url);
      if (hit && !last.errorPage) {
        return {
          status: 'SUCCESS', method: 'url-match', evidence: last, confidence: 0.95,
          detail: `URL verified: ${last.url} ("${last.title}")`,
        };
      }
      if (last.errorPage) {
        return {
          status: 'FAILURE', method: 'url-match', evidence: last, confidence: 0.95,
          detail: `Navigation failed — Chrome error page at ${last.url} ("${last.title}")`,
        };
      }
    }
    await sleep(300);
  }

  if (!observedOnce || !last) {
    return {
      status: 'UNKNOWN', method: 'url-match', evidence: null, confidence: 0,
      detail: 'Could not read the page location (evaluation failed) — URL unverified',
    };
  }
  return {
    status: 'FAILURE', method: 'url-match', evidence: last, confidence: 0.9,
    detail: `URL is ${last.url} — does not match the expectation (waited ${waitMs}ms)`,
  };
}

// ── verifyTitle / verifyText ───────────────────────────────────────

export async function verifyTitle(
  cdp: PageEval,
  substring: string,
  waitMs = 4000,
): Promise<Verification<string | null>> {
  const deadline = Date.now() + waitMs;
  let last: PageLocation | null = null;
  let observedOnce = false;
  while (Date.now() < deadline) {
    last = await readLocation(cdp);
    if (last) {
      observedOnce = true;
      if (last.title.toLowerCase().includes(substring.toLowerCase())) {
        return {
          status: 'SUCCESS', method: 'title-contains', evidence: last.title, confidence: 0.9,
          detail: `Title verified: "${last.title}" contains "${substring}"`,
        };
      }
    }
    await sleep(300);
  }
  if (!observedOnce) {
    return { status: 'UNKNOWN', method: 'title-contains', evidence: null, confidence: 0, detail: 'Could not read the page title' };
  }
  return { status: 'FAILURE', method: 'title-contains', evidence: last?.title ?? null, confidence: 0.9, detail: `Title "${last?.title}" does not contain "${substring}" (waited ${waitMs}ms)` };
}

export async function verifyText(
  cdp: PageEval,
  text: string,
  waitMs = 4000,
): Promise<Verification<string | null>> {
  const deadline = Date.now() + waitMs;
  let observedOnce = false;
  let lastLen: number | null = null;
  while (Date.now() < deadline) {
    let body: string | null = null;
    try {
      body = await cdp.eval<string | null>(`(() => document.body ? document.body.innerText : null)()`);
    } catch { body = null; }
    if (body !== null) {
      observedOnce = true;
      lastLen = body.length;
      if (body.toLowerCase().includes(text.toLowerCase())) {
        return {
          status: 'SUCCESS', method: 'body-text-contains', evidence: text, confidence: 0.85,
          detail: `Page text contains "${text.slice(0, 80)}"`,
        };
      }
    }
    await sleep(300);
  }
  if (!observedOnce) {
    return { status: 'UNKNOWN', method: 'body-text-contains', evidence: null, confidence: 0, detail: 'Could not read page text' };
  }
  return { status: 'FAILURE', method: 'body-text-contains', evidence: null, confidence: 0.8, detail: `Text "${text.slice(0, 80)}" not on page (observed ${lastLen} chars, waited ${waitMs}ms)` };
}

// ── verifyPageTransition (form-submit / navigation outcomes) ─────

/**
 * REAL post-submit outcome for form submissions: a submission either
 * navigates (the URL left the form page — observed, not assumed), stays
 * on the same document while the page itself CONFIRMS success (validation
 * message / inline confirmation — read from the live DOM), or fails.
 * FAILURE requires observed negative evidence; UNKNOWN only when reality
 * cannot be observed at all. Never a fabricated "the form went through".
 */
export async function verifyPageTransition(
  cdp: PageEval,
  opts: { originUrl: string; waitMs?: number; pollMs?: number } = { originUrl: '' },
): Promise<Verification<{ navigated: boolean; url: string | null; successText: string | null }>> {
  const waitMs = opts.waitMs ?? 6000;
  const pollMs = opts.pollMs ?? 300;
  // Phrases a page honestly uses to confirm a submission (case-insensitive
  // substring scan over the live body text — evidence from the page, not
  // from us).
  const SUCCESS_PATTERNS = [
    'thank you', 'thanks for', 'successfully', 'success', 'submitted',
    'confirmation', 'message sent', 'message has been sent',
    'has been received', 'we received', 'received your',
    'check your email', 'verify your email', 'your request',
    'your message', 'your submission', 'form has been',
    'error occurred', 'an error', 'error:', 'failed to',
  ];
  const deadline = Date.now() + waitMs;
  let url: string | null = null;
  let title: string | null = null;
  let observedOnce = false;
  let sawConfirmingText: string | null = null;

  while (Date.now() < deadline) {
    // Reality check 1: did the URL leave the form page? (observed)
    try {
      const loc = await cdp.eval<{ url: string; title: string }>(
        '(() => ({ url: location.href, title: document.title }))()',
      );
      if (loc && typeof loc.url === 'string') {
        observedOnce = true;
        url = loc.url;
        title = loc.title;
        const sameDoc = urlMatches(url, opts.originUrl);
        // Reality check 2: same-document confirmations (SPA submission or
        // validation outcome) — read from the live DOM, never invented.
        if (sameDoc) {
          try {
            const body = await cdp.eval<string | null>('(() => document.body ? document.body.innerText : null)()');
            if (body) {
              const low = body.toLowerCase();
              const hit = SUCCESS_PATTERNS.find((p) => low.includes(p));
              if (hit) {
                sawConfirmingText = body
                  .split('\n')
                  .map((l) => l.trim())
                  .find((l) => l.toLowerCase().includes(hit)) ?? hit;
              }
              // Failure surfaced IN the DOM beats the silent same-document case.
              if (low.includes('error') || low.includes('required') || low.includes('invalid')) {
                return {
                  status: 'FAILURE', method: 'page-transition',
                  evidence: { navigated: false, url, successText: sawConfirmingText },
                  confidence: 0.9,
                  detail: `Form outcome — the page reports an error (URL ${url})`,
                };
              }
              if (hit) {
                return {
                  status: 'SUCCESS', method: 'page-transition',
                  evidence: { navigated: false, url, successText: sawConfirmingText },
                  confidence: 0.85,
                  detail: `Submission confirmed on-page: "${sawConfirmingText}" (URL ${url})`,
                };
              }
            }
          } catch { /* body unreadable this round — keep polling */ }
        }
        if (!sameDoc) {
          return {
            status: 'SUCCESS', method: 'page-transition',
            evidence: { navigated: true, url, successText: null }, confidence: 0.9,
            detail: `Submission navigated the page: ${url} ("${title}")`,
          };
        }
      }
    } catch { /* unobservable this round — keep polling */ }
    await sleep(pollMs);
  }

  if (!observedOnce) {
    return {
      status: 'UNKNOWN', method: 'page-transition', evidence: null, confidence: 0,
      detail: 'Could not observe the page after submission — outcome unverified',
    };
  }
  return {
    status: 'FAILURE', method: 'page-transition',
    evidence: { navigated: false, url, successText: sawConfirmingText }, confidence: 0.85,
    detail: `URL is ${url} — the submission did not navigate or confirm (waited ${waitMs}ms)`,
  };
}

/**
 * A target is verified visible only when it is REALLY grounded in the
 * current DOM AND intersects the viewport (§20 — DOM presence is not
 * visibility).
 */
export async function verifyElementVisible(
  cdp: PageEval,
  description: string,
  minConfidence = 0.55,
): Promise<Verification<{ found: boolean; inViewport: boolean; confidence: number; reason?: string }>> {
  let els;
  try {
    els = await snapshotInteractives(cdp);
  } catch {
    return { status: 'UNKNOWN', method: 'element-visible', evidence: null, confidence: 0, detail: 'Could not snapshot the page DOM' };
  }
  const hit = findTarget(els, description, minConfidence);
  if (!hit) {
    return {
      status: 'FAILURE', method: 'element-visible',
      evidence: { found: false, inViewport: false, confidence: 0 },
      confidence: 0.9,
      detail: `No confident match for "${description}" among ${els.length} visible elements — grounding refused to guess`,
    };
  }
  const ev = { found: true, inViewport: hit.element.inViewport, confidence: hit.confidence, reason: hit.reason };
  if (!hit.element.inViewport) {
    return {
      status: 'FAILURE', method: 'element-visible', evidence: ev, confidence: 0.85,
      detail: `"${description}" exists (confidence ${hit.confidence.toFixed(2)}) but is OFF-SCREEN — not visible`,
    };
  }
  return {
    status: 'SUCCESS', method: 'element-visible', evidence: ev, confidence: hit.confidence,
    detail: `"${description}" visible (confidence ${hit.confidence.toFixed(2)}, ${hit.reason})`,
  };
}

// ── verifyPlayback (tri-state wrapper over real video state) ──────

export async function verifyPlaybackTri(
  cdp: PageEval,
  waitMs = 6000,
): Promise<Verification<{ playing: boolean; currentTime: number; duration: number; videoTitle: string | null }>> {
  const deadline = Date.now() + waitMs;
  let last: { playing: boolean; currentTime: number; duration: number; videoTitle: string | null } | null = null;
  let videoSeen = false;
  let observedOnce = false;

  while (Date.now() < deadline) {
    try {
      const raw = await cdp.eval<string | null>(`
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
      `);
      observedOnce = true;
      if (raw) {
        videoSeen = true;
        last = JSON.parse(raw);
        if (last?.playing) {
          return {
            status: 'SUCCESS', method: 'video-state', evidence: last, confidence: 0.95,
            detail: `PLAYING (verified): "${last.videoTitle}" — t=${last.currentTime.toFixed(1)}s of ${Math.round(last.duration)}s`,
          };
        }
      }
    } catch { /* unobservable this round — keep polling */ }
    await sleep(400);
  }

  if (!observedOnce) {
    return { status: 'UNKNOWN', method: 'video-state', evidence: null, confidence: 0, detail: 'Could not observe video state — playback UNVERIFIED' };
  }
  if (!videoSeen) {
    return { status: 'FAILURE', method: 'video-state', evidence: null, confidence: 0.95, detail: 'No <video> element on the page — nothing is playing' };
  }
  return {
    status: 'FAILURE', method: 'video-state', evidence: last, confidence: 0.9,
    detail: `Video present but NOT playing (t=${last?.currentTime.toFixed(1)}s, paused) after ${waitMs}ms`,
  };
}

// ── verifyStateChange (temporal verification, §26) ────────────────

/**
 * STATE(t0) → wait → STATE(t1) → COMPARE. The expression must return a
 * JSON-serializable value. SUCCESS = the value actually changed;
 * FAILURE = it provably stayed the same through the window;
 * UNKNOWN = the page could not be observed.
 */
export async function verifyStateChange(
  cdp: PageEval,
  expression: string,
  waitMs = 4000,
  pollMs = 350,
): Promise<Verification<{ before: unknown; after: unknown }>> {
  const read = async (): Promise<{ ok: boolean; value: unknown }> => {
    try {
      const v = await cdp.eval<unknown>(expression);
      return { ok: true, value: v };
    } catch {
      return { ok: false, value: undefined };
    }
  };

  const t0 = await read();
  if (!t0.ok) {
    return { status: 'UNKNOWN', method: 'state-change', evidence: null, confidence: 0, detail: 'Initial state could not be observed' };
  }

  const deadline = Date.now() + waitMs;
  let lastOk = true;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const t1 = await read();
    if (!t1.ok) { lastOk = false; continue; }
    if (JSON.stringify(t1.value) !== JSON.stringify(t0.value)) {
      return {
        status: 'SUCCESS', method: 'state-change',
        evidence: { before: t0.value, after: t1.value }, confidence: 0.9,
        detail: `State changed: ${JSON.stringify(t0.value).slice(0, 60)} → ${JSON.stringify(t1.value).slice(0, 60)}`,
      };
    }
  }
  if (!lastOk) {
    return { status: 'UNKNOWN', method: 'state-change', evidence: { before: t0.value, after: null }, confidence: 0.3, detail: 'State unchanged but observation became unreliable — UNKNOWN' };
  }
  return {
    status: 'FAILURE', method: 'state-change', evidence: { before: t0.value, after: t0.value }, confidence: 0.85,
    detail: `State did not change through the ${waitMs}ms window`,
  };
}
