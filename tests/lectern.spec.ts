import { test, expect } from '@playwright/test';
import type { Page as BrowserPage } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import type { Project } from '../src/model';

test('mixed page sizes preserve proportions and ink through zoom and screen rotation', async ({
  page,
}) => {
  const sizes: [number, number][] = [
    [595.28, 841.89],
    [960, 540],
    [600, 600],
    [841.89, 1190.55],
    [300, 1000],
    [400, 700],
  ];
  const doc = await PDFDocument.create();
  sizes.forEach((size, i) => {
    const p = doc.addPage(size);
    p.drawText('Handout page ' + (i + 1));
    if (i === 5) p.setRotation(degrees(90));
  });
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'PDFを読み込む', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'mixed-sizes.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await saved(page);
  const dimensions = [...sizes.slice(0, 5), [700, 400]];
  for (let i = 0; i < dimensions.length; i++) {
    await page.getByRole('button', { name: 'ページ ' + (i + 1), exact: true }).click();
    await page.getByLabel('表示倍率').selectOption('1');
    await expect(page.getByText('ページを読み込み中…', { exact: true })).toBeHidden();
    let r = (await page.getByTestId('pdf-page').boundingBox())!;
    expect(r.width / r.height).toBeCloseTo(dimensions[i][0] / dimensions[i][1], 2);
    await page.getByLabel('表示倍率').selectOption('2');
    await line(page, [0.4, 0.45], [0.55, 0.55]);
    const pg = (await stored(page))[0].pages[i];
    expect(pg.width).toBeCloseTo(dimensions[i][0], 2);
    expect(pg.height).toBeCloseTo(dimensions[i][1], 2);
    expect(pg.strokes).toHaveLength(1);
    expect(Math.abs(pg.strokes[0].points[0].x - pg.width * 0.4)).toBeLessThan(2);
  }
  const before = JSON.stringify((await stored(page))[0].pages.map((p: any) => p.strokes));
  await page.setViewportSize({ width: 900, height: 1200 });
  await page.getByLabel('表示倍率').selectOption('1');
  const r = (await page.getByTestId('pdf-page').boundingBox())!;
  expect(r.width / r.height).toBeCloseTo(700 / 400, 2);
  expect(JSON.stringify((await stored(page))[0].pages.map((p: any) => p.strokes))).toBe(before);
});
async function demo(page: BrowserPage) {
  await page.goto('/');
  await page.getByRole('button', { name: 'まずは3ページのサンプルで試す' }).click();
  await expect(page.getByRole('button', { name: 'ページ 3', exact: true })).toBeVisible();
  await expect(page.getByText('ページを読み込み中…', { exact: true })).toBeHidden();
}
async function stored(page: BrowserPage) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('lectern');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      return await new Promise<any[]>((resolve, reject) => {
        const r = db.transaction('projects').objectStore('projects').getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  });
}
async function saved(page: BrowserPage) {
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
}
async function line(page: BrowserPage, from = [0.15, 0.45], to = [0.45, 0.55]) {
  const r = (await page.getByTestId('pdf-page').boundingBox())!;
  await page.mouse.move(r.x + r.width * from[0], r.y + r.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * to[0], r.y + r.height * to[1], { steps: 15 });
  await page.mouse.up();
  await saved(page);
}
test('PDF, ink coordinates, undo/redo, eraser, lasso, laser and restart', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await demo(page);
  await line(page);
  let p = (await stored(page))[0];
  expect(p.pages).toHaveLength(3);
  expect(p.pages[0].strokes).toHaveLength(1);
  const first = p.pages[0].strokes[0].points[0];
  expect(Math.abs(first.x - p.pages[0].width * 0.15)).toBeLessThan(1.5);
  expect(Math.abs(first.y - p.pages[0].height * 0.45)).toBeLessThan(1.5);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await saved(page);
  expect((await stored(page))[0].pages[0].strokes).toHaveLength(0);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await saved(page);
  expect((await stored(page))[0].pages[0].strokes).toHaveLength(1);
  await page.getByLabel('表示倍率').selectOption('2');
  await line(page, [0.4, 0.45], [0.55, 0.55]);
  p = (await stored(page))[0];
  expect(Math.abs(p.pages[0].strokes[1].points[0].x - p.pages[0].width * 0.4)).toBeLessThan(1.5);
  await page.getByLabel('表示倍率').selectOption('1');
  await page.getByRole('button', { name: '消しゴム', exact: true }).click();
  await line(page, [0.28, 0.46], [0.32, 0.53]);
  expect((await stored(page))[0].pages[0].strokes).toHaveLength(2);
  expect((await stored(page))[0].pages[0].strokes[0].erasures).toHaveLength(1);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await saved(page);
  await page.getByRole('button', { name: '選択', exact: true }).click();
  const r = (await page.getByTestId('pdf-page').boundingBox())!;
  for (const [i, pt] of [
    [0.1, 0.35],
    [0.48, 0.35],
    [0.48, 0.65],
    [0.1, 0.65],
    [0.1, 0.35],
  ].entries()) {
    await page.mouse.move(r.x + r.width * pt[0], r.y + r.height * pt[1], { steps: 3 });
    if (!i) await page.mouse.down();
  }
  await page.mouse.up();
  await expect(page.getByRole('button', { name: /選択した線を削除/ })).toBeVisible();
  // Drag the selected stroke, then check its page-space translation.
  await page.mouse.move(r.x + r.width * 0.3, r.y + r.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.35, r.y + r.height * 0.55, { steps: 8 });
  await page.mouse.up();
  await saved(page);
  expect(
    Math.abs((await stored(page))[0].pages[0].strokes[0].points[0].x - p.pages[0].width * 0.2),
  ).toBeLessThan(1.5);
  await page.getByRole('button', { name: /選択した線を削除/ }).click();
  await saved(page);
  expect((await stored(page))[0].pages[0].strokes).toHaveLength(0);
  await page.getByRole('button', { name: '蛍光ペン', exact: true }).click();
  await line(page);
  expect((await stored(page))[0].pages[0].strokes[0].tool).toBe('highlighter');
  const before = JSON.stringify((await stored(page))[0].pages[0].strokes);
  await page.getByRole('button', { name: 'レーザー', exact: true }).click();
  await page.mouse.move(r.x + r.width * 0.5, r.y + r.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.6, r.y + r.height * 0.7, { steps: 5 });
  await expect
    .poll(() =>
      page.locator('.laser-canvas').evaluate((c: HTMLCanvasElement) =>
        c
          .getContext('2d')!
          .getImageData(0, 0, c.width, c.height)
          .data.some((v, i) => i % 4 === 3 && v > 0),
      ),
    )
    .toBe(true);
  await page.mouse.up();
  expect(JSON.stringify((await stored(page))[0].pages[0].strokes)).toBe(before);
  await page.getByRole('button', { name: '次のページ', exact: true }).click();
  await saved(page);
  await page.reload();
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
  await page.getByRole('button', { name: '前のページ', exact: true }).click();
  await saved(page);
  expect((await stored(page))[0].pages[0].strokes).toHaveLength(1);
  expect(errors).toEqual([]);
});
test('page reorder, delete, blank page and append actual portrait/rotated PDF', async ({
  page,
}) => {
  await demo(page);
  await page.getByRole('button', { name: '白紙を追加' }).click();
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
  await saved(page);
  const newId = (await stored(page))[0].pages[1].id;
  await page.getByRole('button', { name: 'ページ2を後へ', exact: true }).click();
  await saved(page);
  expect((await stored(page))[0].pages[2].id).toBe(newId);
  await expect(page.getByLabel('ページ番号')).toHaveValue('3');
  await page.getByRole('button', { name: 'ページ3を削除', exact: true }).click();
  await page.getByRole('button', { name: 'ページを削除', exact: true }).click();
  await saved(page);
  expect((await stored(page))[0].pages).toHaveLength(3);
  const doc = await PDFDocument.create();
  doc.addPage([400, 700]).drawText('Portrait test');
  doc.addPage([400, 700]).setRotation(degrees(90));
  await page.locator('.export-menu>summary').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'PDFのページを追加' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'portrait.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.getByRole('button', { name: 'ページ 5', exact: true })).toBeVisible();
  await saved(page);
  const p = (await stored(page))[0];
  expect(p.pages[3].width).toBe(400);
  expect(p.pages[3].height).toBe(700);
  expect(p.pages[4].width).toBe(700);
  expect(p.pages[4].height).toBe(400);
  await page.getByLabel('ページ番号').fill('5');
  await page.getByLabel('ページ番号').press('Enter');
  await expect(page.getByLabel('ページ番号')).toHaveValue('5');
  await page.getByRole('button', { name: 'ページ 4', exact: true }).click();
  await page.getByLabel('表示方法').selectOption('width');
  const paper = (await page.getByTestId('pdf-page').boundingBox())!,
    stage = (await page.getByTestId('stage').boundingBox())!;
  expect(Math.abs(paper.width - (stage.width - 56))).toBeLessThan(2);
  await page.getByRole('button', { name: 'フィット', exact: true }).click();
});
test('inserts writable blank pages before or after the displayed page and retains their sizes', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  doc.addPage([360, 640]).drawText('Portrait handout');
  const rotated = doc.addPage([410, 720]);
  rotated.drawText('Landscape handout');
  rotated.setRotation(degrees(90));
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'PDFを読み込む', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'blank-insertion.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });

  const thumbnail = (number: number) =>
    page.getByRole('button', { name: `ページ ${number}`, exact: true });
  const layout = page.getByLabel('ページ表示');
  const insert = page.getByLabel('白紙を挿入', { exact: true });
  await expect(thumbnail(2)).toBeVisible();
  await saved(page);
  const original: Project = (await stored(page))[0];
  await expect(layout).toHaveValue('continuous');
  await thumbnail(2).click();
  await expect(thumbnail(2)).toHaveAttribute('aria-current', 'page');
  await insert.click();
  await page.getByRole('button', { name: '前に挿入', exact: true }).click();
  await expect(thumbnail(2)).toHaveAttribute('aria-current', 'page');
  await expect(thumbnail(3)).toBeVisible();
  await saved(page);
  const withLandscapeBlank: Project = (await stored(page))[0];
  const landscapeBlank = withLandscapeBlank.pages[1];
  expect(landscapeBlank).toMatchObject({ width: 720, height: 410, strokes: [], videos: [] });
  expect(landscapeBlank.assetId).toBeUndefined();
  expect(withLandscapeBlank.pages[2].id).toBe(original.pages[1].id);
  await line(page);

  await layout.selectOption('single');
  await thumbnail(1).click();
  await expect(thumbnail(1)).toHaveAttribute('aria-current', 'page');
  await insert.click();
  await page.getByRole('button', { name: '後ろに挿入', exact: true }).click();
  await expect(thumbnail(2)).toHaveAttribute('aria-current', 'page');
  await expect(thumbnail(4)).toBeVisible();
  await saved(page);
  const withPortraitBlank: Project = (await stored(page))[0];
  const portraitBlank = withPortraitBlank.pages[1];
  await page.reload();
  await expect(thumbnail(2)).toHaveAttribute('aria-current', 'page');
  const restored: Project = (await stored(page))[0];
  expect(restored.pages.map((sheet) => sheet.id)).toEqual([
    original.pages[0].id,
    portraitBlank.id,
    landscapeBlank.id,
    original.pages[1].id,
  ]);
  expect(restored.pages[1]).toMatchObject({ width: 360, height: 640, strokes: [], videos: [] });
  expect(restored.pages[1].assetId).toBeUndefined();
  expect(restored.pages[2].strokes).toHaveLength(1);

  await page.locator('.export-menu>summary').click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '書き込み入りPDF', exact: true }).click();
  const output = await PDFDocument.load(await readFile((await (await downloading).path())!));
  expect(output.getPageCount()).toBe(4);
  expect(output.getPage(1).getSize()).toEqual({ width: 360, height: 640 });
  expect(output.getPage(2).getSize()).toEqual({ width: 720, height: 410 });
});
test('YouTube placement controls appear on selection and stay available in fullscreen', async ({
  page,
}) => {
  await page.route('https://www.youtube.com/iframe_api', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.__ytAudioLog = [];
        window.YT = { Player: class {
          constructor(el, options) {
            this.muted = false;
            this.iframe = document.createElement('iframe');
            this.iframe.src = 'about:blank';
            el.replaceWith(this.iframe);
            window.__ytOptions = { videoId: options.videoId, playerVars: options.playerVars };
            setTimeout(() => options.events.onReady({ target: this }), 20);
            window.__ytError = () => options.events.onError({ data: 150 });
          }
          mute() {
            this.muted = true;
            window.__ytAudioLog.push('mute');
          }
          unMute() {
            this.muted = false;
            window.__ytAudioLog.push('unmute');
          }
          isMuted() { return this.muted; }
          playVideo() { window.__ytAudioLog.push(this.muted ? 'play:muted' : 'play:audible'); }
          getIframe() { return this.iframe; }
          destroy() { this.iframe.remove(); }
        } };
        window.onYouTubeIframeAPIReady();
      `,
    }),
  );
  await demo(page);
  await page.getByRole('button', { name: 'YouTube挿入' }).click();
  await page.getByLabel('YouTube URL').fill('https://youtu.be/M7lc1UVf-VE');
  await page.getByRole('button', { name: 'このページに追加' }).click();
  await expect(page.getByTestId('video-box')).toBeVisible();
  await saved(page);
  const before = (await stored(page))[0].pages[0].videos[0];
  const box = page.getByTestId('video-box');
  const handle = page.locator('.stage-video-controls .video-handle');
  await expect(handle).toHaveCount(0);
  await expect(page.getByTitle('動画のサイズ変更')).toHaveCount(0);
  await box
    .getByRole('button', { name: 'サムネイルを選択', exact: true })
    .click({ position: { x: 4, y: 4 } });
  const r = (await handle.boundingBox())!;
  expect(r.height).toBeCloseTo(36, 0);
  expect(r.width).toBeCloseTo(176, 0);
  await page.mouse.move(r.x + 20, r.y + 10);
  await page.mouse.down();
  await page.mouse.move(r.x + 80, r.y + 30, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await stored(page))[0].pages[0].videos[0].x)
    .toBeGreaterThan(before.x);
  const after = (await stored(page))[0].pages[0].videos[0];
  expect(after.y).toBeGreaterThan(before.y);
  const resize = (await page.getByTitle('動画のサイズ変更').boundingBox())!;
  await page.mouse.move(resize.x + 10, resize.y + 10);
  await page.mouse.down();
  await page.mouse.move(resize.x + 35, resize.y + 25, { steps: 6 });
  await page.mouse.up();
  await saved(page);
  expect((await stored(page))[0].pages[0].videos[0].width).toBeGreaterThan(after.width);
  const paper = (await page.getByTestId('pdf-page').boundingBox())!;
  const movedHandle = (await handle.boundingBox())!;
  await page.mouse.move(movedHandle.x + 12, movedHandle.y + 10);
  await page.mouse.down();
  await page.mouse.move(paper.x + paper.width - 20, movedHandle.y + 10, { steps: 8 });
  await page.mouse.up();
  await saved(page);
  const overhang = (await stored(page))[0].pages[0];
  expect(overhang.videos[0].x + overhang.videos[0].width).toBeGreaterThan(overhang.width);
  const placed = (await page.getByTestId('video-box').boundingBox())!;
  expect(placed.x + placed.width).toBeGreaterThan(paper.x + paper.width);
  await page.mouse.click(paper.x + paper.width * 0.2, paper.y + paper.height * 0.65);
  await expect(handle).toHaveCount(0);
  await page.getByRole('button', { name: '全画面表示', exact: true }).click();
  await expect(page.getByRole('button', { name: '移動', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(handle).toHaveCount(0);
  const play = page.getByRole('button', { name: '動画をページ内で再生' });
  const close = page.getByTitle('動画を閉じる', { exact: true });
  const unmute = page.getByRole('button', { name: '動画のミュートを解除', exact: true });
  const mute = page.getByRole('button', { name: '動画をミュート', exact: true });
  const audioLog = () =>
    page.evaluate(() => (window as Window & { __ytAudioLog: string[] }).__ytAudioLog);
  await play.click();
  await expect(handle).toHaveCount(0);
  await expect(page.getByTitle('YouTube動画', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__ytOptions.playerVars.playsinline)).toBe(1);
  await expect.poll(audioLog).toEqual(['mute', 'play:muted']);

  await unmute.click();
  await expect(mute).toBeVisible();
  await mute.click();
  await unmute.click();
  await expect(mute).toBeVisible();
  await close.click();
  await play.click();
  await expect(unmute).toBeVisible();
  await expect
    .poll(audioLog)
    .toEqual(['mute', 'play:muted', 'unmute', 'mute', 'unmute', 'mute', 'play:muted']);

  await page.evaluate(() => (window as any).__ytError());
  await expect(page.getByText('この動画は埋め込み再生が許可されていません。')).toBeVisible();
  await expect(page.getByRole('link', { name: 'YouTubeで開く' })).toHaveAttribute(
    'target',
    '_blank',
  );
  await close.click();
  await expect(handle).toHaveCount(0);
  const thumbnail = box.getByRole('button', { name: 'サムネイルを選択', exact: true });
  await thumbnail.click({ position: { x: 3, y: 3 } });
  await expect(handle).toBeVisible();
  await expect(box.locator('iframe')).toHaveCount(0);
  await expect(page.getByLabel('ページ番号')).toHaveValue('1');
  await page.getByRole('button', { name: '全画面表示を終了' }).click();
  await page.getByRole('button', { name: '次のページ', exact: true }).click();
  await page.getByRole('button', { name: 'YouTube挿入' }).click();
  await page.getByLabel('YouTube URL').fill('https://www.youtube.com/watch?v=M7lc1UVf-VE');
  await page.getByRole('button', { name: 'このページに追加' }).click();
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('video-box')).toHaveCount(2);
  await expect(page.locator('.video-handle')).toHaveCount(0);
  const restored = (await stored(page))[0];
  expect(restored.pages[0].videos).toHaveLength(1);
  expect(restored.pages[0].videos[0]).toEqual(overhang.videos[0]);
  expect(restored.pages[1].videos).toHaveLength(1);
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
});
test('backup restore, annotated PDF output and library rename/duplicate/delete', async ({
  page,
}) => {
  await demo(page);
  await line(page);
  await page.getByLabel('ペンの種類', { exact: true }).selectOption('fountain');
  await page.getByRole('slider', { name: 'ペンの太さを調整', exact: true }).press('ArrowRight');
  await line(page, [0.15, 0.58], [0.45, 0.68]);
  await page.getByRole('button', { name: 'YouTube挿入' }).click();
  await page.getByLabel('YouTube URL').fill('https://youtu.be/M7lc1UVf-VE');
  await page.getByRole('button', { name: 'このページに追加' }).click();
  await saved(page);
  await page.locator('.export-menu>summary').click();
  let dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '編集可能なバックアップ' }).click();
  const backup = await dl;
  const data = await readFile((await backup.path())!);
  const zip = await JSZip.loadAsync(data);
  const meta = JSON.parse(await zip.file('project.json')!.async('string'));
  expect(meta.version).toBe(2);
  expect(meta.project.pages).toHaveLength(3);
  expect(meta.project.pages[0].strokes).toHaveLength(2);
  expect(meta.project.pages[0].strokes[0]).not.toHaveProperty('penKind');
  const fountain = meta.project.pages[0].strokes[1];
  expect(fountain).toMatchObject({ penKind: 'fountain', width: 2.6 });
  expect(meta.project.pages[0].videos).toHaveLength(1);
  expect(Object.keys(zip.files).some((name) => name.endsWith('.pdf'))).toBe(true);
  await page.locator('.export-menu>summary').click();
  dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '書き込み入りPDF' }).click();
  const pdf = await PDFDocument.load(await readFile((await (await dl).path())!));
  expect(pdf.getPageCount()).toBe(3);
  expect(pdf.getPage(0).getWidth()).toBeCloseTo(595.28, 2);
  expect(pdf.getPage(0).node.Annots()?.size()).toBe(1);
  await page.getByRole('button', { name: 'ライブラリに戻る' }).click();
  await expect(page.getByRole('heading', { name: '講義資料' })).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'バックアップを復元' }).click();
  const legacyStroke = { ...meta.project.pages[0].strokes[0], penKind: 'pencil' };
  meta.project.pages[0].strokes[0] = legacyStroke;
  zip.file('project.json', JSON.stringify({ ...meta, version: 1 }));
  await (
    await chooser
  ).setFiles({
    name: 'backup.lecture.zip',
    mimeType: 'application/zip',
    buffer: await zip.generateAsync({ type: 'nodebuffer' }),
  });
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await saved(page);
  const restored = await stored(page);
  expect(restored).toHaveLength(2);
  expect(restored.map((project) => project.pages[0].strokes)).toEqual(
    expect.arrayContaining([[legacyStroke, fountain]]),
  );
  await page.getByRole('button', { name: 'ライブラリに戻る' }).click();
  await page.locator('.card-menu>summary').first().click();
  await page.getByRole('button', { name: '名前を変更' }).first().click();
  await page.getByLabel('資料名', { exact: true }).fill('情報科学 第1回');
  await page.getByRole('button', { name: '保存する' }).click();
  await expect(page.getByRole('heading', { name: '情報科学 第1回', exact: true })).toBeVisible();
  await page.locator('.card-menu>summary').first().click();
  await page.getByRole('button', { name: '複製', exact: true }).first().click();
  await expect.poll(async () => (await stored(page)).length).toBe(3);
  await page.locator('.card-menu>summary').first().click();
  await page.getByRole('button', { name: '削除', exact: true }).first().click();
  await page.getByRole('button', { name: '削除する', exact: true }).click();
  await expect.poll(async () => (await stored(page)).length).toBe(2);
});
test('touch navigation, pinch and pressure-bearing pen input in landscape', async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Pressure/touch injection uses Chromium CDP; physical Pencil still requires iPad QA.',
  );
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await demo(page);
  await page.getByLabel('ページ表示').selectOption('single');
  const session = await context.newCDPSession(page);
  let r = (await page.getByTestId('pdf-page').boundingBox())!;
  const touch = async (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    points: { x: number; y: number; id: number }[],
  ) => session.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const x = r.x + r.width * 0.8,
    y = r.y + r.height * 0.55;
  await touch('touchStart', [{ x, y, id: 1 }]);
  await touch('touchMove', [{ x: x - 160, y, id: 1 }]);
  await touch('touchEnd', []);
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
  await saved(page);
  expect((await stored(page))[0].pages[0].strokes).toHaveLength(0);
  const cx = r.x + r.width / 2,
    cy = r.y + r.height / 2;
  await touch('touchStart', [
    { x: cx - 50, y: cy, id: 1 },
    { x: cx + 50, y: cy, id: 2 },
  ]);
  await touch('touchMove', [
    { x: cx - 100, y: cy, id: 1 },
    { x: cx + 100, y: cy, id: 2 },
  ]);
  await touch('touchEnd', []);
  await expect
    .poll(async () => Number(await page.getByLabel('表示倍率').inputValue()))
    .toBeGreaterThan(1.5);
  // A real one-finger swipe must also turn a zoomed page, then return exactly one page.
  await touch('touchStart', [{ x: cx + 80, y: cy, id: 3 }]);
  await touch('touchMove', [{ x: cx - 80, y: cy, id: 3 }]);
  await touch('touchEnd', []);
  await expect(page.getByLabel('ページ番号')).toHaveValue('3');
  await touch('touchStart', [{ x: cx - 80, y: cy, id: 4 }]);
  await touch('touchMove', [{ x: cx + 80, y: cy, id: 4 }]);
  await touch('touchEnd', []);
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
  await page.getByLabel('表示倍率').selectOption('1');
  await page.getByLabel('入力設定', { exact: true }).click();
  await page.getByLabel('Pencilの筆圧で線の太さを変える').check();
  await page.getByLabel('入力設定', { exact: true }).click();
  r = (await page.getByTestId('pdf-page').boundingBox())!;
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: r.x + r.width * 0.2,
    y: r.y + r.height * 0.6,
    pointerType: 'pen',
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: r.x + r.width * 0.2,
    y: r.y + r.height * 0.6,
    pointerType: 'pen',
    button: 'left',
    buttons: 1,
    force: 0.2,
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: r.x + r.width * 0.5,
    y: r.y + r.height * 0.6,
    pointerType: 'pen',
    button: 'left',
    buttons: 1,
    force: 0.8,
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: r.x + r.width * 0.5,
    y: r.y + r.height * 0.6,
    pointerType: 'pen',
    button: 'left',
  });
  await saved(page);
  const ink = (await stored(page))[0].pages[1].strokes[0];
  expect(ink.points.some((pt: any) => pt.p > 0.7)).toBe(true);
  await context.close();
});
