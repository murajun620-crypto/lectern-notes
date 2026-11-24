import {
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  type PDFPage,
} from 'pdf-lib';
import type { Page } from './model';

type Sheet = Pick<Page, 'width' | 'height' | 'paper'>;
const lineColor = [149, 173, 188] as const;
const lineWidth = 0.55;

function paperLines(
  { width, height, paper }: Sheet,
  line: (x1: number, y1: number, x2: number, y2: number) => void,
) {
  const spacing = ((paper === 'grid' ? 5 : 7) * 72) / 25.4;
  for (let y = spacing; y < height - lineWidth / 2; y += spacing) line(0, y, width, y);
  if (paper === 'grid') {
    for (let x = spacing; x < width - lineWidth / 2; x += spacing) line(x, 0, x, height);
  }
}

export function drawPaperPattern(ctx: CanvasRenderingContext2D, sheet: Sheet) {
  ctx.strokeStyle = `rgb(${lineColor.join(',')})`;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  paperLines(sheet, (x1, y1, x2, y2) => {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  });
  ctx.stroke();
}

export function drawPdfPaperPattern(out: PDFPage, sheet: Sheet) {
  const [r, g, b] = lineColor;
  out.pushOperators(
    pushGraphicsState(),
    setStrokingRgbColor(r / 255, g / 255, b / 255),
    setLineWidth(lineWidth),
  );
  paperLines(sheet, (x1, y1, x2, y2) => {
    out.pushOperators(moveTo(x1, sheet.height - y1), lineTo(x2, sheet.height - y2));
  });
  out.pushOperators(stroke(), popGraphicsState());
}
