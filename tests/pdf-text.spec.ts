import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { degrees, PDFDocument, PDFName, PDFNumber, StandardFonts } from 'pdf-lib';
import { addPdfLink } from '../src/pdf-background';

const videoUrl = 'https://youtu.be/M7lc1UVf-VE';
const indexedPdfText = '[data-testid="pdf-text-layer"][data-pdf-youtube]';
const insertPdfVideo = (page: Page) =>
  page.getByTestId('stage').getByRole('button', { name: 'YouTube動画を挿入', exact: true });

async function openPdf(page: Page, doc: PDFDocument) {
  await page.goto('/');
  const chooseFile = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'PDFを読み込む', exact: true }).click();
  await (
    await chooseFile
  ).setFiles({
    name: 'lecture-url.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await expect(page.getByText('ページを読み込み中…', { exact: true })).toBeHidden();
}

async function openHandout(page: Page, rotation: 0 | 90) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const handout = doc.addPage([520, 700]);
  handout.drawText(videoUrl, { font, x: 100, y: 350, size: 21 });
  handout.setRotation(degrees(rotation));
  if (rotation) handout.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  await openPdf(page, doc);
}

function centerOfTextRun(locator: Locator, value: string) {
  return locator.evaluate((span, value) => {
    const node = span.firstChild!;
    const offset = node.textContent!.indexOf(value);
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + value.length);
    const { x, y, width, height } = range.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  }, value);
}

async function dragToSelect(page: Page, text: Locator, rotation: 0 | 90) {
  const box = (await text.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const start = rotation === 90 ? { x, y: box.y + 0.5 } : { x: box.x + 0.5, y };
  const end =
    rotation === 90 ? { x, y: box.y + box.height - 0.5 } : { x: box.x + box.width - 0.5, y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(videoUrl);
}

function touchDrag(page: Page, x: number, y: number, dy: number) {
  return page.evaluate(
    ({ x, y, dy }) => {
      const target = document.elementFromPoint(x, y)!;
      const start = { identifier: 1, clientX: x, clientY: y, target };
      const end = { ...start, clientY: y + dy };
      const dispatch = (type: string, touches: (typeof start)[], changedTouches = touches) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: touches },
          changedTouches: { value: changedTouches },
        });
        return target.dispatchEvent(event);
      };
      const accepted = dispatch('touchstart', [start]);
      dispatch('touchmove', [end]);
      dispatch('touchend', [], [end]);
      return { accepted, onText: !!target.closest('.pdf-text-layer span') };
    },
    { x, y, dy },
  );
}

for (const { mode, rotation } of [
  { mode: 'continuous', rotation: 0 },
  { mode: 'single', rotation: 90 },
] as const) {
  test(`native PDF text selection copies an embedded URL in ${mode} view at ${rotation}°`, async ({
    page,
  }) => {
    if (mode === 'continuous') await page.setViewportSize({ width: 1024, height: 768 });
    await openHandout(page, rotation);
    await page.getByLabel('ページ表示').selectOption(mode);
    await page.getByLabel('表示倍率').selectOption('1.5');
    const tool = page.getByRole('button', { name: 'PDFテキストを選択', exact: true });
    await tool.click();
    const layer = page.getByTestId('pdf-text-layer');
    await expect(layer).toHaveAttribute('data-main-rotation', String(rotation));
    const text = layer.locator('span').filter({ hasText: videoUrl });
    await expect(text).toBeVisible();
    const sheet = page.getByTestId('pdf-page');
    if (mode === 'continuous') {
      const before = (await sheet.boundingBox())!;
      const line = (await text.boundingBox())!;
      const x = line.x + line.width / 2;
      const y = line.y + line.height / 2;
      expect(await touchDrag(page, x, y, -55)).toEqual({ accepted: true, onText: true });
      expect((await sheet.boundingBox())!.y).toBeCloseTo(before.y);
      expect(await touchDrag(page, x, y + 110, -68)).toEqual({ accepted: true, onText: false });
      await expect.poll(async () => (await sheet.boundingBox())!.y).toBeCloseTo(before.y - 68);
    }
    const paper = (await sheet.boundingBox())!;
    const word = (await text.boundingBox())!;
    const progress =
      rotation === 90 ? (word.y - paper.y) / paper.height : (word.x - paper.x) / paper.width;
    expect(progress).toBeCloseTo(100 / 520, 2);
    await dragToSelect(page, text, rotation);
    await expect(insertPdfVideo(page)).toHaveCount(0);

    // Observe the browser's trusted copy shortcut without modifying the host clipboard.
    await page.evaluate(() =>
      document.addEventListener(
        'copy',
        (event) => {
          if (!event.defaultPrevented) {
            document.body.dataset.copiedPdfText = getSelection()?.toString();
          }
          event.preventDefault();
        },
        { once: true },
      ),
    );
    await page.keyboard.press('ControlOrMeta+c');
    await expect(page.locator('body')).toHaveAttribute('data-copied-pdf-text', videoUrl);
    const copied = (await page.locator('body').getAttribute('data-copied-pdf-text'))!;

    await page.getByRole('button', { name: 'YouTube挿入', exact: true }).click();
    await page.getByLabel('YouTube URL').fill(copied);
    await page.getByRole('button', { name: 'このページに追加', exact: true }).click();
    await expect(page.getByTestId('video-box')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '動画をページ内で再生' })).toBeVisible();
  });
}

test('a printed YouTube URL on the neighboring sheet offers insertion onto that sheet', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([520, 700]).drawText('First page', { font, x: 100, y: 350, size: 21 });
  const prefix = 'Video: ';
  doc.addPage([520, 700]).drawText(prefix + videoUrl, { font, x: 100, y: 620, size: 21 });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'PDFテキストを選択', exact: true }).click();
  const text = page.locator(indexedPdfText).locator('span').filter({ hasText: videoUrl });
  const stage = page.getByTestId('stage');
  const bounds = (await stage.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 200);
  await expect(text).toBeInViewport();
  await expect(page.getByLabel('ページ番号')).toHaveValue('1');

  const beforeUrl = await centerOfTextRun(text, prefix);
  await page.mouse.click(beforeUrl.x, beforeUrl.y);
  const insert = insertPdfVideo(page);
  await expect(insert).toHaveCount(0);
  const url = await centerOfTextRun(text, videoUrl);
  await page.mouse.click(url.x, url.y);
  await expect(insert).toBeVisible();
  await expect(page.getByTestId('video-box')).toHaveCount(0);
  await page.mouse.click(bounds.x + 12, bounds.y + bounds.height / 2);
  await expect(insert).toHaveCount(0);
  await page.getByRole('button', { name: '移動', exact: true }).click();
  await expect(text).toBeInViewport();
  const handUrl = await centerOfTextRun(text, videoUrl);
  const expectHoveredCursor = async (point: { x: number; y: number }, expected: string) => {
    await page.mouse.move(point.x, point.y);
    await expect
      .poll(() =>
        page.evaluate(
          ({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor,
          point,
        ),
      )
      .toBe(expected);
  };
  await expectHoveredCursor(handUrl, 'pointer');
  await expectHoveredCursor(await centerOfTextRun(text, prefix), 'grab');
  await page.mouse.click(handUrl.x, handUrl.y);
  await insert.click();

  await page.getByLabel('ページ表示').selectOption('single');
  await page.getByRole('button', { name: 'ページ 2', exact: true }).click();
  const video = page.getByTestId('video-box');
  await expect(video).toHaveCount(1);
  await expect(video.locator('img')).toHaveAttribute('src', /M7lc1UVf-VE/);
  await page.getByRole('button', { name: 'ページ 1', exact: true }).click();
  await expect(video).toHaveCount(0);
});

async function openRotatedPdfLink(page: Page) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const handout = doc.addPage([520, 700]);
  const label = 'Open lecture clip';
  handout.drawText(label, { font, x: 100, y: 350, size: 21 });
  handout.setRotation(degrees(90));
  const rect: [number, number, number, number] = [
    98,
    345,
    102 + font.widthOfTextAtSize(label, 21),
    373,
  ];
  addPdfLink(handout, rect, videoUrl);
  await openPdf(page, doc);
  await page.getByLabel('ページ表示').selectOption('single');
  const sheet = (await page.getByTestId('pdf-page').boundingBox())!;
  // Rotating the sheet 90° maps PDF y to screen x and PDF x to screen y.
  return {
    x: sheet.x + (sheet.width * (rect[1] + rect[3])) / (2 * 700),
    y: sheet.y + (sheet.height * (rect[0] + rect[2])) / (2 * 520),
  };
}

test.describe('touch input', () => {
  test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } });

  test('a tap on a YouTube hyperlink with a label offers insertion without external navigation', async ({
    page,
  }) => {
    const { x, y } = await openRotatedPdfLink(page);
    await page.getByRole('button', { name: '移動', exact: true }).click();
    await expect(page.locator(indexedPdfText)).toBeAttached();
    const startUrl = page.url();
    await page.touchscreen.tap(x, y);
    const insert = insertPdfVideo(page);
    await expect(insert).toBeVisible();
    await expect(page.getByTestId('video-box')).toHaveCount(0);
    await expect(page).toHaveURL(startUrl);
    expect(page.context().pages()).toHaveLength(1);
    await insert.tap();
    const video = page.getByTestId('video-box');
    await expect(video).toHaveCount(1);
    await expect(video.locator('img')).toHaveAttribute('src', /M7lc1UVf-VE/);
  });

  test('finger taps open a link in pen mode while a Pencil contact still writes', async ({
    page,
  }) => {
    const position = await openRotatedPdfLink(page);
    const pen = page.getByRole('button', { name: 'ペン', exact: true });
    const undo = page.getByRole('button', { name: '元に戻す', exact: true });
    const insert = insertPdfVideo(page);
    await expect(pen).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(indexedPdfText)).toBeAttached();
    await page.touchscreen.tap(position.x, position.y);
    await expect(insert).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(insert).toHaveCount(0);

    const settings = page.getByLabel('入力設定', { exact: true });
    await settings.click();
    await page.getByRole('checkbox', { name: '指でも筆記する', exact: true }).check();
    await settings.click();
    await page.touchscreen.tap(position.x, position.y);
    await expect(insert).toBeVisible();
    await expect(undo).toBeDisabled();
    const video = page.getByTestId('video-box');
    await insert.tap();
    await expect(insert).toHaveCount(0);
    await expect(video.locator('img')).toHaveAttribute('src', /M7lc1UVf-VE/);
    await undo.click();
    await expect(video).toHaveCount(0);
    await expect(undo).toBeDisabled();

    await page.getByTestId('stage').evaluate((stage, { x, y }) => {
      // The browser cannot capture a synthetic pointer ID.
      stage.setPointerCapture = () => {};
      const target = document.elementFromPoint(x, y)!;
      for (const kind of ['pointerdown', 'pointerup', 'click']) {
        target.dispatchEvent(
          new PointerEvent(kind, {
            bubbles: true,
            cancelable: true,
            pointerType: 'pen',
            isPrimary: true,
            pointerId: 7,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: kind === 'pointerdown' ? 1 : 0,
            pressure: kind === 'pointerdown' ? 0.65 : 0,
          }),
        );
      }
    }, position);
    await expect(undo).toBeEnabled();
    await expect(insert).toHaveCount(0);
    await expect(video).toHaveCount(0);
  });
});
