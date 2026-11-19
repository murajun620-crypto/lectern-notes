import { useCallback, useMemo, useRef, useState } from 'react';
import type { Page } from './model';
import {
  buildPageStack,
  pageContentBounds,
  pageFit,
  stackIndexAt,
  stackPageAt,
} from './page-stack';
import type { StackPage } from './page-stack';
import type { PageView } from './usePageViewport';

export function usePageStack(
  pages: Page[] | undefined,
  page: Page,
  size: { w: number; h: number },
  fitWidth: boolean,
  onFocusPage: (id: string) => void,
) {
  const stack = useMemo(
    () => (pages ? buildPageStack(pages, size, fitWidth) : []),
    [pages, size, fitWidth],
  );
  const currentStack = useRef(stack);
  currentStack.current = stack;
  const active = stack.find((item) => item.page.id === page.id);
  const activeId = active?.page.id;
  const activeCenter = active?.center;
  const fit = active?.fit ?? pageFit(page, size, fitWidth);
  const contentBounds = pageContentBounds(page);
  if (active) {
    contentBounds.top = (stack[0].start - active.top) / fit;
    contentBounds.bottom = (stack.at(-1)!.end - active.top) / fit;
  }

  const paperLayer = useRef<HTMLDivElement>(null);
  const videoLayer = useRef<HTMLDivElement>(null);
  const carried = useRef<{ id: string; pan: PageView['pan'] } | null>(null);
  const [range, setRange] = useState<[number, number]>([0, 1]);
  const lastRange = useRef(range);
  const focus = useCallback(
    (target: StackPage, view: PageView) => {
      if (activeCenter === undefined || target.page.id === activeId) return;
      carried.current = {
        id: target.page.id,
        pan: { x: view.pan.x, y: view.pan.y + (target.center - activeCenter) * view.zoom },
      };
      onFocusPage(target.page.id);
    },
    [activeCenter, activeId, onFocusPage],
  );

  const paintStack = useCallback(
    (view: PageView) => {
      if (activeCenter === undefined) return;
      const transform = `translate3d(${view.pan.x}px, ${view.pan.y}px, 0) scale(${view.zoom})`;
      if (paperLayer.current) paperLayer.current.style.transform = transform;
      if (videoLayer.current) videoLayer.current.style.transform = transform;

      const stack = currentStack.current;
      const center = activeCenter - view.pan.y / view.zoom;
      // Include the next page on either side, so dragging can expose it immediately.
      const reach = size.h / (2 * view.zoom);
      const first = Math.max(0, stackIndexAt(stack, center - reach) - 1);
      const last = Math.min(stack.length - 1, stackIndexAt(stack, center + reach) + 1);
      if (first !== lastRange.current[0] || last !== lastRange.current[1]) {
        lastRange.current = [first, last];
        setRange(lastRange.current);
      }
    },
    [activeCenter, size.h],
  );
  const settleStack = useCallback(
    (view: PageView) => {
      if (activeCenter !== undefined)
        focus(stackPageAt(currentStack.current, activeCenter - view.pan.y / view.zoom), view);
    },
    [activeCenter, focus],
  );
  const takePagePan = useCallback((id: string) => {
    const next = carried.current;
    carried.current = null;
    return next?.id === id ? next.pan : undefined;
  }, []);
  const pageAtPointer = (x: number, y: number, view: PageView) => {
    if (!active) return;
    const stackX = (x - size.w / 2 - view.pan.x) / view.zoom;
    const stackY = active.center + (y - size.h / 2 - view.pan.y) / view.zoom;
    const item = stackPageAt(stack, stackY);
    if (
      stackY >= item.top &&
      stackY <= item.top + item.page.height * item.fit &&
      Math.abs(stackX) <= (item.page.width * item.fit) / 2
    )
      return item;
  };
  const nearby = useMemo(() => stack.slice(range[0], range[1] + 1), [stack, range]);
  return {
    active,
    fit,
    contentBounds,
    paperLayer,
    videoLayer,
    focus,
    paintStack,
    settleStack,
    takePagePan,
    pageAtPointer,
    nearby,
  };
}
