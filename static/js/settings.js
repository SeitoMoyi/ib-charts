// App-wide appearance settings (shared by every chart) and time-zone helpers.

import * as api from './api.js';

export const settings = {
  theme: 'dark',
  tz: 'local', // 'local' | 'exchange' | 'UTC' | IANA name
  sessionShading: true,
  sessionBreaks: false,
  countdown: true,
  prevClose: true,
  dayHighLow: false,
};

const listeners = new Set();
const save = api.debouncedSaver('settings', 'app', 300);

export async function loadSettings() {
  Object.assign(settings, await api.load('settings', 'app', {}));
  applyThemeCss();
}

export function setSetting(key, value) {
  settings[key] = value;
  if (key === 'theme') applyThemeCss();
  save(settings);
  listeners.forEach((cb) => cb(key, value));
}

export function onSettings(cb) { listeners.add(cb); }

function applyThemeCss() { document.documentElement.dataset.theme = settings.theme; }

export const THEMES = {
  dark: { bg: '#131722', text: '#d1d4dc', grid: '#1e222d', border: '#2a2e39', shade: 'rgba(120,123,134,0.10)', break: 'rgba(120,123,134,0.35)' },
  light: { bg: '#ffffff', text: '#131722', grid: '#f0f3fa', border: '#e0e3eb', shade: 'rgba(120,123,134,0.10)', break: 'rgba(120,123,134,0.4)' },
};

export const TIME_ZONES = [
  ['local', 'Local time'], ['exchange', 'Exchange time'], ['UTC', 'UTC'],
  ['America/New_York', 'New York'], ['America/Chicago', 'Chicago'], ['America/Los_Angeles', 'Los Angeles'],
  ['Europe/London', 'London'], ['Europe/Frankfurt', 'Frankfurt'], ['Asia/Tokyo', 'Tokyo'], ['Asia/Hong_Kong', 'Hong Kong'],
  ['Asia/Shanghai', 'Shanghai'], ['Asia/Singapore', 'Singapore'], ['Australia/Sydney', 'Sydney'],
];

// ---------- time zones ----------

const formatters = new Map();
const offsetCache = new Map();

/** Seconds to add to a UTC timestamp to get wall-clock time in `tz` (IANA name or 'local'). */
export function tzOffset(tz, t) {
  if (!tz || tz === 'local') return -new Date(t * 1000).getTimezoneOffset() * 60;
  if (tz === 'UTC') return 0;
  const key = `${tz}|${Math.floor(t / 1800)}`;
  const hit = offsetCache.get(key);
  if (hit !== undefined) return hit;
  let f = formatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      f = null; // unknown zone: fall back to local
    }
    formatters.set(tz, f);
  }
  if (!f) return tzOffset('local', t);
  const p = Object.fromEntries(f.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000;
  const off = wall - t;
  if (offsetCache.size > 20000) offsetCache.clear();
  offsetCache.set(key, off);
  return off;
}

/** UTC timestamp for a wall-clock time (seconds since epoch as if UTC) in `tz`. */
export function wallToUtc(tz, wall) {
  let utc = wall - tzOffset(tz, wall);
  utc = wall - tzOffset(tz, utc); // second pass settles DST edges
  return utc;
}

export function tzLabel(tz, exchangeTz) {
  if (tz === 'exchange') return exchangeTz ? `Exchange (${exchangeTz})` : 'Exchange';
  return TIME_ZONES.find(([id]) => id === tz)?.[1] ?? tz;
}

/**
 * Parses IB trading/liquid hours ("20261126:0930-20261126:1600;20261127:CLOSED" or the
 * older "20261126:0930-1600,1700-1800") into UTC [start, end] second ranges.
 */
export function parseSessions(spec, tz) {
  const out = [];
  const list = Array.isArray(spec) ? spec : String(spec || '').split(';');
  for (const day of list.flatMap((s) => s.split(';')).map((s) => s.trim()).filter(Boolean)) {
    if (day.endsWith('CLOSED')) continue;
    const dayPrefix = day.slice(0, 8);
    const rest = day.slice(9);
    for (const range of rest.split(',')) {
      const [a, b] = range.split('-');
      if (!a || !b) continue;
      const s = toWall(a, dayPrefix), e = toWall(b, dayPrefix);
      if (s == null || e == null) continue;
      out.push([wallToUtc(tz, s), wallToUtc(tz, e)]);
    }
  }
  return out.sort((x, y) => x[0] - y[0]);
}

function toWall(part, dayPrefix) {
  const [d, hm] = part.includes(':') ? part.split(':') : [dayPrefix, part];
  if (!/^\d{8}$/.test(d) || !/^\d{4}$/.test(hm)) return null;
  return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +hm.slice(0, 2), +hm.slice(2, 4)) / 1000;
}
