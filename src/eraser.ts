import { segmentDistance } from './model';
import type { Erasure, Point, Stroke } from './model';

function segmentGap(a: Point, b: Point, c: Point, d: Point) {
  const rx = b.x - a.x,
    ry = b.y - a.y,
    sx = d.x - c.x,
    sy = d.y - c.y;
  const cross = rx * sy - ry * sx;
  if (Math.abs(cross) > 1e-10) {
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / cross;
    const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / cross;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    segmentDistance(a, c, d),
    segmentDistance(b, c, d),
    segmentDistance(c, a, b),
    segmentDistance(d, a, b),
  );
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
    for (let i = fromIndex; i < erasure.points.length; i++) {
      const a = erasure.points[Math.max(0, i - 1)],
        b = erasure.points[i];
      if (
        s.points.some(
          (p, j) =>
            segmentGap(s.points[Math.max(0, j - 1)], p, a, b) <= erasure.width / 2 + s.width,
        )
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
