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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, chmodSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
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

// ── content-hash dedupe (B4.1) ────────────────────────────────
// Duplicate identity is the file's REAL bytes (SHA-256), never the name.
// Every case runs against the real filesystem; deletion is verified
// from the filesystem, never from the tool's own word.

describe('bulk_files: dedupe (content-hash identity)', () => {
  it('REPORT: A/B (different names, identical content) are duplicates; C (different content) is not', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blaxin-bulk-dedupe-'));
    // Same bytes, completely different names — identity is content.
    writeFileSync(join(work, 'report-final.txt'), 'IDENTICAL-CONTENT-XYZ');
    writeFileSync(join(work, 'copy (1) of something.bin'), 'IDENTICAL-CONTENT-XYZ');
    // Distinct content must never be grouped in.
    writeFileSync(join(work, 'different.txt'), 'totally other bytes');
    // Same NAME stem but different bytes: names mean nothing.
    writeFileSync(join(work, 'report-final2.txt'), 'IDENTICAL-CONTENT-XYZ'.replace('XYZ', 'ABC'));

    const r = await tool.execute({ operation: 'dedupe', mode: 'report', path: work });
    expect(r.success).toBe(true);
    expect(r.data?.operation).toBe('dedupe');
    expect(r.data?.mode).toBe('report');
    expect(r.data?.duplicateGroups).toBe(1);
    expect(r.data?.duplicatesFound).toBe(1); // A↔B only — C and D are unique
    const group = (r.data?.groups as Array<{ hash: string; files: string[] }>)[0];
    expect(group.files.sort()).toEqual(['copy (1) of something.bin', 'report-final.txt']);
    // Honest read-only claim: nothing modified.
    expect(existsSync(join(work, 'report-final.txt'))).toBe(true);
    expect(existsSync(join(work, 'copy (1) of something.bin'))).toBe(true);
    expect(r.output).toContain('nothing modified');
    // Hash is REAL sha-256 of the actual content (verified externally against
    // the crypto module — not an abbreviated or synthetic value).
    expect(group.hash).toBe(createHash('sha256').update('IDENTICAL-CONTENT-XYZ').digest('hex'));
    rmSync(work, { recursive: true, force: true });
  });

  it('REPORT: empty identical-content set is an honest SUCCESS with zero groups', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blaxin-bulk-dedupe0-'));
    writeFileSync(join(work, 'a.log'), 'x');
    writeFileSync(join(work, 'b.log'), 'y');
    const r = await tool.execute({ operation: 'dedupe', mode: 'report', path: work });
    expect(r.success).toBe(true);
    expect(r.data?.duplicateGroups).toBe(0);
    expect(r.data?.uniqueFiles).toBe(2);
    expect(r.output).toContain('no duplicate files found');
    rmSync(work, { recursive: true, force: true });
  });

  it('REPORT: respects dotfile/protected guards and the pattern filter', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blaxin-bulk-dedupe-guard-'));
    writeFileSync(join(work, '.secret'), 'same');
    writeFileSync(join(work, 'id_rsa'), 'same'); // sensitive name → never touched
    writeFileSync(join(work, 'n1.log'), 'dup-bytes');
    writeFileSync(join(work, 'n2.log'), 'dup-bytes');
    writeFileSync(join(work, 'n3.txt'), 'dup-bytes'); // outside *.log pattern
    const r = await tool.execute({ operation: 'dedupe', mode: 'report', path: work, pattern: '*.log' });
    expect(r.success).toBe(true);
    expect(r.data?.requested).toBe(2); // only the two .log files were candidates
    expect(r.data?.duplicateGroups).toBe(1);
    // Untouched by the report (read-only) — and never candidates anyway.
    expect(existsSync(join(work, '.secret'))).toBe(true);
    expect(existsSync(join(work, 'id_rsa'))).toBe(true);
    expect(existsSync(join(work, 'n3.txt'))).toBe(true);
    rmSync(work, { recursive: true, force: true });
  });

  it('REPORT: unreadable files are honestly reported, never guessed into groups', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blaxin-bulk-dedupe-perm-'));
    writeFileSync(join(work, 'r1.txt'), 'readable twin');
    writeFileSync(join(work, 'r2.txt'), 'readable twin');
    writeFileSync(join(work, 'locked.txt'), 'unreadable');
    chmodSync(join(work, 'locked.txt'), 0o000);
    try {
      const r = await tool.execute({ operation: 'dedupe', mode: 'report', path: work });
      const hashErrors = (r.data?.hashErrors ?? []) as Array<{ file: string; error: string }>;
      // Running as root would read the file anyway — then there is
      // nothing to report and the group detection stays honest either way.
      if (hashErrors.length > 0) {
        expect(r.success).toBe(false); // unreadable → honest failure, not silent skip
        expect(hashErrors[0].file).toContain('locked.txt');
      } else {
        // Root: every file readable. r1/r2 are twins of each other → the
        // one honest group; locked.txt is unique. Nothing invented.
        expect(r.success).toBe(true);
        expect(r.data?.duplicateGroups).toBe(1);
        expect(r.data?.duplicatesFound).toBe(1);
      }
      expect(existsSync(join(work, 'r1.txt'))).toBe(true);
      expect(existsSync(join(work, 'r2.txt'))).toBe(true);
    } finally {
      chmodSync(join(work, 'locked.txt'), 0o644);
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('DELETE: deletes duplicates, keeps one per group, verifies absence from the REAL filesystem', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blaxin-bulk-dedupe-del-'));
    const content = 'DELETE-ME-TWINS-0123456789';
    writeFileSync(join(work, 'z-keeper.bin'), content);
    writeFileSync(join(work, 'a-copy.bin'), content);
    writeFileSync(join(work, 'm-copy.bin'), content);
    writeFileSync(join(work, 'unique.txt'), 'singular');
    const r = await tool.execute({ operation: 'dedupe', mode: 'delete_duplicates', path: work });
    expect(r.success).toBe(true);
    expect(r.data?.deleted).toBe(2);
    expect(r.data?.duplicateGroups).toBe(1);
    // Deterministic keeper: first file in name order survives —
    // 'a-copy.bin' < 'm-copy.bin' < 'z-keeper.bin'.
    const kept = (r.data?.items as Array<{ from: string; kept?: boolean }>).filter((i) => i.kept);
    expect(kept).toHaveLength(1);
    expect(kept[0].from.endsWith('a-copy.bin')).toBe(true);
    // Post-state from the FILESYSTEM, not the tool's claim:
    expect(existsSync(join(work, 'a-copy.bin'))).toBe(true);
    expect(existsSync(join(work, 'm-copy.bin'))).toBe(false);
    expect(existsSync(join(work, 'z-keeper.bin'))).toBe(false);
    expect(existsSync(join(work, 'unique.txt'))).toBe(true);
    // Keeper content really intact (byte compare against the original).
    expect(readFileSync(join(work, 'a-copy.bin'), 'utf-8')).toBe(content);
    rmSync(work, { recursive: true, force: true });
  });

  it('DELETE: multiple duplicate groups each keep exactly one survivor', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blaxin-bulk-dedupe-groups-'));
    writeFileSync(join(work, 'g1.txt'), 'GROUP-ONE');
    writeFileSync(join(work, 'g1-copy.txt'), 'GROUP-ONE');
    writeFileSync(join(work, 'g2.txt'), 'GROUP-TWO');
    writeFileSync(join(work, 'g2-copy.txt'), 'GROUP-TWO');
    writeFileSync(join(work, 'g2-copy2.txt'), 'GROUP-TWO');
    const r = await tool.execute({ operation: 'dedupe', mode: 'delete_duplicates', path: work });
    expect(r.success).toBe(true);
    expect(r.data?.duplicateGroups).toBe(2);
    expect(r.data?.deleted).toBe(3);
    // Name-order keepers: 'g1-copy.txt' < 'g1.txt' and 'g2-copy.txt' < 'g2.txt'
    // ('-' 0x2D sorts before '.' 0x2E) — the copy names survive.
    const remain = readdirSync(work).sort();
    expect(remain).toEqual(['g1-copy.txt', 'g2-copy.txt']);
    expect(readFileSync(join(work, 'g1-copy.txt'), 'utf-8')).toBe('GROUP-ONE');
    expect(readFileSync(join(work, 'g2-copy.txt'), 'utf-8')).toBe('GROUP-TWO');
    rmSync(work, { recursive: true, force: true });
  });

  it('DELETE never touches unique files or guard-excluded ones (dotfile twin survives)', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blaxin-bulk-dedupe-safe-'));
    writeFileSync(join(work, 'one.txt'), 'twin-bytes');
    writeFileSync(join(work, 'two.txt'), 'twin-bytes');
    writeFileSync(join(work, '.twin'), 'twin-bytes'); // dotfile: excluded, survives
    writeFileSync(join(work, 'id_rsa'), 'twin-bytes'); // sensitive: excluded, survives
    const r = await tool.execute({ operation: 'dedupe', mode: 'delete_duplicates', path: work });
    expect(r.success).toBe(true);
    expect(r.data?.skippedByGuard).toBe(2);
    expect(existsSync(join(work, '.twin'))).toBe(true);
    expect(existsSync(join(work, 'id_rsa'))).toBe(true);
    // Exactly one of the two plain twins was removed.
    const remain = readdirSync(work).filter((f) => f.endsWith('.txt'));
    expect(remain).toHaveLength(1);
    rmSync(work, { recursive: true, force: true });
  });

  it('ALWAYS requires confirmation — including the read-only report (consistent HIGH gate)', () => {
    expect(tool.requiresConfirmation({ operation: 'dedupe', mode: 'report' })).toBe(true);
    expect(tool.requiresConfirmation({ operation: 'dedupe', mode: 'delete_duplicates' })).toBe(true);
  });

  it('protected paths are refused outright (BLOCKED, same as every bulk verb)', async () => {
    const r = await tool.execute({ operation: 'dedupe', path: '/etc' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('protects');
  });
});

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
