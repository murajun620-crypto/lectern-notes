import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('recovers confirmed Pencil motion without a start and never paints post-release motion', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'まずは3ページのサンプルで試す' }).click();
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await page.getByLabel('入力設定', { exact: true }).click();
  await page.getByRole('button', { name: 'Pencil入力を記録', exact: true }).click();
  await page.getByTestId('stage').evaluate((stage) => {
    HTMLElement.prototype.setPointerCapture = () => {};
    const paper = stage.querySelector('[data-testid=pdf-page]')!;
    const box = paper.getBoundingClientRect();
    const x = Math.round(box.left + box.width / 2);
    const y = Math.round(box.top + box.height / 2);
    const time = performance.now();
    const pointer = (
      type: string,
      id: number,
      dx: number,
      t: number,
      buttons: number,
      coalesced: number[] = [],
    ) => {
      const data = {
        bubbles: true,
        pointerId: id,
        pointerType: 'pen',
        button: 0,
        buttons,
        pressure: 0,
        isPrimary: true,
        clientX: x + dx,
        clientY: y,
      };
      const event = new PointerEvent(type, data);
      Object.defineProperties(event, {
        timeStamp: { value: time + t },
        getCoalescedEvents: {
          value: () =>
            coalesced.map((delta, i) => ({
              ...data,
              clientX: x + delta,
              timeStamp: time + t - coalesced.length + i + 1,
              type: 'pointermove',
            })),
        },
      });
      paper.dispatchEvent(event);
    };
    const touch = (type: string, id: number, dx: number, t: number, touchType = 'stylus') => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const contact = {
        identifier: id,
        touchType,
        clientX: x + dx,
        clientY: y,
        target: paper,
        force: 0,
      };
      Object.defineProperties(event, {
        timeStamp: { value: time + t },
        changedTouches: { value: [contact] },
        touches: { value: type === 'touchend' ? [] : [contact] },
      });
      paper.dispatchEvent(event);
    };

    pointer('pointermove', 100, 0, 1, 0); // hover
    touch('touchmove', 101, 1, 2, 'direct');
    pointer('pointermove', 102, 7, 10, 1, [2, 4, 7]); // no down, first real sample at +2
    pointer('pointerdown', 102, 2, 7, 1); // delayed original start
    touch('touchstart', 102, 2, 7);
    pointer('pointerup', 102, 85, 12, 0);
    touch('touchmove', 102, 55, 13); // companion stream after physical lift
    touch('touchend', 102, 55, 14);
    pointer('pointermove', 102, 88, 16, 1); // stale same-ID packet
    touch('touchmove', 110, 72, 11); // older timestamp but different touch identifier

    touch('touchmove', 103, 20, 20); // no pointer stream or touchstart
    touch('touchmove', 103, 25, 22);
    touch('touchend', 103, 75, 24);
    touch('touchmove', 103, 80, 25);
    // A subsequent genuine start with a reused identifier still opens a fresh stroke.
    pointer('pointerdown', 102, 30, 30, 1);
    pointer('pointermove', 102, 36, 32, 1);
    pointer('pointerup', 102, 80, 34, 0);
  });
  await page.getByLabel('入力設定', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '記録を終了して書き出す', exact: true }).click();
  const report = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  const events: {
    type: string;
    id?: number;
    recoveredStart?: string;
    dx?: number;
    pointCount?: number;
  }[] = report.events;
  expect(
    events
      .filter((e) => e.type === 'strokeFinished')
      .map((e) => [e.recoveredStart, e.pointCount, e.dx]),
  ).toEqual([
    ['pointermove', 3, 5],
    ['touchmove', 2, 5],
    [undefined, 2, 6],
  ]);
  expect(events.some((e) => e.id === 100 && e.type === 'pointermove')).toBe(false);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'pointermove', id: 102, originFromMove: true }),
      expect.objectContaining({
        type: 'touchmove',
        id: 103,
        originFromMove: true,
        startedInStage: false,
      }),
    ]),
  );
});
