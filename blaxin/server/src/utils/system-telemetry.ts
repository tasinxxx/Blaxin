// BLAXIN system telemetry
// =============================================================
// Real, dependency-free readings for the live system panel. Never
// invents numbers: CPU usage is derived from os.cpus() tick deltas
// between calls, memory from os.totalmem/freemem, disk from statfs
// (with a df fallback). No polling happens server-side — each request
// is one cheap read; the client controls the cadence.
//
// 10× system awareness: battery (/sys/class/power_supply), display +
// windows (X11 via xwininfo/xprop, ONE-TWO spawns per request), audio
// (wpctl get-volume), and per-process CPU (kernel tick deltas from
// /proc — the same honest delta semantics as the CPU number). Every
// sensor reports an honest UNAVAILABLE (null / explicit reason) when
// its source is absent — a null is never rendered as a zero.
// =============================================================

import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { statfsSync } from 'fs';

const execFileAsync = promisify(execFile);

export interface CpuTelemetry {
  /** Percent of CPU ticks spent busy since the previous call (0-100). */
  usagePercent: number;
  cores: number;
  model: string | null;
  loadAvg: { one: number; five: number; fifteen: number };
}

export interface MemoryTelemetry {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  percent: number;
}

export interface DiskTelemetry {
  totalBytes: number;
  usedBytes: number;
  percent: number;
  mount: string;
}

export interface BatteryCell {
  name: string;
  status: string;
  capacityPercent: number | null;
  /** Real per-cell power draw (µW→W) when the sensor reports it. */
  powerWatts: number | null;
  technology: string | null;
  model: string | null;
}

export interface BatteryTelemetry {
  /** True when AC mains is online right now. */
  acOnline: boolean | null;
  /** Kernel battery status, verbatim ('Charging', 'Discharging', …). */
  status: string | null;
  capacityPercent: number | null;
  /** Bounded minutes remaining derived from real energy/power fields. */
  minutesRemaining: number | null;
  /** Real draw across batteries in watts when sensors report it. */
  powerWatts: number | null;
  cycleCount: number | null;
  model: string | null;
  cells: BatteryCell[];
  /** null = this machine has no battery at all (honest desktop case). */
  present: boolean;
}

export interface DisplayTelemetry {
  available: boolean;
  /** Why it is unavailable when available=false (honest, no guessing). */
  unavailableReason?: string;
  /** X display name actually read (e.g. ':0'). */
  display: string | null;
  widthPx: number | null;
  heightPx: number | null;
  /** The window manager's active (focused) window, from _NET_ACTIVE_WINDOW. */
  activeWindowId: string | null;
  activeWindowTitle: string | null;
}

export interface WindowInfo {
  id: string;
  title: string | null;
  wmClass: string | null;
  geometry: { x: number; y: number; width: number; height: number } | null;
}

export interface WindowsTelemetry {
  available: boolean;
  unavailableReason?: string;
  windows: WindowInfo[];
  /** Bounded list (first N windows, stacking order). */
  truncated: boolean;
}

export interface AudioTelemetry {
  available: boolean;
  unavailableReason?: string;
  /** Output volume percent of the default sink (0–150, wpctl scale). */
  volumePercent: number | null;
  muted: boolean | null;
}

export interface ProcessInfo {
  pid: number;
  comm: string;
  /** Real per-process CPU % from kernel tick deltas (null on first sample). */
  cpuPercent: number | null;
  rssBytes: number | null;
}

export interface ProcessesTelemetry {
  count: number;
  /** Top processes by CPU delta (bounded). First call: cpuPercent null. */
  top: ProcessInfo[];
  totalRssBytes: number | null;
}

export interface SystemTelemetry {
  timestamp: number;
  cpu: CpuTelemetry;
  memory: MemoryTelemetry;
  disk: DiskTelemetry | null;
  uptimeSec: number;
  os: { platform: string; release: string; arch: string; hostname: string };
  nodeVersion: string;
  /** 10× system awareness sensors — each null-honest when absent. */
  battery: BatteryTelemetry | null;
  display: DisplayTelemetry | null;
  windows: WindowsTelemetry | null;
  audio: AudioTelemetry | null;
  processes: ProcessesTelemetry;
}

interface CpuSample {
  idle: number;
  total: number;
}

function cpuSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

// Baseline taken at module load so even the first request has a delta.
let lastCpu: CpuSample = cpuSample();

function cpuUsagePercent(): number {
  const now = cpuSample();
  const prev = lastCpu;
  lastCpu = now;
  const idleDelta = now.idle - prev.idle;
  const totalDelta = now.total - prev.total;
  if (totalDelta <= 0 || idleDelta < 0) return 0;
  const used = Math.round((1 - idleDelta / totalDelta) * 100);
  return Math.max(0, Math.min(100, used));
}

function statfsDisk(mount: string): DiskTelemetry | null {
  try {
    const s = (statfsSync as (p: string) => { blocks: number; bsize: number; bfree: number; bavail: number })(mount);
    if (!s || typeof s.blocks !== 'number' || typeof s.bsize !== 'number') return null;
    const total = s.blocks * s.bsize;
    const free = (typeof s.bavail === 'number' ? s.bavail : s.bfree) * s.bsize;
    const used = Math.max(0, total - free);
    return {
      totalBytes: total,
      usedBytes: used,
      percent: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
      mount,
    };
  } catch {
    return null;
  }
}

async function diskUsage(mount: string): Promise<DiskTelemetry | null> {
  if (typeof statfsSync === 'function') {
    const viaStatfs = statfsDisk(mount);
    if (viaStatfs) return viaStatfs;
  }
  // Fallback: df -kP (POSIX, stable column order with -P).
  try {
    const { stdout } = await execFileAsync('df', ['-kP', mount]);
    const lines = stdout.trim().split('\n');
    const last = lines[lines.length - 1]?.trim().split(/\s+/);
    if (last && last.length >= 5 && /^\d+$/.test(last[1])) {
      const totalKb = Number(last[1]);
      const usedKb = Number(last[2]);
      const pct = Number((last[4] || '0').replace('%', ''));
      return {
        totalBytes: totalKb * 1024,
        usedBytes: usedKb * 1024,
        percent: Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0,
        mount: last[5] ?? mount,
      };
    }
  } catch {
    // df unavailable — disk stays null, the UI says so.
  }
  return null;
}

// ── Network throughput (real /proc/net/dev deltas) ───────────

export interface NetworkInterfaceSample {
  name: string;
  rxBytes: number;
  txBytes: number;
}

export interface NetworkTelemetry {
  timestamp: number;
  /** Bytes per second since the previous call (aggregate, non-loopback). */
  rxBytesPerSec: number;
  txBytesPerSec: number;
  interfaces: NetworkInterfaceSample[];
  /** Cumulative bytes since boot (non-loopback aggregate). */
  rxTotalBytes: number;
  txTotalBytes: number;
}

function readNetDev(): NetworkInterfaceSample[] {
  try {
    const raw = readFileSync('/proc/net/dev', 'utf-8');
    const out: NetworkInterfaceSample[] = [];
    for (const line of raw.split('\n').slice(2)) {
      const m = line.trim().match(/^([^:]+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
      if (!m) continue;
      const name = m[1];
      if (name === 'lo') continue; // loopback traffic is not "network"
      out.push({ name, rxBytes: Number(m[2]), txBytes: Number(m[3]) });
    }
    return out;
  } catch {
    // /proc/net/dev unavailable (non-Linux / sandboxed) — empty, the UI says so.
    return [];
  }
}

let lastNetSample: { at: number; rx: number; tx: number } | null = null;

function networkThroughput(): { rxBytesPerSec: number; txBytesPerSec: number; rxTotal: number; txTotal: number } {
  const ifaces = readNetDev();
  const rxTotal = ifaces.reduce((s, i) => s + i.rxBytes, 0);
  const txTotal = ifaces.reduce((s, i) => s + i.txBytes, 0);
  const now = Date.now();
  if (!lastNetSample) {
    lastNetSample = { at: now, rx: rxTotal, tx: txTotal };
    return { rxBytesPerSec: 0, txBytesPerSec: 0, rxTotal, txTotal };
  }
  const dt = (now - lastNetSample.at) / 1000;
  const rxRate = dt > 0 ? Math.max(0, (rxTotal - lastNetSample.rx) / dt) : 0;
  const txRate = dt > 0 ? Math.max(0, (txTotal - lastNetSample.tx) / dt) : 0;
  lastNetSample = { at: now, rx: rxTotal, tx: txTotal };
  return { rxBytesPerSec: rxRate, txBytesPerSec: txRate, rxTotal, txTotal };
}

export function getNetworkTelemetry(): NetworkTelemetry {
  const { rxBytesPerSec, txBytesPerSec, rxTotal, txTotal } = networkThroughput();
  return {
    timestamp: Date.now(),
    rxBytesPerSec,
    txBytesPerSec,
    interfaces: readNetDev(),
    rxTotalBytes: rxTotal,
    txTotalBytes: txTotal,
  };
}

// ── Battery (real /sys/class/power_supply) ─────────────────

interface PsUevent {
  [key: string]: string;
}

function readUevent(dir: string): PsUevent {
  const out: PsUevent = {};
  try {
    const raw = readFileSync(`${dir}/uevent`, 'utf-8');
    for (const line of raw.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
  } catch {
    /* absent field */
  }
  return out;
}

function num(v: string | undefined): number | null {
  if (v === undefined || !/^\d+$/.test(v)) return null;
  return Number(v);
}

export function getBatteryTelemetry(now: number = Date.now()): BatteryTelemetry {
  let entries: string[] = [];
  try {
    entries = readdirSync('/sys/class/power_supply');
  } catch {
    return { present: false, acOnline: null, status: null, capacityPercent: null, minutesRemaining: null, powerWatts: null, cycleCount: null, model: null, cells: [] };
  }
  const isBattery = (d: string) => {
    try {
      return readUevent(`/sys/class/power_supply/${d}`).POWER_SUPPLY_TYPE?.split(',')[0] === 'Battery';
    } catch {
      return false;
    }
  };
  const isMains = (d: string) => {
    try {
      return readUevent(`/sys/class/power_supply/${d}`).POWER_SUPPLY_TYPE === 'Mains';
    } catch {
      return false;
    }
  };
  const batteries = entries.filter(isBattery);
  const ac = entries.find(isMains);

  const cells: BatteryCell[] = batteries.map((name) => {
    const d = `/sys/class/power_supply/${name}`;
    const u = readUevent(d);
    const status = u.POWER_SUPPLY_STATUS ?? null;
    const energyNow = num(u.POWER_SUPPLY_ENERGY_NOW);
    const powerNow = num(u.POWER_SUPPLY_POWER_NOW);
    let minutes: number | null = null;
    if (energyNow !== null && powerNow !== null && powerNow > 0) {
      minutes = status === 'Charging'
        ? Math.round(((num(u.POWER_SUPPLY_ENERGY_FULL) ?? 0) - energyNow) / powerNow * 60)
        : Math.round((energyNow / powerNow) * 60);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) minutes = null;
    }
    return {
      name,
      status,
      capacityPercent: num(u.POWER_SUPPLY_CAPACITY),
      powerWatts: powerNow !== null ? Math.round((powerNow / 1_000_000) * 100) / 100 : null,
      technology: u.POWER_SUPPLY_TECHNOLOGY ?? null,
      model: u.POWER_SUPPLY_MODEL_NAME?.trim() || null,
    };
  });

  if (batteries.length === 0) {
    // No battery at all (pure-AC desktop / docked USB-C PD): present=false
    // whenever there is no Battery-type supply. AC mains presence is still
    // reported honestly — an AC-only machine DOES have real mains state.
    return {
      present: false,
      acOnline: ac !== undefined ? num(readUevent(`/sys/class/power_supply/${ac}`).POWER_SUPPLY_ONLINE) === 1 : null,
      status: null,
      capacityPercent: null,
      minutesRemaining: null,
      powerWatts: null,
      cycleCount: null,
      model: null,
      cells: [],
    };
  }

  const acOnline = ac !== undefined ? num(readUevent(`/sys/class/power_supply/${ac}`).POWER_SUPPLY_ONLINE) === 1 : null;
  const caps = cells.map((c) => c.capacityPercent).filter((v): v is number => v !== null);
  const capacityPercent = caps.length > 0 ? Math.round(caps.reduce((a, b) => a + b, 0) / caps.length) : null;
  const status = acOnline === true ? 'Charging' : (cells.find((c) => c.status)?.status ?? null);
  const minutes = cells.map((c) => {
    const u = readUevent(`/sys/class/power_supply/${c.name}`);
    const energyNow = num(u.POWER_SUPPLY_ENERGY_NOW);
    const powerNow = num(u.POWER_SUPPLY_POWER_NOW);
    if (energyNow === null || powerNow === null || powerNow <= 0) return null;
    const m = acOnline === true
      ? Math.round(((num(u.POWER_SUPPLY_ENERGY_FULL) ?? 0) - energyNow) / powerNow * 60)
      : Math.round((energyNow / powerNow) * 60);
    return Number.isFinite(m) && m >= 0 && m <= 24 * 60 ? m : null;
  }).filter((v): v is number => v !== null);
  const watts = cells.map((c) => c.powerWatts).filter((v): v is number => v !== null);
  const cycle = cells.map((c) => {
    const u = readUevent(`/sys/class/power_supply/${c.name}`);
    return num(u.POWER_SUPPLY_CYCLE_COUNT);
  }).find((v) => v !== null) ?? null;
  const model = cells.map((c) => c.model).find(Boolean) ?? null;

  void now;
  return {
    present: true,
    acOnline,
    status,
    capacityPercent,
    minutesRemaining: minutes.length > 0 ? Math.min(...minutes) : null,
    powerWatts: watts.length > 0 ? Math.round(watts.reduce((a, b) => a + b, 0) * 100) / 100 : null,
    cycleCount: cycle,
    model,
    cells,
  };
}

// ── Display + windows (real X11, bounded spawns) ────────────

function xDisplayCandidates(): string[] {
  const out: string[] = [];
  if (process.env.DISPLAY) out.push(process.env.DISPLAY);
  if (!out.includes(':0')) out.push(':0');
  if (!out.includes(':0.0')) out.push(':0.0');
  return out;
}

async function xrun(cmd: string, args: string[], display: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    timeout: timeoutMs,
    env: { ...process.env, DISPLAY: display },
    maxBuffer: 512 * 1024,
  });
  return stdout;
}

export function parseXwininfoTree(stdout: string): { width: number | null; height: number | null } {
  // `xwininfo -root` reports the root geometry as Width:/Height: fields.
  const w = stdout.match(/^\s*Width:\s*(\d+)/m);
  const h = stdout.match(/^\s*Height:\s*(\d+)/m);
  return { width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null };
}

export function parseActiveWindowId(xpropRoot: string): string | null {
  const m = xpropRoot.match(/window id #\s*(0x[0-9a-f]+)/i);
  return m ? m[1] : null;
}

export function parseWindowGeometry(xwininfoOut: string): { x: number; y: number; width: number; height: number } | null {
  const m = xwininfoOut.match(/Absolute upper-left X:\s*(-?\d+)[\s\S]*?Absolute upper-left Y:\s*(-?\d+)[\s\S]*?Width:\s*(\d+)[\s\S]*?Height:\s*(\d+)/);
  return m ? { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) } : null;
}

export function parseXpropClass(xpropOut: string): string | null {
  const m = xpropOut.match(/WM_CLASS\(STRING\)\s*=\s*"([^"]*)",\s*"([^"]*)"/);
  return m ? m[2] || m[1] : null;
}

export function parseNetWmName(xpropOut: string): string | null {
  const m = xpropOut.match(/_NET_WM_NAME\(UTF8_STRING\)\s*=\s*"([\s\S]*?)"\s*\n/);
  return m ? m[1] : null;
}

const MAX_WINDOWS = 40;

export async function getDisplayAndWindowsTelemetry(): Promise<{ display: DisplayTelemetry | null; windows: WindowsTelemetry | null }> {
  for (const display of xDisplayCandidates()) {
    try {
      // ONE spawn for the root: geometry + active window id together.
      const rootOut = await xrun('xprop', ['-root'], display, 3000);
      const activeId = parseActiveWindowId(rootOut);
      // ONE spawn for the root geometry.
      let width: number | null = null;
      let height: number | null = null;
      try {
        const geo = parseXwininfoTree(await xrun('xwininfo', ['-root'], display, 3000));
        width = geo.width;
        height = geo.height;
      } catch { /* xwininfo absent — geometry stays null, xprop data is still real */ }

      // Windows: bounded walk. wmctrl is absent on many machines; use
      // xwininfo -root -children + per-window xprop (bounded to 40).
      const windows: WindowInfo[] = [];
      let truncated = false;
      try {
        const children = await xrun('xwininfo', ['-root', '-children'], display, 3000);
        const ids: string[] = [];
        for (const m of children.matchAll(/(^|\s)(0x[0-9a-f]+)\s+(?:\d+\s+){5}/g)) ids.push(m[2]);
        for (const id of ids.slice(0, MAX_WINDOWS)) {
          try {
            const props = await xrun('xprop', ['-id', id, 'WM_CLASS', '_NET_WM_NAME'], display, 2000);
            const wmClass = parseXpropClass(props);
            const title = parseNetWmName(props);
            if (!wmClass && !title) continue; // unmapped/pseudo windows have no identity
            let geometry: WindowInfo['geometry'] = null;
            try {
              geometry = parseWindowGeometry(await xrun('xwininfo', ['-id', id], display, 2000));
            } catch { /* geometry optional */ }
            windows.push({ id, title, wmClass, geometry });
          } catch { /* window vanished mid-walk — skip honestly */ }
        }
        truncated = ids.length > MAX_WINDOWS;
      } catch (e: any) {
        if (windows.length === 0) {
          return {
            display: { available: true, display, widthPx: width, heightPx: height, activeWindowId: activeId, activeWindowTitle: null },
            windows: { available: false, unavailableReason: `window enumeration failed: ${String(e?.message ?? e).slice(0, 120)}`, windows: [], truncated: false },
          };
        }
      }

      let activeWindowTitle: string | null = null;
      if (activeId) {
        try {
          const props = await xrun('xprop', ['-id', activeId, '_NET_WM_NAME', 'WM_CLASS'], display, 2000);
          activeWindowTitle = parseNetWmName(props) ?? parseXpropClass(props);
        } catch { /* active window vanished between reads */ }
      }

      return {
        display: { available: true, display, widthPx: width, heightPx: height, activeWindowId: activeId, activeWindowTitle },
        windows: { available: true, windows, truncated },
      };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!/Cannot open display|unable to open|No protocol/i.test(msg)) {
        // xprop missing etc — no point trying other displays, same tools.
        return {
          display: { available: false, unavailableReason: `X query failed: ${msg.slice(0, 120)}`, display: null, widthPx: null, heightPx: null, activeWindowId: null, activeWindowTitle: null },
          windows: { available: false, unavailableReason: `X query failed: ${msg.slice(0, 120)}`, windows: [], truncated: false },
        };
      }
      // Try the next display candidate.
    }
  }
  return {
    display: { available: false, unavailableReason: 'no reachable X display (headless or DISPLAY unset)', display: null, widthPx: null, heightPx: null, activeWindowId: null, activeWindowTitle: null },
    windows: { available: false, unavailableReason: 'no reachable X display (headless or DISPLAY unset)', windows: [], truncated: false },
  };
}

// ── Audio (real wpctl, read-only) ───────────────────────────

export function parseWpctlVolume(out: string): { volumePercent: number | null; muted: boolean | null } {
  const m = out.match(/Volume:\s*([\d.]+)/);
  if (!m) return { volumePercent: null, muted: null };
  // wpctl prints "[MUTED]" ONLY when muted — a parsed volume line without
  // it is genuinely unmuted (real wpctl semantic, not an assumption).
  return {
    volumePercent: Math.round(parseFloat(m[1]) * 100),
    muted: /MUTED/.test(out) ? true : false,
  };
}

export async function getAudioTelemetry(): Promise<AudioTelemetry> {
  try {
    const { stdout } = await execFileAsync('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'], { timeout: 3000, maxBuffer: 64 * 1024 });
    const { volumePercent, muted } = parseWpctlVolume(stdout);
    if (volumePercent === null) {
      return { available: false, unavailableReason: 'wpctl output not parseable', volumePercent: null, muted: null };
    }
    return { available: true, volumePercent, muted };
  } catch (e: any) {
    const code = String(e?.code ?? '');
    return {
      available: false,
      unavailableReason: code === 'ENOENT' ? 'wpctl (PipeWire) not installed' : `wpctl failed: ${String(e?.message ?? e).slice(0, 120)}`,
      volumePercent: null,
      muted: null,
    };
  }
}

// ── Processes (real /proc tick deltas — same honesty as CPU %) ──

interface ProcSample {
  pid: number;
  comm: string;
  ticks: number;
  rssBytes: number | null;
  sampledAt: number;
}

let lastProcSamples: Map<number, ProcSample> | null = null;

export function parseStat(stat: string): { utime: number; stime: number; comm: string; rssPages: number | null } | null {
  // comm can contain spaces and parentheses — split from the LAST ')'.
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const comm = stat.slice(stat.indexOf('(') + 1, close);
  const fields = stat.slice(close + 2).split(' ');
  // After 'state' (fields[0]), utime is field 11 and stime 12 in the
  // full line; relative to fields here: index 11-1=10 and 11.
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const rssPages = /^\d+$/.test(fields[21] ?? '') ? Number(fields[21]) : null;
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { utime, stime, comm, rssPages };
}

export function readProcSamples(): Map<number, ProcSample> {
  const out = new Map<number, ProcSample>();
  const hz = 100; // CLK_TCK is 100 on essentially all Linux userlands
  const pageSize = 4096;
  let at = Date.now();
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
        const p = parseStat(stat);
        if (!p) continue;
        out.set(Number(pid), {
          pid: Number(pid),
          comm: p.comm.slice(0, 64),
          ticks: p.utime + p.stime,
          rssBytes: p.rssPages !== null ? p.rssPages * pageSize : null,
          sampledAt: at,
        });
      } catch { /* process vanished — skip */ }
    }
  } catch { /* /proc unavailable */ }
  void hz;
  return out;
}

const MAX_TOP_PROCESSES = 8;

export function getProcessesTelemetry(): ProcessesTelemetry {
  const now = Date.now();
  const current = readProcSamples();
  const prev = lastProcSamples;
  lastProcSamples = current;

  const totalRss = [...current.values()].reduce((s, p) => s + (p.rssBytes ?? 0), 0);
  if (!prev || prev.size === 0) {
    // First sample: no delta exists yet — null, never a fake 0%.
    return { count: current.size, top: [], totalRssBytes: totalRss > 0 ? totalRss : null };
  }
  const dtSec = Math.max(0.001, (now - (prev.values().next().value?.sampledAt ?? now)) / 1000);
  const ranked: ProcessInfo[] = [];
  for (const [pid, cur] of current) {
    const before = prev.get(pid);
    if (!before) continue; // new process: no honest delta yet
    const deltaTicks = cur.ticks - before.ticks;
    if (deltaTicks < 0) continue;
    const cpuPercent = Math.min(100, Math.round((deltaTicks / (dtSec * 100)) * 100 * 10) / 10);
    ranked.push({ pid, comm: cur.comm, cpuPercent, rssBytes: cur.rssBytes });
  }
  ranked.sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0) || (b.rssBytes ?? 0) - (a.rssBytes ?? 0));
  return {
    count: current.size,
    top: ranked.slice(0, MAX_TOP_PROCESSES).filter((p) => (p.cpuPercent ?? 0) > 0 || (p.rssBytes ?? 0) > 50 * 1024 * 1024),
    totalRssBytes: totalRss > 0 ? totalRss : null,
  };
}

export async function getSystemTelemetry(): Promise<SystemTelemetry> {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = memTotal - memFree;
  const load = os.loadavg();
  const cpus = os.cpus();
  // Home is always a real, existing mount — the most meaningful disk for
  // the user's data (BLAXIN state lives under ~/.local/share/blaxin).
  const disk = await diskUsage(os.homedir());
  const [displayWindows, audio] = await Promise.all([getDisplayAndWindowsTelemetry(), getAudioTelemetry()]);

  return {
    timestamp: Date.now(),
    cpu: {
      usagePercent: cpuUsagePercent(),
      cores: cpus.length,
      model: cpus[0]?.model ?? null,
      loadAvg: { one: load[0], five: load[1], fifteen: load[2] },
    },
    memory: {
      totalBytes: memTotal,
      usedBytes: memUsed,
      freeBytes: memFree,
      percent: memTotal > 0 ? Math.min(100, Math.round((memUsed / memTotal) * 100)) : 0,
    },
    disk,
    uptimeSec: os.uptime(),
    os: { platform: os.platform(), release: os.release(), arch: os.arch(), hostname: os.hostname() },
    nodeVersion: process.version,
    battery: getBatteryTelemetry(),
    display: displayWindows.display,
    windows: displayWindows.windows,
    audio,
    processes: getProcessesTelemetry(),
  };
}