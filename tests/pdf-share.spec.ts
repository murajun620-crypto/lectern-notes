import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

async function prepare(page: Page, acceptsPdf: boolean) {
  await page.addInitScript((supported) => {
    const received: ShareData[] = [];
    Object.assign(window, { receivedFiles: received });
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: (data: ShareData) => supported && data.files?.[0]?.type === 'application/pdf',
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: ShareData) => {
        if (navigator.userActivation && !navigator.userActivation.isActive)
          throw new DOMException('User activation required', 'NotAllowedError');
        received.push(data);
        if (received.length === 1) throw new DOMException('Cancelled', 'AbortError');
      },
    });
  }, acceptsPdf);
  await page.goto('/');
  await page.getByRole('button', { name: /3ページのサンプル/ }).click();
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  // A loaded handout can be turned into a shareable file with no network access.
  await page.context().setOffline(true);
  await page.locator('.export-menu > summary').click();
  await page.getByRole('button', { name: 'PDFファイルを共有', exact: true }).click();
  return page.getByRole('dialog');
}

test('shares the prepared PDF file on a user tap and allows retry after cancellation', async ({
  page,
}) => {
  const dialog = await prepare(page, true);
  const choose = dialog.getByRole('button', { name: '共有先を選ぶ' });
  await choose.click();
  await expect(choose).toBeEnabled();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await choose.click();
  await expect(dialog).toHaveCount(0);
  const result = await page.evaluate(async () => {
    const calls = (window as Window & { receivedFiles?: ShareData[] }).receivedFiles!;
    const [file] = calls[1].files!;
    return {
      count: calls.length,
      keys: Object.keys(calls[1]),
      reused: file === calls[0].files![0],
      type: file.type,
      name: file.name,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    };
  });
  expect(result.count).toBe(2);
  expect(result.keys).toEqual(['files']);
  expect(result.reused).toBe(true);
  expect(result.name).toMatch(/-書き込み\.pdf$/);
  expect(result.type).toBe('application/pdf');
  expect((await PDFDocument.load(new Uint8Array(result.bytes))).getPageCount()).toBe(3);
});

test('offers a downloadable PDF when the share target cannot accept files', async ({ page }) => {
  const dialog = await prepare(page, false);
  await expect(dialog.getByRole('button', { name: '共有先を選ぶ' })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'PDFを保存' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toMatch(/-書き込み\.pdf$/);
  expect((await PDFDocument.load(await readFile((await saved.path())!))).getPageCount()).toBe(3);
});
