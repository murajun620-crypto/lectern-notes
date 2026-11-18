import { describe, it, expect, vi } from 'vitest';
import { effectiveTool, PalmGuard } from './input';
import { initialVideoRect, playbackRect } from './video-layout';
import { penOutline, drawLaser } from './model';
describe('automatic Pencil and finger routing', () => {
  it('keeps the last Pencil tool while hand mode remains available to mouse', () => {
    expect(effectiveTool('hand', 'pen', 'pen', false)).toBe('pen');
    expect(effectiveTool('hand', 'eraser', 'pen', false)).toBe('eraser');
    expect(effectiveTool('hand', 'pen', 'mouse', false)).toBe('hand');
    expect(effectiveTool('eraser', 'pen', 'pen', false)).toBe('eraser');
  });
});
describe('palm rejection lifecycle', () => {
  it('quarantines a palm that lands before the Pencil until it lifts', () => {
    const g = new PalmGuard();
    expect(g.touchDown(1, 10, 10, 0, true)).toBe(true);
    g.penDown(2, 50);
    expect(g.allowsTouch(1)).toBe(false);
    g.penUp(2, 100);
    expect(g.allowsTouch(1)).toBe(false);
    expect(g.touchDown(1, 10, 10, 900, true)).toBe(false);
    g.touchUp(1);
    expect(g.touchDown(1, 10, 10, 1000, true)).toBe(true);
  });
  it('rejects contacts during drawing and briefly after, then restores finger navigation', () => {
    const g = new PalmGuard();
    g.penDown(1, 0);
    expect(g.touchDown(2, 5, 5, 100, true)).toBe(false);
    g.penUp(1, 200);
    expect(g.touchDown(3, 5, 5, 300, true)).toBe(false);
    expect(g.touchDown(4, 5, 5, 600, true)).toBe(true);
    expect(g.blocksNavigation(300, true)).toBe(true);
    g.touchUp(2);
    g.touchUp(3);
    expect(g.blocksNavigation(600, true)).toBe(false);
  });
  it('rejects broad contacts and can recover after losing focus', () => {
    const g = new PalmGuard();
    expect(g.touchDown(1, 65, 40, 0, true)).toBe(false);
    expect(g.blocksNavigation(0, true)).toBe(true);
    g.penDown(2, 50);
    g.reset(100);
    expect(g.touchDown(1, 5, 5, 500, true)).toBe(true);
    expect(g.touchDown(3, 65, 40, 500, false)).toBe(true);
  });
});
describe('small thumbnail and independent playback geometry', () => {
  it('uses a small 16:9 thumbnail on either portrait or landscape paper', () => {
    for (const page of [
      { width: 595.28, height: 841.89 },
      { width: 960, height: 540 },
    ]) {
      const r = initialVideoRect(page);
      expect(r.width).toBe(160);
      expect(r.height).toBe(90);
    }
  });
  it('keeps a minimum-size player inside the paper without mutating stored thumbnail size', () => {
    const v = { id: 'v', videoId: 'M7lc1UVf-VE', x: 500, y: 780, width: 64, height: 36 };
    const r = playbackRect(v, { width: 450, height: 636 }, { width: 595.28, height: 841.89 });
    expect(r.width).toBeGreaterThanOrEqual(240);
    expect(r.height).toBeGreaterThanOrEqual(200);
    expect(r.left + r.width).toBeLessThanOrEqual(450);
    expect(r.top + r.height).toBeLessThanOrEqual(636);
    expect(v.width).toBe(64);
  });
});
describe('smooth pressure-bearing stroke outline', () => {
  const stroke = {
    id: 's',
    tool: 'pen' as const,
    color: '#183e3a',
    width: 12,
    points: [
      { x: 0, y: 0, p: 0.2 },
      { x: 20, y: 2, p: 0.2 },
      { x: 40, y: 0, p: 0.2 },
    ],
  };
  it('renders a single Pencil dot and sparse curves as finite closed outlines', () => {
    for (const s of [stroke, { ...stroke, points: stroke.points.slice(0, 1) }]) {
      const points = penOutline(s);
      expect(points.length).toBeGreaterThan(4);
      expect(points.flat().every(Number.isFinite)).toBe(true);
    }
  });
  it('uses real pressure to vary width', () => {
    const extent = (p: number) => {
      const outline = penOutline({ ...stroke, points: stroke.points.map((pt) => ({ ...pt, p })) });
      const ys = outline.map((pt) => pt[1]);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(extent(0.85)).toBeGreaterThan(extent(0.1));
  });
});
describe('laser trail compositing', () => {
  it('draws one continuous curve and one head instead of overlapping round segments', () => {
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    drawLaser(
      ctx,
      Array.from({ length: 20 }, (_, i) => ({ x: i * 3, y: Math.sin(i / 3) * 10, t: i * 10 })),
      1,
      200,
      true,
    );
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
    expect(ctx.arc).toHaveBeenCalledTimes(1);
    expect(ctx.quadraticCurveTo).toHaveBeenCalledTimes(18);
  });
});
