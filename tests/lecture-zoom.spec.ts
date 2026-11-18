import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
async function demo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'まずは3ページのサンプルで試す' }).click();
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await expect(page.getByText('ページを読み込み中…', { exact: true })).toBeHidden();
}
async function projects(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('lectern', 1);
      r.onsuccess = () => resolve(r.result);
    });
    try {
      return await new Promise<any[]>((resolve) => {
        const r = db.transaction('projects').objectStore('projects').getAll();
        r.onsuccess = () => resolve(r.result);
      });
    } finally {
      db.close();
    }
  });
}
async function touch(
  page: Page,
  type: string,
  points: { identifier: number; clientX: number; clientY: number }[],
  changed = points,
) {
  await page.getByTestId('stage').evaluate(
    (el, args) => {
      const e = new Event(args.type, { bubbles: true, cancelable: true });
      Object.defineProperties(e, {
        touches: { value: args.points },
        changedTouches: { value: args.changed },
      });
      el.dispatchEvent(e);
    },
    { type, points, changed },
  );
}

test('lecture has highlighter, no document header, and an independent persistent laser width', async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await demo(page);
  const before = (await page.getByTestId('stage').boundingBox())!;
  await page.getByRole('button', { name: '講義を始める', exact: true }).click();
  await expect(page.locator('.editor-header')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '更新確認', exact: true })).toHaveCount(0);
  await expect(page.locator('.export-menu')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '蛍光ペン', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '編集に戻る', exact: true })).toBeVisible();
  await expect
    .poll(async () => (await page.getByTestId('stage').boundingBox())!.height)
    .toBeGreaterThan(before.height + 40);
  await page.getByRole('button', { name: '蛍光ペン', exact: true }).click();
  let r = (await page.getByTestId('pdf-page').boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.2, r.y + r.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.6, r.y + r.height * 0.4, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await projects(page))[0].pages[0].strokes[0]?.tool)
    .toBe('highlighter');
  await page.getByRole('button', { name: 'レーザー', exact: true }).click();
  await page.getByLabel('レーザーの太さ', { exact: true }).selectOption('2');
  const stage = (await page.getByTestId('stage').boundingBox())!;
  const trace = async () => {
    r = (await page.getByTestId('pdf-page').boundingBox())!;
    await page.mouse.move(r.x + r.width * 0.2, r.y + r.height * 0.7);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width * 0.8, r.y + r.height * 0.7, { steps: 10 });
    await page.mouse.up();
  };
  const thickness = () =>
    page.locator('.laser-canvas').evaluate(
      (el: HTMLCanvasElement, args) => {
        const x = Math.round(((args.x - args.sx) * el.width) / args.sw),
          y = Math.round(((args.y - args.sy) * el.height) / args.sh);
        const data = el.getContext('2d')!.getImageData(x, y - 20, 1, 41).data;
        let count = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 30) count++;
        return count;
      },
      {
        x: r.x + r.width * 0.5,
        y: r.y + r.height * 0.7,
        sx: stage.x,
        sy: stage.y,
        sw: stage.width,
        sh: stage.height,
      },
    );
  await trace();
  await expect.poll(thickness).toBeGreaterThan(0);
  const thin = await thickness();
  await page.getByLabel('レーザーの太さ', { exact: true }).selectOption('12');
  await trace();
  await expect.poll(thickness).toBeGreaterThan(thin + 4);
  expect((await projects(page))[0].pages[0].strokes).toHaveLength(1);
  await page.screenshot({ path: `artifacts/lecture-tools-${browserName}.png` });
  await page.getByRole('button', { name: '編集に戻る', exact: true }).click();
  await expect(page.getByRole('button', { name: '更新確認', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  await expect(page.getByLabel('ペンの太さ', { exact: true })).toHaveValue('2.5');
  await page.reload();
  await page.getByRole('button', { name: 'レーザー', exact: true }).click();
  await expect(page.getByLabel('レーザーの太さ', { exact: true })).toHaveValue('12');
});

test('pinch scales cached layers without raster resizing or a loading overlay, then sharpens once', async ({
  page,
}) => {
  await demo(page);
  const paper = (await page.getByTestId('pdf-page').boundingBox())!;
  const initial = await page
    .locator('.pdf-canvas')
    .evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));
  const inkWidth = await page.getByTestId('ink-canvas').evaluate((c: HTMLCanvasElement) => c.width);
  await page.evaluate(() => {
    (window as any).__rasterChanges = [];
    const c = document.querySelector('.pdf-canvas')!;
    new MutationObserver((records) =>
      (window as any).__rasterChanges.push(...records.map((r) => r.attributeName)),
    ).observe(c, { attributes: true, attributeFilter: ['width', 'height'] });
  });
  const cx = paper.x + paper.width / 2,
    cy = paper.y + paper.height / 2;
  const a = { identifier: 1, clientX: cx - 40, clientY: cy },
    b = { identifier: 2, clientX: cx + 40, clientY: cy };
  await touch(page, 'touchstart', [a, b]);
  for (let i = 1; i <= 12; i++) {
    const d = 40 + i * 4;
    await touch(page, 'touchmove', [
      { ...a, clientX: cx - d },
      { ...b, clientX: cx + d },
    ]);
    await expect(page.locator('.pdf-loading')).toHaveCount(0);
  }
  await expect
    .poll(async () => (await page.getByTestId('pdf-page').boundingBox())!.width / paper.width)
    .toBeGreaterThan(2);
  expect(await page.locator('.pdf-canvas').evaluate((c: HTMLCanvasElement) => c.width)).toBe(
    initial.w,
  );
  expect(await page.getByTestId('ink-canvas').evaluate((c: HTMLCanvasElement) => c.width)).toBe(
    inkWidth,
  );
  expect(await page.evaluate(() => (window as any).__rasterChanges)).toEqual([]);
  await touch(
    page,
    'touchend',
    [],
    [
      { ...a, clientX: cx - 88 },
      { ...b, clientX: cx + 88 },
    ],
  );
  await expect
    .poll(async () => Number(await page.getByLabel('表示倍率').inputValue()))
    .toBeCloseTo(2.2, 1);
  await expect
    .poll(() => page.locator('.pdf-canvas').evaluate((c: HTMLCanvasElement) => c.width))
    .toBeGreaterThan(initial.w * 1.8);
  expect(await page.evaluate(() => (window as any).__rasterChanges.length)).toBe(2);
  await expect(page.locator('.pdf-loading')).toHaveCount(0);
  const sharp = await page.locator('.pdf-canvas').evaluate((c: HTMLCanvasElement) => c.width);
  await page.getByLabel('表示倍率').selectOption('1');
  await page.getByLabel('表示倍率').selectOption('2');
  expect(await page.locator('.pdf-canvas').evaluate((c: HTMLCanvasElement) => c.width)).toBe(sharp);
  const r = (await page.getByTestId('pdf-page').boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.3, r.y + r.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.5, r.y + r.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await projects(page))[0].pages[0].strokes.length).toBe(1);
  const pg = (await projects(page))[0].pages[0];
  expect(Math.abs(pg.strokes[0].points[0].x - pg.width * 0.3)).toBeLessThan(2);
  expect(Math.abs(pg.strokes[0].points[0].y - pg.height * 0.4)).toBeLessThan(2);
});

test('video placement and inline player stay aligned after compositor zoom', async ({ page }) => {
  await page.route('https://www.youtube.com/iframe_api', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.YT={Player:class{constructor(el,o){this.iframe=document.createElement('iframe');this.iframe.src='about:blank';el.replaceWith(this.iframe);window.__playerCount=(window.__playerCount||0)+1;setTimeout(()=>o.events.onReady(),20);}playVideo(){}getIframe(){return this.iframe;}destroy(){this.iframe.remove();}}};window.onYouTubeIframeAPIReady();`,
    }),
  );
  await demo(page);
  await page.getByLabel('表示倍率').selectOption('2');
  await page.getByRole('button', { name: 'YouTube挿入' }).click();
  await page.getByLabel('YouTube URL').fill('https://youtu.be/M7lc1UVf-VE');
  await page.getByRole('button', { name: 'このページに追加' }).click();
  await expect(page.getByTestId('video-box')).toBeVisible();
  await expect.poll(async () => (await projects(page))[0].pages[0].videos.length).toBe(1);
  const pg = (await projects(page))[0].pages[0],
    v = pg.videos[0],
    r = (await page.getByTestId('pdf-page').boundingBox())!,
    thumb = (await page.getByTestId('video-box').boundingBox())!;
  expect((thumb.x - r.x) / r.width).toBeCloseTo(v.x / pg.width, 2);
  expect(thumb.width / r.width).toBeCloseTo(v.width / pg.width, 2);
  await page.getByRole('button', { name: '動画をページ内で再生' }).click();
  await expect(page.getByTitle('YouTube動画', { exact: true })).toBeVisible();
  let player = (await page.getByTitle('YouTube動画', { exact: true }).boundingBox())!;
  expect(player.width).toBeGreaterThanOrEqual(239);
  expect(player.height).toBeGreaterThanOrEqual(199);
  const iframeViewport = () =>
    page.getByTitle('YouTube動画', { exact: true }).evaluate((el) => ({
      width: el.clientWidth,
      height: el.clientHeight,
    }));
  expect((await iframeViewport()).width).toBeGreaterThanOrEqual(239);
  expect((await iframeViewport()).height).toBeGreaterThanOrEqual(199);
  await page.getByLabel('表示倍率').selectOption('1.5');
  player = (await page.getByTitle('YouTube動画', { exact: true }).boundingBox())!;
  expect(player.width).toBeGreaterThanOrEqual(239);
  expect(player.height).toBeGreaterThanOrEqual(199);
  expect((await iframeViewport()).height).toBeGreaterThanOrEqual(199);
  expect(await page.evaluate(() => (window as any).__playerCount)).toBe(1);
  await page.getByTitle('動画を閉じる', { exact: true }).click();
  expect((await projects(page))[0].pages[0].videos[0]).toEqual(v);
});
