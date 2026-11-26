// Technical-analysis library for indicator scripts.
//
// Every function works on whole series (arrays, one value per bar) and returns a
// Float64Array of the same length. Values that can't be computed yet (warm-up) are NaN.
// Arguments that are plain numbers are treated as constant series.

const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);

export function toSeries(x, n) {
  if (x instanceof Float64Array || Array.isArray(x)) return x;
  const out = new Float64Array(n);
  out.fill(typeof x === 'number' ? x : Number.NaN);
  return out;
}

const make = (n) => new Float64Array(n).fill(Number.NaN);

export function makeTa(n) {
  const S = (x) => toSeries(x, n);

  const ta = {
    sma(src, len) {
      src = S(src);
      const out = make(n);
      let sum = 0, count = 0;
      for (let i = 0; i < n; i++) {
        const v = src[i];
        if (isNum(v)) { sum += v; count++; }
        if (i >= len) { const old = src[i - len]; if (isNum(old)) { sum -= old; count--; } }
        if (i >= len - 1 && count === len) out[i] = sum / len;
      }
      return out;
    },

    ema(src, len) {
      src = S(src);
      const out = make(n), k = 2 / (len + 1);
      let e = Number.NaN, seen = 0, sum = 0;
      for (let i = 0; i < n; i++) {
        const v = src[i];
        if (!isNum(v)) continue;
        if (seen < len) { sum += v; seen++; if (seen === len) { e = sum / len; out[i] = e; } continue; }
        e = v * k + e * (1 - k);
        out[i] = e;
      }
      return out;
    },

    /** Wilder's moving average (used by RSI and ATR). */
    rma(src, len) {
      src = S(src);
      const out = make(n);
      let r = Number.NaN, seen = 0, sum = 0;
      for (let i = 0; i < n; i++) {
        const v = src[i];
        if (!isNum(v)) continue;
        if (seen < len) { sum += v; seen++; if (seen === len) { r = sum / len; out[i] = r; } continue; }
        r = (r * (len - 1) + v) / len;
        out[i] = r;
      }
      return out;
    },

    wma(src, len) {
      src = S(src);
      const out = make(n), denom = (len * (len + 1)) / 2;
      for (let i = len - 1; i < n; i++) {
        let s = 0, ok = true;
        for (let j = 0; j < len; j++) { const v = src[i - j]; if (!isNum(v)) { ok = false; break; } s += v * (len - j); }
        if (ok) out[i] = s / denom;
      }
      return out;
    },

    /** Hull moving average. */
    hma(src, len) {
      const half = ta.wma(src, Math.max(1, Math.floor(len / 2)));
      const full = ta.wma(src, len);
      const diff = new Float64Array(n);
      for (let i = 0; i < n; i++) diff[i] = 2 * half[i] - full[i];
      return ta.wma(diff, Math.max(1, Math.round(Math.sqrt(len))));
    },

    vwma(src, len, vol) {
      src = S(src); vol = S(vol);
      const pv = new Float64Array(n);
      for (let i = 0; i < n; i++) pv[i] = src[i] * vol[i];
      const a = ta.sma(pv, len), b = ta.sma(vol, len);
      const out = make(n);
      for (let i = 0; i < n; i++) out[i] = a[i] / b[i];
      return out;
    },

    change(src, len = 1) {
      src = S(src);
      const out = make(n);
      for (let i = len; i < n; i++) out[i] = src[i] - src[i - len];
      return out;
    },

    mom(src, len = 10) { return ta.change(src, len); },

    roc(src, len = 9) {
      src = S(src);
      const out = make(n);
      for (let i = len; i < n; i++) out[i] = (100 * (src[i] - src[i - len])) / src[i - len];
      return out;
    },

    highest(src, len) {
      src = S(src);
      const out = make(n);
      for (let i = len - 1; i < n; i++) { let m = -Infinity; for (let j = i - len + 1; j <= i; j++) if (src[j] > m) m = src[j]; out[i] = m; }
      return out;
    },

    lowest(src, len) {
      src = S(src);
      const out = make(n);
      for (let i = len - 1; i < n; i++) { let m = Infinity; for (let j = i - len + 1; j <= i; j++) if (src[j] < m) m = src[j]; out[i] = m; }
      return out;
    },

    stdev(src, len) {
      src = S(src);
      const mean = ta.sma(src, len), out = make(n);
      for (let i = len - 1; i < n; i++) {
        if (!isNum(mean[i])) continue;
        let s = 0;
        for (let j = i - len + 1; j <= i; j++) s += (src[j] - mean[i]) ** 2;
        out[i] = Math.sqrt(s / len);
      }
      return out;
    },

    cum(src) {
      src = S(src);
      const out = new Float64Array(n);
      let s = 0;
      for (let i = 0; i < n; i++) { if (isNum(src[i])) s += src[i]; out[i] = s; }
      return out;
    },

    rsi(src, len = 14) {
      src = S(src);
      const up = make(n), down = make(n);
      for (let i = 1; i < n; i++) { const d = src[i] - src[i - 1]; up[i] = Math.max(d, 0); down[i] = Math.max(-d, 0); }
      const u = ta.rma(up, len), d = ta.rma(down, len), out = make(n);
      for (let i = 0; i < n; i++) if (isNum(u[i]) && isNum(d[i])) out[i] = d[i] === 0 ? 100 : 100 - 100 / (1 + u[i] / d[i]);
      return out;
    },

    macd(src, fast = 12, slow = 26, signal = 9) {
      const f = ta.ema(src, fast), s = ta.ema(src, slow);
      const macd = new Float64Array(n);
      for (let i = 0; i < n; i++) macd[i] = f[i] - s[i];
      const sig = ta.ema(macd, signal);
      const hist = new Float64Array(n);
      for (let i = 0; i < n; i++) hist[i] = macd[i] - sig[i];
      return { macd, signal: sig, hist };
    },

    bb(src, len = 20, mult = 2) {
      const basis = ta.sma(src, len), dev = ta.stdev(src, len);
      const upper = new Float64Array(n), lower = new Float64Array(n);
      for (let i = 0; i < n; i++) { upper[i] = basis[i] + mult * dev[i]; lower[i] = basis[i] - mult * dev[i]; }
      return { basis, upper, lower };
    },

    /** Needs the bar series; bound in the script context. */
    tr: null,
    atr: null,
    stoch: null,
    vwap: null,
    obv: null,
    cci: null,
    mfi: null,
    dmi: null,
    supertrend: null,

    crossover(a, b) {
      a = S(a); b = S(b);
      const out = new Uint8Array(n);
      for (let i = 1; i < n; i++) out[i] = a[i] > b[i] && a[i - 1] <= b[i - 1] ? 1 : 0;
      return out;
    },

    crossunder(a, b) {
      a = S(a); b = S(b);
      const out = new Uint8Array(n);
      for (let i = 1; i < n; i++) out[i] = a[i] < b[i] && a[i - 1] >= b[i - 1] ? 1 : 0;
      return out;
    },

    cross(a, b) {
      const o = ta.crossover(a, b), u = ta.crossunder(a, b);
      return o.map((v, i) => v || u[i]);
    },
  };
  return ta;
}

/** Bar-based indicators need OHLCV; bind them once the series exist. */
export function bindBarTa(ta, bars, n) {
  const { open, high, low, close, volume, time } = bars;

  ta.tr = () => {
    const out = make(n);
    for (let i = 0; i < n; i++) {
      const pc = i > 0 ? close[i - 1] : Number.NaN;
      out[i] = isNum(pc) ? Math.max(high[i] - low[i], Math.abs(high[i] - pc), Math.abs(low[i] - pc)) : high[i] - low[i];
    }
    return out;
  };

  ta.atr = (len = 14) => ta.rma(ta.tr(), len);

  ta.stoch = (kLen = 14, kSmooth = 1, dLen = 3) => {
    const hh = ta.highest(high, kLen), ll = ta.lowest(low, kLen), raw = make(n);
    for (let i = 0; i < n; i++) raw[i] = (100 * (close[i] - ll[i])) / (hh[i] - ll[i]);
    const k = kSmooth > 1 ? ta.sma(raw, kSmooth) : raw;
    return { k, d: ta.sma(k, dLen) };
  };

  /** Session VWAP, reset at each (chart-local) calendar day. */
  ta.vwap = (src) => {
    src = src ? toSeries(src, n) : bars.hlc3;
    const out = make(n);
    let day = null, pv = 0, vol = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.floor(time[i] / 86400);
      if (d !== day) { day = d; pv = 0; vol = 0; }
      const v = volume[i] || 0;
      pv += src[i] * v;
      vol += v;
      if (vol > 0) out[i] = pv / vol;
    }
    return out;
  };

  ta.obv = () => {
    const out = new Float64Array(n);
    for (let i = 1; i < n; i++) out[i] = out[i - 1] + (close[i] > close[i - 1] ? volume[i] : close[i] < close[i - 1] ? -volume[i] : 0);
    return out;
  };

  ta.cci = (len = 20) => {
    const tp = bars.hlc3, ma = ta.sma(tp, len), out = make(n);
    for (let i = len - 1; i < n; i++) {
      let md = 0;
      for (let j = i - len + 1; j <= i; j++) md += Math.abs(tp[j] - ma[i]);
      md /= len;
      out[i] = (tp[i] - ma[i]) / (0.015 * md);
    }
    return out;
  };

  ta.mfi = (len = 14) => {
    const tp = bars.hlc3, out = make(n);
    for (let i = len; i < n; i++) {
      let pos = 0, neg = 0;
      for (let j = i - len + 1; j <= i; j++) {
        const flow = tp[j] * volume[j];
        if (tp[j] > tp[j - 1]) pos += flow; else if (tp[j] < tp[j - 1]) neg += flow;
      }
      out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    }
    return out;
  };

  /** Directional movement: returns { plus, minus, adx }. */
  ta.dmi = (len = 14, adxLen = 14) => {
    const plusDM = make(n), minusDM = make(n);
    for (let i = 1; i < n; i++) {
      const up = high[i] - high[i - 1], down = low[i - 1] - low[i];
      plusDM[i] = up > down && up > 0 ? up : 0;
      minusDM[i] = down > up && down > 0 ? down : 0;
    }
    const atr = ta.atr(len), p = ta.rma(plusDM, len), m = ta.rma(minusDM, len);
    const plus = make(n), minus = make(n), dx = make(n);
    for (let i = 0; i < n; i++) {
      plus[i] = (100 * p[i]) / atr[i];
      minus[i] = (100 * m[i]) / atr[i];
      dx[i] = (100 * Math.abs(plus[i] - minus[i])) / (plus[i] + minus[i]);
    }
    return { plus, minus, adx: ta.rma(dx, adxLen) };
  };

  /** SuperTrend: returns { line, direction } (direction 1 = up-trend, -1 = down-trend). */
  ta.supertrend = (factor = 3, atrLen = 10) => {
    const atr = ta.atr(atrLen), line = make(n), direction = make(n);
    let upper = Number.NaN, lower = Number.NaN, dir = 1;
    for (let i = 0; i < n; i++) {
      if (!isNum(atr[i])) continue;
      const mid = (high[i] + low[i]) / 2;
      const bu = mid + factor * atr[i], bl = mid - factor * atr[i];
      const pc = close[i - 1];
      upper = !isNum(upper) || bu < upper || pc > upper ? bu : upper;
      lower = !isNum(lower) || bl > lower || pc < lower ? bl : lower;
      if (dir === 1 && close[i] < lower) dir = -1;
      else if (dir === -1 && close[i] > upper) dir = 1;
      direction[i] = dir;
      line[i] = dir === 1 ? lower : upper;
    }
    return { line, direction };
  };
}
