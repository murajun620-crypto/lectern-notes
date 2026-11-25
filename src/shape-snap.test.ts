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

function traceOutline(corners: Point[], wobble = 0) {
  return [
    corners[0],
    ...corners.slice(1).flatMap((end, index) => {
      const start = corners[index];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      return Array.from({ length: 12 }, (_, sample) => {
        const progress = (sample + 1) / 12;
        const offset = wobble * Math.sin(progress * 2 * Math.PI);
        return point(
          start.x + dx * progress - (dy / length) * offset,
          start.y + dy * progress + (dx / length) * offset,
        );
      });
    }),
  ];
}

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

  it('straightens a rough tilted triangle, keeping the three drawn corners', () => {
    const triangle = [point(50, 25), point(118, 112), point(22, 95), point(50, 25)];
    const outline = traceOutline(triangle, 3);
    const expected = triangle.slice(0, 3).map(({ x, y }) => ({ x, y }));
    for (const stroke of [outline, [...outline].reverse()]) {
      const heldStroke = [...stroke, ...Array<Point>(60).fill(stroke[stroke.length - 1])];
      expect(detectSnapShape(heldStroke, 1)).toEqual({
        kind: 'triangle',
        vertices: expect.arrayContaining(expected),
      });
    }
  });

  it('straightens a tilted quadrilateral started mid-edge with a small gap at the join', () => {
    const corners = [point(128, 66), point(109, 106), point(29, 66), point(48, 26)];
    const midEdge = point(73, 38.5);
    const outline = traceOutline([midEdge, ...corners, midEdge], 2).slice(0, -2);
    expect(detectSnapShape(outline, 1)).toEqual({
      kind: 'quadrilateral',
      vertices: expect.arrayContaining(corners.map(({ x, y }) => ({ x, y }))),
    });
  });

  it('does not close open, self-crossing, or tiny outlines', () => {
    const box = [point(30, 30), point(90, 30), point(90, 90), point(30, 90)];
    expect(detectSnapShape(traceOutline(box), 1)).toBeNull();
    expect(detectSnapShape(traceOutline([box[0], box[2], box[1], box[3], box[0]]), 1)).toBeNull();
    const small = [point(30, 30), point(42, 30), point(40, 41), point(30, 30)];
    expect(detectSnapShape(traceOutline(small), 1)).toBeNull();
  });

  it('rejects loops traced twice', () => {
    const box = [point(30, 30), point(90, 30), point(90, 90), point(30, 90)];
    expect(detectSnapShape(traceOutline([...box, ...box, box[0]]), 1)).toBeNull();
    expect(detectSnapShape(loop(48, 1, 4 * Math.PI), 1)).toBeNull();
  });
});
