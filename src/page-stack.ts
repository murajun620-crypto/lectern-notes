import type { Page } from './model';

type Size = { w: number; h: number };
export function pageFit(page: Page, size: Size, fitWidth: boolean) {
  const widthFit = (size.w - 56) / page.width;
  return Math.max(0.05, fitWidth ? widthFit : Math.min(widthFit, (size.h - 48) / page.height));
}

export function pageContentBounds(page: Page) {
  return page.videos.reduce(
    (bounds, video) => ({
      left: Math.min(bounds.left, video.x),
      right: Math.max(bounds.right, video.x + video.width),
      top: Math.min(bounds.top, video.y),
      bottom: Math.max(bounds.bottom, video.y + video.height),
    }),
    { left: 0, right: page.width, top: 0, bottom: page.height },
  );
}

export type StackPage = {
  page: Page;
  fit: number;
  top: number;
  start: number;
  end: number;
  center: number;
};

export function buildPageStack(pages: Page[], size: Size, fitWidth: boolean) {
  let y = 0;
  return pages.map((page) => {
    const fit = pageFit(page, size, fitWidth);
    const bounds = pageContentBounds(page);
    const top = y - bounds.top * fit;
    const item: StackPage = {
      page,
      fit,
      top,
      start: y,
      end: top + bounds.bottom * fit,
      center: top + (page.height * fit) / 2,
    };
    y = item.end + 18;
    return item;
  });
}

export function stackIndexAt(stack: StackPage[], y: number) {
  let low = 0,
    high = stack.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (stack[middle].end < y) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, stack.length - 1);
}

export function stackPageAt(stack: StackPage[], y: number) {
  const index = stackIndexAt(stack, y);
  const page = stack[index];
  if (index > 0 && y < page.start && y - stack[index - 1].end < page.start - y)
    return stack[index - 1];
  return page;
}
