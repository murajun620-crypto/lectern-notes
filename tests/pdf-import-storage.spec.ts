import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import type { Project } from '../src/model';

async function onePagePdf(name: string, width: number) {
  const pdf = await PDFDocument.create();
  pdf.addPage([width, 700]).drawText(name);
  return {
    name: name + '.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  };
}

async function choosePdf(page: Page, file: Awaited<ReturnType<typeof onePagePdf>>, append = false) {
  if (append) await page.locator('.export-menu > summary').click();
  const chooser = page.waitForEvent('filechooser');
  await page
    .getByRole('button', { name: append ? 'PDFのページを追加' : 'PDFを読み込む', exact: true })
    .click();
  await (await chooser).setFiles(file);
}

async function readLibrary(page: Page) {
  return page.evaluate(async () => {
    function result<T>(request: IDBRequest<T>) {
      return new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    const db = await result(indexedDB.open('lectern'));
    try {
      const tx = db.transaction(['projects', 'assets']);
      const [projects, assetIds] = await Promise.all([
        result(tx.objectStore('projects').getAll()) as Promise<Project[]>,
        result(tx.objectStore('assets').getAllKeys()),
      ]);
      return { projects, assetIds };
    } finally {
      db.close();
    }
  });
}

test('PDF import and append roll back staged assets when the project write fails', async ({
  page,
}) => {
  const [original, appendix] = await Promise.all([
    onePagePdf('handout', 480),
    onePagePdf('appendix', 360),
  ]);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'まずは3ページのサンプルで試す' })).toBeVisible();
  const fault = await page.evaluateHandle(() => {
    const state = { enabled: true, writes: [] as string[] };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (state.enabled && this.name === 'projects') {
        state.writes.push('project rejected');
        throw new DOMException('Test quota reached', 'QuotaExceededError');
      }
      const request = put.apply(this, args);
      if (state.enabled && this.name === 'assets')
        request.addEventListener('success', () => state.writes.push('asset staged'), {
          once: true,
        });
      return request;
    };
    return state;
  });
  const checkFailedWrite = async () => {
    await expect(page.getByRole('alert')).toContainText('保存容量が不足');
    expect(await fault.evaluate((s) => s.writes)).toEqual(['asset staged', 'project rejected']);
  };
  const toggle = (enabled: boolean) =>
    fault.evaluate((s, enabled) => {
      s.writes = [];
      s.enabled = enabled;
    }, enabled);
  await choosePdf(page, original);
  await checkFailedWrite();
  expect(await readLibrary(page)).toEqual({ projects: [], assetIds: [] });
  await toggle(false);
  await choosePdf(page, original);
  await expect(page.getByLabel('ページ番号')).toHaveValue('1');
  const before = await readLibrary(page);
  expect(before.projects).toHaveLength(1);
  expect(before.projects[0].pages).toHaveLength(1);
  const firstPage = before.projects[0].pages[0];
  expect(firstPage.width).toBe(480);
  expect(before.assetIds).toEqual([firstPage.assetId]);

  await toggle(true);
  await choosePdf(page, appendix, true);
  await checkFailedWrite();
  await expect(page.getByLabel('ページ番号')).toHaveValue('1');
  expect(await readLibrary(page)).toEqual(before);
  await toggle(false);
  await choosePdf(page, appendix, true);
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
  const after = await readLibrary(page);
  expect(after.projects).toHaveLength(1);
  expect(after.projects[0].id).toBe(before.projects[0].id);
  expect(after.projects[0].pages).toHaveLength(2);
  expect(after.projects[0].pages[0]).toEqual(firstPage);
  const secondPage = after.projects[0].pages[1];
  expect(secondPage.width).toBe(360);
  expect(secondPage.assetId).not.toBe(firstPage.assetId);
  expect(after.assetIds).toEqual([firstPage.assetId, secondPage.assetId].sort());
});
