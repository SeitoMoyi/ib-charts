// Watchlist sidebar: one list of symbols (with optional section headers), live quotes,
// drag to reorder, click to chart, ↑/↓ to step through.

import * as api from './api.js';
import { $, el } from './util.js';

const DEFAULT = {
  items: [
    { type: 'section', title: 'Stocks' },
    { type: 'symbol', symbol: 'AAPL' },
    { type: 'symbol', symbol: 'MSFT' },
    { type: 'symbol', symbol: 'NVDA' },
    { type: 'section', title: 'Indices & futures' },
    { type: 'symbol', symbol: '^SPX' },
    { type: 'symbol', symbol: '/ES' },
    { type: 'section', title: 'FX & crypto' },
    { type: 'symbol', symbol: 'EUR.USD' },
    { type: 'symbol', symbol: '$BTC' },
  ],
};
const LINE_LIMIT = 100; // IB's default market-data lines per user

export class Watchlist {
  /**
   * @param {import('./feed.js').Feed} feed
   * @param {{onPick:(symbol:string)=>void, current:()=>string}} hooks
   */
  constructor(feed, hooks) {
    this.feed = feed;
    this.hooks = hooks;
    this.quotes = new Map(); // symbol -> quote
    this.save = api.debouncedSaver('watchlist', 'default', 300);
    this.root = $('watchlist');
    this.body = el('div', { class: 'wl-body' });
    this.footer = el('div', { class: 'wl-footer' });
    this.addInput = el('input', { class: 'wl-add', placeholder: 'Add symbol…', spellcheck: 'false', autocomplete: 'off' });
    this.root.append(
      el('div', { class: 'wl-head' },
        el('span', { class: 'wl-title' }, 'Watchlist'),
        el('button', { class: 'small', title: 'Add a section header', onclick: () => this.addSection() }, '+ Section')),
      this.addInput,
      el('div', { class: 'wl-cols' }, el('span', {}, 'Symbol'), el('span', {}, 'Last'), el('span', {}, 'Chg'), el('span', {}, 'Chg%')),
      this.body,
      this.footer,
    );
    this.addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { this.add(this.addInput.value); this.addInput.value = ''; }
      if (e.key === 'Escape') this.addInput.blur();
    });
    feed.onGlobal((m) => { if (m.type === 'quote') this.onQuote(m.quote); });

    // ↑/↓ steps through the list when you're not typing somewhere.
    document.addEventListener('keydown', (e) => {
      const t = document.activeElement;
      if (this.root.hidden || this.root.closest('aside')?.hidden || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName) || t?.isContentEditable) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      this.step(e.key === 'ArrowDown' ? 1 : -1);
    });
  }

  async load() {
    this.data = (await api.load('watchlist', 'default')) || structuredClone(DEFAULT);
    this.render();
    this.subscribe();
  }

  symbols() {
    return this.data.items.filter((i) => i.type === 'symbol').map((i) => i.symbol);
  }

  has(symbol) {
    return this.symbols().includes(symbol.toUpperCase());
  }

  toggle(symbol) {
    if (this.has(symbol)) this.remove(symbol); else this.add(symbol);
  }

  add(symbol) {
    symbol = symbol.trim().toUpperCase();
    if (!symbol || this.has(symbol)) return;
    this.data.items.push({ type: 'symbol', symbol });
    this.changed();
  }

  remove(symbol) {
    this.data.items = this.data.items.filter((i) => !(i.type === 'symbol' && i.symbol === symbol));
    this.quotes.delete(symbol);
    this.changed();
  }

  addSection() {
    this.data.items.push({ type: 'section', title: 'New section' });
    this.changed();
    const titles = this.body.querySelectorAll('.wl-section-title');
    this.editTitle(titles[titles.length - 1], this.data.items[this.data.items.length - 1]);
  }

  /** Inline rename of a section title (Enter saves, Esc cancels). */
  editTitle(span, item) {
    span.contentEditable = 'true';
    span.focus();
    document.getSelection().selectAllChildren(span);
    const finish = (commit) => {
      span.contentEditable = 'false';
      const t = span.textContent.trim();
      if (commit && t) item.title = t;
      this.changed();
    };
    span.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
      if (e.key === 'Escape') { span.textContent = item.title; span.blur(); }
      e.stopPropagation();
    });
    span.addEventListener('blur', () => finish(true), { once: true });
  }

  step(dir) {
    const syms = this.symbols();
    if (!syms.length) return;
    const i = syms.indexOf(this.hooks.current());
    const next = syms[(i + dir + syms.length) % syms.length] ?? syms[0];
    this.hooks.onPick(next);
  }

  changed() {
    this.save(this.data);
    this.render();
    this.subscribe();
    this.onChange?.();
  }

  subscribe() {
    this.feed.setQuotes(this.symbols());
  }

  /** Re-highlights the row for the charted symbol. */
  highlight() {
    const cur = this.hooks.current();
    this.body.querySelectorAll('.wl-row').forEach((r) => r.classList.toggle('current', r.dataset.symbol === cur));
  }

  // ---------- rendering ----------

  render() {
    this.body.replaceChildren(...this.data.items.map((item, idx) => (item.type === 'section' ? this.sectionRow(item, idx) : this.symbolRow(item, idx))));
    this.highlight();
    const n = this.symbols().length;
    this.footer.className = `wl-footer ${n > LINE_LIMIT * 0.9 ? 'warn' : ''}`;
    this.footer.textContent = n > LINE_LIMIT * 0.9
      ? `${n} symbols — close to IB's ${LINE_LIMIT} market-data line limit`
      : `${n} symbol${n === 1 ? '' : 's'}`;
  }

  sectionRow(item, idx) {
    const title = el('span', { class: 'wl-section-title', title: 'Double-click to rename' }, item.title);
    title.addEventListener('dblclick', () => this.editTitle(title, item));
    return this.draggable(el('div', { class: 'wl-section' }, title,
      el('button', { class: 'wl-x', title: 'Remove section', onclick: () => { this.data.items.splice(idx, 1); this.changed(); } }, '×')), idx);
  }

  symbolRow(item, idx) {
    const row = el('div', { class: 'wl-row', 'data-symbol': item.symbol, onclick: () => this.hooks.onPick(item.symbol) },
      el('span', { class: 'wl-sym' }, item.symbol, el('span', { class: 'wl-badge' })),
      el('span', { class: 'wl-last' }), el('span', { class: 'wl-chg' }), el('span', { class: 'wl-pct' }),
      el('button', { class: 'wl-x', title: 'Remove', onclick: (e) => { e.stopPropagation(); this.remove(item.symbol); } }, '×'));
    this.paint(row, this.quotes.get(item.symbol));
    return this.draggable(row, idx);
  }

  draggable(row, idx) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(idx)); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop');
      const from = Number(e.dataTransfer.getData('text/plain'));
      if (Number.isNaN(from) || from === idx) return;
      const [moved] = this.data.items.splice(from, 1);
      this.data.items.splice(idx, 0, moved);
      this.changed();
    });
    return row;
  }

  onQuote(q) {
    const prev = this.quotes.get(q.symbol);
    if (q.error && prev && !prev.error) q = { ...prev, stale: true }; // keep last good values
    this.quotes.set(q.symbol, q);
    const row = this.body.querySelector(`.wl-row[data-symbol="${CSS.escape(q.symbol)}"]`);
    if (!row) return;
    this.paint(row, q);
    if (prev?.price != null && q.price != null && q.price !== prev.price) {
      row.classList.remove('flash-up', 'flash-down');
      void row.offsetWidth; // restart the animation
      row.classList.add(q.price > prev.price ? 'flash-up' : 'flash-down');
    }
  }

  paint(row, q) {
    const [last, chg, pct] = [row.querySelector('.wl-last'), row.querySelector('.wl-chg'), row.querySelector('.wl-pct')];
    const badge = row.querySelector('.wl-badge');
    if (!q || q.price == null) {
      last.textContent = q?.error ? '—' : '…';
      chg.textContent = pct.textContent = '';
      row.title = q?.error || 'Loading…';
      badge.textContent = '';
      return;
    }
    const d = decimals(row.dataset.symbol, q.price);
    last.textContent = q.price != null ? q.price.toFixed(d) : '—';
    chg.textContent = q.change != null ? (q.change >= 0 ? '+' : '') + q.change.toFixed(d) : '';
    pct.textContent = q.changePct != null ? (q.changePct >= 0 ? '+' : '') + q.changePct.toFixed(2) + '%' : '';
    const cls = q.change == null ? '' : q.change >= 0 ? 'up' : 'down';
    chg.className = `wl-chg ${cls}`;
    pct.className = `wl-pct ${cls}`;
    const delayed = q.dataType === 'delayed' || q.dataType === 'delayedFrozen';
    badge.textContent = delayed ? 'D' : '';
    badge.title = delayed ? 'Delayed data (no live subscription)' : '';
    row.title = [q.bid != null && `Bid ${q.bid}`, q.ask != null && `Ask ${q.ask}`, q.close != null && `Prev close ${q.close}`,
      q.dataType && `Data: ${q.dataType}`, q.stale && 'Stale — reconnecting'].filter(Boolean).join('\n');
  }
}

function decimals(symbol, price) {
  if (/^[A-Z]{3}\.[A-Z]{3}$/.test(symbol)) return symbol.endsWith('JPY') ? 3 : 5;
  if (price != null && price < 1) return 4;
  return 2;
}
