import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { classifyDirect } from '../router/direct.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'blaxin-router-'));
  writeFileSync(join(dir, 'notes.txt'), 'hello world');
  mkdirSync(join(dir, 'sub'), { recursive: true });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fast-path router: direct actions', () => {
  it('classifies screenshots', () => {
    for (const msg of ['take a screenshot', 'screenshot', 'grab a screenshot', 'capture the screen']) {
      expect(classifyDirect(msg)?.tool).toBe('screenshot');
    }
  });

  it('classifies clipboard reads', () => {
    for (const msg of ["what's on my clipboard", 'read the clipboard', 'show me the clipboard contents']) {
      expect(classifyDirect(msg)?.tool).toBe('clipboard');
    }
  });

  it('classifies volume get/set/mute to the verified system-audio tool', () => {
    for (const msg of ['volume', 'what is the volume', 'check the volume', 'is the sound muted']) {
      const get = classifyDirect(msg);
      expect(get?.tool).toBe('system-audio');
      expect(get?.args.action).toBe('get');
    }
    const set = classifyDirect('set volume to 42');
    expect(set?.tool).toBe('system-audio');
    expect(set?.args).toMatchObject({ action: 'set', percent: 42 });
    expect(classifyDirect('volume 80')?.args).toMatchObject({ action: 'set', percent: 80 });
    expect(classifyDirect('turn the volume up to 65 percent')?.args).toMatchObject({ action: 'set', percent: 65 });
    expect(classifyDirect('mute')?.args).toMatchObject({ action: 'mute' });
    expect(classifyDirect('unmute')?.args).toMatchObject({ action: 'unmute' });
  });

  it('routes process listing and pid-specific kill to process-control', () => {
    for (const msg of ['list processes', 'what processes are running', 'what is running', 'show me the running processes', 'processes?']) {
      const hit = classifyDirect(msg);
      expect(hit?.tool).toBe('process-control');
      expect(hit?.args).toMatchObject({ action: 'list' });
    }
    // Kill ONLY with an explicit numeric pid (never a guessed name).
    expect(classifyDirect('kill 1234')?.args).toMatchObject({ action: 'kill', pid: 1234 });
    expect(classifyDirect('kill pid 567')?.args).toMatchObject({ action: 'kill', pid: 567 });
    expect(classifyDirect('terminate process 42')?.args).toMatchObject({ action: 'kill', pid: 42 });
    expect(classifyDirect('kill -9 999')?.args).toMatchObject({ action: 'kill', pid: 999, force: true });
    expect(classifyDirect('force kill 12')?.args).toMatchObject({ action: 'kill', pid: 12, force: true });
    // A name-based kill is a guess — stays with the LLM loop.
    expect(classifyDirect('kill the browser')).toBeNull();
    expect(classifyDirect('kill chrome')).toBeNull();
    // Bare kill with no target is never guessed either.
    expect(classifyDirect('kill')).toBeNull();
    // Inspect by pid.
    expect(classifyDirect('what is pid 4242')?.args).toMatchObject({ action: 'inspect', pid: 4242 });
    expect(classifyDirect('inspect pid 7')?.args).toMatchObject({ action: 'inspect', pid: 7 });
  });

  it('refuses out-of-range or nonsense volume values instead of guessing', () => {
    expect(classifyDirect('set volume to 500')).toBeNull();
    expect(classifyDirect('set volume to -10')).toBeNull();
  });

  it('routes organize-by-type to the gated bulk-files tool against real dirs only', () => {
    const hit = classifyDirect(`organize the files in ${dir} by type`);
    expect(hit?.tool).toBe('bulk-files');
    expect(hit?.args).toMatchObject({ operation: 'organize' });
    expect(classifyDirect(`sort files in ${dir}`)?.tool).toBe('bulk-files');
    // A non-directory target is refused, never guessed.
    expect(classifyDirect('organize the files in certainly-not-a-real-dir-xyz')).toBeNull();
  });

  it('routes content-hash dedupe: report (read-only) vs delete modes, real dirs only', () => {
    expect(classifyDirect(`find duplicate files in ${dir}`)).toMatchObject({
      tool: 'bulk-files',
      args: { operation: 'dedupe', mode: 'report', path: dir },
    });
    expect(classifyDirect(`check ${dir} for duplicates`)).toMatchObject({
      tool: 'bulk-files',
      args: { operation: 'dedupe', mode: 'report', path: dir },
    });
    expect(classifyDirect(`dedupe ${dir}`)).toMatchObject({
      tool: 'bulk-files',
      args: { operation: 'dedupe', mode: 'report', path: dir },
    });
    expect(classifyDirect(`delete duplicate files in ${dir}`)).toMatchObject({
      tool: 'bulk-files',
      args: { operation: 'dedupe', mode: 'delete_duplicates', path: dir },
    });
    // Non-directory target is refused, never guessed.
    expect(classifyDirect('find duplicate files in certainly-not-a-real-dir-xyz')).toBeNull();
  });

  it('routes bare form-submit to the verified blaxin_web action', () => {
    expect(classifyDirect('submit the form')).toMatchObject({ tool: 'blaxin_web', args: { action: 'form_submit' } });
    expect(classifyDirect('submit')).toMatchObject({ tool: 'blaxin_web', args: { action: 'form_submit' } });
    expect(classifyDirect('send form')).toMatchObject({ tool: 'blaxin_web', args: { action: 'form_submit' } });
    // Filling fields carries user intent (the values) — the LLM loop owns it.
    expect(classifyDirect('fill the form with my name')).toBeNull();
  });

  it('routes single-target downloads with disk verification; multi-step phrasing stays with the LLM', () => {
    expect(classifyDirect('download the quarterly report')).toMatchObject({
      tool: 'blaxin_web',
      args: { action: 'download', target: 'quarterly report' },
    });
    expect(classifyDirect('save the installer')).toMatchObject({ tool: 'blaxin_web', args: { action: 'download' } });
    // Multi-step / sourced / URL targets are NOT one unambiguous action.
    expect(classifyDirect('download the file from dropbox')).toBeNull();
    expect(classifyDirect('download https://example.com/file.zip')).toBeNull();
    expect(classifyDirect('download the tool and install it')).toBeNull();
  });

  it('classifies system info by facet', () => {
    expect(classifyDirect('how much ram do i have')).toMatchObject({ tool: 'system-info', args: { info: 'memory' } });
    expect(classifyDirect('disk usage')).toMatchObject({ tool: 'system-info', args: { info: 'disk' } });
    expect(classifyDirect('cpu status')).toMatchObject({ tool: 'system-info', args: { info: 'cpu' } });
    expect(classifyDirect('system info')).toMatchObject({ tool: 'system-info', args: { info: 'all' } });
  });

  it('classifies file reads and directory listings against real paths', () => {
    const file = join(dir, 'notes.txt');
    expect(classifyDirect(`read ${file}`)).toMatchObject({ tool: 'filesystem', args: { operation: 'read', path: file } });
    expect(classifyDirect(`what's in ${file}`)).toMatchObject({ tool: 'filesystem', args: { operation: 'read' } });
    expect(classifyDirect(`list files in ${dir}`)).toMatchObject({ tool: 'filesystem', args: { operation: 'list', path: dir } });
    expect(classifyDirect(`ls ${dir}`)).toMatchObject({ tool: 'filesystem', args: { operation: 'list', path: dir } });
    expect(classifyDirect(`show me the contents of ${dir}`)).toMatchObject({ tool: 'filesystem', args: { operation: 'list' } });
  });

  it('classifies URLs and app launches', () => {
    expect(classifyDirect('open https://example.com')).toMatchObject({ tool: 'browser', args: { action: 'open_url', url: 'https://example.com' } });
    expect(classifyDirect('open example.com')).toMatchObject({ tool: 'browser', args: { url: 'https://example.com' } });
    expect(classifyDirect('open firefox')).toMatchObject({ tool: 'computer-control', args: { action: 'launch_app', app: 'firefox' } });
  });

  it('resolves known site names to browser URLs deterministically', () => {
    expect(classifyDirect('open youtube')).toMatchObject({ tool: 'browser', args: { action: 'open_url', url: 'https://youtube.com' } });
    expect(classifyDirect('open gmail')).toMatchObject({ tool: 'browser', args: { url: 'https://mail.google.com' } });
    expect(classifyDirect('open GitHub')).toMatchObject({ tool: 'browser', args: { url: 'https://github.com' } });
    expect(classifyDirect('open wikipedia')).toMatchObject({ tool: 'browser', args: { url: 'https://wikipedia.org' } });
    // explicit URLs still win over aliases
    expect(classifyDirect('open youtube.com')).toMatchObject({ tool: 'browser', args: { url: 'https://youtube.com' } });
    // unknown single-word targets stay app launches
    expect(classifyDirect('open firefox')).toMatchObject({ tool: 'computer-control', args: { action: 'launch_app', app: 'firefox' } });
  });

  it('classifies web searches', () => {
    expect(classifyDirect('search the web for quantum computing')).toMatchObject({ tool: 'search', args: { query: 'quantum computing' } });
    expect(classifyDirect('search for best pizza')).toMatchObject({ tool: 'search' });
    expect(classifyDirect('google weather today')).toMatchObject({ tool: 'search' });
  });

  it('routes YouTube playback/search deterministically to the grounded blaxin_web tool', () => {
    expect(classifyDirect('play never gonna give you up on youtube')).toMatchObject({
      tool: 'blaxin_web',
      args: { action: 'youtube_play', query: 'never gonna give you up' },
    });
    expect(classifyDirect('watch lofi beats on yt')).toMatchObject({
      tool: 'blaxin_web',
      args: { action: 'youtube_play', query: 'lofi beats' },
    });
    expect(classifyDirect('search youtube for blaxin demo')).toMatchObject({
      tool: 'blaxin_web',
      args: { action: 'youtube_search', query: 'blaxin demo' },
    });
    expect(classifyDirect('find me a tutorial on youtube')).toMatchObject({
      tool: 'blaxin_web',
      args: { action: 'youtube_search', query: 'a tutorial' },
    });
    // Ambiguous fragments stay on the LLM path — never guessed.
    expect(classifyDirect('play')).toBeNull();
    expect(classifyDirect('play something')).toBeNull();
  });

  it('routes browser session control deterministically (§6)', () => {
    for (const msg of ['back', 'go back', 'go back a page', 'previous page', 'go to the previous page', 'browser back']) {
      expect(classifyDirect(msg), msg).toMatchObject({ tool: 'browser', args: { action: 'back' } });
    }
    for (const msg of ['forward', 'go forward', 'go forward one page', 'go to the next page']) {
      expect(classifyDirect(msg), msg).toMatchObject({ tool: 'browser', args: { action: 'forward' } });
    }
    for (const msg of ['refresh', 'reload', 'refresh the page', 'reload the tab']) {
      expect(classifyDirect(msg), msg).toMatchObject({ tool: 'browser', args: { action: 'refresh' } });
    }
    for (const msg of ['new tab', 'open a new tab', 'open new tab', 'create another new tab']) {
      expect(classifyDirect(msg), msg).toMatchObject({ tool: 'browser', args: { action: 'open_new_tab' } });
    }
    for (const msg of ['close tab', 'close this tab', 'close the current tab']) {
      expect(classifyDirect(msg), msg).toMatchObject({ tool: 'browser', args: { action: 'close_tab' } });
    }
    for (const msg of ["what's the current url", 'current url', 'what url am i on', 'what page am i on', 'show me the url']) {
      expect(classifyDirect(msg), msg).toMatchObject({ tool: 'browser', args: { action: 'current_url' } });
    }
    for (const msg of ["what's the page title", 'page title', "what's the title of this page", 'show me the page title']) {
      expect(classifyDirect(msg), msg).toMatchObject({ tool: 'browser', args: { action: 'page_title' } });
    }
    for (const msg of ['list tabs', 'show me the tabs', 'show open tabs', 'what tabs are open']) {
      expect(classifyDirect(msg), msg).toMatchObject({ tool: 'browser', args: { action: 'list_tabs' } });
    }
  });

  it('routes "go to / navigate to <url|site>" to a deterministic navigation', () => {
    expect(classifyDirect('go to youtube')).toMatchObject({ tool: 'browser', args: { action: 'open_url', url: 'https://youtube.com' } });
    expect(classifyDirect('navigate to example.com')).toMatchObject({ tool: 'browser', args: { url: 'https://example.com' } });
    expect(classifyDirect('go to https://github.com')).toMatchObject({ tool: 'browser', args: { url: 'https://github.com' } });
    expect(classifyDirect('take me to gmail')).toMatchObject({ tool: 'browser', args: { url: 'https://mail.google.com' } });
    expect(classifyDirect('goto wikipedia')).toMatchObject({ tool: 'browser', args: { action: 'open_url' } });
    // An unresolvable destination is never guessed.
    expect(classifyDirect('go to my settings page')).toBeNull();
  });
});

describe('fast-path router: refusal to guess', () => {
  it('rejects multi-step, negated, or ambiguous requests', () => {
    for (const msg of [
      'open firefox and chrome',
      "don't open anything",
      'read the file about cats and summarize it',
      'please send an email',
      'what time is it',
      'delete /tmp/x.txt',
      'read /definitely/not/here.txt',
      'open example.com/docs',
      'show firefox',
      // Browser session phrases that are NOT the deterministic action.
      "don't go back",
      'refresh my memory',
      'back up my files',
      'reload the page and take a screenshot',
      'go to my settings page',
    ]) {
      expect(classifyDirect(msg), `expected NULL for: ${msg}`).toBeNull();
    }
  });

  it('never returns a terminal or mutating action', () => {
    expect(classifyDirect('run ls -la')).toBeNull();
    expect(classifyDirect('create a file called test')).toBeNull();
  });
});
