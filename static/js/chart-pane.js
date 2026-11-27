// One chart: main series + volume + indicators + drawings + legend, bound to one feed
// subscription. Also handles chart type, price-scale mode, time zone, compare symbols,
// session shading/breaks, bar-close countdown and previous-close / day high-low lines.

import * as LWC from '/vendor/lightweight-charts.mjs';
import { DrawingManager } from './drawings/manager.js';
import { logicalToX } from './drawings/geometry.js';
import { StudyHost } from './scripts/studies.js';
import { THEMES, parseSessions, settings, tzLabel, tzOffset } from './settings.js';
import { el, fmtVol, precisionFor, fill } from './util.js';

const UP = '#26a69a', DOWN = '#ef5350';
const COMPARE_COLORS = ['#ff9800', '#e040fb', '#00bcd4', '#ffeb3b', '#8bc34a'];
let nextId = 1;

export const CHART_TYPES = {
  candles: 'Candles', hollow: 'Hollow candles', ha: 'Heikin Ashi', bars: 'Bars (OHLC)', line: 'Line', area: 'Area', baseline: 'Baseline',
};
const OHLC_TYPES = new Set(['candles', 'hollow', 'ha', 'bars']);

export class ChartPane {
  /**
   * @param {HTMLElement} container
   * @param {import('./feed.js').Feed} feed
   * @param {object} state  { symbol, tf, rth, studies, chartType, scale, compares }
   * @param {object} hooks  onStatus, onChange, onLoad, onStudySettings, onDrawingAlert, onTimeZoneMenu, onLegend
   */
  constructor(container, feed, state, hooks = {}) {
    this.id = `pane${nextId++}`;
    this.feed = feed;
    this.state = { symbol: 'AAPL', tf: '5m', rth: false, chartType: 'candles', compares: [], ...state };
    this.state.scale = { mode: 'normal', invert: false, ...this.state.scale };
    this.state.studies = migrateStudies(this.state);
    delete this.state.ind;
    this.hooks = hooks;
    this.data = { bars: [], intraday: true, hasVolume: true, symbol: '', description: '', info: null, precision: 2, sessions: [] };
    this.compareSeries = new Map(); // symbol -> { series, last, shift, error }
    this.hovering = false;

    this.root = el('div', { class: 'pane' });
    this.legend = el('div', { class: 'legend' },
      el('div', { class: 'legend-title' }, el('span', { class: 'legend-symbol' }), ' ', el('span', { class: 'legend-desc' })),
      el('div', { class: 'legend-ohlc' }),
      el('div', { class: 'legend-compares' }));
    this.chartEl = el('div', { class: 'chart' });
    this.corner = el('div', { class: 'pane-corner' });
    this.root.append(this.legend, this.chartEl, this.corner);
    container.append(this.root);

    const t = THEMES[settings.theme] || THEMES.dark;
    this.chart = LWC.createChart(this.chartEl, {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: t.bg }, textColor: t.text, fontSize: 12,
        attributionLogo: false, // credited in the toolbar instead (see README)
        panes: { separatorColor: t.border, separatorHoverColor: t.border },
      },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: false, rightOffset: 8 },
      localization: { timeFormatter: (time) => this.formatTime(time) },
    });
    this.volume = this.chart.addSeries(LWC.HistogramSeries, {
      priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false,
    });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    this.candles = this.createMainSeries(this.state.chartType);

    this.sessionLayer = new SessionLayer(this);
    this.infoLayer = new InfoLayer(this);
    this.profileLayer = new VolumeProfileLayer(this);
    this.candles.attachPrimitive(this.sessionLayer);
    this.candles.attachPrimitive(this.infoLayer);
    this.candles.attachPrimitive(this.profileLayer);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.profileLayer.invalidate());
    this.drawings = new DrawingManager(this);
    this.studies = new StudyHost(this);
    this.studies.setConfigs(this.state.studies);
    this.buildCorner();
    this.applyScale();

    this.chart.subscribeCrosshairMove((p) => {
      const has = p.time !== undefined && p.seriesData.get(this.candles);
      this.hovering = !!has;
      this.updateLegend(has ? this.barAtOrBefore(p.time) : null);
    });

    this.subscribe();
  }

  // ---------- public API ----------
  setSymbol(symbol) { this.state.symbol = symbol.trim().toUpperCase(); this.subscribe(); }
  setTimeframe(tf) { this.state.tf = tf; this.subscribe(); }
  setRth(rth) { this.state.rth = rth; this.subscribe(); }
  addStudy(ref, inputs) { return this.studies.add(ref, inputs); }

  destroy() {
    this.feed.unsubscribe(this.id);
    for (const sym of this.compareSeries.keys()) this.feed.unsubscribe(`${this.id}:cmp:${sym}`);
    clearInterval(this.infoLayer.timer);
    this.studies.dispose();
    this.drawings.dispose?.();
    this.chart.remove();
    this.root.remove();
  }

  /** Last bar at or before a chart time (linked crosshairs, legend). */
  barAtOrBefore(time) {
    const b = this.data.bars;
    let lo = 0, hi = b.length - 1, ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (b[mid].time <= time) { ans = b[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /** Dashed lines for this symbol's price alerts. */
  setAlertLevels(levels) {
    this.alertLevels = levels;
    for (const l of this.alertLines || []) this.candles.removePriceLine(l);
    this.alertLines = levels.map((price) => this.candles.createPriceLine({
      price, color: '#ff9800', lineStyle: LWC.LineStyle.LargeDashed, lineWidth: 1, axisLabelVisible: true, title: '⏰',
    }));
  }

  /** Your average cost as a price line (positions panel). */
  setPositionLine(pos) {
    if (this.posLine) this.candles.removePriceLine(this.posLine);
    this.posLine = null;
    this.position = pos;
    if (pos) {
      this.posLine = this.candles.createPriceLine({
        price: pos.price, color: '#2962ff', lineStyle: LWC.LineStyle.Solid, lineWidth: 1, axisLabelVisible: true,
        title: `${pos.qty > 0 ? 'Long' : 'Short'} ${Math.abs(pos.qty)}`,
      });
    }
  }

  /** Markers that aren't from indicators (fills, earnings), merged into the chart's markers. */
  setExtraMarkers(kind, markers) {
    this.extraMarkers = { ...this.extraMarkers, [kind]: markers };
    this.studies.refreshData();
  }

  studiesChanged() {
    this.state.studies = this.studies.configs();
    this.changed();
  }

  // ---------- chart type ----------

  createMainSeries(type) {
    const pf = { type: 'price', precision: this.data.precision, minMove: 10 ** -this.data.precision };
    switch (type) {
      case 'hollow':
        return this.chart.addSeries(LWC.CandlestickSeries, {
          upColor: 'rgba(0,0,0,0)', downColor: DOWN, borderVisible: true, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, priceFormat: pf,
        });
      case 'bars':
        return this.chart.addSeries(LWC.BarSeries, { upColor: UP, downColor: DOWN, thinBars: false, priceFormat: pf });
      case 'line':
        return this.chart.addSeries(LWC.LineSeries, { color: '#2962ff', lineWidth: 2, priceFormat: pf });
      case 'area':
        return this.chart.addSeries(LWC.AreaSeries, { lineColor: '#2962ff', topColor: 'rgba(41,98,255,.35)', bottomColor: 'rgba(41,98,255,0)', lineWidth: 2, priceFormat: pf });
      case 'baseline':
        return this.chart.addSeries(LWC.BaselineSeries, { baseValue: { type: 'price', price: 0 }, lineWidth: 2, priceFormat: pf });
      default: // candles, ha
        return this.chart.addSeries(LWC.CandlestickSeries, { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN, priceFormat: pf });
    }
  }

  setChartType(type) {
    if (!CHART_TYPES[type] || type === this.state.chartType) return;
    this.state.chartType = type;
    const old = this.candles;
    this.candles = this.createMainSeries(type);
    for (const prim of [this.sessionLayer, this.infoLayer, this.profileLayer, this.drawings.layer]) {
      old.detachPrimitive(prim);
      this.candles.attachPrimitive(prim);
    }
    this.drawings.series = this.candles;
    this.studies.reattachMarkers();
    for (const l of [...(this.alertLines || []), ...(this.refLines || []), ...(this.posLine ? [this.posLine] : [])]) old.removePriceLine(l);
    this.alertLines = this.refLines = [];
    this.posLine = null;
    this.chart.removeSeries(old);
    this.renderMain();
    this.setAlertLevels(this.alertLevels || []);
    this.setPositionLine(this.position);
    this.updateRefLines();
    this.changed();
  }

  mainData(bars) {
    const type = this.state.chartType;
    if (type === 'ha') return heikinAshi(bars);
    if (OHLC_TYPES.has(type)) return bars;
    return bars.map((b) => ({ time: b.time, value: b.close }));
  }

  renderMain() {
    const bars = this.data.bars;
    this.candles.setData(this.mainData(bars));
    if (this.state.chartType === 'baseline' && bars.length) {
      const visible = bars.slice(-150);
      const mid = (Math.max(...visible.map((b) => b.high)) + Math.min(...visible.map((b) => b.low))) / 2;
      this.candles.applyOptions({ baseValue: { type: 'price', price: mid } });
    }
  }

  // ---------- price scale ----------

  applyScale() {
    const s = this.state.scale;
    const modes = { normal: LWC.PriceScaleMode.Normal, log: LWC.PriceScaleMode.Logarithmic, percent: LWC.PriceScaleMode.Percentage, indexed: LWC.PriceScaleMode.IndexedTo100 };
    // Comparing symbols only makes sense in percent.
    const mode = this.compareSeries.size ? LWC.PriceScaleMode.Percentage : modes[s.mode] ?? LWC.PriceScaleMode.Normal;
    this.chart.priceScale('right').applyOptions({ mode, invertScale: !!s.invert, autoScale: true });
    this.syncCorner();
  }

  setScale(patch) {
    Object.assign(this.state.scale, patch);
    this.applyScale();
    this.changed();
  }

  /** Small controls in the bottom-right corner: time zone, %, log, invert, auto. */
  buildCorner() {
    const btn = (label, title, onclick) => el('button', { title, onclick }, label);
    this.cornerBtns = {
      tz: btn('', 'Time zone', (e) => this.hooks.onTimeZoneMenu?.(e.currentTarget)),
      pct: btn('%', 'Percent scale', () => this.setScale({ mode: this.state.scale.mode === 'percent' ? 'normal' : 'percent' })),
      log: btn('log', 'Logarithmic scale', () => this.setScale({ mode: this.state.scale.mode === 'log' ? 'normal' : 'log' })),
      inv: btn('⇅', 'Invert scale', () => this.setScale({ invert: !this.state.scale.invert })),
      auto: btn('auto', 'Fit the price scale to the data', () => this.chart.priceScale('right').applyOptions({ autoScale: true })),
    };
    this.corner.append(...Object.values(this.cornerBtns));
  }

  syncCorner() {
    if (!this.cornerBtns) return;
    const s = this.state.scale;
    this.cornerBtns.tz.textContent = tzLabel(settings.tz, this.data.info?.timeZone).replace(/ \(.*\)/, '');
    this.cornerBtns.pct.classList.toggle('on', s.mode === 'percent' || this.compareSeries.size > 0);
    this.cornerBtns.log.classList.toggle('on', s.mode === 'log');
    this.cornerBtns.inv.classList.toggle('on', !!s.invert);
  }

  // ---------- time ----------

  get tz() { return settings.tz === 'exchange' ? this.data.info?.timeZone || 'local' : settings.tz; }

  /** IB sends UTC; Lightweight Charts has no time zones, so intraday bars are shifted to the chosen zone. */
  toChartTime(t) {
    return this.data.intraday ? t + tzOffset(this.tz, t) : t;
  }

  fromChartTime(t) {
    return this.data.intraday ? t - tzOffset(this.tz, t - tzOffset(this.tz, t)) : t;
  }

  formatTime(time) {
    const d = new Date(time * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return this.data.intraday ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : date;
  }

  // ---------- data ----------

  subscribe() {
    const { symbol, tf, rth } = this.state;
    this.feed.subscribe(this.id, { symbol, tf, rth }, (m) => this.onMessage(m));
    for (const c of this.state.compares) this.subscribeCompare(c);
    this.changed();
  }

  changed() { this.hooks.onChange?.(this); }
  status(text, kind = '') { this.hooks.onStatus?.(this, text, kind); }

  onMessage(m) {
    switch (m.type) {
      case 'status': this.status(m.message); break;
      case 'error': this.status(m.message, 'err'); break;
      case 'ended': this.status('Stream ended — resubscribing…', 'err'); break;
      case 'history': this.onHistory(m); break;
      case 'bar': this.onBar(m.bar); break;
    }
  }

  onHistory(m) {
    if (this.replay) { clearInterval(this.replay.timer); this.replay = null; this.hooks.onReplay?.(this); }
    const d = this.data;
    Object.assign(d, { intraday: m.intraday, hasVolume: m.hasVolume, symbol: m.symbol, description: m.description, info: m.info });
    d.bars = m.bars.map((b) => ({ ...b, time: this.toChartTime(b.time) }));
    d.precision = precisionFor(m.minTick);
    d.sessions = m.intraday && m.info?.liquidHours?.length ? parseSessions(m.info.liquidHours, m.info.timeZone) : [];
    this.candles.applyOptions({ priceFormat: { type: 'price', precision: d.precision, minMove: 10 ** -d.precision } });
    this.renderMain();
    this.volume.setData(d.hasVolume ? d.bars.map(volBar) : []);
    this.updateLegend();
    this.updateRefLines();
    this.chart.timeScale().applyOptions({ timeVisible: m.intraday, secondsVisible: /s$/.test(this.state.tf) });
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, d.bars.length - 150), to: d.bars.length + 8 });
    this.syncCorner();
    this.status(`${m.symbol} ${this.state.tf} · live`, 'live');
    this.drawings.setBars(d.bars, m.info?.key ?? m.symbol);
    this.studies.runAll(true);
    this.hooks.onLoad?.(this);
  }

  onBar(raw) {
    if (this.replay) { this.replay.pending.push(raw); return; } // live bars wait until replay ends
    const bar = { ...raw, time: this.toChartTime(raw.time) };
    const bars = this.data.bars;
    const last = bars[bars.length - 1];
    if (last && bar.time < last.time) return; // stale
    const isNew = !last || bar.time !== last.time;
    if (isNew) bars.push(bar); else bars[bars.length - 1] = bar;
    this.drawings.onBar(bar);
    const type = this.state.chartType;
    if (type === 'ha') this.candles.update(heikinAshi(bars.slice(-300)).at(-1));
    else this.candles.update(OHLC_TYPES.has(type) ? bar : { time: bar.time, value: bar.close });
    if (this.data.hasVolume) this.volume.update(volBar(bar));
    this.studies.onBar();
    if (isNew || bar.high > this.dayHigh || bar.low < this.dayLow) this.updateRefLines();
    this.profileLayer.invalidate();
    if (!this.hovering) this.updateLegend();
  }

  // ---------- bar replay ----------

  /** Starts replaying from bar `index` (hides everything after it). */
  startReplay(index) {
    const all = this.replay?.all || this.data.bars;
    index = Math.max(10, Math.min(all.length - 1, index));
    this.replay = { all, index, pending: this.replay?.pending || [], playing: false, speed: this.replay?.speed || 1 };
    this.showReplayBars();
    this.hooks.onReplay?.(this);
  }

  showReplayBars() {
    const r = this.replay;
    this.data.bars = r.all.slice(0, r.index + 1);
    this.renderMain();
    this.volume.setData(this.data.hasVolume ? this.data.bars.map(volBar) : []);
    this.drawings.mapper.setTimes(this.data.bars.map((b) => b.time));
    this.studies.runAll(false);
    this.updateRefLines();
    this.profileLayer.invalidate();
    this.updateLegend();
  }

  replayStep(n = 1) {
    const r = this.replay;
    if (!r) return;
    if (r.index >= r.all.length - 1) { this.replayPlay(false); return; }
    r.index = Math.min(r.all.length - 1, r.index + n);
    const bar = r.all[r.index];
    this.data.bars.push(bar);
    this.candles.update(this.state.chartType === 'ha' ? heikinAshi(this.data.bars.slice(-300)).at(-1) : OHLC_TYPES.has(this.state.chartType) ? bar : { time: bar.time, value: bar.close });
    if (this.data.hasVolume) this.volume.update(volBar(bar));
    this.drawings.mapper.update(bar.time);
    this.studies.onBar();
    this.profileLayer.invalidate();
    this.updateLegend();
    this.hooks.onReplay?.(this);
  }

  replayPlay(on) {
    const r = this.replay;
    if (!r) return;
    r.playing = on;
    clearInterval(r.timer);
    if (on) r.timer = setInterval(() => this.replayStep(), 1000 / r.speed);
    this.hooks.onReplay?.(this);
  }

  replaySpeed(speed) {
    if (!this.replay) return;
    this.replay.speed = speed;
    if (this.replay.playing) this.replayPlay(true);
  }

  stopReplay() {
    const r = this.replay;
    if (!r) return;
    clearInterval(r.timer);
    this.replay = null;
    this.data.bars = r.all;
    this.showLive(r.pending);
    this.hooks.onReplay?.(this);
  }

  showLive(pending) {
    this.renderMain();
    this.volume.setData(this.data.hasVolume ? this.data.bars.map(volBar) : []);
    this.drawings.mapper.setTimes(this.data.bars.map((b) => b.time));
    for (const raw of pending) this.onBar(raw);
    this.studies.runAll(false);
    this.updateRefLines();
    this.profileLayer.invalidate();
    this.updateLegend();
  }

  // ---------- compare symbols ----------

  addCompare(symbol) {
    symbol = symbol.trim().toUpperCase();
    if (!symbol || symbol === this.state.symbol || this.state.compares.some((c) => c.symbol === symbol)) return;
    const used = new Set(this.state.compares.map((c) => c.color));
    const c = { symbol, color: COMPARE_COLORS.find((x) => !used.has(x)) || COMPARE_COLORS[0] };
    this.state.compares.push(c);
    this.subscribeCompare(c);
    this.changed();
  }

  removeCompare(symbol) {
    this.state.compares = this.state.compares.filter((c) => c.symbol !== symbol);
    const cs = this.compareSeries.get(symbol);
    if (cs) this.chart.removeSeries(cs.series);
    this.compareSeries.delete(symbol);
    this.feed.unsubscribe(`${this.id}:cmp:${symbol}`);
    this.applyScale();
    this.renderCompareLegend();
    this.changed();
  }

  subscribeCompare(c) {
    if (!this.compareSeries.has(c.symbol)) {
      const series = this.chart.addSeries(LWC.LineSeries, { color: c.color, lineWidth: 2, priceLineVisible: false, crosshairMarkerVisible: false });
      this.compareSeries.set(c.symbol, { series, last: null });
      this.applyScale();
    }
    const { tf, rth } = this.state;
    this.feed.subscribe(`${this.id}:cmp:${c.symbol}`, { symbol: c.symbol, tf, rth }, (m) => {
      const cs = this.compareSeries.get(c.symbol);
      if (!cs) return;
      if (m.type === 'history') {
        const shift = (t) => (m.intraday ? t + tzOffset(this.tz, t) : t);
        cs.series.setData(m.bars.map((b) => ({ time: shift(b.time), value: b.close })));
        cs.last = m.bars.at(-1)?.close ?? null;
        cs.shift = shift;
        cs.error = null;
      } else if (m.type === 'bar' && cs.shift) {
        cs.series.update({ time: cs.shift(m.bar.time), value: m.bar.close });
        cs.last = m.bar.close;
      } else if (m.type === 'error') {
        cs.error = m.message;
      }
      this.renderCompareLegend();
    });
    this.renderCompareLegend();
  }

  renderCompareLegend() {
    const box = this.legend.querySelector('.legend-compares');
    fill(box, ...this.state.compares.map((c) => {
      const cs = this.compareSeries.get(c.symbol);
      return el('div', { class: 'legend-line' },
        el('span', { class: 'obj-dot', style: `background:${c.color}` }),
        el('span', { class: 'lt' }, c.symbol),
        cs?.error ? el('span', { class: 'lerr', title: cs.error }, '⚠ ' + cs.error) : el('span', { class: 'lv', style: `color:${c.color}` }, cs?.last != null ? String(cs.last) : '…'),
        el('span', { class: 'lbtns' }, el('button', { title: 'Remove', onclick: () => this.removeCompare(c.symbol) }, '×')));
    }));
  }

  // ---------- previous close / day high-low ----------

  updateRefLines() {
    for (const l of this.refLines || []) this.candles.removePriceLine(l);
    this.refLines = [];
    const bars = this.data.bars;
    if (!bars.length || !this.data.intraday) return;
    const day = (b) => Math.floor(b.time / 86400);
    const today = day(bars[bars.length - 1]);
    let i = bars.length - 1;
    while (i >= 0 && day(bars[i]) === today) i--;
    const todays = bars.slice(i + 1);
    this.dayHigh = Math.max(...todays.map((b) => b.high));
    this.dayLow = Math.min(...todays.map((b) => b.low));
    const line = (price, title, color) => this.candles.createPriceLine({ price, title, color, lineStyle: LWC.LineStyle.Dotted, lineWidth: 1, axisLabelVisible: true });
    if (settings.prevClose && i >= 0) this.refLines.push(line(bars[i].close, 'Prev close', '#787b86'));
    if (settings.dayHighLow) this.refLines.push(line(this.dayHigh, 'H', '#26a69a'), line(this.dayLow, 'L', '#ef5350'));
  }

  // ---------- theme / settings ----------

  applyTheme() {
    const t = THEMES[settings.theme] || THEMES.dark;
    this.chart.applyOptions({
      layout: { background: { type: 'solid', color: t.bg }, textColor: t.text, panes: { separatorColor: t.border, separatorHoverColor: t.border } },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
    this.sessionLayer.requestUpdate?.();
  }

  /** App settings changed (theme, time zone, overlays). */
  onSettings(key) {
    if (key === 'theme') this.applyTheme();
    else if (key === 'tz') { this.syncCorner(); this.subscribe(); }
    else if (key === 'prevClose' || key === 'dayHighLow') this.updateRefLines();
    else if (key === 'volumeProfile') this.profileLayer.invalidate();
    else this.sessionLayer.requestUpdate?.();
  }

  // ---------- legend ----------

  updateLegend(bar) {
    const { bars, precision, hasVolume } = this.data;
    bar = bar || bars[bars.length - 1];
    this.legend.querySelector('.legend-symbol').textContent = this.data.symbol;
    this.legend.querySelector('.legend-desc').textContent = this.data.description;
    const ohlc = this.legend.querySelector('.legend-ohlc');
    if (!bar) { fill(ohlc, ); return; }
    const i = bars.indexOf(bar);
    const prev = i > 0 ? bars[i - 1].close : bar.open;
    const chg = bar.close - prev, pct = prev ? (chg / prev) * 100 : 0;
    const cls = chg >= 0 ? 'up' : 'down';
    const f = (v) => v.toFixed(precision);
    const kv = (k, v) => [el('span', { class: 'k' }, k), ' ', el('span', { class: cls }, f(v))];
    fill(ohlc, 
      ...kv('O', bar.open), ...kv('H', bar.high), ...kv('L', bar.low), ...kv('C', bar.close), ' ',
      el('span', { class: cls }, `${chg >= 0 ? '+' : ''}${f(chg)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`),
      ...(hasVolume && bar.volume != null ? [' ', el('span', { class: 'k' }, 'V'), ' ', fmtVol(bar.volume)] : []),
    );
    this.hooks.onLegend?.(this, bar);
  }
}

// ---------- session shading & breaks (drawn behind the series) ----------

class SessionLayer {
  constructor(pane) {
    this.pane = pane;
    this.view = { zOrder: () => 'bottom', renderer: () => ({ draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.draw(context, mediaSize)) }) };
  }
  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() {}
  updateAllViews() {}
  paneViews() { return [this.view]; }

  draw(ctx, size) {
    const p = this.pane, bars = p.data.bars;
    if (!p.data.intraday || bars.length < 2) return;
    const ts = p.chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const from = Math.max(0, Math.floor(range.from) - 1), to = Math.min(bars.length - 1, Math.ceil(range.to) + 1);
    const spacing = (logicalToX(ts, 1) ?? 0) - (logicalToX(ts, 0) ?? 0);
    const t = THEMES[settings.theme] || THEMES.dark;
    const sessions = p.data.sessions;

    if (settings.sessionShading && sessions.length && !p.state.rth) {
      ctx.fillStyle = t.shade;
      const inSession = (b) => {
        const u = p.fromChartTime(b.time);
        return sessions.some(([s, e]) => u >= s && u < e);
      };
      let runStart = null;
      for (let i = from; i <= to + 1; i++) {
        const out = i <= to && !inSession(bars[i]);
        if (out && runStart === null) runStart = i;
        if (!out && runStart !== null) {
          const x0 = logicalToX(ts, runStart) - spacing / 2, x1 = logicalToX(ts, i - 1) + spacing / 2;
          ctx.fillRect(x0, 0, x1 - x0, size.height);
          runStart = null;
        }
      }
    }
    if (settings.sessionBreaks) {
      ctx.strokeStyle = t.break;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      for (let i = Math.max(1, from); i <= to; i++) {
        if (Math.floor(bars[i].time / 86400) !== Math.floor(bars[i - 1].time / 86400)) {
          const x = Math.round(logicalToX(ts, i) - spacing / 2) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, size.height);
          ctx.stroke();
        }
      }
    }
  }
}

// ---------- visible-range volume profile ----------

class VolumeProfileLayer {
  constructor(pane) {
    this.pane = pane;
    this.view = { zOrder: () => 'bottom', renderer: () => ({ draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.draw(context, mediaSize)) }) };
  }
  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() {}
  updateAllViews() {}
  paneViews() { return [this.view]; }
  invalidate() { this.cache = null; if (settings.volumeProfile) this.requestUpdate?.(); }

  /** Volume by price over the visible bars (each bar's volume spread over its high-low range). */
  compute() {
    const p = this.pane, bars = p.data.bars;
    const range = p.chart.timeScale().getVisibleLogicalRange();
    if (!range || !p.data.hasVolume) return null;
    const vis = bars.slice(Math.max(0, Math.floor(range.from)), Math.min(bars.length, Math.ceil(range.to) + 1));
    if (vis.length < 2) return null;
    const lo = Math.min(...vis.map((b) => b.low)), hi = Math.max(...vis.map((b) => b.high));
    if (!(hi > lo)) return null;
    const rows = 32, step = (hi - lo) / rows;
    const up = new Float64Array(rows), down = new Float64Array(rows);
    for (const b of vis) {
      const v = b.volume || 0;
      const a = Math.max(0, Math.floor((b.low - lo) / step)), z = Math.min(rows - 1, Math.floor((b.high - lo) / step));
      const share = v / (z - a + 1);
      for (let i = a; i <= z; i++) (b.close >= b.open ? up : down)[i] += share;
    }
    const total = up.map((u, i) => u + down[i]);
    const poc = total.indexOf(Math.max(...total));
    // Value area: grow around the POC until 70% of volume is covered.
    const sum = total.reduce((x, y) => x + y, 0);
    let va = total[poc], a = poc, z = poc;
    while (va < sum * 0.7 && (a > 0 || z < rows - 1)) {
      const below = a > 0 ? total[a - 1] : -1, above = z < rows - 1 ? total[z + 1] : -1;
      if (above >= below) va += total[++z]; else va += total[--a];
    }
    return { lo, step, rows, up, down, total, poc, va: [a, z], max: total[poc] };
  }

  draw(ctx, size) {
    if (!settings.volumeProfile) return;
    this.cache ||= this.compute();
    const c = this.cache;
    if (!c) return;
    const width = Math.min(220, size.width * 0.25);
    const s = this.pane.candles;
    for (let i = 0; i < c.rows; i++) {
      const y1 = s.priceToCoordinate(c.lo + i * c.step), y2 = s.priceToCoordinate(c.lo + (i + 1) * c.step);
      if (y1 == null || y2 == null) continue;
      const h = Math.max(1, Math.abs(y1 - y2) - 1), top = Math.min(y1, y2);
      const inVa = i >= c.va[0] && i <= c.va[1];
      const wUp = (c.up[i] / c.max) * width, wDown = (c.down[i] / c.max) * width;
      const x = size.width - wUp - wDown;
      ctx.fillStyle = inVa ? 'rgba(38,166,154,.38)' : 'rgba(38,166,154,.16)';
      ctx.fillRect(x, top, wUp, h);
      ctx.fillStyle = inVa ? 'rgba(239,83,80,.38)' : 'rgba(239,83,80,.16)';
      ctx.fillRect(x + wUp, top, wDown, h);
      if (i === c.poc) {
        ctx.fillStyle = 'rgba(255,152,0,.9)';
        ctx.fillRect(0, top + h / 2, size.width, 1);
      }
    }
  }
}

// ---------- bar-close countdown on the price scale ----------

class InfoLayer {
  constructor(pane) {
    this.pane = pane;
    this.timer = setInterval(() => { if (settings.countdown && pane.data.intraday) this.requestUpdate?.(); }, 1000);
  }
  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() {}
  updateAllViews() {}
  priceAxisViews() {
    const p = this.pane, last = p.data.bars.at(-1);
    if (!settings.countdown || !last || !p.data.intraday) return [];
    const secs = tfSeconds(p.state.tf);
    const end = p.fromChartTime(last.time) + secs;
    let left = Math.round(end - Date.now() / 1000);
    if (left < 0 || left > secs) return [];
    const h = Math.floor(left / 3600);
    left %= 3600;
    const text = `${h ? h + ':' : ''}${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    const y = p.candles.priceToCoordinate(last.close);
    if (y == null) return [];
    const color = last.close >= last.open ? UP : DOWN;
    return [{ coordinate: () => y + 18, text: () => text, textColor: () => '#fff', backColor: () => color, visible: () => true, tickVisible: () => false }];
  }
}

export function tfSeconds(tf) {
  const m = /^(\d+)([smhDWM])$/.exec(tf);
  if (!m) return 60;
  return +m[1] * { s: 1, m: 60, h: 3600, D: 86400, W: 604800, M: 2592000 }[m[2]];
}

// ---------- helpers ----------

export function heikinAshi(bars) {
  const out = [];
  let prev = null;
  for (const b of bars) {
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = prev ? (prev.open + prev.close) / 2 : (b.open + b.close) / 2;
    const ha = { time: b.time, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close) };
    out.push(ha);
    prev = ha;
  }
  return out;
}

/** Converts the old fixed indicator toggles (`ind: {sma20: true}`) into script studies. */
function migrateStudies(state) {
  if (Array.isArray(state.studies)) return state.studies;
  const map = {
    sma20: ['builtin:SMA', { Length: 20 }],
    sma50: ['builtin:SMA', { Length: 50, Color: '#2196f3' }],
    ema200: ['builtin:EMA', { Length: 200 }],
    vwap: ['builtin:VWAP', {}],
    rsi: ['builtin:RSI', {}],
  };
  return Object.entries(state.ind || { sma20: true })
    .filter(([id, on]) => on && map[id])
    .map(([id], i) => ({ uid: `m${Date.now()}${i}`, ref: map[id][0], inputs: map[id][1], hidden: false }));
}

function volBar(b) {
  return { time: b.time, value: b.volume ?? 0, color: b.close >= b.open ? 'rgba(38,166,154,.45)' : 'rgba(239,83,80,.45)' };
}
