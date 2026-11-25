import type { Point } from './model';

type Position = Pick<Point, 'x' | 'y'>;

export type SnapShape =
  | { kind: 'line'; start: Position; end: Position }
  | { kind: 'circle'; center: Position; radius: number; startAngle: number; direction: 1 | -1 }
  | { kind: 'triangle' | 'quadrilateral'; vertices: readonly Position[] };

const fullTurn = 2 * Math.PI;

function fitLine(points: readonly Point[], pathLength: number, chord: number, screenScale: number) {
  const first = points[0];
  const last = points[points.length - 1];
  const lengthInPixels = chord * screenScale;
  if (lengthInPixels < 32 || pathLength > chord * 1.18) return null;

  const unitX = (last.x - first.x) / chord;
  const unitY = (last.y - first.y) / chord;
  const maxDeviation = Math.min(10, Math.max(3, lengthInPixels * 0.085)) / screenScale;
  const maxBacktrack = Math.max(2 / screenScale, chord * 0.07);
  let previous = 0;
  let backtrack = 0;
  for (const point of points) {
    const x = point.x - first.x;
    const y = point.y - first.y;
    if (Math.abs(x * unitY - y * unitX) > maxDeviation) return null;
    const along = x * unitX + y * unitY;
    backtrack += Math.max(0, previous - along);
    if (backtrack > maxBacktrack) return null;
    previous = along;
  }

  return {
    kind: 'line' as const,
    start: { x: first.x, y: first.y },
    end: { x: last.x, y: last.y },
  };
}

function sampleByDistance(points: readonly Point[], pathLength: number): Position[] {
  // Even spacing keeps a slow or stationary section from dominating the fit.
  const count = 32;
  const spacing = pathLength / count;
  const samples: Position[] = [points[0]];
  let covered = 0;
  for (let i = 1; i < points.length && samples.length < count; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!length) continue;
    while (samples.length < count && covered + length >= samples.length * spacing) {
      const t = (samples.length * spacing - covered) / length;
      samples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    covered += length;
  }
  return samples;
}

function circleCenter(samples: readonly Position[]): Position | null {
  const sum = samples.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), {
    x: 0,
    y: 0,
  });
  const mean = { x: sum.x / samples.length, y: sum.y / samples.length };
  let xx = 0;
  let xy = 0;
  let yy = 0;
  let xz = 0;
  let yz = 0;
  for (const point of samples) {
    const x = point.x - mean.x;
    const y = point.y - mean.y;
    const z = x * x + y * y;
    xx += x * x;
    xy += x * y;
    yy += y * y;
    xz += x * z;
    yz += y * z;
  }
  const spread = xx + yy;
  // Reject noticeably oval paths regardless of their rotation on the page.
  if (!spread || Math.hypot(xx - yy, 2 * xy) > 0.23 * spread) return null;
  // Solve the centered least-squares fit of x² + y² = 2cx·x + 2cy·y + c.
  const determinant = xx * yy - xy * xy;
  return {
    x: mean.x + (yy * xz - xy * yz) / (2 * determinant),
    y: mean.y + (xx * yz - xy * xz) / (2 * determinant),
  };
}

function fitCircle(
  points: readonly Point[],
  pathLength: number,
  gap: number,
  screenScale: number,
): SnapShape | null {
  if (points.length < 9 || gap > pathLength * 0.09 || pathLength * screenScale < 80) return null;
  const samples = sampleByDistance(points, pathLength);
  const center = circleCenter(samples);
  if (!center) return null;

  const radius =
    samples.reduce((sum, point) => sum + Math.hypot(point.x - center.x, point.y - center.y), 0) /
    samples.length;
  if (radius * screenScale < 13 || gap > radius * 0.45) return null;
  const circumference = fullTurn * radius;
  if (pathLength < circumference * 0.86 || pathLength > circumference * 1.2) return null;

  const first = points[0];
  const startAngle = Math.atan2(first.y - center.y, first.x - center.x);
  let previousAngle = startAngle;
  let turn = 0;
  let angularTravel = 0;
  for (const point of points) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    if (Math.abs(Math.hypot(dx, dy) - radius) > radius * 0.17) return null;
    const angle = Math.atan2(dy, dx);
    const delta = angle - previousAngle;
    const step = Math.atan2(Math.sin(delta), Math.cos(delta));
    if (Math.abs(step) > Math.PI / 3) return null;
    turn += step;
    angularTravel += Math.abs(step);
    previousAngle = angle;
  }
  if (Math.abs(Math.abs(turn) - fullTurn) > 0.5 || angularTravel - Math.abs(turn) > 0.55)
    return null;

  return { kind: 'circle', center, radius, startAngle, direction: turn > 0 ? 1 : -1 };
}

function farthestPoint(points: readonly Position[], from: number) {
  const origin = points[from];
  let farthest = from;
  let maxDistance = 0;
  for (let index = 0; index < points.length; index++) {
    const distance = (points[index].x - origin.x) ** 2 + (points[index].y - origin.y) ** 2;
    if (distance > maxDistance) {
      farthest = index;
      maxDistance = distance;
    }
  }
  return farthest;
}

function polygonCorners(points: readonly Point[], tolerance: number): Position[] | null {
  // Split the loop at distant points so the pen can start anywhere along an edge.
  const firstAnchor = farthestPoint(points, 0);
  const secondAnchor = farthestPoint(points, firstAnchor);
  const start = Math.min(firstAnchor, secondAnchor);
  const other = Math.abs(firstAnchor - secondAnchor);
  const ring = [...points.slice(start), ...points.slice(0, start + 1)];
  const corners = [0, other];
  const segments = [
    [0, other],
    [other, ring.length - 1],
  ];
  const toleranceSquared = tolerance ** 2;

  while (segments.length) {
    const [from, to] = segments.pop()!;
    const a = ring[from];
    const b = ring[to];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    let splitAt = -1;
    let maxDistance = toleranceSquared;

    for (let index = from + 1; index < to; index++) {
      const x = ring[index].x - a.x;
      const y = ring[index].y - a.y;
      const fraction = Math.max(0, Math.min(1, (x * dx + y * dy) / lengthSquared));
      const distance = (x - fraction * dx) ** 2 + (y - fraction * dy) ** 2;
      if (distance > maxDistance) {
        maxDistance = distance;
        splitAt = index;
      }
    }

    if (splitAt < 0) continue;
    if (corners.length === 4) return null;
    corners.push(splitAt);
    segments.push([from, splitAt], [splitAt, to]);
  }

  return corners
    .sort((a, b) => a - b)
    .map((index) => {
      const { x, y } = ring[index];
      return { x, y };
    });
}

function fitPolygon(
  points: readonly Point[],
  pathLength: number,
  gap: number,
  screenScale: number,
): SnapShape | null {
  if (
    points.length < 4 ||
    pathLength * screenScale < 90 ||
    gap > Math.min(pathLength * 0.08, 22 / screenScale)
  ) {
    return null;
  }

  const tolerance = Math.min(10, Math.max(2.5, pathLength * screenScale * 0.021)) / screenScale;
  const vertices = polygonCorners(points, tolerance);
  if (!vertices || vertices.length < 3) return null;

  const sideMinimum = Math.max(16 / screenScale, pathLength * 0.05);
  let perimeter = 0;
  let turn = 0;
  for (let index = 0; index < vertices.length; index++) {
    const a = vertices[index];
    const b = vertices[(index + 1) % vertices.length];
    const c = vertices[(index + 2) % vertices.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const nextX = c.x - b.x;
    const nextY = c.y - b.y;
    const length = Math.hypot(dx, dy);
    if (length < sideMinimum) return null;

    // Clear, consistently turning corners rule out crossing and nearly flat outlines.
    const corner = (dx * nextY - dy * nextX) / (length * Math.hypot(nextX, nextY));
    if (Math.abs(corner) < 0.35 || corner * turn < 0) return null;
    turn = Math.sign(corner);
    perimeter += length;
  }

  if (pathLength + gap > perimeter * 1.16) return null;
  return { kind: vertices.length === 3 ? 'triangle' : 'quadrilateral', vertices };
}

/** Fit only unambiguous, screen-sized single strokes. Returned coordinates stay in PDF points. */
export function detectSnapShape(points: readonly Point[], screenScale: number): SnapShape | null {
  if (points.length < 2 || !Number.isFinite(screenScale) || screenScale <= 0) return null;
  let pathLength = 0;
  for (let i = 1; i < points.length; i++) {
    pathLength += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  if (!Number.isFinite(pathLength)) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  return (
    fitLine(points, pathLength, gap, screenScale) ??
    fitCircle(points, pathLength, gap, screenScale) ??
    fitPolygon(points, pathLength, gap, screenScale)
  );
}
