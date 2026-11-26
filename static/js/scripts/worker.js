// Runs one indicator script in isolation (module Web Worker).
//
// The script gets a Pine-like API (indicator, input.*, plot, hline, plotshape, bgcolor,
// alertcondition, ta.*) plus the bar series. Network access is removed before any user
// code runs, so a shared script can't talk to the local IB Charts server.

import { bindBarTa, makeTa, toSeries } from './ta.js';

for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'BroadcastChannel', 'indexedDB', 'caches']) {
  try { Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false }); } catch { /* ignore */ }
}

// How many lines `new Function` adds before the script body (differs by engine).
const LINE_OFFSET = (() => {
  try { new Function('\nthrow new Error("probe")\n//# sourceURL=probe.js')(); } catch (e) {
    const m = String(e.stack).match(/probe\.js:(\d+)/);
    if (m) return Number(m[1]) - 2;
  }
  return 2;
})();

const compiled = new Map(); // code -> Function

self.onmessage = ({ data }) => {
  const { id, code, bars, inputs } = data;
  try {
    const result = run(code, bars, inputs || {});
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: describe(e) });
  }
};

function describe(e) {
  const stack = String(e?.stack || '');
  const m = stack.match(/script\.js:(\d+)(?::(\d+))?/);
  return {
    message: `${e?.name && e.name !== 'Error' ? e.name + ': ' : ''}${e?.message ?? e}`,
    line: m ? Math.max(1, Number(m[1]) - LINE_OFFSET - 1) : null, // -1 for the "use strict" line
  };
}

const API_NAMES = [
  'indicator', 'input', 'plot', 'hline', 'plotshape', 'bgcolor', 'alertcondition', 'ta',
  'open', 'high', 'low', 'close', 'volume', 'time', 'hl2', 'hlc3', 'ohlc4', 'n',
  'series', 'map', 'shift', 'add', 'sub', 'mul', 'div', 'na', 'nz', 'color',
];

function run(code, raw, inputValues) {
  const n = raw.close.length;
  const bars = { ...raw };
  bars.hl2 = new Float64Array(n);
  bars.hlc3 = new Float64Array(n);
  bars.ohlc4 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    bars.hl2[i] = (raw.high[i] + raw.low[i]) / 2;
    bars.hlc3[i] = (raw.high[i] + raw.low[i] + raw.close[i]) / 3;
    bars.ohlc4[i] = (raw.open[i] + raw.high[i] + raw.low[i] + raw.close[i]) / 4;
  }
  const ta = makeTa(n);
  bindBarTa(ta, bars, n);
  const S = (x) => toSeries(x, n);

  const out = { meta: { title: 'Script', overlay: false, precision: null }, inputs: [], plots: [], hlines: [], shapes: [], bgcolors: [], alerts: [] };

  const indicator = (title, opts = {}) => { out.meta = { ...out.meta, title: String(title), ...opts }; };

  const defineInput = (type, title, def, opts = {}) => {
    out.inputs.push({ type, title, default: def, ...opts });
    const v = Object.hasOwn(inputValues, title) ? inputValues[title] : def;
    return v;
  };
  const input = {
    int: (title, def, o) => Math.round(Number(defineInput('int', title, def, o))),
    float: (title, def, o) => Number(defineInput('float', title, def, o)),
    bool: (title, def, o) => Boolean(defineInput('bool', title, def, o)),
    string: (title, def, o) => String(defineInput('string', title, def, o)),
    color: (title, def, o) => String(defineInput('color', title, def, o)),
    /** Returns the chosen price series (open/high/low/close/hl2/hlc3/ohlc4). */
    source: (title, def = 'close', o) => bars[defineInput('source', title, def, { options: ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4'], ...o })] || bars.close,
  };

  const plot = (values, o = {}) => {
    const v = Float64Array.from(S(values), Number);
    const colors = Array.isArray(o.colors) ? o.colors.slice(0, n) : null;
    out.plots.push({ title: o.title || `Plot ${out.plots.length + 1}`, color: o.color || '#2962ff', width: o.width ?? 1.5, style: o.style || 'line', values: v, colors });
    return out.plots.length - 1;
  };
  const hline = (price, o = {}) => { out.hlines.push({ price: Number(price), title: o.title || '', color: o.color || '#787b86', dash: o.dash ?? 1 }); };
  const plotshape = (cond, o = {}) => {
    const c = S(cond);
    for (let i = 0; i < n; i++) {
      if (c[i] && !Number.isNaN(c[i])) {
        out.shapes.push({ index: i, shape: o.shape || 'circle', location: o.location || 'aboveBar', color: o.color || '#2962ff', text: o.text || '' });
      }
    }
  };
  const bgcolor = (cond, clr) => {
    for (let i = 0; i < n; i++) {
      const v = Array.isArray(cond) || ArrayBuffer.isView(cond) ? cond[i] : cond;
      const col = typeof v === 'string' ? v : v ? clr : null;
      if (col) out.bgcolors.push({ index: i, color: col });
    }
  };
  const alertcondition = (cond, o = {}) => {
    const c = S(cond);
    out.alerts.push({ title: o.title || `Alert ${out.alerts.length + 1}`, message: o.message || '', last: Boolean(c[n - 1]), prev: Boolean(c[n - 2]) });
  };

  // Series helpers.
  const series = (fn) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = fn(i); return a; };
  const map = (a, fn) => { a = S(a); const r = new Float64Array(n); for (let i = 0; i < n; i++) r[i] = fn(a[i], i); return r; };
  /** Value `k` bars ago (Pine's `src[k]`). */
  const shift = (a, k = 1) => { a = S(a); const r = new Float64Array(n).fill(Number.NaN); for (let i = k; i < n; i++) r[i] = a[i - k]; return r; };
  const op = (f) => (a, b) => { const A = S(a), B = S(b); const r = new Float64Array(n); for (let i = 0; i < n; i++) r[i] = f(A[i], B[i]); return r; };
  const add = op((x, y) => x + y), sub = op((x, y) => x - y), mul = op((x, y) => x * y), div = op((x, y) => x / y);
  const na = (x) => x == null || Number.isNaN(x);
  const nz = (x, v = 0) => (ArrayBuffer.isView(x) ? map(x, (y) => (Number.isNaN(y) ? v : y)) : na(x) ? v : x);
  const color = { rgba: (hex, a) => { const k = parseInt(hex.slice(1), 16); return `rgba(${(k >> 16) & 255},${(k >> 8) & 255},${k & 255},${a})`; } };

  let fn = compiled.get(code);
  if (!fn) {
    fn = new Function(...API_NAMES, `"use strict";\n${code}\n//# sourceURL=script.js`);
    compiled.clear();
    compiled.set(code, fn);
  }
  fn(indicator, input, plot, hline, plotshape, bgcolor, alertcondition, ta,
    bars.open, bars.high, bars.low, bars.close, bars.volume, bars.time, bars.hl2, bars.hlc3, bars.ohlc4, n,
    series, map, shift, add, sub, mul, div, na, nz, color);
  return out;
}
