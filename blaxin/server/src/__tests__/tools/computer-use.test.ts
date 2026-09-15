// CLOSED-LOOP COMPUTER-USE PROOF (env-gated: BLAXIN_COMPUTER_USE=1)
// =============================================================
// Runs the REAL closed loop end to end on a private Xvfb display:
//   screenshot (real pixels) → PNG validated → OCR perception (real
//   grounding) → model decision stage (local Ollama vision if present,
//   honest fallback otherwise) → smooth cursor travel + real click →
//   observed screen change → verified teardown.
// No mocks anywhere in the chain. Exit 0 = the loop is real.
//   BLAXIN_COMPUTER_USE=1 npx vitest run src/__tests__/tools/computer-use.test.ts
// Requires: Xvfb, xmessage, xdotool, import (ImageMagick), python3+tesseract,
// Pillow for the upscale ensemble (all probed honestly; skips list why).
// =============================================================

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// src/__tests__/tools/ → server/ → blaxin/ → scripts/computer-use/
const here = dirname(fileURLToPath(import.meta.url));
const probe = join(here, '..', '..', '..', '..', 'scripts', 'computer-use', 'probe-computer-use.mjs');

function missingTool(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
}

const FLAG = !!process.env.BLAXIN_COMPUTER_USE;
const REQUIRED = ['Xvfb', 'xmessage', 'xdotool', 'import', 'python3', 'tesseract'];
const missing = FLAG ? REQUIRED.filter(missingTool) : [];

const d = FLAG && missing.length === 0 ? it : it.skip;

describe('LIVE closed-loop computer use (real display, real pixels)', () => {
  d('drives the full observe→perceive→decide→act→observe→verify loop', () => {
    expect(existsSync(probe)).toBe(true);
    // The probe is the proof: it spawns a private Xvfb, launches a real
    // dialog, grounds the marker button from OCR on real pixels, moves the
    // real cursor, clicks, and verifies the resulting screen state.
    const out = execFileSync('node', [probe], { encoding: 'utf8', timeout: 360000 });
    expect(out).toContain('checks: 9/9 PASS');
    // The summary must name the real stages, not mocks.
    expect(out).toMatch(/perception:.*grounded elements/i);
    expect(out).toMatch(/decision:.*stage=/i);
    expect(out).toMatch(/action:.*smooth travel \+ click/i);
  }, 380000);
});
