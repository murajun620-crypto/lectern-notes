import { expect, test, type Page as BrowserPage } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
} from 'pdf-lib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { BaseCanvasFactory } from 'pdfjs-dist/types/src/display/canvas_factory';
import JSZip from 'jszip';
import type { Page, Project } from '../src/model';

async function jpegFixture(page: BrowserPage) {
  const payload = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 40;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fd4167';
    ctx.fillRect(0, 0, 96, 40);
    ctx.fillStyle = '#233564';
    for (let x = 0; x < 96; x += 3) ctx.fillRect(x, 0, 1, 40);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  return Buffer.from(payload, 'base64');
}

async function handout(jpeg: Buffer) {
  const source = await PDFDocument.create();
  const image = await source.embedJpg(Uint8Array.from(jpeg));
  const pages: Page[] = [];
  for (const angle of [0, 90, 180, 270]) {
    const page = source.addPage([240, 190]);
    page.setCropBox(24, 32, 160, 104);
    page.setRotation(degrees(angle));
    const unit = angle === 90 ? 2 : 1;
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
    page.drawRectangle({ x: 24, y: 32, width: 160, height: 104, color: rgb(0.8, 0.9, 0.96) });
    page.drawText(`Source ${angle}`, { x: 30, y: 126, size: 5 });
    if (angle === 90) {
      const sourceLink = source.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [30, 125, 66, 132],
        Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com/reading') },
      });
      page.node.addAnnot(source.context.register(sourceLink));
    }
    if (angle === 0) {
      const field = source.getForm().createTextField('course');
      field.setText('FORM 42');
      field.addToPage(page, {
        x: 105,
        y: 92,
        width: 62,
        height: 16,
        backgroundColor: rgb(0, 1, 1),
      });
      // Sub-point black rules disappear when the page is flattened at the old 2x scale.
      for (let n = 0; n < 12; n++)
        page.drawRectangle({ x: 62 + n / 2, y: 90, width: 0.25, height: 12, color: rgb(0, 0, 0) });
      page.drawImage(image, { x: 108, y: 62, width: 32, height: 14 });
    }
    const width = (angle % 180 ? 104 : 160) * unit;
    const height = (angle % 180 ? 160 : 104) * unit;
    const point = (x: number, y: number) => ({ x, y, p: 0.5 });
    pages.push({
      id: `page-${angle}`,
      assetId: 'handout',
      sourcePage: pages.length + 1,
      width,
      height,
      strokes:
        angle === 0
          ? []
          : [
              {
                id: 'ink',
                tool: 'pen',
                color: '#ff0000',
                width: 8,
                points: [point(16, 52), point(80, 52)],
                erasures: [42, 45].map((x) => ({
                  id: `cut-${x}`,
                  width: 12,
                  points: [point(x, 52)],
                })),
              },
              {
                id: 'highlight',
                tool: 'highlighter',
                color: '#ffff00',
                width: 10,
                points: [point(16, 24), point(66, 24)],
              },
              {
                id: 'graphite',
                tool: 'pen',
                penKind: 'pencil',
                color: '#333333',
                width: 10,
                points: [point(16, 78), point(66, 78)],
              },
            ],
      videos:
        angle === 0
          ? []
          : [{ id: 'video', videoId: 'M7lc1UVf-VE', x: width - 18, y: 68, width: 40, height: 26 }],
    });
  }
  const blank: Page = { id: 'blank', width: 99, height: 77, strokes: [], videos: [] };
  const project: Project = {
    id: 'quality',
    name: 'Export fidelity',
    createdAt: 1,
    updatedAt: 1,
    currentPage: 0,
    pages: [pages[1], blank, pages[3], pages[2], pages[0]],
  };
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify({ format: 'lectern', version: 2, project }));
  zip.file('assets/handout.pdf', await source.save());
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('PDF download preserves fine source detail, native JPEGs and aligned ink and links after cropping and rotation', async ({
  page,
}, testInfo) => {
  await page.route('https://i.ytimg.com/**', (route) => route.abort());
  await page.goto('/');
  const jpeg = await jpegFixture(page);
  const zip = await handout(jpeg);
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'バックアップを復元', exact: true }).click();
  await (
    await choosing
  ).setFiles({ name: 'handout.lecture.zip', mimeType: 'application/zip', buffer: zip });
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await page.locator('.export-menu>summary').click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '書き込み入りPDF', exact: true }).click();
  const file = await downloading;
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  const output = testInfo.outputPath('handout.pdf');
  await file.saveAs(output);
  const bytes = await readFile(output);
  const document = await PDFDocument.load(bytes);
  expect(document.getPageCount()).toBe(5);
  const retainedJpeg = document.context
    .enumerateIndirectObjects()
    .some(([, obj]) => obj instanceof PDFRawStream && Buffer.from(obj.contents).equals(jpeg));
  expect(retainedJpeg).toBe(true);

  const parsed = await getDocument({
    data: Uint8Array.from(bytes),
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + sep,
    isEvalSupported: false,
  }).promise;
  try {
    const factory = parsed.canvasFactory as BaseCanvasFactory;
    for (const [index, angle] of [90, null, 270, 180, 0].entries()) {
      const pdfPage = await parsed.getPage(index + 1);
      const text = (await pdfPage.getTextContent()).items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join(' ');
      const natural = pdfPage.getViewport({ scale: 1 });
      if (angle === null) {
        expect([natural.width, natural.height]).toEqual([99, 77]);
        expect(text.trim()).toBe('');
        continue;
      }
      expect(text).toContain(`Source ${angle}`);
      const unit = angle === 90 ? 2 : 1;
      expect([natural.width, natural.height]).toEqual(
        angle % 180 ? [104 * unit, 160 * unit] : [160 * unit, 104 * unit],
      );
      const scale = angle === 0 ? 8 : 2;
      const viewport = pdfPage.getViewport({ scale });
      const surface = factory.create(viewport.width, viewport.height);
      try {
        await pdfPage.render({ viewport, canvasContext: surface.context }).promise;
        const pixel = (x: number, y: number) =>
          [
            ...surface.context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1)
              .data,
          ].slice(0, 3);
        if (angle === 0) {
          // The original interactive field's painted appearance remains on the handout.
          expect(pixel(138, 40)).toEqual([0, 255, 255]);
          expect(text).toContain('FORM 42');
          for (let n = 0; n < 12; n++) {
            expect(pixel(38.125 + n / 2, 39)[0]).toBeLessThan(25);
            expect(pixel(38.375 + n / 2, 39)[0]).toBeGreaterThan(180);
          }
          continue;
        }
        expect(pixel(24, 52)).toEqual([255, 0, 0]);
        const paper = pixel(12, 45);
        // The overlapping cuts must expose the original paper without refilling their overlap.
        expect(pixel(43, 52)).toEqual(paper);
        expect(pixel(68, 52)).toEqual([255, 0, 0]);
        const highlight = pixel(36, 24);
        for (let i = 0; i < 3; i++)
          expect(Math.abs(highlight[i] - (paper[i] * 0.7 + (i < 2 ? 255 : 0) * 0.3))).toBeLessThan(
            3,
          );
        const graphite = Array.from({ length: 30 }, (_, i) => pixel(26 + i / scale, 78)[0]);
        expect(Math.min(...graphite)).toBeLessThan(paper[0] - 40);
        expect(Math.max(...graphite) - Math.min(...graphite)).toBeGreaterThan(10);
        const annotations = await pdfPage.getAnnotations();
        if (angle === 90) {
          const original = annotations.find((a) => a.url === 'https://example.com/reading');
          expect(original).toBeDefined();
          const [x1, y1, x2, y2] = natural.convertToViewportRectangle(original.rect);
          expect([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]).toEqual([
            186, 12, 200, 84,
          ]);
        }
        const links = annotations.filter((a) => a.url?.includes('M7lc1UVf-VE'));
        expect(links).toHaveLength(1);
        const [ax, ay, bx, by] = natural.convertToViewportRectangle(links[0].rect);
        expect([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]).toEqual([
          natural.width - 18,
          68,
          natural.width,
          94,
        ]);
      } finally {
        factory.destroy(surface);
      }
    }
  } finally {
    await parsed.destroy();
  }
});

test('an optional-layer handout exports the displayed layers and keeps new handwriting vector', async ({
  page,
}) => {
  const source = await PDFDocument.create();
  const sheet = source.addPage([160, 100]);
  const font = await source.embedFont(StandardFonts.Helvetica);
  const group = (name: string) =>
    source.context.register(source.context.obj({ Type: 'OCG', Name: PDFString.of(name) }));
  const shown = group('Slide');
  const hidden = group('Hidden answer');
  source.catalog.set(
    PDFName.of('OCProperties'),
    source.context.obj({
      OCGs: [shown, hidden],
      D: { BaseState: 'ON', OFF: [hidden], Order: [shown, hidden] },
    }),
  );
  sheet.node.set(
    PDFName.of('Resources'),
    source.context.obj({ Font: { F1: font.ref }, Properties: { Slide: shown, Answer: hidden } }),
  );
  sheet.node.addContentStream(
    source.context.register(
      source.context.flateStream(
        '/OC /Slide BDC BT /F1 12 Tf 8 70 Td (QUESTION) Tj ET EMC\n/OC /Answer BDC BT /F1 12 Tf 85 70 Td (ANSWER) Tj ET EMC',
      ),
    ),
  );
  await page.goto('/');
  const choose = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'PDFを読み込む', exact: true }).click();
  await (
    await choose
  ).setFiles({
    name: 'layers.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await source.save()),
  });
  const paper = page.getByTestId('pdf-page');
  await expect(paper).toBeVisible();
  await expect(page.getByText('ページを読み込み中…', { exact: true })).toBeHidden();
  const rect = (await paper.boundingBox())!;
  await page.mouse.move(rect.x + rect.width * 0.25, rect.y + rect.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * 0.75, rect.y + rect.height * 0.7, { steps: 5 });
  await page.mouse.up();
  await page.locator('.export-menu>summary').click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '書き込み入りPDF', exact: true }).click();
  const bytes = await readFile((await (await downloaded).path())!);
  const parsed = await getDocument({ data: Uint8Array.from(bytes) }).promise;
  try {
    const pdfPage = await parsed.getPage(1);
    expect((await pdfPage.getTextContent()).items).toHaveLength(0);
    const operations = (await pdfPage.getOperatorList()).fnArray;
    expect(operations).toContain(OPS.paintImageXObject);
    expect(operations).toContain(OPS.constructPath);
    expect(operations).toContain(OPS.fill);
    const viewport = pdfPage.getViewport({ scale: 2 });
    const factory = parsed.canvasFactory as BaseCanvasFactory;
    const surface = factory.create(viewport.width, viewport.height);
    try {
      await pdfPage.render({ viewport, canvasContext: surface.context }).promise;
      const darkPixels = (x: number, y: number, w: number, h: number) => {
        const pixels = surface.context.getImageData(2 * x, 2 * y, 2 * w, 2 * h).data;
        let dark = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 110) dark++;
        return dark;
      };
      expect(darkPixels(4, 15, 74, 25)).toBeGreaterThan(30);
      expect(darkPixels(82, 15, 74, 25)).toBe(0);
      expect(darkPixels(50, 65, 60, 10)).toBeGreaterThan(30);
    } finally {
      factory.destroy(surface);
    }
  } finally {
    await parsed.destroy();
  }
});
