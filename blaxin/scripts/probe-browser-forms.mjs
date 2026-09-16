// B5 RUNTIME PROOF — form fill / submit / download on REAL Chromium
// =============================================================
// Proves against a real headless Chrome (not mocks, and not the src tree —
// the COMPILED dist that actually ships):
//   1. fill_form really fills real <input>/<select>/checkbox elements and
//      the page itself confirms the values (per-field read-back);
//   2. form_submit verifies the REAL outcome (navigation to the thank-you
//      page), and honestly FAILS when validation blocks the submit;
//   3. download really writes bytes to the real filesystem and the tool
//      verifies the file by stable-size read-back.
// Env-gated like every live proof: BLAXIN_REAL_CHROME=1 node scripts/probe-browser-forms.mjs

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.BLAXIN_REAL_CHROME) {
  console.error('env-gated: set BLAXIN_REAL_CHROME=1 to run this proof against a real Chromium');
  process.exit(1);
}

const steps = [];
const failures = [];
function step(name, ok, detail = '') {
  steps.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

// ── Load the REAL compiled tool (server/dist) ────────────────
const ROOT = dirname(dirname(new URL(import.meta.url).pathname));
const distPath = join(ROOT, 'server', 'dist', 'tools', 'web-agent.js');
if (!existsSync(distPath)) {
  console.error(`bundled tool missing: ${distPath} — run: cd server && npm run build`);
  process.exit(1);
}
const { WebAgentTool } = await import(pathToFileURL(distPath).href);
const { browserSession } = await import(pathToFileURL(join(ROOT, 'server', 'dist', 'tools', 'browser-session.js')).href);

// ── Launch real headless Chrome on a private CDP port ────────
const PORT = 9400 + Math.floor(Math.random() * 400);
process.env.BLAXIN_CDP_PORT = String(PORT);

const CHILDREN = [];
async function launchHeadlessChrome() {
  const bins = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const bin of bins) {
    const ok = await new Promise((resolve) => execFile('which', [bin], (e) => resolve(!e)));
    if (!ok) continue;
    const child = execFile(bin, [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=/tmp/blaxin-forms-proof-${PORT}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      ...(process.env.BLAXIN_E2E_NO_SANDBOX ? ['--no-sandbox'] : []),
      'about:blank',
    ], () => undefined);
    child.on('error', () => undefined);
    child.unref();
    CHILDREN.push(child);
    for (let i = 0; i < 20; i++) {
      try {
        const v = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        if (v.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('No Chromium/Chrome with CDP could be started');
}

// ── Loopback form server (real pages, real network, no internet) ──
let server;
async function startFormServer() {
  server = createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/form')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><head><title>Proof Form</title></head><body>
        <form id="f" action="/thank-you" method="get">
          <input id="name" name="name" aria-label="Name" placeholder="Your name" required />
          <input id="email" name="email" aria-label="Email" placeholder="you@example.com" required />
          <select id="topic" name="topic" aria-label="Topic" required>
            <option value="">Choose…</option>
            <option value="support">Support</option>
            <option value="sales">Sales</option>
          </select>
          <label><input type="checkbox" id="subscribe" aria-label="Subscribe" /> Subscribe</label>
          <button type="submit" aria-label="Submit form">Submit form</button>
        </form>
        <a id="dl" aria-label="Download proof file" href="/proof-file.txt">Download proof file</a>
        <a id="missing" aria-label="Download missing file" href="/missing-file.txt">Download missing file</a>
      </body></html>`);
      return;
    }
    if (url.startsWith('/thank-you')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><head><title>Confirmed</title></head><body><h1>Thank you! Your submission has been received.</h1></body></html>');
      return;
    }
    if (url.startsWith('/proof-file.txt')) {
      // A REAL download response: Content-Disposition makes Chrome save
      // the file instead of rendering it in the tab (as any honest
      // download link would).
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="proof-file.txt"',
      });
      res.end('BLAXIN-PROOF-PAYLOAD-'.repeat(64));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

const tool = new WebAgentTool();
let port;
let workDir;

try {
  await launchHeadlessChrome();
  port = await startFormServer();
  workDir = mkdtempSync(join(tmpdir(), 'blaxin-forms-proof-'));
  const formUrl = `http://127.0.0.1:${port}/form`;
  const dlDir = join(workDir, 'downloads');
  console.log(`form server: ${formUrl}\ndownload dir: ${dlDir}\nchrome cdp port: ${PORT}`);

  // ── 0. open the real form page ──────────────────────────────
  const opened = await tool.execute({ action: 'open', url: formUrl });
  step('0. open: real navigation verified', opened.success === true && opened.output.includes('URL verified'), (opened.error ?? '').slice(0, 120));

  // ── 1. fill_form: all four fields, per-field read-back ──────
  const fill = await tool.execute({
    action: 'fill_form',
    fields: [
      { target: 'Name', value: 'Ada Lovelace' },
      { target: 'Email', value: 'ada@example.com' },
      { target: 'Topic', value: 'Support' },
      { target: 'Subscribe', value: 'true', check: true },
    ],
  });
  step('1. fill_form: 4/4 fields verified by read-back', fill.success === true && fill.output.includes('4/4 fields'), (fill.error ?? fill.output).slice(0, 160));

  // ── 2. form_submit: navigation to the thank-you page VERIFIED ──
  const submit = await tool.execute({ action: 'form_submit', target: 'Submit form' });
  step('2. form_submit: real outcome verified (navigated to thank-you)',
    submit.success === true && submit.output.includes('VERIFIED'),
    (submit.error ?? submit.data?.verification?.detail ?? '').slice(0, 160));
  const nav = submit.data?.verification?.evidence?.navigated;
  const url = submit.data?.verification?.evidence?.url ?? '';
  step('2b. evidence shows REAL navigation + the confirmation page',
    nav === true && url.includes('/thank-you'), `url=${url}`);

  // ── 3. honest validation failure: required fields NOT filled ──
  const back = await tool.execute({ action: 'open', url: formUrl });
  step('3. re-open the form for the negative path', back.success === true);
  const failSubmit = await tool.execute({ action: 'form_submit', target: 'Submit form' });
  step('3b. empty required fields → honest FAILURE (chrome validation blocks)',
    failSubmit.success === false, (failSubmit.error ?? '').slice(0, 140));

  // ── 4. download: REAL bytes land in the REAL directory ──────
  const dl = await tool.execute({ action: 'download', target: 'Download proof file', directory: dlDir });
  const dlFile = join(dlDir, 'proof-file.txt');
  const dlOk = dl.success === true && existsSync(dlFile) && statSync(dlFile).size > 0
    && readFileSync(dlFile, 'utf8').startsWith('BLAXIN-PROOF-PAYLOAD-');
  step('4. download: file verified on disk with the real payload', dlOk,
    (dl.error ?? `${dl.output?.slice(0, 100)} size=${existsSync(dlFile) ? statSync(dlFile).size : 'n/a'}`).slice(0, 160));
  step('4b. verification payload carries download-file-verified evidence',
    dl.data?.verification?.method === 'download-file-verified' && dl.data?.verification?.status === 'SUCCESS',
    JSON.stringify(dl.data?.verification ?? {}).slice(0, 120));

  // ── 5. honest download failure: the link 404s, nothing lands ──
  const dlBad = await tool.execute({ action: 'download', target: 'Download missing file', directory: dlDir });
  const nothing = !existsSync(join(dlDir, 'missing-file.txt'));
  step('5. 404 download → honest FAILURE, nothing on disk', dlBad.success === false && nothing, (dlBad.error ?? '').slice(0, 140));

  // ── 6. grounding refusal: nonexistent link is never guessed ──
  const dlGhost = await tool.execute({ action: 'download', target: 'Download the moon and the stars', directory: dlDir });
  step('6. grounding refuses a nonexistent trigger (no guess)', dlGhost.success === false, (dlGhost.error ?? '').slice(0, 120));
} catch (e) {
  step('probe completed without throwing', false, String(e?.message ?? e));
} finally {
  try { server?.closeAllConnections?.(); } catch { /* ignore */ }
  try { server?.close(); } catch { /* ignore */ }
  for (const c of CHILDREN) { try { c.kill(); } catch { /* ignore */ } }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  setTimeout(() => {
    const pass = steps.filter((s) => s.ok).length;
    console.log(`\nchecks: ${pass}/${steps.length} PASS`);
    process.exit(failures.length === 0 ? 0 : 1);
  }, 500);
}
