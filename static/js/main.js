// App bootstrap: settings, toolbar, layout of charts, side panel and all the wiring.

import * as api from './api.js';
import { AlertEngine, initAlertsUi, openAlertDialog } from './alerts.js';
import { CHART_TYPES } from './chart-pane.js';
import { initDrawingToolbar, renderObjects } from './drawing-toolbar.js';
import { Feed } from './feed.js';
import { initGateway } from './gateway.js';
import { initIbPanels } from './ibinfo.js';
import { LAYOUTS, Layout } from './layout.js';
import { initScriptsUi, onScriptFileChanged, openStudySettings } from './scripts/scripts-ui.js';
import { TIME_ZONES, loadSettings, onSettings, setSetting, settings } from './settings.js';
import { initSymbolSearch } from './symbol-search.js';
import { $, el, openMenu } from './util.js';
import { Watchlist } from './watchlist.js';
import { copyScreenshot, initReplay, layoutsMenuItems, renderDataWindow, saveScreenshot, showShortcuts } from './workflow.js';

const FAVORITE_TFS = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['1h', '1h'], ['4h', '4h'], ['1D', 'D'], ['1W', 'W']];
const ALL_TFS = [
  ['Seconds', ['1s', '5s', '10s', '15s', '30s']],
  ['Minutes', ['1m', '2m', '3m', '5m', '10m', '15m', '20m', '30m']],
  ['Hours', ['1h', '2h', '3h', '4h', '8h']],
  ['Days', ['1D', '1W', '1M']],
];
const TF_IDS = new Set(ALL_TFS.flatMap(([, l]) => l));

await loadSettings();
const ui = { watchlistOpen: true, ...(await api.load('settings', 'ui', {})) };
// Older versions stored a single chart's state at the top level.
if (!ui.layout) ui.layout = { type: '1', panes: [{ symbol: ui.symbol, tf: ui.tf, rth: ui.rth, studies: ui.studies, ind: ui.ind }].map(clean) };
const saveUi = api.debouncedSaver('settings', 'ui');

function clean(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)); }

const feed = new Feed();
feed.onConnection((up) => { if (!up) setStatus('Disconnected from ib-charts — retrying…', 'err'); });

function setStatus(text, kind = '') {
  $('status-text').textContent = text;
  $('status').className = kind === 'err' ? 'err' : '';
  $('dot').className = kind;
  $('status').title = text;
}

// ---------- side panel: watchlist + alerts ----------
let layout;
const active = () => layout?.active;
const watchlist = new Watchlist(feed, { onPick: (sym) => active().setSymbol(sym), current: () => active()?.state.symbol });
watchlist.onChange = () => syncToolbar();
await watchlist.load();

const setPanelOpen = (open) => { $('sidebar').hidden = !open; $('wl-toggle').classList.toggle('active', open); ui.watchlistOpen = open; };
setPanelOpen(ui.watchlistOpen);
$('wl-toggle').addEventListener('click', () => { setPanelOpen($('sidebar').hidden); saveUi(ui); });
const showTab = (tab) => {
  document.querySelectorAll('.sb-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.sb-pane').forEach((p) => { p.hidden = p.id !== tab; });
  ui.sidebarTab = tab;
  if (tab === 'datawin') renderDataWindow(active());
  ibPanels?.onTab(tab);
};
let ibPanels;
document.querySelectorAll('.sb-tabs button').forEach((b) => b.addEventListener('click', () => { showTab(b.dataset.tab); saveUi(ui); }));
showTab(ui.sidebarTab || 'watchlist');
$('wl-star').addEventListener('click', () => watchlist.toggle(active().state.symbol));

const alerts = new AlertEngine(feed, active);
await alerts.load();
initAlertsUi(alerts);
const refreshAlertLevels = () => layout?.panes.forEach((p) => p.setAlertLevels(alerts.levelsFor(p.state.symbol)));
alerts.onChange(() => {
  refreshAlertLevels();
  const n = alerts.alerts.filter((a) => a.active).length;
  $('alert-count').textContent = n ? `(${n})` : '';
});
$('alert-btn').addEventListener('click', () => openAlertDialog(alerts, {}));

// ---------- toolbar ----------
$('timeframes').append(...FAVORITE_TFS.map(([tf, label]) => el('button', { 'data-tf': tf, onclick: () => active().setTimeframe(tf) }, label)),
  el('button', { id: 'tf-more', title: 'All timeframes (or type a number, e.g. 15 or 2h)', onclick: (e) => tfMenu(e.currentTarget) }, '▾'));
$('rth').addEventListener('click', () => active().setRth(!active().state.rth));

function tfMenu(anchor) {
  openMenu(anchor, (close) => ALL_TFS.flatMap(([group, list]) => [
    el('div', { class: 'menu-title' }, group),
    el('div', { class: 'menu-grid' }, ...list.map((tf) => el('button', { class: active().state.tf === tf ? 'on' : '', onclick: () => { active().setTimeframe(tf); close(); } }, tf))),
  ]));
}

$('type-btn').addEventListener('click', (e) => openMenu(e.currentTarget, (close) => [
  el('div', { class: 'menu-title' }, 'Chart type'),
  ...Object.entries(CHART_TYPES).map(([id, label]) => el('div', { class: `menu-item ${active().state.chartType === id ? 'on' : ''}`, onclick: () => { active().setChartType(id); close(); } }, label)),
]));

$('compare-btn').addEventListener('click', (e) => openMenu(e.currentTarget, (close) => {
  const input = el('input', { class: 'menu-input', placeholder: 'Symbol to compare, e.g. QQQ', spellcheck: 'false' });
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter' && input.value.trim()) { active().addCompare(input.value); close(); }
  });
  setTimeout(() => input.focus(), 0);
  const current = active().state.compares;
  return [
    el('div', { class: 'menu-title' }, 'Compare symbol (switches to % scale)'), input,
    ...current.map((c) => el('div', { class: 'menu-item' }, el('span', { class: 'obj-dot', style: `background:${c.color}` }), ` ${c.symbol}`,
      el('button', { class: 'small right', onclick: () => { active().removeCompare(c.symbol); close(); } }, 'Remove'))),
  ];
}));

$('layout-btn').addEventListener('click', (e) => openMenu(e.currentTarget, (close) => {
  const saved = el('div');
  layoutsMenuItems(layout, close, (l) => layout.load(l)).then((items) => saved.append(...items));
  return [...layout.menu(close), saved];
}));

const toast = (text) => {
  let box = $('toasts');
  if (!box) { box = el('div', { id: 'toasts' }); document.body.append(box); }
  const t = el('div', { class: 'toast info' }, text);
  box.prepend(t);
  setTimeout(() => t.remove(), 4000);
};
$('shot-btn').addEventListener('click', (e) => openMenu(e.currentTarget, (close) => [
  el('div', { class: 'menu-item', onclick: () => { close(); copyScreenshot(active(), toast); } }, 'Copy image (Alt+S)'),
  el('div', { class: 'menu-item', onclick: () => { close(); saveScreenshot(active(), toast); } }, 'Save image to Downloads'),
]));
$('help-btn').addEventListener('click', showShortcuts);
document.addEventListener('keydown', (e) => {
  const t = document.activeElement;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName) || t?.isContentEditable || document.querySelector('dialog[open]')) return;
  if (e.key === '?') { e.preventDefault(); showShortcuts(); }
  if (e.altKey && e.code === 'KeyS') { e.preventDefault(); copyScreenshot(active(), toast); }
});

$('settings-btn').addEventListener('click', (e) => openMenu(e.currentTarget, () => {
  const toggle = (key, label) => el('label', { class: 'menu-item check' },
    el('input', { type: 'checkbox', checked: settings[key], onchange: (ev) => setSetting(key, ev.target.checked) }), label);
  return [
    el('div', { class: 'menu-title' }, 'Theme'),
    el('div', { class: 'menu-grid' }, ...['dark', 'light'].map((t) => el('button', { class: settings.theme === t ? 'on' : '', onclick: (ev) => { setSetting('theme', t); ev.target.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === ev.target)); } }, t === 'dark' ? 'Dark' : 'Light'))),
    el('div', { class: 'menu-title' }, 'Time zone'),
    el('select', { class: 'menu-input', onchange: (ev) => setSetting('tz', ev.target.value) }, ...TIME_ZONES.map(([id, label]) => el('option', { value: id, selected: settings.tz === id }, label))),
    el('div', { class: 'menu-title' }, 'Chart'),
    toggle('sessionShading', 'Shade pre-market / after-hours'),
    toggle('sessionBreaks', 'Session break lines'),
    toggle('countdown', 'Countdown to bar close'),
    toggle('prevClose', 'Previous close line'),
    toggle('dayHighLow', "Today's high / low lines"),
    toggle('volumeProfile', 'Volume profile (visible range)'),
    toggle('earnings', 'Earnings markers (needs Wall Street Horizon data)'),
  ];
}));

function tzMenu(anchor) {
  openMenu(anchor, (close) => [
    el('div', { class: 'menu-title' }, 'Time zone'),
    ...TIME_ZONES.map(([id, label]) => el('div', { class: `menu-item ${settings.tz === id ? 'on' : ''}`, onclick: () => { setSetting('tz', id); close(); } }, label)),
  ]);
}

onSettings((key) => {
  layout.panes.forEach((p) => p.onSettings(key));
  if (key === 'earnings') layout.panes.forEach((p) => ibPanels?.onLoad(p));
});

function syncToolbar() {
  const pane = active();
  if (!pane) return;
  const s = pane.state;
  const starred = watchlist.has(s.symbol);
  $('wl-star').textContent = starred ? '★' : '☆';
  $('wl-star').classList.toggle('starred', starred);
  $('wl-star').title = starred ? 'Remove from watchlist' : 'Add to watchlist';
  watchlist.highlight();
  if (document.activeElement !== $('symbol')) $('symbol').value = s.symbol;
  document.querySelectorAll('[data-tf]').forEach((b) => b.classList.toggle('active', b.dataset.tf === s.tf));
  const fav = FAVORITE_TFS.some(([tf]) => tf === s.tf);
  $('tf-more').textContent = fav ? '▾' : `${s.tf} ▾`;
  $('tf-more').classList.toggle('active', !fav);
  $('type-btn').textContent = `${CHART_TYPES[s.chartType] || 'Candles'} ▾`;
  $('compare-btn').classList.toggle('active', s.compares.length > 0);
  $('layout-btn').textContent = `▦ ${layout.panes.length > 1 ? layout.panes.length : ''}`;
  $('rth').classList.toggle('active', s.rth);
}

// ---------- typing a number changes the timeframe ----------
document.addEventListener('keydown', (e) => {
  const t = document.activeElement;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName) || t?.isContentEditable || document.querySelector('dialog[open]')) return;
  if (e.metaKey || e.ctrlKey || e.altKey || !/^[0-9]$/.test(e.key)) return;
  e.preventDefault();
  const box = el('div', { id: 'tf-typer' }, el('div', { class: 'muted' }, 'Timeframe — e.g. 15, 2h, 30s, D, W'));
  const input = el('input', { value: e.key, spellcheck: 'false' });
  box.prepend(input);
  document.body.append(box);
  input.focus();
  input.setSelectionRange(1, 1);
  const done = (apply) => {
    if (!box.isConnected) return;
    const tf = parseTf(input.value);
    box.remove();
    if (apply && tf) active().setTimeframe(tf);
  };
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') done(true);
    if (ev.key === 'Escape') done(false);
  });
  input.addEventListener('input', () => input.classList.toggle('bad', !parseTf(input.value)));
  input.addEventListener('blur', () => done(false));
});

function parseTf(text) {
  let s = text.trim();
  if (/^\d+$/.test(s)) s += 'm';
  s = s.replace(/^([DWM])$/i, (m) => `1${m.toUpperCase()}`).replace(/^(\d+)([dwM])$/, (_, n, u) => `${n}${u === 'M' ? 'M' : u.toUpperCase()}`).replace(/^(\d+)H$/, '$1h').replace(/^(\d+)S$/, '$1s');
  return TF_IDS.has(s) ? s : null;
}

// ---------- charts ----------
let drawTools, replay;
layout = new Layout($('charts'), feed, ui.layout, {
  onStatus: (_p, text, kind) => setStatus(text, kind),
  onLoad: (p) => { document.title = `${p.data.symbol} · IB Charts`; },
  onAnyLoad: (p) => ibPanels?.onLoad(p),
  onStudySettings: (host, study) => openStudySettings(host, study),
  onDrawingAlert: (d) => openAlertDialog(alerts, { drawing: d }),
  onTimeZoneMenu: (anchor) => tzMenu(anchor),
  onLegend: (p, bar) => { if (p === active()) renderDataWindow(p, bar); },
  onReplay: () => replay?.render(),
  onPaneCreated: (p) => {
    p.drawings.onChange((m) => { if (p === active()) drawTools?.sync(); alerts.syncDrawings(m.key, m.drawings); });
    p.onStudiesRun = () => { if (p === active()) { renderObjects(active); if (!p.hovering) renderDataWindow(p); } };
    p.setAlertLevels(alerts.levelsFor(p.state.symbol));
  },
  onActivate: (p) => {
    syncToolbar();
    drawTools?.sync();
    renderObjects(active);
    document.title = `${p.data.symbol || p.state.symbol} · IB Charts`;
    const st = document.getElementById('status-text');
    if (st && p.data.symbol) setStatus(`${p.data.symbol} ${p.state.tf} · live`, 'live');
  },
  onActiveChange: () => { syncToolbar(); renderObjects(active); replay?.render(); ibPanels?.onActivate(); },
  onAnyChange: (p) => p.setAlertLevels(alerts.levelsFor(p.state.symbol)),
  onChange: (l) => {
    ui.layout = l.serialize();
    saveUi(ui);
    syncToolbar();
  },
});

ibPanels = initIbPanels(feed, active, () => layout.panes);
ibPanels.start();
layout.panes.forEach((p) => p.data.bars.length && ibPanels.onLoad(p));
drawTools = initDrawingToolbar(active);
replay = initReplay(active);
drawTools.sync();
initGateway(feed);
initScriptsUi(active, () => layout.panes);
feed.onGlobal((m) => { if (m.type === 'scriptChanged') onScriptFileChanged(m.name); });
initSymbolSearch($('symbol'), $('suggestions'), (sym) => active().setSymbol(sym), () => active().state.symbol);
syncToolbar();
alerts.listeners.forEach((cb) => cb(alerts));

// Handy for debugging from the devtools console.
window.__app = { get active() { return active(); }, layout, feed, watchlist, alerts, settings, LAYOUTS };
