// Drawing types: how many points they need, how to draw them and how to hit-test them.
// Points passed to draw/hit are pixel coordinates {x, y} in the chart pane.

import { distToSegment, extendLine } from './geometry.js';

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618];
const FIB_COLORS = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#787b86', '#2962ff'];
const TOL = 6;

const DASH = { 0: [], 1: [6, 4], 2: [2, 3] };

function stroke(ctx, d, selected) {
  ctx.strokeStyle = d.style.color;
  ctx.lineWidth = d.style.width + (selected ? 0.5 : 0);
  ctx.setLineDash(DASH[d.style.dash] || []);
}

function line(ctx, a, b) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function label(ctx, text, x, y, color, align = 'left', bg = null) {
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  if (bg) {
    const w = ctx.measureText(text).width + 10;
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(left, y - 10, w, 20, 3);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(text, align === 'center' ? x : align === 'right' ? x - 5 : x + 5, y);
    return;
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const lineLike = (back, forward) => ({
  points: 2,
  draw(ctx, p, d, env) {
    stroke(ctx, d, env.selected);
    const [a, b] = extendLine(p[0], p[1], env.width, env.height, back, forward);
    line(ctx, a, b);
  },
  hit(x, y, p, d, env) {
    const [a, b] = extendLine(p[0], p[1], env.width, env.height, back, forward);
    return distToSegment(x, y, a.x, a.y, b.x, b.y) < TOL;
  },
});

export const SHAPES = {
  trend: { label: 'Trend line', key: 'T', ...lineLike(false, false) },
  ray: { label: 'Ray', ...lineLike(false, true) },
  extended: { label: 'Extended line', ...lineLike(true, true) },

  hline: {
    label: 'Horizontal line', key: 'H', points: 1, priceOnly: true,
    draw(ctx, p, d, env) { stroke(ctx, d, env.selected); line(ctx, { x: 0, y: p[0].y }, { x: env.width, y: p[0].y }); },
    hit: (x, y, p) => Math.abs(y - p[0].y) < TOL,
  },
  hray: {
    label: 'Horizontal ray', points: 1,
    draw(ctx, p, d, env) { stroke(ctx, d, env.selected); line(ctx, p[0], { x: env.width, y: p[0].y }); },
    hit: (x, y, p) => x >= p[0].x - TOL && Math.abs(y - p[0].y) < TOL,
  },
  vline: {
    label: 'Vertical line', key: 'V', points: 1, timeOnly: true,
    draw(ctx, p, d, env) { stroke(ctx, d, env.selected); line(ctx, { x: p[0].x, y: 0 }, { x: p[0].x, y: env.height }); },
    hit: (x, y, p) => Math.abs(x - p[0].x) < TOL,
  },

  rect: {
    label: 'Rectangle', points: 2,
    draw(ctx, p, d, env) {
      const [a, b] = p;
      ctx.fillStyle = alpha(d.style.color, 0.15);
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      stroke(ctx, d, env.selected);
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    },
    hit(x, y, p) {
      const [a, b] = p;
      return x >= Math.min(a.x, b.x) - TOL && x <= Math.max(a.x, b.x) + TOL && y >= Math.min(a.y, b.y) - TOL && y <= Math.max(a.y, b.y) + TOL;
    },
  },

  channel: {
    label: 'Parallel channel', points: 3,
    /** The third point sets the channel width; the second line runs through it. */
    lines(p) {
      const [a, b, c] = p;
      if (!c) return [[a, b]];
      const dy = c.y - (a.y + ((b.y - a.y) * (c.x - a.x)) / ((b.x - a.x) || 1));
      return [[a, b], [{ x: a.x, y: a.y + dy }, { x: b.x, y: b.y + dy }]];
    },
    draw(ctx, p, d, env) {
      const ls = this.lines(p);
      if (ls.length === 2) {
        ctx.fillStyle = alpha(d.style.color, 0.12);
        ctx.beginPath();
        ctx.moveTo(ls[0][0].x, ls[0][0].y); ctx.lineTo(ls[0][1].x, ls[0][1].y);
        ctx.lineTo(ls[1][1].x, ls[1][1].y); ctx.lineTo(ls[1][0].x, ls[1][0].y);
        ctx.closePath();
        ctx.fill();
      }
      stroke(ctx, d, env.selected);
      for (const [a, b] of ls) line(ctx, a, b);
      if (ls.length === 2) {
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        line(ctx, { x: (ls[0][0].x + ls[1][0].x) / 2, y: (ls[0][0].y + ls[1][0].y) / 2 }, { x: (ls[0][1].x + ls[1][1].x) / 2, y: (ls[0][1].y + ls[1][1].y) / 2 });
      }
    },
    hit(x, y, p) {
      return this.lines(p).some(([a, b]) => distToSegment(x, y, a.x, a.y, b.x, b.y) < TOL);
    },
    /** Handle for the third point sits on the second line, above the first point. */
    handles(p) {
      const ls = this.lines(p);
      return ls.length === 2 ? [p[0], p[1], { x: (ls[1][0].x + ls[1][1].x) / 2, y: (ls[1][0].y + ls[1][1].y) / 2 }] : p;
    },
  },

  fib: {
    label: 'Fib retracement', key: 'F', points: 2,
    draw(ctx, p, d, env) {
      const [a, b] = p;
      const left = Math.min(a.x, b.x), right = env.width;
      ctx.setLineDash(DASH[d.style.dash] || []);
      ctx.lineWidth = 1;
      FIB_LEVELS.forEach((lvl, i) => {
        const y = b.y + (a.y - b.y) * lvl;
        const price = d.points[1].p + (d.points[0].p - d.points[1].p) * lvl;
        ctx.strokeStyle = FIB_COLORS[i];
        line(ctx, { x: left, y }, { x: right, y });
        label(ctx, `${lvl} (${price.toFixed(env.precision)})`, left + 4, y - 8, FIB_COLORS[i]);
      });
      stroke(ctx, d, env.selected);
      ctx.setLineDash([3, 3]);
      line(ctx, a, b);
    },
    hit(x, y, p) {
      const [a, b] = p;
      if (x < Math.min(a.x, b.x) - TOL) return false;
      return FIB_LEVELS.some((lvl) => Math.abs(y - (b.y + (a.y - b.y) * lvl)) < TOL) || distToSegment(x, y, a.x, a.y, b.x, b.y) < TOL;
    },
  },

  measure: {
    label: 'Measure (price & time range)', points: 2,
    draw(ctx, p, d, env) {
      const [a, b] = p;
      const up = d.points[1].p >= d.points[0].p;
      const color = up ? '#2962ff' : '#f23645';
      ctx.fillStyle = alpha(color, 0.18);
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
      line(ctx, { x: midX, y: a.y }, { x: midX, y: b.y });
      line(ctx, { x: a.x, y: midY }, { x: b.x, y: midY });
      const dp = d.points[1].p - d.points[0].p;
      const pct = d.points[0].p ? (dp / d.points[0].p) * 100 : 0;
      const info = env.measure?.(d) || '';
      const text = `${dp >= 0 ? '+' : ''}${dp.toFixed(env.precision)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)${info ? '   ' + info : ''}`;
      const ly = up ? Math.min(a.y, b.y) - 16 : Math.max(a.y, b.y) + 16;
      label(ctx, text, midX, ly, '#fff', 'center', color);
    },
    hit: (x, y, p) => SHAPES.rect.hit(x, y, p),
  },

  text: {
    label: 'Text', points: 1,
    draw(ctx, p, d, env) {
      ctx.font = `${12 + d.style.width * 2}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'left';
      ctx.fillStyle = d.style.color;
      ctx.fillText(d.text || 'Text', p[0].x, p[0].y);
      if (env.selected) {
        const w = ctx.measureText(d.text || 'Text').width;
        ctx.strokeStyle = d.style.color;
        ctx.setLineDash([2, 2]);
        ctx.lineWidth = 1;
        ctx.strokeRect(p[0].x - 3, p[0].y - (14 + d.style.width * 2) - 3, w + 6, 14 + d.style.width * 2 + 6);
      }
      d._w = ctx.measureText(d.text || 'Text').width;
    },
    hit(x, y, p, d) {
      const h = 14 + d.style.width * 2;
      return x >= p[0].x - 3 && x <= p[0].x + (d._w || 40) + 3 && y >= p[0].y - h - 3 && y <= p[0].y + 3;
    },
  },
};

export const COLORS = ['#2962ff', '#f23645', '#089981', '#ff9800', '#e040fb', '#00bcd4', '#ffeb3b', '#d1d4dc'];
