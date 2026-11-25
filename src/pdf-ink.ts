import { drawObject, type PDFPage } from 'pdf-lib';
import { graphiteGrain, graphitePixelSize, strokeBounds, traceInkPath, type Stroke } from './model';

// Fractional PDF points without scientific notation, which PDF operands do not allow.
const pt = (n: number) => String(Math.round(n * 10000) / 10000);
const xy = (x: number, y: number) => `${pt(x)} ${pt(y)}`;

function inkPath(stroke: Stroke) {
  const path: string[] = [];
  let lastX = 0,
    lastY = 0;
  traceInkPath(
    {
      moveTo(x, y) {
        path.push(`${xy(x, y)} m`);
        lastX = x;
        lastY = y;
      },
      lineTo(x, y) {
        path.push(`${xy(x, y)} l`);
        lastX = x;
        lastY = y;
      },
      quadraticCurveTo(cx, cy, x, y) {
        // PDF paths use cubic Beziers. This conversion exactly matches the Canvas quadratic.
        path.push(
          `${xy((lastX + 2 * cx) / 3, (lastY + 2 * cy) / 3)} ${xy((x + 2 * cx) / 3, (y + 2 * cy) / 3)} ${xy(x, y)} c`,
        );
        lastX = x;
        lastY = y;
      },
      bezierCurveTo(ax, ay, bx, by, x, y) {
        path.push(`${xy(ax, ay)} ${xy(bx, by)} ${xy(x, y)} c`);
        lastX = x;
        lastY = y;
      },
      closePath() {
        path.push('h');
      },
    },
    stroke,
  );
  return path.join('\n');
}

// Intersect inverse capsule clips just as the on-screen eraser does. This also
// covers a stationary tap and overlapping drags without viewer-specific alpha masks.
function clipErasures(content: string[], stroke: Stroke, pageRect: string) {
  const bounds = strokeBounds(stroke);
  const k = 0.55228474983; // cubic control-point offset for a quarter circle
  for (const erase of stroke.erasures ?? []) {
    const r = erase.width / 2;
    for (let i = erase.points.length === 1 ? 0 : 1; i < erase.points.length; i++) {
      const a = erase.points[Math.max(0, i - 1)],
        b = erase.points[i];
      if (
        Math.max(a.x, b.x) + r < bounds.left ||
        Math.min(a.x, b.x) - r > bounds.right ||
        Math.max(a.y, b.y) + r < bounds.top ||
        Math.min(a.y, b.y) - r > bounds.bottom
      )
        continue;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const ux = Math.cos(angle) * r,
        uy = Math.sin(angle) * r;
      // In the local basis, u follows the eraser segment and n points to its side.
      const point = (p: typeof a, u: number, n: number) =>
        xy(p.x + u * ux + n * uy, p.y + u * uy - n * ux);
      content.push(
        pageRect,
        `${point(a, 0, 1)} m ${point(b, 0, 1)} l
        ${point(b, k, 1)} ${point(b, 1, k)} ${point(b, 1, 0)} c
        ${point(b, 1, -k)} ${point(b, k, -1)} ${point(b, 0, -1)} c ${point(a, 0, -1)} l
        ${point(a, -k, -1)} ${point(a, -1, -k)} ${point(a, -1, 0)} c
        ${point(a, -1, k)} ${point(a, -k, 1)} ${point(a, 0, 1)} c h W* n`,
      );
    }
  }
}

// The pencil uses the same repeating alpha tile as the screen, inside a vector outline.
function graphitePattern(page: PDFPage, color: number) {
  const ctx = page.doc.context;
  const image = { Type: 'XObject', Subtype: 'Image', Width: 32, Height: 32, BitsPerComponent: 8 };
  const mask = ctx.register(
    ctx.flateStream(new Uint8Array(graphiteGrain()), { ...image, ColorSpace: 'DeviceGray' }),
  );
  const pixels = new Uint8Array(32 * 32 * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = color >>> 16;
    pixels[i + 1] = color >>> 8;
    pixels[i + 2] = color;
  }
  const tile = ctx.register(
    ctx.flateStream(pixels, { ...image, ColorSpace: 'DeviceRGB', SMask: mask }),
  );
  return ctx.register(
    ctx.flateStream('32 0 0 -32 0 32 cm /Grain Do', {
      Type: 'Pattern',
      PatternType: 1,
      PaintType: 1,
      TilingType: 1,
      BBox: [0, 0, 32, 32],
      XStep: 32,
      YStep: 32,
      Matrix: [graphitePixelSize, 0, 0, -graphitePixelSize, 0, page.getHeight()],
      Resources: { XObject: { Grain: tile } },
    }),
  );
}

export function drawPdfInk(page: PDFPage, strokes: Stroke[]) {
  if (!strokes.length) return;
  const { context } = page.doc;
  const { width, height } = page.getSize();
  const content = [`q 1 0 0 -1 0 ${pt(page.getHeight())} cm`];
  const patterns: Record<string, ReturnType<typeof graphitePattern>> = {};
  const pageRect = `0 0 ${pt(width)} ${pt(height)} re`;
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    content.push('q');
    if (stroke.erasures?.length) clipErasures(content, stroke, pageRect);
    const color = Number.parseInt(stroke.color.slice(1), 16);
    const components = [color >>> 16, (color >>> 8) & 255, color & 255]
      .map((v) => pt(v / 255))
      .join(' ');
    if (stroke.tool === 'highlighter') {
      content.push(
        `/Highlight gs ${components} RG ${pt(stroke.width)} w 1 J 1 j`,
        inkPath(stroke),
        'S',
      );
    } else {
      if (stroke.penKind === 'pencil') {
        const name = `Graphite${color}`;
        patterns[name] ??= graphitePattern(page, color);
        content.push(`/Pattern cs /${name} scn`);
      } else content.push(`${components} rg`);
      content.push(inkPath(stroke), 'f');
    }
    content.push('Q');
  }
  content.push('Q');
  const form = context.register(
    context.flateStream(content.join('\n'), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, width, height],
      Resources: { ExtGState: { Highlight: { Type: 'ExtGState', CA: 0.3 } }, Pattern: patterns },
    }),
  );
  page.pushOperators(drawObject(page.node.newXObject('Handwriting', form)));
}
