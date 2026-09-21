import { Tool, ToolResult } from '../types.js';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import {
  clipboardReaders,
  clipboardWriters,
  clipboardUnavailableHint,
  currentPlatform,
} from '../utils/platform.js';

const execFileAsync = promisify(execFile);

/**
 * Injectable command runner (verification seam). The default shells out to
 * the real clipboard tools; tests inject fakes to drive honest outcomes.
 */
export type ClipboardRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number,
  input?: string
) => Promise<{ stdout: string; stderr: string }>;

/** Real runner: execFile for reads, stdin-fed spawn for writes (no shell). */
const defaultRunner: ClipboardRunner = (cmd, args, timeoutMs, input) =>
  input === undefined
    ? execFileAsync(cmd, args, { timeout: timeoutMs, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } })
    : new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, {
          timeout: timeoutMs,
          env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
        });
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          proc.kill();
          reject(new Error('Timeout'));
        }, timeoutMs);

        proc.stdin.write(input);
        proc.stdin.end();

        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d) => { stdout += d; });
        proc.stderr?.on('data', (d) => { stderr += d; });

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (killed) return;
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(`Exit code ${code}`));
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          if (!killed) reject(err);
        });
      });

// Honest-unavailable messages. On Linux these are the exact v1.4.0 strings
// (frozen contract); other platforms get the same wording with a
// platform-correct hint.
const IS_LINUX = currentPlatform() === 'linux';
const NO_TOOL_ERROR = IS_LINUX
  ? 'No clipboard tool available. Install xclip, xsel, or wl-clipboard.'
  : `No clipboard tool available. ${clipboardUnavailableHint()}`;
// Read-specific: every reader failed. State BOTH plausible causes honestly
// instead of asserting the wrong diagnosis (the old code said "No clipboard
// tool available" even when the tools existed and the clipboard was simply
// empty/unowned).
const READ_UNAVAILABLE_ERROR = IS_LINUX
  ? 'Clipboard read failed: none of the clipboard readers (xclip, xsel, wl-paste) could read the selection. This usually means no clipboard utility is installed, or the clipboard is currently empty/unowned. Install one: sudo apt install xclip'
  : `Clipboard read failed: none of the clipboard readers (${clipboardReaders().join(', ')}) could read the selection. This usually means no clipboard utility is installed, or the clipboard is currently empty/unowned. ${clipboardUnavailableHint()}`;

export class ClipboardTool implements Tool {
  name = 'clipboard';
  description = 'Read from and write to the system clipboard.';

  definition = {
    type: 'function' as const,
    function: {
      name: 'clipboard',
      description: 'Get or set the system clipboard content.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write'],
            description: 'Read from or write to clipboard',
          },
          text: {
            type: 'string',
            description: 'Text to write to clipboard (for write action)',
          },
        },
        required: ['action'],
      },
    },
  };

  constructor(private runner: ClipboardRunner = defaultRunner) {}

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;

    try {
      switch (action) {
        case 'read':
          return await this.readClipboard();

        case 'write': {
          const text = args.text as string;
          if (text === undefined) return { success: false, output: '', error: 'Text is required' };
          return await this.writeClipboard(text);
        }

        default:
          return { success: false, output: '', error: `Unknown action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, output: '', error: `Clipboard error: ${error.message}` };
    }
  }

  // ── Read (per-platform candidate chain, honest failure at the end) ──

  private async readOnce(): Promise<string | null> {
    const platform = currentPlatform();

    if (platform === 'linux') {
      // Frozen v1.4.0 Linux chain: xclip → xsel → wl-paste.
      try {
        const { stdout } = await this.runner('xclip', ['-selection', 'clipboard', '-o'], 3000);
        // xclip exits 0 with empty output when the clipboard is empty —
        // that is an EMPTY clipboard, not a missing tool. The old code
        // fell through to "No clipboard tool available", a wrong
        // diagnosis the model would then report to the user.
        return stdout;
      } catch { /* tool missing or display error — try next */ }
      try {
        const { stdout } = await this.runner('xsel', ['--clipboard', '--output'], 3000);
        return stdout;
      } catch { /* try next */ }
      try {
        const { stdout } = await this.runner('wl-paste', [], 3000);
        return stdout;
      } catch { /* try next */ }
      return null;
    }

    if (platform === 'darwin') {
      try {
        const { stdout } = await this.runner('pbpaste', [], 3000);
        return stdout;
      } catch { return null; }
    }

    // Windows: PowerShell Get-Clipboard (Raw = no trailing newline added to
    // the content itself). UTF-8 console output so non-ASCII survives.
    try {
      const { stdout } = await this.runner(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'],
        3000,
      );
      // PowerShell's pipeline adds one trailing CRLF to output; strip it so
      // empty/compare semantics match the other platforms.
      return stdout.replace(/\r\n$/, '');
    } catch { return null; }
  }

  private async readClipboard(): Promise<ToolResult> {
    const content = await this.readOnce();
    if (content === null) {
      return { success: false, output: '', error: READ_UNAVAILABLE_ERROR };
    }
    return { success: true, output: content, data: { content, empty: content.length === 0 } };
  }

  // ── Write + verification read-back ──────────────────────────────────

  private async writeOnce(text: string): Promise<boolean> {
    const platform = currentPlatform();

    if (platform === 'linux') {
      // Frozen v1.4.0 Linux chain: xclip → xsel → wl-copy, stdin-fed.
      try {
        await this.runner('xclip', ['-selection', 'clipboard'], 3000, text);
        return true;
      } catch { try {
        await this.runner('xsel', ['--clipboard', '--input'], 3000, text);
        return true;
      } catch { try {
        await this.runner('wl-copy', [], 3000, text);
        return true;
      } catch {
        return false;
      } } }
    }

    if (platform === 'darwin') {
      try {
        await this.runner('pbcopy', [], 3000, text);
        return true;
      } catch { return false; }
    }

    // Windows: Set-Clipboard with the text traveling base64-encoded inside
    // the command — no shell quoting surface, no stdin newline issues.
    // (Base64 argv caps around ~24k source chars; larger writes are not
    // supported and the tool reports the failure honestly.)
    try {
      const b64 = Buffer.from(text, 'utf-8').toString('base64');
      await this.runner(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          `Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`],
        3000,
      );
      return true;
    } catch { return false; }
  }

  private async writeClipboard(text: string): Promise<ToolResult> {
    const wrote = await this.writeOnce(text);
    if (!wrote) {
      return { success: false, output: '', error: NO_TOOL_ERROR };
    }

    // Verification-in-depth: read the clipboard BACK and compare. The old
    // code trusted the writer's exit code alone; xclip can exit 0 and still
    // not own the selection (another owner takes over, or the daemon exits
    // before a reader attaches). Windows Get-Clipboard output carries a
    // trailing CRLF which is stripped on both sides of the compare.
    await new Promise((r) => setTimeout(r, 150));
    let readBack = await this.readOnce();

    if (readBack === null) {
      return {
        success: false,
        output: '',
        error: 'Clipboard write NOT verified: the write command ran but the clipboard could not be read back',
        data: { verified: false },
      };
    }
    const normalize = (s: string) => (currentPlatform() === 'windows' ? s.replace(/\r\n$/, '') : s);
    const actual = normalize(readBack);
    if (actual !== text) {
      return {
        success: false,
        output: '',
        error: `Clipboard write NOT verified: clipboard content (${actual.length} chars) does not match what was written (${text.length} chars)`,
        data: { verified: false, expectedLength: text.length, actualLength: actual.length },
      };
    }
    return { success: true, output: `Text copied to clipboard — verified by read-back (${text.length} chars)`, data: { verified: true, chars: text.length } };
  }
}
