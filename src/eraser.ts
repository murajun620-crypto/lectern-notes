import type { Erasure, Point, Stroke } from './model';

type Bounds = { left: number; right: number; top: number; bottom: number };
const boundsCache = new WeakMap<Point[], Bounds>();
function bounds(points: Point[]) {
  let result = boundsCache.get(points);
  if (!result) {
    result = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    for (const p of points) {
      result.left = Math.min(result.left, p.x);
      result.right = Math.max(result.right, p.x);
      result.top = Math.min(result.top, p.y);
      result.bottom = Math.max(result.bottom, p.y);
    }
    boundsCache.set(points, result);
  }
  return result;
}

/** Attach an immutable, per-stroke mask. Later ink and the PDF are never erased. */
export function applyErasure(
  strokes: Stroke[],
  erasure: Erasure,
  touched = new Set<string>(),
  fromIndex = 0,
): Stroke[] {
  if (!erasure.points.length) return strokes;
  for (const s of strokes) {
    if (touched.has(s.id)) continue;
    const box = bounds(s.points),
      padding = s.width + erasure.width / 2;
    for (let i = fromIndex; i < erasure.points.length; i++) {
      const a = erasure.points[Math.max(0, i - 1)],
        b = erasure.points[i];
      // Smoothed curves can bow away from input segments. Conservative bounds
      // select candidates; canvas clipping limits removal to the exact circle.
      if (
        Math.max(a.x, b.x) + padding >= box.left &&
        Math.min(a.x, b.x) - padding <= box.right &&
        Math.max(a.y, b.y) + padding >= box.top &&
        Math.min(a.y, b.y) - padding <= box.bottom
      ) {
        touched.add(s.id);
        break;
      }
    }
  }
  return touched.size
    ? strokes.map((s) =>
        touched.has(s.id) ? { ...s, erasures: [...(s.erasures || []), erasure] } : s,
      )
    : strokes;
}
