// Multi-chart layouts (1, 2 side by side, 2 stacked, 3, 4) with an active chart and
// optional linking of symbol, timeframe, crosshair and visible time range.

import { ChartPane } from './chart-pane.js';
import { el } from './util.js';

export const LAYOUTS = {
  1: { label: '1 chart', count: 1 },
  '2v': { label: '2 side by side', count: 2 },
  '2h': { label: '2 stacked', count: 2 },
  3: { label: '3 (1 large + 2)', count: 3 },
  4: { label: '4 grid', count: 4 },
};

export class Layout {
  /**
   * @param {HTMLElement} container
   * @param {import('./feed.js').Feed} feed
   * @param {object} saved  { type, panes: [state], active, link: { symbol, tf, crosshair, time } }
   * @param {object} hooks  ChartPane hooks plus onActivate(pane), onChange()
   */
  constructor(container, feed, saved, hooks) {
    this.container = container;
    this.feed = feed;
    this.hooks = hooks;
    this.type = LAYOUTS[saved.type] ? String(saved.type) : '1';
    this.link = { symbol: false, tf: false, crosshair: true, time: false, ...saved.link };
    this.panes = [];
    this.states = saved.panes?.length ? saved.panes : [{}];
    this.activeIndex = Math.min(saved.active ?? 0, this.states.length - 1);
    this.syncing = false;
    this.build();
  }

  get active() { return this.panes[this.activeIndex] ?? this.panes[0]; }

  build() {
    for (const p of this.panes) p.destroy();
    this.panes = [];
    this.container.className = `layout-${this.type}`;
    const count = LAYOUTS[this.type].count;
    while (this.states.length < count) this.states.push(structuredClone(this.states[this.states.length - 1] || {}));
    for (let i = 0; i < count; i++) this.addPane(this.states[i]);
    this.activeIndex = Math.min(this.activeIndex, count - 1);
    this.activate(this.active, true);
  }

  addPane(state) {
    const pane = new ChartPane(this.container, this.feed, structuredClone(state), {
      ...this.hooks,
      onChange: (p) => this.onPaneChange(p),
      onStatus: (p, text, kind) => { if (p === this.active) this.hooks.onStatus?.(p, text, kind); },
      onLoad: (p) => { if (p === this.active) this.hooks.onLoad?.(p); },
    });
    pane.root.addEventListener('pointerdown', () => { if (pane !== this.active) this.activate(pane); }, true);
    pane.chart.subscribeCrosshairMove((param) => this.syncCrosshair(pane, param));
    pane.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.syncTime(pane));
    this.panes.push(pane);
    this.hooks.onPaneCreated?.(pane);
    return pane;
  }

  setType(type) {
    if (!LAYOUTS[type] || type === this.type) return;
    this.states = this.panes.map((p) => structuredClone(p.state));
    this.type = String(type);
    this.build();
    this.changed();
  }

  activate(pane, force = false) {
    const idx = this.panes.indexOf(pane);
    if (idx < 0 || (idx === this.activeIndex && !force)) return;
    this.activeIndex = idx;
    for (const p of this.panes) p.root.classList.toggle('active-pane', p === pane && this.panes.length > 1);
    this.hooks.onActivate?.(pane);
    this.changed();
  }

  onPaneChange(pane) {
    // Linked symbol / timeframe follow the chart that changed.
    if (!this.syncing && this.panes.length > 1) {
      this.syncing = true;
      for (const p of this.panes) {
        if (p === pane) continue;
        if (this.link.symbol && p.state.symbol !== pane.state.symbol) p.setSymbol(pane.state.symbol);
        if (this.link.tf && p.state.tf !== pane.state.tf) p.setTimeframe(pane.state.tf);
      }
      this.syncing = false;
    }
    if (pane === this.active) this.hooks.onActiveChange?.(pane);
    this.hooks.onAnyChange?.(pane);
    this.changed();
  }

  syncCrosshair(source, param) {
    if (!this.link.crosshair || this.syncing || this.panes.length < 2) return;
    this.syncing = true;
    for (const p of this.panes) {
      if (p === source) continue;
      if (param.time === undefined) { p.chart.clearCrosshairPosition(); continue; }
      const bar = p.barAtOrBefore(param.time);
      if (bar) p.chart.setCrosshairPosition(bar.close, bar.time, p.candles);
    }
    this.syncing = false;
  }

  syncTime(source) {
    if (!this.link.time || this.syncing || this.panes.length < 2) return;
    const range = source.chart.timeScale().getVisibleRange();
    if (!range) return;
    this.syncing = true;
    for (const p of this.panes) {
      if (p !== source && p.data.bars.length) {
        try { p.chart.timeScale().setVisibleRange(range); } catch { /* range outside data */ }
      }
    }
    this.syncing = false;
  }

  setLink(key, on) {
    this.link[key] = on;
    if (on && (key === 'symbol' || key === 'tf')) this.onPaneChange(this.active);
    this.changed();
  }

  serialize() {
    return { type: this.type, panes: this.panes.map((p) => structuredClone(p.state)), active: this.activeIndex, link: { ...this.link } };
  }

  changed() { this.hooks.onChange?.(this); }

  /** Layout picker + link toggles for the toolbar menu. */
  menu(close) {
    const item = (type) => el('div', { class: `menu-item ${type === this.type ? 'on' : ''}`, onclick: () => { this.setType(type); close(); } },
      el('span', { class: `layout-icon li-${type}` }, ...Array.from({ length: LAYOUTS[type].count }, () => el('i'))), LAYOUTS[type].label);
    const toggle = (key, label) => el('label', { class: 'menu-item check' },
      el('input', { type: 'checkbox', checked: this.link[key], onchange: (e) => this.setLink(key, e.target.checked) }), label);
    return [
      el('div', { class: 'menu-title' }, 'Layout'),
      ...Object.keys(LAYOUTS).map(item),
      el('div', { class: 'menu-title' }, 'Link charts'),
      toggle('symbol', 'Symbol'), toggle('tf', 'Timeframe'), toggle('crosshair', 'Crosshair'), toggle('time', 'Scroll / zoom'),
    ];
  }
}
