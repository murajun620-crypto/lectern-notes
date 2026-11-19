import { getStroke } from 'perfect-freehand';
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'select' | 'laser' | 'hand';
export type Point = { x: number; y: number; p: number };
export type Erasure = { id: string; width: number; points: Point[] };
export type Stroke = {
  id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  points: Point[];
  erasures?: Erasure[];
};
export type Video = {
  id: string;
  videoId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed?: boolean;
};
export type Page = {
  id: string;
  assetId?: string;
  sourcePage?: number;
  width: number;
  height: number;
  strokes: Stroke[];
  videos: Video[];
};
export type Project = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  currentPage: number;
  pages: Page[];
};
export const uid = () => crypto.randomUUID();
export const A4 = { width: 595.28, height: 841.89 };
export const blankPage = (width = A4.width, height = A4.height): Page => ({
  id: uid(),
  width,
  height,
  strokes: [],
  videos: [],
});
export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
export function parseYoutubeUrl(raw: string) {
  try {
    const url = new URL(raw.trim());
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.replace(/^www\.|^m\./, '');
    const [, route, pathId] = url.pathname.split('/');
    let portrait = false;
    let id: string | null = null;
    if (host === 'youtu.be') id = route;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      portrait = route === 'shorts';
      id = ['embed', 'shorts', 'live'].includes(route) ? pathId : url.searchParams.get('v');
    }
    return id && /^[\w-]{11}$/.test(id) ? { id, portrait } : null;
  } catch {
    return null;
  }
}
export function pointInPolygon(p: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}
export function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function strokeHit(stroke: Stroke, point: Point, radius: number) {
  const points = strokeCenterline(stroke);
  return points.some((b, i) => {
    const a = points[Math.max(0, i - 1)],
      dx = b.x - a.x,
      dy = b.y - a.y;
    const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    const nearest = { x: a.x + t * dx, y: a.y + t * dy, p: 0.5 };
    return (
      Math.hypot(point.x - nearest.x, point.y - nearest.y) <= radius + stroke.width / 2 &&
      !pointErased(stroke, nearest)
    );
  });
}
export function translateStroke(stroke: Stroke, dx: number, dy: number): Stroke {
  return transformStroke(stroke, 1, dx, dy);
}
export function transformStroke(stroke: Stroke, scale: number, dx: number, dy: number): Stroke {
  const shift = (p: Point) => ({ ...p, x: p.x * scale + dx, y: p.y * scale + dy });
  return {
    ...stroke,
    width: stroke.width * scale,
    points: stroke.points.map(shift),
    ...(stroke.erasures && {
      erasures: stroke.erasures.map((e) => ({
        ...e,
        width: e.width * scale,
        points: e.points.map(shift),
      })),
    }),
  };
}
export function pointErased(stroke: Stroke, p: Point) {
  return (
    stroke.erasures?.some((e) =>
      e.points.some((b, i) => segmentDistance(p, e.points[Math.max(0, i - 1)], b) < e.width / 2),
    ) ?? false
  );
}
function curveHandle(start: Point, end: Point, neighbor: Point | undefined, length: number) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const nx = start.x - (neighbor?.x ?? start.x);
  const ny = start.y - (neighbor?.y ?? start.y);
  const distance = Math.hypot(nx, ny);
  // Keep a sharp corner's tangent on its own segment.
  if (nx * dx + ny * dy <= 0.5 * distance * length) {
    return { x: start.x + dx / 3, y: start.y + dy / 3 };
  }
  const ratio = length / distance;
  return {
    x: clamp(start.x + (dx + nx * ratio) / 6, Math.min(start.x, end.x), Math.max(start.x, end.x)),
    y: clamp(start.y + (dy + ny * ratio) / 6, Math.min(start.y, end.y), Math.max(start.y, end.y)),
  };
}

const centerlines = new WeakMap<Stroke, { count: number; points: Point[] }>();
/** Fill widely spaced curves between contacts while keeping the recorded samples intact. */
export function strokeCenterline(stroke: Stroke): Point[] {
  const { points, width } = stroke;
  if (stroke.tool !== 'pen' || points.length < 3) return points;
  const cached = centerlines.get(stroke);
  if (cached?.count === points.length) return cached.points;
  let interpolated: Point[] | undefined;
  let remaining = 1024;
  const step = Math.max(4, width);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const count = Math.min(8, remaining + 1, Math.ceil(length / step));
    if (count > 1) {
      const c = curveHandle(a, b, points[i - 2], length);
      const d = curveHandle(b, a, points[i + 1], length);
      const cross = (p: { x: number; y: number }) => dx * (p.y - a.y) - dy * (p.x - a.x);
      if (Math.max(Math.abs(cross(c)), Math.abs(cross(d))) > 0.02 * length) {
        interpolated ??= points.slice(0, i);
        for (let j = 1; j < count; j++) {
          const t = j / count;
          const s = 1 - t;
          interpolated.push({
            x: s ** 3 * a.x + 3 * s * s * t * c.x + 3 * s * t * t * d.x + t ** 3 * b.x,
            y: s ** 3 * a.y + 3 * s * s * t * c.y + 3 * s * t * t * d.y + t ** 3 * b.y,
            p: a.p + t * (b.p - a.p),
          });
        }
        remaining -= count - 1;
      }
    }
    interpolated?.push(b);
  }
  const result = interpolated ?? points;
  centerlines.set(stroke, { count: points.length, points: result });
  return result;
}

export function penOutline(stroke: Stroke) {
  return getStroke(
    strokeCenterline(stroke).map((p) => [p.x, p.y, Math.max(0.32, p.p)]),
    {
      size: stroke.width,
      thinning: 0.55,
      smoothing: 0.65,
      streamline: 0.2,
      simulatePressure: false,
      last: true,
    },
  );
}

type InkBounds = { left: number; top: number; right: number; bottom: number };
const savedInkBounds = new WeakMap<Stroke, InkBounds>();
export function strokeBounds(stroke: Stroke): InkBounds {
  const cached = savedInkBounds.get(stroke);
  if (cached) return cached;
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const { x, y } of stroke.points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  // Include the outline's end caps and perfect-freehand's synthetic points for single taps.
  const padding = stroke.width * 2 + 2;
  const bounds = {
    left: left - padding,
    top: top - padding,
    right: right + padding,
    bottom: bottom + padding,
  };
  savedInkBounds.set(stroke, bounds);
  return bounds;
}
export function traceCurve(
  ctx: Pick<CanvasRenderingContext2D, 'moveTo' | 'quadraticCurveTo' | 'lineTo'>,
  points: { x: number; y: number }[],
) {
  if (!points.length) return;
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i],
      next = points[i + 1];
    ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
  }
  const last = points.at(-1)!;
  ctx.lineTo(last.x, last.y);
}
export function drawLaser(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number; t: number }[],
  scale: number,
  now: number,
  trail: boolean,
  width = 4,
) {
  const head = points.at(-1);
  if (!head) return;
  const opacity = clamp(1 - (now - head.t) / (trail ? 700 : 130), 0, 1);
  ctx.save();
  if (trail && points.length > 1) {
    ctx.globalAlpha = opacity * 0.55;
    ctx.strokeStyle = '#fb403b';
    ctx.lineWidth = width / scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    traceCurve(ctx, points);
    ctx.stroke();
  }
  ctx.globalAlpha = opacity;
  ctx.shadowColor = '#fa3939';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#ff3c3c';
  ctx.beginPath();
  ctx.arc(head.x, head.y, Math.max(5, width * 0.9 + 2) / scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();
  ctx.restore();
}
/** Separate inverse clips keep overlapping eraser passes transparent. */
function clipErasures(ctx: CanvasRenderingContext2D, erasures: Erasure[]) {
  const transform = ctx.getTransform();
  for (const erasure of erasures) {
    for (let i = erasure.points.length === 1 ? 0 : 1; i < erasure.points.length; i++) {
      const a = erasure.points[Math.max(0, i - 1)],
        b = erasure.points[i];
      const radius = erasure.width / 2,
        angle = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.setTransform(transform);
      ctx.moveTo(a.x + Math.sin(angle) * radius, a.y - Math.cos(angle) * radius);
      ctx.lineTo(b.x + Math.sin(angle) * radius, b.y - Math.cos(angle) * radius);
      ctx.arc(b.x, b.y, radius, angle - Math.PI / 2, angle + Math.PI / 2);
      ctx.lineTo(a.x - Math.sin(angle) * radius, a.y + Math.cos(angle) * radius);
      ctx.arc(a.x, a.y, radius, angle + Math.PI / 2, angle + Math.PI * 1.5);
      ctx.closePath();
      ctx.clip('evenodd');
    }
  }
}
type StrokeShape = { points: number[][]; bounds: InkBounds };
const strokePaths = new WeakMap<Stroke, { count: number; path: Path2D }>();
function includeVertex(bounds: InkBounds, [x, y]: number[], padding: number) {
  bounds.left = Math.min(bounds.left, x - padding);
  bounds.top = Math.min(bounds.top, y - padding);
  bounds.right = Math.max(bounds.right, x + padding);
  bounds.bottom = Math.max(bounds.bottom, y + padding);
}
const emptyInkBounds = () => ({
  left: Infinity,
  top: Infinity,
  right: -Infinity,
  bottom: -Infinity,
});

export function strokeShape(stroke: Stroke) {
  const count = stroke.points.length;
  const path = new Path2D();
  const points =
    stroke.tool === 'pen' ? penOutline(stroke) : stroke.points.map(({ x, y }) => [x, y]);
  const bounds = emptyInkBounds();
  for (const p of points)
    includeVertex(bounds, p, stroke.tool === 'pen' ? 1 : stroke.width / 2 + 1);
  if (stroke.tool === 'highlighter') {
    traceCurve(path, stroke.points);
    if (stroke.points.length === 1) path.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y);
  } else {
    const outline = points;
    if (outline.length) {
      const first = outline[0],
        last = outline.at(-1)!;
      path.moveTo((last[0] + first[0]) / 2, (last[1] + first[1]) / 2);
      for (let i = 0; i < outline.length; i++) {
        const p = outline[i],
          next = outline[(i + 1) % outline.length];
        path.quadraticCurveTo(p[0], p[1], (p[0] + next[0]) / 2, (p[1] + next[1]) / 2);
      }
      path.closePath();
    }
  }
  strokePaths.set(stroke, { count, path });
  return { path, points, bounds };
}

/** Quadratic segments only depend on neighboring vertices. Include both sides of edited spans. */
export function changedStrokeBounds(previous: StrokeShape, next: StrokeShape, stroke: Stroke) {
  const a = previous.points;
  const b = next.points;
  const match = (p: number[], q: number[]) => p[0] === q[0] && p[1] === q[1];
  let start = 0;
  while (start < a.length && start < b.length && match(a[start], b[start])) start++;
  if (start === a.length && start === b.length) return null;
  let i = a.length - 1;
  let j = b.length - 1;
  while (i >= start && j >= start && match(a[i], b[j])) {
    i--;
    j--;
  }
  const bounds = emptyInkBounds();
  const padding = stroke.tool === 'pen' ? 1 : stroke.width / 2 + 1;
  for (const [points, end] of [
    [a, i],
    [b, j],
  ] as const) {
    const from = Math.max(0, start - 2);
    const to = Math.min(points.length - 1, end + 2);
    for (let index = from; index <= to; index++) includeVertex(bounds, points[index], padding);
    if (stroke.tool === 'pen' && points.length) {
      if (from === 0) includeVertex(bounds, points[points.length - 1], padding);
      if (to === points.length - 1) includeVertex(bounds, points[0], padding);
    }
  }
  return bounds;
}

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[]) {
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    // Active strokes only append samples. The last preview path can also paint the final stroke.
    const cached = strokePaths.get(stroke);
    const path = cached?.count === stroke.points.length ? cached.path : strokeShape(stroke).path;
    ctx.save();
    if (stroke.erasures?.length) clipErasures(ctx, stroke.erasures);
    if (stroke.tool === 'highlighter') {
      // Composite one path so individual segments cannot leave darker joints.
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    } else {
      ctx.fillStyle = stroke.color;
      ctx.fill(path);
    }
    ctx.restore();
  }
}
