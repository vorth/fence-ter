// Plan view of a job, seen from above, scaled to fit. A *terminal* is a
// measured point, labelled "t0" (the job's origin), "t1"... in the order
// created. Every terminal but t0 ends a *run* from its start terminal; the
// run is labelled after the terminal it ends at ("r5" ends at t5). Runs
// branch wherever measuring starts from an earlier terminal.

import type { Point, Terminal } from './db';

/** The in-progress run while measuring. */
export interface LiveRun {
  /** Index of the terminal the run starts at. */
  from: number;
  /** Where the phone is now, in feet from the origin. */
  to: Point;
}

type Pt = [number, number];

/** A position in SVG coordinates: x east, y south (so north is up), in feet. */
const plan = (p: Point): Pt => [p.x, -p.y];

// Never zoom in closer than this, so the first few inches of sensor noise
// don't fill the screen.
const MIN_SPAN_FT = 10;
const MARGIN = 0.08;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * What the drawing shows: a square `span` feet across, centred on (cx, cy) in
 * SVG coordinates (x east, y south), turned clockwise by `angle` radians.
 */
export interface View {
  cx: number;
  cy: number;
  span: number;
  angle: number;
}

/** A round grid spacing giving about six lines across `span`. */
function gridStep(span: number): number {
  const target = span / 6;
  const p = 10 ** Math.floor(Math.log10(target));
  for (const n of [1, 2, 5]) if (n * p >= target) return n * p;
  return 10 * p;
}

function el(name: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/**
 * Draws the job into `svg`, showing `view` or, when null, a view fitted to
 * all the terminals. `selected` is the run highlighted (by the index of the
 * terminal it ends at). Returns the view used and the grid spacing in feet.
 */
export function drawJob(
  svg: SVGSVGElement,
  terminals: Terminal[],
  live: LiveRun | null,
  view: View | null,
  selected: number | null,
): { view: View; step: number } {
  const at = terminals.map(plan);
  const tip: Pt | null = live ? plan(live.to) : null;

  if (!view) {
    // Fit everything, north up, square, with a margin.
    const all = [...at, ...(tip ? [tip] : [])];
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    const [minX, maxX, minY, maxY] =
      [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    view = {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      span: Math.max(maxX - minX, maxY - minY, MIN_SPAN_FT) * (1 + 2 * MARGIN),
      angle: 0,
    };
  }
  const { cx, cy, span, angle } = view;
  const deg = (angle * 180) / Math.PI;
  // The viewBox is centred on zero; the drawing is turned and moved into it.
  svg.setAttribute('viewBox', `${-span / 2} ${-span / 2} ${span} ${span}`);
  const world = el('g', { transform: `rotate(${deg}) translate(${-cx} ${-cy})` });

  const r = span * 0.014;
  const font = span * 0.038;
  const children: SVGElement[] = [];

  /** Text at (x, y) that stays upright however the drawing is turned. */
  const text = (cls: string, x: number, y: number, content: string, attrs = {}) => {
    const t = el('text', {
      class: cls, x, y, 'font-size': font, transform: `rotate(${-deg} ${x} ${y})`, ...attrs,
    });
    t.textContent = content;
    return t;
  };

  // Grid lines over the circle around the view, so they reach every corner
  // whatever the rotation.
  const step = gridStep(span);
  const reach = span * 0.75;
  for (let gx = Math.ceil((cx - reach) / step) * step; gx <= cx + reach; gx += step) {
    children.push(el('line', { class: 'grid', x1: gx, y1: cy - reach, x2: gx, y2: cy + reach }));
  }
  for (let gy = Math.ceil((cy - reach) / step) * step; gy <= cy + reach; gy += step) {
    children.push(el('line', { class: 'grid', x1: cx - reach, y1: gy, x2: cx + reach, y2: gy }));
  }

  const runs = terminals.filter((t) => t.start != null);
  for (const t of runs) {
    const [p, q] = [at[t.start!], at[t.index]];
    children.push(el('line', {
      class: t.index === selected ? 'run selected' : 'run', x1: p[0], y1: p[1], x2: q[0], y2: q[1],
    }));
  }
  if (live && tip) {
    const p = at[live.from];
    children.push(el('line', { class: 'live-path', x1: p[0], y1: p[1], x2: tip[0], y2: tip[1] }));
  }

  at.forEach(([x, y], i) => {
    children.push(el('circle', {
      class: i === live?.from ? 'terminal measuring-from' : 'terminal', cx: x, cy: y, r,
    }));
  });
  if (tip) children.push(el('circle', { class: 'live-point', cx: tip[0], cy: tip[1], r: r * 1.4 }));

  // Run labels at their midpoints, haloed so they read over the line.
  for (const t of runs) {
    const [p, q] = [at[t.start!], at[t.index]];
    children.push(text(t.index === selected ? 'label selected' : 'label',
      (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, `r${t.index}`,
      { 'text-anchor': 'middle', 'dominant-baseline': 'central' }));
  }
  // Terminal labels up and to the right of their dots on screen.
  const [ox, oy] = unrotate(r * 1.5, -r * 1.5, angle);
  const selectedRun = selected != null ? terminals[selected] : undefined;
  const ends = selectedRun ? [selectedRun.start, selectedRun.index] : [];
  at.forEach(([x, y], i) => {
    children.push(text(ends.includes(i) ? 'label selected' : 'label', x + ox, y + oy, `t${i}`));
  });
  world.replaceChildren(...children);

  // North arrow, top left, in screen coordinates.
  const a = span * 0.05;
  const north = el('g', {
    class: 'north',
    transform: `translate(${-span / 2 + a * 1.6} ${-span / 2 + a * 1.6}) rotate(${deg})`,
  });
  north.append(
    el('path', { d: `M0 ${-a} L${a * 0.45} ${a * 0.6} L0 ${a * 0.3} L${-a * 0.45} ${a * 0.6} Z` }),
  );
  const n = el('text', {
    x: 0, y: -a * 1.15, 'font-size': font, 'text-anchor': 'middle',
    transform: `rotate(${-deg} 0 ${-a * 1.15})`,
  });
  n.textContent = 'N';
  north.append(n);

  svg.replaceChildren(world, north);
  return { view, step };
}

// How close a tap must be to a terminal or run to hit it, in screen pixels.
// Terminals win over runs, since every terminal sits on runs.
const TERMINAL_SLOP_PX = 30;
const RUN_SLOP_PX = 24;

export type Hit = { kind: 'terminal' | 'run'; index: number };

/**
 * What a tap at (clientX, clientY) hits: the nearest terminal within
 * TERMINAL_SLOP_PX, else the nearest run within RUN_SLOP_PX (by the index of
 * the terminal it ends at), else null. `view` is the view on screen.
 */
export function hitTest(
  svg: SVGSVGElement,
  terminals: Terminal[],
  view: View,
  clientX: number,
  clientY: number,
): Hit | null {
  const rect = svg.getBoundingClientRect();
  const feetPerPx = view.span / rect.width;
  const [sx, sy] = [
    ((clientX - rect.left) / rect.width - 0.5) * view.span,
    ((clientY - rect.top) / rect.height - 0.5) * view.span,
  ];
  const [dx, dy] = unrotate(sx, sy, view.angle);
  const w: Pt = [view.cx + dx, view.cy + dy];
  const at = terminals.map(plan);

  let best: Hit | null = null;
  let bestDist = TERMINAL_SLOP_PX * feetPerPx;
  at.forEach((p, i) => {
    const d = Math.hypot(w[0] - p[0], w[1] - p[1]);
    if (d <= bestDist) {
      best = { kind: 'terminal', index: i };
      bestDist = d;
    }
  });
  if (best) return best;

  bestDist = RUN_SLOP_PX * feetPerPx;
  for (const t of terminals) {
    if (t.start == null) continue;
    const d = distanceToSegment(w, at[t.start], at[t.index]);
    if (d <= bestDist) {
      best = { kind: 'run', index: t.index };
      bestDist = d;
    }
  }
  return best;
}

function distanceToSegment(w: Pt, p: Pt, q: Pt): number {
  const [vx, vy] = [q[0] - p[0], q[1] - p[1]];
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0
    : Math.max(0, Math.min(1, ((w[0] - p[0]) * vx + (w[1] - p[1]) * vy) / len2));
  return Math.hypot(w[0] - (p[0] + t * vx), w[1] - (p[1] + t * vy));
}

/** Turns (x, y) anticlockwise by `angle`: from screen directions back to drawing ones. */
function unrotate(x: number, y: number, angle: number): [number, number] {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [x * c + y * s, -x * s + y * c];
}

/** Wraps an angle in radians into (-π, π]. */
function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

// Zoom limits for pinching, as the width shown, in feet.
const MIN_PINCH_SPAN_FT = 1;
const MAX_PINCH_SPAN_FT = 5000;

/**
 * Two-finger pinch on `svg` pans, zooms and rotates: the drawing point under
 * the fingers' midpoint stays under it, and the drawing turns as the line
 * between the fingers turns. One finger is left to scroll the page.
 * `current` gives the view on screen when a pinch starts; `change` gets each
 * new view.
 */
export function enablePinch(
  svg: SVGSVGElement,
  current: () => View | null,
  change: (v: View) => void,
): void {
  let start: {
    view: View;
    // The drawing point under the fingers' midpoint at the start.
    anchor: [number, number];
    dist: number;
  } | null = null;
  // The fingers' angle at the last move, and the turn since the start,
  // accumulated so that turning past half a circle doesn't jump.
  let lastAngle = 0;
  let turned = 0;

  const mid = (t: TouchList): [number, number] =>
    [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
  const dist = (t: TouchList) =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  // Clockwise on screen, since client y points down.
  const fingerAngle = (t: TouchList) =>
    Math.atan2(t[1].clientY - t[0].clientY, t[1].clientX - t[0].clientX);

  /** A screen point as an offset from the drawing's centre, in feet at `span`. */
  function fromCentre(p: [number, number], span: number): [number, number] {
    // The SVG is square and shows the view's square exactly.
    const rect = svg.getBoundingClientRect();
    return [
      ((p[0] - rect.left) / rect.width - 0.5) * span,
      ((p[1] - rect.top) / rect.height - 0.5) * span,
    ];
  }

  svg.addEventListener('touchstart', (e) => {
    const view = current();
    if (e.touches.length !== 2 || !view) return;
    e.preventDefault();
    const [sx, sy] = fromCentre(mid(e.touches), view.span);
    const [dx, dy] = unrotate(sx, sy, view.angle);
    start = { view, anchor: [view.cx + dx, view.cy + dy], dist: Math.max(dist(e.touches), 1) };
    lastAngle = fingerAngle(e.touches);
    turned = 0;
  }, { passive: false });

  svg.addEventListener('touchmove', (e) => {
    if (!start || e.touches.length !== 2) return;
    e.preventDefault();
    const { view: v0, anchor } = start;
    const span = Math.min(MAX_PINCH_SPAN_FT,
      Math.max(MIN_PINCH_SPAN_FT, v0.span * start.dist / Math.max(dist(e.touches), 1)));
    const a = fingerAngle(e.touches);
    turned += wrapAngle(a - lastAngle);
    lastAngle = a;
    const angle = wrapAngle(v0.angle + turned);
    // Put the anchor under where the midpoint is now.
    const [sx, sy] = fromCentre(mid(e.touches), span);
    const [dx, dy] = unrotate(sx, sy, angle);
    change({ cx: anchor[0] - dx, cy: anchor[1] - dy, span, angle });
  }, { passive: false });

  const end = (e: TouchEvent) => {
    if (e.touches.length < 2) start = null;
  };
  svg.addEventListener('touchend', end);
  svg.addEventListener('touchcancel', end);
  // iOS's own pinch gesture (page zoom).
  svg.addEventListener('gesturestart', (e) => e.preventDefault());
}
