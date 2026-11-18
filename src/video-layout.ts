import { clamp } from './model';
import type { Page, Video } from './model';

type Paper = Pick<Page, 'width' | 'height'>;

export function initialVideoRect(page: Paper, portrait = false) {
  const [w, h] = portrait ? [90, 160] : [160, 90];
  const scale = Math.min(1, (page.width * 0.45) / w, (page.height * 0.3) / h);
  const width = w * scale,
    height = h * scale;
  return { x: (page.width - width) / 2, y: (page.height - height) / 2, width, height };
}

export function rotateVideo(v: Video, page: Paper) {
  const portrait = v.width >= v.height;
  const long = Math.max(v.width, v.height);
  const w = portrait ? (long * 9) / 16 : long;
  const h = portrait ? long : (long * 9) / 16;
  const scale = Math.min(1, page.width / w, page.height / h);
  const width = w * scale,
    height = h * scale;
  return {
    ...v,
    x: clamp(v.x + (v.width - width) / 2, 0, page.width - width),
    y: clamp(v.y + (v.height - height) / 2, 0, page.height - height),
    width,
    height,
  };
}

export function resizeVideo(v: Video, page: Paper, factor: number) {
  const max = Math.min((page.width - v.x) / v.width, (page.height - v.y) / v.height);
  const min = Math.min(1, 64 / Math.max(v.width, v.height), max);
  const scale = clamp(factor, min, max);
  return { ...v, width: v.width * scale, height: v.height * scale };
}

/** Extra space for controls is opt-in and stays within the PDF when possible. */
export function enlargedVideoRect(v: Video, page: Paper, screenScale: number) {
  const max = Math.min(page.width / v.width, page.height / v.height);
  const desired = Math.max(360 / Math.max(v.width, v.height), 200 / Math.min(v.width, v.height));
  const scale = Math.max(1, Math.min(max, desired / screenScale));
  const width = v.width * scale,
    height = v.height * scale;
  return {
    x: clamp(v.x + (v.width - width) / 2, 0, Math.max(0, page.width - width)),
    y: clamp(v.y + (v.height - height) / 2, 0, Math.max(0, page.height - height)),
    width,
    height,
  };
}

/** Size the iframe viewport for YouTube's controls, then fit the whole player into the frame. */
export function playerViewport(box: Paper, pageScale: number, zoom: number) {
  const width = box.width * pageScale,
    height = box.height * pageScale;
  // Older placements could have arbitrary proportions. Bound the iframe ratio
  // while keeping the entire player visible even inside an unusually narrow box.
  const fittedWidth = Math.min(width, height * 4);
  const fittedHeight = Math.min(height, width * 4);
  const scale = Math.max(zoom, 200 / Math.min(fittedWidth, fittedHeight));
  return {
    left: (width - fittedWidth) / 2,
    top: (height - fittedHeight) / 2,
    width: fittedWidth * scale,
    height: fittedHeight * scale,
    transform: `scale(${1 / scale})`,
    transformOrigin: 'top left',
  };
}
