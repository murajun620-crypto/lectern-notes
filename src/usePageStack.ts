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
import type { PageView, StageLocation } from './usePageViewport';

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
  const byId = useMemo(() => new Map(stack.map((item) => [item.page.id, item])), [stack]);
  const active = byId.get(page.id);
  const activeId = active?.page.id;
  const activeCenter = active?.center;
  const fit = active?.fit ?? pageFit(page, size, fitWidth);
  const captureLocation = useCallback(
    (view: PageView): StageLocation => {
      const y = -view.pan.y / view.zoom;
      // During momentum the centered sheet can already differ from the focused sheet.
      const item = activeCenter === undefined ? undefined : stackPageAt(stack, activeCenter + y);
      const sheet = item?.page ?? page;
      const sheetFit = item?.fit ?? fit;
      const offset = item && activeCenter !== undefined ? item.center - activeCenter : 0;
      return {
        pageId: sheet.id,
        center: {
          x: sheet.width / 2 - view.pan.x / (sheetFit * view.zoom),
          y: sheet.height / 2 + (y - offset) / sheetFit,
        },
        zoom: view.zoom,
        fitWidth,
      };
    },
    [activeCenter, stack, page, fit, fitWidth],
  );
  const contentBounds = pageContentBounds(page);
  if (active) {
    contentBounds.top = (stack[0].start - active.top) / fit;
    contentBounds.bottom = (stack.at(-1)!.end - active.top) / fit;
  }

  const paperLayer = useRef<HTMLDivElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const videoLayer = useRef<HTMLDivElement>(null);
  const carried = useRef<{ id: string; pan: PageView['pan'] } | null>(null);
  const [range, setRange] = useState<[number, number]>([0, 1]);
  const lastRange = useRef(range);
  const pagePosition = useCallback(
    (id: string) => {
      const item = byId.get(id);
      if (item && activeCenter !== undefined)
        return { fit: item.fit, offset: item.center - activeCenter };
    },
    [byId, activeCenter],
  );
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
      if (textLayer.current) textLayer.current.style.transform = transform;
      if (videoLayer.current) videoLayer.current.style.transform = transform;

      const stack = currentStack.current;
      const center = activeCenter - view.pan.y / view.zoom;
      const reach = size.h / (2 * view.zoom);
      const visibleFirst = stackIndexAt(stack, center - reach);
      const visibleLast = stackIndexAt(stack, center + reach);
      // Retain the existing neighbors while they still cover the viewport.
      const [start, end] = lastRange.current;
      if (visibleFirst < start || visibleLast > end || end >= stack.length) {
        const first = Math.max(0, visibleFirst - 1);
        const last = Math.min(stack.length - 1, visibleLast + 1);
        lastRange.current = [first, last];
        setRange(lastRange.current);
      }
    },
    [activeCenter, size.h],
  );
  const settleStack = useCallback(
    (view: PageView) => {
      if (activeCenter === undefined) return;
      const list = currentStack.current;
      const center = activeCenter - view.pan.y / view.zoom;
      const reach = size.h / (2 * view.zoom);
      const first = Math.max(0, stackIndexAt(list, center - reach) - 1);
      const last = Math.min(list.length - 1, stackIndexAt(list, center + reach) + 1);
      if (first !== lastRange.current[0] || last !== lastRange.current[1]) {
        lastRange.current = [first, last];
        setRange(lastRange.current);
      }
      focus(stackPageAt(list, center), view);
    },
    [activeCenter, focus, size.h],
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
    captureLocation,
    contentBounds,
    paperLayer,
    textLayer,
    videoLayer,
    focus,
    paintStack,
    pagePosition,
    settleStack,
    takePagePan,
    pageAtPointer,
    nearby,
  };
}
