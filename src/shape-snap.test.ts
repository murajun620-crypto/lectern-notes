import { describe, expect, it } from 'vitest';
import type { Point } from './model';
import { detectSnapShape } from './shape-snap';

const point = (x: number, y: number): Point => ({ x, y, p: 0.5 });
const loop = (radius: number, direction: 1 | -1, arc = Math.PI * 2, oval = 1, wobble = 0) =>
  Array.from({ length: 49 }, (_, index) => {
    const angle = -0.8 + (direction * arc * index) / 48;
    const reach = radius * (1 + wobble * Math.sin(3 * angle + 0.1));
    const x = Math.cos(angle) * reach * oval;
    const y = Math.sin(angle) * reach;
    // A rotated oval must be rejected just like an axis-aligned one.
    return point(1035 + (x - y) * Math.SQRT1_2, 620 + (x + y) * Math.SQRT1_2);
  });

describe('hold-to-snap geometry', () => {
  it('straightens a rough diagonal line while preserving its endpoints and direction', () => {
    const start = { x: 442, y: 223 };
    const end = { x: 318, y: 171 };
    expect(
      detectSnapShape([point(442, 223), point(399, 210), point(359, 183), point(318, 171)], 1.25),
    ).toEqual({ kind: 'line', start, end });
  });

  it('requires a sufficient mark length at the current display scale', () => {
    const short = [point(80, 110), point(90, 110.5), point(100, 110)];
    expect(detectSnapShape(short, 1)).toBeNull();
    expect(detectSnapShape(short, 2)).toMatchObject({ kind: 'line' });
    expect(detectSnapShape(loop(7, 1), 1)).toBeNull();
    expect(detectSnapShape(loop(7, 1), 2)).toMatchObject({ kind: 'circle' });
  });

  it('leaves corners and heavily retraced lines intact', () => {
    expect(detectSnapShape([point(0, 0), point(55, 22), point(110, 0)], 1)).toBeNull();
    expect(detectSnapShape([point(0, 0), point(70, 0), point(50, 0), point(100, 0)], 1)).toBeNull();
  });

  it.each([1, -1] as const)('fits a rough loop drawn in direction %s', (direction) => {
    const samples = loop(48, direction, 2 * Math.PI - 0.2, 1, 0.065);
    const last = samples[samples.length - 1];
    const result = detectSnapShape([...samples, ...Array<Point>(60).fill(last)], 1);
    expect(result).toMatchObject({ kind: 'circle', direction });
    if (result?.kind !== 'circle') throw new Error('Expected a circle');
    expect(Math.abs(result.radius - 48)).toBeLessThan(2);
    expect(Math.hypot(result.center.x - 1035, result.center.y - 620)).toBeLessThan(2);
    expect(Math.abs(result.startAngle - (-0.8 + Math.PI / 4))).toBeLessThan(0.06);
  });

  it('does not complete an open arc or a pronounced ellipse', () => {
    expect(detectSnapShape(loop(48, 1, 1.8 * Math.PI), 1)).toBeNull();
    expect(detectSnapShape(loop(48, 1, 2 * Math.PI, 1.45), 1)).toBeNull();
  });

  it('rejects polygonal outlines and loops traced twice', () => {
    const box = [
      point(300, 300),
      point(355, 300),
      point(355, 355),
      point(300, 355),
      point(300, 300),
    ];
    const rectangle = box.slice(1).flatMap((b, i) => {
      const a = box[i];
      return Array.from({ length: 10 }, (_, n) =>
        point(a.x + ((b.x - a.x) * n) / 10, a.y + ((b.y - a.y) * n) / 10),
      );
    });
    expect(detectSnapShape([...rectangle, box[0]], 1)).toBeNull();
    expect(detectSnapShape(loop(48, 1, 4 * Math.PI), 1)).toBeNull();
  });
});
