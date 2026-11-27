// IB account & research panels (all read-only): positions with live P&L, fills and
// earnings markers on the chart, market scanner, news headlines and symbol info.

import { settings, wallToUtc } from './settings.js';
import { $, el, fill } from './util.js';

const SCANS = [
  ['TOP_PERC_GAIN', 'Top % gainers'], ['TOP_PERC_LOSE', 'Top % losers'], ['MOST_ACTIVE', 'Most active'],
  ['HOT_BY_VOLUME', 'Unusual volume'], ['TOP_TRADE_COUNT', 'Most trades'], ['HIGH_VS_13W_HL', 'Near 13-week high'],
  ['LOW_VS_13W_HL', 'Near 13-week low'], ['HIGH_OPT_IMP_VOLAT', 'Highest option IV'], ['HALTED', 'Halted'],
];
const LOCATIONS = [['STK.US.MAJOR', 'US major exchanges'], ['STK.US', 'All US'], ['STK.NASDAQ', 'NASDAQ'], ['STK.NYSE', 'NYSE']];

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

/**
 * @param {import('./feed.js').Feed} feed
 * @param {() => import('./chart-pane.js').ChartPane} getActive
 * @param {() => import('./chart-pane.js').ChartPane[]} getPanes
 */
export function initIbPanels(feed, getActive, getPanes) {
  const quotes = new Map();
  const state = { positions: [], fills: [], scan: [], scanCode: 'TOP_PERC_GAIN', location: 'STK.US.MAJOR', minPrice: 5 };
  const visible = (id) => !$(id).hidden && !$('sidebar').hidden;
  const pick = (sym) => getActive()?.setSymbol(sym);

  feed.onGlobal((m) => {
    if (m.type !== 'quote') return;
    quotes.set(m.quote.symbol, m.quote);
    if (visible('positions')) renderPositions();
    if (visible('scanner')) renderScanner();
  });

  // ---------- positions & fills ----------

  async function loadPositions() {
    try {
      [state.positions, state.fills] = await Promise.all([getJson('/api/positions'), getJson('/api/executions')]);
      state.posError = null;
    } catch (e) {
      state.posError = e.message;
    }
    feed.setQuotes(state.positions.map((p) => p.symbol), 'positions');
    renderPositions();
    getPanes().forEach(applyTrades);
  }

  function renderPositions() {
    const box = $('positions');
    const rows = state.positions.map((p) => {
      const q = quotes.get(p.symbol);
      const mult = Number(p.multiplier) || 1;
      const cost = p.avgCost / mult; // IB reports average cost per contract incl. multiplier
      const pnl = q?.price != null ? (q.price - cost) * p.position * mult : null;
      const pct = q?.price != null ? ((q.price - cost) / cost) * 100 * Math.sign(p.position) : null;
      const cls = pnl == null ? '' : pnl >= 0 ? 'up' : 'down';
      return el('div', { class: 'pos-row', onclick: () => pick(p.symbol), title: `${p.account} · ${p.secType}` },
        el('b', {}, p.localSymbol || p.symbol),
        el('span', {}, `${p.position > 0 ? '+' : ''}${p.position}`),
        el('span', {}, cost.toFixed(2)),
        el('span', {}, q?.price != null ? q.price.toFixed(2) : '…'),
        el('span', { class: cls }, pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}` : ''),
        el('span', { class: cls }, pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : ''));
    });
    const total = state.positions.reduce((s, p) => {
      const q = quotes.get(p.symbol), mult = Number(p.multiplier) || 1;
      return q?.price != null ? s + (q.price - p.avgCost / mult) * p.position * mult : s;
    }, 0);
    fill(box, 
      el('div', { class: 'wl-head' }, el('span', { class: 'wl-title' }, 'Positions'), el('button', { class: 'small', onclick: loadPositions }, '↻ Refresh')),
      state.posError ? el('div', { class: 'obj-empty err' }, state.posError) : null,
      el('div', { class: 'pos-row head' }, ...['Symbol', 'Qty', 'Avg', 'Last', 'P&L', '%'].map((h) => el('span', {}, h))),
      ...(rows.length ? rows : [el('div', { class: 'obj-empty' }, 'No open positions')]),
      rows.length ? el('div', { class: 'pos-total' }, 'Unrealized P&L ', el('b', { class: total >= 0 ? 'up' : 'down' }, `${total >= 0 ? '+' : ''}${total.toFixed(2)}`)) : null,
      el('div', { class: 'wl-head' }, el('span', { class: 'muted' }, "Today's fills")),
      ...state.fills.slice().reverse().map((f) => el('div', { class: 'al-log', onclick: () => pick(f.symbol) },
        el('span', { class: f.side === 'buy' ? 'up' : 'down' }, f.side === 'buy' ? 'BOT ' : 'SLD '),
        `${f.shares} ${f.symbol} @ ${f.price}`, el('div', { class: 'muted' }, new Date(fillTime(f.time) * 1000).toLocaleString()))),
      el('div', { class: 'muted pad' }, 'Read-only: IB Charts never places orders.'));
  }

  /** Average-cost line and fill markers on a chart showing a held symbol. */
  function applyTrades(pane) {
    const sym = pane.state.symbol;
    const pos = state.positions.find((p) => p.symbol === sym || p.localSymbol === sym);
    pane.setPositionLine(pos ? { price: pos.avgCost / (Number(pos.multiplier) || 1), qty: pos.position } : null);
    const marks = [];
    for (const f of state.fills.filter((x) => x.symbol === sym)) {
      const bar = pane.barAtOrBefore(pane.toChartTime(fillTime(f.time)));
      if (bar) marks.push({ time: bar.time, position: f.side === 'buy' ? 'belowBar' : 'aboveBar', shape: f.side === 'buy' ? 'arrowUp' : 'arrowDown', color: f.side === 'buy' ? '#2962ff' : '#ff6d00', text: `${f.side === 'buy' ? 'B' : 'S'} ${f.shares}@${f.price}` });
    }
    pane.setExtraMarkers('fills', marks);
  }

  // ---------- earnings ----------

  const earningsCache = new Map();
  async function applyEarnings(pane) {
    const sym = pane.state.symbol;
    if (!settings.earnings) { pane.setExtraMarkers('earnings', []); return; }
    if (!earningsCache.has(sym)) earningsCache.set(sym, getJson(`/api/earnings?symbol=${encodeURIComponent(sym)}`).catch(() => []));
    const dates = await earningsCache.get(sym);
    if (pane.state.symbol !== sym) return;
    pane.earnings = dates;
    const bars = pane.data.bars;
    const marks = [];
    for (const d of dates) {
      const t = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 1000;
      const ct = pane.data.intraday ? pane.toChartTime(t + 12 * 3600) : t;
      const bar = bars.find((b) => b.time >= ct - (pane.data.intraday ? 12 * 3600 : 0));
      if (bar) marks.push({ time: bar.time, position: 'belowBar', shape: 'circle', color: '#ffb300', text: 'E' });
    }
    pane.setExtraMarkers('earnings', marks);
    if (visible('info') && pane === getActive()) renderInfo();
  }

  // ---------- scanner ----------

  async function loadScan() {
    state.scanError = null;
    try {
      state.scan = await getJson(`/api/scanner?code=${state.scanCode}&location=${state.location}&above_price=${state.minPrice}`);
    } catch (e) {
      state.scan = [];
      state.scanError = e.message;
    }
    feed.setQuotes(state.scan.slice(0, 25).map((r) => r.symbol), 'scanner');
    renderScanner();
  }

  function renderScanner() {
    const box = $('scanner');
    const sel = (opts, value, onchange) => el('select', { onchange }, ...opts.map(([v, l]) => el('option', { value: v, selected: v === value }, l)));
    fill(box, 
      el('div', { class: 'wl-head' }, el('span', { class: 'wl-title' }, 'Scanner'), el('button', { class: 'small', onclick: loadScan }, '↻ Scan')),
      el('div', { class: 'scan-ctl' },
        sel(SCANS, state.scanCode, (e) => { state.scanCode = e.target.value; loadScan(); }),
        sel(LOCATIONS, state.location, (e) => { state.location = e.target.value; loadScan(); }),
        el('label', { class: 'muted' }, 'Min $', el('input', { type: 'number', value: state.minPrice, min: 0, onchange: (e) => { state.minPrice = Number(e.target.value) || 0; loadScan(); } }))),
      state.scanError ? el('div', { class: 'obj-empty err' }, state.scanError) : null,
      ...state.scan.map((r) => {
        const q = quotes.get(r.symbol);
        const cls = q?.changePct == null ? '' : q.changePct >= 0 ? 'up' : 'down';
        return el('div', { class: 'wl-row', onclick: () => pick(r.symbol), title: r.name },
          el('span', { class: 'wl-sym' }, `${r.rank + 1}. ${r.symbol}`),
          el('span', { class: 'wl-last' }, q?.price != null ? q.price.toFixed(2) : ''),
          el('span', { class: `wl-chg ${cls}` }, q?.change != null ? q.change.toFixed(2) : ''),
          el('span', { class: `wl-pct ${cls}` }, q?.changePct != null ? `${q.changePct.toFixed(2)}%` : ''),
          el('button', { class: 'wl-x', title: 'Add to watchlist', onclick: (e) => { e.stopPropagation(); window.__app?.watchlist.add(r.symbol); } }, '+'));
      }));
  }

  // ---------- news ----------

  let newsFor = null;
  async function loadNews(force = false) {
    const sym = getActive()?.state.symbol;
    if (!sym || (sym === newsFor && !force)) return;
    newsFor = sym;
    const box = $('news');
    fill(box, el('div', { class: 'obj-empty' }, `Loading news for ${sym}…`));
    try {
      const n = await getJson(`/api/news?symbol=${encodeURIComponent(sym)}`);
      if (newsFor !== sym) return;
      fill(box, 
        el('div', { class: 'wl-head' }, el('span', { class: 'wl-title' }, `News · ${sym}`), el('button', { class: 'small', onclick: () => loadNews(true) }, '↻')),
        n.note ? el('div', { class: 'obj-empty' }, n.note) : null,
        ...n.items.map((a) => el('div', { class: 'news-row', onclick: () => openArticle(a) },
          el('div', {}, a.headline.replace(/^\{[^}]*\}/, '')),
          el('div', { class: 'muted' }, `${new Date(a.time * 1000).toLocaleString()} · ${a.provider}`))),
        n.items.length ? null : el('div', { class: 'obj-empty' }, 'No headlines in the last 30 days.'));
    } catch (e) {
      fill(box, el('div', { class: 'obj-empty err' }, `News unavailable: ${e.message}`));
    }
  }

  async function openArticle(a) {
    const dlg = $('news-dialog');
    // Articles are provider HTML: show them in a sandboxed frame (no scripts, no navigation).
    const frame = el('iframe', { sandbox: '', class: 'news-frame' });
    fill(dlg, el('div', { class: 'gw-form' },
      el('div', { class: 'gw-head' }, el('h2', {}, a.headline.replace(/^\{[^}]*\}/, '')), el('button', { class: 'icon', onclick: () => dlg.close() }, '✕')),
      el('div', { class: 'muted' }, `${new Date(a.time * 1000).toLocaleString()} · ${a.provider}`), frame));
    dlg.showModal();
    try {
      const art = await getJson(`/api/news/article?provider=${encodeURIComponent(a.provider)}&id=${encodeURIComponent(a.id)}`);
      const bg = settings.theme === 'light' ? '#fff' : '#1e222d', fg = settings.theme === 'light' ? '#131722' : '#d1d4dc';
      frame.srcdoc = art.binary ? '<p>This article is a PDF and can\'t be shown here.</p>'
        : `<style>body{font:14px/1.5 -apple-system,sans-serif;background:${bg};color:${fg};margin:8px}a{color:#82b1ff}</style>${art.text}`;
    } catch (e) {
      frame.srcdoc = `<p>${String(e.message).replace(/</g, '&lt;')}</p>`;
    }
  }

  // ---------- symbol info ----------

  function renderInfo() {
    const pane = getActive();
    const i = pane?.data.info;
    const box = $('info');
    if (!i) { fill(box, el('div', { class: 'obj-empty' }, 'No symbol loaded')); return; }
    const row = (k, v) => (v ? el('div', { class: 'dw-row' }, el('span', { class: 'muted' }, k), el('span', {}, String(v))) : null);
    const upcoming = pane.data.sessions.filter(([, e]) => e * 1000 > Date.now()).slice(0, 5);
    const fmt = (t) => new Date(t * 1000).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const earnings = (pane.earnings || []).map((d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
    fill(box, 
      el('div', { class: 'dw-head' }, i.symbol),
      el('div', { class: 'muted pad' }, i.longName),
      row('Type', i.kind), row('Exchange', i.exchange), row('Currency', i.currency), row('Industry', i.industry),
      row('Category', [i.category, i.subcategory].filter(Boolean).join(' · ')), row('Expiry', i.expiry), row('Multiplier', i.multiplier),
      row('Contract ID', i.conId || ''), row('Exchange time zone', i.timeZone),
      upcoming.length ? el('div', { class: 'dw-head' }, 'Regular sessions (your time)') : null,
      ...upcoming.map(([s, e]) => el('div', { class: 'dw-row' }, el('span', {}, fmt(s)), el('span', { class: 'muted' }, `→ ${new Date(e * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`))),
      earnings.length ? el('div', { class: 'dw-head' }, 'Earnings dates') : null,
      ...earnings.map((d) => el('div', { class: 'dw-row' }, el('span', {}, d), el('span', { class: 'muted' }, new Date(d) > new Date() ? 'upcoming' : ''))));
  }

  // ---------- wiring ----------

  setInterval(() => {
    if (visible('positions')) loadPositions();
    if (visible('scanner')) loadScan();
  }, 60000);

  return {
    onTab(tab) {
      if (tab === 'positions') loadPositions();
      if (tab === 'scanner' && !state.scan.length) loadScan();
      if (tab === 'news') loadNews();
      if (tab === 'info') renderInfo();
    },
    /** A chart loaded data (new symbol or timeframe). */
    onLoad(pane) {
      applyTrades(pane);
      applyEarnings(pane);
      if (pane === getActive()) {
        if (visible('news')) loadNews();
        if (visible('info')) renderInfo();
      }
    },
    onActivate() {
      if (visible('news')) loadNews();
      if (visible('info')) renderInfo();
    },
    start() { loadPositions(); },
  };
}

/** Execution time like "20261126  14:30:12 US/Eastern" or "20261126-14:30:12" → UTC seconds. */
export function fillTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})[ -]+(\d{2}):(\d{2}):(\d{2})(?:\s+(\S+))?/.exec(String(s).trim());
  if (!m) return Date.now() / 1000;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  return wallToUtc(m[7] || 'local', wall);
}
