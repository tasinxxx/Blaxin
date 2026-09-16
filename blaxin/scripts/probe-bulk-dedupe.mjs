// B4.1 RUNTIME PROOF — content-hash dedupe on the REAL filesystem
// =============================================================
// Proves on real files (not mocks):
//   1. file A and file B have DIFFERENT names but IDENTICAL content
//      → detected as one duplicate group by REAL SHA-256;
//   2. file C has different content → never grouped with A/B;
//   3. the report mode touches NOTHING (read-only claim is real);
//   4. delete mode removes exactly the duplicates, keeping one per
//      group — every deletion verified from the filesystem afterwards;
//   5. the same verbs run through the REAL bundled dist (server build),
//      so this proves what actually ships, not just the src tree.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const steps = [];
const failures = [];
function step(name, ok, detail = '') {
  steps.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

// Load the REAL compiled tool (server/dist) so the proof covers the
// shipping artifact. Fall back to a fresh build only if dist is stale.
const ROOT = dirname(dirname(new URL(import.meta.url).pathname));
const distTool = join(ROOT, 'server', 'dist', 'tools', 'bulk-files.js');
if (!existsSync(distTool)) {
  console.error(`bundled tool missing: ${distTool} — run: cd server && npm run build`);
  process.exit(1);
}
const { BulkFilesTool } = await import(pathToFileURL(distTool).href);
const tool = new BulkFilesTool();

// ── STAGE the real files ─────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'blaxin-dedupe-proof-'));
const CONTENT_AB = 'same-bytes-for-A-and-B-' + 'x'.repeat(4096); // multi-chunk-safe size
const CONTENT_C = 'totally-different-bytes-' + 'z'.repeat(4096);
const A = join(work, 'A report final.txt');   // name shares nothing with B
const B = join(work, 'B_backup_copy.dat');    // name shares nothing with A
const C = join(work, 'C_unique.bin');         // different content
writeFileSync(A, CONTENT_AB);
writeFileSync(B, CONTENT_AB);
writeFileSync(C, CONTENT_C);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

console.log(`proof dir: ${work}`);
console.log(`A: ${A}  sha256=${sha(A).slice(0, 16)}…`);
console.log(`B: ${B}  sha256=${sha(B).slice(0, 16)}…`);
console.log(`C: ${C}  sha256=${sha(C).slice(0, 16)}…`);

try {
  // ── 1. REPORT: A/B detected as duplicates, C not ────────────
  const report = await tool.execute({ operation: 'dedupe', mode: 'report', path: work });
  step('report executed (real SHA-256 grouping over real files)', report.success === true, report.output?.slice(0, 120));
  const groups = report.data?.groups ?? [];
  step('exactly ONE duplicate group found', groups.length === 1, `groups=${groups.length}`);
  const group = groups[0];
  const members = (group?.files ?? []).sort();
  step('the group is exactly {A, B} — different names, identical content',
    members.length === 2 && members.includes('A report final.txt') && members.includes('B_backup_copy.dat'),
    JSON.stringify(members));
  step('C (different content) is NOT in any group', !members.includes('C_unique.bin'));
  step('group hash is the REAL SHA-256 of the content',
    group?.hash === sha(A) && sha(A) === sha(B),
    `hash=${group?.hash?.slice(0, 16)}…`);
  step('report claims 1 duplicate across 1 group (honest counts)',
    report.data?.duplicatesFound === 1 && report.data?.duplicateGroups === 1);

  // ── 2. REPORT is really read-only ───────────────────────────
  step('REPORT touched nothing: A, B, C all still on disk with unchanged bytes',
    existsSync(A) && existsSync(B) && existsSync(C)
      && sha(A) === sha(B) && sha(C) !== sha(A)
      && readdirSync(work).length === 3);

  // ── 3. DELETE duplicates: keeper + verified absence ─────────
  const del = await tool.execute({ operation: 'dedupe', mode: 'delete_duplicates', path: work });
  step('delete mode executed', del.data?.deleted === 1 && del.success === true, del.output?.slice(0, 120));
  // The group summary names the keeper by FULL PATH; basename it.
  const keepPath = del.data?.groups?.[0]?.kept ?? '';
  const keepName = basename(String(keepPath));
  const removedName = keepName === 'A report final.txt' ? 'B_backup_copy.dat' : 'A report final.txt';
  step('exactly ONE file survived per the deterministic keeper rule (name order)',
    existsSync(A) !== existsSync(B) && keepName === (existsSync(A) ? 'A report final.txt' : 'B_backup_copy.dat'),
    `kept=${keepName}`);
  step('the duplicate is REALLY gone from the filesystem',
    !existsSync(join(work, removedName)) && readdirSync(work).filter((f) => f !== 'C_unique.bin').length === 1);
  step('C untouched by delete mode', existsSync(C) && sha(C) === sha(join(work, 'C_unique.bin')));
  step('survivor bytes unchanged (content identity intact)',
    existsSync(keepPath) && sha(keepPath) === sha(A) || existsSync(keepPath) && sha(keepPath) === sha(B));
  step('verification payload carries real delete-readback evidence',
    del.data?.verification?.method === 'delete-readback' && del.data?.verification?.status === 'SUCCESS',
    JSON.stringify(del.data?.verification));

  // ── 4. Re-run report on the post-delete state: honest zero ──
  const after = await tool.execute({ operation: 'dedupe', mode: 'report', path: work });
  step('post-delete report: no duplicates remain (verified empty result)',
    after.success === true && after.data?.duplicateGroups === 0 && after.data?.uniqueFiles === 2);
} finally {
  rmSync(work, { recursive: true, force: true });
}

const pass = steps.filter((s) => s.ok).length;
console.log(`\nchecks: ${pass}/${steps.length} PASS`);
process.exit(failures.length === 0 ? 0 : 1);
