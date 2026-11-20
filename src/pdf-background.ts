import {
  concatTransformationMatrix,
  drawObject,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFRef,
  PDFStream,
  popGraphicsState,
  pushGraphicsState,
  type PDFPage,
} from 'pdf-lib';
import type { PDFPageProxy } from 'pdfjs-dist';

type Matrix = [number, number, number, number, number, number];
type Rect = [number, number, number, number];
type Source = { pdf: PDFDocument; copier: PDFObjectCopier };
const key = PDFName.of;

export async function readVectorSource(
  data: ArrayBuffer,
  output: PDFDocument,
): Promise<Source | null> {
  try {
    const pdf = await PDFDocument.load(data, { updateMetadata: false });
    // The catalog determines which optional layers are visible. Let the viewer
    // paint its selected layer configuration instead of exposing hidden layers.
    if (
      pdf.catalog.has(key('OCProperties')) ||
      pdf.catalog.lookupMaybe(key('AcroForm'), PDFDict)?.has(key('XFA'))
    )
      return null;
    return { pdf, copier: PDFObjectCopier.for(pdf.context, output.context) };
  } catch {
    // Some repaired or encrypted sources are displayable only through PDF.js.
    return null;
  }
}

function copyBase(out: PDFPage, source: Source, number: number, matrix: Matrix) {
  const original = source.pdf.getPage(number - 1).node;
  const ctx = out.doc.context;
  const resources = original.Resources();
  if (resources) out.node.set(key('Resources'), source.copier.copy(resources).clone(ctx));
  const group = original.get(key('Group'));
  if (group) out.node.set(key('Group'), source.copier.copy(group));
  const contents = original.Contents();
  if (!contents) return;
  // Only copy drawing commands and their resources. Page annotations, actions,
  // parent page trees and document attachments do not belong in these streams.
  const streams =
    contents instanceof PDFArray ? contents.asArray() : [original.get(key('Contents'))!];
  const head = ctx.register(
    ctx.contentStream([pushGraphicsState(), concatTransformationMatrix(...matrix)]),
  );
  const result = ctx.obj([head]);
  for (const stream of streams) {
    const copied = source.copier.copy(stream);
    result.push(copied instanceof PDFRef ? copied : ctx.register(copied));
  }
  result.push(ctx.getPopGraphicsStateContentStream());
  out.node.set(key('Contents'), result);
}

export function addPdfLink(page: PDFPage, rect: Rect, url: string) {
  const ctx = page.doc.context;
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: rect,
    Border: [0, 0, 0],
    A: {
      Type: 'Action',
      S: 'URI',
      // Original URLs can contain literal parentheses or backslashes.
      URI: PDFHexString.of(
        Array.from(new TextEncoder().encode(url), (b) => b.toString(16).padStart(2, '0')).join(''),
      ),
    },
  });
  page.node.addAnnot(ctx.register(annot));
}

function normalizedRect([x1, y1, x2, y2]: number[]): Rect {
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

// Save a widget or markup's normal appearance as a static Form XObject. Its
// own Matrix applies when painted; this matrix fits the transformed BBox into Rect.
function copyAppearance(
  out: PDFPage,
  source: Source,
  id: string,
  rawRect: number[],
  pageMatrix: Matrix,
) {
  const ref = /^(\d+)R(\d*)$/.exec(id);
  if (!ref) return false;
  const annotation = source.pdf.context.lookupMaybe(PDFRef.of(+ref[1], +ref[2]), PDFDict);
  const ap = annotation?.lookupMaybe(key('AP'), PDFDict);
  if (!annotation || !ap) return false;
  const normal = ap.lookup(key('N'));
  const state = annotation.lookupMaybe(key('AS'), PDFName);
  const entry = normal instanceof PDFDict && state ? normal.get(state) : ap.get(key('N'));
  if (!entry) return false;
  const appearance = source.pdf.context.lookup(entry);
  if (!(appearance instanceof PDFStream)) return false;
  const numbers = (array?: PDFArray) =>
    array?.asArray().map((_, i) => array.lookup(i, PDFNumber).asNumber());
  const bbox = numbers(appearance.dict.lookupMaybe(key('BBox'), PDFArray));
  if (bbox?.length !== 4) return false;
  const [a, b, c, d, e, f] = numbers(appearance.dict.lookupMaybe(key('Matrix'), PDFArray)) ?? [
    1, 0, 0, 1, 0, 0,
  ];
  const xs = [],
    ys = [];
  for (const x of [bbox[0], bbox[2]])
    for (const y of [bbox[1], bbox[3]]) {
      xs.push(a * x + c * y + e);
      ys.push(b * x + d * y + f);
    }
  const x = Math.min(...xs),
    y = Math.min(...ys);
  const [l, bt, r, t] = normalizedRect(rawRect);
  const sx = (r - l) / (Math.max(...xs) - x),
    sy = (t - bt) / (Math.max(...ys) - y);
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false;
  const copied = source.copier.copy(entry);
  const refOut = copied instanceof PDFRef ? copied : out.doc.context.register(copied);
  const name = out.node.newXObject('Appearance', refOut);
  out.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...pageMatrix),
    concatTransformationMatrix(sx, 0, 0, sy, l - x * sx, bt - y * sy),
    drawObject(name),
    popGraphicsState(),
  );
  return true;
}

async function drawViewerPixels(out: PDFPage, original: PDFPageProxy, regions: Rect[]) {
  const view = original.getViewport({ scale: 1 });
  const scale = Math.min(
    4,
    4096 / Math.max(view.width, view.height),
    Math.sqrt(8000000 / (view.width * view.height)),
  );
  const canvas = document.createElement('canvas');
  const patch = document.createElement('canvas');
  try {
    canvas.width = Math.ceil(view.width * scale);
    canvas.height = Math.ceil(view.height * scale);
    await original.render({
      canvasContext: canvas.getContext('2d')!,
      viewport: original.getViewport({ scale }),
    }).promise;
    for (const [left, top, right, bottom] of regions) {
      const x = Math.floor(left * scale),
        y = Math.floor(top * scale);
      const w = Math.ceil(right * scale) - x,
        h = Math.ceil(bottom * scale) - y;
      const imageCanvas =
        x === 0 && y === 0 && w === canvas.width && h === canvas.height ? canvas : patch;
      if (imageCanvas === patch) {
        patch.width = w;
        patch.height = h;
        patch.getContext('2d')!.drawImage(canvas, x, y, w, h, 0, 0, w, h);
      }
      const blob = await new Promise<Blob>((ok, fail) =>
        imageCanvas.toBlob((b) =>
          b ? ok(b) : fail(new Error('PDFの表示画像を作成できませんでした。')),
        ),
      );
      const image = await out.doc.embedPng(await blob.arrayBuffer());
      const sx = out.getWidth() / (view.width * scale),
        sy = out.getHeight() / (view.height * scale);
      out.drawImage(image, {
        x: x * sx,
        y: out.getHeight() - (y + h) * sy,
        width: w * sx,
        height: h * sy,
      });
    }
  } finally {
    canvas.width = canvas.height = patch.width = patch.height = 1;
  }
}

export async function drawPdfBackground(
  out: PDFPage,
  original: PDFPageProxy,
  source: Source | null,
) {
  const view = original.getViewport({ scale: 1 });
  const [a, b, c, d, e, f] = view.transform;
  const sx = out.getWidth() / view.width,
    sy = out.getHeight() / view.height;
  // PDF.js handles UserUnit, intersected CropBox/MediaBox and all page rotations.
  // Convert its top-left viewport to the new page's bottom-left coordinate system.
  const matrix: Matrix = [a * sx, -b * sy, c * sx, -d * sy, e * sx, out.getHeight() - f * sy];
  let vector = !!source;
  if (source) {
    try {
      copyBase(out, source, original.pageNumber, matrix);
    } catch {
      vector = false;
    }
  }
  const raster: Rect[] = vector ? [] : [[0, 0, view.width, view.height]];
  for (const annotation of await original.getAnnotations({ intent: 'display' })) {
    if (!Array.isArray(annotation.rect) || annotation.rect.length !== 4) continue;
    const [x1, y1, x2, y2] = normalizedRect(view.convertToViewportRectangle(annotation.rect));
    const rect: Rect = [
      Math.max(0, x1),
      Math.max(0, y1),
      Math.min(view.width, x2),
      Math.min(view.height, y2),
    ];
    if (rect[2] <= rect[0] || rect[3] <= rect[1]) continue;
    if (annotation.subtype === 'Link' && /^https?:\/\//i.test(annotation.url || '')) {
      addPdfLink(
        out,
        [
          rect[0] * sx,
          out.getHeight() - rect[3] * sy,
          rect[2] * sx,
          out.getHeight() - rect[1] * sy,
        ],
        annotation.url,
      );
    }
    if (
      !vector ||
      annotation.subtype === 'Popup' ||
      (annotation.subtype === 'Link' && !annotation.hasAppearance)
    )
      continue;
    try {
      if (
        annotation.hasAppearance &&
        copyAppearance(out, source!, annotation.id, annotation.rect, matrix)
      )
        continue;
    } catch {
      /* A malformed optional appearance can still be rendered by PDF.js. */
    }
    // PDF.js can synthesize annotation graphics when the PDF has no saved AP.
    // Bake just that visible region, keeping the original text and page drawings.
    raster.push(rect);
  }
  if (raster.length) await drawViewerPixels(out, original, raster);
}
