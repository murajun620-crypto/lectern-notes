import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { degrees, PDFDocument, PDFName, PDFNumber, StandardFonts } from 'pdf-lib';

const videoUrl = 'https://youtu.be/M7lc1UVf-VE';

async function openHandout(page: Page, rotation: 0 | 90) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const handout = doc.addPage([520, 700]);
  handout.drawText(videoUrl, { font, x: 100, y: 350, size: 21 });
  handout.setRotation(degrees(rotation));
  if (rotation) handout.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
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
