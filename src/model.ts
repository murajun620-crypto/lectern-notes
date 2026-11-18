import { getStroke } from 'perfect-freehand';
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'select' | 'laser' | 'hand';
export type Point = { x: number; y: number; p: number };
export type Stroke = {
  id: string;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  points: Point[];
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
  return stroke.points.some((p, i) =>
    i
      ? segmentDistance(point, stroke.points[i - 1], p) <= radius + stroke.width / 2
      : Math.hypot(point.x - p.x, point.y - p.y) <= radius + stroke.width / 2,
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
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], draft = false) {
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    // One composited path per highlighter prevents dark joints inside a single stroke.
    ctx.save();
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
