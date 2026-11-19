import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { changedStrokeBounds, drawStrokes, strokeBounds, strokeShape } from './model';
import type { Page, Point, Stroke } from './model';
import type { StackPage } from './page-stack';
import { afterViewportFrame, rasterScaleLimit, zoomRasterReserve } from './usePageViewport';
import type { PageView } from './usePageViewport';

type InkGeometry = {
  width: number;
  height: number;
  scale: number;
  x: number;
  y: number;
  pageWidth: number;
  pageHeight: number;
};

function inPage(ctx: CanvasRenderingContext2D, geometry: InkGeometry, draw: () => void) {
  ctx.save();
  const { scale, x, y, pageWidth, pageHeight } = geometry;
  ctx.setTransform(scale, 0, 0, scale, x, y);
  ctx.beginPath();
  ctx.rect(0, 0, pageWidth, pageHeight);
  ctx.clip();
  draw();
  ctx.restore();
}

function clearCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

type InkBounds = ReturnType<typeof strokeBounds>;
function inPixels(
  ctx: CanvasRenderingContext2D,
  { left, top, right, bottom }: InkBounds,
  draw: () => void,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip();
  draw();
  ctx.restore();
}
function pixelBounds(geometry: InkGeometry, bounds: InkBounds): InkBounds {
  const { x, y, scale, width, height, pageWidth, pageHeight } = geometry;
  return {
    left: Math.max(0, Math.floor(x + Math.max(0, bounds.left) * scale) - 1),
    top: Math.max(0, Math.floor(y + Math.max(0, bounds.top) * scale) - 1),
    right: Math.min(width, Math.ceil(x + Math.min(pageWidth, bounds.right) * scale) + 1),
    bottom: Math.min(height, Math.ceil(y + Math.min(pageHeight, bounds.bottom) * scale) + 1),
  };
}

function visibleStrokes(geometry: InkGeometry, strokes: Stroke[]) {
  return strokes.filter((stroke) => {
    const { left, right, top, bottom } = pixelBounds(geometry, strokeBounds(stroke));
    return right > left && bottom > top;
  });
}

function canRefreshNextFrame(strokes: Stroke[], neighbors: StackPage[], pageId: string) {
  let budget = 4096;
  for (const paths of [
    strokes,
    ...neighbors.filter((item) => item.page.id !== pageId).map((item) => item.page.strokes),
  ]) {
    for (const stroke of paths) {
      budget -= 32 + stroke.points.length;
      for (const erasure of stroke.erasures ?? []) budget -= 32 + erasure.points.length;
      if (budget < 0) return false;
    }
  }
  return true;
}

function paintChanges(
  ctx: CanvasRenderingContext2D,
  geometry: InkGeometry,
  previous: Stroke[],
  next: Stroke[],
) {
  if (previous === next) return;
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  if (start === previous.length) {
    if (start < next.length) inPage(ctx, geometry, () => drawStrokes(ctx, next.slice(start)));
    return;
  }

  const damage = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  // Gather only changed paths. A shared suffix can stay in place outside this area.
  for (let i = start; i < Math.max(previous.length, next.length); i++) {
    if (previous[i] === next[i]) continue;
    for (const stroke of [previous[i], next[i]]) {
      if (!stroke) continue;
      const bounds = strokeBounds(stroke);
      damage.left = Math.min(damage.left, bounds.left);
      damage.top = Math.min(damage.top, bounds.top);
      damage.right = Math.max(damage.right, bounds.right);
      damage.bottom = Math.max(damage.bottom, bounds.bottom);
    }
  }
  const { left, top, right, bottom } = pixelBounds(geometry, damage);
  if (right <= left || bottom <= top) return;
  const intersecting = next.filter((stroke) => {
    const bounds = pixelBounds(geometry, strokeBounds(stroke));
    return bounds.right > left && bounds.left < right && bounds.top < bottom && bounds.bottom > top;
  });
  ctx.clearRect(left, top, right - left, bottom - top);
  inPixels(ctx, { left, top, right, bottom }, () =>
    inPage(ctx, geometry, () => drawStrokes(ctx, intersecting)),
  );
}

/** Rasterize the visible ink at screen resolution and keep a page preview for navigation. */
export function useInkLayer({
  page,
  viewport,
  size,
  fit,
  zoom,
  pan,
  settled,
  interacting,
  working,
  lasso,
  neighbors,
  center,
  shouldPausePreview,
}: {
  page: Page;
  viewport: RefObject<HTMLDivElement | null>;
  size: { w: number; h: number };
  fit: number;
  zoom: number;
  pan: { x: number; y: number };
  settled: number;
  interacting: RefObject<boolean>;
  working: Stroke[] | null;
  lasso: Point[];
  neighbors: StackPage[];
  center: number;
  shouldPausePreview: () => boolean;
}) {
  const inkCanvas = useRef<HTMLCanvasElement>(null);
  const draftCanvas = useRef<HTMLCanvasElement>(null);
  const inkPreview = useRef<HTMLCanvasElement>(null);
  const rasterGeometry = useRef<InkGeometry | null>(null);
  const lastRaster = useRef<{
    id: string;
    strokes: Stroke[];
    neighbors: StackPage[];
    center: number;
    zoom: number;
    pan: PageView['pan'];
    fit: number;
    size: typeof size;
  } | null>(null);
  const lastPreview = useRef<{ id: string; strokes: Stroke[]; scale: number } | null>(null);
  const pendingInk = useRef<(() => void) | null>(null);
  const draft = useRef<Stroke | null>(null);
  const draftFrame = useRef<number | null>(null);
  const draftArea = useRef<InkBounds | null>(null);
  const draftPaint = useRef<{
    stroke: Stroke;
    geometry: InkGeometry;
    shape: ReturnType<typeof strokeShape>;
  } | null>(null);
  const lassoVisible = useRef(false);
  const eraseFrame = useRef<number | null>(null);
  const erasing = useRef<{ points: Point[]; width: number; painted: number } | null>(null);
  const [eraseRevision, setEraseRevision] = useState(0);
  const actualScale = fit * zoom;
  const ratio = Math.min(devicePixelRatio || 1, rasterScaleLimit(size.w, size.h));
  const { id, width: pageWidth, height: pageHeight, strokes: saved } = page;
  const strokes = working || saved;
  const pageX = (size.w - pageWidth * actualScale) / 2 + pan.x;
  const pageY = (size.h - pageHeight * actualScale) / 2 + pan.y;
  const previewScale = Math.min(
    fit * (devicePixelRatio || 1) * zoomRasterReserve(1),
    2560 / Math.max(pageWidth, pageHeight),
  );

  const paintInkPreview = (view: PageView) => {
    const stage = viewport.current;
    const canvas = inkCanvas.current;
    if (!canvas || !stage?.hasAttribute('data-ink-preview')) return;
    const paper = lastPreview.current;
    const screen = lastRaster.current;
    const paperReady = paper?.id === id && paper.strokes === saved && paper.scale === previewScale;
    if (screen?.id === id && screen.size === size && saved.length > 0) {
      const magnification = (fit * view.zoom) / (screen.fit * screen.zoom);
      const x = size.w / 2 + view.pan.x - (size.w / 2 + screen.pan.x) * magnification;
      const y = size.h / 2 + view.pan.y - (size.h / 2 + screen.pan.y) * magnification;
      const coversViewport =
        x <= 0.5 &&
        y <= 0.5 &&
        x + size.w * magnification >= size.w - 0.5 &&
        y + size.h * magnification >= size.h - 0.5;
      const screenScale = rasterGeometry.current?.scale ?? 0;
      if (!paperReady || (coversViewport && screenScale > paper.scale)) {
        canvas.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${magnification})`;
        stage.setAttribute('data-ink-preview', 'screen');
        return;
      }
    }
    canvas.style.transform = '';
    stage.setAttribute('data-ink-preview', paperReady ? 'page' : 'stack');
  };

  const flushInk = useCallback(() => pendingInk.current?.(), []);

  const clearDraft = useCallback(() => {
    if (draftFrame.current !== null) cancelAnimationFrame(draftFrame.current);
    draftFrame.current = null;
    draft.current = null;
    draftPaint.current = null;
    const area = draftArea.current;
    if (area) {
      draftCanvas.current
        ?.getContext('2d')
        ?.clearRect(area.left, area.top, area.right - area.left, area.bottom - area.top);
      draftArea.current = null;
    }
  }, []);
  const paintDraft = useCallback(() => {
    draftFrame.current = null;
    flushInk();
    const geometry = rasterGeometry.current;
    const stroke = draft.current;
    const canvas = draftCanvas.current;
    if (!canvas || !stroke || !geometry || interacting.current) return;
    const ctx = canvas.getContext('2d')!;
    const shape = strokeShape(stroke);
    const last = draftPaint.current;
    const sameView = last?.stroke === stroke && last.geometry === geometry;
    const box = sameView ? changedStrokeBounds(last.shape, shape, stroke) : shape.bounds;
    if (!box) return;
    const previous = draftArea.current;
    if (!sameView && previous)
      ctx.clearRect(
        previous.left,
        previous.top,
        previous.right - previous.left,
        previous.bottom - previous.top,
      );
    const bounds = pixelBounds(geometry, shape.bounds);
    draftArea.current = bounds.right > bounds.left && bounds.bottom > bounds.top ? bounds : null;
    draftPaint.current = { stroke, geometry, shape };
    const damage = pixelBounds(geometry, box);
    if (damage.right <= damage.left || damage.bottom <= damage.top) return;
    ctx.clearRect(damage.left, damage.top, damage.right - damage.left, damage.bottom - damage.top);
    inPixels(ctx, damage, () => inPage(ctx, geometry, () => drawStrokes(ctx, [stroke])));
  }, [flushInk, interacting]);
  const previewStroke = (stroke: Stroke) => {
    draft.current = stroke;
    if (draftFrame.current === null) draftFrame.current = requestAnimationFrame(paintDraft);
  };

  const paintErasure = useCallback(() => {
    eraseFrame.current = null;
    const erasure = erasing.current;
    const geometry = rasterGeometry.current;
    const ctx = inkCanvas.current?.getContext('2d');
    if (!erasure || !geometry || !ctx || interacting.current) return;
    const { points, width, painted } = erasure;
    if (painted === points.length) return;
    inPage(ctx, geometry, () => {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      if (points.length === 1) {
        ctx.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const start = Math.max(0, painted - 1);
        ctx.moveTo(points[start].x, points[start].y);
        for (let i = start + 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }
    });
    erasure.painted = points.length;
  }, [interacting]);

  const previewErasure = (points: Point[], width: number) => {
    flushInk();
    if (erasing.current?.points !== points) erasing.current = { points, width, painted: 0 };
    if (eraseFrame.current === null) eraseFrame.current = requestAnimationFrame(paintErasure);
  };
  const finishErasure = useCallback(() => {
    if (eraseFrame.current !== null) cancelAnimationFrame(eraseFrame.current);
    eraseFrame.current = null;
    if (erasing.current?.painted) {
      lastRaster.current = null;
      setEraseRevision((value) => value + 1);
    }
    erasing.current = null;
  }, []);
  useEffect(
    () => () => {
      clearDraft();
      if (eraseFrame.current !== null) cancelAnimationFrame(eraseFrame.current);
    },
    [clearDraft],
  );

  useLayoutEffect(() => {
    if (interacting.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelFrame: (() => void) | undefined;
    const paint = () => {
      cancelFrame?.();
      clearTimeout(timer);
      if (interacting.current) {
        timer = setTimeout(paint, 80);
        return;
      }
      pendingInk.current = null;
      paintScreen();
    };
    const paintScreen = () => {
      const geometry = {
        width: Math.max(1, Math.round(size.w * ratio)),
        height: Math.max(1, Math.round(size.h * ratio)),
        scale: actualScale * ratio,
        x: pageX * ratio,
        y: pageY * ratio,
        pageWidth,
        pageHeight,
      };
      const overlay = draftCanvas.current!;
      if (overlay.width !== geometry.width || overlay.height !== geometry.height) {
        if (overlay.width !== geometry.width) overlay.width = geometry.width;
        if (overlay.height !== geometry.height) overlay.height = geometry.height;
        draftArea.current = null;
        draftPaint.current = null;
      }
      const last = lastRaster.current;
      const old = rasterGeometry.current;
      const otherPages = neighbors.filter((neighbor) => neighbor.page.id !== id);
      const canvas = inkCanvas.current!;
      const sameView =
        last?.id === id &&
        old &&
        old.x === geometry.x &&
        old.y === geometry.y &&
        old.width === geometry.width &&
        old.height === geometry.height &&
        old.scale === geometry.scale &&
        old.pageWidth === pageWidth &&
        old.pageHeight === pageHeight &&
        last.center === center &&
        last.zoom === zoom &&
        last.neighbors.length === otherPages.length &&
        otherPages.every((neighbor, i) => {
          const prev = last.neighbors[i];
          return (
            prev.page === neighbor.page && prev.fit === neighbor.fit && prev.top === neighbor.top
          );
        });
      lastRaster.current = { id, strokes, neighbors: otherPages, center, zoom, pan, fit, size };
      rasterGeometry.current = geometry;
      if (sameView && !erasing.current) {
        paintChanges(canvas.getContext('2d')!, geometry, last.strokes, strokes);
        canvas.style.transform = '';
        viewport.current?.removeAttribute('data-ink-preview');
        return;
      }
      const ctx = clearCanvas(canvas, geometry.width, geometry.height);
      inPage(ctx, geometry, () => drawStrokes(ctx, visibleStrokes(geometry, strokes)));
      for (const { page: neighbor, fit: neighborFit, top } of otherPages) {
        if (!neighbor.strokes.length) continue;
        const scale = neighborFit * zoom * ratio;
        const x = (size.w / 2 + pan.x) * ratio - (neighbor.width * scale) / 2;
        const y = (size.h / 2 + pan.y + (top - center) * zoom) * ratio;
        if (
          x >= geometry.width ||
          x + neighbor.width * scale <= 0 ||
          y >= geometry.height ||
          y + neighbor.height * scale <= 0
        )
          continue;
        const neighborGeometry = {
          ...geometry,
          scale,
          x,
          y,
          pageWidth: neighbor.width,
          pageHeight: neighbor.height,
        };
        inPage(ctx, neighborGeometry, () =>
          drawStrokes(ctx, visibleStrokes(neighborGeometry, neighbor.strokes)),
        );
      }
      if (erasing.current) {
        erasing.current.painted = 0;
        if (eraseFrame.current !== null) cancelAnimationFrame(eraseFrame.current);
        paintErasure();
      }
      canvas.style.transform = '';
      viewport.current?.removeAttribute('data-ink-preview');
    };
    const last = lastRaster.current;
    if (
      viewport.current?.hasAttribute('data-ink-preview') &&
      (last?.id !== id || last.strokes === strokes)
    ) {
      pendingInk.current = paint;
      if (canRefreshNextFrame(strokes, neighbors, id)) cancelFrame = afterViewportFrame(paint);
      else timer = setTimeout(paint, 80);
    } else paint();
    return () => {
      cancelFrame?.();
      clearTimeout(timer);
      if (pendingInk.current === paint) pendingInk.current = null;
    };
  }, [
    id,
    pageWidth,
    pageHeight,
    size.w,
    size.h,
    ratio,
    actualScale,
    fit,
    pageX,
    pageY,
    strokes,
    settled,
    eraseRevision,
    interacting,
    viewport,
    paintErasure,
    neighbors,
    center,
    zoom,
    pan.x,
    pan.y,
  ]);

  const prepareInkPreview = useCallback(() => {
    const canvas = inkPreview.current;
    if (!canvas) return;
    const scale = previewScale;
    const width = saved.length ? Math.max(1, Math.round(pageWidth * scale)) : 1;
    const height = saved.length ? Math.max(1, Math.round(pageHeight * scale)) : 1;
    const geometry = { width, height, scale, x: 0, y: 0, pageWidth, pageHeight };
    const last = lastPreview.current;
    lastPreview.current = { id, strokes: saved, scale };
    if (
      last?.id === id &&
      last.scale === scale &&
      canvas.width === width &&
      canvas.height === height
    )
      paintChanges(canvas.getContext('2d')!, geometry, last.strokes, saved);
    else {
      const ctx = clearCanvas(canvas, width, height);
      inPage(ctx, geometry, () => drawStrokes(ctx, saved));
    }
  }, [id, saved, previewScale, pageWidth, pageHeight]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      if (shouldPausePreview()) timer = setTimeout(refresh, 90);
      else prepareInkPreview();
    };
    timer = setTimeout(refresh, 90);
    return () => clearTimeout(timer);
  }, [prepareInkPreview, shouldPausePreview]);

  useLayoutEffect(() => {
    if (lasso.length) flushInk();
    const geometry = rasterGeometry.current;
    if (!geometry || interacting.current) return;
    if (!lasso.length) {
      if (lassoVisible.current) {
        clearCanvas(draftCanvas.current!, geometry.width, geometry.height);
        lassoVisible.current = false;
      }
      return;
    }
    lassoVisible.current = true;
    const ctx = clearCanvas(draftCanvas.current!, geometry.width, geometry.height);
    inPage(ctx, geometry, () => {
      ctx.strokeStyle = '#367f77';
      ctx.lineWidth = 1.5 / actualScale;
      ctx.setLineDash([5 / actualScale, 4 / actualScale]);
      ctx.beginPath();
      lasso.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
    });
  }, [
    id,
    pageWidth,
    pageHeight,
    size.w,
    size.h,
    ratio,
    actualScale,
    pageX,
    pageY,
    settled,
    lasso,
    interacting,
    flushInk,
  ]);

  return {
    inkCanvas,
    draftCanvas,
    inkPreview,
    paintInkPreview,
    previewStroke,
    clearDraft,
    previewErasure,
    finishErasure,
  };
}
