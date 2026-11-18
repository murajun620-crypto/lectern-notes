import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { clamp } from './model';

type Offset = { x: number; y: number };
type View = { zoom: number; pan: Offset };

/** The compositor follows the fingers; React and canvas resolution settle after release. */
export function usePageViewport({
  paper,
  pageId,
  width,
  height,
  size,
  fit,
  zoom,
  setZoom,
}: {
  paper: RefObject<HTMLDivElement | null>;
  pageId: string;
  width: number;
  height: number;
  size: { w: number; h: number };
  fit: number;
  zoom: number;
  setZoom: (z: number) => void;
}) {
  const [pan, setPan] = useState<Offset>({ x: 0, y: 0 });
  const [settled, setSettled] = useState(0);
  const view = useRef<View>({ zoom, pan: { x: 0, y: 0 } });
  const interacting = useRef(false),
    frame = useRef<number | null>(null),
    idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    previousPage = useRef(pageId);
  const rasterFor = useCallback(
    (z: number) =>
      Math.min(fit * z * Math.min(devicePixelRatio || 1, 2), 4096 / Math.max(width, height)),
    [fit, width, height],
  );
  const [raster, setRaster] = useState({ pageId, scale: rasterFor(zoom) });
  const rasterScale = raster.pageId === pageId ? raster.scale : rasterFor(zoom);
  const limit = useCallback(
    (next: Offset, z = view.current.zoom): Offset => ({
      x: clamp(
        next.x,
        -Math.max(0, (width * fit * z - size.w + 40) / 2),
        Math.max(0, (width * fit * z - size.w + 40) / 2),
      ),
      y: clamp(
        next.y,
        -Math.max(0, (height * fit * z - size.h + 40) / 2),
        Math.max(0, (height * fit * z - size.h + 40) / 2),
      ),
    }),
    [width, height, fit, size],
  );
  const paint = useCallback(() => {
    frame.current = null;
    const current = view.current;
    if (paper.current)
      paper.current.style.transform = `translate3d(${current.pan.x}px, ${current.pan.y}px, 0) scale(${current.zoom})`;
  }, [paper]);
  const begin = useCallback(() => {
    interacting.current = true;
    clearTimeout(idle.current);
  }, []);
  const move = useCallback(
    (z: number, next: Offset) => {
      view.current = { zoom: clamp(z, 1, 5), pan: next };
      if (frame.current === null) frame.current = requestAnimationFrame(paint);
    },
    [paint],
  );
  const commit = useCallback(() => {
    interacting.current = false;
    clearTimeout(idle.current);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    paint();
    const current = view.current;
    setPan({ ...current.pan });
    setZoom(current.zoom);
    setSettled((v) => v + 1);
  }, [paint, setZoom]);
  const commitSoon = useCallback(() => {
    clearTimeout(idle.current);
    idle.current = setTimeout(commit, 120);
  }, [commit]);
  useLayoutEffect(() => {
    const changed = previousPage.current !== pageId;
    if (changed) {
      previousPage.current = pageId;
      interacting.current = false;
      clearTimeout(idle.current);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      view.current = { zoom, pan: { x: 0, y: 0 } };
      setPan({ x: 0, y: 0 });
    } else if (!interacting.current) {
      view.current = { zoom, pan: limit(view.current.pan, zoom) };
      setPan((p) =>
        p.x === view.current.pan.x && p.y === view.current.pan.y ? p : { ...view.current.pan },
      );
    }
    paint();
  }, [pageId, zoom, limit, paint]);
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
  return { view, pan, interacting, rasterScale, limit, begin, move, commit, commitSoon };
}
