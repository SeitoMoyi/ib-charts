// Mapping between time, fractional bar index ("logical") and pixels.
//
// Drawings anchor to real time, not bar index, so they line up on any timeframe.
// Times between bars are interpolated; times past the last bar are extrapolated
// with the typical bar interval (so lines can extend into the future area).

export class TimeMapper {
  constructor(times = []) {
    this.setTimes(times);
  }

  setTimes(times) {
    this.times = times;
    const n = times.length;
    const diffs = [];
    for (let i = Math.max(1, n - 60); i < n; i++) diffs.push(times[i] - times[i - 1]);
    diffs.sort((a, b) => a - b);
    this.step = diffs.length ? diffs[diffs.length >> 1] || 60 : 60;
  }

  /** Appends or replaces the last bar time (live updates). */
  update(t) {
    const T = this.times;
    if (!T.length || t > T[T.length - 1]) T.push(t);
  }

  toLogical(t) {
    const T = this.times, n = T.length;
    if (!n) return null;
    if (t <= T[0]) return (t - T[0]) / this.step;
    if (t >= T[n - 1]) return n - 1 + (t - T[n - 1]) / this.step;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (T[mid] <= t) lo = mid; else hi = mid;
    }
    return lo + (t - T[lo]) / (T[hi] - T[lo]);
  }

  fromLogical(l) {
    const T = this.times, n = T.length;
    if (!n) return null;
    if (l <= 0) return T[0] + l * this.step;
    if (l >= n - 1) return T[n - 1] + (l - (n - 1)) * this.step;
    const i = Math.floor(l), f = l - i;
    return T[i] + f * (T[i + 1] - T[i]);
  }
}

/** X pixel for a fractional logical index (the chart API only handles whole bars). */
export function logicalToX(timeScale, l) {
  const c0 = timeScale.logicalToCoordinate(0);
  const c1 = timeScale.logicalToCoordinate(1);
  if (c0 == null || c1 == null) return null;
  return c0 + l * (c1 - c0);
}

/** Fractional logical index for an x pixel (the chart API only returns whole bars). */
export function xToLogical(timeScale, x) {
  const c0 = timeScale.logicalToCoordinate(0);
  const c1 = timeScale.logicalToCoordinate(1);
  if (c0 == null || c1 == null || c1 === c0) return null;
  return (x - c0) / (c1 - c0);
}

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Extends segment a→b to the edges of a w×h box.
 * `back`/`forward` choose which directions to extend.
 */
export function extendLine(a, b, w, h, back, forward) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return [a, b];
  const ts = [];
  if (dx !== 0) ts.push(-a.x / dx, (w - a.x) / dx);
  if (dy !== 0) ts.push(-a.y / dy, (h - a.y) / dy);
  const inside = ts.filter((t) => {
    const x = a.x + t * dx, y = a.y + t * dy;
    return x >= -1 && x <= w + 1 && y >= -1 && y <= h + 1;
  });
  const tMin = Math.min(0, ...inside), tMax = Math.max(1, ...inside);
  return [
    back ? { x: a.x + tMin * dx, y: a.y + tMin * dy } : a,
    forward ? { x: a.x + tMax * dx, y: a.y + tMax * dy } : b,
  ];
}
