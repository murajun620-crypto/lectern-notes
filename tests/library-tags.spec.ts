import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

async function openSample(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'まずは3ページのサンプルで試す' }).click();
  await expect(page.getByTestId('pdf-page')).toBeVisible();
}

async function returnToLibrary(page: Page) {
  await page.getByRole('button', { name: 'ライブラリに戻る', exact: true }).click();
  await expect(page.getByRole('heading', { name: '講義資料', exact: true })).toBeVisible();
}

async function editFromLibrary(page: Page, name: string) {
  await page.getByLabel(`${name}のメニュー`, { exact: true }).click();
  await page.getByRole('button', { name: '科目・年度を編集', exact: true }).click();
}

async function saveTags(page: Page, subject: string, year: string) {
  await page.getByLabel('科目名', { exact: true }).fill(subject);
  await page.getByLabel('年度', { exact: true }).fill(year);
  await page.getByRole('button', { name: '保存する', exact: true }).click();
  await expect(page.getByLabel('年度', { exact: true })).toBeHidden();
}

test('library combines subject, academic year and name filters and can clear tags on a copy', async ({
  page,
}) => {
  await openSample(page);
  await returnToLibrary(page);
  const titles = page.locator('.project-open h3');
  const original = await titles.innerText();
  const copy = original + ' のコピー';
  const subject = page.getByLabel('科目で絞り込む', { exact: true });
  const year = page.getByLabel('年度で絞り込む', { exact: true });
  const query = page.getByLabel('資料を検索', { exact: true });
  await editFromLibrary(page, original);
  await expect(page.getByLabel('科目名', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('年度', { exact: true })).toHaveValue('');
  await saveTags(page, '情報科学', '２０２６年度');
  const originalCard = page
    .locator('.project-open')
    .filter({ has: page.getByRole('heading', { name: original, exact: true }) });
  await expect(originalCard.getByText('情報科学', { exact: true })).toBeVisible();
  await expect(originalCard.getByText('2026年度', { exact: true })).toBeVisible();
  await page.getByLabel(`${original}のメニュー`, { exact: true }).click();
  await page.getByRole('button', { name: '複製', exact: true }).click();
  await expect(titles).toHaveCount(2);
  await subject.selectOption({ label: '情報科学' });
  await year.selectOption({ label: '2026年度' });
  await expect(titles).toHaveCount(2);

  // A copied handout can be reused for a new year without changing its source.
  await editFromLibrary(page, copy);
  await expect(page.getByLabel('科目名', { exact: true })).toHaveValue('情報科学');
  await expect(page.getByLabel('年度', { exact: true })).toHaveValue('2026');
  await saveTags(page, '情報科学', '2025');
  await expect(titles).toHaveText([original]);
  await query.fill('コピー');
  await expect(titles).toHaveCount(0);
  await year.selectOption({ label: '2025年度' });
  await expect(titles).toHaveText([copy]);
  await query.fill('');
  await year.selectOption({ index: 0 });
  await expect(titles).toHaveCount(2);
  await query.fill('２０２５');
  await expect(titles).toHaveText([copy]);
  await query.fill('');

  await editFromLibrary(page, copy);
  await saveTags(page, '', '');
  await expect(titles).toHaveText([original]);
  await page.reload();
  await expect(subject).toBeVisible();
  await subject.selectOption({ label: '未設定' });
  await year.selectOption({ label: '未設定' });
  await expect(titles).toHaveText([copy]);
  await subject.selectOption({ label: '情報科学' });
  await expect(titles).toHaveCount(0);
  await year.selectOption({ label: '2026年度' });
  await expect(titles).toHaveText([original]);
});

test('editor tags round-trip in backups and handouts from before tags remain editable', async ({
  page,
}) => {
  await openSample(page);
  const exportMenu = page.locator('.export-menu > summary');
  const edit = page.getByRole('button', { name: '科目・年度を編集', exact: true });
  await exportMenu.click();
  await edit.click();
  await saveTags(page, '物理学', '2026');
  await exportMenu.click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '編集可能なバックアップ', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  const zip = await JSZip.loadAsync(bytes);
  const meta = JSON.parse(await zip.file('project.json')!.async('string'));
  expect(meta.project).toMatchObject({ subject: '物理学', academicYear: '2026' });

  async function restore(buffer: Buffer) {
    await returnToLibrary(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'バックアップを復元', exact: true }).click();
    await (
      await chooser
    ).setFiles({ name: 'handout.lecture.zip', mimeType: 'application/zip', buffer });
    await expect(page.getByTestId('pdf-page')).toBeVisible();
    await exportMenu.click();
    await edit.click();
  }

  await restore(bytes);
  await expect(page.getByLabel('科目名', { exact: true })).toHaveValue('物理学');
  await expect(page.getByLabel('年度', { exact: true })).toHaveValue('2026');
  await saveTags(page, '数学', '2025');
  delete meta.project.subject;
  delete meta.project.academicYear;
  meta.project.name = 'タグ導入前のハンドアウト';
  zip.file('project.json', JSON.stringify(meta));
  await restore(await zip.generateAsync({ type: 'nodebuffer' }));
  await expect(page.getByLabel('科目名', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('年度', { exact: true })).toHaveValue('');
  await saveTags(page, '統計学', '');
  await returnToLibrary(page);
  await page.getByLabel('科目で絞り込む', { exact: true }).selectOption({ label: '統計学' });
  await page.getByLabel('年度で絞り込む', { exact: true }).selectOption({ label: '未設定' });
  await expect(page.locator('.project-open h3')).toHaveText([meta.project.name]);
});

test('editor keeps tag input after a quota error and saves it on retry', async ({ page }) => {
  await openSample(page);
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  const exportMenu = page.locator('.export-menu > summary');
  const edit = page.getByRole('button', { name: '科目・年度を編集', exact: true });
  await exportMenu.click();
  await edit.click();
  const dialog = page.getByRole('dialog');
  const subject = dialog.getByLabel('科目名', { exact: true });
  const year = dialog.getByLabel('年度', { exact: true });
  const save = dialog.getByRole('button', { name: '保存する', exact: true });
  await subject.fill('生物学');
  await year.fill('2027');
  const restoreWrites = await page.evaluateHandle(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'projects')
        throw new DOMException('Test quota reached', 'QuotaExceededError');
      return put.call(this, value, key);
    };
    return () => {
      IDBObjectStore.prototype.put = put;
    };
  });
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText('保存容量が不足');
  await expect(subject).toHaveValue('生物学');
  await expect(year).toHaveValue('2027');
  await expect(save).toBeEnabled();

  await restoreWrites.evaluate((restore) => restore());
  await save.click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await exportMenu.click();
  await edit.click();
  await expect(subject).toHaveValue('生物学');
  await expect(year).toHaveValue('2027');
});
