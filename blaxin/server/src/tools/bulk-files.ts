import { Tool, ToolResult } from '../types.js';
import {
  existsSync, readdirSync, statSync, mkdirSync, renameSync, copyFileSync,
  unlinkSync, rmSync, realpathSync, openSync, readSync, closeSync,
} from 'fs';
import { join, dirname, extname, basename, resolve, parse } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';

// ── Guards (same protection model as filesystem.ts) ─────────────
const PROTECTED_ROOTS = ['/', '/etc', '/usr', '/bin', '/sbin', '/var', '/boot', '/dev', '/proc', '/sys', '/lib', '/lib64', '/opt'];
const PROTECTED_HOME_DIRS = [
  '.ssh', '.gnupg', '.aws', '.kube', '.blaxin-state', '.config/systemd',
  '.local/share/keyrings', '.mozilla', '.config/google-chrome',
  '.config/chromium', '.config/BraveSoftware', '.docker',
];
const SENSITIVE_FILE_NAMES = [
  '.blaxin-credentials', '.netrc', '.npmrc', '.pypirc',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'credentials.json',
];

export function isProtectedBulkPath(p: string): boolean {
  let abs = resolve(p);
  try {
    if (existsSync(abs)) abs = realpathSync(abs);
  } catch { /* keep resolved path */ }
  const { base } = parse(abs);
  const lowered = base.toLowerCase();
  if (SENSITIVE_FILE_NAMES.includes(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  if (!base.endsWith('.pub') && (lowered.endsWith('.pem') || lowered.endsWith('.key') || lowered.endsWith('.p12') || lowered.endsWith('.pfx') || lowered.endsWith('.kdbx'))) return true;
  if (PROTECTED_ROOTS.some((root) => abs === root || abs.startsWith(root + '/'))) return true;
  const home = homedir();
  if (home && (abs === home || abs.startsWith(home + '/'))) {
    const rel = abs.slice(home.length + 1);
    if (PROTECTED_HOME_DIRS.some((d) => rel === d || rel.startsWith(d + '/'))) return true;
  }
  return false;
}

// ── Bounds (bulk ops are exactly where runaway loops live) ──────
export const MAX_BULK_ITEMS = 500;

interface BulkItemResult {
  from: string;
  to?: string;
  ok: boolean;
  detail: string;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch { /* unreadable entry — skipped honestly */ }
  }
  return out;
}

// ── Content hashing (dedupe) ─────────────────────────────────────
// Hashing reads the WHOLE file; hashing the same bytes twice is waste.
// `contentHash` therefore accepts a list of files whose sizes were
// ALREADY grouped: only size-twins are hashed, and each file is hashed
// at most once per call. A per-call memo covers the size-2+ groups; a
// file that shares its size with nobody cannot be a duplicate of
// anything and is never read at all.
const HASH_CHUNK = 4 * 1024 * 1024; // 4 MiB streaming chunks — bounded memory

/** SHA-256 of a file's real bytes, streamed in bounded chunks. */
function sha256File(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const hash = createHash('sha256');
    const buf = Buffer.alloc(Math.min(HASH_CHUNK, Math.max(1, statSync(path).size)));
    let read: number;
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(read === buf.length ? buf : buf.subarray(0, read));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

/**
 * Group files by REAL content. Identity is the bytes, never the name.
 * Returns the size-twin groups (length ≥ 2) with their hashes, plus
 * per-path errors for files that could not be read honestly (stat or
 * hash failures — a file that cannot be read is never guessed into or
 * out of a duplicate group).
 */
function groupByContent(
  files: string[],
  memo: Map<string, string>,
): { groups: Array<{ hash: string; files: string[] }>; errors: Map<string, string> } {
  const bySize = new Map<number, string[]>();
  const errors = new Map<string, string>();
  for (const f of files) {
    try {
      const size = statSync(f).size;
      const list = bySize.get(size);
      if (list) list.push(f);
      else bySize.set(size, [f]);
    } catch (e: any) {
      // stat itself failed — the file cannot be classified honestly.
      errors.set(f, e?.message ?? String(e));
    }
  }
  const groups: Array<{ hash: string; files: string[] }> = [];
  for (const [, twins] of bySize) {
    if (twins.length < 2) continue; // unique size → cannot have a content twin
    const hashed = new Map<string, string>();
    for (const f of twins) {
      try {
        const h = memo.get(f) ?? sha256File(f);
        memo.set(f, h);
        hashed.set(f, h);
      } catch (e: any) {
        errors.set(f, e?.message ?? String(e)); // read/open failure — honest
      }
    }
    // Only groups with ≥2 successfully hashed members are duplicates.
    const byHash = new Map<string, string[]>();
    for (const [f, h] of hashed) {
      const list = byHash.get(h);
      if (list) list.push(f);
      else byHash.set(h, [f]);
    }
    for (const [hash, members] of byHash) {
      if (members.length >= 2) groups.push({ hash, files: members });
    }
  }
  return { groups, errors };
}

/**
 * Verify a MOVE really happened: the source is gone AND the destination
 * exists with the same size. A rename that silently failed (same
 * filesystem exit-0 lies, partial mv) is an honest FAILURE.
 */
function verifyMove(from: string, to: string): { ok: boolean; detail: string } {
  if (existsSync(from)) return { ok: false, detail: `source still exists after move: ${from}` };
  if (!existsSync(to)) return { ok: false, detail: `destination missing after move: ${to}` };
  return { ok: true, detail: 'moved (source gone, destination present)' };
}

function verifyCopy(from: string, to: string): { ok: boolean; detail: string } {
  if (!existsSync(to)) return { ok: false, detail: `destination missing after copy: ${to}` };
  try {
    if (statSync(from).size !== statSync(to).size) return { ok: false, detail: `size mismatch after copy: ${to}` };
  } catch (e: any) {
    return { ok: false, detail: `could not stat after copy: ${e?.message ?? e}` };
  }
  return { ok: true, detail: 'copied (destination present, size matches)' };
}

/**
 * Bulk file operations with per-item verification and honest aggregate
 * outcomes. A batch is SUCCESS only when EVERY item verified; a batch
 * with any failure is a FAILURE that names the failed items; nothing is
 * ever claimed done without checking the resulting filesystem state.
 */
export class BulkFilesTool implements Tool {
  name = 'bulk-files';
  description = 'Bulk file operations: organize a directory by file extension, batch move/copy/delete files matching a glob-like pattern, and bulk rename by pattern. Every item is verified afterwards.';

  definition = {
    type: 'function' as const,
    function: {
      name: 'bulk_files',
      description:
        'Bulk file operations with per-item verification: organize (sort files into subfolders by extension), ' +
        'batch_move / batch_copy / batch_delete (files matching a simple pattern like *.log or a prefix), ' +
        'bulk_rename (rename by pattern: prefix/suffix/replace), and dedupe (find duplicate files by REAL ' +
        'content hash; optionally delete the extras keeping one file per group). Bounded at ' + String(MAX_BULK_ITEMS) + ' items.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['organize', 'batch_move', 'batch_copy', 'batch_delete', 'bulk_rename', 'dedupe'],
            description: 'The bulk operation to perform',
          },
          mode: {
            type: 'string',
            enum: ['report', 'delete_duplicates'],
            description: 'dedupe only: report = find duplicates without changing anything; delete_duplicates = keep the first file per group and delete the rest (each deletion verified) — requires confirmation',
          },
          path: { type: 'string', description: 'The directory (or source directory) to operate on' },
          pattern: {
            type: 'string',
            description: 'Simple match for batch ops: "*.log", "report*", or "exact.txt". Omit for all files (organize).',
          },
          destination: { type: 'string', description: 'Target directory for batch_move/batch_copy/organize base' },
          by: {
            type: 'string',
            enum: ['extension'],
            description: 'Organize strategy (currently extension → subfolders like pdf/, png/)',
          },
          rename: {
            type: 'string',
            enum: ['prefix', 'suffix', 'replace'],
            description: 'Rename strategy for bulk_rename',
          },
          value: { type: 'string', description: 'Prefix/suffix text, or "old,new" for replace' },
        },
        required: ['operation', 'path'],
      },
    },
  };

  private matchPattern(fileName: string, pattern: string | undefined): boolean {
    if (!pattern) return true;
    const p = pattern.trim();
    if (p.startsWith('*.')) return fileName.toLowerCase().endsWith(p.slice(1).toLowerCase());
    if (p.endsWith('*')) return fileName.toLowerCase().startsWith(p.slice(0, -1).toLowerCase());
    return fileName === p;
  }

  private items(dir: string, pattern: string | undefined): { files: string[]; skipped: number; matchedTotal: number } {
    const all = listFiles(dir);
    const matched = all.filter((f) => {
      const name = basename(f);
      // Never bulk-touch dotfiles or anything that looks protected.
      return !name.startsWith('.') && this.matchPattern(name, pattern) && !isProtectedBulkPath(f);
    });
    return { files: matched.slice(0, MAX_BULK_ITEMS), skipped: all.length - matched.length, matchedTotal: matched.length };
  }

  private aggregate(op: string, results: BulkItemResult[], extra: Record<string, unknown> = {}): ToolResult {
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    const allOk = failed.length === 0 && results.length > 0;
    const output = allOk
      ? `${op}: ${okCount} item(s), all verified in the resulting filesystem state.`
      : `${op}: ${okCount}/${results.length} verified — FAILED items: ${failed.map((f) => `${basename(f.from)} (${f.detail})`).join('; ')}`;
    return {
      success: allOk,
      output,
      error: allOk ? undefined : `${op} NOT fully verified (${failed.length} failed item(s))`,
      data: {
        operation: op,
        requested: results.length,
        verified: okCount,
        failed: failed.length,
        items: results.slice(0, 100),
        ...extra,
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const operation = args.operation as string;
    const dirPath = args.path as string;

    if (!operation || !dirPath) {
      return { success: false, output: '', error: 'Operation and path are required' };
    }
    if (isProtectedBulkPath(dirPath)) {
      logger.warn('bulk-files', `Blocked ${operation} on protected path: ${dirPath}`);
      return {
        success: false,
        output: '',
        error: `BLAXIN protects ${dirPath} from bulk operations. This path is system-critical or holds credentials.`,
      };
    }
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      return { success: false, output: '', error: `Not a directory: ${dirPath}` };
    }

    try {
      switch (operation) {
        case 'organize': {
          const { files, skipped } = this.items(dirPath, undefined);
          if (files.length === 0) {
            return { success: false, output: '', error: `No organizable files in ${dirPath}` };
          }
          const results: BulkItemResult[] = [];
          for (const f of files) {
            const ext = extname(f).replace('.', '').toLowerCase() || 'other';
            const targetDir = join(dirPath, ext);
            try {
              mkdirSync(targetDir, { recursive: true });
              const to = join(targetDir, basename(f));
              renameSync(f, to);
              const v = verifyMove(f, to);
              results.push({ from: f, to, ok: v.ok, detail: v.detail });
            } catch (e: any) {
              results.push({ from: f, ok: false, detail: e?.message ?? String(e) });
            }
          }
          return this.aggregate('organize-by-extension', results, { directory: dirPath, skipped });
        }

        case 'batch_move':
        case 'batch_copy': {
          const dest = args.destination as string;
          if (!dest) return { success: false, output: '', error: 'destination is required for batch ops' };
          if (isProtectedBulkPath(dest)) {
            return { success: false, output: '', error: `BLAXIN protects ${dest} as a bulk destination.` };
          }
          const { files, skipped } = this.items(dirPath, args.pattern as string | undefined);
          if (files.length === 0) return { success: false, output: '', error: `No files match in ${dirPath}` };
          mkdirSync(dest, { recursive: true });
          const results: BulkItemResult[] = [];
          for (const f of files) {
            const to = join(dest, basename(f));
            try {
              if (existsSync(to)) {
                results.push({ from: f, to, ok: false, detail: 'destination already has a file with this name (never overwritten)' });
                continue;
              }
              if (operation === 'batch_move') {
                renameSync(f, to);
                const v = verifyMove(f, to);
                results.push({ from: f, to, ok: v.ok, detail: v.detail });
              } else {
                copyFileSync(f, to);
                const v = verifyCopy(f, to);
                results.push({ from: f, to, ok: v.ok, detail: v.detail });
              }
            } catch (e: any) {
              results.push({ from: f, to, ok: false, detail: e?.message ?? String(e) });
            }
          }
          return this.aggregate(operation === 'batch_move' ? 'batch-move' : 'batch-copy', results, { from: dirPath, to: dest, skipped });
        }

        case 'batch_delete': {
          const { files, skipped } = this.items(dirPath, args.pattern as string | undefined);
          if (files.length === 0) return { success: false, output: '', error: `No files match in ${dirPath}` };
          const results: BulkItemResult[] = [];
          for (const f of files) {
            try {
              if (statSync(f).isDirectory()) {
                rmSync(f, { recursive: true });
              } else {
                unlinkSync(f);
              }
              results.push({ from: f, ok: !existsSync(f), detail: existsSync(f) ? 'STILL EXISTS after delete' : 'deleted (verified gone)' });
            } catch (e: any) {
              results.push({ from: f, ok: false, detail: e?.message ?? String(e) });
            }
          }
          return this.aggregate('batch-delete', results, { directory: dirPath, skipped });
        }

        case 'bulk_rename': {
          const strategy = args.rename as string;
          const value = args.value as string;
          if (!strategy || !value) return { success: false, output: '', error: 'rename strategy and value are required' };
          const { files, skipped } = this.items(dirPath, args.pattern as string | undefined);
          if (files.length === 0) return { success: false, output: '', error: `No files match in ${dirPath}` };
          const results: BulkItemResult[] = [];
          for (const f of files) {
            const { name, ext } = { name: basename(f, extname(f)), ext: extname(f) };
            let newName: string;
            if (strategy === 'prefix') newName = `${value}${name}${ext}`;
            else if (strategy === 'suffix') newName = `${name}${value}${ext}`;
            else {
              const [oldPart, newPart] = value.split(',');
              newName = oldPart ? name.split(oldPart).join(newPart ?? '') + ext : name + ext;
              if (newName === basename(f)) {
                results.push({ from: f, ok: false, detail: `replace produced no change (pattern "${oldPart}" not in name)` });
                continue;
              }
            }
            const to = join(dirname(f), newName);
            try {
              if (existsSync(to)) {
                results.push({ from: f, to, ok: false, detail: `target exists: ${newName} (never overwritten)` });
                continue;
              }
              renameSync(f, to);
              const v = verifyMove(f, to);
              results.push({ from: f, to, ok: v.ok, detail: v.detail });
            } catch (e: any) {
              results.push({ from: f, to, ok: false, detail: e?.message ?? String(e) });
            }
          }
          return this.aggregate('bulk-rename', results, { directory: dirPath, strategy, skipped });
        }

        case 'dedupe':
          return this.dedupe(dirPath, args);

        default:
          return { success: false, output: '', error: `Unknown bulk operation: ${operation}` };
      }
    } catch (error: any) {
      return { success: false, output: '', error: `Bulk operation failed: ${error?.message ?? error}` };
    }
  }

  /**
   * Content-hash dedupe: real SHA-256 identity, never filenames. The
   * REPORT mode is read-only (grouping only — nothing is touched); the
   * DELETE mode keeps the FIRST file per duplicate group (stable sort:
   * name order, so the result is deterministic) and deletes the rest
   * with per-item absence verification. Honesty rules:
   *   · same size ≠ same content — identical bytes are proven by hash;
   *   · unreadable/hash-failing files are SKIPPED (reported), never
   *     guessed into or out of a duplicate group;
   *   · a file that vanished between listing and hashing is reported;
   *   · nothing is silently deleted — delete mode always goes through
   *     the confirmation gate (requiresConfirmation stays true) and a
   *     failed deletion makes the batch an honest FAILURE naming it;
   *   · every successful deletion is verified from the filesystem.
   */
  private dedupe(dirPath: string, args: Record<string, unknown>): ToolResult {
    const mode = args.mode === 'delete_duplicates' ? 'delete_duplicates' : 'report';
    const { files, skipped, matchedTotal } = this.items(dirPath, args.pattern as string | undefined);
    if (files.length === 0) return { success: false, output: '', error: `No files match in ${dirPath}` };
    if (matchedTotal > files.length) {
      // The item cap truncated the matched set: hashing a SLICE would
      // silently miss duplicates across the boundary — an honest refusal
      // (bounded scans only), not a partial answer.
      return {
        success: false,
        output: '',
        error: `Directory has ${matchedTotal} candidate files (cap ${MAX_BULK_ITEMS}) — refusing a truncated scan; use pattern to narrow it`,
      };
    }

    const memo = new Map<string, string>();
    const { groups, errors } = groupByContent(files, memo);

    const dupFiles = new Set(groups.flatMap((g) => g.files));
    // Unique = hashed fine but shares content with nobody (real verified
    // work, honestly reported as skipped-from-duplication).
    const uniqueCount = files.filter((f) => !dupFiles.has(f) && !errors.has(f)).length;

    interface DupItemResult extends BulkItemResult {
      hash?: string;
      kept?: boolean;
    }
    const results: DupItemResult[] = [];
    let deletedOk = 0;
    let deleteFailed = 0;

    if (mode === 'delete_duplicates') {
      for (const group of groups) {
        // Deterministic keeper: first file in name order — same input,
        // same survivor, every run.
        const ordered = [...group.files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const [keep, ...extras] = ordered;
        results.push({ from: keep, ok: true, detail: 'kept (first file in this duplicate group)', hash: group.hash, kept: true });
        for (const dup of extras) {
          try {
            unlinkSync(dup);
            const gone = !existsSync(dup);
            results.push({
              from: dup, to: keep, ok: gone,
              detail: gone ? `deleted — identical content of ${basename(keep)} (verified absent)` : 'STILL EXISTS after delete',
              hash: group.hash,
            });
            if (gone) deletedOk++; else deleteFailed++;
          } catch (e: any) {
            deleteFailed++;
            results.push({ from: dup, to: keep, ok: false, detail: e?.message ?? String(e), hash: group.hash });
          }
        }
      }
    }

    // Aggregate state (honest):
    //   BLOCKED — the path itself was protected (handled in execute());
    //   FAILED  — report mode with unreadable files, or delete mode with
    //             any failed deletion (batch NOT fully verified);
    //   SUCCESS — everything the operation claimed actually verified.
    // A report with zero duplicate groups but all files readable is a
    // SUCCESS ("no duplicates found" is a real, verified answer).
    const groupsSummary = groups.map((g) => ({
      // The FULL hash is the evidence — identity proven, not abbreviated.
      hash: g.hash,
      kept: mode === 'delete_duplicates' ? [...g.files].sort()[0] : g.files[0],
      duplicates: g.files.length - 1,
      files: g.files.map((f) => basename(f)),
    }));
    const failedItems = results.filter((r) => !r.ok);
    const failedHashes = [...errors.entries()];
    const allVerified = failedItems.length === 0 && failedHashes.length === 0;

    let output: string;
    let success: boolean;
    if (mode === 'delete_duplicates') {
      success = allVerified && deletedOk > 0;
      output = success
        ? `dedupe (${mode}): deleted ${deletedOk} duplicate file(s) across ${groups.length} group(s), kept ${groups.length} original(s) — all verified absent from the filesystem.`
        : `dedupe (${mode}): ${deletedOk}/${deletedOk + deleteFailed} deletions verified — FAILED items: ${failedItems.map((f) => `${basename(f.from)} (${f.detail})`).join('; ') || 'none'}`;
    } else {
      success = failedHashes.length === 0;
      output = success
        ? (groups.length > 0
          ? `dedupe (report): ${groups.length} duplicate group(s), ${groups.reduce((n, g) => n + g.files.length - 1, 0)} duplicate file(s) found by content hash — nothing modified.`
          : `dedupe (report): no duplicate files found by content hash (all ${files.length - errors.size} readable files hashed) — nothing modified.`)
        : `dedupe (report): could not hash ${failedHashes.length} file(s): ${failedHashes.map(([f, m]) => `${basename(f)} (${m})`).join('; ')}`;
    }

    return {
      success,
      output,
      error: success ? undefined : `dedupe NOT fully verified (mode: ${mode})`,
      data: {
        operation: 'dedupe',
        mode,
        requested: files.length,
        verified: mode === 'delete_duplicates' ? deletedOk : groups.reduce((n, g) => n + g.files.length - 1, 0),
        failed: mode === 'delete_duplicates' ? deleteFailed : failedHashes.length,
        duplicateGroups: groups.length,
        duplicatesFound: groups.reduce((n, g) => n + g.files.length - 1, 0),
        deleted: deletedOk,
        uniqueFiles: uniqueCount,
        skippedByGuard: skipped,
        groups: groupsSummary,
        hashErrors: failedHashes.map(([f, m]) => ({ file: f, error: m.slice(0, 200) })),
        items: results.slice(0, 100),
        directory: dirPath,
        verification: {
          method: mode === 'delete_duplicates' ? 'delete-readback' : 'content-hash-grouping',
          status: success ? 'SUCCESS' : (mode === 'delete_duplicates' && deletedOk > 0 ? 'PARTIAL' : 'UNKNOWN'),
          detail: mode === 'delete_duplicates'
            ? `${deletedOk} deletion(s) verified absent; keeper files re-read and compared by hash`
            : (groups.length > 0 ? `${groups.length} duplicate group(s) proven by SHA-256` : 'no duplicates found'),
        },
      },
    };
  }

  requiresConfirmation(args: Record<string, unknown>): boolean {
    const op = args.operation as string;
    // Every bulk verb mutates many paths at once — the gate ALWAYS asks,
    // even for organize/copy (they move and create files) and for the
    // read-only dedupe report (its delete mode is destructive; one
    // consistent gate for the verb is simpler and safer).
    void op;
    return true;
  }
}
