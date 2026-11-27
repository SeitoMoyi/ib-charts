// Workflow tools: bar replay controls, data window, screenshots, saved layouts,
// indicator templates and the keyboard-shortcut reference.

import * as api from './api.js';
import { $, confirmDialog, el, fill } from './util.js';

// ---------- bar replay ----------

/** Toolbar button → pick a start bar on the chart → floating playback controls. */
export function initReplay(getActive) {
  const bar = el('div', { id: 'replay-bar', hidden: true });
  document.body.append(bar);
  let picking = null;

  const render = () => {
    const pane = getActive();
    const r = pane?.replay;
    $('replay-btn').classList.toggle('active', !!r || !!picking);
    if (picking) {
      bar.hidden = false;
      fill(bar, el('span', {}, 'Click on the chart where the replay should start'), el('button', { onclick: cancelPick }, 'Cancel'));
      return;
    }
    bar.hidden = !r;
    if (!r) return;
    const at = r.all[r.index];
    fill(bar, 
      el('b', {}, 'Replay'),
      el('button', { title: 'Pick a new start', onclick: () => pick() }, '⏮'),
      el('button', { title: r.playing ? 'Pause' : 'Play', class: 'primary', onclick: () => pane.replayPlay(!r.playing) }, r.playing ? '⏸' : '▶'),
      el('button', { title: 'Next bar (→)', onclick: () => pane.replayStep() }, '⏭'),
      el('select', { title: 'Speed', onchange: (e) => pane.replaySpeed(Number(e.target.value)) },
        ...[0.5, 1, 2, 5, 10].map((s) => el('option', { value: s, selected: s === r.speed }, `${s} bar/s`))),
      el('span', { class: 'muted' }, `${pane.formatTime(at.time)} · ${r.all.length - 1 - r.index} bars left`),
      el('button', { title: 'Back to live', onclick: () => pane.stopReplay() }, '✕ Exit'));
  };

  const pick = () => {
    const pane = getActive();
    if (!pane?.data.bars.length) return;
    if (pane.replay?.playing) pane.replayPlay(false);
    picking = (e) => {
      const r = pane.chartEl.getBoundingClientRect();
      const logical = pane.chart.timeScale().coordinateToLogical(e.clientX - r.left);
      e.stopPropagation();
      e.preventDefault();
      cancelPick();
      if (logical != null) pane.startReplay(Math.round(logical));
    };
    pane.chartEl.addEventListener('pointerdown', picking, { capture: true, once: true });
    pane.chartEl.classList.add('picking');
    render();
  };

  const cancelPick = () => {
    const pane = getActive();
    if (picking) pane?.chartEl.removeEventListener('pointerdown', picking, { capture: true });
    pane?.chartEl.classList.remove('picking');
    picking = null;
    render();
  };

  $('replay-btn').addEventListener('click', () => {
    const pane = getActive();
    if (pane?.replay) pane.stopReplay();
    else if (picking) cancelPick();
    else pick();
  });
  document.addEventListener('keydown', (e) => {
    const pane = getActive();
    if (!pane?.replay || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); e.stopPropagation(); pane.replayStep(); }
    if (e.key === ' ') { e.preventDefault(); pane.replayPlay(!pane.replay.playing); }
  }, true);
  return { render };
}

// ---------- data window ----------

export function renderDataWindow(pane, bar) {
  const box = $('datawin');
  if (!box || box.hidden || !pane) return;
  const bars = pane.data.bars;
  bar = bar || bars.at(-1);
  if (!bar) { fill(box, el('div', { class: 'obj-empty' }, 'No data')); return; }
  const i = bars.indexOf(bar);
  const f = (v, p = pane.data.precision) => (Number.isFinite(v) ? v.toFixed(p) : '–');
  const prev = i > 0 ? bars[i - 1].close : bar.open;
  const row = (k, v, color) => el('div', { class: 'dw-row' }, el('span', { class: 'muted' }, k), el('span', { style: color ? `color:${color}` : '' }, v));
  const sections = [
    el('div', { class: 'dw-head' }, `${pane.data.symbol} · ${pane.state.tf}`),
    row('Time', pane.formatTime(bar.time)),
    row('Open', f(bar.open)), row('High', f(bar.high)), row('Low', f(bar.low)), row('Close', f(bar.close)),
    row('Change', `${f(bar.close - prev)} (${(((bar.close - prev) / prev) * 100).toFixed(2)}%)`, bar.close >= prev ? 'var(--up)' : 'var(--down)'),
    bar.volume != null ? row('Volume', Math.round(bar.volume).toLocaleString()) : null,
  ];
  for (const s of pane.studies.studies) {
    if (!s.result || s.cfg.hidden) continue;
    sections.push(el('div', { class: 'dw-head' }, s.title));
    for (const p of s.result.plots) sections.push(row(p.title, f(p.values[i], s.result.meta.precision ?? 4), p.colors?.[i] || p.color));
  }
  fill(box, ...sections);
}

// ---------- screenshot ----------

/** Renders the chart with its title into a PNG blob. */
async function chartImage(pane) {
  const shot = pane.chart.takeScreenshot();
  const header = 34;
  const canvas = document.createElement('canvas');
  canvas.width = shot.width;
  canvas.height = shot.height + header;
  const ctx = canvas.getContext('2d');
  const dark = document.documentElement.dataset.theme !== 'light';
  ctx.fillStyle = dark ? '#131722' : '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(shot, 0, header);
  ctx.fillStyle = dark ? '#d1d4dc' : '#131722';
  ctx.font = '600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const last = pane.data.bars.at(-1);
  ctx.fillText(`${pane.data.symbol} · ${pane.state.tf}${last ? ` · ${last.close.toFixed(pane.data.precision)}` : ''}`, 12, 22);
  ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#787b86';
  ctx.fillText(`${new Date().toLocaleString()} · IB Charts (TradingView Lightweight Charts)`, canvas.width - 12, 22);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export async function copyScreenshot(pane, toast) {
  const blob = await chartImage(pane);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Chart image copied to the clipboard');
  } catch {
    await saveScreenshot(pane, toast, blob);
  }
}

export async function saveScreenshot(pane, toast, blob = null) {
  blob ||= await chartImage(pane);
  const name = `IB Charts ${pane.data.symbol} ${pane.state.tf} ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`;
  const r = await fetch(`/api/screenshot?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
  if (r.ok) toast(`Saved to ${(await r.json()).path}`);
  else toast(`Could not save the image: ${await r.text()}`);
}

// ---------- saved layouts ----------

export async function layoutsMenuItems(layout, close, onLoaded) {
  const names = await api.list('layouts');
  const input = el('input', { class: 'menu-input', placeholder: 'Save current layout as…', spellcheck: 'false' });
  input.addEventListener('keydown', async (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && input.value.trim()) {
      await api.save('layouts', input.value.trim(), layout.serialize());
      close();
    }
  });
  return [
    el('div', { class: 'menu-title' }, 'Saved layouts'), input,
    ...names.map((n) => el('div', { class: 'menu-item', onclick: async () => { onLoaded(await api.load('layouts', n)); close(); } }, n,
      el('button', { class: 'small right', title: 'Delete', onclick: async (e) => { e.stopPropagation(); if (await confirmDialog(`Delete layout "${n}"?`, 'Delete')) { await api.remove('layouts', n); close(); } } }, '×'))),
  ];
}

// ---------- indicator templates ----------

export async function templateSection(getActive, closeDialog, toast) {
  const names = await api.list('templates');
  const input = el('input', { class: 'ind-search', placeholder: 'Save this chart\'s indicators as a template…', spellcheck: 'false' });
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    const pane = getActive();
    await api.save('templates', input.value.trim(), pane.studies.configs().map(({ uid, ...c }) => c));
    toast(`Saved template "${input.value.trim()}"`);
    input.value = '';
    closeDialog();
  });
  return [
    el('div', { class: 'ind-section' }, 'Templates'),
    ...names.map((n) => el('div', { class: 'ind-row', onclick: async () => {
      const list = await api.load('templates', n, []);
      const pane = getActive();
      await pane.studies.setConfigs(list.map((c, i) => ({ ...c, uid: `t${Date.now()}${i}` })));
      pane.studiesChanged();
      toast(`Applied template "${n}"`);
    } }, el('span', {}, n),
    el('button', { class: 'small', onclick: async (e) => { e.stopPropagation(); if (await confirmDialog(`Delete template "${n}"?`, 'Delete')) { await api.remove('templates', n); closeDialog(); } } }, 'Delete'))),
    input,
  ];
}

// ---------- shortcuts ----------

export const SHORTCUTS = [
  ['Type letters', 'Change symbol'],
  ['Type a number (15, 2h, D)', 'Change timeframe'],
  ['↑ / ↓', 'Previous / next watchlist symbol'],
  ['Alt+T  H  V  F  R  C  M  X', 'Trend line, horizontal, vertical, Fib, rectangle, channel, measure, text'],
  ['Shift while drawing', 'Keep the drawing tool'],
  ['Esc', 'Cancel drawing / deselect'],
  ['Del / Backspace', 'Delete the selected drawing'],
  ['Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z', 'Undo / redo drawings'],
  ['Alt+A', 'Create alert'],
  ['Alt+S', 'Copy chart image'],
  ['Space, Shift+→ (in replay)', 'Play/pause, next bar'],
  ['Cmd/Ctrl+S (editor)', 'Save script'],
  ['?', 'This list'],
];

export function showShortcuts() {
  const dlg = $('help-dialog');
  fill(dlg, el('div', { class: 'gw-form' },
    el('div', { class: 'gw-head' }, el('h2', {}, 'Keyboard shortcuts'), el('button', { class: 'icon', onclick: () => dlg.close() }, '✕')),
    el('div', { class: 'shortcuts' }, ...SHORTCUTS.flatMap(([k, v]) => [el('kbd', {}, k), el('span', {}, v)]))));
  dlg.showModal();
}
