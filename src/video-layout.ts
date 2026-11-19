import { clamp } from './model';
import type { Page, Video } from './model';

type Paper = Pick<Page, 'width' | 'height'>;
export type VideoBounds = { left: number; right: number; top: number; bottom: number };

export function videoPlacementBounds(page: Paper): VideoBounds {
  return { left: -page.width, right: page.width * 2, top: -page.height, bottom: page.height * 2 };
}

export function positionVideo(v: Video, page: Paper, x: number, y: number): Video {
  const edges = videoPlacementBounds(page);
  return {
    ...v,
    x: clamp(x, edges.left, edges.right - v.width),
    y: clamp(y, edges.top, edges.bottom - v.height),
  };
}

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
  return positionVideo(
    { ...v, width, height },
    page,
    v.x + (v.width - width) / 2,
    v.y + (v.height - height) / 2,
  );
}

export function resizeVideo(v: Video, page: Paper, factor: number) {
  const edges = videoPlacementBounds(page);
  const max = Math.min(
    page.width / v.width,
    page.height / v.height,
    (edges.right - v.x) / v.width,
    (edges.bottom - v.y) / v.height,
  );
  const min = Math.min(1, 64 / Math.max(v.width, v.height), max);
  const scale = clamp(factor, min, max);
  return { ...v, width: v.width * scale, height: v.height * scale };
}

/** Extra space for controls is opt-in and stays within the PDF when possible. */
export function enlargedVideoRect(
  v: Video,
  page: Paper,
  screenScale: number,
  bounds: VideoBounds = { left: 0, top: 0, right: page.width, bottom: page.height },
) {
  const max = Math.min(
    (bounds.right - bounds.left) / v.width,
    (bounds.bottom - bounds.top) / v.height,
  );
  const desired = Math.max(360 / Math.max(v.width, v.height), 200 / Math.min(v.width, v.height));
  const scale = Math.max(1, Math.min(max, desired / screenScale));
  if (scale === 1) return v;
  const width = v.width * scale,
    height = v.height * scale;
  return {
    x: clamp(v.x + (v.width - width) / 2, bounds.left, Math.max(bounds.left, bounds.right - width)),
    y: clamp(
      v.y + (v.height - height) / 2,
      bounds.top,
      Math.max(bounds.top, bounds.bottom - height),
    ),
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
