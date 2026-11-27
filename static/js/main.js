// App bootstrap: toolbar, persistence and the active chart.

import * as api from './api.js';
import { ChartPane } from './chart-pane.js';
import { Feed } from './feed.js';
import { initDrawingToolbar, renderObjects } from './drawing-toolbar.js';
import { initGateway } from './gateway.js';
import { initScriptsUi, onScriptFileChanged, openStudySettings } from './scripts/scripts-ui.js';
import { initSymbolSearch } from './symbol-search.js';
import { $, el } from './util.js';
import { AlertEngine, initAlertsUi, openAlertDialog } from './alerts.js';
import { Watchlist } from './watchlist.js';

const TIMEFRAMES = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['30m', '30m'], ['1h', '1h'], ['4h', '4h'], ['1D', 'D'], ['1W', 'W'], ['1M', 'M']];

const defaults = { symbol: 'AAPL', tf: '5m', rth: false, watchlistOpen: true };
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
  $('rth').classList.toggle('active', s.rth);
}

// ---------- watchlist ----------
let active;
const watchlist = new Watchlist(feed, { onPick: (sym) => active.setSymbol(sym), current: () => active?.state.symbol });
watchlist.onChange = () => syncToolbar(active);
await watchlist.load();
const setWatchlistOpen = (open) => {
  $('sidebar').hidden = !open;
  $('wl-toggle').classList.toggle('active', open);
  ui.watchlistOpen = open;
};
setWatchlistOpen(ui.watchlistOpen);
$('wl-toggle').addEventListener('click', () => { setWatchlistOpen($('sidebar').hidden); saveUi(ui); });
const showTab = (tab) => {
  document.querySelectorAll('.sb-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.sb-pane').forEach((p) => { p.hidden = p.id !== tab; });
  ui.sidebarTab = tab;
};
document.querySelectorAll('.sb-tabs button').forEach((b) => b.addEventListener('click', () => { showTab(b.dataset.tab); saveUi(ui); }));
showTab(ui.sidebarTab || 'watchlist');
$('wl-star').addEventListener('click', () => watchlist.toggle(active.state.symbol));

// ---------- alerts ----------
const alerts = new AlertEngine(feed, () => active);
await alerts.load();
initAlertsUi(alerts);
alerts.onChange(() => {
  active?.setAlertLevels(alerts.levelsFor(active.state.symbol));
  const n = alerts.alerts.filter((a) => a.active).length;
  $('alert-count').textContent = n ? `(${n})` : '';
});
$('alert-btn').addEventListener('click', () => openAlertDialog(alerts, {}));

// ---------- chart ----------
active = new ChartPane($('charts'), feed, structuredClone(ui), {
  onChange: (pane) => {
    syncToolbar(pane);
    renderObjects(() => active);
    const { watchlistOpen, sidebarTab } = ui;
    Object.assign(ui, structuredClone(pane.state), { watchlistOpen, sidebarTab });
    if (alerts) pane.setAlertLevels(alerts.levelsFor(pane.state.symbol));
    saveUi(ui);
  },
  onStatus: (_pane, text, kind) => setStatus(text, kind),
  onLoad: (pane) => { document.title = `${pane.data.symbol} · IB Charts`; },
  onStudySettings: (host, study) => openStudySettings(host, study),
  onDrawingAlert: (d) => openAlertDialog(alerts, { drawing: d }),
});

const drawTools = initDrawingToolbar(() => active);
active.drawings.onChange((m) => { drawTools.sync(); alerts.syncDrawings(m.key, m.drawings); });
drawTools.sync();
initGateway(feed);
initScriptsUi(() => active);
active.onStudiesRun = () => renderObjects(() => active);
feed.onGlobal((m) => { if (m.type === 'scriptChanged') onScriptFileChanged(m.name); });
// Handy for debugging from the devtools console.
window.__app = { get active() { return active; }, feed, watchlist, alerts };
active.setAlertLevels(alerts.levelsFor(active.state.symbol));
alerts.listeners.forEach((cb) => cb(alerts));
initSymbolSearch($('symbol'), $('suggestions'), (sym) => active.setSymbol(sym), () => active.state.symbol);
