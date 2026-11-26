// Small client for the on-disk store (/api/store/{namespace}/{key}).

const url = (ns, key) => `/api/store/${ns}${key === undefined ? '' : '/' + encodeURIComponent(key)}`;

export async function load(ns, key, fallback = null) {
  try {
    const r = await fetch(url(ns, key));
    if (!r.ok) return fallback;
    return ns === 'scripts' ? await r.text() : await r.json();
  } catch {
    return fallback;
  }
}

export async function save(ns, key, value) {
  const body = ns === 'scripts' ? value : JSON.stringify(value);
  const r = await fetch(url(ns, key), {
    method: 'PUT',
    headers: { 'Content-Type': ns === 'scripts' ? 'text/plain' : 'application/json' },
    body,
  });
  if (!r.ok) throw new Error(`save ${ns}/${key} failed: ${r.status} ${await r.text()}`);
}

export async function remove(ns, key) {
  await fetch(url(ns, key), { method: 'DELETE' });
}

export async function list(ns) {
  const r = await fetch(url(ns));
  return r.ok ? r.json() : [];
}

/** Returns a function that saves `ns/key` at most once per `ms`, always with the latest value. */
export function debouncedSaver(ns, key, ms = 500) {
  let timer, latest;
  return (value) => {
    latest = value;
    clearTimeout(timer);
    timer = setTimeout(() => save(ns, key, latest).catch((e) => console.error(e)), ms);
  };
}
