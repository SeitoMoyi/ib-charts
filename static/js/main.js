// App bootstrap: toolbar, persistence and the active chart.

import * as api from './api.js';
import { ChartPane } from './chart-pane.js';
import { Feed } from './feed.js';
import { initGateway } from './gateway.js';
import { BUILTINS } from './indicators.js';
import { initSymbolSearch } from './symbol-search.js';
import { $, el } from './util.js';
import { Watchlist } from './watchlist.js';

const TIMEFRAMES = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['30m', '30m'], ['1h', '1h'], ['4h', '4h'], ['1D', 'D'], ['1W', 'W'], ['1M', 'M']];

const defaults = { symbol: 'AAPL', tf: '5m', rth: false, ind: { sma20: true }, watchlistOpen: true };
const ui = { ...defaults, ...(await api.load('settings', 'ui', {})) };
const saveUi = api.debouncedSaver('settings', 'ui');

const feed = new Feed();
feed.onConnection((up) => { if (!up) setStatus('Disconnected from ib-charts — retrying…', 'err'); });

function setStatus(text, kind = '') {
  $('status-text').textContent = text;
  $('status').className = kind === 'err' ? 'err' : '';
  $('dot').className = kind;
  $('status').title = text;
}

// ---------- toolbar ----------
$('timeframes').append(...TIMEFRAMES.map(([tf, label]) => el('button', { 'data-tf': tf, onclick: () => active.setTimeframe(tf) }, label)));
$('indicators').append(...Object.entries(BUILTINS).map(([id, def]) => el('button', { 'data-ind': id, onclick: () => active.toggleIndicator(id) }, def.label)));
$('rth').addEventListener('click', () => active.setRth(!active.state.rth));

function syncToolbar(pane) {
  const s = pane.state;
  const starred = watchlist?.has(s.symbol);
  $('wl-star').textContent = starred ? '★' : '☆';
  $('wl-star').classList.toggle('starred', !!starred);
  $('wl-star').title = starred ? 'Remove from watchlist' : 'Add to watchlist';
  watchlist?.highlight();
  if (document.activeElement !== $('symbol')) $('symbol').value = s.symbol;
  document.querySelectorAll('[data-tf]').forEach((b) => b.classList.toggle('active', b.dataset.tf === s.tf));
  document.querySelectorAll('[data-ind]').forEach((b) => b.classList.toggle('active', !!s.ind[b.dataset.ind]));
  $('rth').classList.toggle('active', s.rth);
}

// ---------- watchlist ----------
let active;
const watchlist = new Watchlist(feed, { onPick: (sym) => active.setSymbol(sym), current: () => active?.state.symbol });
watchlist.onChange = () => syncToolbar(active);
await watchlist.load();
const setWatchlistOpen = (open) => {
  $('watchlist').hidden = !open;
  $('wl-toggle').classList.toggle('active', open);
  ui.watchlistOpen = open;
};
setWatchlistOpen(ui.watchlistOpen);
$('wl-toggle').addEventListener('click', () => { setWatchlistOpen($('watchlist').hidden); saveUi(ui); });
$('wl-star').addEventListener('click', () => watchlist.toggle(active.state.symbol));

// ---------- chart ----------
active = new ChartPane($('charts'), feed, structuredClone(ui), {
  onChange: (pane) => {
    syncToolbar(pane);
    const { watchlistOpen } = ui;
    Object.assign(ui, structuredClone(pane.state), { watchlistOpen });
    saveUi(ui);
  },
  onStatus: (_pane, text, kind) => setStatus(text, kind),
  onLoad: (pane) => { document.title = `${pane.data.symbol} · IB Charts`; },
});

initGateway(feed);
initSymbolSearch($('symbol'), $('suggestions'), (sym) => active.setSymbol(sym), () => active.state.symbol);
