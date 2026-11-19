import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function demo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'まずは3ページのサンプルで試す' }).click();
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await expect(page.getByText('ページを読み込み中…', { exact: true })).toBeHidden();
}
async function stored(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('lectern', 1);
      r.onsuccess = () => resolve(r.result);
    });
    const data = await new Promise<any[]>((resolve) => {
      const r = db.transaction('projects').objectStore('projects').getAll();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return data;
  });
}
async function pointer(
  page: Page,
  type: string,
  id: number,
  pointerType: string,
  x: number,
  y: number,
  extra = {},
) {
  await page.getByTestId('stage').dispatchEvent(type, {
    pointerId: id,
    pointerType,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    pressure: type === 'pointerup' ? 0 : 0.65,
    width: 8,
    height: 8,
    isPrimary: true,
    ...extra,
  });
}
async function nativeTouch(
  page: Page,
  type: string,
  points: {
    identifier: number;
    clientX: number;
    clientY: number;
    touchType?: string;
    radiusX?: number;
    radiusY?: number;
  }[],
  changed = points,
) {
  await page.getByTestId('stage').evaluate(
    (el, args) => {
      const e = new Event(args.type, { bubbles: true, cancelable: true });
      Object.defineProperties(e, {
        touches: { value: args.points },
        changedTouches: { value: args.changed },
        targetTouches: { value: args.points },
      });
      el.dispatchEvent(e);
    },
    { type, points, changed },
  );
}
async function mockYoutube(page: Page) {
  await page.route('https://www.youtube.com/iframe_api', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.YT={Player:class{constructor(el,o){this.iframe=document.createElement('iframe');this.iframe.src='about:blank';el.replaceWith(this.iframe);setTimeout(()=>o.events.onReady(),20);this.iframe.addEventListener('mock-ended',()=>o.events.onStateChange({data:0}));}playVideo(){}getIframe(){return this.iframe;}destroy(){this.iframe.remove();}}};window.onYouTubeIframeAPIReady();`,
    }),
  );
}

test('finger writing accepts broad contacts and yields to native pinch on a phone-sized viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await page.getByRole('button', { name: '移動', exact: true }).click();
  await page.getByLabel('入力設定', { exact: true }).click();
  await page.getByRole('checkbox', { name: '指でも筆記する', exact: true }).check();
  await page.getByLabel('入力設定', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'ペン', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.evaluate(() => {
    HTMLElement.prototype.setPointerCapture = function () {};
  });
  let r = (await page.getByTestId('pdf-page').boundingBox())!;
  const x = r.x + r.width * 0.25,
    y = r.y + r.height * 0.4;
  await pointer(page, 'pointerdown', 1, 'touch', x, y, { width: 60, height: 54, pressure: 1 });
  // An implicit capture lost by the child page must not cancel the stage's capture.
  await page
    .getByTestId('pdf-page')
    .dispatchEvent('lostpointercapture', { pointerId: 1, pointerType: 'touch', bubbles: true });
  for (let i = 1; i <= 8; i++)
    await pointer(page, 'pointermove', 1, 'touch', x + i * 5, y + Math.sin(i) * 4, {
      width: 60,
      height: 54,
      pressure: i / 8,
    });
  await pointer(page, 'pointerup', 1, 'touch', x + 40, y, { width: 60, height: 54 });
  await expect.poll(async () => (await stored(page))[0].pages[0].strokes.length).toBe(1);
  const stroke = (await stored(page))[0].pages[0].strokes[0];
  expect(stroke.points.length).toBeGreaterThan(5);
  expect(stroke.points.every((pt: any) => pt.p === 0.5)).toBe(true);
  r = (await page.getByTestId('pdf-page').boundingBox())!;
  const cx = r.x + r.width / 2,
    cy = r.y + r.height / 2;
  const a = { identifier: 11, clientX: cx - 25, clientY: cy, radiusX: 30, radiusY: 27 },
    b = { identifier: 12, clientX: cx + 25, clientY: cy, radiusX: 30, radiusY: 27 };
  await pointer(page, 'pointerdown', 11, 'touch', a.clientX, a.clientY, { width: 60, height: 54 });
  await nativeTouch(page, 'touchstart', [a]);
  await pointer(page, 'pointerdown', 12, 'touch', b.clientX, b.clientY, { width: 60, height: 54 });
  await nativeTouch(page, 'touchstart', [a, b]);
  const am = { ...a, clientX: cx - 60 },
    bm = { ...b, clientX: cx + 60 };
  await pointer(page, 'pointermove', 11, 'touch', am.clientX, am.clientY, {
    width: 60,
    height: 54,
  });
  await pointer(page, 'pointermove', 12, 'touch', bm.clientX, bm.clientY, {
    width: 60,
    height: 54,
  });
  await nativeTouch(page, 'touchmove', [am, bm]);
  await expect
    .poll(async () => (await page.getByTestId('pdf-page').boundingBox())!.width / r.width)
    .toBeGreaterThan(2);
  await pointer(page, 'pointerup', 11, 'touch', am.clientX, am.clientY);
  await nativeTouch(page, 'touchend', [bm], [am]);
  await pointer(page, 'pointerup', 12, 'touch', bm.clientX, bm.clientY);
  await nativeTouch(page, 'touchend', [], [bm]);
  await expect(page.getByRole('button', { name: 'ペン', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect((await stored(page))[0].pages[0].strokes).toHaveLength(1);
  // Safari's Touch Events must also pinch when no secondary PointerEvent is delivered.
  await page.getByLabel('表示倍率').selectOption('1');
  await nativeTouch(page, 'touchstart', [a, b]);
  await nativeTouch(page, 'touchmove', [am, bm]);
  await nativeTouch(page, 'touchend', [], [am, bm]);
  await expect
    .poll(async () => Number(await page.getByLabel('表示倍率').inputValue()))
    .toBeGreaterThan(2);
  const before = await page.getByTestId('pdf-page').evaluate((el) => el.style.transform);
  await nativeTouch(page, 'touchstart', [am, bm]);
  await nativeTouch(page, 'touchmove', [
    { ...am, clientX: am.clientX + 25, clientY: am.clientY + 20 },
    { ...bm, clientX: bm.clientX + 25, clientY: bm.clientY + 20 },
  ]);
  await nativeTouch(page, 'touchend', [], [am, bm]);
  await expect
    .poll(() => page.getByTestId('pdf-page').evaluate((el) => el.style.transform))
    .not.toBe(before);
  expect((await stored(page))[0].pages[0].strokes).toHaveLength(1);
});

test('real broad-finger touch events can draw and pinch with finger ink enabled', async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Real gesture injection uses CDP; WebKit native Touch Events are tested separately.',
  );
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await demo(page);
  await page.getByLabel('入力設定', { exact: true }).click();
  await page.getByRole('checkbox', { name: '指でも筆記する', exact: true }).check();
  await page.getByLabel('入力設定', { exact: true }).click();
  const session = await context.newCDPSession(page),
    r = (await page.getByTestId('pdf-page').boundingBox())!,
    x = r.x + r.width * 0.25,
    y = r.y + r.height * 0.4;
  const touch = async (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    points: { x: number; y: number; id: number }[],
  ) =>
    session.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p) => ({ ...p, radiusX: 30, radiusY: 27, force: 1 })),
    });
  await touch('touchStart', [{ x, y, id: 1 }]);
  for (let i = 1; i <= 10; i++)
    await touch('touchMove', [{ x: x + i * 4, y: y + Math.sin(i) * 3, id: 1 }]);
  await touch('touchEnd', []);
  await expect.poll(async () => (await stored(page))[0].pages[0].strokes.length).toBe(1);
  expect((await stored(page))[0].pages[0].strokes[0].points.every((pt: any) => pt.p === 0.5)).toBe(
    true,
  );
  const cx = r.x + r.width / 2,
    cy = r.y + r.height / 2;
  await touch('touchStart', [
    { x: cx - 25, y: cy, id: 2 },
    { x: cx + 25, y: cy, id: 3 },
  ]);
  await touch('touchMove', [
    { x: cx - 60, y: cy, id: 2 },
    { x: cx + 60, y: cy, id: 3 },
  ]);
  await touch('touchEnd', []);
  await expect
    .poll(async () => Number(await page.getByLabel('表示倍率').inputValue()))
    .toBeGreaterThan(2);
  expect((await stored(page))[0].pages[0].strokes).toHaveLength(1);
  await context.close();
});

test('Pencil writes in hand mode, a resting palm stays blocked, and two-finger tap switches eraser', async ({
  page,
}) => {
  await demo(page);
  await page.getByLabel('ページ表示').selectOption('single');
  // Synthetic events test routing on both engines; real pointer capture is covered by CDP tests.
  await page.evaluate(() => {
    HTMLElement.prototype.setPointerCapture = function () {};
  });
  await page.getByRole('button', { name: '移動', exact: true }).click();
  let r = (await page.getByTestId('pdf-page').boundingBox())!;
  const x = r.x + r.width * 0.3,
    y = r.y + r.height * 0.45;
  await pointer(page, 'pointerdown', 1, 'pen', x, y);
  await pointer(page, 'pointermove', 1, 'pen', x + 40, y + 15);
  await pointer(page, 'pointerup', 1, 'pen', x + 40, y + 15);
  await expect.poll(async () => (await stored(page))[0].pages[0].strokes.length).toBe(1);
  await expect(page.getByRole('button', { name: '移動', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.waitForTimeout(400);
  await page.getByLabel('表示倍率').selectOption('2');
  r = (await page.getByTestId('pdf-page').boundingBox())!;
  const a = r.x + r.width * 0.45,
    b = r.y + r.height * 0.5;
  const original = await page.getByTestId('pdf-page').evaluate((el) => el.style.transform);
  await pointer(page, 'pointerdown', 2, 'touch', a, b);
  await pointer(page, 'pointermove', 2, 'touch', a, b + 40);
  await expect
    .poll(() => page.getByTestId('pdf-page').evaluate((el) => el.style.transform))
    .not.toBe(original);
  await pointer(page, 'pointerdown', 3, 'pen', a, b);
  await expect
    .poll(() => page.getByTestId('pdf-page').evaluate((el) => el.style.transform))
    .toBe(original);
  await pointer(page, 'pointermove', 2, 'touch', a - 180, b + 40);
  await pointer(page, 'pointermove', 3, 'pen', a + 20, b + 10);
  await pointer(page, 'pointerup', 3, 'pen', a + 20, b + 10);
  await page.waitForTimeout(400);
  await pointer(page, 'pointermove', 2, 'touch', a - 200, b + 40);
  await pointer(page, 'pointerup', 2, 'touch', a - 200, b + 40);
  await expect(page.getByLabel('ページ番号')).toHaveValue('1');
  await expect.poll(async () => (await stored(page))[0].pages[0].strokes.length).toBe(2);
  await pointer(page, 'pointerdown', 4, 'touch', a, b, { width: 100, height: 90 });
  await pointer(page, 'pointermove', 4, 'touch', a - 150, b, { width: 100, height: 90 });
  await pointer(page, 'pointerup', 4, 'touch', a - 150, b, { width: 100, height: 90 });
  await expect(page.getByLabel('ページ番号')).toHaveValue('1');
  for (let i = 0; i < 2; i++) {
    await pointer(page, 'pointerdown', 5, 'touch', a - 30, b);
    await pointer(page, 'pointerdown', 6, 'touch', a + 30, b);
    await pointer(page, 'pointerup', 5, 'touch', a - 30, b);
    await pointer(page, 'pointerup', 6, 'touch', a + 30, b);
    await expect(
      page.getByRole('button', { name: i ? 'ペン' : '消しゴム', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  }
  // A newly placed finger can swipe immediately after lifting Pencil; only held contacts stay blocked.
  await pointer(page, 'pointerdown', 7, 'pen', a, b);
  await pointer(page, 'pointerup', 7, 'pen', a, b);
  await pointer(page, 'pointerdown', 8, 'touch', a + 40, b);
  await pointer(page, 'pointermove', 8, 'touch', a - 80, b);
  await pointer(page, 'pointerup', 8, 'touch', a - 80, b);
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
});

test.describe('Pencil contact samples', () => {
  test.use({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2 });

  test('Pencil strokes stay continuous when a detailed batch loses contact flags', async ({
    page,
  }) => {
    await demo(page);
    await page.getByRole('button', { name: '白紙を追加', exact: true }).click();
    await expect(page.getByLabel('ページ番号')).toHaveValue('2');
    await page.getByLabel('ペンの太さ', { exact: true }).selectOption('1');
    const stage = page.getByTestId('stage');
    const rect = (await stage.boundingBox())!;
    const x = Math.round(rect.x + rect.width / 2 - 105);
    const y = rect.y + rect.height / 2 - 20;
    await stage.evaluate(
      async (el, pos) => {
        HTMLElement.prototype.setPointerCapture = () => {};
        const send = (
          type: string,
          dx: number,
          dy: number,
          samples?: { clientX: number; clientY: number; pressure: number; buttons: number }[],
          contact = true,
        ) => {
          const event = new PointerEvent(type, {
            bubbles: true,
            pointerType: 'pen',
            pointerId: 43,
            isPrimary: true,
            clientX: pos.x + dx,
            clientY: pos.y + dy,
            pressure: contact ? 0.07 : 0,
            buttons: contact ? 1 : 0,
          });
          if (samples) Object.defineProperty(event, 'getCoalescedEvents', { value: () => samples });
          el.dispatchEvent(event);
        };
        send('pointerdown', 0, 0);
        const slope = 43 / 204;
        for (let i = 1; i <= 12; i++) {
          const dx = 17 * i;
          send(
            'pointermove',
            dx - 4,
            dx * slope - 0.8,
            [dx - 8, dx].map((offset) => ({
              clientX: pos.x + offset,
              clientY: pos.y + offset * slope,
              pressure: 0.07,
              buttons: 1,
            })),
          );
          await new Promise(requestAnimationFrame);
        }
        // Browsers without detailed samples still contribute the dispatched point.
        send('pointermove', 218, 218 * slope, []);
        const unmarked = (offset: number) => [
          {
            clientX: pos.x + offset,
            clientY: pos.y + offset * slope,
            pressure: 0,
            buttons: 0,
          },
        ];
        for (const offset of [231, 245, 258]) {
          send('pointermove', offset, offset * slope, unmarked(offset - 4));
          await new Promise(requestAnimationFrame);
        }
        send('pointermove', 270, 68, unmarked(266), false);
      },
      { x, y },
    );
    const gaps = (selector: string) =>
      page.locator(selector).evaluate(
        (c: HTMLCanvasElement, pos) => {
          const box = c.getBoundingClientRect();
          const ratio = c.width / box.width;
          const w = Math.round(240 * ratio);
          const h = Math.round(67 * ratio);
          const rgba = c
            .getContext('2d')!
            .getImageData(
              Math.floor((pos.x + 10 - box.x) * ratio),
              Math.floor((pos.y - 5 - box.y) * ratio),
              w,
              h,
            ).data;
          let empty = 0;
          for (let i = 0; i < w; i++) {
            let covered = false;
            for (let j = 0; j < h && !covered; j++) covered = rgba[(j * w + i) * 4 + 3] > 16;
            if (!covered) empty++;
          }
          return empty;
        },
        { x, y },
      );
    await expect.poll(() => gaps('.ink-draft-canvas')).toBe(0);
    await pointer(page, 'pointerup', 43, 'pen', x + 280, y + 77);
    await expect.poll(() => gaps('.ink-canvas')).toBe(0);
    const pdf = (await page.getByTestId('pdf-page').boundingBox())!;
    await expect
      .poll(async () => {
        const blank = (await stored(page))[0].pages[1];
        return blank.strokes[0]?.points.map((p: { x: number }) =>
          Math.round(pdf.x + (p.x / blank.width) * pdf.width - x),
        );
      })
      .toEqual([
        0,
        ...Array.from({ length: 12 }, (_, i) => {
          const dx = 17 * (i + 1);
          return [dx - 8, dx];
        }).flat(),
        218,
        231,
        245,
        258,
      ]);
  });
});

test('Pencil paint takes priority over PDF refresh and lift-off cannot extend the stroke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await demo(page);
  await page.evaluate(() => {
    HTMLElement.prototype.setPointerCapture = () => {};
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (x, y, width, height) {
      if (this.canvas.classList.contains('ink-draft-canvas'))
        this.canvas.dataset.clearWidth = String(width);
      clear.call(this, x, y, width, height);
    };
  });
  const stage = (await page.getByTestId('stage').boundingBox())!;
  const start = stage.x + stage.width / 2 - 155;
  const y = stage.y + stage.height / 2;
  await page.getByLabel('表示倍率').selectOption('2');
  await pointer(page, 'pointerdown', 41, 'pen', start, y, { pressure: 0.06 });
  for (let i = 1; i <= 10; i++)
    await pointer(page, 'pointermove', 41, 'pen', start + i * 15, y, { pressure: 0.06 });
  const draft = page.locator('.ink-draft-canvas');
  await expect(draft).toHaveAttribute('data-clear-width');
  await page.waitForTimeout(450);
  await expect(page.locator('.pdf-detail-layer canvas')).toHaveCount(0);
  await draft.evaluate((canvas) => canvas.removeAttribute('data-clear-width'));
  const end = start + 170;
  await pointer(page, 'pointermove', 41, 'pen', end, y, { pressure: 0.06 });
  await expect
    .poll(async () => Number(await draft.getAttribute('data-clear-width')))
    .toBeGreaterThan(0);
  expect(Number(await draft.getAttribute('data-clear-width'))).toBeLessThan(90);
  const readInk = (selector: string) =>
    page.locator(selector).evaluate(
      (c: HTMLCanvasElement, pos) => {
        const r = c.getBoundingClientRect();
        const image = c
          .getContext('2d')!
          .getImageData(Math.floor(pos.start - r.x - 10), Math.floor(pos.y - r.y - 12), 205, 105);
        return Array.from({ length: image.width * image.height }, (_, i) => image.data[i * 4 + 3]);
      },
      { start, y },
    );
  const live = await readInk('.ink-draft-canvas');
  expect(live.reduce((sum, alpha) => sum + alpha, 0)).toBeGreaterThan(5000);
  await pointer(page, 'pointermove', 41, 'pen', end + 45, y + 60, { buttons: 0, pressure: 0 });
  await pointer(page, 'pointerup', 41, 'pen', end + 80, y + 85, { pressure: 0 });
  // Raster clipping can round the alpha of edge pixels differently.
  await expect
    .poll(async () => {
      const saved = await readInk('.ink-canvas');
      return saved.reduce((sum, alpha, i) => sum + Math.abs(alpha - live[i]), 0);
    })
    .toBeLessThan(32);
  await expect(page.locator('.pdf-detail-layer canvas')).toBeVisible();
  const paper = (await page.getByTestId('pdf-page').boundingBox())!;
  await expect
    .poll(async () => {
      const p = (await stored(page))[0].pages[0];
      return (p.strokes[0]?.points.at(-1)?.x / p.width) * paper.width + paper.x;
    })
    .toBeCloseTo(end, 0);
});

test('light Pencil strokes stay continuous and ink history updates without repainting the whole page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await demo(page);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('lectern', 1);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      const request = store.getAll();
      request.onsuccess = () => {
        const project = request.result[0];
        project.pages[0].strokes = Array.from({ length: 120 }, (_, i) => ({
          id: `sample-${i}`,
          tool: 'pen',
          color: '#183e3a',
          width: 2.5,
          points: [{ x: 160 + (i % 20) * 12, y: 280 + Math.floor(i / 20) * 12, p: 0.5 }],
        }));
        store.put(project);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await page.getByLabel('表示倍率').selectOption('2');
  const detail = page.locator('.pdf-detail-layer canvas');
  await expect(detail).toBeVisible();
  const ink = page.getByTestId('ink-canvas');
  await expect(ink).toBeVisible();
  await detail.evaluate((canvas) => canvas.setAttribute('data-test-original', ''));
  await page.evaluate(() => {
    HTMLElement.prototype.setPointerCapture = () => {};
    const fill = CanvasRenderingContext2D.prototype.fill;
    CanvasRenderingContext2D.prototype.fill = function (...args: unknown[]) {
      if (this.canvas.classList.contains('ink-canvas'))
        this.canvas.dataset.fillCount = String(Number(this.canvas.dataset.fillCount ?? 0) + 1);
      Reflect.apply(fill, this, args);
    };
    const stage = document.querySelector('[data-testid="stage"]')!;
    const rect = document.querySelector('[data-testid="pdf-page"]')!.getBoundingClientRect();
    for (let i = 0; i <= 36; i++) {
      stage.dispatchEvent(
        new PointerEvent(i === 0 ? 'pointerdown' : 'pointermove', {
          bubbles: true,
          pointerType: 'pen',
          pointerId: 31,
          isPrimary: true,
          buttons: 1,
          clientX: rect.x + rect.width * (0.33 + 0.33 * (i / 36)),
          clientY: rect.y + rect.height * 0.62,
          pressure: i % 2 ? 0.015 : 0.001,
        }),
      );
    }
  });
  const coverage = (selector: string) =>
    page.locator(selector).evaluate((canvas: HTMLCanvasElement) => {
      const paper = document.querySelector('[data-testid="pdf-page"]')!.getBoundingClientRect();
      const box = canvas.getBoundingClientRect();
      const start = Math.round(((paper.x + paper.width * 0.36 - box.x) * canvas.width) / box.width);
      const end = Math.round(((paper.x + paper.width * 0.63 - box.x) * canvas.width) / box.width);
      const y = Math.floor(((paper.y + paper.height * 0.62 - box.y) * canvas.height) / box.height);
      const pixels = canvas.getContext('2d')!.getImageData(start, y - 2, end - start, 5).data;
      let gaps = 0;
      for (let x = 0; x < end - start; x++)
        if ([0, 1, 2, 3, 4].every((dy) => pixels[(dy * (end - start) + x) * 4 + 3] < 40)) gaps++;
      return { gaps, width: end - start };
    });
  await expect.poll(async () => (await coverage('.ink-draft-canvas')).gaps).toBe(0);
  await expect(ink).not.toHaveAttribute('data-fill-count');

  // A system cancellation can end Pencil contact before a pointerup arrives.
  await pointer(page, 'pointercancel', 31, 'pen', 0, 0);
  await expect.poll(async () => (await coverage('.ink-canvas')).gaps).toBe(0);
  await expect(ink).toHaveAttribute('data-fill-count', '1');
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  const undone = await coverage('.ink-canvas');
  expect(undone.gaps).toBe(undone.width);
  await expect(ink).toHaveAttribute('data-fill-count', '1');
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  expect((await coverage('.ink-canvas')).gaps).toBe(0);
  await expect(ink).toHaveAttribute('data-fill-count', '2');
  await expect(detail).toHaveAttribute('data-test-original');
  await expect.poll(async () => (await stored(page))[0].pages[0].strokes.length).toBe(121);
});

test('Safari touch fallback flips pages while zoomed and never double-turns a Pointer gesture', async ({
  page,
}) => {
  await demo(page);
  await page.getByLabel('ページ表示').selectOption('single');
  await page.getByLabel('表示倍率').selectOption('2');
  const r = (await page.getByTestId('stage').boundingBox())!,
    x = r.x + r.width * 0.6,
    y = r.y + r.height * 0.5;
  const start = { identifier: 1, clientX: x, clientY: y },
    end = { ...start, clientX: x - 120 };
  await nativeTouch(page, 'touchstart', [start]);
  await nativeTouch(page, 'touchmove', [end]);
  await nativeTouch(page, 'touchend', [], [end]);
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
  const back = { identifier: 2, clientX: x - 120, clientY: y },
    backEnd = { ...back, clientX: x };
  await nativeTouch(page, 'touchstart', [back]);
  await nativeTouch(page, 'touchmove', [backEnd]);
  await nativeTouch(page, 'touchend', [], [backEnd]);
  await expect(page.getByLabel('ページ番号')).toHaveValue('1');
  await page.evaluate(() => {
    HTMLElement.prototype.setPointerCapture = function () {};
  });
  await pointer(page, 'pointerdown', 20, 'touch', x, y);
  await nativeTouch(page, 'touchstart', [start]);
  await pointer(page, 'pointermove', 20, 'touch', x - 120, y);
  await nativeTouch(page, 'touchmove', [end]);
  await pointer(page, 'pointerup', 20, 'touch', x - 120, y);
  await nativeTouch(page, 'touchend', [], [end]);
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
  await nativeTouch(page, 'touchstart', [start]);
  await nativeTouch(page, 'touchmove', [{ ...start, clientY: y - 130 }]);
  await nativeTouch(page, 'touchend', [], [{ ...start, clientY: y - 130 }]);
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
  const stylus = { ...start, touchType: 'stylus' },
    stylusEnd = { ...end, touchType: 'stylus' };
  await nativeTouch(page, 'touchstart', [stylus]);
  await nativeTouch(page, 'touchmove', [stylusEnd]);
  await nativeTouch(page, 'touchend', [], [stylusEnd]);
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
  await pointer(page, 'pointerdown', 30, 'touch', x, y, { width: 60, height: 50 });
  await nativeTouch(page, 'touchstart', [start]);
  await nativeTouch(page, 'touchmove', [end]);
  await pointer(page, 'pointerup', 30, 'touch', x - 120, y, { width: 60, height: 50 });
  await nativeTouch(page, 'touchend', [], [end]);
  await expect(page.getByLabel('ページ番号')).toHaveValue('3');
});

test('iPad-sized layout keeps editing controls and ink palettes in the fullscreen fallback', async ({
  page,
  browserName,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { get: () => false, configurable: true });
    if (!localStorage.getItem('lectern.input'))
      localStorage.setItem(
        'lectern.input',
        JSON.stringify({ presets: ['#183e3a', '#cf4d44', '#345678'] }),
      );
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await demo(page);
  await page.addStyleTag({ content: '.app{padding:24px 14px 20px!important;}' });
  for (const name of ['更新確認', '書き出す', '全画面表示']) {
    const button =
      name === '書き出す'
        ? page.locator('.export-menu>summary')
        : page.getByRole('button', { name, exact: true });
    const r = (await button.boundingBox())!;
    expect(r.y).toBeGreaterThanOrEqual(24);
    expect(r.x + r.width).toBeLessThanOrEqual(1010);
    expect(r.y + r.height).toBeLessThan(748);
  }
  const swatch = (tool: string, slot: number) =>
    page.getByRole('button', { name: `${tool}のカラープリセット${slot}`, exact: true });
  for (let i = 1; i <= 3; i++) await expect(swatch('ペン', i)).toBeVisible();
  await expect(swatch('ペン', 3)).toHaveCSS('--swatch', '#345678');
  await swatch('ペン', 2).click();
  await expect(page.getByLabel('ペンの色', { exact: true })).toHaveValue('#cf4d44');
  await page.getByLabel('入力設定', { exact: true }).click();
  const changePreset = (label: string, color: string) =>
    page.getByLabel(label, { exact: true }).evaluate((el: HTMLInputElement, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, color);
  await changePreset('ペンのプリセット2の色を変更', '#00aa55');
  await expect(page.getByLabel('ペンの色', { exact: true })).toHaveValue('#00aa55');
  await page.getByRole('button', { name: '全画面表示', exact: true }).click();
  await expect(page.locator('.app')).toHaveClass(/is-fullscreen/);
  await expect(page.getByRole('button', { name: '選択', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'YouTube挿入' })).toBeVisible();
  const documents = page.getByRole('button', { name: '資料メニュー', exact: true });
  await documents.click();
  await expect(page.getByRole('button', { name: '更新確認', exact: true })).toBeVisible();
  await expect(page.locator('.export-menu>summary')).toBeVisible();
  await documents.click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const penWidth = page.getByLabel('ペンの太さ', { exact: true });
  const highlighterWidth = page.getByLabel('蛍光ペンの太さ', { exact: true });
  await penWidth.selectOption('7');
  const highlighter = page.getByRole('button', { name: '蛍光ペン', exact: true });
  await highlighter.click();
  await expect(highlighterWidth).toHaveValue('12.5');
  await highlighterWidth.selectOption('35');
  for (const [i, color] of ['#fff200', '#ff45bf', '#a6ff00'].entries()) {
    await expect(swatch('蛍光ペン', i + 1)).toBeVisible();
    await expect(swatch('蛍光ペン', i + 1)).toHaveCSS('--swatch', color);
  }
  await swatch('蛍光ペン', 2).click();
  const paper = (await page.getByTestId('pdf-page').boundingBox())!;
  const draw = async (fraction: number) => {
    const y = paper.y + paper.height * fraction;
    await page.mouse.move(paper.x + paper.width * 0.25, y);
    await page.mouse.down();
    await page.mouse.move(paper.x + paper.width * 0.65, y, { steps: 8 });
    await page.mouse.up();
  };
  await draw(0.4);
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  await expect(penWidth).toHaveValue('7');
  await expect(swatch('ペン', 2)).toHaveAttribute('aria-pressed', 'true');
  await draw(0.6);
  await highlighter.click();
  await expect(highlighterWidth).toHaveValue('35');
  await expect(swatch('蛍光ペン', 2)).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(async () => {
      const strokes = (await stored(page))[0].pages[0].strokes;
      return strokes.map(
        ({ tool, color, width }: { tool: string; color: string; width: number }) => [
          tool,
          color,
          width,
        ],
      );
    })
    .toEqual([
      ['highlighter', '#ff45bf', 35],
      ['pen', '#00aa55', 7],
    ]);
  await page.getByLabel('入力設定', { exact: true }).click();
  await changePreset('蛍光ペンのプリセット2の色を変更', '#ff7a20');
  await expect(swatch('蛍光ペン', 2)).toHaveCSS('--swatch', '#ff7a20');
  await page.getByLabel('入力設定', { exact: true }).click();
  await page.screenshot({ path: `artifacts/ipad-layout-${browserName}.png` });
  await page.reload();
  await expect(penWidth).toHaveValue('7');
  await expect(swatch('ペン', 2)).toHaveCSS('--swatch', '#00aa55');
  await highlighter.click();
  await expect(highlighterWidth).toHaveValue('35');
  await expect(swatch('蛍光ペン', 2)).toHaveCSS('--swatch', '#ff7a20');
});

test('a small Shorts placement plays upright at the saved size and can enlarge on demand', async ({
  page,
}) => {
  await mockYoutube(page);
  await demo(page);
  await page.getByRole('button', { name: 'YouTube挿入' }).click();
  await page
    .getByLabel('YouTube URL')
    .fill('https://www.youtube.com/shorts/M7lc1UVf-VE?si=example');
  await page.getByRole('button', { name: 'このページに追加' }).click();
  await expect(page.getByTestId('video-box')).toBeVisible();
  await expect.poll(async () => (await stored(page))[0].pages[0].videos[0]?.height).toBe(160);
  await page
    .getByRole('button', { name: 'サムネイルを選択', exact: true })
    .click({ position: { x: 3, y: 3 } });
  await page.getByTitle('動画を横長にする', { exact: true }).click();
  await expect.poll(async () => (await stored(page))[0].pages[0].videos[0].width).toBe(160);
  await page.getByTitle('動画を縦長にする', { exact: true }).click();
  for (let i = 0; i < 4; i++) await page.getByTitle('サムネイルを小さく', { exact: true }).click();
  await expect.poll(async () => (await stored(page))[0].pages[0].videos[0].height).toBeCloseTo(64);
  const savedVideo = (await stored(page))[0].pages[0].videos[0];
  const paper = page.getByTestId('pdf-page');
  const regularHeight = (await paper.boundingBox())!.height;
  await page.getByRole('button', { name: '全画面表示', exact: true }).click();
  await expect
    .poll(async () => (await paper.boundingBox())!.height)
    .toBeGreaterThan(regularHeight + 20);
  const before = (await page.getByTestId('video-box').boundingBox())!;
  expect(before.width).toBeLessThan(80);
  expect(before.width / before.height).toBeCloseTo(9 / 16);
  await page.getByRole('button', { name: '動画をページ内で再生' }).click();
  await expect(page.getByTitle('YouTube動画', { exact: true })).toBeVisible();
  const iframe = page.getByTitle('YouTube動画', { exact: true });
  const toolbar = page.locator('.toolbar');
  await expect(page.getByTestId('video-box').locator('.video-handle')).toHaveCount(0);
  const r = (await iframe.boundingBox())!;
  expect(r.width).toBeCloseTo(before.width, 0);
  expect(r.height).toBeCloseTo(before.height, 0);
  expect(r.x).toBeCloseTo(before.x, 0);
  expect(r.y).toBeCloseTo(before.y, 0);
  expect(await iframe.evaluate((el) => el.clientWidth)).toBeGreaterThanOrEqual(200);
  await iframe.evaluate((el) => el.setAttribute('data-instance', 'original'));
  await toolbar.getByTitle('動画を拡大', { exact: true }).click();
  const big = (await iframe.boundingBox())!;
  expect(big.width).toBeGreaterThan(160);
  expect(big.width / big.height).toBeCloseTo(9 / 16);
  await toolbar.getByTitle('配置サイズに戻す', { exact: true }).click();
  expect((await iframe.boundingBox())!.width).toBeCloseTo(before.width, 0);
  await expect(iframe).toHaveAttribute('data-instance', 'original');
  await toolbar.getByTitle('動画を閉じる', { exact: true }).click();
  await expect(toolbar.locator('.toolbar-video-actions')).toHaveCount(0);
  expect((await page.getByTestId('video-box').boundingBox())!.width).toBeCloseTo(before.width, 0);
  await page.getByRole('button', { name: '全画面表示を終了', exact: true }).click();
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  const select = page.getByRole('button', { name: 'サムネイルを選択', exact: true });
  const ribbon = page.locator('.video-handle');
  await expect(ribbon).toHaveCount(0);
  // The play area remains a one-tap shortcut after closing, including in Pen mode.
  await page.getByRole('button', { name: '動画をページ内で再生', exact: true }).click();
  await expect(iframe).toBeVisible();
  await expect(ribbon).toHaveCount(0);
  await iframe.dispatchEvent('mock-ended');
  await expect(iframe).toHaveCount(0);
  await expect(ribbon).toHaveCount(0);
  await select.click({ position: { x: 3, y: 3 } });
  await expect(ribbon).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('video-box')).toBeVisible();
  expect((await stored(page))[0].pages[0].videos[0]).toEqual(savedVideo);
});

test('collapsed videos retain their placement and play silently until the player responds', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.route('https://www.youtube.com/iframe_api', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.YT = { Player: class {
          constructor(el, options) {
            this.iframe = document.createElement('iframe');
            this.iframe.src = 'about:blank';
            el.replaceWith(this.iframe);
            this.iframe.addEventListener('mock-error', () => options.events.onError({ data: 150 }));
          }
          destroy() { this.iframe.remove(); }
        } };
        window.onYouTubeIframeAPIReady();
      `,
    }),
  );
  await demo(page);
  await page.getByRole('button', { name: 'YouTube挿入' }).click();
  await page.getByLabel('YouTube URL').fill('https://www.youtube.com/shorts/M7lc1UVf-VE');
  await page.getByRole('button', { name: 'このページに追加' }).click();
  const box = page.getByTestId('video-box');
  const select = box.getByRole('button', { name: 'サムネイルを選択', exact: true });
  const play = box.getByRole('button', { name: '動画をページ内で再生' });
  const thumbnail = box.locator('img');
  const fold = box.getByTitle('動画を折りたたむ', { exact: true });
  const unfold = box.getByTitle('折りたたみを解除', { exact: true });
  const savedVideos = async () => (await stored(page))[0]?.pages[0].videos;
  await expect.poll(savedVideos).toHaveLength(1);
  const [original] = await savedVideos();
  await expect(fold).toHaveCount(0);
  await select.click({ position: { x: 4, y: 4 } });
  const unfolded = (await box.boundingBox())!;
  await fold.click();
  await expect(thumbnail).toHaveCount(0);
  await expect(box.getByTitle('動画のサイズ変更')).toBeHidden();
  const folded = (await select.boundingBox())!;
  expect(folded.width).toBeCloseTo(44, 0);
  expect(folded.height).toBeCloseTo(44, 0);
  expect(folded.x).toBeCloseTo(unfolded.x, 0);
  expect(folded.y).toBeCloseTo(unfolded.y, 0);
  await unfold.click();
  await expect(thumbnail).toHaveCount(1);
  expect((await box.boundingBox())!.height).toBeCloseTo(unfolded.height, 0);
  await fold.click();
  await expect.poll(savedVideos).toEqual([{ ...original, collapsed: true }]);

  await page.reload();
  await expect(select).toBeVisible();
  await expect(thumbnail).toHaveCount(0);
  await page.getByRole('button', { name: '全画面表示', exact: true }).click();
  const pageAnchor = () => box.evaluate((el) => [el.style.left, el.style.top]);
  const anchorBeforePlay = await pageAnchor();
  const marker = (await select.boundingBox())!;
  await expect(unfold).toHaveCount(0);
  await play.click();
  const iframe = box.locator('iframe');
  await expect(iframe).toBeVisible();
  await expect(box.getByText('YouTubeに接続中…', { exact: true })).toHaveCount(0);
  const player = (await box.boundingBox())!;
  expect(player.width / player.height).toBeCloseTo(9 / 16);
  expect(player.height).toBeGreaterThan(marker.height);
  expect(await pageAnchor()).toEqual(anchorBeforePlay);
  await iframe.dispatchEvent('mock-error');
  await expect(box.getByRole('alert')).toContainText(
    'この動画は埋め込み再生が許可されていません。',
  );
  await expect(box.getByRole('link', { name: 'YouTubeで開く' })).toHaveAttribute(
    'href',
    'https://www.youtube.com/watch?v=M7lc1UVf-VE',
  );
  await page.locator('.toolbar').getByTitle('動画を閉じる', { exact: true }).click();
  await expect(select).toBeVisible();
  await expect(thumbnail).toHaveCount(0);
  expect((await select.boundingBox())!.width).toBeCloseTo(44, 0);
  await select.click({ position: { x: 4, y: 4 } });
  await expect(unfold).toBeVisible();
});

test('update check handles latest, offline and a saved reload without losing notes', async ({
  page,
}) => {
  await demo(page);
  const manifest = await (await page.request.get('/version.json')).json();
  let mode = 'latest';
  await page.route('**/version.json?*', (route) =>
    mode === 'offline'
      ? route.abort()
      : route.fulfill({
          json: { ...manifest, version: mode === 'latest' ? manifest.version : 'test-new-release' },
        }),
  );
  await page.getByRole('button', { name: '更新確認', exact: true }).click();
  await expect(page.getByRole('heading', { name: '最新版を利用しています' })).toBeVisible();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  mode = 'offline';
  await page.getByRole('button', { name: '更新確認', exact: true }).click();
  await expect(page.getByText(/更新を確認できませんでした/)).toBeVisible();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  const r = (await page.getByTestId('pdf-page').boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.2, r.y + r.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.4, r.y + r.height * 0.5, { steps: 5 });
  await page.mouse.up();
  mode = 'new';
  await page.getByRole('button', { name: '更新確認', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新しいバージョンがあります' })).toBeVisible();
  await page.getByRole('button', { name: '保存して更新', exact: true }).click();
  await expect(page).toHaveURL(/v=test-new-release/);
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  expect((await stored(page))[0].pages[0].strokes).toHaveLength(1);
  await page.getByRole('button', { name: 'ライブラリに戻る', exact: true }).click();
  await expect(page.getByRole('button', { name: '更新確認', exact: true })).toBeVisible();
});
