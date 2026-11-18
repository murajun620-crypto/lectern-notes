import { clamp } from './model';
import type { Page, Video } from './model';
export function initialVideoRect(page: Pick<Page, 'width' | 'height'>) {
  const width = Math.min(160, page.width * 0.45),
    height = Math.min((width * 9) / 16, page.height * 0.3);
  return { x: (page.width - width) / 2, y: (page.height - height) / 2, width, height };
}
export function playbackRect(
  v: Video,
  paper: { width: number; height: number },
  page: Pick<Page, 'width' | 'height'>,
) {
  const scale = paper.width / page.width;
  // Thumbnail dimensions are independent of YouTube's minimum 200 x 200 player viewport.
  const width = Math.max(240, Math.min(Math.max(v.width * scale, 360), paper.width));
  const height = Math.max(200, Math.min((width * 9) / 16, paper.height));
  return {
    left: clamp(v.x * scale, 0, Math.max(0, paper.width - width)),
    top: clamp(v.y * scale, 0, Math.max(0, paper.height - height)),
    width,
    height,
  };
}
