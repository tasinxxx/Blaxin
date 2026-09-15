// bulk_files — verified batch file operations
// =============================================================
// Stonic parity gap from docs/capability-matrix.md ("bulk organize
// downloads, find duplicates, rename by pattern"). Honesty rules under
// test:
//   · a batch is SUCCESS only when EVERY item verified in the resulting
//     filesystem state (source gone + destination present for moves,
//     size match for copies, absence for deletes);
//   · one failed item makes the WHOLE batch an honest FAILURE that names
//     the failed items — never a partial-success claim;
//   · protected paths, dotfiles, and existing targets are never touched;
//   · every bulk verb requires user confirmation (HIGH risk gate).
// All cases run against the REAL filesystem in a scratch dir.
// =============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BulkFilesTool, isProtectedBulkPath, MAX_BULK_ITEMS } from '../tools/bulk-files.js';

const tool = new BulkFilesTool();
let dir: string;
let dest: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'blaxin-bulk-'));
  dest = mkdtempSync(join(tmpdir(), 'blaxin-bulk-dest-'));
  writeFileSync(join(dir, 'report.pdf'), 'PDFDATA');
  writeFileSync(join(dir, 'photo.png'), 'PNGDATA');
  writeFileSync(join(dir, 'photo2.png'), 'PNGDATA2');
  writeFileSync(join(dir, 'notes.txt'), 'text');
  writeFileSync(join(dir, '.hidden'), 'dotfile');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
});

describe('bulk_files: organize', () => {
  it('sorts files into extension folders and verifies each move', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blaxin-bulk-org-'));
    writeFileSync(join(work, 'a.pdf'), 'x');
    writeFileSync(join(work, 'b.pdf'), 'yy');
    writeFileSync(join(work, 'c.png'), 'zzz');
    writeFileSync(join(work, 'noext'), 'w');
    writeFileSync(join(work, '.hidden'), 'dotfile');
    const r = await tool.execute({ operation: 'organize', path: work });
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/4 item\(s\), all verified/); // .hidden excluded
    // Real resulting state:
    expect(readdirSync(join(work, 'pdf')).sort()).toEqual(['a.pdf', 'b.pdf']);
    expect(existsSync(join(work, 'png', 'c.png'))).toBe(true);
    expect(existsSync(join(work, 'other', 'noext'))).toBe(true);
    expect(existsSync(join(work, 'a.pdf'))).toBe(false); // source really gone
    // Dotfile untouched
    expect(existsSync(join(work, '.hidden'))).toBe(true);
    rmSync(work, { recursive: true, force: true });
  });

  it('FAILS honestly when nothing is organizable', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'blaxin-bulk-empty-'));
    const r = await tool.execute({ operation: 'organize', path: empty });
    expect(r.success).toBe(false);
    expect(r.error).toContain('No organizable files');
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('bulk_files: batch_move / batch_copy', () => {
  it('moves matching files and verifies source-gone + destination-present', async () => {
    const r = await tool.execute({ operation: 'batch_move', path: dir, pattern: '*.png', destination: dest });
    expect(r.success).toBe(true);
    expect(r.data?.verified).toBe(2);
    expect(existsSync(join(dest, 'photo.png'))).toBe(true);
    expect(existsSync(join(dest, 'photo2.png'))).toBe(true);
    expect(existsSync(join(dir, 'photo.png'))).toBe(false);
    // Non-matching files untouched
    expect(existsSync(join(dir, 'report.pdf'))).toBe(true);
  });

  it('copies matching files with size verification, source intact', async () => {
    const r = await tool.execute({ operation: 'batch_copy', path: dir, pattern: 'report*', destination: dest });
    expect(r.success).toBe(true);
    expect(existsSync(join(dest, 'report.pdf'))).toBe(true);
    expect(statSync(join(dest, 'report.pdf')).size).toBe(statSync(join(dir, 'report.pdf')).size);
    expect(existsSync(join(dir, 'report.pdf'))).toBe(true); // copy keeps source
  });

  it('NEVER overwrites an existing destination file (honest per-item failure)', async () => {
    const r2 = await tool.execute({ operation: 'batch_copy', path: dir, pattern: 'report*', destination: dest });
    // The copy target already exists from the previous test.
    expect(r2.success).toBe(false);
    expect(r2.output).toMatch(/destination already has a file with this name/);
    const onDisk = readFileSync(join(dest, 'report.pdf'), 'utf-8');
    expect(onDisk).toBe('PDFDATA'); // untouched
  });
});

describe('bulk_files: batch_delete', () => {
  it('deletes matching files and verifies absence', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blaxin-bulk-del-'));
    writeFileSync(join(work, 'temp1.log'), 'a');
    writeFileSync(join(work, 'temp2.log'), 'b');
    writeFileSync(join(work, 'keep.txt'), 'c');
    const r = await tool.execute({ operation: 'batch_delete', path: work, pattern: '*.log' });
    expect(r.success).toBe(true);
    expect(r.data?.verified).toBe(2);
    expect(existsSync(join(work, 'temp1.log'))).toBe(false);
    expect(existsSync(join(work, 'temp2.log'))).toBe(false);
    expect(existsSync(join(work, 'keep.txt'))).toBe(true);
    rmSync(work, { recursive: true, force: true });
  });
});

describe('bulk_files: bulk_rename', () => {
  it('renames by prefix/suffix/replace with post-state verification', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blaxin-bulk-ren-'));
    writeFileSync(join(work, 'IMG_1.jpg'), 'a');
    writeFileSync(join(work, 'IMG_2.jpg'), 'b');

    const pre = await tool.execute({ operation: 'bulk_rename', path: work, pattern: 'IMG_*', rename: 'prefix', value: '2026-' });
    expect(pre.success).toBe(true);
    expect(existsSync(join(work, '2026-IMG_1.jpg'))).toBe(true);
    expect(existsSync(join(work, 'IMG_1.jpg'))).toBe(false);

    const rep = await tool.execute({ operation: 'bulk_rename', path: work, pattern: '2026-*', rename: 'replace', value: 'IMG,PHOTO' });
    expect(rep.success).toBe(true);
    // replace keeps the rest of the name: 2026-IMG_1.jpg → 2026-PHOTO_1.jpg
    expect(existsSync(join(work, '2026-PHOTO_1.jpg'))).toBe(true);
    expect(existsSync(join(work, '2026-IMG_1.jpg'))).toBe(false);

    const suf = await tool.execute({ operation: 'bulk_rename', path: work, pattern: '2026-PHOTO_1.jpg', rename: 'suffix', value: '-old' });
    expect(suf.success).toBe(true);
    expect(existsSync(join(work, '2026-PHOTO_1-old.jpg'))).toBe(true);
    rmSync(work, { recursive: true, force: true });
  });

  it('fails an item whose replace produces no change or an existing target', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blaxin-bulk-ren2-'));
    writeFileSync(join(work, 'same.txt'), 'a');
    const r = await tool.execute({ operation: 'bulk_rename', path: work, rename: 'replace', value: 'NOTPRESENT,x' });
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/produced no change/);
    expect(existsSync(join(work, 'same.txt'))).toBe(true);
    rmSync(work, { recursive: true, force: true });
  });
});

describe('bulk_files: guards and gates', () => {
  it('refuses protected paths and directories that do not exist', async () => {
    expect((await tool.execute({ operation: 'organize', path: '/etc' })).success).toBe(false);
    expect((await tool.execute({ operation: 'organize', path: join(dir, 'nope-missing') })).success).toBe(false);
  });

  it('never touches dotfiles or protected-looking files in the batch', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blaxin-bulk-guard-'));
    writeFileSync(join(work, '.secret'), 's');
    writeFileSync(join(work, 'id_rsa'), 'k');
    writeFileSync(join(work, 'plain.txt'), 'p');
    const r = await tool.execute({ operation: 'batch_delete', path: work, pattern: '*' });
    // Only plain.txt matched; dotfile and id_rsa survived.
    expect(r.data?.verified).toBe(1);
    expect(existsSync(join(work, '.secret'))).toBe(true);
    expect(existsSync(join(work, 'id_rsa'))).toBe(true);
    expect(existsSync(join(work, 'plain.txt'))).toBe(false);
    rmSync(work, { recursive: true, force: true });
  });

  it('ALWAYS requires confirmation (bulk mutation is gated)', () => {
    for (const op of ['organize', 'batch_move', 'batch_copy', 'batch_delete', 'bulk_rename']) {
      expect(tool.requiresConfirmation({ operation: op })).toBe(true);
    }
  });

  it('isProtectedBulkPath guards the dangerous targets', () => {
    expect(isProtectedBulkPath('/etc')).toBe(true);
    expect(isProtectedBulkPath('/')).toBe(true);
    expect(isProtectedBulkPath(join(dir, 'id_rsa'))).toBe(true);
    expect(isProtectedBulkPath(join(dir, 'plain.txt'))).toBe(false);
  });
});

// Tiny local helper (no import churn): readFileSync used in one test above.
import { readFileSync } from 'fs';

describe('bulk_files: bounds', () => {
  it('caps the batch at MAX_BULK_ITEMS', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blaxin-bulk-cap-'));
    for (let i = 0; i < MAX_BULK_ITEMS + 25; i++) writeFileSync(join(work, `f${i}.txt`), 'x');
    const r = await tool.execute({ operation: 'batch_delete', path: work, pattern: '*.txt' });
    // Bounded: only MAX items were requested in this batch.
    expect(r.data?.requested).toBe(MAX_BULK_ITEMS);
    // All VERIFIED items are really gone.
    const remaining = readdirSync(work).filter((f) => f.endsWith('.txt'));
    expect(remaining.length).toBe(25);
    rmSync(work, { recursive: true, force: true });
  }, 30000);
});
