import { describe, expect, it } from 'vitest';
import { applyErasure } from './eraser';
import { pointErased, translateStroke } from './model';
import type { Erasure, Stroke } from './model';
import { validateProject } from './storage';

const line: Stroke = {
  id: 'ink',
  tool: 'pen',
  width: 2,
  color: '#123456',
  points: [
    { x: 0, y: 50, p: 0.2 },
    { x: 100, y: 50, p: 0.8 },
  ],
};
const cut: Erasure = {
  id: 'cut',
  width: 10,
  points: [
    { x: 50, y: 0, p: 0.5 },
    { x: 50, y: 100, p: 0.5 },
  ],
};
describe('partial circular eraser', () => {
  it('also reaches a smoothed curve that bows away from its sparse input segments', () => {
    const curve = {
      ...line,
      tool: 'highlighter' as const,
      points: [
        { x: 0, y: 0, p: 0.5 },
        { x: 100, y: 0, p: 0.5 },
        { x: 100, y: 100, p: 0.5 },
      ],
    };
    // traceCurve's quadratic passes through (75, 12.5), away from both raw segments.
    const [result] = applyErasure([curve], {
      id: 'circle',
      width: 4,
      points: [{ x: 75, y: 12.5, p: 0.5 }],
    });
    expect(result.erasures).toHaveLength(1);
  });
  it('catches a fast sweep between sparse samples without changing original ink or pressure', () => {
    const [result] = applyErasure([line], cut);
    expect(result.points).toBe(line.points);
    expect(line.erasures).toBeUndefined();
    expect(result.erasures).toEqual([cut]);
    expect(pointErased(result, { x: 50, y: 50, p: 0.5 })).toBe(true);
    expect(pointErased(result, { x: 20, y: 50, p: 0.5 })).toBe(false);
    expect(pointErased(result, { x: 80, y: 50, p: 0.5 })).toBe(false);
  });
  it('does not modify nearby strokes or add empty undo operations', () => {
    const original = [line];
    expect(applyErasure(original, { ...cut, points: [{ x: 200, y: 200, p: 0.5 }] })).toBe(original);
  });
  it('keeps a gesture as one mask and does not affect subsequently added ink', () => {
    const touched = new Set<string>();
    const first = { ...cut, points: [cut.points[0]] };
    applyErasure([line], first, touched);
    const result = applyErasure([line], cut, touched, 1);
    expect(result[0].erasures).toHaveLength(1);
    const later = { ...line, id: 'later' };
    expect(pointErased(later, { x: 50, y: 50, p: 0.5 })).toBe(false);
  });
  it('moves erased areas with their ink, preserving the source for undo', () => {
    const [original] = applyErasure([line], cut);
    const moved = translateStroke(original, 20, 30);
    expect(pointErased(moved, { x: 70, y: 80, p: 0.5 })).toBe(true);
    expect(moved.points[0]).toEqual({ x: 20, y: 80, p: 0.2 });
    expect(original.erasures![0].points[0]).toEqual(cut.points[0]);
  });
  it('validates optional masks in both old and new backup data', () => {
    const project = {
      id: 'p',
      name: 'test',
      createdAt: 0,
      updatedAt: 0,
      currentPage: 0,
      pages: [{ id: 'pg', width: 595, height: 842, videos: [], strokes: [line] }],
    };
    expect(() => validateProject(project)).not.toThrow();
    project.pages[0].strokes = applyErasure([line], cut);
    expect(() => validateProject(project)).not.toThrow();
    project.pages[0].strokes[0].erasures![0] = { ...cut, width: Infinity };
    expect(() => validateProject(project)).toThrow();
  });
});
