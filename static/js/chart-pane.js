// One chart: candles + volume + indicators + legend, bound to one feed subscription.

import * as LWC from '/vendor/lightweight-charts.mjs';
import { DrawingManager } from './drawings/manager.js';
import { BUILTINS } from './indicators.js';
import { el, fmtVol, precisionFor } from './util.js';

const UP = '#26a69a', DOWN = '#ef5350';
let nextId = 1;

export class ChartPane {
  /**
   * @param {HTMLElement} container
   * @param {import('./feed.js').Feed} feed
   * @param {{symbol:string, tf:string, rth:boolean, ind:Object<string,boolean>}} state
   * @param {{onStatus?:Function, onChange?:Function, onLoad?:Function}} hooks
   */
  constructor(container, feed, state, hooks = {}) {
    this.id = `pane${nextId++}`;
    this.feed = feed;
    this.state = { symbol: 'AAPL', tf: '5m', rth: false, ind: {}, ...state };
    this.hooks = hooks;
    this.data = { bars: [], intraday: true, hasVolume: true, symbol: '', description: '', info: null, precision: 2 };
    this.lines = {};
    this.hovering = false;

    this.root = el('div', { class: 'pane' });
    this.legend = el('div', { class: 'legend' },
      el('div', { class: 'legend-title' }, el('span', { class: 'legend-symbol' }), ' ', el('span', { class: 'legend-desc' })),
      el('div', { class: 'legend-ohlc' }));
    this.chartEl = el('div', { class: 'chart' });
    this.root.append(this.legend, this.chartEl);
    container.append(this.root);

    this.chart = LWC.createChart(this.chartEl, {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: '#131722' },
        textColor: '#d1d4dc',
        fontSize: 12,
        attributionLogo: false, // credited in the toolbar instead (see README)
        panes: { separatorColor: '#2a2e39', separatorHoverColor: '#2a2e39' },
      },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false, rightOffset: 8 },
    });
    this.candles = this.chart.addSeries(LWC.CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
    });
    this.volume = this.chart.addSeries(LWC.HistogramSeries, {
      priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false,
    });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    this.drawings = new DrawingManager(this);

    this.chart.subscribeCrosshairMove((p) => {
      const d = p.time !== undefined ? p.seriesData.get(this.candles) : null;
      this.hovering = !!d;
      this.updateLegend(d ? this.data.bars.find((b) => b.time === d.time) || d : null);
    });

    this.subscribe();
  }

  // ---------- public API ----------
  setSymbol(symbol) { this.state.symbol = symbol.trim().toUpperCase(); this.subscribe(); }
  setTimeframe(tf) { this.state.tf = tf; this.subscribe(); }
  setRth(rth) { this.state.rth = rth; this.subscribe(); }
  toggleIndicator(id) {
    this.state.ind[id] = !this.state.ind[id];
    this.renderIndicator(id);
    this.changed();
  }
  destroy() {
    this.feed.unsubscribe(this.id);
    this.chart.remove();
    this.root.remove();
  }

  // ---------- data ----------
  subscribe() {
    const { symbol, tf, rth } = this.state;
    this.feed.subscribe(this.id, { symbol, tf, rth }, (m) => this.onMessage(m));
    this.changed();
  }

  changed() { this.hooks.onChange?.(this); }
  status(text, kind = '') { this.hooks.onStatus?.(this, text, kind); }

  /** IB sends UTC; Lightweight Charts has no time zones, so shift intraday bars to local time. */
  toChartTime(t) {
    return this.data.intraday ? t - new Date(t * 1000).getTimezoneOffset() * 60 : t;
  }

  /** Inverse of toChartTime. */
  fromChartTime(t) {
    return this.data.intraday ? t + new Date(t * 1000).getTimezoneOffset() * 60 : t;
  }

  indicatorLabel(id) { return BUILTINS[id]?.label ?? id; }
  indicatorColor(id) { return BUILTINS[id]?.color ?? '#787b86'; }

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
    const d = this.data;
    Object.assign(d, { intraday: m.intraday, hasVolume: m.hasVolume, symbol: m.symbol, description: m.description, info: m.info });
    d.bars = m.bars.map((b) => ({ ...b, time: this.toChartTime(b.time) }));
    d.precision = precisionFor(m.minTick);
    this.candles.applyOptions({ priceFormat: { type: 'price', precision: d.precision, minMove: 10 ** -d.precision } });
    this.renderAll();
    this.chart.timeScale().applyOptions({ timeVisible: m.intraday });
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, d.bars.length - 150), to: d.bars.length + 8 });
    this.status(`${m.symbol} ${this.state.tf} · live`, 'live');
    this.drawings.setBars(d.bars, m.info?.key ?? m.symbol);
    this.hooks.onLoad?.(this);
  }

  onBar(raw) {
    const bar = { ...raw, time: this.toChartTime(raw.time) };
    const bars = this.data.bars;
    const last = bars[bars.length - 1];
    if (last && bar.time < last.time) return; // stale
    if (last && bar.time === last.time) bars[bars.length - 1] = bar; else bars.push(bar);
    this.drawings.onBar(bar);

    this.candles.update(bar);
    if (this.data.hasVolume) this.volume.update(volBar(bar));
    const tail = bars.slice(-400); // indicators only change at the end
    for (const id of Object.keys(this.lines)) {
      const def = BUILTINS[id];
      const pts = def.calc(def.fullHistory ? bars : tail, this.data);
      if (pts.length) this.lines[id].update(pts[pts.length - 1]);
    }
    if (!this.hovering) this.updateLegend();
  }

  // ---------- rendering ----------
  renderAll() {
    const b = this.data.bars;
    this.candles.setData(b);
    this.volume.setData(this.data.hasVolume ? b.map(volBar) : []);
    for (const id of Object.keys(BUILTINS)) this.renderIndicator(id);
    this.updateLegend();
  }

  renderIndicator(id) {
    const def = BUILTINS[id];
    if (!this.state.ind[id]) {
      if (this.lines[id]) { this.chart.removeSeries(this.lines[id]); delete this.lines[id]; }
      return;
    }
    if (!this.lines[id]) {
      const s = this.chart.addSeries(LWC.LineSeries, {
        color: def.color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true,
        crosshairMarkerVisible: false, title: def.label,
      }, def.pane || 0);
      for (const price of def.levels || []) {
        s.createPriceLine({ price, color: '#787b86', lineStyle: LWC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      }
      if (def.pane) this.chart.panes()[def.pane]?.setHeight(140);
      this.lines[id] = s;
    }
    this.lines[id].setData(def.calc(this.data.bars, this.data));
  }

  updateLegend(bar) {
    const { bars, precision, hasVolume } = this.data;
    bar = bar || bars[bars.length - 1];
    this.legend.querySelector('.legend-symbol').textContent = this.data.symbol;
    this.legend.querySelector('.legend-desc').textContent = this.data.description;
    const ohlc = this.legend.querySelector('.legend-ohlc');
    if (!bar) { ohlc.replaceChildren(); return; }
    const i = bars.findIndex((b) => b.time === bar.time);
    const prev = i > 0 ? bars[i - 1].close : bar.open;
    const chg = bar.close - prev, pct = prev ? (chg / prev) * 100 : 0;
    const cls = chg >= 0 ? 'up' : 'down';
    const f = (v) => v.toFixed(precision);
    const kv = (k, v) => [el('span', { class: 'k' }, k), ' ', el('span', { class: cls }, f(v))];
    ohlc.replaceChildren(
      ...kv('O', bar.open), ...kv('H', bar.high), ...kv('L', bar.low), ...kv('C', bar.close), ' ',
      el('span', { class: cls }, `${chg >= 0 ? '+' : ''}${f(chg)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`),
      ...(hasVolume && bar.volume != null ? [' ', el('span', { class: 'k' }, 'V'), ' ', fmtVol(bar.volume)] : []),
    );
  }
}

function volBar(b) {
  return { time: b.time, value: b.volume ?? 0, color: b.close >= b.open ? 'rgba(38,166,154,.45)' : 'rgba(239,83,80,.45)' };
}
