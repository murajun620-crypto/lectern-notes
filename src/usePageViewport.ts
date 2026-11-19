import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { clamp } from './model';
import type { VideoBounds } from './video-layout';

type Offset = { x: number; y: number };
export type PageView = { zoom: number; pan: Offset };

const maxPageZoom = 10;
export const pageZoomSteps = [1, 1.25, 1.5, 2, 3, 4, 5, 6, 8, maxPageZoom];
export const clampPageZoom = (zoom: number) => clamp(zoom, 1, maxPageZoom);

// Bound both the texture dimensions and total pixel memory of each canvas.
export function rasterScaleLimit(width: number, height: number) {
  return Math.min(4096 / Math.max(width, height), Math.sqrt(8_000_000 / (width * height)));
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
  paintStack,
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
  paintStack: (view: PageView) => void;
  settleStack: (view: PageView) => void;
  takePagePan: (pageId: string) => Offset | undefined;
}) {
  const [pan, setPan] = useState<Offset>({ x: 0, y: 0 });
  const [settled, setSettled] = useState(0);
  const view = useRef<PageView>({ zoom, pan: { x: 0, y: 0 } });
  const detailView = useRef<{
    view: PageView;
    pageId: string;
    fit: number;
    w: number;
    h: number;
  } | null>(null);
  const interacting = useRef(false),
    moved = useRef(false),
    frame = useRef<number | null>(null),
    idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    previousPage = useRef(pageId);
  const rasterFor = useCallback(
    (z: number) =>
      Math.min(fit * z * Math.min(devicePixelRatio || 1, 2), rasterScaleLimit(width, height)),
    [fit, width, height],
  );
  const [raster, setRaster] = useState({ pageId, scale: rasterFor(zoom) });
  const rasterScale = raster.pageId === pageId ? raster.scale : rasterFor(zoom);
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
    const layer = detail.current,
      previous = detailView.current;
    if (!layer || !previous) return;
    if (
      previous.pageId !== pageId ||
      previous.fit !== fit ||
      previous.w !== size.w ||
      previous.h !== size.h
    ) {
      layer.style.visibility = 'hidden';
      return;
    }
    const ratio = current.zoom / previous.view.zoom;
    const x = size.w / 2 + current.pan.x - (size.w / 2 + previous.view.pan.x) * ratio;
    const y = size.h / 2 + current.pan.y - (size.h / 2 + previous.view.pan.y) * ratio;
    layer.style.visibility = 'visible';
    layer.style.transform =
      ratio === 1 && x === 0 && y === 0 ? '' : `translate3d(${x}px, ${y}px, 0) scale(${ratio})`;
  }, [backdrop, detail, fit, pageId, paper, paintStack, size.w, size.h]);
  const showDetail = useCallback(
    (canvas: HTMLCanvasElement) => {
      const layer = detail.current;
      if (!layer) return;
      const previous = layer.querySelector('canvas');
      layer.replaceChildren(canvas);
      if (previous) previous.width = previous.height = 1;
      detailView.current = { view: view.current, pageId, fit, w: size.w, h: size.h };
      paint();
    },
    [detail, fit, pageId, paint, size.w, size.h],
  );
  const clearDetail = useCallback(() => {
    detailView.current = null;
    const previous = detail.current?.querySelector('canvas');
    detail.current?.replaceChildren();
    if (previous) previous.width = previous.height = 1;
  }, [detail]);
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
    setPan({ ...current.pan });
    setZoom(current.zoom);
    setSettled((v) => v + 1);
    if (moved.current) {
      moved.current = false;
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
      clearDetail();
      previousPage.current = pageId;
      interacting.current = false;
      moved.current = false;
      clearTimeout(idle.current);
      const pan = takePagePan(pageId) ?? { x: 0, y: 0 };
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
  useEffect(() => {
    const desired = rasterFor(zoom);
    if (raster.pageId !== pageId) {
      setRaster({ pageId, scale: desired });
      return;
    }
    const timer = setTimeout(() => {
      if (interacting.current) return;
      // Reuse the sharper bitmap when zooming out or making tiny adjustments.
      setRaster((current) =>
        current.pageId === pageId && desired <= current.scale * 1.1
          ? current
          : { pageId, scale: desired },
      );
    }, 140);
    return () => clearTimeout(timer);
  }, [pageId, zoom, rasterFor, settled, raster.pageId]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      clearTimeout(idle.current);
    },
    [],
  );
  return {
    view,
    pan,
    interacting,
    rasterScale,
    settled,
    showDetail,
    clearDetail,
    limit,
    begin,
    move,
    commit,
    commitSoon,
  };
}
