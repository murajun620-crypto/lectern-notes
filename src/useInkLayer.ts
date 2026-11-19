import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { drawStrokes } from './model';
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
  draft,
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
  draft: Stroke | null;
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
  const eraseFrame = useRef<number | null>(null);
  const erasing = useRef<{ points: Point[]; width: number; painted: number } | null>(null);
  const [eraseRevision, setEraseRevision] = useState(0);
  const actualScale = fit * zoom;
  const ratio = Math.min(devicePixelRatio || 1, rasterScaleLimit(size.w, size.h));
  const { id, width: pageWidth, height: pageHeight, strokes: saved } = page;
  const strokes = working || saved;
  const pageX = (size.w - pageWidth * actualScale) / 2 + pan.x;
  const pageY = (size.h - pageHeight * actualScale) / 2 + pan.y;

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
    if (erasing.current?.painted) setEraseRevision((value) => value + 1);
    erasing.current = null;
  }, []);
  useEffect(
    () => () => {
      if (eraseFrame.current !== null) cancelAnimationFrame(eraseFrame.current);
    },
    [],
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
    rasterGeometry.current = geometry;
    const ctx = clearCanvas(inkCanvas.current!, geometry.width, geometry.height);
    inPage(ctx, geometry, () => drawStrokes(ctx, strokes));
    for (const { page: neighbor, fit: neighborFit, top } of neighbors) {
      if (neighbor.id === id || !neighbor.strokes.length) continue;
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
    const ctx = clearCanvas(canvas, width, height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawStrokes(ctx, saved);
    ctx.resetTransform();
  }, [id, saved, fit, pageWidth, pageHeight]);

  useLayoutEffect(() => {
    const geometry = rasterGeometry.current;
    if (!geometry || interacting.current) return;
    const ctx = clearCanvas(draftCanvas.current!, geometry.width, geometry.height);
    inPage(ctx, geometry, () => {
      if (draft) drawStrokes(ctx, [draft], true);
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
    draft,
    lasso,
    selection,
    interacting,
  ]);

  return { inkCanvas, draftCanvas, inkPreview, previewErasure, finishErasure };
}
