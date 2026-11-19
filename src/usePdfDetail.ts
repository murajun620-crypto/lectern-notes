import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { Page } from './model';
import { renderPage } from './pdf';
import { rasterScaleLimit } from './usePageViewport';
import type { PageView } from './usePageViewport';

/** Reuse native-resolution pixels as long as they cover the visible part of the page. */
export function usePdfDetail({
  page,
  fit,
  zoom,
  pan,
  size,
  baseScale,
  view,
  isBusy,
  showDetail,
}: {
  page: Page;
  fit: number;
  zoom: number;
  pan: PageView['pan'];
  size: { w: number; h: number };
  baseScale: number;
  view: RefObject<PageView>;
  isBusy: () => boolean;
  showDetail: (canvas: HTMLCanvasElement) => void;
}) {
  const cache = useRef<{
    id: string;
    canvas: HTMLCanvasElement;
    scale: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null>(null);
  const { id, assetId, sourcePage, width, height } = page;
  useEffect(() => {
    if (!assetId) return;
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
    const density = Math.min(devicePixelRatio || 1, rasterScaleLimit(visibleW, visibleH));
    const scale = displayScale * density;
    if (baseScale >= scale - 1e-6) return;

    const last = cache.current;
    const tolerance = 1 / density;
    if (
      last?.id === id &&
      last.canvas.isConnected &&
      last.scale >= scale - 1e-6 &&
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
    // Extra coverage must fit in memory without lowering visible resolution.
    const box =
      density <= rasterScaleLimit(expanded.right - expanded.left, expanded.bottom - expanded.top)
        ? expanded
        : visible;
    const canvasWidth = box.right - box.left;
    const canvasHeight = box.bottom - box.top;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const start = () => {
      if (isBusy()) {
        timer = setTimeout(start, 65);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.style.left = `${box.left}px`;
      canvas.style.top = `${box.top}px`;
      canvas.style.width = `${canvasWidth}px`;
      canvas.style.height = `${canvasHeight}px`;
      let published = false;
      void renderPage(
        { assetId, sourcePage, width, height },
        canvas,
        scale,
        abort.signal,
        {
          width: Math.max(1, Math.round(canvasWidth * density)),
          height: Math.max(1, Math.round(canvasHeight * density)),
          offsetX: (originX - box.left) * density,
          offsetY: (originY - box.top) * density,
        },
        isBusy,
      )
        .then(() => {
          const current = view.current;
          if (
            abort.signal.aborted ||
            current.zoom !== zoom ||
            current.pan.x !== pan.x ||
            current.pan.y !== pan.y
          )
            return;
          cache.current = {
            id,
            canvas,
            scale,
            left: (box.left - originX) / displayScale,
            top: (box.top - originY) / displayScale,
            right: (box.right - originX) / displayScale,
            bottom: (box.bottom - originY) / displayScale,
          };
          showDetail(canvas);
          published = true;
        })
        .catch(() => {
          // Retain the existing detail or the full-page bitmap on a failed render.
        })
        .finally(() => {
          if (!published) canvas.width = canvas.height = 1;
        });
    };
    timer = setTimeout(start, 140);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [
    id,
    assetId,
    sourcePage,
    width,
    height,
    fit,
    zoom,
    pan.x,
    pan.y,
    size.w,
    size.h,
    baseScale,
    view,
    isBusy,
    showDetail,
  ]);
}
