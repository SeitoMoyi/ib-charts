// Indicator picker, study settings dialog and the script editor.

import * as api from '../api.js';
import { $, confirmDialog, el } from '../util.js';
import { forgetCode, listScripts, loadCode, splitRef } from './studies.js';

const TEMPLATE = `// My indicator. Click "API" above for everything scripts can use.
indicator("My indicator", { overlay: true });

const len = input.int("Length", 20, { min: 1 });
const ma = ta.sma(close, len);

plot(ma, { title: "MA", color: "#2962ff", width: 2 });
plotshape(ta.crossover(close, ma), { shape: "arrowUp", location: "belowBar", color: "#26a69a" });
plotshape(ta.crossunder(close, ma), { shape: "arrowDown", location: "aboveBar", color: "#ef5350" });
alertcondition(ta.crossover(close, ma), { title: "Price crossed above MA" });
`;

const API_HELP = `
<h3>Script API</h3>
<p>Scripts are JavaScript. Every series (<code>close</code>, results of <code>ta.*</code>…) is an array with one value per bar, oldest first; <code>n</code> is the number of bars. Values that aren't available yet are <code>NaN</code>.</p>
<h4>Declare</h4>
<pre>indicator(title, { overlay: true|false, precision })
input.int(title, default, { min, max, step })   input.float(…)
input.bool(title, default)   input.color(title, "#hex")
input.string(title, default, { options: [...] })
input.source(title, "close")  // returns the chosen series</pre>
<h4>Data</h4>
<pre>open high low close volume time hl2 hlc3 ohlc4 n</pre>
<h4>Output</h4>
<pre>plot(series, { title, color, width, style: "line"|"step"|"histogram"|"area"|"circles", colors: [per-bar] })
hline(price, { title, color, dash: 0|1|2 })
plotshape(condition, { shape: "arrowUp"|"arrowDown"|"circle"|"square", location: "aboveBar"|"belowBar"|"inBar", color, text })
bgcolor(condition, color)          // or bgcolor(arrayOfColors)
alertcondition(condition, { title, message })   // pick it in Alerts</pre>
<h4>ta.*</h4>
<pre>sma ema rma wma hma vwma(src, len, volume)  rsi(src, len)  stdev highest lowest
change(src, len)  mom  roc  cum  crossover(a, b)  crossunder  cross
macd(src, fast, slow, signal) → { macd, signal, hist }
bb(src, len, mult) → { basis, upper, lower }
atr(len)  tr()  stoch(k, kSmooth, d) → { k, d }  vwap(src)  obv()  cci(len)  mfi(len)
dmi(len, adxLen) → { plus, minus, adx }   supertrend(factor, atrLen) → { line, direction }</pre>
<h4>Helpers</h4>
<pre>series(i => …)       build a series bar by bar
map(series, (v, i) => …)
shift(series, k)     value k bars ago (Pine's src[k])
add sub mul div      element-wise, numbers or series
na(x)  nz(x, v)  color.rgba("#hex", alpha)  Math.*</pre>
<p>Scripts run in a sandbox without network access and are stopped after 3 seconds.
They're saved as <code>.js</code> files in your data folder (<i>scripts/</i>) — edit them in any editor and the chart updates when you save.</p>`;

let getActive = () => null;
let getPanes = () => [];
let editor = null; // { cm, name, ref, dirty }

export function initScriptsUi(activeGetter, panesGetter = () => [activeGetter()]) {
  getActive = activeGetter;
  getPanes = panesGetter;
  $('ind-btn').addEventListener('click', openPicker);
  $('script-btn').addEventListener('click', () => openEditor(null));
}

// ---------- picker ----------

async function openPicker() {
  const dlg = $('ind-dialog');
  const { builtin, user } = await listScripts();
  const search = el('input', { class: 'ind-search', placeholder: 'Search', spellcheck: 'false' });
  const list = el('div', { class: 'ind-list' });
  const row = (ref, name, mine) => el('div', { class: 'ind-row', onclick: async () => { await getActive()?.addStudy(ref); toast(`Added ${name}`); } },
    el('span', {}, name),
    mine ? el('button', { class: 'small', title: 'Edit script', onclick: (e) => { e.stopPropagation(); dlg.close(); openEditor(ref); } }, 'Edit')
      : el('button', { class: 'small', title: 'Open a copy in the editor', onclick: (e) => { e.stopPropagation(); dlg.close(); openEditor(ref, { copy: true }); } }, 'Copy'));
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const f = (n) => !q || n.toLowerCase().includes(q);
    list.replaceChildren(
      el('div', { class: 'ind-section' }, 'Built-in'),
      ...builtin.filter(f).map((n) => row(`builtin:${n}`, n, false)),
      el('div', { class: 'ind-section' }, 'My scripts'),
      ...user.filter(f).map((n) => row(`user:${n}`, n, true)),
      el('div', { class: 'ind-row new', onclick: () => { dlg.close(); openEditor(null); } }, '+ New script…'));
  };
  search.addEventListener('input', render);
  render();
  dlg.replaceChildren(el('div', { class: 'gw-form' },
    el('div', { class: 'gw-head' }, el('h2', {}, 'Indicators'), el('button', { type: 'button', class: 'icon', onclick: () => dlg.close() }, '✕')),
    search, list, el('div', { id: 'ind-toast', class: 'muted' })));
  dlg.showModal();
  search.focus();
}

function toast(text) {
  const t = $('ind-toast');
  if (t) { t.textContent = text; clearTimeout(t._t); t._t = setTimeout(() => { t.textContent = ''; }, 1500); }
}

// ---------- study settings ----------

export function openStudySettings(host, study) {
  const dlg = $('study-dialog');
  const defs = study.result?.inputs || [];
  const values = { ...study.cfg.inputs };
  const field = (d) => {
    const v = values[d.title] ?? d.default;
    const set = (x) => { values[d.title] = x; };
    let input;
    if (d.type === 'bool') input = el('input', { type: 'checkbox', checked: !!v, onchange: (e) => set(e.target.checked) });
    else if (d.type === 'color') input = el('input', { type: 'color', value: v, oninput: (e) => set(e.target.value) });
    else if (d.options) input = el('select', { onchange: (e) => set(e.target.value) }, ...d.options.map((o) => el('option', { value: o, selected: o === v }, o)));
    else if (d.type === 'int' || d.type === 'float') {
      input = el('input', { type: 'number', value: v, min: d.min, max: d.max, step: d.step ?? (d.type === 'int' ? 1 : 'any'),
        oninput: (e) => set(d.type === 'int' ? parseInt(e.target.value, 10) : parseFloat(e.target.value)) });
    } else input = el('input', { value: v, oninput: (e) => set(e.target.value) });
    return el('label', { class: 'row' }, el('span', { class: 'label' }, d.title), input);
  };
  dlg.replaceChildren(el('form', { class: 'gw-form', onsubmit: (e) => { e.preventDefault(); host.update(study.cfg.uid, { inputs: values }); dlg.close(); } },
    el('div', { class: 'gw-head' }, el('h2', {}, study.title), el('button', { type: 'button', class: 'icon', onclick: () => dlg.close() }, '✕')),
    defs.length ? el('div', { class: 'inputs' }, ...defs.map(field)) : el('div', { class: 'muted' }, 'This script has no inputs.'),
    el('div', { class: 'gw-actions' },
      el('button', { type: 'button', onclick: () => { host.update(study.cfg.uid, { inputs: {} }); dlg.close(); } }, 'Reset to defaults'),
      splitRef(study.cfg.ref)[0] === 'user' ? el('button', { type: 'button', onclick: () => { dlg.close(); openEditor(study.cfg.ref); } }, 'Edit script') : null,
      el('button', { type: 'submit', class: 'primary' }, 'OK'))));
  dlg.showModal();
}

// ---------- editor ----------

async function openEditor(ref, { copy = false } = {}) {
  const box = $('editor');
  box.hidden = false;
  if (!editor) buildEditor(box);
  if (editor.dirty && !(await confirmDiscard())) return;
  let code = TEMPLATE, name = await uniqueName('My indicator');
  if (ref) {
    code = await loadCode(ref, { fresh: true });
    const [kind, n] = splitRef(ref);
    name = kind === 'user' && !copy ? n : await uniqueName(`My ${n}`);
  }
  editor.name = name;
  editor.saved = !!ref && !copy && splitRef(ref)[0] === 'user';
  editor.nameInput.value = name;
  editor.cm.setValue(code);
  editor.cm.clearHistory();
  editor.dirty = !editor.saved;
  setEditorStatus(editor.saved ? 'Saved' : 'Not saved yet');
  editor.cm.refresh();
  editor.cm.focus();
}

function confirmDiscard() {
  return confirmDialog('Discard unsaved changes to this script?', 'Discard');
}

async function uniqueName(base) {
  const existing = new Set(await api.list('scripts'));
  if (!existing.has(base)) return base;
  for (let i = 2; ; i++) if (!existing.has(`${base} ${i}`)) return `${base} ${i}`;
}

function buildEditor(box) {
  const nameInput = el('input', { class: 'ed-name', spellcheck: 'false', title: 'Script name (file name)' });
  const status = el('span', { class: 'ed-status' });
  const help = el('div', { class: 'ed-help', hidden: true });
  help.innerHTML = API_HELP;
  const host = el('div', { class: 'ed-cm' });
  box.replaceChildren(
    el('div', { class: 'ed-resize', title: 'Drag to resize' }),
    el('div', { class: 'ed-bar' },
      el('b', {}, 'Script'), nameInput,
      el('button', { onclick: () => openEditor(null) }, 'New'),
      el('button', { onclick: openScriptMenu }, 'Open ▾'),
      el('button', { class: 'primary', title: 'Save (Cmd/Ctrl+S)', onclick: () => saveScript() }, 'Save'),
      el('button', { title: 'Save and add to the chart', onclick: () => saveScript(true) }, 'Add to chart'),
      el('button', { onclick: deleteScript }, 'Delete'),
      el('button', { onclick: () => { help.hidden = !help.hidden; } }, 'API'),
      status,
      el('span', { class: 'spacer' }),
      el('button', { class: 'icon', title: 'Close editor', onclick: async () => { if (!editor.dirty || (await confirmDiscard())) box.hidden = true; } }, '✕')),
    el('div', { class: 'ed-main' }, host, help));

  const cm = window.CodeMirror(host, {
    mode: 'javascript', theme: 'ibc', lineNumbers: true, tabSize: 2, indentUnit: 2,
    matchBrackets: true, autoCloseBrackets: true,
    extraKeys: { 'Cmd-S': () => saveScript(), 'Ctrl-S': () => saveScript(), 'Cmd-/': 'toggleComment', 'Ctrl-/': 'toggleComment', Tab: (c) => c.execCommand('insertSoftTab') },
  });
  cm.on('change', () => { editor.dirty = true; setEditorStatus('Unsaved changes'); clearErrorMark(); });
  editor = { cm, nameInput, status, dirty: false, saved: false, name: '' };

  // Drag the top edge to resize.
  const handle = box.querySelector('.ed-resize');
  handle.addEventListener('pointerdown', (e) => {
    const startY = e.clientY, startH = box.offsetHeight;
    const move = (ev) => { box.style.height = `${Math.max(160, Math.min(window.innerHeight - 200, startH + startY - ev.clientY))}px`; cm.refresh(); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

async function openScriptMenu(e) {
  const { builtin, user } = await listScripts();
  const menu = el('div', { class: 'ed-menu' },
    el('div', { class: 'ind-section' }, 'My scripts'),
    ...(user.length ? user.map((n) => el('div', { class: 'ind-row', onclick: () => { menu.remove(); openEditor(`user:${n}`); } }, n)) : [el('div', { class: 'obj-empty' }, 'None yet')]),
    el('div', { class: 'ind-section' }, 'Built-in (opens a copy)'),
    ...builtin.map((n) => el('div', { class: 'ind-row', onclick: () => { menu.remove(); openEditor(`builtin:${n}`, { copy: true }); } }, n)));
  const r = e.target.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
  document.body.append(menu);
  setTimeout(() => document.addEventListener('pointerdown', (ev) => { if (!menu.contains(ev.target)) menu.remove(); }, { once: true }), 0);
}

async function saveScript(addToChart = false) {
  const name = editor.nameInput.value.trim();
  if (!name) return setEditorStatus('Give the script a name', true);
  const code = editor.cm.getValue();
  const renamed = editor.saved && name !== editor.name;
  try {
    await api.save('scripts', name, code);
    if (renamed) await api.remove('scripts', editor.name);
  } catch (e) {
    return setEditorStatus(e.message, true);
  }
  editor.name = name;
  editor.saved = true;
  editor.dirty = false;
  forgetCode(`user:${name}`);
  const pane = getActive();
  for (const p of getPanes()) await p?.studies.reloadScript(`user:${name}`);
  if (addToChart) await pane?.addStudy(`user:${name}`);
  // Report the first error from a study using this script, if any.
  const err = pane?.studies.studies.find((s) => s.cfg.ref === `user:${name}` && s.error)?.error;
  if (err) {
    setEditorStatus(`Saved — error: ${err}`, true);
    const m = err.match(/^line (\d+)/);
    if (m) markErrorLine(Number(m[1]));
  } else setEditorStatus(addToChart ? 'Saved and added to chart' : 'Saved');
}

async function deleteScript() {
  if (!editor.saved) { $('editor').hidden = true; return; }
  if (!(await confirmDialog(`Delete script "${editor.name}"?`, 'Delete'))) return;
  await api.remove('scripts', editor.name);
  editor.saved = false;
  editor.dirty = true;
  setEditorStatus('Deleted (still open here)');
}

function setEditorStatus(text, isErr = false) {
  if (!editor) return;
  editor.status.textContent = text;
  editor.status.className = `ed-status ${isErr ? 'err' : ''}`;
}

function markErrorLine(line) {
  clearErrorMark();
  editor.errLine = editor.cm.addLineClass(line - 1, 'background', 'cm-error-line');
  editor.cm.scrollIntoView({ line: line - 1, ch: 0 }, 80);
}

function clearErrorMark() {
  if (editor?.errLine) { editor.cm.removeLineClass(editor.errLine, 'background', 'cm-error-line'); editor.errLine = null; }
}

/** A script file changed on disk (e.g. saved from VS Code). */
export async function onScriptFileChanged(name) {
  forgetCode(`user:${name}`);
  for (const p of getPanes()) await p?.studies.reloadScript(`user:${name}`);
  if (editor && editor.saved && editor.name === name && !editor.dirty) {
    const code = await loadCode(`user:${name}`, { fresh: true });
    if (code !== editor.cm.getValue()) {
      const cursor = editor.cm.getCursor();
      editor.cm.setValue(code);
      editor.cm.setCursor(cursor);
      editor.dirty = false;
      setEditorStatus('Reloaded from disk');
    }
  }
}
