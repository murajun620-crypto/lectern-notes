import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { drawStrokes, strokeBounds } from './model';
import type { Page, Point, Stroke } from './model';
import type { StackPage } from './page-stack';
import { rasterScaleLimit } from './usePageViewport';

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
function pixelBounds(geometry: InkGeometry, bounds: InkBounds): InkBounds {
  const { x, y, scale, width, height, pageWidth, pageHeight } = geometry;
  return {
    left: Math.max(0, Math.floor(x + Math.max(0, bounds.left) * scale) - 1),
    top: Math.max(0, Math.floor(y + Math.max(0, bounds.top) * scale) - 1),
    right: Math.min(width, Math.ceil(x + Math.min(pageWidth, bounds.right) * scale) + 1),
    bottom: Math.min(height, Math.ceil(y + Math.min(pageHeight, bounds.bottom) * scale) + 1),
  };
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
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip();
  inPage(ctx, geometry, () => drawStrokes(ctx, intersecting));
  ctx.restore();
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
  selection,
  lasso,
  neighbors,
  center,
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
  selection: string[];
  lasso: Point[];
  neighbors: StackPage[];
  center: number;
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
  } | null>(null);
  const lastPreview = useRef<{ id: string; strokes: Stroke[]; scale: number } | null>(null);
  const draft = useRef<Stroke | null>(null);
  const draftFrame = useRef<number | null>(null);
  const draftArea = useRef<InkBounds | null>(null);
  const selectionVisible = useRef(false);
  const eraseFrame = useRef<number | null>(null);
  const erasing = useRef<{ points: Point[]; width: number; painted: number } | null>(null);
  const [eraseRevision, setEraseRevision] = useState(0);
  const actualScale = fit * zoom;
  const ratio = Math.min(devicePixelRatio || 1, rasterScaleLimit(size.w, size.h));
  const { id, width: pageWidth, height: pageHeight, strokes: saved } = page;
  const strokes = working || saved;
  const pageX = (size.w - pageWidth * actualScale) / 2 + pan.x;
  const pageY = (size.h - pageHeight * actualScale) / 2 + pan.y;

  const clearDraft = useCallback(() => {
    if (draftFrame.current !== null) cancelAnimationFrame(draftFrame.current);
    draftFrame.current = null;
    draft.current = null;
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
    const geometry = rasterGeometry.current;
    const stroke = draft.current;
    const canvas = draftCanvas.current;
    if (!canvas || !stroke || !geometry || interacting.current) return;
    const ctx = canvas.getContext('2d')!;
    const previous = draftArea.current;
    if (previous)
      ctx.clearRect(
        previous.left,
        previous.top,
        previous.right - previous.left,
        previous.bottom - previous.top,
      );
    const bounds = pixelBounds(geometry, strokeBounds(stroke, true));
    draftArea.current = bounds.right > bounds.left && bounds.bottom > bounds.top ? bounds : null;
    if (draftArea.current) inPage(ctx, geometry, () => drawStrokes(ctx, [stroke], true));
  }, [interacting]);
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
    // No paint work during pinch/pan. The cached page preview follows the PDF transform.
    if (interacting.current) return;
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
    lastRaster.current = { id, strokes, neighbors: otherPages, center, zoom };
    rasterGeometry.current = geometry;
    if (sameView && !erasing.current) {
      paintChanges(canvas.getContext('2d')!, geometry, last.strokes, strokes);
      viewport.current?.removeAttribute('data-ink-preview');
      return;
    }
    const ctx = clearCanvas(canvas, geometry.width, geometry.height);
    inPage(ctx, geometry, () => drawStrokes(ctx, strokes));
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
      inPage(
        ctx,
        { ...geometry, scale, x, y, pageWidth: neighbor.width, pageHeight: neighbor.height },
        () => drawStrokes(ctx, neighbor.strokes),
      );
    }
    if (erasing.current) {
      erasing.current.painted = 0;
      if (eraseFrame.current !== null) cancelAnimationFrame(eraseFrame.current);
      paintErasure();
    }
    viewport.current?.removeAttribute('data-ink-preview');
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

  useLayoutEffect(() => {
    const canvas = inkPreview.current!;
    const scale = Math.min(fit * (devicePixelRatio || 1), 2048 / Math.max(pageWidth, pageHeight));
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
  }, [id, saved, fit, pageWidth, pageHeight]);

  useLayoutEffect(() => {
    const geometry = rasterGeometry.current;
    if (!geometry || interacting.current) return;
    if (!lasso.length && !selection.length) {
      if (selectionVisible.current) {
        clearCanvas(draftCanvas.current!, geometry.width, geometry.height);
        selectionVisible.current = false;
      }
      return;
    }
    selectionVisible.current = true;
    const ctx = clearCanvas(draftCanvas.current!, geometry.width, geometry.height);
    inPage(ctx, geometry, () => {
      ctx.strokeStyle = '#367f77';
      ctx.lineWidth = 1.5 / actualScale;
      ctx.setLineDash([5 / actualScale, 4 / actualScale]);
      if (lasso.length) {
        ctx.beginPath();
        lasso.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.stroke();
      }
      if (!selection.length) return;
      let left = Infinity,
        top = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      for (const stroke of strokes) {
        if (!selection.includes(stroke.id)) continue;
        for (const p of stroke.points) {
          left = Math.min(left, p.x);
          top = Math.min(top, p.y);
          right = Math.max(right, p.x);
          bottom = Math.max(bottom, p.y);
        }
      }
      if (Number.isFinite(left))
        ctx.strokeRect(left - 6, top - 6, right - left + 12, bottom - top + 12);
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
    strokes,
    settled,
    lasso,
    selection,
    interacting,
  ]);

  return {
    inkCanvas,
    draftCanvas,
    inkPreview,
    previewStroke,
    clearDraft,
    previewErasure,
    finishErasure,
  };
}
