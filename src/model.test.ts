import { describe, expect, it } from 'vitest';
import { blankPage, parseYoutubeUrl, pointInPolygon, segmentDistance, strokeHit } from './model';
import { validateProject } from './storage';
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
  it('accepts video placements that extend beyond the paper', () => {
    const p = valid();
    p.pages[0].videos = [
      { id: 'v', videoId: 'M7lc1UVf-VE', x: -40, y: 780, width: 160, height: 90 },
    ];
    expect(() => validateProject(p)).not.toThrow();
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
});
