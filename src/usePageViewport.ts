import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { clamp } from './model';
import type { VideoBounds } from './video-layout';

type Offset = { x: number; y: number };
export type PageView = { zoom: number; pan: Offset };

const maxPageZoom = 10;
export const pageZoomSteps = [1, 1.25, 1.5, 2, 3, 4, 5, 6, 8, maxPageZoom];
export const clampPageZoom = (zoom: number) => clamp(zoom, 1, maxPageZoom);
export const zoomRasterReserve = (zoom: number) => Math.min(1.35, maxPageZoom / zoom);

// Bound both the texture dimensions and total pixel memory of each canvas.
export function rasterScaleLimit(width: number, height: number) {
  return Math.min(4096 / Math.max(width, height), Math.sqrt(8_000_000 / (width * height)));
}

/** Give the final gesture position a paint opportunity before queuing raster work. */
export function afterViewportFrame(callback: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(callback, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}

/** The compositor follows the fingers; React and canvas resolution settle after release. */
export function usePageViewport({
  paper,
  backdrop,
  detail,
  pageId,
  width,
  height,
  contentBounds,
  size,
  fit,
  zoom,
  setZoom,
  showInkPreview,
  paintOverlays,
  paintStack,
  pagePosition,
  settleStack,
  takePagePan,
}: {
  paper: RefObject<HTMLDivElement | null>;
  backdrop: RefObject<HTMLDivElement | null>;
  detail: RefObject<HTMLDivElement | null>;
  pageId: string;
  width: number;
  height: number;
  contentBounds: VideoBounds;
  size: { w: number; h: number };
  fit: number;
  zoom: number;
  setZoom: (z: number) => void;
  showInkPreview: () => void;
  paintOverlays: (view: PageView) => void;
  paintStack: (view: PageView) => void;
  pagePosition: (id: string) => { fit: number; offset: number } | undefined;
  settleStack: (view: PageView) => void;
  takePagePan: (pageId: string) => Offset | undefined;
}) {
  const [pan, setPan] = useState<Offset>({ x: 0, y: 0 });
  const [settled, setSettled] = useState(0);
  const view = useRef<PageView>({ zoom, pan: { x: 0, y: 0 } });
  const detailViews = useRef<
    Array<{
      canvas: HTMLCanvasElement;
      surface: HTMLDivElement;
      view: PageView;
      pageId: string;
      fit: number;
      w: number;
      h: number;
    }>
  >([]);
  const interacting = useRef(false),
    moved = useRef(false),
    frame = useRef<number | null>(null),
    idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    previousPage = useRef(pageId);
  const fitScale = fit * Math.min(devicePixelRatio || 1, 2);
  const maxScale = rasterScaleLimit(width, height);
  const rasterScale = Math.min(
    maxScale,
    Math.max(
      fitScale,
      Math.min(fitScale * zoomRasterReserve(1), Math.sqrt(5_000_000 / (width * height))),
    ),
  );
  const limit = useCallback(
    (next: Offset, z = view.current.zoom): Offset => ({
      x: clamp(
        next.x,
        Math.min(0, (size.w - 40) / 2 - (contentBounds.right - width / 2) * fit * z),
        Math.max(0, (width / 2 - contentBounds.left) * fit * z - (size.w - 40) / 2),
      ),
      y: clamp(
        next.y,
        Math.min(0, (size.h - 40) / 2 - (contentBounds.bottom - height / 2) * fit * z),
        Math.max(0, (height / 2 - contentBounds.top) * fit * z - (size.h - 40) / 2),
      ),
    }),
    [
      width,
      height,
      fit,
      size,
      contentBounds.left,
      contentBounds.right,
      contentBounds.top,
      contentBounds.bottom,
    ],
  );
  const paint = useCallback(() => {
    const current = view.current;
    const transform = `translate3d(${current.pan.x}px, ${current.pan.y}px, 0) scale(${current.zoom})`;
    if (paper.current) paper.current.style.transform = transform;
    if (backdrop.current) backdrop.current.style.transform = `translate(-50%, -50%) ${transform}`;
    paintStack(current);
    paintOverlays(current);
    for (const previous of detailViews.current) {
      const position =
        previous.pageId === pageId ? { fit, offset: 0 } : pagePosition(previous.pageId);
      if (!position) {
        previous.surface.hidden = true;
        continue;
      }
      const ratio = (position.fit * current.zoom) / (previous.fit * previous.view.zoom);
      const x = size.w / 2 + current.pan.x - (previous.w / 2 + previous.view.pan.x) * ratio;
      const y =
        size.h / 2 +
        current.pan.y +
        position.offset * current.zoom -
        (previous.h / 2 + previous.view.pan.y) * ratio;
      previous.surface.hidden = false;
      previous.surface.style.transform =
        ratio === 1 && x === 0 && y === 0 ? '' : `translate3d(${x}px, ${y}px, 0) scale(${ratio})`;
    }
  }, [backdrop, fit, pageId, paper, paintOverlays, paintStack, pagePosition, size.w, size.h]);
  const releaseDetail = useCallback((item: (typeof detailViews.current)[number]) => {
    item.surface.remove();
    item.canvas.width = item.canvas.height = 1;
  }, []);
  const showDetail = useCallback(
    (canvas: HTMLCanvasElement, sample: PageView) => {
      const layer = detail.current;
      if (!layer) return;
      const keep = detailViews.current.find((item) => item.pageId !== pageId);
      const retained =
        keep && keep.canvas.width * keep.canvas.height + canvas.width * canvas.height <= 12_000_000
          ? [keep]
          : [];
      const surface = document.createElement('div');
      surface.className = 'pdf-detail-surface';
      surface.dataset.page = pageId;
      surface.append(canvas);
      layer.append(surface);
      for (const item of detailViews.current) if (!retained.includes(item)) releaseDetail(item);
      detailViews.current = [
        { canvas, surface, view: sample, pageId, fit, w: size.w, h: size.h },
        ...retained,
      ];
      paint();
    },
    [detail, fit, pageId, paint, releaseDetail, size.w, size.h],
  );
  const clearDetail = useCallback(() => {
    for (const item of detailViews.current) releaseDetail(item);
    detailViews.current = [];
  }, [releaseDetail]);
  const begin = useCallback(() => {
    interacting.current = true;
    clearTimeout(idle.current);
  }, []);
  const move = useCallback(
    (z: number, next: Offset) => {
      const zoom = clampPageZoom(z);
      const current = view.current;
      if (current.zoom === zoom && current.pan.x === next.x && current.pan.y === next.y) return;
      view.current = { zoom, pan: next };
      moved.current = true;
      showInkPreview();
      if (frame.current === null)
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          paint();
        });
    },
    [paint, showInkPreview],
  );
  const commit = useCallback(() => {
    interacting.current = false;
    clearTimeout(idle.current);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    paint();
    const current = view.current;
    setPan((previous) =>
      previous.x === current.pan.x && previous.y === current.pan.y ? previous : current.pan,
    );
    setZoom(current.zoom);
    if (moved.current) {
      moved.current = false;
      setSettled((v) => v + 1);
      settleStack(current);
    }
  }, [paint, setZoom, settleStack]);
  const commitSoon = useCallback(() => {
    clearTimeout(idle.current);
    idle.current = setTimeout(commit, 120);
  }, [commit]);
  useLayoutEffect(() => {
    const changed = previousPage.current !== pageId;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (changed) {
      const carriedPan = takePagePan(pageId);
      if (!carriedPan) clearDetail();
      previousPage.current = pageId;
      interacting.current = false;
      moved.current = false;
      clearTimeout(idle.current);
      const pan = carriedPan ?? { x: 0, y: 0 };
      view.current = { zoom, pan };
      setPan(pan);
    } else if (!interacting.current) {
      view.current = { zoom, pan: limit(view.current.pan, zoom) };
      setPan((p) =>
        p.x === view.current.pan.x && p.y === view.current.pan.y ? p : { ...view.current.pan },
      );
    }
    paint();
  }, [pageId, zoom, limit, paint, clearDetail, takePagePan]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      clearTimeout(idle.current);
      clearDetail();
    },
    [clearDetail],
  );
  return {
    view,
    pan,
    interacting,
    rasterScale,
    settled,
    showDetail,
    limit,
    begin,
    move,
    commit,
    commitSoon,
  };
}
