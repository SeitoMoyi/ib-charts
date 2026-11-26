// Indicator instances ("studies") on one chart: running scripts in workers and
// turning their output into chart series, markers, levels and legends.

import * as LWC from '/vendor/lightweight-charts.mjs';
import * as api from '../api.js';
import { el } from '../util.js';

const TIMEOUT_MS = 3000;
const RERUN_MS = 750; // live updates: rerun at most this often
let uidSeq = Date.now();

// ---------- script sources ----------

const codeCache = new Map(); // ref -> code

/** `builtin:RSI` or `user:My Script`. */
export async function loadCode(ref, { fresh = false } = {}) {
  if (!fresh && codeCache.has(ref)) return codeCache.get(ref);
  const [kind, name] = splitRef(ref);
  let code = null;
  if (kind === 'builtin') {
    const r = await fetch(`/scripts/builtin/${encodeURIComponent(name)}.js`);
    code = r.ok ? await r.text() : null;
  } else {
    code = await api.load('scripts', name, null);
  }
  if (code == null) throw new Error(`script "${name}" not found`);
  codeCache.set(ref, code);
  return code;
}

export function forgetCode(ref) { codeCache.delete(ref); }

export function splitRef(ref) {
  const i = ref.indexOf(':');
  return [ref.slice(0, i), ref.slice(i + 1)];
}

export async function listScripts() {
  const [builtin, user] = await Promise.all([
    fetch('/scripts/builtin/index.json').then((r) => r.json()).catch(() => []),
    api.list('scripts'),
  ]);
  return { builtin, user };
}

// ---------- worker runner ----------

class Runner {
  constructor() { this.spawn(); }

  spawn() {
    this.worker?.terminate();
    this.worker = new Worker('/js/scripts/worker.js', { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const p = this.pending;
      if (!p || p.id !== data.id) return;
      clearTimeout(p.timer);
      this.pending = null;
      data.ok ? p.resolve(data.result) : p.reject(Object.assign(new Error(data.error.message), { line: data.error.line }));
    };
    this.worker.onerror = (e) => {
      const p = this.pending;
      if (!p) return;
      clearTimeout(p.timer);
      this.pending = null;
      p.reject(new Error(e.message || 'script worker failed to start'));
      e.preventDefault?.();
    };
  }

  run(code, bars, inputs) {
    if (this.pending) { this.pending.reject(new Error('superseded')); clearTimeout(this.pending.timer); this.pending = null; this.spawn(); }
    return new Promise((resolve, reject) => {
      const id = Math.random();
      const timer = setTimeout(() => {
        this.pending = null;
        this.spawn(); // the only way to stop a runaway script
        reject(new Error(`script took longer than ${TIMEOUT_MS / 1000}s (endless loop?)`));
      }, TIMEOUT_MS);
      this.pending = { id, resolve, reject, timer };
      this.worker.postMessage({ id, code, bars, inputs });
    });
  }

  terminate() { this.worker.terminate(); }
}

// ---------- one study ----------

class Study {
  constructor(host, cfg) {
    this.host = host;
    this.cfg = cfg; // { uid, ref, inputs, hidden }
    this.runner = new Runner();
    this.result = null;
    this.error = null;
    this.series = [];
    this.markers = null;
    this.bg = null;
    this.paneIndex = 0;
    this.signature = '';
  }

  get title() {
    return this.result?.meta.title || splitRef(this.cfg.ref)[1];
  }

  get overlay() { return !!this.result?.meta.overlay; }

  async run(bars) {
    try {
      const code = await loadCode(this.cfg.ref);
      this.result = await this.runner.run(code, bars, this.cfg.inputs || {});
      this.error = null;
    } catch (e) {
      if (e.message === 'superseded') return false;
      this.error = e.line ? `line ${e.line}: ${e.message}` : e.message;
      this.result = this.result && { ...this.result, plots: [], shapes: [], bgcolors: [] };
    }
    return true;
  }

  /** Structure that, if changed, needs new series (vs. just new data). */
  sig() {
    const r = this.result;
    if (!r || this.cfg.hidden) return `hidden:${this.cfg.hidden}`;
    return JSON.stringify([r.meta.overlay, r.plots.map((p) => [p.style, p.color, p.width]), r.hlines, r.bgcolors.length > 0]);
  }

  destroySeries(chart) {
    for (const s of this.series) chart.removeSeries(s);
    if (this.bg) chart.removeSeries(this.bg);
    this.markers?.detach?.();
    this.series = [];
    this.bg = null;
    this.markers = null;
  }

  dispose(chart) {
    this.destroySeries(chart);
    this.runner.terminate();
  }
}

// ---------- host (one per chart) ----------

export class StudyHost {
  /** @param {import('../chart-pane.js').ChartPane} pane */
  constructor(pane) {
    this.pane = pane;
    this.chart = pane.chart;
    this.studies = [];
    this.legendBoxes = [];
    this.candleMarkers = LWC.createSeriesMarkers(pane.candles, []);
    this.rerunTimer = null;
    this.hoverIndex = null;
    this.chart.subscribeCrosshairMove((p) => {
      this.hoverIndex = p.logical != null ? Math.round(p.logical) : null;
      this.renderLegends();
    });
    setInterval(() => this.positionLegends(), 500); // pane separators can be dragged
  }

  /** Replaces the study list (from saved state). */
  async setConfigs(configs) {
    for (const s of this.studies) s.dispose(this.chart);
    this.studies = configs.map((c) => new Study(this, { ...c }));
    await this.runAll(true);
  }

  configs() {
    return this.studies.map((s) => ({ ...s.cfg }));
  }

  async add(ref, inputs = {}) {
    const s = new Study(this, { uid: `s${uidSeq++}`, ref, inputs, hidden: false });
    this.studies.push(s);
    await this.runAll(true);
    this.pane.studiesChanged();
    return s;
  }

  remove(uid) {
    const i = this.studies.findIndex((s) => s.cfg.uid === uid);
    if (i < 0) return;
    this.studies[i].dispose(this.chart);
    this.studies.splice(i, 1);
    this.rebuild();
    this.pane.studiesChanged();
  }

  async update(uid, patch) {
    const s = this.studies.find((x) => x.cfg.uid === uid);
    if (!s) return;
    Object.assign(s.cfg, patch);
    await this.runAll(true);
    this.pane.studiesChanged();
  }

  /** A user script was edited: reload it everywhere it is used. */
  async reloadScript(ref) {
    forgetCode(ref);
    if (this.studies.some((s) => s.cfg.ref === ref)) await this.runAll(true);
  }

  barsForScripts() {
    const bars = this.pane.data.bars;
    const n = bars.length;
    const col = (k) => {
      const a = new Float64Array(n);
      for (let i = 0; i < n; i++) a[i] = bars[i][k] ?? (k === 'volume' ? 0 : Number.NaN);
      return a;
    };
    return { time: col('time'), open: col('open'), high: col('high'), low: col('low'), close: col('close'), volume: col('volume') };
  }

  /** Runs every study on the current bars. `force` rebuilds series even if unchanged. */
  async runAll(force = false) {
    if (!this.pane.data.bars.length) { this.rebuild(); return; }
    const bars = this.barsForScripts();
    const done = await Promise.all(this.studies.map((s) => (s.cfg.hidden ? true : s.run(bars))));
    if (done.includes(false) && !force) return;
    const sigs = this.studies.map((s) => s.sig()).join('|');
    if (force || sigs !== this.lastSigs) {
      this.lastSigs = sigs;
      this.rebuild();
    } else {
      this.refreshData();
    }
    this.pane.onStudiesRun?.(this);
  }

  /** Live bar update: rerun scripts, throttled. */
  onBar() {
    if (this.rerunTimer || !this.studies.length) return;
    this.rerunTimer = setTimeout(() => { this.rerunTimer = null; this.runAll(false); }, RERUN_MS);
  }

  // ---------- rendering ----------

  rebuild() {
    const chart = this.chart;
    for (const s of this.studies) s.destroySeries(chart);
    for (let i = chart.panes().length - 1; i >= 1; i--) {
      if (!chart.panes()[i].getSeries().length) chart.removePane(i);
    }
    let nextPane = 1;
    for (const s of this.studies) {
      if (!s.result || s.cfg.hidden) continue;
      s.paneIndex = s.overlay ? 0 : nextPane++;
      this.createSeries(s);
    }
    // Main chart gets most of the height; each indicator pane about a fifth of it.
    const panes = chart.panes();
    panes[0]?.setStretchFactor(1);
    for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(0.25);
    this.refreshData();
  }

  createSeries(s) {
    const r = s.result;
    const precision = r.meta.precision ?? (s.overlay ? this.pane.data.precision : 2);
    const priceFormat = { type: 'price', precision, minMove: 10 ** -precision };
    if (r.bgcolors.length) {
      s.bg = this.chart.addSeries(LWC.HistogramSeries, {
        priceScaleId: `bg-${s.cfg.uid}`, lastValueVisible: false, priceLineVisible: false, base: 0,
      }, s.paneIndex);
      s.bg.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
      s.bg.setSeriesOrder(0); // behind the candles
    }
    for (const p of r.plots) {
      const common = { color: p.color, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, priceFormat };
      let series;
      if (p.style === 'histogram' || p.style === 'columns') {
        series = this.chart.addSeries(LWC.HistogramSeries, { ...common, base: 0 }, s.paneIndex);
      } else if (p.style === 'area') {
        series = this.chart.addSeries(LWC.AreaSeries, { ...common, lineColor: p.color, topColor: p.color + '55', bottomColor: p.color + '05', lineWidth: p.width }, s.paneIndex);
      } else {
        series = this.chart.addSeries(LWC.LineSeries, {
          ...common, lineWidth: p.width,
          lineType: p.style === 'step' ? LWC.LineType.WithSteps : LWC.LineType.Simple,
          lineVisible: p.style !== 'circles', pointMarkersVisible: p.style === 'circles', pointMarkersRadius: 2,
        }, s.paneIndex);
      }
      s.series.push(series);
    }
    const levelHost = s.series[0] || (s.overlay ? this.pane.candles : null);
    for (const h of r.hlines) {
      levelHost?.createPriceLine({ price: h.price, color: h.color, lineStyle: h.dash === 0 ? LWC.LineStyle.Solid : h.dash === 2 ? LWC.LineStyle.Dotted : LWC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: h.title });
    }
    if (!s.overlay && s.series[0]) s.markers = LWC.createSeriesMarkers(s.series[0], []);
  }

  refreshData() {
    const bars = this.pane.data.bars;
    const overlayMarkers = [];
    for (const s of this.studies) {
      const r = s.result;
      if (!r || s.cfg.hidden) continue;
      r.plots.forEach((p, i) => {
        const series = s.series[i];
        if (!series) return;
        const data = new Array(bars.length);
        for (let j = 0; j < bars.length; j++) {
          const v = p.values[j];
          data[j] = Number.isFinite(v) ? (p.colors?.[j] ? { time: bars[j].time, value: v, color: p.colors[j] } : { time: bars[j].time, value: v }) : { time: bars[j].time };
        }
        series.setData(data);
      });
      if (s.bg) {
        const colors = new Map(r.bgcolors.map((b) => [b.index, b.color]));
        s.bg.setData(bars.map((b, j) => (colors.has(j) ? { time: b.time, value: 1, color: colors.get(j) } : { time: b.time })));
      }
      const markers = r.shapes.filter((m) => bars[m.index]).map((m) => ({ time: bars[m.index].time, position: m.location, shape: m.shape, color: m.color, text: m.text }));
      if (s.overlay) overlayMarkers.push(...markers);
      else s.markers?.setMarkers(markers);
    }
    overlayMarkers.sort((a, b) => a.time - b.time);
    this.candleMarkers.setMarkers(overlayMarkers);
    this.renderLegends();
  }

  // ---------- legends ----------

  renderLegends() {
    const idx = this.hoverIndex ?? this.pane.data.bars.length - 1;
    const byPane = new Map();
    for (const s of this.studies) {
      const key = s.cfg.hidden || !s.result ? (s.overlay ? 0 : -1) : s.paneIndex;
      if (!byPane.has(key)) byPane.set(key, []);
      byPane.get(key).push(s);
    }
    // Overlay (and hidden) studies are listed under the main OHLC legend.
    const main = this.pane.legend.querySelector('.legend-studies') || this.pane.legend.appendChild(el('div', { class: 'legend-studies' }));
    main.replaceChildren(...[...(byPane.get(0) || []), ...(byPane.get(-1) || [])].map((s) => this.legendLine(s, idx)));

    const needed = [...byPane.keys()].filter((k) => k > 0);
    while (this.legendBoxes.length > needed.length) this.legendBoxes.pop().remove();
    needed.forEach((paneIdx, i) => {
      let box = this.legendBoxes[i];
      if (!box) { box = el('div', { class: 'legend pane-legend' }); this.pane.root.append(box); this.legendBoxes.push(box); }
      box.dataset.pane = paneIdx;
      box.replaceChildren(...byPane.get(paneIdx).map((s) => this.legendLine(s, idx)));
    });
    this.positionLegends();
  }

  positionLegends() {
    const panes = this.chart.panes();
    for (const box of this.legendBoxes) {
      const k = Number(box.dataset.pane);
      let top = 0;
      for (let i = 0; i < k && i < panes.length; i++) top += panes[i].getHeight() + 1;
      box.style.top = `${top + 4}px`;
    }
  }

  legendLine(s, idx) {
    const r = s.result;
    const inputs = r?.inputs.filter((d) => ['int', 'float', 'source'].includes(d.type)).map((d) => s.cfg.inputs?.[d.title] ?? d.default) ?? [];
    const values = s.cfg.hidden || !r ? [] : r.plots.map((p) => {
      const v = p.values[Math.min(idx, p.values.length - 1)];
      return el('span', { class: 'lv', style: `color:${p.colors?.[idx] || p.color}` }, Number.isFinite(v) ? fmt(v, r.meta.precision) : '–');
    });
    const host = this;
    return el('div', { class: `legend-line ${s.cfg.hidden ? 'off' : ''}` },
      el('span', { class: 'lt' }, s.title, inputs.length ? el('span', { class: 'li' }, ` ${inputs.join(' ')}`) : null),
      ...values,
      s.error ? el('span', { class: 'lerr', title: s.error }, `⚠ ${s.error}`) : null,
      el('span', { class: 'lbtns' },
        el('button', { title: s.cfg.hidden ? 'Show' : 'Hide', onclick: () => host.update(s.cfg.uid, { hidden: !s.cfg.hidden }) }, s.cfg.hidden ? '◌' : '👁'),
        el('button', { title: 'Settings', onclick: () => host.pane.hooks.onStudySettings?.(host, s) }, '⚙'),
        el('button', { title: 'Remove', onclick: () => host.remove(s.cfg.uid) }, '×')));
  }
}

function fmt(v, precision) {
  if (precision != null) return v.toFixed(precision);
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return v.toFixed(0);
  if (a >= 100) return v.toFixed(2);
  return v.toFixed(a >= 1 ? 3 : 5);
}
