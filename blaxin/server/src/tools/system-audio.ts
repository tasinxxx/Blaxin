import { Tool, ToolResult } from '../types.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Injectable command runner (verification seam). The default runs the real
 * wpctl (PipeWire volume control); tests inject fakes to drive honest
 * success/failure/unavailable paths deterministically.
 */
export type AudioRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: AudioRunner = (cmd, args, timeoutMs) =>
  execFileAsync(cmd, args, { timeout: timeoutMs });

/** wpctl reports volume as a linear scale (0.0–1.5+); we expose percent. */
function parseSinks(stdout: string): { id: number | null; volumePct: number | null; muted: boolean | null } {
  const sinkLine = /^[*]\s+(\d+)\.\s+(.*)$/m.exec(stdout);
  const id = sinkLine ? Number(sinkLine[1]) : null;
  // "[vol: 0.65]" — the default sink's volume
  const volMatch = /\[vol:\s*([\d.]+)\]/.exec(stdout);
  const volumePct = volMatch ? Math.round(Number(volMatch[1]) * 100) : null;
  // "[ audio_muted" style: muted sinks show "MUTED" in the status output
  const muted = /\[\s*audio_muted[^\]]*\]/.test(stdout) || /MUTED/.test(stdout);
  return { id, volumePct, muted };
}

export class SystemAudioTool implements Tool {
  name = 'system-audio';
  description = 'Get or set the system output volume (default audio sink). Real read-back verification: a set is only successful when a fresh read confirms the new level.';

  private runner: AudioRunner;

  constructor(runner?: AudioRunner) {
    this.runner = runner ?? defaultRunner;
  }

  definition = {
    type: 'function' as const,
    function: {
      name: 'system_audio',
      description:
        'Get or set the system output volume. Actions: get (read the current volume/mute state), ' +
        'set (set volume to a percent, 0-150), mute, unmute. A set/mute is only SUCCESS when a ' +
        'fresh read-back confirms the change.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['get', 'set', 'mute', 'unmute'],
            description: 'The volume action to perform',
          },
          percent: {
            type: 'number',
            description: 'Volume percent for the set action (0–150)',
          },
        },
        required: ['action'],
      },
    },
  };

  private async readVolume(): Promise<{ id: number | null; volumePct: number | null; muted: boolean | null }> {
    const { stdout } = await this.runner('wpctl', ['status'], 5000);
    return parseSinks(stdout);
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;

    // wpctl is the only backend: honest unavailability instead of a guess.
    try {
      await this.runner('which', ['wpctl'], 3000);
    } catch {
      return {
        success: false,
        output: '',
        error: 'Audio control unavailable: wpctl (PipeWire) not found. Install pipewire + wireplumber.',
        data: { available: false },
      };
    }

    try {
      switch (action) {
        case 'get': {
          const state = await this.readVolume();
          if (state.volumePct === null) {
            return {
              success: false,
              output: '',
              error: 'Volume state unreadable: no default sink with a volume in wpctl status output.',
              data: { available: true, verified: false },
            };
          }
          const mutedNote = state.muted ? ' (MUTED)' : '';
          return {
            success: true,
            output: `Output volume: ${state.volumePct}%${mutedNote} (read from the live PipeWire default sink)`,
            data: {
              available: true,
              volumePct: state.volumePct,
              muted: state.muted,
              sinkId: state.id,
              verified: true,
            },
          };
        }

        case 'set': {
          const percent = Number(args.percent);
          if (!Number.isFinite(percent) || percent < 0 || percent > 150) {
            return {
              success: false,
              output: '',
              error: 'Invalid volume percent: must be a number between 0 and 150.',
            };
          }
          const before = await this.readVolume();
          // wpctl set-volume <sink|@DEFAULT_AUDIO_SINK@> <fraction>
          await this.runner('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', String(percent / 100)], 5000);
          // Verification-in-depth: re-read the LIVE state. Exit 0 only
          // proves the request was accepted, not that the level changed.
          const after = await this.readVolume();
          if (after.volumePct === null) {
            return {
              success: false,
              output: '',
              error: 'Volume set NOT verified: post-set read-back failed.',
              data: { available: true, requested: percent, verified: false },
            };
          }
          if (Math.abs(after.volumePct - percent) > 1) {
            return {
              success: false,
              output: '',
              error: `Volume set NOT verified: requested ${percent}%, read-back shows ${after.volumePct}%.`,
              data: { available: true, requested: percent, actual: after.volumePct, verified: false },
            };
          }
          return {
            success: true,
            output: `Volume set to ${after.volumePct}% — verified by read-back (${before.volumePct}% → ${after.volumePct}%).`,
            data: {
              available: true,
              requested: percent,
              before: before.volumePct,
              after: after.volumePct,
              muted: after.muted,
              verified: true,
            },
          };
        }

        case 'mute':
        case 'unmute': {
          const wantMuted = action === 'mute';
          await this.runner('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', wantMuted ? '1' : '0'], 5000);
          // Read-back: wpctl status marks the muted sink. A MUTED marker
          // after `mute` (and its absence after `unmute`) is the proof.
          const after = await this.readVolume();
          if (after.muted === null) {
            return {
              success: false,
              output: '',
              error: `Mute ${action} NOT verified: post-set read-back could not determine mute state.`,
              data: { available: true, verified: false },
            };
          }
          if (after.muted !== wantMuted) {
            return {
              success: false,
              output: '',
              error: `Mute ${action} NOT verified: read-back shows muted=${after.muted}.`,
              data: { available: true, requestedMuted: wantMuted, actualMuted: after.muted, verified: false },
            };
          }
          return {
            success: true,
            output: `${wantMuted ? 'Muted' : 'Unmuted'} the default sink — verified by read-back (muted=${after.muted}).`,
            data: { available: true, muted: after.muted, volumePct: after.volumePct, verified: true },
          };
        }

        default:
          return {
            success: false,
            output: '',
            error: `Unknown action: ${action}. Use get, set, mute, or unmute.`,
          };
      }
    } catch (error: any) {
      return {
        success: false,
        output: '',
        error: `Audio control failed: ${error?.message ?? String(error)}`,
        data: { available: true },
      };
    }
  }
}
