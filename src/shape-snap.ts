import type { Point } from './model';

type Position = Pick<Point, 'x' | 'y'>;

export type SnapShape =
  | { kind: 'line'; start: Position; end: Position }
  | { kind: 'circle'; center: Position; radius: number; startAngle: number; direction: 1 | -1 };

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
    fitLine(points, pathLength, gap, screenScale) ?? fitCircle(points, pathLength, gap, screenScale)
  );
}
