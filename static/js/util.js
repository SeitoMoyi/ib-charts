export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

export function fmtVol(v) {
  if (v == null) return '';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}

/** Decimal places implied by a tick size: 0.01 -> 2, 0.005 -> 3, 0.00005 -> 5, 0.25 -> 2. */
export function precisionFor(minTick) {
  const decimals = minTick > 0 ? (minTick.toFixed(10).replace(/0+$/, '').split('.')[1] || '').length : 2;
  return Math.min(8, Math.max(2, decimals));
}

/** In-app replacement for window.confirm (which desktop webviews may not implement). */
export function confirmDialog(text, okLabel = 'OK') {
  return new Promise((resolve) => {
    const dlg = el('dialog', { class: 'confirm' });
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(el('div', { class: 'gw-form' },
      el('div', {}, text),
      el('div', { class: 'gw-actions' },
        el('button', { type: 'button', onclick: () => done(false) }, 'Cancel'),
        el('button', { type: 'button', class: 'primary', onclick: () => done(true) }, okLabel))));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** Opens a dropdown menu under `anchor`. Returns a function that closes it. */
export function openMenu(anchor, build) {
  document.querySelector('.menu')?.remove();
  const menu = el('div', { class: 'menu' });
  const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true); };
  const outside = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  menu.append(...build(close));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
  if (r.bottom + menu.offsetHeight > window.innerHeight - 8) menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
  else menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, left)}px`;
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc, true); }, 0);
  return close;
}

/** replaceChildren that skips null/false entries (the DOM would print them as text). */
export function fill(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
}
