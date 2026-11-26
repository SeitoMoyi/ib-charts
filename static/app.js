'use strict';

const LWC = LightweightCharts;
const $ = (id) => document.getElementById(id);
const UP = '#26a69a', DOWN = '#ef5350';

// ---------- persisted settings ----------
const saved = JSON.parse(localStorage.getItem('ib-charts') || '{}');
const state = {
  symbol: saved.symbol || 'AAPL',
  tf: saved.tf || '5m',
  rth: saved.rth ?? false,
  ind: saved.ind || { sma20: true, sma50: false, ema200: false, vwap: false, rsi: false },
};
const persist = () => localStorage.setItem('ib-charts', JSON.stringify(state));

// ---------- chart ----------
const chart = LWC.createChart($('chart'), {
  autoSize: true,
  layout: {
    background: { type: 'solid', color: '#131722' },
    textColor: '#d1d4dc',
    fontSize: 12,
    panes: { separatorColor: '#2a2e39', separatorHoverColor: '#2a2e39' },
  },
  grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
  crosshair: { mode: LWC.CrosshairMode.Normal },
  rightPriceScale: { borderColor: '#2a2e39' },
  timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false, rightOffset: 8 },
});

const candles = chart.addSeries(LWC.CandlestickSeries, {
  upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
});
const volume = chart.addSeries(LWC.HistogramSeries, {
  priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false,
});
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

const INDICATORS = {
  sma20: { color: '#f7c948', calc: (b) => sma(b, 20) },
  sma50: { color: '#2196f3', calc: (b) => sma(b, 50) },
  ema200: { color: '#e040fb', calc: (b) => ema(b, 200) },
  vwap: { color: '#ff9800', calc: (b) => (current.intraday && current.hasVolume ? vwap(b) : []) },
  rsi: { color: '#7e57c2', calc: (b) => rsi(b, 14), pane: 1 },
};
const lines = {}; // indicator id -> series

// ---------- current data ----------
let current = { seq: 0, bars: [], intraday: true, hasVolume: true, symbol: '', description: '' };

// IB sends UTC; Lightweight Charts has no time zones, so shift intraday bars to local time.
const toChartTime = (t) => (current.intraday ? t - new Date(t * 1000).getTimezoneOffset() * 60 : t);

function volBar(b) {
  return { time: b.time, value: b.volume ?? 0, color: b.close >= b.open ? 'rgba(38,166,154,.45)' : 'rgba(239,83,80,.45)' };
}

function setPrecision(minTick) {
  // Decimal places of the contract's tick size: 0.01 -> 2, 0.005 -> 3, 0.00005 -> 5, 0.03125 -> 5.
  const decimals = minTick > 0 ? (minTick.toFixed(10).replace(/0+$/, '').split('.')[1] || '').length : 2;
  const precision = Math.min(8, Math.max(2, decimals));
  candles.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
  current.precision = precision;
}

function renderAll() {
  const b = current.bars;
  candles.setData(b);
  volume.setData(current.hasVolume ? b.map(volBar) : []);
  for (const id of Object.keys(INDICATORS)) renderIndicator(id);
  updateLegend();
}

function renderIndicator(id) {
  const def = INDICATORS[id];
  if (!state.ind[id]) {
    if (lines[id]) { chart.removeSeries(lines[id]); delete lines[id]; }
    return;
  }
  if (!lines[id]) {
    lines[id] = chart.addSeries(LWC.LineSeries, {
      color: def.color, lineWidth: id === 'rsi' ? 1.5 : 1.5, priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerVisible: false, title: id.toUpperCase(),
    }, def.pane || 0);
    if (id === 'rsi') {
      lines[id].createPriceLine({ price: 70, color: '#787b86', lineStyle: LWC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      lines[id].createPriceLine({ price: 30, color: '#787b86', lineStyle: LWC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      const pane = chart.panes()[1];
      if (pane) pane.setHeight(140);
    }
  }
  lines[id].setData(def.calc(current.bars));
}

function applyLiveBar(raw) {
  const bar = { ...raw, time: toChartTime(raw.time) };
  const bars = current.bars;
  const last = bars[bars.length - 1];
  if (last && bar.time < last.time) return; // stale
  if (last && bar.time === last.time) bars[bars.length - 1] = bar; else bars.push(bar);

  candles.update(bar);
  if (current.hasVolume) volume.update(volBar(bar));
  // Recompute indicators over a short tail; only the last point changes.
  const tail = bars.slice(-400);
  for (const id of Object.keys(lines)) {
    const pts = INDICATORS[id].calc(id === 'vwap' ? bars : tail);
    if (pts.length) lines[id].update(pts[pts.length - 1]);
  }
  if (!hovering) updateLegend();
}

// ---------- legend ----------
let hovering = false;
function fmt(v) { return v == null ? '–' : v.toFixed(current.precision ?? 2); }
function fmtVol(v) {
  if (v == null) return '';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}
function updateLegend(bar) {
  const bars = current.bars;
  bar = bar || bars[bars.length - 1];
  $('legend-symbol').textContent = current.symbol;
  $('legend-desc').textContent = current.description;
  if (!bar) { $('legend-ohlc').innerHTML = ''; return; }
  const i = bars.findIndex((b) => b.time === bar.time);
  const prev = i > 0 ? bars[i - 1].close : bar.open;
  const chg = bar.close - prev, pct = prev ? (chg / prev) * 100 : 0;
  const cls = chg >= 0 ? 'up' : 'down';
  const vol = current.hasVolume && bar.volume != null ? `<span class="k">V</span> ${fmtVol(bar.volume)}` : '';
  $('legend-ohlc').innerHTML =
    `<span class="k">O</span> <span class="${cls}">${fmt(bar.open)}</span>` +
    `<span class="k">H</span> <span class="${cls}">${fmt(bar.high)}</span>` +
    `<span class="k">L</span> <span class="${cls}">${fmt(bar.low)}</span>` +
    `<span class="k">C</span> <span class="${cls}">${fmt(bar.close)}</span>` +
    ` <span class="${cls}">${chg >= 0 ? '+' : ''}${fmt(chg)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span> ${vol}`;
}
chart.subscribeCrosshairMove((p) => {
  const d = p.time !== undefined ? p.seriesData.get(candles) : null;
  hovering = !!d;
  updateLegend(d ? current.bars.find((b) => b.time === d.time) || d : null);
});

// ---------- indicators ----------
function sma(bars, n) {
  const out = []; let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: bars[i].time, value: sum / n });
  }
  return out;
}
function ema(bars, n) {
  const out = [], k = 2 / (n + 1); let e;
  for (let i = 0; i < bars.length; i++) {
    e = e === undefined ? bars[i].close : bars[i].close * k + e * (1 - k);
    if (i >= n - 1) out.push({ time: bars[i].time, value: e });
  }
  return out;
}
function rsi(bars, n) {
  const out = []; let gain = 0, loss = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) { gain += g / n; loss += l / n; } else { gain = (gain * (n - 1) + g) / n; loss = (loss * (n - 1) + l) / n; }
    if (i >= n) out.push({ time: bars[i].time, value: loss === 0 ? 100 : 100 - 100 / (1 + gain / loss) });
  }
  return out;
}
function vwap(bars) {
  // Resets each (local) calendar day.
  const out = []; let day = null, pv = 0, vol = 0;
  for (const b of bars) {
    const d = Math.floor(b.time / 86400);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const v = b.volume || 0;
    pv += ((b.high + b.low + b.close) / 3) * v; vol += v;
    if (vol > 0) out.push({ time: b.time, value: pv / vol });
  }
  return out;
}

// ---------- status ----------
function setStatus(text, kind = '') {
  $('status-text').textContent = text;
  $('status').className = kind === 'err' ? 'err' : '';
  $('dot').className = kind;
  $('status').title = text;
}

// ---------- websocket ----------
let ws, retryMs = 1000, retryTimer;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { retryMs = 1000; subscribe(); };
  ws.onclose = () => {
    setStatus('Disconnected from ib-charts server — retrying…', 'err');
    setTimeout(connect, retryMs); retryMs = Math.min(retryMs * 2, 15000);
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.seq !== current.seq) return; // reply to an older request
    switch (m.type) {
      case 'status': setStatus(m.message); break;
      case 'history': {
        current.intraday = m.intraday;
        current.hasVolume = m.hasVolume;
        current.symbol = m.symbol;
        current.description = m.description;
        current.bars = m.bars.map((b) => ({ ...b, time: toChartTime(b.time) }));
        document.title = `${m.symbol} · IB Charts`;
        setPrecision(m.minTick);
        renderAll();
        chart.timeScale().applyOptions({ timeVisible: m.intraday });
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, current.bars.length - 150), to: current.bars.length + 8 });
        setStatus(`${m.symbol} ${state.tf} · live`, 'live');
        break;
      }
      case 'bar': applyLiveBar(m.bar); break;
      case 'error': setStatus(m.message, 'err'); break;
      case 'ended':
        // Usually the Gateway restarted or dropped the stream: resubscribe shortly.
        setStatus('Stream ended — resubscribing…', 'err');
        clearTimeout(retryTimer); retryTimer = setTimeout(subscribe, 5000);
        break;
    }
  };
}

function subscribe() {
  clearTimeout(retryTimer);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  current.seq += 1;
  ws.send(JSON.stringify({ type: 'subscribe', seq: current.seq, symbol: state.symbol, tf: state.tf, rth: state.rth }));
  persist();
  syncToolbar();
}

// ---------- toolbar ----------
function syncToolbar() {
  $('symbol').value = state.symbol;
  document.querySelectorAll('[data-tf]').forEach((b) => b.classList.toggle('active', b.dataset.tf === state.tf));
  document.querySelectorAll('[data-ind]').forEach((b) => b.classList.toggle('active', !!state.ind[b.dataset.ind]));
  $('rth').classList.toggle('active', state.rth);
}

document.querySelectorAll('[data-tf]').forEach((b) => b.addEventListener('click', () => { state.tf = b.dataset.tf; subscribe(); }));
document.querySelectorAll('[data-ind]').forEach((b) => b.addEventListener('click', () => {
  const id = b.dataset.ind;
  state.ind[id] = !state.ind[id];
  renderIndicator(id); persist(); syncToolbar();
}));
$('rth').addEventListener('click', () => { state.rth = !state.rth; subscribe(); });

// ---------- symbol box + search ----------
const input = $('symbol'), list = $('suggestions');
let hits = [], sel = -1, searchTimer, searchSeq = 0;

function chooseSymbol(sym) {
  sym = sym.trim().toUpperCase();
  list.hidden = true;
  input.blur();
  if (!sym) { input.value = state.symbol; return; }
  state.symbol = sym;
  subscribe();
}

function renderHits() {
  list.innerHTML = '';
  hits.forEach((h, i) => {
    const li = document.createElement('li');
    if (i === sel) li.className = 'sel';
    li.innerHTML = '<span class="sym"></span><span class="meta"></span>';
    li.firstChild.textContent = h.input;
    li.lastChild.textContent = [h.kind, h.exchange, h.currency].filter(Boolean).join(' · ');
    li.addEventListener('mousedown', (e) => { e.preventDefault(); chooseSymbol(h.input); });
    list.appendChild(li);
  });
  list.hidden = hits.length === 0;
}

input.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = input.value.trim();
  // Only plain tickers are searchable; special syntax (/ES, EUR.USD, ^SPX…) is typed directly.
  if (!q || /[\/^$.:]/.test(q)) { hits = []; renderHits(); return; }
  searchTimer = setTimeout(async () => {
    const my = ++searchSeq;
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (!r.ok || my !== searchSeq) return;
      hits = (await r.json()).slice(0, 12); sel = -1; renderHits();
    } catch { /* ignore */ }
  }, 400); // IB allows roughly one symbol search per second
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!hits.length) return;
    sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length; renderHits();
  } else if (e.key === 'Enter') {
    chooseSymbol(sel >= 0 ? hits[sel].input : input.value);
  } else if (e.key === 'Escape') {
    list.hidden = true; input.value = state.symbol; input.blur();
  }
});
input.addEventListener('focus', () => input.select());
input.addEventListener('blur', () => { list.hidden = true; if (!input.value.trim()) input.value = state.symbol; });

// Start typing anywhere to change symbol, TradingView-style.
document.addEventListener('keydown', (e) => {
  if (document.activeElement === input || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^[a-zA-Z0-9\/^$]$/.test(e.key)) { input.focus(); input.value = ''; }
});

syncToolbar();
connect();
