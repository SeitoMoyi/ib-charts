// WebSocket market-data feed. Multiplexes any number of subscriptions (one per chart)
// over a single connection and transparently resubscribes after reconnects.

export class Feed {
  constructor() {
    this.subs = new Map(); // id -> { params, handler, seq }
    this.seq = 0;
    this.retryMs = 1000;
    this.connListeners = new Set();
    this.globalListeners = new Set();
    this.connect();
  }

  onConnection(cb) {
    this.connListeners.add(cb);
  }

  /** Messages not tied to a subscription (e.g. Gateway status). */
  onGlobal(cb) {
    this.globalListeners.add(cb);
  }

  resubscribeAll() {
    for (const id of this.subs.keys()) this.send(id);
  }

  connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 1000;
      this.connListeners.forEach((cb) => cb(true));
      for (const id of this.subs.keys()) this.send(id);
    };
    ws.onclose = () => {
      this.connListeners.forEach((cb) => cb(false));
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 15000);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === undefined) { this.globalListeners.forEach((cb) => cb(m)); return; }
      const sub = this.subs.get(m.id);
      if (!sub || sub.seq !== m.seq) return; // stale reply
      if (m.type === 'ended') {
        // Usually the Gateway restarted or dropped the stream: resubscribe shortly.
        clearTimeout(sub.retry);
        sub.retry = setTimeout(() => this.subs.get(m.id) === sub && this.send(m.id), 5000);
      }
      sub.handler(m);
    };
  }

  /** Subscribe (or re-subscribe) `id` to bars for `{symbol, tf, rth}`. */
  subscribe(id, params, handler) {
    const prev = this.subs.get(id);
    if (prev) clearTimeout(prev.retry);
    this.subs.set(id, { params, handler, seq: 0 });
    this.send(id);
  }

  unsubscribe(id) {
    const sub = this.subs.get(id);
    if (!sub) return;
    clearTimeout(sub.retry);
    this.subs.delete(id);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'unsubscribe', id }));
  }

  send(id) {
    const sub = this.subs.get(id);
    if (!sub || this.ws.readyState !== WebSocket.OPEN) return;
    sub.seq = ++this.seq;
    this.ws.send(JSON.stringify({ type: 'subscribe', id, seq: sub.seq, ...sub.params }));
  }
}
