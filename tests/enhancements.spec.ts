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
  points: { identifier: number; clientX: number; clientY: number; touchType?: string }[],
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
      body: `window.YT={Player:class{constructor(el,o){this.iframe=document.createElement('iframe');this.iframe.src='about:blank';el.replaceWith(this.iframe);setTimeout(()=>o.events.onReady(),20);}playVideo(){}getIframe(){return this.iframe;}destroy(){this.iframe.remove();}}};window.onYouTubeIframeAPIReady();`,
    }),
  );
}

test('Pencil writes in hand mode, a resting palm stays blocked, and two-finger tap switches eraser', async ({
  page,
}) => {
  await demo(page);
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
  await pointer(page, 'pointerdown', 4, 'touch', a, b, { width: 60, height: 50 });
  await pointer(page, 'pointermove', 4, 'touch', a - 150, b, { width: 60, height: 50 });
  await pointer(page, 'pointerup', 4, 'touch', a - 150, b, { width: 60, height: 50 });
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

test('Safari touch fallback flips pages while zoomed and never double-turns a Pointer gesture', async ({
  page,
}) => {
  await demo(page);
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
  await expect(page.getByLabel('ページ番号')).toHaveValue('2');
});

test('iPad-sized standalone layout keeps top buttons and three presets visible; fullscreen falls back to lecture', async ({
  page,
  browserName,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { get: () => false, configurable: true });
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await demo(page);
  await page.addStyleTag({ content: '.app{padding:24px 14px 20px!important;}' });
  for (const name of ['更新確認', '書き出す', '講義を始める']) {
    const button =
      name === '書き出す'
        ? page.locator('.export-menu>summary')
        : page.getByRole('button', { name, exact: true });
    const r = (await button.boundingBox())!;
    expect(r.y).toBeGreaterThanOrEqual(24);
    expect(r.x + r.width).toBeLessThanOrEqual(1010);
    expect(r.y + r.height).toBeLessThan(748);
  }
  for (let i = 1; i <= 3; i++)
    await expect(
      page.getByRole('button', { name: 'カラープリセット' + i, exact: true }),
    ).toBeVisible();
  await page.getByRole('button', { name: 'カラープリセット2', exact: true }).click();
  await expect(page.getByLabel('ペンの色', { exact: true })).toHaveValue('#cf4d44');
  await page.getByLabel('入力設定', { exact: true }).click();
  await page.getByLabel('プリセット2の色を変更').evaluate((el: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '#00aa55');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lectern.input')!).presets[1]))
    .toBe('#00aa55');
  await page.getByRole('button', { name: '画面いっぱいの講義表示', exact: true }).click();
  await expect(page.locator('.app')).toHaveClass(/lecture/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  for (let i = 1; i <= 3; i++)
    await expect(
      page.getByRole('button', { name: 'カラープリセット' + i, exact: true }),
    ).toBeVisible();
  await page.screenshot({ path: `artifacts/ipad-layout-${browserName}.png` });
  await page.reload();
  await expect(page.getByRole('button', { name: 'カラープリセット2', exact: true })).toHaveCSS(
    '--swatch',
    '#00aa55',
  );
});

test('tiny YouTube thumbnails expand only for inline playback and restore their saved size', async ({
  page,
}) => {
  await mockYoutube(page);
  await demo(page);
  await page.getByRole('button', { name: 'YouTube挿入' }).click();
  await page.getByLabel('YouTube URL').fill('https://youtu.be/M7lc1UVf-VE');
  await page.getByRole('button', { name: 'このページに追加' }).click();
  await expect(page.getByTestId('video-box')).toBeVisible();
  await expect.poll(async () => (await stored(page))[0].pages[0].videos[0]?.width).toBe(160);
  for (let i = 0; i < 4; i++) await page.getByTitle('サムネイルを小さく', { exact: true }).click();
  await expect.poll(async () => (await stored(page))[0].pages[0].videos[0].width).toBe(64);
  const before = (await page.getByTestId('video-box').boundingBox())!;
  expect(before.width).toBeLessThan(80);
  await page.getByRole('button', { name: '動画をページ内で再生' }).click();
  await expect(page.getByTitle('YouTube動画', { exact: true })).toBeVisible();
  const r = (await page.getByTitle('YouTube動画', { exact: true }).boundingBox())!,
    paper = (await page.getByTestId('pdf-page').boundingBox())!;
  expect(r.width).toBeGreaterThanOrEqual(240);
  expect(r.height).toBeGreaterThanOrEqual(200);
  expect(r.x + r.width).toBeLessThanOrEqual(paper.x + paper.width + 1);
  expect(r.y + r.height).toBeLessThanOrEqual(paper.y + paper.height + 1);
  await page.getByTitle('動画を閉じる', { exact: true }).click();
  expect((await page.getByTestId('video-box').boundingBox())!.width).toBeCloseTo(before.width, 0);
  await page.reload();
  await expect(page.getByTestId('video-box')).toBeVisible();
  expect((await stored(page))[0].pages[0].videos[0].width).toBe(64);
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
