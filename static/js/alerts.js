// Alerts: price levels, drawn lines and script alertconditions.
//
// Alerts are evaluated here in the UI. In the desktop app the window only hides
// when closed, so alerts keep running from the tray.
//   - price alerts use live quotes;
//   - line and script alerts follow live bars on the timeframe they were created on.

import * as api from './api.js';
import { TimeMapper } from './drawings/geometry.js';
import { SHAPES } from './drawings/shapes.js';
import { Runner, loadCode, splitRef } from './scripts/studies.js';
import { $, confirmDialog, el, fill } from './util.js';

const LINE_TYPES = ['hline', 'hray', 'trend', 'ray', 'extended'];
const SCRIPT_EVERY_MS = 2000;
const TRIGGERS = { once: 'Only once', bar: 'Once per bar', every: 'Every time' };
const DIRS = { cross: 'Crossing', up: 'Crossing up', down: 'Crossing down' };

let seq = Date.now();

export class AlertEngine {
  /**
   * @param {import('./feed.js').Feed} feed
   * @param {() => import('./chart-pane.js').ChartPane} getActive
   */
  constructor(feed, getActive) {
    this.feed = feed;
    this.getActive = getActive;
    this.alerts = [];
    this.log = [];
    this.streams = new Map(); // "SYM|tf" -> { bars, intraday, mapper, alerts }
    this.state = new Map(); // alert id -> { sign, firedBar, lastCond }
    this.runners = new Map(); // alert id -> Runner
    this.listeners = new Set();
    this.save = api.debouncedSaver('alerts', 'all', 300);
    feed.onGlobal((m) => { if (m.type === 'quote') this.onQuote(m.quote); });
  }

  async load() {
    const saved = await api.load('alerts', 'all', null);
    this.alerts = saved?.alerts || [];
    this.log = saved?.log || [];
    this.resubscribe();
  }

  onChange(cb) { this.listeners.add(cb); }
  changed() {
    this.save({ alerts: this.alerts, log: this.log.slice(0, 200) });
    this.resubscribe();
    this.listeners.forEach((cb) => cb(this));
  }

  add(a) {
    a.id = `a${seq++}`;
    a.active = true;
    a.created = Date.now();
    this.alerts.push(a);
    this.changed();
    return a;
  }

  update(id, patch) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return;
    Object.assign(a, patch);
    this.state.delete(id); // re-baseline
    this.changed();
  }

  remove(id) {
    this.alerts = this.alerts.filter((a) => a.id !== id);
    this.state.delete(id);
    this.runners.get(id)?.terminate();
    this.runners.delete(id);
    this.changed();
  }

  clearLog() { this.log = []; this.changed(); }

  /** A drawing was moved or deleted: keep line alerts in sync. */
  syncDrawings(key, drawings) {
    let dirty = false;
    for (const a of this.alerts) {
      if (a.kind !== 'line' || a.drawingKey !== key) continue;
      const d = drawings.find((x) => x.id === a.drawingId);
      if (!d) { if (a.active) { a.active = false; a.note = 'line was deleted'; dirty = true; } continue; }
      if (JSON.stringify(d.points) !== JSON.stringify(a.points)) { a.points = structuredClone(d.points); this.state.delete(a.id); dirty = true; }
    }
    if (dirty) this.changed();
  }

  /** Price alert levels for a symbol, to draw on its chart. */
  levelsFor(symbol) {
    return this.alerts.filter((a) => a.active && a.kind === 'price' && a.symbol === symbol).map((a) => a.value);
  }

  // ---------- data subscriptions ----------

  resubscribe() {
    const active = this.alerts.filter((a) => a.active);
    this.feed.setQuotes([...new Set(active.filter((a) => a.kind === 'price').map((a) => a.symbol))], 'alerts');
    const wanted = new Set(active.filter((a) => a.kind !== 'price').map((a) => `${a.symbol}|${a.tf}`));
    for (const [key] of this.streams) {
      if (!wanted.has(key)) { this.feed.unsubscribe(`alert:${key}`); this.streams.delete(key); }
    }
    for (const key of wanted) {
      if (this.streams.has(key)) continue;
      const [symbol, tf] = key.split('|');
      const st = { bars: [], intraday: true, mapper: new TimeMapper(), lastRun: 0 };
      this.streams.set(key, st);
      this.feed.subscribe(`alert:${key}`, { symbol, tf, rth: false }, (m) => this.onStream(key, m));
    }
  }

  onStream(key, m) {
    const st = this.streams.get(key);
    if (!st) return;
    const shift = (t) => (st.intraday ? t - new Date(t * 1000).getTimezoneOffset() * 60 : t);
    if (m.type === 'history') {
      st.intraday = m.intraday;
      st.bars = m.bars.map((b) => ({ ...b, time: shift(b.time) }));
      st.mapper.setTimes(st.bars.map((b) => b.time));
    } else if (m.type === 'bar') {
      const bar = { ...m.bar, time: shift(m.bar.time) };
      const last = st.bars[st.bars.length - 1];
      if (last && bar.time < last.time) return;
      if (last && bar.time === last.time) st.bars[st.bars.length - 1] = bar; else st.bars.push(bar);
      st.mapper.update(bar.time);
    } else return;
    this.evaluateStream(key, st);
  }

  // ---------- evaluation ----------

  onQuote(q) {
    if (q.price == null) return;
    for (const a of this.alerts) {
      if (a.active && a.kind === 'price' && a.symbol === q.symbol) this.checkCross(a, q.price, a.value, null);
    }
  }

  evaluateStream(key, st) {
    const bar = st.bars[st.bars.length - 1];
    if (!bar) return;
    for (const a of this.alerts) {
      if (!a.active || `${a.symbol}|${a.tf}` !== key) continue;
      if (a.kind === 'line') {
        const level = lineValue(a, st);
        if (level != null) this.checkCross(a, bar.close, level, bar.time);
      } else if (a.kind === 'script') {
        this.runScript(a, st, bar.time);
      }
    }
  }

  /** Fires when `price` crosses `level` in the alert's direction. */
  checkCross(a, price, level, barTime) {
    const s = this.state.get(a.id) || {};
    const sign = Math.sign(price - level);
    if (s.sign === undefined || sign === 0) { this.state.set(a.id, { ...s, sign: sign || s.sign }); return; }
    const crossedUp = s.sign < 0 && sign > 0, crossedDown = s.sign > 0 && sign < 0;
    s.sign = sign;
    this.state.set(a.id, s);
    const hit = a.dir === 'up' ? crossedUp : a.dir === 'down' ? crossedDown : crossedUp || crossedDown;
    if (hit) this.fire(a, `${a.symbol} ${crossedUp ? 'crossed above' : 'crossed below'} ${a.kind === 'line' ? 'the line at ' : ''}${fmt(level)} (now ${fmt(price)})`, barTime);
  }

  async runScript(a, st, barTime) {
    const now = Date.now();
    const s = this.state.get(a.id) || {};
    if (s.running || now - (s.lastRun || 0) < SCRIPT_EVERY_MS) return;
    s.running = true;
    s.lastRun = now;
    this.state.set(a.id, s);
    try {
      let runner = this.runners.get(a.id);
      if (!runner) { runner = new Runner(); this.runners.set(a.id, runner); }
      const code = await loadCode(a.ref);
      const n = st.bars.length;
      const col = (k) => Float64Array.from(st.bars, (b) => b[k] ?? (k === 'volume' ? 0 : Number.NaN));
      const res = await runner.run(code, { time: col('time'), open: col('open'), high: col('high'), low: col('low'), close: col('close'), volume: col('volume') }, a.inputs || {});
      const cond = res.alerts.find((x) => x.title === a.condition);
      if (!cond) { a.note = `condition "${a.condition}" not found in script`; return; }
      a.note = '';
      const rising = cond.last && !s.lastCond;
      s.lastCond = cond.last;
      if (cond.last && (a.trigger !== 'every' || rising)) this.fire(a, cond.message || `${a.condition} (${splitRef(a.ref)[1]})`, barTime ?? n);
    } catch (e) {
      if (e.message !== 'superseded') a.note = e.message;
    } finally {
      s.running = false;
    }
  }

  fire(a, text, barTime) {
    const s = this.state.get(a.id) || {};
    if (a.trigger === 'bar' && barTime != null && s.firedBar === barTime) return;
    s.firedBar = barTime;
    this.state.set(a.id, s);
    const message = a.message?.trim() || text;
    this.log.unshift({ id: a.id, time: Date.now(), symbol: a.symbol, message });
    if (a.trigger === 'once') a.active = false;
    a.lastFired = Date.now();
    this.changed();
    notify(`⏰ ${a.symbol}`, message, a.sound !== false);
  }
}

/** Price of a drawn line at the latest bar of `st`. */
function lineValue(a, st) {
  const [p0, p1] = a.points;
  if (a.lineType === 'hline' || a.lineType === 'hray') return p0.p;
  const shift = (t) => (st.intraday ? t - new Date(t * 1000).getTimezoneOffset() * 60 : t);
  const l0 = st.mapper.toLogical(shift(p0.t)), l1 = st.mapper.toLogical(shift(p1.t));
  if (l0 == null || l1 == null || l0 === l1) return null;
  const l = st.bars.length - 1;
  return p0.p + ((p1.p - p0.p) * (l - l0)) / (l1 - l0);
}

function fmt(v) {
  const a = Math.abs(v);
  return v.toFixed(a >= 100 ? 2 : a >= 1 ? 4 : 5);
}

// ---------- notifications ----------

async function notify(title, body, sound) {
  toast(title, body);
  if (sound) beep();
  try {
    const r = await fetch('/api/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body }) });
    if (r.ok) return;
  } catch { /* fall through */ }
  if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
}

function toast(title, body) {
  let box = $('toasts');
  if (!box) { box = el('div', { id: 'toasts' }); document.body.append(box); }
  const t = el('div', { class: 'toast' }, el('b', {}, title), el('div', {}, body));
  t.addEventListener('click', () => t.remove());
  box.prepend(t);
  setTimeout(() => t.remove(), 12000);
}

let audio;
function beep() {
  try {
    audio ||= new AudioContext();
    const now = audio.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.2, now + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.16);
      o.connect(g).connect(audio.destination);
      o.start(now + i * 0.18);
      o.stop(now + i * 0.18 + 0.17);
    }
  } catch { /* no audio */ }
}

// ---------- UI: panel ----------

export function initAlertsUi(engine) {
  const box = $('alerts');
  const render = () => {
    const rows = engine.alerts.map((a) => el('div', { class: `al-row ${a.active ? '' : 'off'}` },
      el('span', { class: `al-dot ${a.active ? 'on' : ''}` }),
      el('div', { class: 'al-main' },
        el('div', {}, el('b', {}, a.symbol), ' ', describe(a)),
        el('div', { class: 'muted' }, TRIGGERS[a.trigger] + (a.lastFired ? ` · fired ${ago(a.lastFired)}` : '') + (a.note ? ` · ⚠ ${a.note}` : ''))),
      el('button', { title: a.active ? 'Pause' : 'Resume', onclick: () => engine.update(a.id, { active: !a.active, note: '' }) }, a.active ? '⏸' : '▶'),
      el('button', { title: 'Edit', onclick: () => openAlertDialog(engine, { edit: a }) }, '✎'),
      el('button', { title: 'Delete', onclick: async () => { if (await confirmDialog('Delete this alert?', 'Delete')) engine.remove(a.id); } }, '×')));
    const log = engine.log.slice(0, 50).map((l) => el('div', { class: 'al-log' }, el('span', { class: 'muted' }, new Date(l.time).toLocaleString()), el('div', {}, l.message)));
    fill(box, 
      el('div', { class: 'wl-head' }, el('span', { class: 'wl-title' }, 'Alerts'),
        el('button', { class: 'small', title: 'Create alert (Alt+A)', onclick: () => openAlertDialog(engine, {}) }, '+ Create')),
      el('div', { class: 'al-list' }, ...(rows.length ? rows : [el('div', { class: 'obj-empty' }, 'No alerts yet. Press Alt+A to create one.')])),
      el('div', { class: 'wl-head' }, el('span', { class: 'muted' }, 'Log'), engine.log.length ? el('button', { class: 'small', onclick: () => engine.clearLog() }, 'Clear') : null),
      el('div', { class: 'al-loglist' }, ...log));
  };
  engine.onChange(render);
  render();
  setInterval(render, 60000); // refresh "fired 3 min ago"

  document.addEventListener('keydown', (e) => {
    const t = document.activeElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName) || t?.isContentEditable || document.querySelector('dialog[open]')) return;
    if (e.altKey && e.code === 'KeyA') { e.preventDefault(); openAlertDialog(engine, {}); }
  });
}

function describe(a) {
  if (a.kind === 'price') return `${DIRS[a.dir].toLowerCase()} ${fmt(a.value)}`;
  if (a.kind === 'line') return `${DIRS[a.dir].toLowerCase()} ${SHAPES[a.lineType]?.label.toLowerCase() || 'line'} (${a.tf})`;
  return `${a.condition} · ${splitRef(a.ref)[1]} (${a.tf})`;
}

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

// ---------- UI: create / edit dialog ----------

/** @param {{edit?: object, drawing?: object}} opts */
export function openAlertDialog(engine, { edit = null, drawing = null } = {}) {
  const pane = engine.getActive();
  const symbol = edit?.symbol ?? pane?.state.symbol ?? '';
  const sameSymbol = pane && pane.state.symbol === symbol;
  const lastPrice = pane?.data.bars.at(-1)?.close;

  // Condition sources available on the current chart.
  const sources = [{ value: 'price', label: 'Price' }];
  if (sameSymbol) {
    for (const d of pane.drawings.drawings.filter((x) => LINE_TYPES.includes(x.type))) {
      sources.push({ value: `line:${d.id}`, label: `${SHAPES[d.type].label} @ ${fmt(d.points[0].p)}`, drawing: d });
    }
    for (const s of pane.studies.studies) {
      for (const c of s.result?.alerts || []) sources.push({ value: `script:${s.cfg.uid}:${c.title}`, label: `${s.title}: ${c.title}`, study: s, condition: c.title });
    }
  }
  if (edit?.kind === 'line' && !sources.some((x) => x.value === `line:${edit.drawingId}`)) sources.push({ value: `line:${edit.drawingId}`, label: `${SHAPES[edit.lineType]?.label || 'Line'} (saved)` });
  if (edit?.kind === 'script') sources.push({ value: 'script:saved', label: `${splitRef(edit.ref)[1]}: ${edit.condition} (saved)` });
  const initial = edit ? (edit.kind === 'price' ? 'price' : edit.kind === 'line' ? `line:${edit.drawingId}` : 'script:saved') : drawing ? `line:${drawing.id}` : 'price';

  const dlg = $('alert-dialog');
  const srcSel = el('select', { name: 'source' }, ...sources.map((x) => el('option', { value: x.value, selected: x.value === initial }, x.label)));
  const dirSel = el('select', { name: 'dir' }, ...Object.entries(DIRS).map(([v, l]) => el('option', { value: v, selected: (edit?.dir ?? 'cross') === v }, l)));
  const value = el('input', { name: 'value', type: 'number', step: 'any', value: edit?.value ?? (lastPrice != null ? +lastPrice.toFixed(pane.data.precision) : '') });
  const trigSel = el('select', { name: 'trigger' }, ...Object.entries(TRIGGERS).map(([v, l]) => el('option', { value: v, selected: (edit?.trigger ?? 'once') === v }, l)));
  const msg = el('input', { name: 'message', value: edit?.message ?? '', placeholder: 'Optional — default describes what happened' });
  const sound = el('input', { type: 'checkbox', name: 'sound', checked: edit?.sound !== false });
  const dirRow = el('div', { class: 'row' }, el('span', { class: 'label' }, 'Condition'), dirSel);
  const valueRow = el('div', { class: 'row' }, el('span', { class: 'label' }, 'Price'), value);
  const sync = () => {
    const v = srcSel.value;
    dirRow.hidden = v.startsWith('script');
    valueRow.hidden = v !== 'price';
  };
  srcSel.addEventListener('change', sync);

  const form = el('form', { class: 'gw-form', onsubmit: (e) => {
    e.preventDefault();
    const v = srcSel.value;
    const src = sources.find((x) => x.value === v);
    const base = { symbol, trigger: trigSel.value, message: msg.value, sound: sound.checked };
    let a;
    if (v === 'price') {
      const price = parseFloat(value.value);
      if (!Number.isFinite(price)) return;
      a = { ...base, kind: 'price', dir: dirSel.value, value: price };
    } else if (v.startsWith('line:')) {
      const d = src.drawing;
      a = d ? { ...base, kind: 'line', dir: dirSel.value, tf: pane.state.tf, drawingId: d.id, drawingKey: pane.drawings.key, lineType: d.type, points: structuredClone(d.points) }
        : { ...edit, ...base, dir: dirSel.value };
    } else if (v === 'script:saved') {
      a = { ...edit, ...base };
    } else {
      const s = src.study;
      a = { ...base, kind: 'script', tf: pane.state.tf, ref: s.cfg.ref, inputs: { ...s.cfg.inputs }, condition: src.condition };
    }
    if ('Notification' in window && Notification.permission === 'default' && !window.__IB_CHARTS_DESKTOP__) Notification.requestPermission();
    if (edit) engine.update(edit.id, { ...a, active: true, note: '' }); else engine.add(a);
    dlg.close();
  } },
  el('div', { class: 'gw-head' }, el('h2', {}, edit ? `Edit alert — ${symbol}` : `Create alert — ${symbol}`), el('button', { type: 'button', class: 'icon', onclick: () => dlg.close() }, '✕')),
  el('div', { class: 'row' }, el('span', { class: 'label' }, 'Source'), srcSel),
  dirRow, valueRow,
  el('div', { class: 'row' }, el('span', { class: 'label' }, 'Trigger'), trigSel),
  el('div', { class: 'row' }, el('span', { class: 'label' }, 'Message'), msg),
  el('label', { class: 'row check' }, sound, 'Play a sound'),
  el('div', { class: 'muted' }, 'Line and script alerts follow the timeframe of the current chart. Alerts keep running while IB Charts is open (also when its window is closed to the tray).'),
  el('div', { class: 'gw-actions' }, el('button', { type: 'submit', class: 'primary' }, edit ? 'Save' : 'Create')));
  fill(dlg, form);
  sync();
  dlg.showModal();
}
