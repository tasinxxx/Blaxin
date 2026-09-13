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
