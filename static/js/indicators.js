// Built-in indicators. (Step 5 replaces these with user-editable scripts.)

export function sma(bars, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: bars[i].time, value: sum / n });
  }
  return out;
}

export function ema(bars, n) {
  const out = [], k = 2 / (n + 1);
  let e;
  for (let i = 0; i < bars.length; i++) {
    e = e === undefined ? bars[i].close : bars[i].close * k + e * (1 - k);
    if (i >= n - 1) out.push({ time: bars[i].time, value: e });
  }
  return out;
}

export function rsi(bars, n) {
  const out = [];
  let gain = 0, loss = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) { gain += g / n; loss += l / n; } else { gain = (gain * (n - 1) + g) / n; loss = (loss * (n - 1) + l) / n; }
    if (i >= n) out.push({ time: bars[i].time, value: loss === 0 ? 100 : 100 - 100 / (1 + gain / loss) });
  }
  return out;
}

/** Session VWAP, reset each (chart-local) calendar day. */
export function vwap(bars) {
  const out = [];
  let day = null, pv = 0, vol = 0;
  for (const b of bars) {
    const d = Math.floor(b.time / 86400);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const v = b.volume || 0;
    pv += ((b.high + b.low + b.close) / 3) * v;
    vol += v;
    if (vol > 0) out.push({ time: b.time, value: pv / vol });
  }
  return out;
}

export const BUILTINS = {
  sma20: { label: 'SMA 20', color: '#f7c948', calc: (b) => sma(b, 20) },
  sma50: { label: 'SMA 50', color: '#2196f3', calc: (b) => sma(b, 50) },
  ema200: { label: 'EMA 200', color: '#e040fb', calc: (b) => ema(b, 200) },
  vwap: { label: 'VWAP', color: '#ff9800', calc: (b, ctx) => (ctx.intraday && ctx.hasVolume ? vwap(b) : []), fullHistory: true },
  rsi: { label: 'RSI', color: '#7e57c2', calc: (b) => rsi(b, 14), pane: 1, levels: [70, 30] },
};
