import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { getAsset } from './storage';
import { uid } from './model';
import type { Page, Project } from './model';
import { addPdfLink, drawPdfBackground, readVectorSource } from './pdf-background';
import { drawPdfInk } from './pdf-ink';
import { drawPaperPattern, drawPdfPaperPattern } from './paper-pattern';
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const documents = new Map<string, Promise<pdfjs.PDFDocumentProxy>>();
export async function getPdf(id: string) {
  if (!documents.has(id))
    documents.set(
      id,
      getAsset(id)
        .then(
          (data) =>
            pdfjs.getDocument({
              data: data.slice(0),
              cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
              cMapPacked: true,
              standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
              isEvalSupported: false,
            }).promise,
        )
        .catch((e) => {
          documents.delete(id);
          throw e;
        }),
    );
  return documents.get(id)!;
}
export function releasePdfs() {
  for (const promise of documents.values()) void promise.then((d) => d.destroy()).catch(() => {});
  documents.clear();
}
export async function importPdf(file: File) {
  if (file.size > 300 * 1024 * 1024) throw new Error('PDFは300 MB以下にしてください。');
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: data.slice(0), isEvalSupported: false }).promise;
  try {
    if (doc.numPages > 2000) throw new Error('PDFは2000ページ以下にしてください。');
    const id = uid(),
      pages: Page[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i),
        view = page.getViewport({ scale: 1 });
      pages.push({
        id: uid(),
        assetId: id,
        sourcePage: i,
        width: view.width,
        height: view.height,
        strokes: [],
        videos: [],
      });
      page.cleanup();
    }
    return { pages, asset: { id, data } };
  } catch (e) {
    if ((e as Error).name === 'PasswordException')
      throw new Error('パスワード保護を解除したPDFを読み込んでください。');
    throw e;
  } finally {
    await doc.destroy();
  }
}
export async function renderPage(
  page: Pick<Page, 'assetId' | 'sourcePage' | 'width' | 'height' | 'paper'>,
  canvas: HTMLCanvasElement,
  scale: number,
  signal?: AbortSignal,
  region?: { width: number; height: number; offsetX: number; offsetY: number },
  shouldPause?: () => boolean,
) {
  canvas.width = region?.width ?? Math.max(1, Math.round(page.width * scale));
  canvas.height = region?.height ?? Math.max(1, Math.round(page.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (page.assetId) {
    const pdfPage = await (await getPdf(page.assetId)).getPage(page.sourcePage!);
    signal?.throwIfAborted();
    const task = pdfPage.render({
      canvasContext: ctx,
      viewport: pdfPage.getViewport({ scale }),
      transform: region ? [1, 0, 0, 1, region.offsetX, region.offsetY] : undefined,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (shouldPause) {
      task.onContinue = (resume: () => void) => {
        const attempt = () => {
          if (signal?.aborted) return;
          if (shouldPause()) timer = setTimeout(attempt, 65);
          else resume();
        };
        attempt();
      };
    }
    const cancel = () => task.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await task.promise;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  } else if (page.paper) {
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, region?.offsetX ?? 0, region?.offsetY ?? 0);
    drawPaperPattern(ctx, page);
    ctx.restore();
  }
}
export async function exportPdf(project: Project, progress: (s: string) => void) {
  const doc = await PDFDocument.create();
  const sources = new Map<string, Awaited<ReturnType<typeof readVectorSource>>>();
  const lastPage = new Map<string, number>();
  project.pages.forEach((p, i) => {
    if (p.assetId) lastPage.set(p.assetId, i);
  });
  for (let i = 0; i < project.pages.length; i++) {
    const pg = project.pages[i];
    progress(`PDFを書き出し中 ${i + 1} / ${project.pages.length}`);
    const out = doc.addPage([pg.width, pg.height]);
    if (pg.assetId) {
      if (!sources.has(pg.assetId))
        sources.set(pg.assetId, await readVectorSource(await getAsset(pg.assetId), doc));
      const original = await (await getPdf(pg.assetId)).getPage(pg.sourcePage!);
      await drawPdfBackground(out, original, sources.get(pg.assetId)!);
      if (lastPage.get(pg.assetId) === i) sources.delete(pg.assetId);
    } else if (pg.paper) drawPdfPaperPattern(out, pg);
    drawPdfInk(out, pg.strokes);
    // Export a clickable link placeholder for videos; editable geometry lives in the backup.
    if (pg.videos.length) {
      for (const v of pg.videos) {
        const left = Math.max(0, v.x);
        const top = Math.max(0, v.y);
        const right = Math.min(pg.width, v.x + v.width);
        const bottom = Math.min(pg.height, v.y + v.height);
        if (right <= left || bottom <= top) continue;
        const width = right - left,
          height = bottom - top;
        out.drawRectangle({
          x: left,
          y: pg.height - bottom,
          width,
          height,
          color: rgb(0.09, 0.16, 0.15),
          opacity: 0.95,
        });
        const labelSize = Math.min(14, width / 16, height / 2);
        if (labelSize >= 4)
          out.drawText('YouTube / Open video', {
            x: left + labelSize,
            y: pg.height - bottom + (height - labelSize) / 2,
            size: labelSize,
            color: rgb(1, 1, 1),
          });
        addPdfLink(
          out,
          [left, pg.height - bottom, right, pg.height - top],
          `https://www.youtube.com/watch?v=${v.videoId}`,
        );
      }
    }
  }
  return new Blob([new Uint8Array(await doc.save()).buffer], { type: 'application/pdf' });
}
export async function demoFile() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica),
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const green = rgb(0.08, 0.25, 0.22),
    muted = rgb(0.4, 0.47, 0.44),
    orange = rgb(0.82, 0.37, 0.21);
  const width = 595.28,
    height = 841.89;
  for (let n = 0; n < 3; n++) {
    const p = doc.addPage([width, height]);
    p.drawRectangle({ x: 0, y: 0, width, height, color: rgb(0.98, 0.98, 0.96) });
    p.drawText('LECTERN  /  TEACHING HANDOUT', {
      x: 44,
      y: 797,
      size: 10,
      font: bold,
      color: green,
    });
    p.drawText('A4 PORTRAIT  /  GETTING STARTED', { x: 44, y: 767, size: 8, font, color: muted });
    const title = [
      ['A little space', 'for big ideas.'],
      ['Connect', 'the dots.'],
      ['Ready for your', 'next lecture.'],
    ][n];
    title.forEach((text, i) =>
      p.drawText(text, { x: 44, y: 707 - i * 43, size: 36, font: bold, color: green }),
    );
    p.drawText(
      [
        'Your handouts, notes, and videos. Together.',
        'Place a YouTube video anywhere on this page.',
        'Bring your PDF. Make it your own.',
      ][n],
      { x: 44, y: 625, size: 12, font, color: muted },
    );
    p.drawLine({
      start: { x: 44, y: 600 },
      end: { x: 551, y: 600 },
      thickness: 1,
      color: rgb(0.83, 0.87, 0.82),
    });
    if (n === 0) {
      ['01   Write naturally', "02   Show, don't just tell", '03   Keep the room with you'].forEach(
        (text, i) => {
          p.drawText(text, { x: 44, y: 544 - i * 125, size: 20, font: bold, color: green });
          p.drawText(
            [
              'Use your Pencil. Two fingers pan and zoom.',
              'Insert a video and play it inside your handout.',
              'Switch to the laser pointer. Let your ideas lead.',
            ][i],
            { x: 44, y: 516 - i * 125, size: 12, font, color: muted },
          );
          p.drawText(
            [
              'One finger swipes to the next or previous page.',
              'Move and resize it, then lock it in lecture mode.',
              'Your notes save automatically on this device.',
            ][i],
            { x: 44, y: 495 - i * 125, size: 11, font, color: muted },
          );
        },
      );
      p.drawCircle({ x: 477, y: 143, size: 45, borderWidth: 1.5, borderColor: green });
      p.drawCircle({ x: 477, y: 143, size: 26, color: rgb(0.87, 0.92, 0.8) });
      p.drawLine({
        start: { x: 431, y: 97 },
        end: { x: 523, y: 189 },
        thickness: 3,
        color: orange,
      });
      p.drawText('Make room for the next idea.', {
        x: 44,
        y: 139,
        size: 14,
        font: bold,
        color: green,
      });
    } else if (n === 1) {
      p.drawRectangle({ x: 44, y: 285, width: 507, height: 285, color: rgb(0.9, 0.93, 0.89) });
      p.drawText('YOUR VIDEO GOES HERE', { x: 194, y: 423, size: 14, font: bold, color: green });
      p.drawText('Edit: move & resize', { x: 44, y: 230, size: 19, font: bold, color: green });
      p.drawText('Drag the top bar. Resize from the bottom-right corner.', {
        x: 44,
        y: 203,
        size: 11,
        font,
        color: muted,
      });
      p.drawText('Lecture: tap & play', { x: 44, y: 147, size: 19, font: bold, color: green });
      p.drawText('Play, pause, and seek without leaving the PDF page.', {
        x: 44,
        y: 120,
        size: 11,
        font,
        color: muted,
      });
    } else {
      ['Import your A4 handout', 'Add notes and videos', 'Start your lecture'].forEach(
        (text, i) => {
          const y = 514 - i * 148;
          p.drawCircle({ x: 69, y: y + 5, size: 25, color: green });
          p.drawText(String(i + 1), { x: 63, y: y - 3, size: 21, font: bold, color: rgb(1, 1, 1) });
          p.drawText(text, { x: 117, y, size: 20, font: bold, color: green });
          p.drawText(
            [
              'Keep the original page size and proportions.',
              'Everything stays aligned when you zoom.',
              'Swipe through pages. Keep your audience with you.',
            ][i],
            { x: 117, y: y - 27, size: 11, font, color: muted },
          );
        },
      );
    }
    p.drawLine({
      start: { x: 44, y: 56 },
      end: { x: 551, y: 56 },
      thickness: 1,
      color: rgb(0.83, 0.87, 0.82),
    });
    p.drawText('A WORKSPACE FOR TEACHING', { x: 44, y: 35, size: 8, font, color: muted });
    p.drawText('0' + (n + 1) + ' / 03', { x: 515, y: 35, size: 8, font, color: muted });
  }
  return new File([new Uint8Array(await doc.save()).buffer], 'Lectern — はじめの3ページ.pdf', {
    type: 'application/pdf',
  });
}
