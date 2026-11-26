// Left-hand drawing toolbar (TradingView-style), keyboard shortcuts and the objects list.
// It always operates on the active chart's DrawingManager.

import { SHAPES } from './drawings/shapes.js';
import { $, el } from './util.js';

const svg = (body) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  cursor: svg('<path d="M6 3l12 9-5.5 1.2L15 20l-2.4 1-2.6-6.6L6 18z"/>'),
  trend: svg('<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.8"/><circle cx="19" cy="5" r="1.8"/>'),
  ray: svg('<path d="M5 19L21 3"/><circle cx="5" cy="19" r="1.8"/><circle cx="12" cy="12" r="1.8"/>'),
  extended: svg('<path d="M2 22L22 2"/><circle cx="8" cy="16" r="1.8"/><circle cx="16" cy="8" r="1.8"/>'),
  hline: svg('<path d="M2 12h20"/><circle cx="12" cy="12" r="1.8"/>'),
  hray: svg('<path d="M7 12h15"/><circle cx="7" cy="12" r="1.8"/>'),
  vline: svg('<path d="M12 2v20"/><circle cx="12" cy="12" r="1.8"/>'),
  rect: svg('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  channel: svg('<path d="M3 15L15 3M9 21L21 9"/>'),
  fib: svg('<path d="M3 5h18M3 10h18M3 14h18M3 19h18" stroke-dasharray="2 0"/><path d="M5 19L19 5" stroke-dasharray="2 2"/>'),
  measure: svg('<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>'),
  text: svg('<path d="M6 5h12M12 5v14M9 19h6"/>'),
  magnet: svg('<path d="M6 4v8a6 6 0 0 0 12 0V4M6 8h4M14 8h4"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  layers: svg('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
};
const TOOLS = ['trend', 'ray', 'extended', 'hline', 'hray', 'vline', 'rect', 'channel', 'fib', 'measure', 'text'];
// Alt + key shortcuts, as in TradingView.
const SHORTCUTS = { KeyT: 'trend', KeyH: 'hline', KeyV: 'vline', KeyF: 'fib', KeyR: 'rect', KeyC: 'channel', KeyM: 'measure', KeyX: 'text' };

/**
 * @param {() => import('./chart-pane.js').ChartPane} getActive
 */
export function initDrawingToolbar(getActive) {
  const bar = $('draw-tools');
  const mgr = () => getActive()?.drawings;
  const btn = (id, title, onclick) => {
    const b = el('button', { 'data-tool': id, title, onclick });
    b.innerHTML = ICONS[id];
    return b;
  };
  const keyFor = (t) => Object.entries(SHORTCUTS).find(([, v]) => v === t)?.[0]?.slice(3);

  bar.append(
    btn('cursor', 'Cursor (Esc)', () => mgr()?.setTool(null)),
    el('span', { class: 'sep' }),
    ...TOOLS.map((t) => btn(t, SHAPES[t].label + (keyFor(t) ? ` (Alt+${keyFor(t)})` : '') + ' — hold Shift to keep drawing', () => mgr()?.setTool(mgr()?.tool === t ? null : t))),
    el('span', { class: 'sep' }),
    btn('magnet', 'Magnet: snap to open/high/low/close', () => { const m = mgr(); if (m) { m.magnet = !m.magnet; sync(); } }),
    btn('lock', 'Lock all drawings', () => { const m = mgr(); if (m) { m.lockAll = !m.lockAll; sync(); } }),
    btn('eye', 'Hide all drawings', () => { const m = mgr(); if (m) { m.hidden = !m.hidden; m.update(); sync(); } }),
    btn('trash', 'Remove all drawings on this symbol', () => mgr()?.removeAll()),
    el('span', { class: 'spacer' }),
    btn('layers', 'Objects on this chart', () => toggleObjects(getActive)),
  );

  function sync() {
    const m = mgr();
    if (!m) return;
    bar.querySelectorAll('[data-tool]').forEach((b) => {
      const id = b.dataset.tool;
      b.classList.toggle('active',
        id === 'cursor' ? !m.tool : id === 'magnet' ? m.magnet : id === 'lock' ? m.lockAll : id === 'eye' ? m.hidden : m.tool === id);
    });
    if (!$('objects').hidden) renderObjects(getActive);
  }

  document.addEventListener('keydown', (e) => {
    const t = document.activeElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t?.tagName) || t?.isContentEditable || document.querySelector('dialog[open]')) return;
    const m = mgr();
    if (!m) return;
    if (e.altKey && !e.metaKey && !e.ctrlKey && SHORTCUTS[e.code]) {
      e.preventDefault();
      m.setTool(SHORTCUTS[e.code]);
      return;
    }
    if (m.onKey(e)) e.preventDefault();
  });

  return { sync };
}

// ---------- objects list ----------

function toggleObjects(getActive) {
  const box = $('objects');
  box.hidden = !box.hidden;
  if (!box.hidden) renderObjects(getActive);
}

export function renderObjects(getActive) {
  const box = $('objects');
  const pane = getActive();
  if (box.hidden || !pane) return;
  const m = pane.drawings;
  const iconBtn = (label, title, onclick, on = false) => el('button', { class: on ? 'on' : '', title, onclick }, label);
  const rows = m.drawings.map((d) => el('div', { class: `obj-row ${d.id === m.selected ? 'sel' : ''}`, onclick: () => { m.selected = d.id; m.update(); m.emit(); } },
    el('span', { class: 'obj-dot', style: `background:${d.style.color}` }),
    el('span', { class: 'obj-name' }, SHAPES[d.type].label + (d.text ? ` “${d.text}”` : '')),
    iconBtn(d.hidden ? '◌' : '●', d.hidden ? 'Show' : 'Hide', (e) => { e.stopPropagation(); m.patch(d.id, (x) => { x.hidden = !x.hidden; }); }, d.hidden),
    iconBtn(d.locked ? '🔒' : '🔓', d.locked ? 'Unlock' : 'Lock', (e) => { e.stopPropagation(); m.patch(d.id, (x) => { x.locked = !x.locked; }); }, d.locked),
    iconBtn('×', 'Remove', (e) => { e.stopPropagation(); m.remove(d.id); })));
  const inds = pane.studies.studies.map((s) => el('div', { class: 'obj-row' },
    el('span', { class: 'obj-dot', style: `background:${s.result?.plots[0]?.color || '#787b86'}` }),
    el('span', { class: 'obj-name' }, s.title),
    iconBtn(s.cfg.hidden ? '◌' : '●', s.cfg.hidden ? 'Show' : 'Hide', () => pane.studies.update(s.cfg.uid, { hidden: !s.cfg.hidden }), s.cfg.hidden),
    iconBtn('⚙', 'Settings', () => pane.hooks.onStudySettings?.(pane.studies, s)),
    iconBtn('×', 'Remove', () => pane.studies.remove(s.cfg.uid))));
  box.replaceChildren(
    el('div', { class: 'obj-head' }, el('b', {}, `Objects — ${pane.data.symbol}`), el('button', { class: 'icon', onclick: () => { box.hidden = true; } }, '✕')),
    el('div', { class: 'obj-section' }, 'Indicators'), ...(inds.length ? inds : [el('div', { class: 'obj-empty' }, 'None')]),
    el('div', { class: 'obj-section' }, 'Drawings'), ...(rows.length ? rows : [el('div', { class: 'obj-empty' }, 'None — pick a tool on the left')]),
  );
}
