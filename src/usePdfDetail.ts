import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { Page } from './model';
import { renderPage } from './pdf';
import { afterViewportFrame, rasterScaleLimit, zoomRasterReserve } from './usePageViewport';
import type { PageView } from './usePageViewport';

type Detail = {
  canvas: HTMLCanvasElement;
  scale: number;
  displayScale: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
};
type Size = { w: number; h: number };

function detailPlan(
  { width, height }: Pick<Page, 'width' | 'height'>,
  fit: number,
  size: Size,
  { zoom, pan }: PageView,
  baseScale: number,
  last: Detail | undefined,
) {
  const displayScale = fit * zoom;
  const pageW = width * displayScale;
  const pageH = height * displayScale;
  const originX = (size.w - pageW) / 2 + pan.x;
  const originY = (size.h - pageH) / 2 + pan.y;
  const visible = {
    left: Math.max(0, originX),
    top: Math.max(0, originY),
    right: Math.min(size.w, originX + pageW),
    bottom: Math.min(size.h, originY + pageH),
  };
  const visibleW = visible.right - visible.left;
  const visibleH = visible.bottom - visible.top;
  if (visibleW <= 0 || visibleH <= 0) return;
  const nativeDensity = Math.min(devicePixelRatio || 1, rasterScaleLimit(visibleW, visibleH));
  const requiredScale = displayScale * nativeDensity;
  if (baseScale >= requiredScale - 1e-6) return;
  const tolerance = 1 / nativeDensity;
  if (
    last?.canvas.isConnected &&
    last.scale >= requiredScale - 1e-6 &&
    // A substantial fractional transform can soften edges even with enough source pixels.
    Math.abs(last.displayScale / displayScale - 1) < 0.12 &&
    originX + last.left * displayScale <= visible.left + tolerance &&
    originY + last.top * displayScale <= visible.top + tolerance &&
    originX + last.right * displayScale >= visible.right - tolerance &&
    originY + last.bottom * displayScale >= visible.bottom - tolerance
  )
    return;

  const margin = 96;
  const expanded = {
    left: Math.max(originX, -margin),
    top: Math.max(originY, -margin),
    right: Math.min(originX + pageW, size.w + margin),
    bottom: Math.min(originY + pageH, size.h + margin),
  };
  const box =
    nativeDensity <=
    rasterScaleLimit(expanded.right - expanded.left, expanded.bottom - expanded.top)
      ? expanded
      : visible;
  const canvasWidth = box.right - box.left;
  const canvasHeight = box.bottom - box.top;
  const density = Math.min(
    nativeDensity * zoomRasterReserve(zoom),
    rasterScaleLimit(canvasWidth, canvasHeight),
  );
  return {
    box,
    canvasWidth,
    canvasHeight,
    density,
    displayScale,
    originX,
    originY,
    scale: displayScale * density,
  };
}

/** Retain finished pixels and prepare a sharper view when a pinch briefly steadies. */
export function usePdfDetail({
  page,
  fit,
  zoom,
  pan,
  size,
  baseScale,
  view,
  interacting,
  isBusy,
  liveBusy,
  showDetail,
}: {
  page: Page;
  fit: number;
  zoom: number;
  pan: PageView['pan'];
  size: Size;
  baseScale: number;
  view: RefObject<PageView>;
  interacting: RefObject<boolean>;
  isBusy: () => boolean;
  liveBusy: () => boolean;
  showDetail: (canvas: HTMLCanvasElement, sample: PageView) => void;
}) {
  const cache = useRef(new Map<string, Detail>());
  const live = useRef<{
    target?: PageView;
    lastMove?: number;
    timer?: ReturnType<typeof setTimeout>;
    request?: AbortController;
  }>({});
  const { id, assetId, sourcePage, width, height, paper } = page;
  const clearLive = useCallback(() => {
    clearTimeout(live.current.timer);
    live.current.request?.abort();
    live.current = {};
  }, []);
  const paint = useCallback(
    async (
      sample: PageView,
      signal: AbortSignal,
      shouldPause: () => boolean,
      canPublish: () => boolean,
    ) => {
      if (!assetId && !paper) return;
      const source = { id, assetId, sourcePage, width, height, paper };
      const plan = detailPlan(source, fit, size, sample, baseScale, cache.current.get(id));
      if (!plan) return;
      const { box, canvasWidth, canvasHeight, density, displayScale, scale, originX, originY } =
        plan;
      const canvas = document.createElement('canvas');
      canvas.style.left = `${box.left}px`;
      canvas.style.top = `${box.top}px`;
      canvas.style.width = `${canvasWidth}px`;
      canvas.style.height = `${canvasHeight}px`;
      let published = false;
      try {
        await renderPage(
          source,
          canvas,
          scale,
          signal,
          {
            width: Math.max(1, Math.round(canvasWidth * density)),
            height: Math.max(1, Math.round(canvasHeight * density)),
            offsetX: (originX - box.left) * density,
            offsetY: (originY - box.top) * density,
          },
          shouldPause,
        );
        const current = view.current;
        if (
          signal.aborted ||
          !canPublish() ||
          current.zoom !== sample.zoom ||
          current.pan.x !== sample.pan.x ||
          current.pan.y !== sample.pan.y
        )
          return;
        showDetail(canvas, sample);
        for (const [key, entry] of cache.current)
          if (!entry.canvas.isConnected) cache.current.delete(key);
        cache.current.set(id, {
          canvas,
          scale,
          displayScale,
          left: (box.left - originX) / displayScale,
          top: (box.top - originY) / displayScale,
          right: (box.right - originX) / displayScale,
          bottom: (box.bottom - originY) / displayScale,
        });
        published = true;
      } catch {
        // Keep the existing pixels on a cancelled or failed render.
      } finally {
        if (!published) canvas.width = canvas.height = 1;
      }
    },
    [id, assetId, sourcePage, width, height, paper, fit, size, baseScale, view, showDetail],
  );

  useEffect(() => {
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const start = () => {
      if (isBusy()) {
        timer = setTimeout(start, 65);
        return;
      }
      void paint({ zoom, pan }, request.signal, isBusy, () => !interacting.current);
    };
    const cancelStart = afterViewportFrame(start);
    return () => {
      cancelStart();
      clearTimeout(timer);
      request.abort();
      clearLive();
    };
  }, [zoom, pan, paint, isBusy, interacting, clearLive]);

  const observeZoom = (target: PageView) => {
    const state = live.current;
    if ((!assetId && !paper) || !interacting.current || target.zoom < zoom * 1.4) {
      if (state.target) clearLive();
      return;
    }
    if (state.target === target) return;
    state.target = target;
    state.lastMove = performance.now();
    const quiet = 38;
    const start = () => {
      state.timer = undefined;
      if (!interacting.current || !state.target) return;
      const remaining = quiet - (performance.now() - (state.lastMove ?? 0));
      if (remaining > 0 || liveBusy()) {
        state.timer = setTimeout(start, Math.max(remaining, 16));
        return;
      }
      const sample = state.target;
      const request = new AbortController();
      state.request = request;
      void paint(
        sample,
        request.signal,
        () =>
          !interacting.current || liveBusy() || performance.now() - (state.lastMove ?? 0) < quiet,
        () => interacting.current,
      ).finally(() => {
        state.request = undefined;
        if (!request.signal.aborted && interacting.current && state.target !== sample)
          state.timer = setTimeout(start, quiet);
      });
    };
    if (!state.request && state.timer === undefined) state.timer = setTimeout(start, quiet);
  };
  return observeZoom;
}
