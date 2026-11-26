// Drawing tools for one chart: placing, selecting, dragging, styling, undo/redo and
// saving (per instrument, shared across timeframes).

import * as api from '../api.js';
import { el } from '../util.js';
import { TimeMapper, logicalToX, xToLogical } from './geometry.js';
import { COLORS, SHAPES } from './shapes.js';

const HANDLE_R = 5;
let nextId = Date.now();

/** Series primitive that renders the drawings and reports hover cursors. */
class DrawingLayer {
  constructor(mgr) {
    this.mgr = mgr;
    this.view = { zOrder: () => 'top', renderer: () => ({ draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => mgr.render(context, mediaSize)) }) };
  }
  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return [this.view]; }
  priceAxisViews() { return this.mgr.axisViews('price'); }
  timeAxisViews() { return this.mgr.axisViews('time'); }
  hitTest(x, y) {
    if (this.mgr.tool) return { cursorStyle: 'crosshair', externalId: 'tool', zOrder: 'top' };
    const h = this.mgr.hitTest(x, y);
    if (!h) return null;
    const locked = h.d.locked || this.mgr.lockAll;
    return { cursorStyle: locked ? 'default' : h.handle != null ? 'grab' : 'move', externalId: h.d.id, zOrder: 'top' };
  }
}

export class DrawingManager {
  /** @param {import('../chart-pane.js').ChartPane} pane */
  constructor(pane) {
    this.pane = pane;
    this.chart = pane.chart;
    this.series = pane.candles;
    this.mapper = new TimeMapper();
    this.drawings = [];
    this.key = null;
    this.tool = null;
    this.draft = null;
    this.selected = null;
    this.hovered = null;
    this.drag = null;
    this.magnet = false;
    this.lockAll = false;
    this.hidden = false;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.defaults = { color: COLORS[0], width: 2, dash: 0 };

    this.layer = new DrawingLayer(this);
    this.series.attachPrimitive(this.layer);
    this.buildStyleBar();
    this.bindPointer();
  }

  // ---------- data ----------

  /** Called when a symbol's history arrives. */
  async setBars(bars, key) {
    this.mapper.setTimes(bars.map((b) => b.time));
    if (key !== this.key) {
      this.key = key;
      this.selected = this.draft = null;
      this.undoStack = [];
      this.redoStack = [];
      const saved = await api.load('drawings', key, null);
      if (this.key !== key) return; // symbol changed while loading
      this.drawings = saved?.drawings || [];
    }
    this.update();
  }

  onBar(bar) { this.mapper.update(bar.time); }

  save() {
    if (!this.key) return;
    clearTimeout(this.saveTimer);
    const key = this.key, drawings = this.drawings;
    this.saveTimer = setTimeout(() => {
      const clean = JSON.parse(JSON.stringify(drawings, (k, v) => (k.startsWith('_') ? undefined : v)));
      api.save('drawings', key, { v: 1, drawings: clean }).catch((e) => console.error(e));
    }, 400);
  }

  /** Records the current state for undo, before a change. */
  checkpoint() {
    this.undoStack.push(JSON.stringify(this.drawings));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  commit() { this.save(); this.update(); this.emit(); }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.drawings));
    this.drawings = JSON.parse(this.undoStack.pop());
    this.selected = null;
    this.commit();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.drawings));
    this.drawings = JSON.parse(this.redoStack.pop());
    this.selected = null;
    this.commit();
  }

  remove(id) {
    this.checkpoint();
    this.drawings = this.drawings.filter((d) => d.id !== id);
    if (this.selected === id) this.selected = null;
    this.commit();
  }

  removeAll() {
    if (!this.drawings.length) return;
    this.checkpoint();
    this.drawings = [];
    this.selected = null;
    this.commit();
  }

  patch(id, fn) {
    const d = this.drawings.find((x) => x.id === id);
    if (!d) return;
    this.checkpoint();
    fn(d);
    this.commit();
  }

  get selectedDrawing() { return this.drawings.find((d) => d.id === this.selected) || null; }

  onChange(cb) { this.listeners.add(cb); }
  emit() { this.listeners.forEach((cb) => cb(this)); this.syncStyleBar(); }
  update() { this.layer.requestUpdate?.(); }

  setTool(type) {
    this.tool = type && SHAPES[type] ? type : null;
    this.draft = null;
    if (this.tool) this.selected = null;
    this.update();
    this.emit();
  }

  // ---------- coordinates ----------

  get ts() { return this.chart.timeScale(); }

  toX(t) {
    const l = this.mapper.toLogical(this.pane.toChartTime(t));
    return l == null ? null : logicalToX(this.ts, l);
  }

  toPixels(d) {
    return d.points.map((pt) => ({ x: this.toX(pt.t) ?? 0, y: this.series.priceToCoordinate(pt.p) ?? 0 }));
  }

  /** Point under the mouse, snapped to the bar grid (and to OHLC with the magnet on). */
  pointAt(x, y, magnet = this.magnet) {
    let l = Math.round(xToLogical(this.ts, x) ?? 0);
    let p = this.series.coordinateToPrice(y);
    const bar = this.pane.data.bars[l];
    if (magnet && bar) {
      let best = null;
      for (const v of [bar.open, bar.high, bar.low, bar.close]) {
        const dy = Math.abs((this.series.priceToCoordinate(v) ?? 1e9) - y);
        if (dy < 30 && (!best || dy < best.dy)) best = { v, dy };
      }
      if (best) p = best.v;
    }
    return { t: this.pane.fromChartTime(this.mapper.fromLogical(l)), p };
  }

  // ---------- rendering ----------

  env(d, size) {
    return {
      width: size.width,
      height: size.height,
      selected: d.id === this.selected || d.id === this.hovered,
      precision: this.pane.data.precision,
      measure: (dd) => this.measureText(dd),
    };
  }

  render(ctx, size) {
    if (this.hidden) return;
    this.size = size;
    const list = this.draft ? [...this.drawings, this.draft] : this.drawings;
    for (const d of list) {
      if (d.hidden) continue;
      const shape = SHAPES[d.type];
      const px = this.toPixels(d);
      ctx.save();
      shape.draw(ctx, px, d, this.env(d, size));
      ctx.restore();
      if (d.id === this.selected || d === this.draft) this.drawHandles(ctx, d, px, size);
    }
  }

  handlePoints(d, px, size = this.size) {
    const shape = SHAPES[d.type];
    if (shape.handles) return shape.handles(px);
    if (shape.priceOnly) return [{ x: (size?.width ?? 200) / 2, y: px[0].y }];
    if (shape.timeOnly) return [{ x: px[0].x, y: (size?.height ?? 200) / 2 }];
    return px;
  }

  drawHandles(ctx, d, px, size) {
    ctx.save();
    ctx.setLineDash([]);
    for (const h of this.handlePoints(d, px, size)) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = '#131722';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = d.style.color;
      ctx.stroke();
    }
    ctx.restore();
  }

  measureText(d) {
    const [a, b] = d.points.map((pt) => this.mapper.toLogical(this.pane.toChartTime(pt.t)));
    const bars = Math.round(Math.abs(b - a));
    let secs = Math.abs(d.points[1].t - d.points[0].t);
    const parts = [];
    for (const [unit, n] of [['d', 86400], ['h', 3600], ['m', 60]]) {
      if (secs >= n && parts.length < 2) { parts.push(Math.floor(secs / n) + unit); secs %= n; }
    }
    return `${bars} bars${parts.length ? ', ' + parts.join(' ') : ''}`;
  }

  /** Price / time axis labels for the selected drawing and for horizontal / vertical lines. */
  axisViews(kind) {
    if (this.hidden) return [];
    const views = [];
    const list = this.draft ? [...this.drawings, this.draft] : this.drawings;
    for (const d of list) {
      if (d.hidden) continue;
      const shape = SHAPES[d.type];
      const active = d.id === this.selected || d === this.draft;
      if (kind === 'price' && (active || d.type === 'hline' || d.type === 'hray') && !shape.timeOnly) {
        for (const pt of d.type === 'channel' || d.type === 'measure' || d.type === 'fib' || d.type === 'rect' || shape.points > 1 ? d.points : d.points.slice(0, 1)) {
          views.push(axisView(() => this.series.priceToCoordinate(pt.p), pt.p.toFixed(this.pane.data.precision), d.style.color));
        }
      }
      if (kind === 'time' && (active || d.type === 'vline') && !shape.priceOnly) {
        for (const pt of d.points) {
          views.push(axisView(() => this.toX(pt.t), this.formatTime(pt.t), d.style.color));
        }
      }
    }
    return views;
  }

  formatTime(t) {
    const dt = new Date(t * 1000);
    if (!this.pane.data.intraday) return dt.toISOString().slice(0, 10);
    const pad = (n) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  }

  // ---------- hit testing ----------

  hitTest(x, y) {
    if (this.hidden || !this.size) return null;
    // Handles of the selected drawing first.
    const sel = this.selectedDrawing;
    if (sel && !sel.hidden) {
      const hs = this.handlePoints(sel, this.toPixels(sel));
      const i = hs.findIndex((h) => Math.hypot(h.x - x, h.y - y) <= HANDLE_R + 3);
      if (i >= 0) return { d: sel, handle: i };
    }
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];
      if (d.hidden) continue;
      if (SHAPES[d.type].hit(x, y, this.toPixels(d), d, this.env(d, this.size))) return { d, handle: null };
    }
    return null;
  }

  // ---------- pointer interaction ----------

  bindPointer() {
    const elx = this.pane.chartEl;
    const local = (e) => {
      const r = elx.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const inPlot = ({ x, y }) => x >= 0 && y >= 0 && x < this.ts.width() && y < (this.chart.panes()[0]?.getHeight() ?? 0);
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };

    elx.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const pos = local(e);
      if (!inPlot(pos)) return;
      if (this.tool) {
        swallow(e);
        this.place(pos, e);
        return;
      }
      const h = this.hitTest(pos.x, pos.y);
      if (h) {
        swallow(e);
        this.selected = h.d.id;
        if (!h.d.locked && !this.lockAll) this.startDrag(h, pos);
        this.update();
        this.emit();
        return;
      }
      if (this.selected) { this.selected = null; this.update(); this.emit(); }
    }, true);

    elx.addEventListener('dblclick', (e) => {
      const pos = local(e);
      const h = this.hitTest(pos.x, pos.y);
      if (h?.d.type === 'text') { swallow(e); this.editText(h.d); }
    }, true);

    elx.addEventListener('pointermove', (e) => {
      const pos = local(e);
      if (this.draft) {
        this.draft.points[this.draft.points.length - 1] = this.pointAt(pos.x, pos.y);
        this.update();
        return;
      }
      if (this.drag) return;
      const h = inPlot(pos) && !this.tool ? this.hitTest(pos.x, pos.y) : null;
      const id = h?.d.id ?? null;
      if (id !== this.hovered) { this.hovered = id; this.update(); }
    });

    elx.addEventListener('pointerup', (e) => {
      // Drag-to-draw: releasing far from where the first point went down places the second point.
      if (!this.draft || !this.downAt) return;
      const pos = local(e);
      if (this.draft.points.length === 2 && Math.hypot(pos.x - this.downAt.x, pos.y - this.downAt.y) > 6) this.place(pos, e);
      this.downAt = null;
    });

    elx.addEventListener('pointerleave', () => { if (this.hovered) { this.hovered = null; this.update(); } });
  }

  place(pos, e) {
    const shape = SHAPES[this.tool];
    const pt = this.pointAt(pos.x, pos.y);
    if (!this.draft) {
      this.draft = { id: `d${nextId++}`, type: this.tool, points: [pt], style: { ...this.defaults } };
      if (shape.points === 1) return this.finish(e);
      this.draft.points.push({ ...pt });
      this.downAt = pos;
      this.update();
      return;
    }
    this.draft.points[this.draft.points.length - 1] = pt;
    if (this.draft.points.length >= shape.points) return this.finish(e);
    this.draft.points.push({ ...pt });
    this.update();
  }

  finish(e) {
    const d = this.draft;
    this.draft = null;
    this.checkpoint();
    if (d.type === 'text') d.text = 'Text';
    this.drawings.push(d);
    this.selected = d.id;
    if (!e?.shiftKey) this.tool = null; // hold Shift to keep drawing with the same tool
    this.commit();
    if (d.type === 'text') this.editText(d);
  }

  startDrag(h, pos) {
    const orig = structuredClone(h.d.points);
    const l0 = xToLogical(this.ts, pos.x);
    const p0 = this.series.coordinateToPrice(pos.y);
    let moved = false;
    const snapshot = JSON.stringify(this.drawings);
    const move = (e) => {
      const r = this.pane.chartEl.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      moved = true;
      if (h.handle != null) {
        const idx = SHAPES[h.d.type].priceOnly || SHAPES[h.d.type].timeOnly ? 0 : h.handle;
        const pt = this.pointAt(x, y);
        if (SHAPES[h.d.type].priceOnly) h.d.points[0] = { t: orig[0].t, p: pt.p };
        else if (SHAPES[h.d.type].timeOnly) h.d.points[0] = { t: pt.t, p: orig[0].p };
        else h.d.points[idx] = pt;
      } else {
        const dl = Math.round((xToLogical(this.ts, x) ?? l0) - l0);
        const dp = (this.series.coordinateToPrice(y) ?? p0) - p0;
        h.d.points = orig.map((pt) => {
          const l = this.mapper.toLogical(this.pane.toChartTime(pt.t)) + dl;
          return { t: this.pane.fromChartTime(this.mapper.fromLogical(l)), p: pt.p + dp };
        });
      }
      this.update();
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      this.drag = null;
      if (moved) {
        this.undoStack.push(snapshot);
        this.redoStack = [];
        this.commit();
      }
    };
    this.drag = true;
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  }

  // ---------- keyboard (called by the global toolbar) ----------

  onKey(e) {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      if (this.draft || this.tool) this.setTool(null);
      else if (this.selected) { this.selected = null; this.update(); this.emit(); }
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { this.remove(this.selected); return true; }
    if (mod && e.code === 'KeyZ') { e.shiftKey ? this.redo() : this.undo(); return true; }
    if (mod && e.code === 'KeyY') { this.redo(); return true; }
    return false;
  }

  // ---------- text editing ----------

  editText(d) {
    const [p] = this.toPixels(d);
    const input = el('input', { class: 'draw-text-edit', value: d.text || '' });
    input.style.left = `${p.x}px`;
    input.style.top = `${p.y - 28}px`;
    this.pane.root.append(input);
    input.focus();
    input.select();
    let finished = false;
    const done = (commit) => {
      if (finished) return;
      finished = true;
      const text = input.value.trim();
      input.remove();
      if (commit && text && text !== d.text) this.patch(d.id, (x) => { x.text = text; });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
  }

  // ---------- floating style bar ----------

  buildStyleBar() {
    const swatches = COLORS.map((c) => el('button', { class: 'swatch', title: c, style: `background:${c}`, onclick: () => this.styleSelected({ color: c }) }));
    const widths = [1, 2, 3, 4].map((w) => el('button', { class: 'wbtn', 'data-w': w, title: `${w}px`, onclick: () => this.styleSelected({ width: w }) },
      el('span', { style: `height:${w}px` })));
    const dashes = [['0', 'Solid', '———'], ['1', 'Dashed', '– – –'], ['2', 'Dotted', '· · · ·']].map(([v, t, s]) =>
      el('button', { class: 'dbtn', 'data-dash': v, title: t, onclick: () => this.styleSelected({ dash: Number(v) }) }, s));
    this.styleBar = el('div', { class: 'draw-style', hidden: true },
      ...swatches, el('span', { class: 'sep' }), ...widths, el('span', { class: 'sep' }), ...dashes, el('span', { class: 'sep' }),
      el('button', { class: 'lock', title: 'Lock / unlock', onclick: () => this.patch(this.selected, (d) => { d.locked = !d.locked; }) }, '🔒'),
      el('button', { title: 'Delete (Del)', onclick: () => this.selected && this.remove(this.selected) }, '🗑'));
    this.styleBar.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.pane.root.append(this.styleBar);
  }

  styleSelected(style) {
    Object.assign(this.defaults, style); // next drawings use the last style picked
    if (this.selected) this.patch(this.selected, (d) => Object.assign(d.style, style));
  }

  syncStyleBar() {
    const d = this.selectedDrawing;
    this.styleBar.hidden = !d;
    if (!d) return;
    this.styleBar.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b.title === d.style.color));
    this.styleBar.querySelectorAll('.wbtn').forEach((b) => b.classList.toggle('on', Number(b.dataset.w) === d.style.width));
    this.styleBar.querySelectorAll('.dbtn').forEach((b) => b.classList.toggle('on', Number(b.dataset.dash) === d.style.dash));
    this.styleBar.querySelector('.lock').classList.toggle('on', !!d.locked);
  }
}

function axisView(coord, text, color) {
  return {
    coordinate: () => coord() ?? -100,
    text: () => text,
    textColor: () => '#fff',
    backColor: () => color,
    visible: () => coord() != null,
    tickVisible: () => true,
  };
}
