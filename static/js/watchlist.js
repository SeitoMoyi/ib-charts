// Watchlist sidebar: one list of symbols (with optional section headers), live quotes,
// drag to reorder, click to chart, ↑/↓ to step through.

import * as api from './api.js';
import { $, el, fill } from './util.js';

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
const SORT_COLUMNS = [['symbol', 'Symbol'], ['price', 'Last'], ['change', 'Chg'], ['changePct', 'Chg%']];

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
      this.cols = el('div', { class: 'wl-cols' }, ...SORT_COLUMNS.map(([key, label]) =>
        el('span', { class: 'sortable', 'data-key': key, title: 'Click to sort', onclick: () => this.toggleSort(key) }, label))),
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

  // ---------- sorting ----------

  /** Header click: ascending → descending → off (numbers start descending, like TradingView). */
  toggleSort(key) {
    const cur = this.data.sort;
    const first = key === 'symbol' ? 1 : -1;
    if (!cur || cur.key !== key) this.data.sort = { key, dir: first };
    else if (cur.dir === first) this.data.sort = { key, dir: -first };
    else this.data.sort = null;
    this.changed();
  }

  /** Items in display order as [{ item, idx }]; sorting applies within each section. */
  viewItems() {
    const items = this.data.items.map((item, idx) => ({ item, idx }));
    const sort = this.data.sort;
    if (!sort) return items;
    const value = ({ item }) => (sort.key === 'symbol' ? item.symbol : this.quotes.get(item.symbol)?.[sort.key]);
    const cmp = (a, b) => {
      const va = value(a), vb = value(b);
      if (va == null || Number.isNaN(va)) return 1; // missing values last
      if (vb == null || Number.isNaN(vb)) return -1;
      return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * sort.dir;
    };
    const out = [];
    let group = [];
    const flush = () => { out.push(...group.sort(cmp)); group = []; };
    for (const it of items) {
      if (it.item.type === 'section') { flush(); out.push(it); } else group.push(it);
    }
    flush();
    return out;
  }

  // ---------- rendering ----------

  render() {
    const view = this.viewItems();
    fill(this.body, ...view.map(({ item, idx }, pos) => {
      const row = item.type === 'section' ? this.sectionRow(item, idx) : this.symbolRow(item, idx);
      row.dataset.pos = pos;
      return this.draggable(row, pos);
    }));
    this.highlight();
    const sort = this.data.sort;
    this.cols.querySelectorAll('.sortable').forEach((h) => {
      const on = sort?.key === h.dataset.key;
      h.classList.toggle('sorted', on);
      h.dataset.arrow = on ? (sort.dir > 0 ? '▲' : '▼') : '';
    });
    const n = this.symbols().length;
    this.footer.className = `wl-footer ${n > LINE_LIMIT * 0.9 ? 'warn' : ''}`;
    this.footer.textContent = (n > LINE_LIMIT * 0.9
      ? `${n} symbols — close to IB's ${LINE_LIMIT} market-data line limit`
      : `${n} symbol${n === 1 ? '' : 's'}`) + (sort ? ' · sorted (drag a row to reorder by hand)' : ' · drag rows to reorder');
  }

  sectionRow(item, idx) {
    const title = el('span', { class: 'wl-section-title', title: 'Double-click to rename' }, item.title);
    title.addEventListener('dblclick', () => this.editTitle(title, item));
    return el('div', { class: 'wl-section' }, title,
      el('button', { class: 'wl-x', title: 'Remove section', onclick: () => { this.data.items.splice(idx, 1); this.changed(); } }, '×'));
  }

  symbolRow(item) {
    const row = el('div', { class: 'wl-row', 'data-symbol': item.symbol, onclick: () => { if (!this.justDragged) this.hooks.onPick(item.symbol); } },
      el('span', { class: 'wl-sym' }, item.symbol, el('span', { class: 'wl-badge' })),
      el('span', { class: 'wl-last' }), el('span', { class: 'wl-chg' }), el('span', { class: 'wl-pct' }),
      el('button', { class: 'wl-x', title: 'Remove', onclick: (e) => { e.stopPropagation(); this.remove(item.symbol); } }, '×'));
    this.paint(row, this.quotes.get(item.symbol));
    return row;
  }

  /**
   * Pointer-based drag to reorder. (Native HTML drag-and-drop doesn't work in the
   * desktop app, where the window intercepts drags for file drops.)
   */
  draggable(row, pos) {
    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button') || e.target.isContentEditable) return;
      const startY = e.clientY;
      let dragging = false, target = pos;
      const indicator = el('div', { class: 'wl-drop' });
      const move = (ev) => {
        if (!dragging) {
          if (Math.abs(ev.clientY - startY) < 5) return;
          dragging = true;
          row.classList.add('dragging');
          this.body.append(indicator);
          document.body.classList.add('wl-dragging');
        }
        // Insertion point = before the first row whose middle is below the pointer.
        const rows = [...this.body.querySelectorAll('[data-pos]')];
        target = rows.length;
        for (const r of rows) {
          const b = r.getBoundingClientRect();
          if (ev.clientY < b.top + b.height / 2) { target = Number(r.dataset.pos); break; }
        }
        const ref = rows[target] || rows[rows.length - 1];
        const rb = ref.getBoundingClientRect(), bb = this.body.getBoundingClientRect();
        indicator.style.top = `${(rows[target] ? rb.top : rb.bottom) - bb.top + this.body.scrollTop - 1}px`;
        // Auto-scroll near the edges.
        if (ev.clientY < bb.top + 24) this.body.scrollTop -= 8;
        if (ev.clientY > bb.bottom - 24) this.body.scrollTop += 8;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (!dragging) return;
        row.classList.remove('dragging');
        indicator.remove();
        document.body.classList.remove('wl-dragging');
        this.justDragged = true;
        setTimeout(() => { this.justDragged = false; }, 0); // swallow the click that follows
        this.moveTo(pos, target);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    return row;
  }

  /** Moves the row at display position `from` to before display position `to`. */
  moveTo(from, to) {
    const order = this.viewItems().map(({ item }) => item); // keep what the user sees
    if (to === from || to === from + 1) {
      if (!this.data.sort) return;
    } else {
      const [moved] = order.splice(from, 1);
      order.splice(to > from ? to - 1 : to, 0, moved);
    }
    this.data.items = order;
    this.data.sort = null; // a manual order replaces sorting
    this.changed();
  }

  onQuote(q) {
    // Keep a price-based sort current, without re-rendering on every tick.
    if (this.data.sort && this.data.sort.key !== 'symbol' && !this.resortTimer) {
      this.resortTimer = setTimeout(() => { this.resortTimer = null; if (!document.body.classList.contains('wl-dragging')) this.render(); }, 2000);
    }
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
