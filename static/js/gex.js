// Gamma exposure (GEX): option-chain data from IB → per-strike dealer gamma, total GEX,
// call/put walls and the zero-gamma ("flip") level. Shown as a sidebar panel and,
// optionally, as an overlay on charts of the same symbol.
//
// Convention (the usual one for public GEX charts): dealers are long calls and short puts,
// so call gamma counts positive and put gamma negative. GEX per strike is
//   gamma × open interest × multiplier × spot² × 1%   (dollars per 1% move).

import { settings, wallToUtc } from './settings.js';
import { $, el, fill } from './util.js';

const RATE = 0.04; // risk-free rate for re-pricing gamma at other spot prices

// ---------- maths ----------

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Black–Scholes gamma. */
export function bsGamma(S, K, T, iv) {
  if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return 0;
  const v = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (RATE + 0.5 * iv * iv) * T) / v;
  return Math.exp(-0.5 * d1 * d1) / SQRT_2PI / (S * v);
}

/** Years until 4 pm New York time on an expiry date (YYYYMMDD), at least one hour. */
function yearsTo(expiry, now = Date.now() / 1000) {
  const close = wallToUtc('America/New_York', Date.UTC(+expiry.slice(0, 4), +expiry.slice(4, 6) - 1, +expiry.slice(6, 8), 16) / 1000);
  return Math.max(close - now, 3600) / (365 * 86400);
}

/**
 * @param {object} data   server result { spot, multiplier, rows: [{ expiry, strike, call, gamma, iv, openInterest }] }
 * @param {Set<string>} expiries  expirations to include
 */
export function computeGex(data, expiries, weight = 'oi') {
  const { spot, multiplier: mult } = data;
  // Contracts per option: open interest, or today's volume when IB sends no open interest.
  const w = (r) => (weight === 'volume' ? r.volume : r.openInterest) || 0;
  const rows = data.rows
    .filter((r) => expiries.has(r.expiry) && w(r) > 0 && (r.gamma != null || r.iv != null))
    .map((r) => ({ ...r, openInterest: w(r) }));
  const T = new Map([...expiries].map((e) => [e, yearsTo(e)]));
  const unit = mult * spot * spot * 0.01;
  const byStrike = new Map();
  for (const r of rows) {
    const g = r.gamma ?? bsGamma(spot, r.strike, T.get(r.expiry), r.iv);
    const v = g * r.openInterest * unit * (r.call ? 1 : -1);
    const s = byStrike.get(r.strike) || { strike: r.strike, call: 0, put: 0, callOi: 0, putOi: 0 };
    if (r.call) { s.call += v; s.callOi += r.openInterest; } else { s.put += v; s.putOi += r.openInterest; }
    byStrike.set(r.strike, s);
  }
  const strikes = [...byStrike.values()].map((s) => ({ ...s, net: s.call + s.put })).sort((a, b) => a.strike - b.strike);
  const total = strikes.reduce((x, s) => x + s.net, 0);
  const callWall = strikes.reduce((best, s) => (!best || s.call > best.call ? s : best), null)?.strike;
  const putWall = strikes.reduce((best, s) => (!best || s.put < best.put ? s : best), null)?.strike;

  // Total GEX as a function of a hypothetical spot price, using each option's IV.
  const curve = [];
  const withIv = rows.filter((r) => r.iv > 0);
  for (let i = 0; i <= 120; i++) {
    const S = spot * (0.85 + (0.3 * i) / 120);
    let t = 0;
    for (const r of withIv) t += bsGamma(S, r.strike, T.get(r.expiry), r.iv) * r.openInterest * mult * S * S * 0.01 * (r.call ? 1 : -1);
    curve.push({ price: S, total: t });
  }
  // Zero-gamma level: the sign change nearest to spot.
  let flip = null;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    if (Math.sign(a.total) !== Math.sign(b.total)) {
      const x = a.price + ((b.price - a.price) * -a.total) / (b.total - a.total);
      if (flip == null || Math.abs(x - spot) < Math.abs(flip - spot)) flip = x;
    }
  }
  return { spot, strikes, total, callWall, putWall, flip, curve, options: rows.length };
}

export function fmtMoney(v) {
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`;
  return `${s}$${a.toFixed(0)}`;
}

// ---------- chart overlay ----------

/** Draws GEX bars at their strikes on the right of a chart, plus wall / flip lines. */
class GexLayer {
  constructor() {
    this.gex = null;
    this.view = { zOrder: () => 'bottom', renderer: () => ({ draw: (t) => t.useMediaCoordinateSpace(({ context, mediaSize }) => this.draw(context, mediaSize)) }) };
  }
  attached({ series, requestUpdate }) { this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.series = null; }
  updateAllViews() {}
  paneViews() { return [this.view]; }
  set(gex) { this.gex = gex; this.requestUpdate?.(); }

  levels() {
    const g = this.gex;
    if (!g) return [];
    return [
      g.callWall != null && { price: g.callWall, label: 'Call wall', color: '#26a69a' },
      g.putWall != null && { price: g.putWall, label: 'Put wall', color: '#ef5350' },
      g.flip != null && { price: g.flip, label: 'Zero γ', color: '#ff9800' },
    ].filter(Boolean);
  }

  priceAxisViews() {
    return this.levels().map((l) => ({
      coordinate: () => this.series?.priceToCoordinate(l.price) ?? -100,
      text: () => `${l.label} ${l.price.toFixed(2)}`, textColor: () => '#fff', backColor: () => l.color, visible: () => true,
    }));
  }

  draw(ctx, size) {
    const g = this.gex;
    if (!g || !this.series) return;
    const max = Math.max(...g.strikes.map((s) => Math.abs(s.net)), 1);
    const width = Math.min(180, size.width * 0.18);
    // Bar thickness from the strike spacing.
    const ys = g.strikes.map((s) => this.series.priceToCoordinate(s.strike)).filter((y) => y != null);
    const gap = ys.length > 1 ? Math.abs(ys[1] - ys[0]) : 6;
    const h = Math.max(1, Math.min(14, gap * 0.8));
    for (const s of g.strikes) {
      const y = this.series.priceToCoordinate(s.strike);
      if (y == null || y < -h || y > size.height + h) continue;
      const w = (Math.abs(s.net) / max) * width;
      ctx.fillStyle = s.net >= 0 ? 'rgba(38,166,154,.3)' : 'rgba(239,83,80,.3)';
      ctx.fillRect(size.width - w, y - h / 2, w, h);
    }
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1;
    for (const l of this.levels()) {
      const y = this.series.priceToCoordinate(l.price);
      if (y == null) continue;
      ctx.strokeStyle = l.color;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(size.width, Math.round(y) + 0.5);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

// ---------- panel ----------

/**
 * @param {() => import('./chart-pane.js').ChartPane} getActive
 * @param {() => import('./chart-pane.js').ChartPane[]} getPanes
 */
export function initGex(getActive, getPanes) {
  const st = {
    symbol: '', follow: true, maxExpiries: 4, maxDays: 45, range: 0.12, maxStrikes: 50, view: 'net', overlay: true, weight: 'auto',
    job: null, status: null, data: null, gex: null, include: new Set(), timer: null,
  };
  const layers = new Map(); // pane -> GexLayer
  const box = $('gex');

  async function run(refresh = false) {
    const symbol = (st.symbol || getActive()?.state.symbol || '').toUpperCase();
    if (!symbol) return;
    st.symbol = symbol;
    st.runningFor = symbol;
    st.status = { state: 'running', message: 'Starting…', done: 0, total: 0 };
    st.startedAt = Date.now();
    render();
    try {
      const r = await fetch('/api/gex', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, maxExpiries: st.maxExpiries, maxDays: st.maxDays, range: st.range, maxStrikes: st.maxStrikes, refresh }),
      });
      if (!r.ok) throw new Error(await r.text());
      st.job = (await r.json()).id;
      poll();
    } catch (e) {
      st.status = { state: 'error', message: e.message };
      render();
    }
  }

  async function poll() {
    clearTimeout(st.timer);
    const job = st.job;
    const r = await fetch(`/api/gex/${encodeURIComponent(job)}`).catch(() => null);
    if (job !== st.job) return;
    if (!r?.ok) { st.status = { state: 'error', message: 'lost the GEX job' }; render(); return; }
    st.status = await r.json();
    if (st.status.state === 'done') {
      st.data = st.status.result;
      st.include = new Set(st.data.expiries);
      recompute();
    } else if (st.status.state === 'running') {
      st.timer = setTimeout(poll, 1000);
    }
    render();
  }

  /** Open interest unless IB sent none (then today's volume), or what the user picked. */
  function weightUsed() {
    if (st.weight !== 'auto') return st.weight;
    return st.data?.rows.some((r) => r.openInterest > 0) ? 'oi' : 'volume';
  }

  function recompute() {
    st.gex = st.data ? computeGex(st.data, st.include, weightUsed()) : null;
    applyOverlay();
  }

  function applyOverlay() {
    for (const pane of getPanes()) {
      const want = st.overlay && st.gex && st.data && pane.state.symbol.toUpperCase() === (st.data.input || st.data.symbol).toUpperCase();
      let layer = layers.get(pane);
      if (want) {
        if (!layer) { layer = new GexLayer(); layers.set(pane, layer); }
        pane.attachExtra(layer);
        layer.set(st.gex);
      } else if (layer) {
        pane.detachExtra(layer);
      }
    }
  }

  function render() {
    if (box.hidden) return;
    const s = st.status, g = st.gex, d = st.data;
    const sel = (opts, value, onchange) => el('select', { onchange }, ...opts.map(([v, l]) => el('option', { value: v, selected: String(v) === String(value) }, l)));
    const symInput = el('input', { class: 'gex-sym', value: st.symbol || getActive()?.state.symbol || '', spellcheck: 'false', title: 'Stock, ETF or index (e.g. SPY, AAPL, ^SPX)' });
    symInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { st.symbol = symInput.value.trim().toUpperCase(); st.follow = false; run(); } });

    const stats = g && d ? el('div', { class: 'gex-stats' },
      stat('Spot', d.spot.toFixed(2)),
      stat('Net GEX', fmtMoney(g.total), g.total >= 0 ? 'up' : 'down', 'Dealer gamma per 1% move. Positive: dealers dampen moves; negative: they amplify them.'),
      stat('Zero γ', g.flip != null ? g.flip.toFixed(2) : '–', '', 'Price where total GEX changes sign'),
      stat('Call wall', g.callWall?.toFixed(2) ?? '–', 'up', 'Strike with the most call gamma'),
      stat('Put wall', g.putWall?.toFixed(2) ?? '–', 'down', 'Strike with the most put gamma'),
      stat('Regime', g.total >= 0 ? 'Positive γ' : 'Negative γ', g.total >= 0 ? 'up' : 'down')) : null;

    const canvas = el('canvas', { class: 'gex-canvas' });
    const curve = el('canvas', { class: 'gex-curve' });
    const tip = el('div', { class: 'gex-tip', hidden: true });

    fill(box,
      el('div', { class: 'wl-head' }, el('span', { class: 'wl-title' }, 'Gamma exposure'),
        el('button', { class: 'small', title: 'Fetch fresh option data', onclick: () => run(true) }, '↻ Refresh')),
      el('div', { class: 'gex-ctl' },
        symInput,
        sel([[1, '1 expiry'], [2, '2 expiries'], [4, '4 expiries'], [8, '8 expiries']], st.maxExpiries, (e) => { st.maxExpiries = +e.target.value; run(); }),
        sel([[7, '≤ 7 days'], [14, '≤ 14 days'], [45, '≤ 45 days'], [90, '≤ 90 days']], st.maxDays, (e) => { st.maxDays = +e.target.value; run(); }),
        sel([[0.05, '±5%'], [0.08, '±8%'], [0.12, '±12%'], [0.2, '±20%']], st.range, (e) => { st.range = +e.target.value; run(); }),
        sel([[30, '30 strikes'], [50, '50 strikes'], [100, '100 strikes']], st.maxStrikes, (e) => { st.maxStrikes = +e.target.value; run(); }),
        el('label', { class: 'muted check' }, el('input', { type: 'checkbox', checked: st.follow, onchange: (e) => { st.follow = e.target.checked; if (st.follow) { st.symbol = ''; run(); } } }), 'Follow chart'),
        el('label', { class: 'muted check' }, el('input', { type: 'checkbox', checked: st.overlay, onchange: (e) => { st.overlay = e.target.checked; applyOverlay(); } }), 'Show on chart')),
      s?.state === 'running' ? el('div', { class: 'gex-progress' },
        el('div', { class: 'muted' }, progressText(s, st.startedAt)),
        el('div', { class: 'bar' }, el('i', { style: `width:${s.total ? (100 * s.done) / s.total : 5}%` }))) : null,
      s?.state === 'error' ? el('div', { class: 'obj-empty err' }, s.message) : null,
      stats,
      d ? el('div', { class: 'gex-exp' }, ...d.expiries.map((e) => el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: st.include.has(e), onchange: (ev) => { ev.target.checked ? st.include.add(e) : st.include.delete(e); recompute(); render(); } }),
        `${e.slice(4, 6)}/${e.slice(6, 8)}`))) : null,
      d ? el('div', { class: 'gex-view' }, el('span', { class: 'muted' }, 'Weight'),
        ...[['oi', 'Open interest'], ['volume', "Today's volume"]].map(([v, l]) =>
          el('button', { class: weightUsed() === v ? 'on' : '', onclick: () => { st.weight = v; recompute(); render(); } }, l))) : null,
      d && st.weight === 'auto' && weightUsed() === 'volume' ? el('div', { class: 'gex-delayed' },
        'IB sent no open interest for these options (it needs a real-time options data subscription for some products, e.g. SPX), so GEX is weighted by today\'s volume instead.') : null,
      g ? el('div', { class: 'gex-view' }, ...[['net', 'Net'], ['split', 'Calls / puts']].map(([v, l]) =>
        el('button', { class: st.view === v ? 'on' : '', onclick: () => { st.view = v; render(); } }, l))) : null,
      g ? el('div', { class: 'gex-chartbox' }, canvas, tip) : null,
      g ? el('div', { class: 'muted pad' }, 'Total GEX vs. price') : null,
      g ? curve : null,
      d && /delayed/i.test(d.dataType) ? el('div', { class: 'gex-delayed' }, el('span', { class: 'data-badge delayed' }, 'D'),
        ' Option data is delayed (no real-time options subscription) — levels reflect prices ~15 min ago.') : null,
      d && /frozen/i.test(d.dataType) && !/delayed/i.test(d.dataType) ? el('div', { class: 'gex-delayed' }, el('span', { class: 'data-badge frozen' }, 'Closed'), ' Market closed — last values.') : null,
      d ? el('div', { class: 'muted pad small' },
        `${d.symbol} · ${g?.options ?? 0} options with data (of ${d.requested}) · weighted by ${weightUsed() === 'oi' ? 'open interest' : "today's volume"} · ${d.dataType || 'data'} · ${new Date(d.fetchedAt * 1000).toLocaleTimeString()}. `,
        'Assumes dealers are long calls and short puts.') : null,
      !d && !s ? el('div', { class: 'obj-empty' }, 'Needs IB US options data (OPRA). Fetching takes ~20–60 s.', el('br'), el('button', { class: 'small', onclick: () => run() }, 'Calculate GEX')) : null);

    if (g) requestAnimationFrame(() => { drawProfile(canvas, tip, g, st.view); drawCurve(curve, g); });
  }

  return {
    onTab() {
      if (st.follow) st.symbol = getActive()?.state.symbol || st.symbol;
      if (!st.data || (st.data.input || st.data.symbol) !== st.symbol || st.runningFor !== st.symbol) {
        if (st.runningFor !== st.symbol) run(); else render();
      } else render();
    },
    /** Active chart changed symbol. */
    onSymbol() {
      if (box.hidden || !st.follow) { applyOverlay(); return; }
      const sym = getActive()?.state.symbol;
      if (sym && sym !== st.symbol) { st.symbol = sym; run(); }
      applyOverlay();
    },
    applyOverlay,
    render,
  };
}

function progressText(s, startedAt) {
  const secs = Math.round((Date.now() - (startedAt || Date.now())) / 1000);
  if (!s.total) return `${s.message} ${secs ? `(${secs}s)` : ''}`;
  const left = s.done > 10 ? Math.round((secs / s.done) * (s.total - s.done)) : null;
  return `Fetching options ${s.done}/${s.total} · ${secs}s${left != null ? ` · about ${left}s left` : ''}`;
}

function stat(label, value, cls = '', title = '') {
  return el('div', { class: 'gex-stat', title }, el('div', { class: 'muted' }, label), el('div', { class: cls }, value));
}

/** Horizontal bars per strike (strikes top-to-bottom, high to low). */
function drawProfile(canvas, tip, g, view) {
  const dpr = window.devicePixelRatio || 1;
  const rows = g.strikes.slice().reverse();
  const W = canvas.clientWidth, rowH = Math.max(6, Math.min(16, 520 / rows.length)), H = rows.length * rowH + 16;
  canvas.style.height = `${H}px`;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const dark = settings.theme !== 'light';
  const labelW = 54, mid = labelW + (W - labelW) / 2, half = (W - labelW) / 2 - 4;
  const max = Math.max(...rows.map((s) => (view === 'net' ? Math.abs(s.net) : Math.max(s.call, -s.put))), 1);
  ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textBaseline = 'middle';
  const yOf = (price) => {
    // Rows are evenly spaced, so interpolate between neighbouring strikes.
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i].strike, b = rows[i + 1].strike;
      if (price <= a && price >= b) return 8 + (i + (a - price) / (a - b)) * rowH + rowH / 2;
    }
    return null;
  };
  const every = Math.ceil(13 / rowH); // keep labels at least ~13px apart
  rows.forEach((s, i) => {
    const y = 8 + i * rowH;
    if (i % every === 0) {
      ctx.fillStyle = dark ? '#787b86' : '#555';
      ctx.textAlign = 'right';
      ctx.fillText(s.strike.toFixed(s.strike % 1 ? 1 : 0), labelW - 6, y + rowH / 2);
    }
    const bh = Math.max(1, rowH - 2);
    if (view === 'net') {
      const w = (Math.abs(s.net) / max) * half;
      ctx.fillStyle = s.net >= 0 ? '#26a69a' : '#ef5350';
      ctx.fillRect(s.net >= 0 ? mid : mid - w, y + 1, w, bh);
    } else {
      ctx.fillStyle = '#26a69a';
      ctx.fillRect(mid, y + 1, (s.call / max) * half, bh);
      ctx.fillStyle = '#ef5350';
      const w = (-s.put / max) * half;
      ctx.fillRect(mid - w, y + 1, w, bh);
    }
  });
  ctx.strokeStyle = dark ? '#2a2e39' : '#e0e3eb';
  ctx.beginPath(); ctx.moveTo(mid + 0.5, 4); ctx.lineTo(mid + 0.5, H - 4); ctx.stroke();
  const hline = (price, color, label) => {
    const y = price != null && yOf(price);
    if (!y) return;
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(labelW, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.textAlign = 'right';
    ctx.fillText(label, W - 2, y - 6);
  };
  hline(g.spot, '#2962ff', `Spot ${g.spot.toFixed(2)}`);
  hline(g.flip, '#ff9800', 'Zero γ');

  canvas.onmousemove = (e) => {
    const i = Math.floor((e.offsetY - 8) / rowH);
    const s = rows[i];
    if (!s) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.style.top = `${e.offsetY + 12}px`;
    tip.replaceChildren(el('b', {}, `Strike ${s.strike}`),
      el('div', { class: 'up' }, `Calls ${fmtMoney(s.call)} · ${Math.round(s.callOi).toLocaleString()} contracts`),
      el('div', { class: 'down' }, `Puts ${fmtMoney(s.put)} · ${Math.round(s.putOi).toLocaleString()} contracts`),
      el('div', {}, `Net ${fmtMoney(s.net)}`));
  };
  canvas.onmouseleave = () => { tip.hidden = true; };
}

/** Total GEX as a function of price, with spot and the zero-gamma crossing. */
function drawCurve(canvas, g) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = 110;
  canvas.style.height = `${H}px`;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const c = g.curve;
  const lo = Math.min(...c.map((p) => p.total), 0), hi = Math.max(...c.map((p) => p.total), 0);
  const x = (price) => 6 + ((price - c[0].price) / (c.at(-1).price - c[0].price)) * (W - 12);
  const y = (v) => 6 + ((hi - v) / (hi - lo || 1)) * (H - 22);
  ctx.strokeStyle = settings.theme === 'light' ? '#e0e3eb' : '#2a2e39';
  ctx.beginPath(); ctx.moveTo(6, y(0)); ctx.lineTo(W - 6, y(0)); ctx.stroke();
  ctx.lineWidth = 1.5;
  for (let i = 1; i < c.length; i++) {
    ctx.strokeStyle = c[i].total >= 0 ? '#26a69a' : '#ef5350';
    ctx.beginPath(); ctx.moveTo(x(c[i - 1].price), y(c[i - 1].total)); ctx.lineTo(x(c[i].price), y(c[i].total)); ctx.stroke();
  }
  ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
  const vline = (price, color, label, top = false) => {
    if (price == null) return;
    ctx.strokeStyle = color;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x(price), 14); ctx.lineTo(x(price), H - 16); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(label, Math.min(W - 30, Math.max(30, x(price))), top ? 10 : H - 6);
  };
  vline(g.spot, '#2962ff', `Spot ${g.spot.toFixed(0)}`, true);
  vline(g.flip, '#ff9800', `Zero γ ${g.flip?.toFixed(0) ?? ''}`);
}
