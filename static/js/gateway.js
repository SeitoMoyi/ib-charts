// Gateway status pill + setup / control dialog.

import { $, el, fill } from './util.js';

const PHASE = {
  offline: ['Gateway offline', ''],
  starting: ['Starting Gateway…', 'busy'],
  loggingIn: ['Logging in…', 'busy'],
  twoFactor: ['Approve on phone', 'warn'],
  connected: ['Gateway', 'live'],
  stopping: ['Stopping…', 'busy'],
  error: ['Gateway error', 'err'],
};
const KEYCHAIN = { macos: 'macOS Keychain', windows: 'Windows Credential Manager', linux: 'system keyring' };

let status = null;
let info = null; // last GET /api/gateway
let logTimer = null;

export function initGateway(feed) {
  const pill = $('gw-pill');
  pill.addEventListener('click', openDialog);
  feed.onGlobal((m) => {
    if (m.type !== 'gateway') return;
    const prev = status?.phase;
    status = m.status;
    renderPill();
    renderStatus();
    // Charts that failed while Gateway was down retry as soon as it's back.
    if (prev && prev !== 'connected' && status.phase === 'connected') feed.resubscribeAll();
  });

  // First run: offer setup if nothing is configured and no Gateway is reachable.
  setTimeout(async () => {
    info = await fetchInfo();
    if (info && !info.settings.configured && info.status.phase !== 'connected') openDialog();
  }, 3000);
}

async function fetchInfo() {
  try {
    const r = await fetch('/api/gateway');
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

function renderPill() {
  const [label, kind] = PHASE[status.phase] || [status.phase, ''];
  const pill = $('gw-pill');
  pill.querySelector('.gw-dot').className = `gw-dot ${kind}`;
  pill.querySelector('.gw-label').textContent = label;
  pill.title = `${status.message}\nClick for Gateway settings`;
}

function renderStatus() {
  const box = $('gw-status');
  if (!box || !status) return;
  const [, kind] = PHASE[status.phase] || [];
  box.className = `gw-status ${kind}`;
  box.textContent = status.message;
  const managedMode = status.mode !== 'external';
  $('gw-start').hidden = !managedMode || ['connected', 'starting', 'loggingIn', 'twoFactor'].includes(status.phase);
  $('gw-stop').hidden = !managedMode || !status.managed;
  $('gw-restart').hidden = !managedMode || !status.managed;
}

// ---------- dialog ----------

async function openDialog() {
  info = (await fetchInfo()) || info;
  if (!info) return;
  const dlg = $('gw-dialog');
  fill(dlg, buildForm(info));
  renderStatus();
  dlg.showModal();
  refreshLog();
  clearInterval(logTimer);
  logTimer = setInterval(refreshLog, 2000);
  dlg.addEventListener('close', () => clearInterval(logTimer), { once: true });
}

function buildForm(info) {
  const s = info.settings;
  const keychain = KEYCHAIN[info.platform] || 'system keyring';
  const radio = (value, title, desc) =>
    el('label', { class: 'gw-mode' },
      el('input', { type: 'radio', name: 'mode', value, checked: s.mode === value }),
      el('div', {}, el('b', {}, title), el('div', { class: 'muted' }, desc)));

  const installSel = el('select', { name: 'installDir' },
    el('option', { value: '' }, info.installs.length ? `Newest found (${info.installs[0].version})` : 'Not found'),
    ...info.installs.map((g) => el('option', { value: g.dir, selected: s.installDir === g.dir }, `${g.version} — ${g.dir}`)));

  const ibcRow = el('div', { class: 'row', id: 'gw-ibc-row' },
    el('span', { class: 'label' }, 'IBC'),
    el('span', {}, info.ibcVersion ? `IBC ${info.ibcVersion} installed` : 'Not installed yet (downloaded automatically on first start)'),
    el('button', { type: 'button', class: 'small', onclick: installIbc }, info.ibcVersion ? 'Update' : 'Install now'));

  const form = el('form', { method: 'dialog', class: 'gw-form', onsubmit: (e) => { e.preventDefault(); save(form); } },
    el('div', { class: 'gw-head' },
      el('h2', {}, 'IB Gateway'),
      el('button', { type: 'button', class: 'icon', title: 'Close', onclick: () => $('gw-dialog').close() }, '✕')),
    el('div', { class: 'gw-statusbar' },
      el('div', { id: 'gw-status', class: 'gw-status' }),
      el('button', { type: 'button', id: 'gw-start', onclick: () => post('start') }, 'Start'),
      el('button', { type: 'button', id: 'gw-restart', onclick: () => post('restart') }, 'Restart'),
      el('button', { type: 'button', id: 'gw-stop', onclick: () => post('stop') }, 'Stop')),

    el('fieldset', {},
      el('legend', {}, 'How should IB Charts handle Gateway?'),
      radio('auto', 'Log in automatically', `Starts Gateway and logs in with IBC. Your password is kept in the ${keychain}. You still approve the login on your phone (IBKR Mobile).`),
      radio('manual', 'Open Gateway, I log in', 'Starts the Gateway app; you type your login.'),
      radio('external', 'I start Gateway myself', 'IB Charts just connects to a running Gateway or TWS.')),

    el('fieldset', { class: 'gw-login' },
      el('legend', {}, 'Login'),
      el('div', { class: 'row' }, el('span', { class: 'label' }, 'Account'),
        el('select', { name: 'tradingMode' },
          el('option', { value: 'live', selected: s.tradingMode === 'live' }, 'Live (port 4001)'),
          el('option', { value: 'paper', selected: s.tradingMode === 'paper' }, 'Paper (port 4002)'))),
      el('div', { class: 'row auto-only' }, el('span', { class: 'label' }, 'Username'),
        el('input', { name: 'username', value: s.username, autocomplete: 'username', spellcheck: 'false' })),
      el('div', { class: 'row auto-only' }, el('span', { class: 'label' }, 'Password'),
        el('input', { name: 'password', type: 'password', autocomplete: 'current-password',
          placeholder: info.hasPassword ? `Saved in ${keychain} — type to replace` : 'Not saved yet' })),
      el('div', { class: 'row' }, el('span', { class: 'label' }, 'Gateway'), installSel),
      info.installs.length ? null : el('div', { class: 'hint' }, 'Install the ',
        el('a', { href: 'https://www.interactivebrokers.com/en/trading/ibgateway-stable.php', target: '_blank' }, 'offline IB Gateway'),
        ' (not the auto-updating one) — IBC needs it.'),
      el('div', { class: 'auto-only' }, ibcRow)),

    el('details', {},
      el('summary', {}, 'Advanced'),
      el('div', { class: 'row' }, el('span', { class: 'label' }, 'API port'),
        el('input', { name: 'apiPort', type: 'number', min: 1, max: 65535, placeholder: 'default', value: s.apiPort ?? '' })),
      el('div', { class: 'row' }, el('span', { class: 'label' }, 'IBC command port'),
        el('input', { name: 'commandPort', type: 'number', min: 1, max: 65535, value: s.commandPort })),
      el('label', { class: 'row check' },
        el('input', { type: 'checkbox', name: 'quitOnExit', checked: s.quitOnExit }),
        'Quit Gateway when IB Charts quits (only a Gateway that IB Charts started)')),

    el('div', { class: 'gw-actions' },
      el('span', { id: 'gw-msg', class: 'muted' }),
      el('button', { type: 'submit', class: 'primary' }, 'Save')),

    el('details', { class: 'gw-log-box' },
      el('summary', {}, 'Gateway log'),
      el('pre', { id: 'gw-log' })),
  );

  const syncMode = () => {
    const mode = form.querySelector('input[name=mode]:checked')?.value;
    form.querySelectorAll('.auto-only').forEach((e) => (e.hidden = mode !== 'auto'));
    form.querySelector('.gw-login').hidden = mode === 'external';
  };
  form.addEventListener('change', syncMode);
  syncMode();
  return form;
}

async function save(form) {
  const f = new FormData(form);
  const settings = {
    ...info.settings,
    mode: f.get('mode'),
    tradingMode: f.get('tradingMode') || info.settings.tradingMode,
    username: (f.get('username') ?? info.settings.username).trim(),
    installDir: f.get('installDir') || null,
    apiPort: f.get('apiPort') ? Number(f.get('apiPort')) : null,
    commandPort: Number(f.get('commandPort')) || 7462,
    quitOnExit: f.get('quitOnExit') === 'on',
  };
  const password = f.get('password') || null;
  if (settings.mode === 'auto' && !settings.username) return msg('Enter your IB username.', true);
  if (settings.mode === 'auto' && !password && !info.hasPassword) return msg('Enter your IB password.', true);
  msg('Saving…');
  const r = await fetch('/api/gateway/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings, password }),
  });
  if (!r.ok) return msg(await r.text(), true);
  info = await fetchInfo();
  form.querySelector('input[name=password]').value = '';
  form.querySelector('input[name=password]').placeholder = info.hasPassword ? 'Saved — type to replace' : 'Not saved yet';
  msg('Saved.');
}

async function post(action) {
  const r = await fetch(`/api/gateway/${action}`, { method: 'POST' });
  if (!r.ok) msg(await r.text(), true);
}

async function installIbc(e) {
  const btn = e.target;
  btn.disabled = true;
  msg('Downloading IBC…');
  const r = await fetch('/api/gateway/install-ibc', { method: 'POST' });
  btn.disabled = false;
  if (!r.ok) return msg(await r.text(), true);
  const { ibcVersion } = await r.json();
  info.ibcVersion = ibcVersion;
  $('gw-ibc-row').children[1].textContent = `IBC ${ibcVersion} installed`;
  msg(`Installed IBC ${ibcVersion}.`);
}

function msg(text, isErr = false) {
  const m = $('gw-msg');
  m.textContent = text;
  m.className = isErr ? 'err' : 'muted';
}

async function refreshLog() {
  const pre = $('gw-log');
  if (!pre || !pre.closest('details').open) return;
  const r = await fetch('/api/gateway/log');
  if (!r.ok) return;
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent = (await r.json()).join('\n') || '(empty)';
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
