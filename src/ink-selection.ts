import { clamp, pointErased, pointInPolygon, strokeBounds, strokeHit } from './model';
import type { Page, Point, Stroke } from './model';

type Bounds = { left: number; top: number; right: number; bottom: number };
export type Position = Pick<Point, 'x' | 'y'>;
export type InkSelection = {
  bounds: Bounds;
  data: Bounds;
  minScale: number;
  maxScale: number;
};
const emptyBounds = () => ({ left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
function include(bounds: Bounds, { x, y }: Position, radius: number) {
  bounds.left = Math.min(bounds.left, x - radius);
  bounds.top = Math.min(bounds.top, y - radius);
  bounds.right = Math.max(bounds.right, x + radius);
  bounds.bottom = Math.max(bounds.bottom, y + radius);
}

export function inkSelection(strokes: Stroke[]): InkSelection | null {
  if (!strokes.length) return null;
  const bounds = emptyBounds();
  const data = emptyBounds();
  let minScale = 0;
  let maxScale = Infinity;
  for (const stroke of strokes) {
    for (const p of stroke.points) {
      include(bounds, p, stroke.width * 0.8 + 1);
      include(data, p, 0);
    }
    minScale = Math.max(minScale, 0.1 / stroke.width);
    maxScale = Math.min(maxScale, 100 / stroke.width);
    for (const erasure of stroke.erasures ?? []) {
      minScale = Math.max(minScale, 0.00001 / erasure.width);
      maxScale = Math.min(maxScale, 2000 / erasure.width);
      for (const p of erasure.points) include(data, p, 0);
    }
  }
  return { bounds, data, minScale, maxScale };
}

export function centerOf(bounds: Bounds) {
  return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
}

export function hitBounds(bounds: Bounds, point: Position, padding: number) {
  return (
    point.x >= bounds.left - padding &&
    point.x <= bounds.right + padding &&
    point.y >= bounds.top - padding &&
    point.y <= bounds.bottom + padding
  );
}

/** Keep the selection on the sheet and within the coordinate limits of existing backups. */
export function selectionTransform(
  { bounds, data, minScale, maxScale }: InkSelection,
  page: Pick<Page, 'width' | 'height'>,
  pivot: Position,
  destination: Position,
  requested: number,
) {
  const max = Math.min(
    maxScale,
    Math.max(1, page.width / (bounds.right - bounds.left)),
    Math.max(1, page.height / (bounds.bottom - bounds.top)),
    60000 / (data.right - data.left),
    60000 / (data.bottom - data.top),
  );
  const scale = clamp(requested, minScale, max);
  const offset = (
    anchor: number,
    target: number,
    lo: number,
    hi: number,
    dataLo: number,
    dataHi: number,
    length: number,
  ) => {
    const a = -lo * scale;
    const b = length - hi * scale;
    const inside = clamp(target - anchor * scale, Math.min(a, b), Math.max(a, b));
    return clamp(inside, -20000 - dataLo * scale, 40000 - dataHi * scale);
  };
  return {
    scale,
    x: offset(pivot.x, destination.x, bounds.left, bounds.right, data.left, data.right, page.width),
    y: offset(
      pivot.y,
      destination.y,
      bounds.top,
      bounds.bottom,
      data.top,
      data.bottom,
      page.height,
    ),
  };
}

export function lassoStrokes(strokes: Stroke[], polygon: Point[]) {
  if (polygon.length < 3) return [];
  const area = emptyBounds();
  for (const point of polygon) include(area, point, 0);
  return strokes.filter((stroke) => {
    const { left, right, top, bottom } = strokeBounds(stroke);
    if (left > area.right || right < area.left || top > area.bottom || bottom < area.top)
      return false;
    if (stroke.points.some((p) => pointInPolygon(p, polygon) && !pointErased(stroke, p)))
      return true;
    if (polygon.some((p) => strokeHit(stroke, p, 0))) return true;
    // A long, sparsely sampled stroke can cross the lasso even with both endpoints outside.
    for (let i = 1; i < stroke.points.length; i++) {
      const a = stroke.points[i - 1];
      const b = stroke.points[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      for (let j = 0; j < polygon.length; j++) {
        const c = polygon[j];
        const d = polygon[(j + 1) % polygon.length];
        const ex = d.x - c.x;
        const ey = d.y - c.y;
        const cross = dx * ey - dy * ex;
        if (!cross) continue;
        const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / cross;
        const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / cross;
        if (
          t >= 0 &&
          t <= 1 &&
          u >= 0 &&
          u <= 1 &&
          !pointErased(stroke, { x: a.x + dx * t, y: a.y + dy * t, p: a.p })
        )
          return true;
      }
    }
    return false;
  });
}
