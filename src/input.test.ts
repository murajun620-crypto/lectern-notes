import { describe, it, expect, vi } from 'vitest';
import { effectiveTool, PalmGuard } from './input';
import { enlargedVideoRect, initialVideoRect, playerViewport, resizeVideo } from './video-layout';
import { penKinds, penOutline, drawLaser, pointInPolygon, strokeCenterline } from './model';
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
  it('uses broad-contact rejection only after real Pencil activity and recovers on blur', () => {
    const g = new PalmGuard();
    expect(g.touchDown(1, 65, 40, 0, true)).toBe(true);
    g.penDown(2, 50);
    g.penUp(2, 60);
    expect(g.touchDown(3, 100, 90, 500, true, false)).toBe(false);
    expect(g.blocksNavigation(500, true)).toBe(true);
    g.reset(100);
    expect(g.touchDown(1, 65, 40, 100, true)).toBe(true);
    expect(g.touchDown(3, 100, 90, 100, true)).toBe(true);
    expect(g.blocksClick('touch', 65, 40, 100, true)).toBe(false);
  });
  it('never treats large fingers on a Pencil-free device as palms', () => {
    const g = new PalmGuard();
    for (let id = 1; id <= 3; id++) expect(g.touchDown(id, 60, 55, 0, true, true)).toBe(true);
    expect(g.blocksNavigation(0, true)).toBe(false);
    expect(g.blocksClick('touch', 60, 55, 0, true)).toBe(false);
    expect(g.rejectsGeometry(60, 55, 0, true)).toBe(false);
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
  it('keeps the iframe viewport sized for its controls while fitting a small portrait placement', () => {
    const page = { width: 595.28, height: 841.89 };
    const v = { id: 'v', videoId: 'M7lc1UVf-VE', ...initialVideoRect(page, true) };
    const small = resizeVideo(v, page, 0.01);
    expect(small.width).toBe(36);
    expect(small.height).toBe(64);
    const player = playerViewport(small, 0.8, 2);
    expect(player.width).toBeGreaterThanOrEqual(200);
    expect(player.height / player.width).toBeCloseTo(16 / 9);
  });
  it('keeps optional enlargement inside the paper without changing stored placement', () => {
    const v = { id: 'v', videoId: 'M7lc1UVf-VE', x: 500, y: 780, width: 64, height: 36 };
    const r = enlargedVideoRect(v, { width: 595.28, height: 841.89 }, 0.75);
    expect(r.width / r.height).toBeCloseTo(16 / 9);
    expect(r.width * 0.75).toBeCloseTo(360);
    expect(r.x + r.width).toBeLessThanOrEqual(595.28);
    expect(r.y + r.height).toBeLessThanOrEqual(841.89);
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
  it('keeps a tap centered and the cap of a short, densely sampled mark within its nib radius', () => {
    for (const offsets of [[0], [0, 0.5, 1, 1.5, 2]]) {
      const outline = penOutline({
        ...stroke,
        width: 1,
        points: offsets.map((dx) => ({ x: 100 + dx, y: 200, p: 0.5 })),
      });
      const xs = outline.map(([x]) => x);
      const ys = outline.map(([, y]) => y);
      expect(Math.min(...xs)).toBeCloseTo(99.5, 1);
      expect(Math.max(...xs)).toBeCloseTo(100.5 + offsets.at(-1)!, 1);
      expect(Math.min(...ys)).toBeCloseTo(199.5, 1);
      expect(Math.max(...ys)).toBeCloseTo(200.5, 1);
    }
  });
  it('connects a tight terminal turn to the round tip at the recorded nib width', () => {
    const points = [
      ...Array.from({ length: 25 }, (_, i) => ({ x: i / 2, y: 0, p: 0.5 })),
      ...[0.5, 1, 1.5].map((y) => ({ x: 12, y, p: 0.5 })),
    ];
    const outline = penOutline({ ...stroke, width: 1, points });
    const polygon = outline.map(([x, y]) => ({ x, y, p: 0.5 }));
    for (const p of points.slice(-6, -1)) expect(pointInPolygon(p, polygon)).toBe(true);
    expect(pointInPolygon({ x: 11, y: -0.3, p: 0.5 }, polygon)).toBe(true);
    expect(Math.max(...outline.map(([, y]) => y))).toBeCloseTo(2, 2);
  });
  it('keeps very light pressure visible and still varies width with pressure', () => {
    const extent = (p: number) => {
      const outline = penOutline({ ...stroke, points: stroke.points.map((pt) => ({ ...pt, p })) });
      const ys = outline.map((pt) => pt[1]);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(extent(0.001)).toBeGreaterThan(stroke.width * 0.72);
    expect(extent(0.85)).toBeGreaterThan(extent(0.1));
  });
  it('gives the fountain nib directional width and keeps dots visible for each pen', () => {
    const samples = Array.from({ length: 20 }, (_, i) => i * 5);
    const diagonal = (dx: number, dy: number) => {
      const outline = penOutline({
        ...stroke,
        penKind: 'fountain',
        points: samples.map((d) => ({ x: d * dx, y: d * dy, p: 0.5 })),
      });
      const perpendicular = outline.map(([x, y]) => -x * dy + y * dx);
      return Math.max(...perpendicular) - Math.min(...perpendicular);
    };
    expect(diagonal(0.6, 0.8)).toBeGreaterThan(diagonal(0.8, -0.6) * 1.4);
    for (const penKind of penKinds) {
      const dot = penOutline({ ...stroke, penKind, points: [stroke.points[0]] });
      expect(dot.length).toBeGreaterThan(4);
      expect(dot.flat().every(Number.isFinite)).toBe(true);
    }
  });
  it('keeps short brush marks visible as contact samples arrive', () => {
    for (const count of [2, 3, 7]) {
      const outline = penOutline({
        ...stroke,
        penKind: 'brush',
        width: 4,
        points: Array.from({ length: count }, (_, i) => ({
          x: (4 * i) / (count - 1),
          y: 0,
          p: 0.05,
        })),
      });
      const ys = outline.map(([, y]) => y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(2);
    }
  });
  it('uses the selected nib radius on a two-sample hairline', () => {
    const outline = penOutline({
      ...stroke,
      penKind: 'brush',
      width: 4,
      points: [
        { x: 0, y: 0, p: 0.04 },
        { x: 2, y: 0, p: 0.04 },
      ],
    });
    const xs = outline.map(([x]) => x);
    const ys = outline.map(([, y]) => y);
    const radius = 4 * (0.5 + 0.86 * (0.24 - 0.5));
    expect(Math.min(...xs)).toBeCloseTo(-radius);
    expect(Math.max(...xs)).toBeCloseTo(2 + radius);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2 * radius);
  });
  it('interpolates sparse pen curves inside the contact span and preserves pressure and corners', () => {
    const points = [
      { x: 0, y: 0, p: 0.12 },
      { x: 14, y: 10, p: 0.25 },
      { x: 30, y: 17, p: 0.5 },
      { x: 50, y: 20, p: 0.8 },
    ];
    const curved = strokeCenterline({ ...stroke, width: 1, points });
    expect(curved.length).toBeGreaterThan(points.length);
    expect(curved[0]).toBe(points[0]);
    expect(curved.at(-1)).toBe(points.at(-1));
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const span = curved.slice(curved.indexOf(a), curved.indexOf(b) + 1);
      expect(span.every((p) => p.x >= a.x && p.x <= b.x && p.y >= a.y && p.y <= b.y)).toBe(true);
      expect(span.every((p) => p.p >= a.p && p.p <= b.p)).toBe(true);
    }
    const corner = [points[0], { x: 30, y: 0, p: 0.3 }, { x: 30, y: 30, p: 0.6 }];
    expect(strokeCenterline({ ...stroke, points: corner })).toBe(corner);
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
  it('uses the configured screen width independently of page zoom', () => {
    const widths: number[] = [];
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      stroke: () => widths.push(ctx.lineWidth),
      arc: vi.fn(),
      fill: vi.fn(),
      lineWidth: 0,
    } as unknown as CanvasRenderingContext2D;
    drawLaser(
      ctx,
      [
        { x: 0, y: 0, t: 0 },
        { x: 10, y: 10, t: 10 },
      ],
      2,
      20,
      true,
      12,
    );
    expect(widths[0]).toBe(6);
  });
});
