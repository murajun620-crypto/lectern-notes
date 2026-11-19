import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true });

async function demo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'まずは3ページのサンプルで試す' }).click();
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await expect(page.locator('.pdf-loading')).toHaveCount(0);
}

test('protects both bars from active and delayed palm taps while allowing a fresh Pencil tap', async ({
  page,
}) => {
  await demo(page);
  const blocked = await page.evaluate(async () => {
    HTMLElement.prototype.setPointerCapture = () => {};
    const stage = document.querySelector('[data-testid="stage"]')!;
    const next = document.querySelector('.editor-footer [aria-label="次のページ"]')!;
    const jump = document.querySelector('.editor-footer input')!;
    const eraser = document.querySelector('.toolbar [aria-label="消しゴム"]')!;
    const zoom = document.querySelector('.editor-footer [aria-label="表示倍率"]')!;
    const box = document.querySelector('[data-testid="pdf-page"]')!.getBoundingClientRect();
    const x = box.x + box.width / 3;
    const y = box.y + box.height / 2;
    const send = (target: Element, type: string, id: number, device = 'touch', dx = 0) =>
      !target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: id,
          pointerType: device,
          isPrimary: true,
          clientX: x + dx,
          clientY: y,
          pressure: 0.5,
          buttons: type === 'pointerup' || type === 'click' ? 0 : 1,
          detail: type === 'click' ? 1 : 0,
        }),
      );
    const priorPalmDown = send(next, 'pointerdown', 11);
    send(stage, 'pointerdown', 51, 'pen');
    send(stage, 'pointermove', 51, 'pen', 30);
    const blockedEraser = send(eraser, 'pointerdown', 12);
    const blockedFocus = send(jump, 'pointerdown', 13);
    const blockedRelease = send(next, 'pointerup', 11);
    send(eraser, 'pointerup', 12);
    send(jump, 'pointerup', 13);
    send(stage, 'pointerup', 51, 'pen', 30);
    const blockedNativeSelect = send(zoom, 'pointerdown', 14);
    send(zoom, 'pointerup', 14);
    const blockedTouchClick = send(eraser, 'click', 12);
    send(eraser, 'pointerdown', 52, 'pen');
    send(eraser, 'pointerup', 52, 'pen');
    const blockedPencilTap = send(eraser, 'click', 52, 'pen');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const blockedDelayedFocus = !jump.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 }),
    );
    const blockedDelayedNext = !next.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        detail: 1,
      }),
    );
    return {
      priorPalmDown,
      blockedEraser,
      blockedFocus,
      blockedRelease,
      blockedNativeSelect,
      blockedTouchClick,
      blockedPencilTap,
      blockedDelayedFocus,
      blockedDelayedNext,
    };
  });
  expect(blocked).toEqual({
    priorPalmDown: false,
    blockedEraser: true,
    blockedFocus: true,
    blockedRelease: true,
    blockedNativeSelect: true,
    blockedTouchClick: true,
    blockedPencilTap: false,
    blockedDelayedFocus: true,
    blockedDelayedNext: true,
  });
  const eraser = page.getByRole('button', { name: '消しゴム', exact: true });
  await expect(eraser).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('ページ番号')).toHaveValue('1');
  await expect(page.getByRole('button', { name: '元に戻す', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '次のページ', exact: true }).tap();
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
});

test('hiding the lower bar keeps page and zoom controls in a stationary top menu', async ({
  page,
}) => {
  await demo(page);
  const stage = page.getByTestId('stage');
  const footer = page.locator('.editor-footer');
  const settings = page.getByLabel('入力設定', { exact: true });
  const menu = page.getByText('ページ・表示', { exact: true });
  const initial = (await stage.boundingBox())!;
  await settings.tap();
  await page.getByRole('checkbox', { name: '下部バーを表示', exact: true }).uncheck();
  await expect(footer).toHaveCount(0);
  const larger = (await stage.boundingBox())!;
  expect(larger.height).toBeGreaterThan(initial.height);
  await menu.tap();
  const topPanel = page.locator('.page-view-dropdown');
  await expect(topPanel).toBeVisible();
  expect(await stage.boundingBox()).toEqual(larger);
  await topPanel.getByLabel('表示倍率').selectOption('2');
  await topPanel.getByRole('button', { name: '次のページ', exact: true }).tap();
  await expect(topPanel.getByLabel('ページ番号')).toHaveValue('2');
  expect(await stage.boundingBox()).toEqual(larger);
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await page.reload();
  await expect(footer).toHaveCount(0);
  await expect(menu).toBeVisible();
  await settings.tap();
  await page.getByRole('checkbox', { name: '下部バーを表示', exact: true }).check();
  await expect(footer.getByLabel('ページ番号')).toHaveValue('2');
  await expect(menu).toHaveCount(0);
});
