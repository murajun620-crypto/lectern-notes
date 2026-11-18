import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function demo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'まずは3ページのサンプルで試す' }).click();
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await expect(page.locator('.pdf-loading')).toHaveCount(0);
}
async function stored(page: Page) {
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
const saved = (page: Page) => expect(page.locator('.save-status')).toHaveText('保存済み');
async function alpha(page: Page, x: number, y: number) {
  return page
    .getByTestId('ink-canvas')
    .evaluate(
      (c: HTMLCanvasElement, p) =>
        c
          .getContext('2d')!
          .getImageData(Math.round(c.width * p.x), Math.round(c.height * p.y), 1, 1).data[3],
      { x, y },
    );
}
async function line(page: Page, x1: number, y1: number, x2: number, y2: number, steps = 30) {
  const r = (await page.getByTestId('pdf-page').boundingBox())!;
  await page.mouse.move(r.x + r.width * x1, r.y + r.height * y1);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * x2, r.y + r.height * y2, { steps });
  await page.mouse.up();
  await saved(page);
}

test('circular eraser keeps both ends, supports undo and zoom, and preserves PDF and later ink', async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await demo(page);
  await page.getByLabel('ペンの太さ', { exact: true }).selectOption('7');
  await line(page, 0.15, 0.4, 0.85, 0.4);
  const original = (await stored(page))[0].pages[0].strokes[0];
  expect(await alpha(page, 0.5, 0.4)).toBeGreaterThan(200);
  const pdfPixel = () =>
    page
      .locator('.pdf-canvas')
      .evaluate((c: HTMLCanvasElement) =>
        Array.from(
          c
            .getContext('2d')!
            .getImageData(Math.round(c.width * 0.5), Math.round(c.height * 0.4), 1, 1).data,
        ),
      );
  const pdfBefore = await pdfPixel();
  await page.getByRole('button', { name: '消しゴム', exact: true }).click();
  await page.getByLabel('消しゴムのサイズ', { exact: true }).selectOption('16');
  const r = (await page.getByTestId('pdf-page').boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.5, r.y + r.height * 0.4);
  await page.mouse.down();
  await expect(page.getByTestId('eraser-cursor')).toBeVisible();
  expect((await page.getByTestId('eraser-cursor').boundingBox())!.width).toBe(16);
  await page.mouse.up();
  await saved(page);
  await expect.poll(() => alpha(page, 0.5, 0.4)).toBe(0);
  expect(await alpha(page, 0.3, 0.4)).toBeGreaterThan(200);
  expect(await alpha(page, 0.7, 0.4)).toBeGreaterThan(200);
  expect(await pdfPixel()).toEqual(pdfBefore);
  const ink = (await stored(page))[0].pages[0].strokes;
  expect(ink).toHaveLength(1);
  expect(ink[0].points).toEqual(original.points);
  expect(ink[0].erasures).toHaveLength(1);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(() => alpha(page, 0.5, 0.4)).toBeGreaterThan(200);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await expect.poll(() => alpha(page, 0.5, 0.4)).toBe(0);
  await page.getByLabel('表示倍率').selectOption('2');
  await expect.poll(() => alpha(page, 0.5, 0.4)).toBe(0);
  await page.getByLabel('消しゴムのサイズ', { exact: true }).selectOption('48');
  const zoomed = (await page.getByTestId('pdf-page').boundingBox())!;
  await page.mouse.move(zoomed.x + zoomed.width * 0.5, zoomed.y + zoomed.height * 0.4);
  expect((await page.getByTestId('eraser-cursor').boundingBox())!.width).toBe(48);
  await saved(page);
  await page.reload();
  await page.getByRole('button', { name: '消しゴム', exact: true }).click();
  await expect(page.getByLabel('消しゴムのサイズ', { exact: true })).toHaveValue('48');
  await expect.poll(() => alpha(page, 0.5, 0.4)).toBe(0);
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  await page.getByLabel('ペンの太さ', { exact: true }).selectOption('7');
  await line(page, 0.45, 0.4, 0.55, 0.4);
  expect(await alpha(page, 0.5, 0.4)).toBeGreaterThan(200);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect.poll(() => alpha(page, 0.5, 0.4)).toBe(0);
  await saved(page);
  await page.getByRole('button', { name: '講義を始める', exact: true }).click();
  await page.getByRole('button', { name: '消しゴム', exact: true }).click();
  await page.getByLabel('消しゴムのサイズ', { exact: true }).selectOption('80');
  const lecturePaper = (await page.getByTestId('pdf-page').boundingBox())!;
  await page.mouse.click(
    lecturePaper.x + lecturePaper.width * 0.3,
    lecturePaper.y + lecturePaper.height * 0.4,
  );
  await expect.poll(() => alpha(page, 0.3, 0.4)).toBe(0);
  expect(await alpha(page, 0.7, 0.4)).toBeGreaterThan(200);
  await expect(page.locator('.lecture-save-indicator')).toHaveAttribute('aria-label', '保存済み');
  await page.mouse.move(
    lecturePaper.x + lecturePaper.width * 0.3,
    lecturePaper.y + lecturePaper.height * 0.4 + 1,
  );
  await page.screenshot({ path: `artifacts/partial-eraser-${browserName}.png` });
});

test('small circles cut only their pixels in wide highlighter; fast sweeps, moving and backup retain cuts', async ({
  page,
}) => {
  await demo(page);
  await page.getByRole('button', { name: '蛍光ペン', exact: true }).click();
  await page.getByLabel('ペンの太さ', { exact: true }).selectOption('10');
  await line(page, 0.2, 0.55, 0.8, 0.55);
  await page.getByRole('button', { name: '消しゴム', exact: true }).click();
  await page.getByLabel('消しゴムのサイズ', { exact: true }).selectOption('8');
  await line(page, 0.5, 0.55, 0.5, 0.55, 1);
  const r = (await page.getByTestId('pdf-page').boundingBox())!;
  await line(page, 0.5 + 2 / r.width, 0.55, 0.5 + 2 / r.width, 0.55, 1);
  expect(await alpha(page, 0.5, 0.55)).toBe(0);
  expect(await alpha(page, 0.5, 0.55 + 12 / r.height)).toBeGreaterThan(50);
  expect(await alpha(page, 0.3, 0.55)).toBeGreaterThan(50);
  await line(page, 0.65, 0.55 - 60 / r.height, 0.65, 0.55 + 60 / r.height, 1);
  expect(await alpha(page, 0.65, 0.55)).toBe(0);
  expect(await alpha(page, 0.65 + 12 / r.width, 0.55)).toBeGreaterThan(50);
  await page.getByRole('button', { name: '選択', exact: true }).click();
  await page.mouse.move(r.x + r.width * 0.1, r.y + r.height * 0.45);
  await page.mouse.down();
  for (const [x, y] of [
    [0.9, 0.45],
    [0.9, 0.65],
    [0.1, 0.65],
    [0.1, 0.45],
  ])
    await page.mouse.move(r.x + r.width * x, r.y + r.height * y, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: /選択した線を削除/ })).toBeVisible();
  await line(page, 0.3, 0.55, 0.3, 0.68, 8);
  expect(await alpha(page, 0.5, 0.68)).toBe(0);
  expect(await alpha(page, 0.5, 0.68 + 12 / r.height)).toBeGreaterThan(50);
  expect(await alpha(page, 0.3, 0.68)).toBeGreaterThan(50);
  await page.locator('.export-menu > summary').click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '編集可能なバックアップ', exact: true }).click();
  const data = await readFile((await (await downloaded).path())!);
  await page.getByRole('button', { name: 'ライブラリに戻る' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'バックアップを復元' }).click();
  await (
    await chooser
  ).setFiles({ name: 'partial.lecture.zip', mimeType: 'application/zip', buffer: data });
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await saved(page);
  await expect.poll(() => alpha(page, 0.5, 0.68)).toBe(0);
  expect(await alpha(page, 0.3, 0.68)).toBeGreaterThan(50);
  expect((await stored(page)).every((p) => p.pages[0].strokes[0].erasures.length === 3)).toBe(true);
  // Sparse input forms a smooth quadratic well away from the raw control polygon.
  await page.getByRole('button', { name: '蛍光ペン', exact: true }).click();
  await page.getByLabel('ペンの太さ', { exact: true }).selectOption('1');
  const curve = (await page.getByTestId('pdf-page').boundingBox())!;
  await page.mouse.move(curve.x + curve.width * 0.2, curve.y + curve.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(curve.x + curve.width * 0.5, curve.y + curve.height * 0.2);
  await page.mouse.move(curve.x + curve.width * 0.5, curve.y + curve.height * 0.4);
  await page.mouse.up();
  await saved(page);
  expect(await alpha(page, 0.425, 0.225)).toBeGreaterThan(40);
  await page.getByRole('button', { name: '消しゴム', exact: true }).click();
  await page.getByLabel('消しゴムのサイズ', { exact: true }).selectOption('8');
  await line(page, 0.425, 0.225, 0.425, 0.225, 1);
  expect(await alpha(page, 0.425, 0.225)).toBe(0);
});
