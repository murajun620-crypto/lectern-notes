import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { PDFDocument, rgb } from 'pdf-lib';
async function demo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'まずは3ページのサンプルで試す' }).click();
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await expect(page.getByText('ページを読み込み中…', { exact: true })).toBeHidden();
}
async function projects(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('lectern');
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

test('defaults to continuous pages, scrolls between sheets and lets ink follow a visible neighbor', async ({
  page,
}) => {
  await demo(page);
  const mode = page.getByLabel('ページ表示');
  await expect(mode).toHaveValue('continuous');
  const stage = (await page.getByTestId('stage').boundingBox())!;
  const first = (await page.getByTestId('pdf-page').boundingBox())!;
  const sheet2 = page.locator('.stack-paper').nth(1);
  await expect(sheet2).toHaveCount(1);
  const x = stage.x + stage.width / 2;
  const start = { identifier: 3, clientX: x, clientY: stage.y + stage.height * 0.75 };
  const end = { ...start, clientY: start.clientY - first.height * 0.42 };
  await touch(page, 'touchstart', [start]);
  await touch(page, 'touchmove', [end]);
  await touch(page, 'touchend', [], [end]);
  await expect(page.getByTestId('stage')).not.toHaveAttribute('data-ink-preview');
  await expect(page.getByLabel('ページ番号')).toHaveValue('1');
  const second = (await sheet2.boundingBox())!;
  expect(second.y).toBeGreaterThan(stage.y);
  expect(second.y + 80).toBeLessThan(stage.y + stage.height);

  await page.mouse.move(x, second.y + 45);
  await page.mouse.down();
  await page.mouse.move(x + 50, second.y + 60, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
  const reanchored = (await page.getByTestId('pdf-page').boundingBox())!;
  expect(reanchored.y).toBeCloseTo(second.y, 0);
  await expect
    .poll(async () => (await projects(page))[0].pages.map((p) => p.strokes.length))
    .toEqual([0, 1, 0]);

  await page.mouse.move(x, stage.y + stage.height * 0.5);
  await page.mouse.wheel(0, -first.height);
  await expect(page.getByLabel('ページ番号')).toHaveValue('1');
  await mode.selectOption('single');
  await expect(page.locator('.stack-board')).toHaveCount(0);
  await page.reload();
  await expect(mode).toHaveValue('single');
  await expect(page.locator('.stack-board')).toHaveCount(0);
});

test('fullscreen enlarges the viewport and keeps the active tool and laser settings', async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await demo(page);
  const before = (await page.getByTestId('stage').boundingBox())!;
  const highlighter = page.getByRole('button', { name: '蛍光ペン', exact: true });
  await highlighter.click();
  await page.getByRole('button', { name: '全画面表示', exact: true }).click();
  await expect(page.locator('.editor-header')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '更新確認', exact: true })).toHaveCount(0);
  await expect(page.locator('.export-menu')).toHaveCount(0);
  await expect(highlighter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '全画面表示を終了', exact: true })).toBeVisible();
  await expect
    .poll(async () => (await page.getByTestId('stage').boundingBox())!.height)
    .toBeGreaterThan(before.height + 40);
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
  await page.screenshot({ path: `artifacts/fullscreen-tools-${browserName}.png` });
  await page.getByRole('button', { name: '全画面表示を終了', exact: true }).click();
  await expect(page.getByRole('button', { name: '更新確認', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  await expect(page.getByLabel('ペンの太さ', { exact: true })).toHaveValue('2.5');
  await page.reload();
  await page.getByRole('button', { name: 'レーザー', exact: true }).click();
  await expect(page.getByLabel('レーザーの太さ', { exact: true })).toHaveValue('12');
});

test('pinch reuses the backing bitmap and sharpens the visible region after release', async ({
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
    (window as any).__postPinchInk = [];
    let released = 0;
    const stage = document.querySelector('[data-testid=stage]')!;
    const ink = stage.querySelector('.ink-canvas');
    stage.addEventListener(
      'touchend',
      () => {
        released = performance.now();
        requestAnimationFrame(
          () => ((window as any).__pinchFirstFrame = performance.now() - released),
        );
      },
      { capture: true },
    );
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (released && this.canvas === ink)
        (window as any).__postPinchInk.push(performance.now() - released);
      return clear.apply(this, args);
    };
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
  await expect(page.locator('.ink-page-preview')).toBeVisible();
  await expect(page.getByTestId('ink-canvas')).toBeHidden();
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
  await expect(page.locator('.pdf-detail-layer canvas')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__rasterChanges)).toEqual([]);
  await expect(page.getByTestId('ink-canvas')).toBeVisible();
  const timing = await page.evaluate(() => ({
    firstFrame: (window as any).__pinchFirstFrame,
    inkRefresh: (window as any).__postPinchInk[0],
  }));
  expect(timing.inkRefresh).toBeGreaterThanOrEqual(timing.firstFrame);
  await expect(page.locator('.ink-page-preview')).toBeHidden();
  await expect(page.locator('.pdf-loading')).toHaveCount(0);
  await page.getByLabel('表示倍率').selectOption('1');
  await page.getByLabel('表示倍率').selectOption('2');
  expect(await page.locator('.pdf-canvas').evaluate((c: HTMLCanvasElement) => c.width)).toBe(
    initial.w,
  );
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

test('continuous page focus keeps the sharp PDF pixels aligned across a touch release', async ({
  page,
}) => {
  await demo(page);
  await page.getByLabel('表示倍率').selectOption('2');
  const view = page.getByTestId('stage');
  const stage = (await view.boundingBox())!;
  const paper = (await page.getByTestId('pdf-page').boundingBox())!;
  const cx = stage.x + stage.width / 2;
  const cy = stage.y + stage.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, paper.y + paper.height + 18 - cy - 45);
  const detail = page.locator('.pdf-detail-surface');
  await expect(detail).toHaveCount(1);
  await expect(detail).toHaveCSS('transform', 'none');
  await expect(page.getByLabel('ページ番号')).toHaveValue('1');
  const previous = detail.locator('canvas');
  await previous.evaluate((canvas) => (canvas.dataset.keep = 'true'));
  const a = { identifier: 4, clientX: cx, clientY: cy + 65 };
  const b = { ...a, clientY: a.clientY - 95 };
  await touch(page, 'touchstart', [a]);
  await touch(page, 'touchmove', [b]);
  const kept = view.locator('canvas[data-keep]');
  await expect(detail).not.toHaveCSS('transform', 'none');
  const before = await kept.boundingBox();
  await touch(page, 'touchend', [], [b]);
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
  await expect(kept).toBeVisible();
  const after = await kept.boundingBox();
  expect(after?.y).toBeCloseTo(before!.y, 0);
  expect(after?.width).toBeCloseTo(before!.width, 0);
  await expect(detail).toHaveCount(2);
  await expect(kept).toBeVisible();
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
  await page
    .getByRole('button', { name: 'サムネイルを選択', exact: true })
    .click({ position: { x: 3, y: 3 } });
  const ribbon = page.locator('.stage-video-controls .video-handle');
  expect((await ribbon.boundingBox())!.height).toBeCloseTo(36, 0);
  await page.getByLabel('表示倍率').selectOption('10');
  await expect(ribbon).toHaveCSS('transform', 'none');
  await expect(ribbon.locator('svg').first()).toHaveCSS('width', '18px');
  expect((await ribbon.boundingBox())!.height).toBeCloseTo(36, 0);
  expect((await ribbon.boundingBox())!.x % 1).toBe(0);
  await page.getByLabel('表示倍率').selectOption('2');
  await page.getByRole('button', { name: '動画をページ内で再生' }).click();
  await expect(page.getByTitle('YouTube動画', { exact: true })).toBeVisible();
  let player = (await page.getByTitle('YouTube動画', { exact: true }).boundingBox())!;
  expect(player.width).toBeCloseTo(thumb.width, 0);
  expect(player.height).toBeCloseTo(thumb.height, 0);
  const iframeViewport = () =>
    page.getByTitle('YouTube動画', { exact: true }).evaluate((el) => ({
      width: el.clientWidth,
      height: el.clientHeight,
    }));
  expect((await iframeViewport()).width).toBeGreaterThanOrEqual(200);
  expect((await iframeViewport()).height).toBeGreaterThanOrEqual(200);
  await page.getByLabel('表示倍率').selectOption('1.5');
  player = (await page.getByTitle('YouTube動画', { exact: true }).boundingBox())!;
  expect(player.width).toBeCloseTo(thumb.width * 0.75, 0);
  expect(player.height).toBeCloseTo(thumb.height * 0.75, 0);
  expect((await iframeViewport()).height).toBeGreaterThanOrEqual(200);
  await page.getByRole('button', { name: '全画面表示', exact: true }).click();
  await expect(page.getByTitle('YouTube動画', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '全画面表示を終了', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__playerCount)).toBe(1);
  await page.getByLabel('表示倍率').selectOption('10');
  const close = page.locator('.toolbar').getByTitle('動画を閉じる', { exact: true });
  await expect(close).toHaveText('閉じる');
  await close.click();
  expect((await projects(page))[0].pages[0].videos[0]).toEqual(v);
});

test.describe('high-DPI PDF detail rendering', () => {
  test.use({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2 });

  test('large pinches and panning show sharp ink while the gesture is held', async ({ page }) => {
    await demo(page);
    await page.getByLabel('ページ表示').selectOption('single');
    const zoom = page.getByLabel('表示倍率');
    await zoom.selectOption('2');
    const stage = page.getByTestId('stage');
    const detail = page.locator('.pdf-detail-surface canvas');
    await expect(detail).toBeVisible();
    await detail.evaluate((canvas) => (canvas.dataset.startZoom = 'true'));
    const rect = (await stage.boundingBox())!;
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    await page.mouse.move(x - 95, y - 44);
    await page.mouse.down();
    await page.mouse.move(x + 95, y - 44, { steps: 15 });
    await page.mouse.up();

    const contacts = (d: number) => [
      { identifier: 1, clientX: x - d, clientY: y },
      { identifier: 2, clientX: x + d, clientY: y },
    ];
    const live = stage.locator('.ink-live-layer canvas');
    const opacity = (cx: number, cy: number) =>
      live.evaluate(
        (c: HTMLCanvasElement, at) => {
          const r = c.getBoundingClientRect();
          if (!r.width || !r.height) return 0;
          const px = Math.round(((at.x - r.left) * c.width) / r.width);
          const py = Math.round(((at.y - r.top) * c.height) / r.height);
          return c.getContext('2d')!.getImageData(px, py, 1, 1).data[3];
        },
        { x: cx, y: cy },
      );
    await touch(page, 'touchstart', contacts(40));
    await touch(page, 'touchmove', contacts(70));
    await expect(stage).toHaveAttribute('data-ink-preview', 'live');
    expect(await opacity(x, y - 77)).toBeGreaterThan(240);
    await expect(detail).not.toHaveAttribute('data-start-zoom');
    await expect(page.locator('.pdf-detail-surface')).toHaveCSS('transform', 'none');
    await expect(zoom).toHaveValue('2');
    const releasePreview = await stage.evaluate(async (el, changedTouches) => {
      const event = new Event('touchend', { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: [] },
        changedTouches: { value: changedTouches },
      });
      const frame = new Promise((resolve) =>
        requestAnimationFrame(() => resolve(el.dataset.inkPreview)),
      );
      el.dispatchEvent(event);
      return frame;
    }, contacts(70));
    expect(releasePreview).toBe('live');
    await expect(zoom).toHaveValue('3.5');
    await expect(stage).not.toHaveAttribute('data-ink-preview');

    await page.getByRole('button', { name: '移動', exact: true }).click();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 38, y + 22);
    await expect(stage).toHaveAttribute('data-ink-preview', 'live');
    const panDensity = await live.evaluate(
      (c: HTMLCanvasElement) => c.width / c.getBoundingClientRect().width,
    );
    expect(panDensity).toBeGreaterThanOrEqual(2);
    expect(await opacity(x + 38, y - 55)).toBeGreaterThan(240);
    await live.evaluate((c) => (c.dataset.panFrame = 'true'));
    await page.mouse.move(x + 65, y + 26, { steps: 3 });
    await expect.poll(() => opacity(x + 65, y - 51)).toBeGreaterThan(240);
    await expect(live).toHaveAttribute('data-pan-frame', 'true');
    await page.mouse.up();
    await expect(stage).not.toHaveAttribute('data-ink-preview');
    await expect(live).toHaveCount(0);
  });

  test('a same-page pinch keeps high-resolution PDF and uses the sharper ink pixels', async ({
    page,
  }) => {
    await demo(page);
    await page.getByLabel('ページ表示').selectOption('single');
    const stage = page.getByTestId('stage');
    const stageBox = (await stage.boundingBox())!;
    const x = stageBox.x + stageBox.width / 2;
    const y = stageBox.y + stageBox.height / 2;
    const contacts = (d: number) => [
      { identifier: 1, clientX: x - d, clientY: y },
      { identifier: 2, clientX: x + d, clientY: y },
    ];
    const zoom = page.getByLabel('表示倍率');
    const detail = page.locator('.pdf-detail-surface canvas');
    const density = (canvas: typeof detail) =>
      canvas.evaluate((c: HTMLCanvasElement) => c.width / c.getBoundingClientRect().width);
    await touch(page, 'touchstart', contacts(40));
    await touch(page, 'touchmove', contacts(50));
    await touch(page, 'touchend', [], contacts(50));
    await expect(zoom).toHaveValue('1.25');
    await expect(detail).toHaveCount(0);
    expect(await density(page.locator('.pdf-canvas'))).toBeGreaterThanOrEqual(2);

    await zoom.selectOption('2');
    await expect(detail).toBeVisible();
    await detail.evaluate((c) => c.setAttribute('data-test-reserve', ''));
    const ink = page.getByTestId('ink-canvas');
    const lineY = y - 56;
    await page.mouse.move(x - 70, lineY);
    await page.mouse.down();
    await page.mouse.move(x + 70, lineY, { steps: 10 });
    await page.mouse.up();
    const alpha = (sampleY: number) =>
      ink.evaluate(
        (canvas: HTMLCanvasElement, p) => {
          const r = canvas.getBoundingClientRect();
          const x = Math.floor(((p.x - r.left) * canvas.width) / r.width);
          const y = Math.floor(((p.y - r.top) * canvas.height) / r.height);
          return canvas.getContext('2d')!.getImageData(x, y, 1, 1).data[3];
        },
        { x, y: sampleY },
      );
    await expect.poll(() => alpha(lineY)).toBeGreaterThan(240);
    await touch(page, 'touchstart', contacts(40));
    await touch(page, 'touchmove', contacts(50));
    await expect(stage).toHaveAttribute('data-ink-preview', 'screen');
    expect(await density(detail)).toBeGreaterThanOrEqual(2);
    expect(await density(ink)).toBeCloseTo(1.6, 1);
    expect(await alpha(y - 56 * 1.25)).toBeGreaterThan(240);
    await expect(detail).toHaveAttribute('data-test-reserve', '');
    await touch(page, 'touchend', [], contacts(50));
    await expect(zoom).toHaveValue('2.5');
    await expect(stage).not.toHaveAttribute('data-ink-preview');
    await expect(detail).not.toHaveAttribute('data-test-reserve');
    await expect(page.locator('.pdf-detail-surface')).toHaveCSS('transform', 'none');
    expect(await density(ink)).toBeCloseTo(2, 1);
    expect(await alpha(y - 56 * 1.25)).toBeGreaterThan(240);
  });

  test('renders the visible PDF at device resolution at 1000%, including after panning', async ({
    page,
  }) => {
    const pdf = await PDFDocument.create();
    const sheet = pdf.addPage([595, 842]);
    sheet.drawRectangle({ x: 0, y: 0, width: 297.5, height: 842, color: rgb(1, 0, 0) });
    sheet.drawRectangle({ x: 297.5, y: 0, width: 297.5, height: 842, color: rgb(0, 0, 1) });
    await page.goto('/');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'PDFを読み込む', exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: 'zoom-resolution.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    });
    await expect(page.locator('.pdf-canvas[data-page]')).toHaveCount(1);
    await page.getByLabel('表示方法').selectOption('width');
    const zoom = page.getByLabel('表示倍率');
    await zoom.selectOption('10');

    const stage = (await page.getByTestId('stage').boundingBox())!;
    const paper = (await page.getByTestId('pdf-page').boundingBox())!;
    const detail = page.locator('.pdf-detail-layer canvas');
    const samples = () =>
      detail.evaluate((canvas: HTMLCanvasElement) => {
        const ctx = canvas.getContext('2d')!;
        const viewport = canvas.closest('[data-testid="stage"]')!.getBoundingClientRect();
        const box = canvas.getBoundingClientRect();
        const y = Math.floor(
          ((viewport.top + viewport.height / 2 - box.top) * canvas.height) / box.height,
        );
        return [0.25, 0.75].map((fraction) => {
          const x = Math.floor(
            ((viewport.left + viewport.width * fraction - box.left) * canvas.width) / box.width,
          );
          return Array.from(ctx.getImageData(x, y, 1, 1).data);
        });
      });
    await expect(detail).toBeVisible();
    const pixels = await detail.evaluate((canvas: HTMLCanvasElement) => {
      const box = canvas.getBoundingClientRect();
      return {
        width: canvas.width,
        height: canvas.height,
        cssWidth: box.width,
        cssHeight: box.height,
      };
    });
    expect(pixels.width).toBeCloseTo(pixels.cssWidth * 2, 0);
    expect(pixels.height).toBeCloseTo(pixels.cssHeight * 2, 0);
    expect(pixels.width).toBeGreaterThanOrEqual(stage.width * 2);
    expect(pixels.height).toBeGreaterThanOrEqual(stage.height * 2);
    const previewWidth = await page
      .locator('.pdf-canvas')
      .evaluate((canvas: HTMLCanvasElement) => canvas.width);
    expect(paper.width * 2).toBeGreaterThan(previewWidth * 2);
    await expect(page.locator('.pdf-detail-surface')).toHaveCSS('transform', 'none');
    expect(await samples()).toEqual([
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ]);

    await detail.evaluate((canvas) => canvas.setAttribute('data-test-old-detail', ''));
    await page.getByRole('button', { name: '移動', exact: true }).click();
    const y = stage.y + stage.height * 0.5;
    const x = stage.x + stage.width * 0.2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 32, y, { steps: 4 });
    await page.mouse.up();
    // Observe longer than the redraw debounce to check that nearby pixels are reused.
    await page.waitForTimeout(450);
    await expect(detail).toHaveAttribute('data-test-old-detail', '');
    expect(await samples()).toEqual([
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ]);
    await page.mouse.move(stage.x + stage.width * 0.2, y);
    await page.mouse.down();
    await page.mouse.move(stage.x + stage.width * 0.8, y, { steps: 8 });
    await expect(detail).toHaveAttribute('data-test-old-detail', '');
    await expect(page.locator('.pdf-detail-surface')).not.toHaveCSS('transform', 'none');
    await page.mouse.up();
    await expect(detail).not.toHaveAttribute('data-test-old-detail');
    await expect(page.locator('.pdf-detail-surface')).toHaveCSS('transform', 'none');
    expect(await samples()).toEqual([
      [255, 0, 0, 255],
      [255, 0, 0, 255],
    ]);
    await expect(page.locator('.pdf-loading')).toHaveCount(0);

    await zoom.selectOption('8');
    const center = stage.x + stage.width / 2;
    const a = { identifier: 1, clientX: center - 40, clientY: y };
    const b = { identifier: 2, clientX: center + 40, clientY: y };
    const wider = [
      { ...a, clientX: center - 80 },
      { ...b, clientX: center + 80 },
    ];
    const initialWidth = (await page.getByTestId('pdf-page').boundingBox())!.width;
    await touch(page, 'touchstart', [a, b]);
    await touch(page, 'touchmove', wider);
    await expect
      .poll(async () => (await page.getByTestId('pdf-page').boundingBox())!.width / initialWidth)
      .toBeCloseTo(1.25, 2);
    await touch(page, 'touchend', [], wider);
    await expect(zoom).toHaveValue('10');
  });

  test('draws pen and highlighter at native pixel density during and after writing at 1000%', async ({
    page,
  }) => {
    await demo(page);
    await page.getByLabel('表示倍率').selectOption('10');
    const ink = page.getByTestId('ink-canvas');
    const draft = page.locator('.ink-draft-canvas');
    const stage = (await page.getByTestId('stage').boundingBox())!;
    for (const layer of [ink, draft]) {
      const box = (await layer.boundingBox())!;
      const pixels = await layer.evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
      expect(box.width).toBeCloseTo(stage.width, 0);
      expect(box.height).toBeCloseTo(stage.height, 0);
      expect(pixels).toEqual([Math.round(box.width * 2), Math.round(box.height * 2)]);
    }
    const opacity = (layer: typeof ink, fractionY: number) =>
      layer.evaluate(
        (c: HTMLCanvasElement, y) =>
          c.getContext('2d')!.getImageData(c.width >> 1, Math.floor(c.height * y), 1, 1).data[3],
        fractionY,
      );
    const draw = async (fractionY: number) => {
      const y = stage.y + stage.height * fractionY;
      await page.mouse.move(stage.x + stage.width * 0.25, y);
      await page.mouse.down();
      await page.mouse.move(stage.x + stage.width * 0.75, y, { steps: 12 });
    };
    await page.getByLabel('ペンの太さ', { exact: true }).selectOption('1');
    await draw(0.35);
    await expect.poll(() => opacity(draft, 0.35)).toBeGreaterThan(240);
    expect(await opacity(ink, 0.35)).toBe(0);
    await page.mouse.up();
    await expect.poll(() => opacity(ink, 0.35)).toBeGreaterThan(240);
    await page.getByRole('button', { name: '蛍光ペン', exact: true }).click();
    await page.getByLabel('蛍光ペンの太さ', { exact: true }).selectOption('5');
    await draw(0.65);
    await expect.poll(() => opacity(draft, 0.65)).toBeCloseTo(77, -1);
    expect(await opacity(ink, 0.35)).toBeGreaterThan(240);
    await page.mouse.up();
    await expect.poll(() => opacity(ink, 0.65)).toBeCloseTo(77, -1);
  });
});
