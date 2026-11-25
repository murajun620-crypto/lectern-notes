import { describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import {
  blankPage,
  parseYoutubeUrl,
  pointInPolygon,
  segmentDistance,
  strokeBounds,
  strokeHit,
  traceInkPath,
  transformStroke,
  type Stroke,
} from './model';
import { drawPdfInk } from './pdf-ink';
import { validateProject } from './storage';

const triangleStroke: Stroke = {
  id: 'triangle',
  tool: 'pen',
  penKind: 'pencil',
  color: '#445566',
  width: 4,
  polygon: true,
  points: [
    { x: 10, y: 10, p: 0.5 },
    { x: 90, y: 10, p: 0.5 },
    { x: 90, y: 90, p: 0.5 },
    { x: 10, y: 10, p: 0.5 },
  ],
};

describe('YouTube URL safety', () => {
  it.each([
    'https://youtu.be/M7lc1UVf-VE?t=3',
    'https://www.youtube.com/watch?v=M7lc1UVf-VE&x=1',
    'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE',
  ])('accepts %s', (url) =>
    expect(parseYoutubeUrl(url)).toEqual({ id: 'M7lc1UVf-VE', portrait: false }),
  );
  it('recognizes a Shorts share URL as portrait', () => {
    expect(parseYoutubeUrl('https://m.youtube.com/shorts/M7lc1UVf-VE?si=example')).toEqual({
      id: 'M7lc1UVf-VE',
      portrait: true,
    });
  });
  it.each([
    'https://youtube.com.evil.example/watch?v=M7lc1UVf-VE',
    'javascript:alert(1)',
    'https://example.com/M7lc1UVf-VE',
    'https://youtube.com/watch?v=bad',
  ])('rejects %s', (url) => expect(parseYoutubeUrl(url)).toBeNull());
});
describe('page-space geometry', () => {
  it('moves and scales both boundaries of a closed pen circle with its samples', () => {
    const original: Stroke = {
      id: 'ring',
      tool: 'pen',
      penKind: 'pencil',
      color: '#445566',
      width: 4,
      circle: { x: 10, y: 20, radius: 8 },
      points: [
        { x: 18, y: 20, p: 0.5 },
        { x: 10, y: 28, p: 0.5 },
      ],
    };
    const stroke = transformStroke(original, 2, 3, -5);
    expect(stroke.circle).toEqual({ x: 23, y: 35, radius: 16 });
    expect(stroke.width).toBe(8);
    expect(stroke.points[0]).toEqual({ x: 39, y: 35, p: 0.5 });
    expect(strokeBounds(stroke)).toEqual({ left: 2, top: 14, right: 44, bottom: 56 });
    const path = {
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      closePath: vi.fn(),
    };
    traceInkPath(path, stroke);
    expect(path.moveTo.mock.calls).toEqual([
      [43, 35],
      [35, 35],
    ]);
    expect(path.closePath).toHaveBeenCalledTimes(2);
    const arcs = path.bezierCurveTo.mock.calls;
    const perCircle = arcs.length / 2;
    // The outer curve initially moves downward, the inner curve upward, and both end at the start.
    expect(arcs[0][1]).toBeGreaterThan(35);
    expect(arcs[perCircle][1]).toBeLessThan(35);
    expect(arcs[perCircle - 1].slice(-2)).toEqual([43, 35]);
    expect(arcs.at(-1)!.slice(-2)).toEqual([35, 35]);
  });
  it('traces one closed path of straight sides after moving and scaling a snapped polygon', () => {
    const stroke = transformStroke(triangleStroke, 2, 3, -5);
    const path = {
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      closePath: vi.fn(),
    };
    traceInkPath(path, stroke);
    expect(path.moveTo.mock.calls).toEqual([[23, 15]]);
    expect(path.lineTo.mock.calls).toEqual([
      [183, 15],
      [183, 175],
    ]);
    expect(path.closePath).toHaveBeenCalledTimes(1);
    expect(path.quadraticCurveTo).not.toHaveBeenCalled();
    expect(path.bezierCurveTo).not.toHaveBeenCalled();
    expect(strokeHit(stroke, { x: 103, y: 95, p: 0.5 }, 0)).toBe(true);
    expect(strokeHit(stroke, { x: 138, y: 95, p: 0.5 }, 0)).toBe(false);
  });
  it('exports the snapped outline as one textured PDF stroke with its partial erasure', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    drawPdfInk(page, [
      {
        ...triangleStroke,
        erasures: [{ id: 'partial', width: 10, points: [{ x: 50, y: 10, p: 0.5 }] }],
      },
    ]);
    const xObjects = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const [[, ref]] = xObjects.entries();
    const form = doc.context.lookup(ref);
    if (!(form instanceof PDFRawStream)) throw new Error('Expected a handwriting form stream');
    const content = Buffer.from(decodePDFRawStream(form).decode()).toString('ascii');
    expect(content).toContain('W* n');
    expect(content).toMatch(/\/Pattern CS \/Graphite\d+ SCN\n4 w 1 j/);
    expect(content).toContain('10 10 m\n90 10 l\n90 90 l\nh\nS');
  });
  it('hits segments between sparse pointer samples', () => {
    expect(
      strokeHit(
        {
          id: 's',
          tool: 'pen',
          color: '#000000',
          width: 2,
          points: [
            { x: 0, y: 0, p: 0.5 },
            { x: 100, y: 0, p: 0.5 },
          ],
        },
        { x: 50, y: 4, p: 0.5 },
        4,
      ),
    ).toBe(true);
    expect(
      segmentDistance({ x: 50, y: 25, p: 0.5 }, { x: 0, y: 0, p: 0.5 }, { x: 100, y: 0, p: 0.5 }),
    ).toBe(25);
  });
  it('selects an enclosed point', () =>
    expect(
      pointInPolygon({ x: 5, y: 5, p: 0.5 }, [
        { x: 0, y: 0, p: 0.5 },
        { x: 10, y: 0, p: 0.5 },
        { x: 10, y: 10, p: 0.5 },
        { x: 0, y: 10, p: 0.5 },
      ]),
    ).toBe(true));
});
describe('backup validation', () => {
  const valid = () => ({
    id: 'p',
    name: 'test',
    createdAt: 0,
    updatedAt: 0,
    currentPage: 0,
    pages: [blankPage()],
  });
  it('accepts a valid project', () => expect(() => validateProject(valid())).not.toThrow());
  it('checks the optional circle center and radius in imported pen ink', () => {
    const project = valid();
    const stroke: Stroke = {
      id: 'ring',
      tool: 'pen',
      color: '#000000',
      width: 2,
      points: [{ x: 18, y: 20, p: 0.5 }],
      circle: { x: 10, y: 20, radius: 8 },
    };
    project.pages[0].strokes = [stroke];
    expect(() => validateProject(project)).not.toThrow();
    for (const circle of [null, { x: NaN, y: 20, radius: 8 }, { x: 10, y: 20, radius: 0 }]) {
      const page = { ...project.pages[0], strokes: [{ ...stroke, circle }] };
      expect(() => validateProject({ ...project, pages: [page] })).toThrow();
    }
    project.pages[0].strokes = [{ ...stroke, tool: 'highlighter' }];
    expect(() => validateProject(project)).toThrow();
  });
  it('accepts a closed snapped polygon and rejects an open one in a backup', () => {
    const project = valid();
    project.pages[0].strokes = [triangleStroke];
    expect(() => validateProject(project)).not.toThrow();
    project.pages[0].strokes = [
      {
        ...triangleStroke,
        points: [...triangleStroke.points.slice(0, -1), { x: 11, y: 10, p: 0.5 }],
      },
    ];
    expect(() => validateProject(project)).toThrow();
  });
  it('accepts optional subject and academic year tags and rejects malformed fields', () => {
    expect(() =>
      validateProject({ ...valid(), subject: '物理学', academicYear: '2026' }),
    ).not.toThrow();
    for (const tags of [
      { subject: [] },
      { subject: ' ' },
      { subject: '字'.repeat(81) },
      { academicYear: 2026 },
      { academicYear: '20' },
    ]) {
      expect(() => validateProject({ ...valid(), ...tags })).toThrow();
    }
  });
  it('accepts video placements that extend beyond the paper', () => {
    const p = valid();
    p.pages[0].videos = [
      { id: 'v', videoId: 'M7lc1UVf-VE', x: -40, y: 780, width: 160, height: 90 },
    ];
    expect(() => validateProject(p)).not.toThrow();
    p.pages[0].videos[0].collapsed = true;
    expect(() => validateProject(p)).not.toThrow();
    expect(() =>
      validateProject({
        ...p,
        pages: [{ ...p.pages[0], videos: [{ ...p.pages[0].videos[0], collapsed: 'true' }] }],
      }),
    ).toThrow();
  });
  it('rejects invalid coordinates and missing pages', () => {
    const p = valid();
    p.pages[0].videos = [
      { id: 'v', videoId: 'M7lc1UVf-VE', x: 950, y: 0, width: 400, height: 200 },
    ];
    expect(() => validateProject(p)).toThrow();
    expect(() => validateProject({ ...valid(), pages: [] })).toThrow();
  });
  it('rejects non-finite ink points and unsafe colors', () => {
    const p = valid();
    p.pages[0].strokes = [
      { id: 's', tool: 'pen', color: '#000000', width: 2, points: [{ x: NaN, y: 0, p: 0.5 }] },
    ];
    expect(() => validateProject(p)).toThrow();
  });
  it('accepts both legacy ink and the new pen kinds in a backup', () => {
    const p = valid();
    const stroke = {
      id: 's',
      tool: 'pen' as const,
      color: '#000000',
      width: 2,
      points: [{ x: 15, y: 15, p: 0.5 }],
    };
    p.pages[0].strokes = [
      stroke,
      ...(['ballpoint', 'fountain', 'pencil', 'brush'] as const).map((penKind) => ({
        ...stroke,
        id: penKind,
        penKind,
      })),
    ];
    expect(() => validateProject(p)).not.toThrow();
    expect(() =>
      validateProject({
        ...p,
        pages: [{ ...p.pages[0], strokes: [{ ...stroke, penKind: 'unknown' }] }],
      }),
    ).toThrow();
  });
});
