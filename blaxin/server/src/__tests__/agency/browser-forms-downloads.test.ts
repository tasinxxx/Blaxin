// Form-fill + submit + download verification (B5, directive §4):
//   fill_form      — per-field read-back verification; a fill is a claim
//                    about element state, so every field's REAL post-fill
//                    value must match what we asked for.
//   form_submit    — the REAL outcome (navigation or the page's own
//                    confirmation) is verified; "we clicked submit" is
//                    never success evidence.
//   download       — SUCCESS only when the file REALLY exists on disk
//                    with a stable non-zero size (filesystem read-back).
// The fake page below is a STATEFUL DOM: fields really hold values,
// selects really match options, a submit really navigates only when the
// required fields are non-empty, and a download click really writes bytes
// to the target directory. No test sees success it did not earn.
// NOTE: the fake's eval dispatch mirrors the REAL cdp-browser expressions
// (selector-variable snapshot, literal-selector click, sentinel-marked
// fill/check evals) so index identity is preserved exactly like production.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readdirSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebAgentTool, WEB_AGENT_TIMING } from '../../tools/web-agent.js';
import { BrowserSessionDeps, browserSession } from '../../tools/browser-session.js';
import type { CdpPage, PageEval } from '../../tools/cdp-browser.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wire the process-wide singleton (the tool uses it) to a fake page. */
function wireSession(page: PageEval): void {
  const deps: BrowserSessionDeps = {
    ensureCdpPage: async () => page as unknown as CdpPage,
    listPageTargets: async () => [{ targetId: 'target-fake', url: (page as unknown as FakeFormPage).url ?? 'https://x.test/', title: 'Fake' }],
    attachToTargetId: async () => page as unknown as CdpPage,
  };
  browserSession.useDeps(deps);
  (browserSession as unknown as { cdp: CdpPage | null }).cdp = null;
  (browserSession as unknown as { targetId: string | null }).targetId = null;
  (browserSession as unknown as { recoveryAttempts: number }).recoveryAttempts = 0;
  (browserSession as unknown as { lastKnownUrl: string | null }).lastKnownUrl = null;
}

beforeEach(() => {
  // Shorten bounded waits — honesty logic untouched, tests stay fast.
  WEB_AGENT_TIMING.navVerifyMs = 700;
  WEB_AGENT_TIMING.formSettleMs = 20;
  WEB_AGENT_TIMING.downloadTimeoutMs = 2500;
});

// ── Stateful fake DOM page ───────────────────────────────────────

interface FieldSpec {
  tag: 'input' | 'textarea' | 'select' | 'checkbox';
  label: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
}

class FakeFormPage {
  url: string;
  title = 'Form Page';
  fields: FieldSpec[];
  /** REAL element values — keyed by selector index in snapshot order. */
  values: Record<number, string> = {};
  checked: Record<number, boolean> = {};
  /** Set true only by a successful required-fields-complete submit. */
  submitted = false;
  /** Simulate a SPA form: submit confirms in-document instead of navigating. */
  spaMode = false;
  /** Simulate a validation failure: submit never navigates nor confirms. */
  validationFails = false;
  /** Page is unobservable (renderer gone). */
  evalFails = false;
  /** Simulate a silent OS/filesystem: the download click writes nothing. */
  downloadSilent = false;
  /** Simulate an in-flight download: the file keeps growing (real fs). */
  downloadNeverStable = false;
  /** Selector order — mirrors the SNAPSHOT_JS selector exactly. */
  private selectorOrder: Array<{ kind: 'link' | 'field' | 'button' | 'check', field?: FieldSpec, idx: number, href?: string }> = [];
  sendCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  private growTimer: ReturnType<typeof setInterval> | null = null;

  constructor(init: { url: string; fields: FieldSpec[]; downloadHref?: string }) {
    this.url = init.url;
    this.fields = init.fields;
    let i = 0;
    for (const f of this.fields) {
      if (f.tag === 'checkbox') this.selectorOrder.push({ kind: 'check', field: f, idx: i++ });
      else this.selectorOrder.push({ kind: 'field', field: f, idx: i++ });
    }
    if (init.downloadHref) this.selectorOrder.push({ kind: 'link', idx: i++, href: init.downloadHref });
    this.selectorOrder.push({ kind: 'button', idx: i++ });
  }

  /** Stop simulated background growth (test teardown). */
  dispose(): void {
    if (this.growTimer) { clearInterval(this.growTimer); this.growTimer = null; }
  }

  getTargetId(): string { return 'target-fake'; }
  isOpen(): boolean { return true; }
  close(): void { /* no-op */ }

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    this.sendCalls.push({ method, params });
    return {};
  }

  private validate(): boolean {
    if (this.validationFails) return false;
    return this.fields.every((f, i) => {
      if (f.tag === 'checkbox') return true;
      if (f.required) return (this.values[i] ?? '').length > 0;
      return true;
    });
  }

  async eval<T>(expression: string): Promise<T> {
    if (this.evalFails) throw new Error('evaluation failed');

    // ── location/state read (readState, verifyPageTransition) ──
    if (expression.includes('location.href') && !expression.includes('querySelectorAll')) {
      const navigated = this.submitted && !this.spaMode;
      const url = navigated ? 'https://forms.test/thank-you' : this.url;
      return { url, title: navigated ? 'Confirmed' : this.title, errorPage: false } as unknown as T;
    }

    // ── body text read (verifyPageTransition same-document scan) ──
    if (expression.includes('document.body.innerText')) {
      const body = this.submitted && this.spaMode ? 'Thank you! Your submission has been received.' : '';
      return body as unknown as T;
    }

    // ── fill_field read-back (sentinel-marked eval) ──
    if (expression.includes('__blaxinFill')) {
      const idx = Number(expression.match(/const IDX = (\d+)/)?.[1] ?? -1);
      const want = expression.match(/WANT = ("(?:[^"\\]|\\.)*")/)?.[1];
      const wanted = want ? JSON.parse(want) as string : '';
      const entry = this.selectorOrder[idx];
      if (!entry || entry.kind !== 'field' || !entry.field) {
        return JSON.stringify({ ok: false, value: '', optionText: null, reason: 'element-not-fillable' }) as unknown as T;
      }
      if (entry.field.tag === 'select') {
        const opt = (entry.field.options ?? []).find((o) => o === wanted)
          ?? (entry.field.options ?? []).find((o) => o.toLowerCase() === wanted.toLowerCase());
        if (!opt) return JSON.stringify({ ok: false, value: '', optionText: null, reason: 'option-not-found' }) as unknown as T;
        this.values[idx] = opt;
        return JSON.stringify({ ok: true, value: opt, optionText: opt, reason: 'set' }) as unknown as T;
      }
      this.values[idx] = wanted;
      return JSON.stringify({ ok: true, value: wanted, optionText: null, reason: 'set' }) as unknown as T;
    }

    // ── checkbox read-back (sentinel-marked eval) ──
    if (expression.includes('__blaxinCheck')) {
      const idx = Number(expression.match(/const IDX = (\d+)/)?.[1] ?? -1);
      const want = /WANT = true/.test(expression);
      const entry = this.selectorOrder[idx];
      if (!entry || entry.kind !== 'check') {
        return JSON.stringify({ ok: false, checked: null, reason: 'element-not-checkable' }) as unknown as T;
      }
      this.checked[idx] = want;
      return JSON.stringify({ ok: true, checked: want, reason: 'set' }) as unknown as T;
    }

    // ── Enter-submit (pressEnter) ──
    if (expression.includes('requestSubmit')) {
      if (this.validate()) this.submitted = true;
      return true as unknown as T;
    }

    // ── SNAPSHOT (selector VARIABLE — exactly like SNAPSHOT_JS) ──
    if (expression.includes("const sel = 'a[href]")) {
      const els = this.selectorOrder.map((e, i) => ({
        index: i,
        text: e.kind === 'button' ? 'Submit' : e.kind === 'link' ? 'Download report' : (e.field?.label ?? ''),
        ariaLabel: e.kind === 'button' ? 'Submit' : e.kind === 'link' ? 'Download report' : (e.field?.label ?? null),
        placeholder: e.field?.placeholder ?? null,
        href: e.href ?? null,
        tag: e.kind === 'button' ? 'button' : e.kind === 'link' ? 'a' : e.field!.tag,
        role: e.kind === 'button' ? 'button' : e.kind === 'link' ? 'link' : e.field!.tag,
        rect: { x: 10, y: 10 + i * 40, width: 200, height: 24 },
        inViewport: true,
      }));
      return JSON.stringify(els) as unknown as T;
    }

    // ── click (literal-selector re-resolve + el.click()) ──
    if (expression.includes('el.click()')) {
      const idx = Number(expression.match(/querySelectorAll\((?:'[^']*'|"[^"]*")\)\[(\d+)\]/)?.[1] ?? -1);
      const entry = this.selectorOrder[idx];
      if (entry?.kind === 'button' && this.validate()) this.submitted = true;
      if (entry?.kind === 'link' && entry.href && !this.downloadSilent) {
        // REAL byte write to the REAL target dir (the CDP download router
        // would do this in production; the filesystem scan decides truth).
        const path = entry.href.startsWith('file://') ? decodeURIComponent(entry.href.slice(7)) : null;
        if (path) {
          try {
            if (this.downloadNeverStable) {
              writeFileSync(path, 'chunk-one');
              // Real growth on the real filesystem — an in-flight download.
              this.growTimer = setInterval(() => {
                try { appendFileSync(path, 'more-bytes-'); } catch { /* gone */ }
              }, 250);
            } else {
              writeFileSync(path, 'PDF-PAYLOAD-BYTES-'.repeat(40));
            }
          } catch { /* dir missing — silent failure surfaces honestly */ }
        }
      }
      return true as unknown as T;
    }

    return null as unknown as T;
  }
}

function makeTool(page: FakeFormPage): WebAgentTool {
  wireSession(page);
  return new WebAgentTool();
}

const FIELDS: FieldSpec[] = [
  { tag: 'input', label: 'Name', placeholder: 'Your name', required: true },
  { tag: 'input', label: 'Email', placeholder: 'you@example.com', required: true },
  { tag: 'select', label: 'Topic', options: ['Support', 'Sales', 'Feedback'], required: true },
  { tag: 'checkbox', label: 'Subscribe' },
];

describe('blaxin_web fill_form — per-field read-back verification', () => {
  it('fills all fields and verifies every read-back (input, select, checkbox)', async () => {
    const page = new FakeFormPage({ url: 'https://forms.test/contact', fields: FIELDS });
    const r = await makeTool(page).execute({
      action: 'fill_form',
      fields: [
        { target: 'Name', value: 'Ada Lovelace' },
        { target: 'Email', value: 'ada@example.com' },
        { target: 'Topic', value: 'Support' },
        { target: 'Subscribe', value: 'true', check: true },
      ],
    });
    expect(r.success, String(r.error ?? r.output)).toBe(true);
    expect(r.output).toContain('4/4 fields');
    const fields = (r.data as { fields: Array<{ target: string; ok: boolean }> }).fields;
    expect(fields.every((f) => f.ok)).toBe(true);
    // The DOM really holds the values (stateful fake, not echoes).
    expect(page.values[0]).toBe('Ada Lovelace');
    expect(page.values[1]).toBe('ada@example.com');
    expect(page.values[2]).toBe('Support');
    expect(page.checked[3]).toBe(true);
  });

  it('fails honestly when a field read-back mismatches (page mutated the value)', async () => {
    const page = new FakeFormPage({ url: 'https://forms.test/contact', fields: FIELDS });
    // The page silently rewrites what we typed (autosuggest/normalizer):
    // mutate the read-back the page reports for fill evals.
    const origEval = page.eval.bind(page);
    (page as unknown as { eval: <T>(expr: string) => Promise<T> }).eval = async <T>(expr: string): Promise<T> => {
      const r = await origEval(expr) as unknown;
      if (expr.includes('__blaxinFill') && typeof r === 'string') {
        const parsed = JSON.parse(r) as { ok: boolean; value: string; optionText: string | null; reason: string };
        if (parsed.ok) {
          parsed.value = 'NORMALIZED-BY-PAGE';
          return JSON.stringify(parsed) as unknown as T;
        }
      }
      return r as T;
    };
    const r = await makeTool(page).execute({
      action: 'fill_form',
      fields: [{ target: 'Name', value: 'Ada Lovelace' }],
    });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('read-back mismatch');
    expect(String(r.error)).toContain('NORMALIZED-BY-PAGE');
  });

  it('fails honestly when a required select option does not exist', async () => {
    const page = new FakeFormPage({ url: 'https://forms.test/contact', fields: FIELDS });
    const r = await makeTool(page).execute({
      action: 'fill_form',
      fields: [{ target: 'Topic', value: 'Nonexistent Option' }],
    });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('option-not-found');
  });

  it('fails honestly when a field cannot be grounded (no guessing)', async () => {
    const page = new FakeFormPage({ url: 'https://forms.test/contact', fields: FIELDS });
    const r = await makeTool(page).execute({
      action: 'fill_form',
      fields: [{ target: 'Completely Absent Field', value: 'x' }],
    });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('no confident grounding');
  });

  it('reports UNKNOWN honestly when the page becomes unobservable mid-fill', async () => {
    const page = new FakeFormPage({ url: 'https://forms.test/contact', fields: FIELDS });
    page.evalFails = true;
    const r = await makeTool(page).execute({
      action: 'fill_form',
      fields: [{ target: 'Name', value: 'Ada' }],
    });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('page evaluation failed');
  });

  it('refuses to run with no fields or an over-cap field list', async () => {
    const page = new FakeFormPage({ url: 'https://forms.test/contact', fields: FIELDS });
    const tool = makeTool(page);
    const none = await tool.execute({ action: 'fill_form', fields: [] });
    expect(none.success).toBe(false);
    const tooMany = await tool.execute({
      action: 'fill_form',
      fields: Array.from({ length: 21 }, (_, i) => ({ target: `F${i}`, value: 'v' })),
    });
    expect(tooMany.success).toBe(false);
    expect(String(tooMany.error)).toContain('bounded cap is 20');
  });

  it('partial failures name exactly which fields failed (per-field honesty)', async () => {
    const page = new FakeFormPage({ url: 'https://forms.test/contact', fields: FIELDS });
    const r = await makeTool(page).execute({
      action: 'fill_form',
      fields: [
        { target: 'Name', value: 'Ada Lovelace' },
        { target: 'Ghost Field', value: 'x' },
      ],
    });
    expect(r.success).toBe(false);
    const fields = (r.data as { fields: Array<{ target: string; ok: boolean }> }).fields;
    expect(fields).toHaveLength(2);
    expect(fields[0].ok).toBe(true);
    expect(fields[1].ok).toBe(false);
    // The successful field is still really set (no rollback lie either way).
    expect(page.values[0]).toBe('Ada Lovelace');
  });
});

describe('blaxin_web form_submit — real outcome verification', () => {
  it('verifies a real navigation on submit (button click + URL left the page)', async () => {
    const page = new FakeFormPage({ url: 'https://forms.test/contact', fields: FIELDS });
    // Pre-fill required fields directly (fill_form coverage above proves the fill path).
    page.values[0] = 'Ada';
    page.values[1] = 'ada@example.com';
    page.values[2] = 'Support';
    const r = await makeTool(page).execute({ action: 'form_submit', target: 'Submit' });
    expect(r.success, String(r.error ?? r.output)).toBe(true);
    expect(r.output).toContain('VERIFIED');
    expect(page.submitted).toBe(true);
    const v = (r.data as { verification: { status: string; method: string } }).verification;
    expect(v.status).toBe('SUCCESS');
    expect(v.method).toBe('page-transition');
  });

  it('verifies a same-document confirmation (SPA form, no navigation)', async () => {
    const page = new FakeFormPage({ url: 'https://forms.test/contact', fields: FIELDS });
    page.spaMode = true;
    page.values[0] = 'Ada';
    page.values[1] = 'ada@example.com';
    page.values[2] = 'Support';
    const r = await makeTool(page).execute({ action: 'form_submit', target: 'Submit' });
    expect(r.success, String(r.error ?? r.output)).toBe(true);
    const v = (r.data as { verification: { evidence: { navigated: boolean; successText: string | null } } }).verification;
    expect(v.evidence.navigated).toBe(false);
    expect(v.evidence.successText).toContain('Thank you');
  });

  it('FAILS honestly when validation blocks the submit (page stays put, no confirmation)', async () => {
    const page = new FakeFormPage({ url: 'https://forms.test/contact', fields: FIELDS });
    page.validationFails = true;
    const r = await makeTool(page).execute({ action: 'form_submit', target: 'Submit' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('NOT verified');
    expect(page.submitted).toBe(false);
  });

  it('FAILS honestly when nothing happens after submit (page never confirms)', async () => {
    const page = new FakeFormPage({ url: 'https://forms.test/contact', fields: FIELDS });
    // SPA mode WITHOUT a confirmation line: the click happens, the page
    // stays, and no confirming text appears — an honest FAILURE, not "we clicked".
    page.spaMode = true;
    page.validationFails = true;
    const r = await makeTool(page).execute({ action: 'form_submit', target: 'Submit' });
    expect(r.success).toBe(false);
  });

  it('refuses to guess a submit button that does not exist', async () => {
    const page = new FakeFormPage({ url: 'https://forms.test/contact', fields: FIELDS });
    const r = await makeTool(page).execute({ action: 'form_submit', target: 'Destroy Everything' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('No confident match');
  });
});

describe('blaxin_web download — filesystem read-back verification', () => {
  let dir: string;
  let page: FakeFormPage | null = null;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'blaxin-dl-')); });
  afterEach(() => {
    page?.dispose();
    page = null;
    rmSync(dir, { recursive: true, force: true });
  });

  function downloadPage(silent = false, neverStable = false): FakeFormPage {
    const p = new FakeFormPage({
      url: 'https://files.test/reports',
      fields: [],
      downloadHref: `file://${join(dir, 'quarterly-report.pdf')}`,
    });
    p.downloadSilent = silent;
    p.downloadNeverStable = neverStable;
    page = p;
    return p;
  }

  it('verifies a real download: file appears on disk with a stable size', async () => {
    const p = downloadPage();
    const r = await makeTool(p).execute({ action: 'download', target: 'Download report', directory: dir });
    expect(r.success, String(r.error ?? r.output)).toBe(true);
    expect(r.output).toContain('VERIFIED');
    expect(r.output).toContain('quarterly-report.pdf');
    const v = (r.data as { verification: { status: string; method: string; evidence: { path: string; size: number } } }).verification;
    expect(v.status).toBe('SUCCESS');
    expect(v.method).toBe('download-file-verified');
    expect(v.evidence.size).toBeGreaterThan(0);
    // The file REALLY exists with the REAL byte content.
    expect(existsSync(v.evidence.path)).toBe(true);
    expect(statSync(v.evidence.path).size).toBe(v.evidence.size);
  });

  it('fails honestly when no file ever appears (silent filesystem)', async () => {
    const p = downloadPage(true);
    const r = await makeTool(p).execute({ action: 'download', target: 'Download report', directory: dir });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('NOT verified');
    expect(String(r.error)).toContain('0 new file(s)');
  });

  it('fails honestly when the file never stabilizes (still downloading)', async () => {
    const p = downloadPage(false, true);
    const r = await makeTool(p).execute({ action: 'download', target: 'Download report', directory: dir });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('still changing in size');
  });

  it('fails honestly when the download directory is unusable', async () => {
    const p = downloadPage();
    // A FILE blocks the directory path — creation genuinely fails.
    const blocked = join(dir, 'blocking-file');
    writeFileSync(blocked, 'not a directory');
    const r = await makeTool(p).execute({ action: 'download', target: 'Download report', directory: blocked });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('not usable');
  });

  it('refuses to guess a download trigger that does not exist', async () => {
    const p = downloadPage();
    const r = await makeTool(p).execute({ action: 'download', target: 'Download the moon', directory: dir });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('No confident match');
  });

  it('respects the expected filename filter (named verification)', async () => {
    const p = downloadPage();
    // An unrelated file appears first — it must NOT satisfy the check.
    writeFileSync(join(dir, 'unrelated.bin'), 'not the payload');
    const r = await makeTool(p).execute({
      action: 'download', target: 'Download report', directory: dir, filename: 'quarterly-report.pdf',
    });
    expect(r.success, String(r.error ?? r.output)).toBe(true);
    expect((r.data as { verification: { evidence: { name: string } } }).verification.evidence.name).toBe('quarterly-report.pdf');
    expect(readdirSync(dir)).toContain('unrelated.bin');
  });
});

describe('blaxin_web gating for the new actions', () => {
  it('gates form mutations + downloads (approval required)', async () => {
    const tool = makeTool(new FakeFormPage({ url: 'https://x.test/', fields: [] }));
    expect(tool.requiresConfirmation({ action: 'fill_form' })).toBe(true);
    expect(tool.requiresConfirmation({ action: 'form_submit' })).toBe(true);
    expect(tool.requiresConfirmation({ action: 'download' })).toBe(true);
    expect(tool.requiresConfirmation({ action: 'snapshot' })).toBe(false);
  });
});
