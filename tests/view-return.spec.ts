import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const back = (page: Page) => page.getByRole('button', { name: '直前の表示に戻る', exact: true });
const remember = (page: Page) => page.getByRole('button', { name: 'ここを覚える', exact: true });
const thumbnail = (page: Page, n: number) =>
  page.getByRole('button', { name: `ページ ${n}`, exact: true });

async function jump(page: Page, input: string) {
  const field = page.getByRole('textbox', { name: 'ページ番号' });
  await field.fill(input);
  await field.press('Enter');
}

async function paperCenter(page: Page) {
  const stage = (await page.getByTestId('stage').boundingBox())!;
  const paper = (await page.getByTestId('pdf-page').boundingBox())!;
  return {
    x: (stage.x + stage.width / 2 - paper.x) / paper.width,
    y: (stage.y + stage.height / 2 - paper.y) / paper.height,
    width: paper.width,
    height: paper.height,
  };
}

async function expectCenter(page: Page, expected: { x: number; y: number }) {
  await expect
    .poll(async () => {
      const current = await paperCenter(page);
      return Math.max(
        Math.abs(current.x - expected.x) * current.width,
        Math.abs(current.y - expected.y) * current.height,
      );
    })
    .toBeLessThan(2);
}

async function pan(page: Page, dx: number, dy: number) {
  const r = (await page.getByTestId('stage').boundingBox())!;
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'まずは3ページのサンプルで試す' }).click();
  await expect(thumbnail(page, 1)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await expect(page.getByText('ページを読み込み中…', { exact: true })).toBeHidden();
});

for (const mode of ['continuous', 'single']) {
  test(`${mode}: returns through numbered and thumbnail jumps to the original PDF coordinates`, async ({
    page,
  }) => {
    const layout = page.getByLabel('ページ表示');
    const zoom = page.getByLabel('表示倍率');
    const fit = page.getByLabel('表示方法');
    await layout.selectOption(mode);
    await page.getByRole('button', { name: '移動', exact: true }).click();
    await fit.selectOption('width');
    await zoom.selectOption('2');
    await pan(page, 104, -92);
    const first = await paperCenter(page);
    expect(first.x).toBeLessThan(0.48);
    expect(first.y).toBeGreaterThan(0.52);
    await jump(page, '3');
    await expect(thumbnail(page, 3)).toHaveAttribute('aria-current', 'page');
    await fit.selectOption('page');
    await zoom.selectOption('3');
    await pan(page, -83, 71);
    const third = await paperCenter(page);
    expect(third.x).toBeGreaterThan(0.52);
    expect(third.y).toBeLessThan(0.48);

    await thumbnail(page, 2).click();
    await expect(thumbnail(page, 2)).toHaveAttribute('aria-current', 'page');
    await zoom.selectOption('1');
    // A different fit factor must still put the same point on the sheet in the center.
    await page.setViewportSize({ width: 1170, height: 820 });
    const otherMode = mode === 'single' ? 'continuous' : 'single';
    await layout.selectOption(otherMode);
    await back(page).click();
    await expect(thumbnail(page, 3)).toHaveAttribute('aria-current', 'page');
    await expect(zoom).toHaveValue('3');
    await expect(fit).toHaveValue('page');
    await expectCenter(page, third);
    await back(page).click();
    await expect(thumbnail(page, 1)).toHaveAttribute('aria-current', 'page');
    await expect(zoom).toHaveValue('2');
    await expect(fit).toHaveValue('width');
    await expect(layout).toHaveValue(otherMode);
    await expectCenter(page, first);
    await expect(back(page)).toBeHidden();
  });
}

test('a manual mark survives ordinary page turns and restores a same-page detour once', async ({
  page,
}) => {
  await jump(page, '99');
  await expect(page.getByLabel('ページ番号')).toHaveValue('1');
  await jump(page, '1');
  await thumbnail(page, 1).click();
  await page.getByRole('button', { name: '次のページ', exact: true }).click();
  await expect(thumbnail(page, 2)).toHaveAttribute('aria-current', 'page');
  await expect(back(page)).toBeHidden();
  await page.getByLabel('表示倍率').selectOption('3');
  await page.getByRole('button', { name: '移動', exact: true }).click();
  await pan(page, -70, -45);
  const marked = await paperCenter(page);
  await remember(page).click();
  await remember(page).click();
  await page.getByRole('button', { name: '次のページ', exact: true }).click();
  await page.getByRole('button', { name: '前のページ', exact: true }).click();
  await expect(thumbnail(page, 2)).toHaveAttribute('aria-current', 'page');
  await page.getByLabel('表示倍率').selectOption('1');
  await back(page).click();
  await expect(page.getByLabel('表示倍率')).toHaveValue('3');
  await expectCenter(page, marked);
  await expect(back(page)).toBeHidden();
});

test('return follows the reordered sheet, drops deleted sheets and clears when reopening', async ({
  page,
}) => {
  await thumbnail(page, 3).click(); // Remember the original first sheet.
  await page.getByRole('button', { name: 'ページ1を後へ' }).click();
  await back(page).click();
  await expect(thumbnail(page, 2)).toHaveAttribute('aria-current', 'page');

  await thumbnail(page, 3).click();
  await page.getByRole('button', { name: 'ページ2を削除' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'ページを削除' }).click();
  await expect(back(page)).toBeHidden();

  await remember(page).click();
  await expect(back(page)).toBeVisible();
  await page.getByRole('button', { name: 'ライブラリに戻る' }).click();
  await page.locator('.project-open').click();
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await expect(back(page)).toBeHidden();
});

test('a full-screen page mark stays available after hiding the footer', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole('button', { name: '全画面表示', exact: true }).click();
  await remember(page).click();
  await page.getByLabel('入力設定', { exact: true }).click();
  await page.getByLabel('下部バーを表示').uncheck();
  await page.getByLabel('入力設定', { exact: true }).click();
  await expect(page.locator('.editor-footer')).toBeHidden();
  await expect(remember(page)).toHaveCount(0);
  await page.locator('.edge-nav.next').click();
  await back(page).click();
  await expect(page.locator('.edge-nav.prev')).toBeDisabled();
  await expect(back(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'ペン', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
