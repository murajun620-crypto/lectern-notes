import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true });

async function demo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'まずは3ページのサンプルで試す' }).click();
  await expect(page.locator('.pdf-loading')).toHaveCount(0);
  return page.getByTestId('stage');
}

test('a fast one-finger native touch scroll coasts across a page and slows down', async ({
  page,
}) => {
  const stage = await demo(page);
  const offsets = await stage.evaluate(async (el) => {
    const target = el.querySelector('[data-testid="pdf-page"]')!;
    const box = el.getBoundingClientRect();
    const x = box.x + box.width / 2;
    const y = box.y + box.height * 0.68;
    const beginning = performance.now();
    const send = (type: string, dy: number, dt: number) => {
      const t = { identifier: 11, clientX: x, clientY: y + dy };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: type === 'touchend' ? [] : [t] },
        changedTouches: { value: [t] },
        timeStamp: { value: beginning + dt },
      });
      el.dispatchEvent(event);
    };
    send('touchstart', 0, 0);
    send('touchmove', -35, 16);
    send('touchmove', -76, 32);
    send('touchmove', -120, 50);
    send('touchend', -120, 56);
    const offset = () => ({ y: target.getBoundingClientRect().y, t: performance.now() });
    const sample = async (delay: number) => {
      await new Promise((r) => setTimeout(r, delay));
      await new Promise(requestAnimationFrame);
      return offset();
    };
    const first = offset();
    const middle = await sample(95);
    return [first, middle, await sample(220)];
  });
  const [a, b, c] = offsets;
  expect(a.y - b.y).toBeGreaterThan(40);
  expect(b.y - c.y).toBeGreaterThan(25);
  expect((a.y - b.y) / (b.t - a.t)).toBeGreaterThan((b.y - c.y) / (c.t - b.t));
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
  await expect(stage).not.toHaveAttribute('data-ink-preview');
});

test('a new touch stops a Pointer Events fling at its current position', async ({ page }) => {
  const stage = await demo(page);
  const result = await stage.evaluate(async (el) => {
    HTMLElement.prototype.setPointerCapture = () => {};
    const sheet = el.querySelector('.stack-paper')!;
    const box = el.getBoundingClientRect();
    const x = box.x + box.width / 2;
    const y = box.y + box.height * 0.68;
    let beginning = performance.now();
    const send = (type: string, id: number, dy: number, dt: number) => {
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        pointerId: id,
        isPrimary: true,
        clientX: x,
        clientY: y + dy,
        buttons: type === 'pointerup' ? 0 : 1,
      });
      Object.defineProperty(event, 'timeStamp', { value: beginning + dt });
      el.dispatchEvent(event);
    };
    send('pointerdown', 11, 0, 0);
    send('pointermove', 11, -28, 16);
    send('pointermove', 11, -56, 32);
    send('pointermove', 11, -90, 50);
    send('pointerup', 11, -90, 56);
    const release = sheet.getBoundingClientRect().y;
    await new Promise((r) => setTimeout(r, 65));
    beginning = performance.now();
    send('pointerdown', 12, 0, 0);
    const stop = sheet.getBoundingClientRect().y;
    await new Promise((r) => setTimeout(r, 130));
    const hold = sheet.getBoundingClientRect().y;
    send('pointerup', 12, 0, 130);
    return { release, stop, hold };
  });
  expect(result.release - result.stop).toBeGreaterThan(40);
  expect(result.hold).toBeCloseTo(result.stop, 1);
  await expect(stage).not.toHaveAttribute('data-ink-preview');
});
