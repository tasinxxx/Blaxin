import { Tool, ToolResult } from '../types.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, unlinkSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { screenshotTools, windowsScreenshotScript } from '../utils/platform.js';

const execFileAsync = promisify(execFile);

/**
 * Injectable command runner (verification seam). The default implementation
 * shells out to the real tools; tests inject fakes to drive honest-success /
 * honest-failure paths deterministically.
 */
export type ScreenshotRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number
) => Promise<{ stdout: string }>;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class ScreenshotTool implements Tool {
  name = 'screenshot';
  description = 'Take a screenshot of the current screen or a specific window. Returns the image as base64 data and a description of what is visible.';

  definition = {
    type: 'function' as const,
    function: {
      name: 'screenshot',
      description: 'Capture a screenshot of the desktop. Useful for observing the current state of applications and the GUI.',
      parameters: {
        type: 'object',
        properties: {
          region: {
            type: 'string',
            description: 'Optional region to capture (format: "WxH+X+Y" or "all" for full screen)',
          },
          window: {
            type: 'string',
            description: 'Optional window title to capture',
          },
        },
        required: [],
      },
    },
  };

  constructor(private runner: ScreenshotRunner = (cmd, args, timeoutMs) => execFileAsync(cmd, args, { timeout: timeoutMs })) {}

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const screenshotPath = join(tmpdir(), `blaxin-screenshot-${Date.now()}.png`);

    try {
      // Per-platform capture chain from the platform module (Linux order is
      // the frozen v1.4.0 contract: scrot → gnome-screenshot → import).
      const tools = screenshotTools().map((t) => ({
        name: t.name,
        cmd: t.cmd,
        // Windows supplies the full -Command script (encoded path inside);
        // every other tool takes the destination path as its last argument.
        args: t.cmd === 'powershell.exe'
          ? ['-Command', windowsScreenshotScript(screenshotPath)]
          : [...t.args, screenshotPath],
      }));

      let captured = false;
      for (const tool of tools) {
        try {
          await this.runner(tool.cmd, tool.args, 10000);
          captured = true;
          break;
        } catch {
          continue;
        }
      }

      if (!captured) {
        // Verification-in-depth (§68): a screenshot tool that did not run and
        // did not produce an image is a FAILURE, never a success — even when
        // an X11 display is present. The old path claimed
        // success: true with no screenshot (fabricated success).
        try {
          await this.runner('xdotool', ['getactivewindow', 'getwindowname'], 5000);
          return {
            success: false,
            output: '',
            error: 'Screenshot NOT captured: no screenshot tool available (X11 display is present). Install one: sudo apt install scrot',
            data: { screenshotAvailable: false },
          };
        } catch {
          return {
            success: false,
            output: '',
            error: 'Screenshot NOT captured: no screenshot tool available. Install one: sudo apt install scrot',
            data: { screenshotAvailable: false },
          };
        }
      }

      if (existsSync(screenshotPath)) {
        const stats = statSync(screenshotPath);
        const imageBuffer = readFileSync(screenshotPath);

        // Verify the capture is a REAL image before claiming success: a
        // zero-byte or non-PNG file (e.g. a tool that exited 0 but wrote
        // nothing on a dead display) is an honest failure, not a screenshot.
        if (stats.size === 0) {
          try { unlinkSync(screenshotPath); } catch {}
          return {
            success: false,
            output: '',
            error: 'Screenshot NOT captured: the screenshot tool wrote a 0-byte file',
            data: { screenshotAvailable: false },
          };
        }
        if (imageBuffer.length < PNG_SIGNATURE.length || !imageBuffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
          try { unlinkSync(screenshotPath); } catch {}
          return {
            success: false,
            output: '',
            error: 'Screenshot NOT captured: the screenshot tool did not produce a valid PNG image',
            data: { screenshotAvailable: false, fileSize: stats.size },
          };
        }

        const base64Data = imageBuffer.toString('base64');

        // Write the screenshot data as a file the frontend can display
        const previewPath = join(tmpdir(), 'blaxin-latest-screenshot.png');
        writeFileSync(previewPath, imageBuffer);

        // Clean up the original temp file
        unlinkSync(screenshotPath);

        return {
          success: true,
          output: `Screenshot captured successfully (${stats.size} bytes). Image data is available as base64 in the data field. The screenshot shows the current desktop state.`,
          data: {
            screenshotAvailable: true,
            size: stats.size,
            base64: base64Data,
            mimeType: 'image/png',
            previewPath,
          },
        };
      }

      return { success: false, output: '', error: 'Screenshot NOT captured: the screenshot tool ran but created no file' };
    } catch (error: any) {
      return { success: false, output: '', error: `Screenshot failed: ${error.message}` };
    }
  }
}
