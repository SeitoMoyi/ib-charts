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
