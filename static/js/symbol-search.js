// Symbol box with IB symbol-search autocomplete.

import { el } from './util.js';

/**
 * @param {HTMLInputElement} input
 * @param {HTMLUListElement} list
 * @param {(symbol:string)=>void} onChoose
 * @param {()=>string} current  returns the currently charted symbol
 */
export function initSymbolSearch(input, list, onChoose, current) {
  let hits = [], sel = -1, timer, searchSeq = 0;

  const choose = (sym) => {
    sym = sym.trim().toUpperCase();
    list.hidden = true;
    input.blur();
    if (!sym) { input.value = current(); return; }
    onChoose(sym);
  };

  const render = () => {
    list.replaceChildren(...hits.map((h, i) => el('li', {
      class: i === sel ? 'sel' : '',
      onmousedown: (e) => { e.preventDefault(); choose(h.input); },
    }, el('span', { class: 'sym' }, h.input), el('span', { class: 'meta' }, [h.kind, h.exchange, h.currency].filter(Boolean).join(' · ')))));
    list.hidden = hits.length === 0;
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    // Only plain tickers are searchable; special syntax (/ES, EUR.USD, ^SPX…) is typed directly.
    if (!q || /[\/^$.:]/.test(q)) { hits = []; render(); return; }
    timer = setTimeout(async () => {
      const my = ++searchSeq;
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!r.ok || my !== searchSeq) return;
        hits = (await r.json()).slice(0, 12);
        sel = -1;
        render();
      } catch { /* ignore */ }
    }, 400); // IB allows roughly one symbol search per second
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      render();
    } else if (e.key === 'Enter') {
      choose(sel >= 0 ? hits[sel].input : input.value);
    } else if (e.key === 'Escape') {
      list.hidden = true;
      input.value = current();
      input.blur();
    }
  });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('blur', () => { list.hidden = true; if (!input.value.trim()) input.value = current(); });

  // Start typing anywhere to change symbol, TradingView-style.
  document.addEventListener('keydown', (e) => {
    const t = document.activeElement;
    if (t === input || t?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Digits open the timeframe box instead (handled in main.js), like TradingView.
    if (/^[a-zA-Z\/^$]$/.test(e.key)) { input.focus(); input.value = ''; }
  });
}
