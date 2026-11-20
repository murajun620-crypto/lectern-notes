import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import type { Project } from '../src/model';

type ProjectFile = { name: string; mimeType: string; buffer: Buffer };

async function fallbackPicker(page: Page) {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }),
  );
}

async function goToLibrary(page: Page) {
  await page.getByRole('button', { name: 'ライブラリに戻る', exact: true }).click();
  await expect(page.getByRole('heading', { name: '講義資料', exact: true })).toBeVisible();
}

async function openFile(page: Page, file: ProjectFile) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'プロジェクトを開く', exact: true }).click();
  await (await chooser).setFiles(file);
}

async function saveFile(page: Page): Promise<ProjectFile> {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'プロジェクトを保存', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.lectern$/i);
  return {
    name: file.suggestedFilename(),
    mimeType: 'application/octet-stream',
    buffer: await readFile((await file.path())!),
  };
}

async function unpack(file: ProjectFile) {
  const signature = Buffer.from('LECTERN/1\n');
  expect(file.buffer.subarray(0, signature.length)).toEqual(signature);
  const zip = await JSZip.loadAsync(file.buffer.subarray(signature.length));
  const { project, format, version } = JSON.parse(await zip.file('project.json')!.async('string'));
  expect(format).toBe('lectern-project');
  expect(version).toBe(1);
  const stored = project as Project;
  const asset = zip.file(`assets/${stored.pages[0].assetId}.pdf`)!;
  return { project: stored, pdf: await asset.async('nodebuffer') };
}

async function draw(page: Page, tool: 'ペン' | '蛍光ペン') {
  await page.getByRole('button', { name: tool, exact: true }).click();
  const box = (await page.getByTestId('pdf-page').boundingBox())!;
  const y = box.y + box.height * 0.66;
  await page.mouse.move(box.x + box.width * 0.23, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.57, y + 12, { steps: 8 });
  await page.mouse.up();
}

test('an editable file makes a round trip between isolated devices with its PDF, ink, videos, tags and page identity', async ({
  page: desktop,
  browser,
  baseURL,
}) => {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]).drawText('First sheet');
  pdf.addPage([842, 595]).drawText('Landscape sheet');
  const original = Buffer.from(await pdf.save());
  await fallbackPicker(desktop);
  await desktop.goto('/');
  const chooser = desktop.waitForEvent('filechooser');
  await desktop.getByRole('button', { name: 'PDFを読み込む', exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: '数学.pdf', mimeType: 'application/pdf', buffer: original });
  await expect(desktop.getByTestId('pdf-page')).toBeVisible();
  await desktop.locator('.export-menu > summary').click();
  await desktop.getByRole('button', { name: '科目・年度を編集', exact: true }).click();
  await desktop.getByLabel('科目名', { exact: true }).fill('線形代数');
  await desktop.getByLabel('年度', { exact: true }).fill('2026');
  await desktop.getByRole('button', { name: '保存する', exact: true }).click();
  await desktop.getByRole('button', { name: 'ページ1を後へ', exact: true }).click();
  await desktop.getByRole('button', { name: 'ページ 1', exact: true }).click();
  await draw(desktop, 'ペン');
  await desktop.getByRole('button', { name: 'YouTube挿入', exact: true }).click();
  await desktop.getByLabel('YouTube URL').fill('https://youtu.be/M7lc1UVf-VE');
  await desktop.getByRole('button', { name: 'このページに追加', exact: true }).click();
  const outbound = await saveFile(desktop);
  const before = await unpack(outbound);
  expect(outbound.name).toBe('数学.lectern');
  expect(before.pdf.equals(original)).toBe(true);
  expect(before.project).toMatchObject({ name: '数学', subject: '線形代数', academicYear: '2026' });
  expect(before.project.pages.map((p) => p.sourcePage)).toEqual([2, 1]);
  expect(before.project.pages[0].strokes).toHaveLength(1);
  expect(before.project.pages[0].videos[0].videoId).toBe('M7lc1UVf-VE');
  await goToLibrary(desktop);
  await test.step('Reopen the library with the database version deployed before the rollback', async () => {
    await desktop.goto('/version.json');
    await desktop.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('lectern', 2);
          request.onupgradeneeded = () => request.result.createObjectStore('projectFileTargets');
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
          request.onerror = () => reject(request.error);
        }),
    );
    await desktop.goto('/');
    await expect(desktop.locator('.project-open')).toHaveCount(1);
  });

  const device = await browser.newContext({ baseURL, viewport: { width: 1024, height: 768 } });
  try {
    const ipad = await device.newPage();
    await fallbackPicker(ipad);
    await ipad.goto('/');
    await openFile(ipad, outbound);
    await expect(ipad.getByTestId('video-box')).toBeVisible();
    await ipad.getByRole('button', { name: '次のページ', exact: true }).click();
    await draw(ipad, '蛍光ペン');
    const incoming = await saveFile(ipad);
    const after = await unpack(incoming);
    expect(after.pdf.equals(original)).toBe(true);
    expect(after.project.id).toBe(before.project.id);
    expect(after.project.pages.map((p) => p.id)).toEqual(before.project.pages.map((p) => p.id));
    expect(after.project.pages[0].strokes).toEqual(before.project.pages[0].strokes);
    expect(after.project.pages[0].videos).toEqual(before.project.pages[0].videos);
    expect(after.project.pages[1].strokes).toMatchObject([{ tool: 'highlighter' }]);
    expect(after.project.currentPage).toBe(1);
    await openFile(desktop, incoming);
    const dialog = desktop.getByRole('dialog');
    await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
    await expect(desktop.locator('.project-open')).toHaveCount(1);
    await desktop.locator('.project-open').click();
    const kept = await unpack(await saveFile(desktop));
    expect(kept.project.pages[1].strokes).toHaveLength(0);

    await goToLibrary(desktop);
    await openFile(desktop, incoming);
    await dialog.getByRole('button', { name: 'ファイルの内容で開く', exact: true }).click();
    await expect(desktop.getByLabel('ページ番号')).toHaveValue('2');
    await desktop.reload();
    const roundTrip = await unpack(await saveFile(desktop));
    expect(roundTrip.project.id).toBe(before.project.id);
    expect(roundTrip.project.pages[1].strokes).toEqual(after.project.pages[1].strokes);
    expect(roundTrip.pdf.equals(original)).toBe(true);
    await goToLibrary(desktop);
    await expect(desktop.locator('.project-open')).toHaveCount(1);
    // Opening the same content again both bypasses replacement and retains a single library item.
    await openFile(desktop, incoming);
    await expect(desktop.getByTestId('pdf-page')).toBeVisible();
    await expect(dialog).toBeHidden();
  } finally {
    await device.close();
  }
});

test('saving reuses a chosen file until another app modifies it', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { picks: 0, writes: 0 };
    let disk = new File([], 'chosen.lectern', { lastModified: 1 });
    Object.assign(window, {
      projectFileTest: state,
      modifyDisk: () => {
        disk = new File(['new contents from another app'], disk.name, {
          lastModified: disk.lastModified + 1,
        });
      },
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        state.picks++;
        return {
          kind: 'file',
          name: disk.name,
          getFile: async () => disk,
          createWritable: async () => {
            let buffer: Blob;
            return {
              write: async (data: Blob) => {
                buffer = data;
              },
              close: async () => {
                if (!buffer?.size) throw new Error('Empty project file');
                disk = new File([buffer], disk.name, { lastModified: disk.lastModified + 1 });
                state.writes++;
              },
              abort: async () => {},
            };
          },
        };
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'まずは3ページのサンプルで試す' }).click();
  const save = page.getByRole('button', { name: 'プロジェクトを保存', exact: true });
  const stats = () =>
    page.evaluate(
      () =>
        (window as Window & { projectFileTest: { picks: number; writes: number } }).projectFileTest,
    );
  await save.click();
  await expect.poll(stats).toEqual({ picks: 1, writes: 1 });
  await draw(page, 'ペン');
  await save.click();
  await expect.poll(stats).toEqual({ picks: 1, writes: 2 });
  await page.evaluate(() => (window as Window & { modifyDisk(): void }).modifyDisk());
  await save.click();
  await expect(page.getByRole('alert')).toContainText('別の端末またはアプリで変更');
  expect(await stats()).toEqual({ picks: 1, writes: 2 });
});
