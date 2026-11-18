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
export function youtubeId(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.replace(/^www\.|^m\./, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = url.pathname.split('/')[1];
    if (host === 'youtube.com' || host === 'youtube-nocookie.com')
      id =
        url.searchParams.get('v') ||
        (/^\/(embed|shorts|live)\//.test(url.pathname) ? url.pathname.split('/')[2] : null);
    return id && /^[\w-]{11}$/.test(id) ? id : null;
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
  return stroke.points.some((b, i) => {
    const a = stroke.points[Math.max(0, i - 1)],
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
  const shift = (p: Point) => ({ ...p, x: p.x + dx, y: p.y + dy });
  return {
    ...stroke,
    points: stroke.points.map(shift),
    ...(stroke.erasures && {
      erasures: stroke.erasures.map((e) => ({ ...e, points: e.points.map(shift) })),
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
export function penOutline(stroke: Stroke, draft = false) {
  return getStroke(
    stroke.points.map((p) => [p.x, p.y, p.p]),
    {
      size: stroke.width,
      thinning: 0.55,
      smoothing: 0.65,
      streamline: 0.2,
      simulatePressure: false,
      last: !draft,
    },
  );
}
export function traceCurve(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[]) {
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
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], draft = false) {
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    // One composited path per highlighter prevents dark joints inside a single stroke.
    ctx.save();
    if (stroke.erasures?.length) clipErasures(ctx, stroke.erasures);
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (stroke.tool === 'highlighter') {
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      traceCurve(ctx, stroke.points);
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x + 0.01, stroke.points[0].y);
      ctx.stroke();
    } else {
      const outline = penOutline(stroke, draft);
      if (outline.length) {
        const first = outline[0],
          last = outline.at(-1)!;
        ctx.beginPath();
        ctx.moveTo((last[0] + first[0]) / 2, (last[1] + first[1]) / 2);
        for (let i = 0; i < outline.length; i++) {
          const p = outline[i],
            next = outline[(i + 1) % outline.length];
          ctx.quadraticCurveTo(p[0], p[1], (p[0] + next[0]) / 2, (p[1] + next[1]) / 2);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
