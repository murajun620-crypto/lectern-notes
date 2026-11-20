import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

declare global {
  interface Window {
    storageTest: {
      databases: IDBDatabase[];
      failure: string;
      pdfWrites: number;
      projectWrites: number;
    };
  }
}

async function openSample(page: Page) {
  await page.addInitScript(() => {
    const state = (window.storageTest = {
      databases: [] as IDBDatabase[],
      failure: '',
      projectWrites: 0,
      pdfWrites: 0,
    });
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      const request = open.apply(this, args);
      if (args[0] === 'lectern')
        request.addEventListener('success', () => state.databases.push(request.result));
      return request;
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'projects') {
        state.projectWrites++;
        if (state.failure) throw new DOMException('Test write failure', state.failure);
      } else if (this.name === 'assets') state.pdfWrites++;
      return put.apply(this, args);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'まずは3ページのサンプルで試す' }).click();
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await expect(page.getByText('ページを読み込み中…', { exact: true })).toBeHidden();
}

async function draw(page: Page, y: number) {
  const bounds = (await page.getByTestId('pdf-page').boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * y, {
    steps: 10,
  });
  await page.mouse.up();
}

async function strokeCount(page: Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('lectern', 1);
    return new Promise<number>((resolve, reject) => {
      request.onsuccess = () => {
        const database = request.result;
        const get = database.transaction('projects').objectStore('projects').getAll();
        get.onsuccess = () => {
          database.close();
          resolve(get.result[0].pages[0].strokes.length);
        };
        get.onerror = () => {
          database.close();
          reject(get.error);
        };
      };
      request.onerror = () => reject(request.error);
    });
  });
}

test('a quota failure keeps changes in the editor and exports the current ink and PDF before a successful retry', async ({
  page,
}) => {
  await openSample(page);
  await page.evaluate(() => {
    window.storageTest.failure = 'QuotaExceededError';
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => ({ usage: 3 * 1048576, quota: 4 * 1048576 }),
      },
    });
  });
  await draw(page, 0.3);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('QuotaExceededError');
  await expect(alert).toContainText('3 MiB');
  await expect(page.getByRole('button', { name: '未保存', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ライブラリに戻る' }).click();
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await expect(alert).toBeVisible();
  await draw(page, 0.4);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'バックアップを書き出す', exact: true }).click();
  const file = await downloading;
  const zip = await JSZip.loadAsync(await readFile((await file.path())!));
  const { project } = JSON.parse(await zip.file('project.json')!.async('string'));
  expect(project.pages[0].strokes).toHaveLength(2);
  const pdf = await zip.file(`assets/${project.pages[0].assetId}.pdf`)!.async('uint8array');
  expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe('%PDF-');
  expect(await strokeCount(page)).toBe(0);
  await page.evaluate(() => {
    window.storageTest.failure = '';
  });
  await page.getByRole('button', { name: '保存を再試行' }).click();
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await expect(alert).toBeHidden();
  expect(await page.evaluate(() => window.storageTest.pdfWrites)).toBe(1);
  await page.reload();
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  expect(await strokeCount(page)).toBe(2);
});

test('saving reconnects after an IndexedDB handle closes and clean opens do not rewrite the project', async ({
  page,
}) => {
  await openSample(page);
  const opens = await page.evaluate(() => {
    window.storageTest.databases.forEach((db) => db.close());
    return window.storageTest.databases.length;
  });
  await draw(page, 0.3);
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.storageTest.databases.length)).toBeGreaterThan(opens);
  expect(await strokeCount(page)).toBe(1);
  await page.reload();
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ライブラリに戻る' }).click();
  await expect(page.getByText('保存済み', { exact: true })).toBeHidden();
  expect(await page.evaluate(() => window.storageTest.projectWrites)).toBe(0);
  await expect(page.getByRole('alert')).toBeHidden();
});
