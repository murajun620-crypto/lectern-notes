import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Trash2 } from 'lucide-react';
import {
  clamp,
  drawStrokes,
  drawLaser,
  pointInPolygon,
  pointErased,
  strokeHit,
  translateStroke,
  uid,
} from './model';
import type { Page, Point, Stroke, Tool, Video } from './model';
import { renderPage } from './pdf';
import VideoBox from './VideoBox';
import { effectiveTool, PalmGuard } from './input';
import type { PencilTool } from './input';
import { rasterScaleLimit, usePageViewport } from './usePageViewport';
import { applyErasure } from './eraser';
type Props = {
  page: Page;
  tool: Tool;
  color: string;
  width: number;
  laserWidth: number;
  eraserWidth: number;
  fingerInk: boolean;
  pencilTool: PencilTool;
  palmRejection: boolean;
  twoFingerTap: boolean;
  onToggleEraser: () => void;
  trail: boolean;
  lecture: boolean;
  fitWidth: boolean;
  zoom: number;
  setZoom: (z: number) => void;
  onChange: (page: Page) => void;
  onNavigate: (delta: number) => void;
  onError: (s: string) => void;
};
export default function Stage({
  page,
  tool,
  color,
  width,
  laserWidth,
  eraserWidth,
  fingerInk,
  pencilTool,
  palmRejection,
  twoFingerTap,
  onToggleEraser,
  trail,
  lecture,
  fitWidth,
  zoom,
  setZoom,
  onChange,
  onNavigate,
  onError,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null),
    paper = useRef<HTMLDivElement>(null),
    backdrop = useRef<HTMLDivElement>(null),
    detail = useRef<HTMLDivElement>(null),
    pdfCanvas = useRef<HTMLCanvasElement>(null),
    inkCanvas = useRef<HTMLCanvasElement>(null),
    laserCanvas = useRef<HTMLCanvasElement>(null),
    eraserCursor = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 700 }),
    [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<string[]>([]),
    [lasso, setLasso] = useState<Point[]>([]),
    [draft, setDraft] = useState<Stroke | null>(null),
    [working, setWorking] = useState<Stroke[] | null>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const gesture = useRef<{
    kind: 'draw' | 'erase' | 'lasso' | 'move' | 'pan' | 'laser';
    id: number;
    pointerType: string;
    started: number;
    start: Point;
    client: { x: number; y: number };
    original: Stroke[];
    pan: { x: number; y: number };
    points: Point[];
    stroke?: Stroke;
    selection?: string[];
    result?: Stroke[];
    erasure?: { id: string; width: number };
    erased?: Set<string>;
  } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>()),
    pinch = useRef<{ distance: number; zoom: number; anchor: { x: number; y: number } } | null>(
      null,
    );
  const palm = useRef(new PalmGuard());
  const nativePinch = useRef<{
    ids: [number, number];
    distance: number;
    zoom: number;
    anchor: { x: number; y: number };
    starts: Map<number, { x: number; y: number }>;
    ending: boolean;
  } | null>(null);
  const swipe = useRef<{ id: number; x: number; y: number; lastX: number; lastY: number } | null>(
    null,
  );
  const tap = useRef<{
    ids: Set<number>;
    starts: Map<number, { x: number; y: number }>;
    at: number;
    cancelled: boolean;
  } | null>(null);
  const lasers = useRef<{ x: number; y: number; t: number }[]>([]);
  const inkCache = useRef<{
    strokes: Stroke[];
    w: number;
    h: number;
    canvas: HTMLCanvasElement;
  } | null>(null);
  const fit = Math.max(
    0.05,
    fitWidth
      ? (size.w - 56) / page.width
      : Math.min((size.w - 56) / page.width, (size.h - 48) / page.height),
  );
  const {
    view,
    pan,
    interacting,
    rasterScale,
    settled,
    showDetail,
    clearDetail,
    limit,
    begin: beginView,
    move: moveView,
    commit: commitView,
    commitSoon,
  } = usePageViewport({
    paper,
    backdrop,
    detail,
    pageId: page.id,
    width: page.width,
    height: page.height,
    size,
    fit,
    zoom,
    setZoom,
  });
  const screenScale = () => fit * view.current.zoom;
  const hideEraser = () => {
    if (eraserCursor.current) eraserCursor.current.style.display = 'none';
  };
  const showEraser = (e: { clientX: number; clientY: number; pointerType: string }) => {
    const el = eraserCursor.current!;
    if (
      effectiveTool(tool, pencilTool, e.pointerType, fingerInk) !== 'eraser' ||
      (e.pointerType === 'touch' && !fingerInk) ||
      pinch.current ||
      nativePinch.current
    ) {
      hideEraser();
      return;
    }
    const r = viewport.current!.getBoundingClientRect();
    el.style.display = 'block';
    el.style.width = el.style.height = `${eraserWidth}px`;
    el.style.transform = `translate3d(${e.clientX - r.left - eraserWidth / 2}px, ${e.clientY - r.top - eraserWidth / 2}px, 0)`;
  };
  useEffect(() => {
    hideEraser();
  }, [tool, eraserWidth, page.id]);
  useLayoutEffect(() => {
    const el = viewport.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    setSelection([]);
    setWorking(null);
    setDraft(null);
    gesture.current = null;
    touches.current.clear();
    pinch.current = null;
    nativePinch.current = null;
    lasers.current = [];
    tap.current = null;
    swipe.current = null;
  }, [page.id]);
  useEffect(() => {
    const reset = () => {
      hideEraser();
      commitView();
      palm.current.reset(performance.now());
      gesture.current = null;
      touches.current.clear();
      pinch.current = null;
      nativePinch.current = null;
      tap.current = null;
      swipe.current = null;
      setDraft(null);
      setWorking(null);
      setLasso([]);
    };
    window.addEventListener('blur', reset);
    return () => window.removeEventListener('blur', reset);
  }, [commitView]);
  useEffect(() => {
    setSelection([]);
    setLasso([]);
  }, [tool]);
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    if (pdfCanvas.current?.dataset.page !== page.id) setLoading(true);
    const target = pdfCanvas.current!;
    // Render offscreen to prevent overlapping PDF.js jobs during zoom/page changes.
    const temp = document.createElement('canvas');
    const output = rasterScale;
    void renderPage(page, temp, output, abort.signal)
      .then(() => {
        if (cancelled) return;
        target.width = temp.width;
        target.height = temp.height;
        target.getContext('2d')!.drawImage(temp, 0, 0);
        target.dataset.page = page.id;
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setLoading(false);
          onError(`PDF表示: ${(e as Error).message}`);
        }
      })
      .finally(() => {
        temp.width = temp.height = 1;
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [page.id, page.assetId, page.sourcePage, page.width, page.height, rasterScale, onError]);
  const { id: pageId, assetId, sourcePage, width: pageWidth, height: pageHeight } = page;
  useEffect(() => {
    const deviceScale = devicePixelRatio || 1;
    const displayScale = fit * zoom;
    const pageFitsAtNativeResolution =
      deviceScale <= 2 && displayScale * deviceScale <= rasterScaleLimit(pageWidth, pageHeight);
    if (!assetId || (zoom === 1 && pageFitsAtNativeResolution)) {
      clearDetail();
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      if (interacting.current) return;
      const originX = (size.w - pageWidth * displayScale) / 2 + pan.x;
      const originY = (size.h - pageHeight * displayScale) / 2 + pan.y;
      const left = Math.max(0, originX);
      const top = Math.max(0, originY);
      const visibleWidth = Math.min(size.w, originX + pageWidth * displayScale) - left;
      const visibleHeight = Math.min(size.h, originY + pageHeight * displayScale) - top;
      if (visibleWidth <= 0 || visibleHeight <= 0) return;
      const outputScale = Math.min(deviceScale, rasterScaleLimit(visibleWidth, visibleHeight));
      const canvas = document.createElement('canvas');
      let published = false;
      canvas.style.left = `${left}px`;
      canvas.style.top = `${top}px`;
      canvas.style.width = `${visibleWidth}px`;
      canvas.style.height = `${visibleHeight}px`;
      const region = {
        width: Math.max(1, Math.round(visibleWidth * outputScale)),
        height: Math.max(1, Math.round(visibleHeight * outputScale)),
        offsetX: (originX - left) * outputScale,
        offsetY: (originY - top) * outputScale,
      };
      void renderPage(
        { assetId, sourcePage, width: pageWidth, height: pageHeight },
        canvas,
        displayScale * outputScale,
        abort.signal,
        region,
      )
        .then(() => {
          const current = view.current;
          if (
            !abort.signal.aborted &&
            !interacting.current &&
            current.zoom === zoom &&
            current.pan.x === pan.x &&
            current.pan.y === pan.y
          ) {
            showDetail(canvas);
            published = true;
          }
        })
        // The full-page bitmap stays visible if the device cannot render the detail layer.
        .catch(() => {})
        .finally(() => {
          if (!published) canvas.width = canvas.height = 1;
        });
    }, 140);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [
    pageId,
    assetId,
    sourcePage,
    pageWidth,
    pageHeight,
    fit,
    zoom,
    size.w,
    size.h,
    pan.x,
    pan.y,
    settled,
    interacting,
    view,
    clearDetail,
    showDetail,
  ]);
  useLayoutEffect(() => {
    const canvas = inkCanvas.current!,
      s = rasterScale;
    const w = Math.round(page.width * s),
      h = Math.round(page.height * s);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const strokes = working || page.strokes;
    if (
      !inkCache.current ||
      inkCache.current.strokes !== strokes ||
      inkCache.current.w !== canvas.width ||
      inkCache.current.h !== canvas.height
    ) {
      const base = document.createElement('canvas');
      base.width = canvas.width;
      base.height = canvas.height;
      const baseCtx = base.getContext('2d')!;
      baseCtx.scale(s, s);
      drawStrokes(baseCtx, strokes);
      inkCache.current = { strokes, w: canvas.width, h: canvas.height, canvas: base };
    }
    ctx.drawImage(inkCache.current.canvas, 0, 0);
    ctx.scale(s, s);
    if (draft) drawStrokes(ctx, [draft], true);
    ctx.strokeStyle = '#367f77';
    ctx.lineWidth = 1.5 / screenScale();
    ctx.setLineDash([5 / screenScale(), 4 / screenScale()]);
    if (lasso.length) {
      ctx.beginPath();
      lasso.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
    }
    const selected = (working || page.strokes).filter((s) => selection.includes(s.id));
    if (selected.length) {
      let left = Infinity,
        top = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      for (const stroke of selected)
        for (const p of stroke.points) {
          left = Math.min(left, p.x);
          top = Math.min(top, p.y);
          right = Math.max(right, p.x);
          bottom = Math.max(bottom, p.y);
        }
      ctx.strokeRect(left - 6, top - 6, right - left + 12, bottom - top + 12);
    }
  }, [page, rasterScale, working, draft, lasso, selection, zoom, fit]);
  useEffect(() => {
    let frame: number;
    let wasVisible = false;
    const canvas = laserCanvas.current!;
    const output = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.w * output);
    canvas.height = Math.round(size.h * output);
    const ctx = canvas.getContext('2d')!;
    const draw = () => {
      const now = performance.now();
      lasers.current = lasers.current.filter((p) => now - p.t < (trail ? 700 : 130));
      const points = lasers.current;
      if (!points.length && !wasVisible) {
        frame = requestAnimationFrame(draw);
        return;
      }
      wasVisible = points.length > 0;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(output, output);
      const current = view.current,
        scale = fit * current.zoom;
      ctx.translate(
        (size.w - page.width * scale) / 2 + current.pan.x,
        (size.h - page.height * scale) / 2 + current.pan.y,
      );
      ctx.scale(scale, scale);
      drawLaser(ctx, points, scale, now, trail, laserWidth);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [page.width, page.height, fit, size, trail, laserWidth, view]);
  const point = (e: {
    clientX: number;
    clientY: number;
    pressure?: number;
    pointerType?: string;
  }): Point => {
    const r = paper.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * page.width,
      y: ((e.clientY - r.top) / r.height) * page.height,
      p: e.pointerType === 'pen' && e.pressure && e.pressure > 0 ? e.pressure : 0.5,
    };
  };
  const turnBySwipe = (dx: number, dy: number) => {
    if (
      Math.abs(dx) < Math.min(70, Math.max(40, size.w * 0.08)) ||
      Math.abs(dx) <= Math.abs(dy) * 1.4
    )
      return false;
    gesture.current = null;
    swipe.current = null;
    tap.current = null;
    if (interacting.current) commitView();
    onNavigate(dx < 0 ? 1 : -1);
    return true;
  };
  const down = (e: ReactPointerEvent) => {
    const { zoom, pan } = view.current;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2) {
        hideEraser();
        beginView();
        tap.current = {
          ids: new Set(touches.current.keys()),
          starts: new Map(touches.current),
          at: performance.now(),
          cancelled: !twoFingerTap || performance.now() - (gesture.current?.started || 0) > 220,
        };
        gesture.current = null;
        setDraft(null);
        setWorking(null);
        setLasso([]);
        const [a, b] = [...touches.current.values()];
        const r = viewport.current!.getBoundingClientRect();
        const mid = {
          x: (a.x + b.x) / 2 - r.left - size.w / 2,
          y: (a.y + b.y) / 2 - r.top - size.h / 2,
        };
        pinch.current = {
          distance: Math.hypot(a.x - b.x, a.y - b.y),
          zoom,
          anchor: { x: (mid.x - pan.x) / (fit * zoom), y: (mid.y - pan.y) / (fit * zoom) },
        };
        return;
      }
      if (touches.current.size > 2) {
        if (tap.current) tap.current.cancelled = true;
        return;
      }
    }
    if (e.pointerType === 'pen') {
      gesture.current = null;
      setDraft(null);
      setWorking(null);
      setLasso([]);
      touches.current.clear();
      pinch.current = null;
    }
    if (gesture.current) return;
    const p = point(e),
      isInk = e.pointerType === 'pen' || e.pointerType === 'mouse' || fingerInk || tool === 'laser';
    const selectedTool = effectiveTool(tool, pencilTool, e.pointerType, fingerInk);
    let kind: 'draw' | 'erase' | 'lasso' | 'move' | 'pan' | 'laser' = 'pan';
    if (isInk) {
      if (selectedTool === 'pen' || selectedTool === 'highlighter') kind = 'draw';
      else if (selectedTool === 'select')
        kind =
          selection.length &&
          page.strokes.some((s) => selection.includes(s.id) && strokeHit(s, p, 18 / screenScale()))
            ? 'move'
            : 'lasso';
      else if (selectedTool === 'eraser') kind = 'erase';
      else if (selectedTool === 'laser') kind = 'laser';
    }
    if (kind === 'pan') beginView();
    showEraser(e);
    gesture.current = {
      kind,
      id: e.pointerId,
      pointerType: e.pointerType,
      started: performance.now(),
      start: p,
      client: { x: e.clientX, y: e.clientY },
      pan,
      original: page.strokes,
      points: [p],
      selection,
    };
    if (kind === 'draw') {
      const s: Stroke = {
        id: uid(),
        tool: selectedTool as 'pen' | 'highlighter',
        color,
        width,
        points: [p],
      };
      gesture.current.stroke = s;
      setDraft(s);
    }
    if (kind === 'erase') {
      gesture.current.erasure = { id: uid(), width: eraserWidth / screenScale() };
      gesture.current.erased = new Set();
      gesture.current.result = applyErasure(
        page.strokes,
        { ...gesture.current.erasure, points: [p] },
        gesture.current.erased,
      );
      setWorking(gesture.current.result);
    }
    if (kind === 'lasso') {
      setSelection([]);
      setLasso([p]);
    }
    if (kind === 'laser') lasers.current.push({ ...p, t: performance.now() });
  };
  const move = (e: ReactPointerEvent) => {
    showEraser(e);
    const initial = tap.current?.starts.get(e.pointerId);
    if (initial && Math.hypot(e.clientX - initial.x, e.clientY - initial.y) > 12)
      tap.current!.cancelled = true;
    if (touches.current.has(e.pointerId))
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === 'touch' && nativePinch.current) return;
    if (pinch.current && touches.current.size >= 2) {
      const [a, b] = [...touches.current.values()],
        g = pinch.current,
        r = viewport.current!.getBoundingClientRect();
      const z = clamp((g.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / (g.distance || 1), 1, 5);
      moveView(
        z,
        limit(
          {
            x: (a.x + b.x) / 2 - r.left - size.w / 2 - g.anchor.x * fit * z,
            y: (a.y + b.y) / 2 - r.top - size.h / 2 - g.anchor.y * fit * z,
          },
          z,
        ),
      );
      return;
    }
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) {
      if (tool === 'laser' && e.pointerType === 'pen')
        lasers.current.push({ ...point(e), t: performance.now() });
      return;
    }
    const p = point(e);
    if (g.kind === 'pan') {
      moveView(
        view.current.zoom,
        limit({ x: g.pan.x + e.clientX - g.client.x, y: g.pan.y + e.clientY - g.client.y }),
      );
      return;
    }
    if (g.kind === 'laser') {
      lasers.current.push({ ...p, t: performance.now() });
      return;
    }
    if (g.kind === 'draw') {
      const coalesced = e.nativeEvent.getCoalescedEvents?.();
      const samples = coalesced?.length ? coalesced : [e.nativeEvent];
      for (const sample of samples) {
        const pt = point({
          clientX: sample.clientX,
          clientY: sample.clientY,
          pressure: sample.pressure,
          pointerType: e.pointerType,
        });
        const last = g.points.at(-1)!;
        if (Math.hypot(pt.x - last.x, pt.y - last.y) > 0.25 / screenScale()) g.points.push(pt);
      }
      setDraft({ ...g.stroke!, points: [...g.points] });
    }
    if (g.kind === 'erase') {
      const fromIndex = g.points.length;
      const samples = e.nativeEvent.getCoalescedEvents?.();
      for (const sample of samples?.length ? samples : [e.nativeEvent]) {
        const pt = point(sample),
          last = g.points.at(-1)!;
        if (Math.hypot(pt.x - last.x, pt.y - last.y) > 0.25 / screenScale()) g.points.push(pt);
      }
      g.result = applyErasure(
        g.original,
        { ...g.erasure!, points: [...g.points] },
        g.erased,
        fromIndex,
      );
      setWorking(g.result);
    }
    if (g.kind === 'lasso') {
      g.points.push(p);
      setLasso([...g.points]);
    }
    if (g.kind === 'move') {
      const dx = p.x - g.start.x,
        dy = p.y - g.start.y;
      g.result = g.original.map((s) =>
        g.selection!.includes(s.id) ? translateStroke(s, dx, dy) : s,
      );
      setWorking(g.result);
    }
  };
  const up = (e: ReactPointerEvent, cancel = false) => {
    if (e.pointerType !== 'mouse' || cancel) hideEraser();
    if (tap.current?.ids.has(e.pointerId)) {
      if (cancel) tap.current.cancelled = true;
      tap.current.ids.delete(e.pointerId);
      if (!tap.current.ids.size) {
        const accepted = !tap.current.cancelled && performance.now() - tap.current.at < 280;
        tap.current = null;
        if (accepted) onToggleEraser();
      }
    }
    touches.current.delete(e.pointerId);
    if (e.pointerType === 'touch' && nativePinch.current) {
      if (interacting.current) commitView();
      gesture.current = null;
      return;
    }
    if (pinch.current) {
      if (interacting.current) commitView();
      if (touches.current.size < 2) pinch.current = null;
      gesture.current = null;
      return;
    }
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (g.kind === 'pan') commitView();
    if (!cancel) {
      if (g.kind === 'draw')
        onChange({
          ...pageRef.current,
          strokes: [...g.original, { ...g.stroke!, points: g.points }],
        });
      // Commit event-time data, never React's potentially deferred pointermove render.
      if (g.kind === 'move') {
        const p = point(e),
          dx = p.x - g.start.x,
          dy = p.y - g.start.y;
        g.result = g.original.map((s) =>
          g.selection!.includes(s.id) ? translateStroke(s, dx, dy) : s,
        );
      }
      if (g.kind === 'erase') {
        const p = point(e),
          last = g.points.at(-1)!,
          fromIndex = g.points.length;
        if (Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) g.points.push(p);
        g.result = applyErasure(
          g.original,
          { ...g.erasure!, points: [...g.points] },
          g.erased,
          fromIndex,
        );
      }
      if ((g.kind === 'erase' || g.kind === 'move') && g.result && g.result !== g.original)
        onChange({ ...pageRef.current, strokes: g.result });
      if (g.kind === 'lasso')
        setSelection(
          g.original
            .filter((s) => s.points.some((p) => !pointErased(s, p) && pointInPolygon(p, g.points)))
            .map((s) => s.id),
        );
      if (g.kind === 'pan' && g.pointerType === 'touch') {
        const dx = e.clientX - g.client.x,
          dy = e.clientY - g.client.y;
        turnBySwipe(dx, dy);
      }
    }
    setDraft(null);
    setWorking(null);
    setLasso([]);
  };
  const changeVideo = (v: Video) =>
    onChange({ ...page, videos: page.videos.map((item) => (item.id === v.id ? v : item)) });
  return (
    <div
      className={`stage tool-${tool}`}
      ref={viewport}
      data-testid="stage"
      onPointerDownCapture={(e) => {
        if (e.pointerType === 'pen') {
          swipe.current = null;
          nativePinch.current = null;
          const g = gesture.current;
          if (g?.pointerType === 'touch') {
            if (g.kind === 'pan') moveView(view.current.zoom, g.pan);
            gesture.current = null;
            setDraft(null);
            setWorking(null);
            setLasso([]);
          }
          if (interacting.current) commitView();
          palm.current.penDown(e.pointerId, performance.now());
          touches.current.clear();
          pinch.current = null;
          tap.current = null;
        } else if (
          e.pointerType === 'touch' &&
          !palm.current.touchDown(
            e.pointerId,
            e.width,
            e.height,
            performance.now(),
            palmRejection,
            fingerInk,
          )
        ) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onPointerMoveCapture={(e) => {
        if (e.pointerType === 'touch' && !palm.current.allowsTouch(e.pointerId)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onPointerUpCapture={(e) => {
        if (e.pointerType === 'pen') palm.current.penUp(e.pointerId, performance.now());
        if (e.pointerType === 'touch') {
          const accepted = palm.current.allowsTouch(e.pointerId);
          palm.current.touchUp(e.pointerId, performance.now());
          if (!accepted) {
            e.preventDefault();
            e.stopPropagation();
          }
        }
      }}
      onPointerCancelCapture={(e) => {
        if (e.pointerType === 'pen') palm.current.penUp(e.pointerId, performance.now());
        if (e.pointerType === 'touch') palm.current.touchUp(e.pointerId);
      }}
      onClickCapture={(e) => {
        const pe = e.nativeEvent as PointerEvent;
        if (
          palm.current.blocksClick(
            pe.pointerType,
            pe.width || 0,
            pe.height || 0,
            performance.now(),
            palmRejection,
          )
        ) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onPointerDown={down}
      onTouchStart={(e) => {
        const { zoom, pan } = view.current;
        const contacts = Array.from(e.touches) as Array<
          (typeof e.touches)[0] & { radiusX?: number; radiusY?: number; touchType?: string }
        >;
        const interactive = (e.target as Element).closest('.video-box,.selection-delete');
        if (
          contacts.length === 2 &&
          !interactive &&
          !palm.current.blocksNavigation(performance.now(), palmRejection) &&
          contacts.every(
            (t) =>
              t.touchType !== 'stylus' &&
              !palm.current.rejectsGeometry(
                (t.radiusX || 0) * 2,
                (t.radiusY || 0) * 2,
                performance.now(),
                palmRejection,
              ),
          )
        ) {
          swipe.current = null;
          if (!nativePinch.current || nativePinch.current.ending) {
            hideEraser();
            beginView();
            const [a, b] = contacts,
              r = viewport.current!.getBoundingClientRect();
            const mid = {
              x: (a.clientX + b.clientX) / 2 - r.left - size.w / 2,
              y: (a.clientY + b.clientY) / 2 - r.top - size.h / 2,
            };
            nativePinch.current = {
              ids: [a.identifier, b.identifier],
              distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
              zoom,
              anchor: { x: (mid.x - pan.x) / (fit * zoom), y: (mid.y - pan.y) / (fit * zoom) },
              starts: new Map(contacts.map((t) => [t.identifier, { x: t.clientX, y: t.clientY }])),
              ending: false,
            };
            gesture.current = null;
            pinch.current = null;
            setDraft(null);
            setWorking(null);
            setLasso([]);
          }
          return;
        }
        if (nativePinch.current) {
          nativePinch.current.ending = true;
          if (tap.current) tap.current.cancelled = true;
          return;
        }
        if (
          e.touches.length !== 1 ||
          fingerInk ||
          tool === 'laser' ||
          interactive ||
          palm.current.blocksNavigation(performance.now(), palmRejection)
        ) {
          swipe.current = null;
          return;
        }
        const t = e.touches[0] as (typeof e.touches)[0] & {
          radiusX?: number;
          radiusY?: number;
          touchType?: string;
        };
        if (
          t.touchType === 'stylus' ||
          palm.current.rejectsGeometry(
            (t.radiusX || 0) * 2,
            (t.radiusY || 0) * 2,
            performance.now(),
            palmRejection,
          )
        ) {
          swipe.current = null;
          return;
        }
        swipe.current = {
          id: t.identifier,
          x: t.clientX,
          y: t.clientY,
          lastX: t.clientX,
          lastY: t.clientY,
        };
      }}
      onTouchMove={(e) => {
        const n = nativePinch.current;
        if (n) {
          if (
            n.ending ||
            e.touches.length !== 2 ||
            palm.current.blocksNavigation(performance.now(), palmRejection)
          ) {
            n.ending = true;
            return;
          }
          const contacts = Array.from(e.touches),
            a = contacts.find((t) => t.identifier === n.ids[0]),
            b = contacts.find((t) => t.identifier === n.ids[1]);
          if (!a || !b) {
            n.ending = true;
            return;
          }
          if (
            tap.current &&
            [a, b].some((t) => {
              const start = n.starts.get(t.identifier)!;
              return Math.hypot(t.clientX - start.x, t.clientY - start.y) > 12;
            })
          )
            tap.current.cancelled = true;
          const r = viewport.current!.getBoundingClientRect(),
            z = clamp(
              (n.zoom * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)) /
                (n.distance || 1),
              1,
              5,
            );
          moveView(
            z,
            limit(
              {
                x: (a.clientX + b.clientX) / 2 - r.left - size.w / 2 - n.anchor.x * fit * z,
                y: (a.clientY + b.clientY) / 2 - r.top - size.h / 2 - n.anchor.y * fit * z,
              },
              z,
            ),
          );
          return;
        }
        const g = swipe.current;
        if (!g) return;
        if (
          e.touches.length !== 1 ||
          palm.current.blocksNavigation(performance.now(), palmRejection)
        ) {
          swipe.current = null;
          return;
        }
        const t = Array.from(e.touches).find((t) => t.identifier === g.id);
        if (t) {
          g.lastX = t.clientX;
          g.lastY = t.clientY;
        }
      }}
      onTouchEnd={(e) => {
        if (nativePinch.current) {
          nativePinch.current.ending = true;
          if (interacting.current) commitView();
          if (!e.touches.length) {
            nativePinch.current = null;
            touches.current.clear();
            pinch.current = null;
            tap.current = null;
            gesture.current = null;
          }
          return;
        }
        const g = swipe.current;
        if (!g) return;
        const t = Array.from(e.changedTouches).find((t) => t.identifier === g.id);
        if (!t) return;
        swipe.current = null;
        if (!palm.current.blocksNavigation(performance.now(), palmRejection))
          turnBySwipe((t.clientX || g.lastX) - g.x, (t.clientY || g.lastY) - g.y);
      }}
      onTouchCancel={() => {
        swipe.current = null;
        if (nativePinch.current) {
          if (interacting.current) commitView();
          nativePinch.current = null;
          touches.current.clear();
          pinch.current = null;
          tap.current = null;
          if (gesture.current?.pointerType === 'touch') gesture.current = null;
          setDraft(null);
          setWorking(null);
          setLasso([]);
        }
      }}
      onPointerMove={move}
      onPointerLeave={hideEraser}
      onPointerUp={(e) => up(e)}
      onPointerCancel={(e) => up(e, true)}
      onLostPointerCapture={(e) => {
        if (e.target === e.currentTarget) up(e, true);
      }}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) => {
        beginView();
        const current = view.current;
        if (e.ctrlKey || e.metaKey) {
          const z = clamp(current.zoom - e.deltaY * 0.005, 1, 5);
          moveView(z, limit(current.pan, z));
        } else if (current.zoom > 1)
          moveView(
            current.zoom,
            limit({ x: current.pan.x - e.deltaX, y: current.pan.y - e.deltaY }, current.zoom),
          );
        commitSoon();
      }}
    >
      <div
        ref={backdrop}
        className="pdf-backdrop"
        aria-hidden="true"
        style={{ width: page.width * fit, height: page.height * fit }}
      >
        <canvas ref={pdfCanvas} className="pdf-canvas" />
      </div>
      <div ref={detail} className="pdf-detail-layer" aria-hidden="true" />
      <div
        ref={paper}
        className="pdf-page"
        data-testid="pdf-page"
        style={{
          width: page.width * fit,
          height: page.height * fit,
        }}
      >
        <canvas ref={inkCanvas} className="ink-canvas" data-testid="ink-canvas" />
        {page.videos.map((v) => (
          <VideoBox
            key={v.id}
            video={v}
            page={page}
            editing={!lecture && tool === 'hand'}
            pageScale={fit}
            displayZoom={zoom}
            onChange={changeVideo}
            onDelete={() =>
              onChange({ ...page, videos: page.videos.filter((item) => item.id !== v.id) })
            }
          />
        ))}
        {loading && <div className="pdf-loading">ページを読み込み中…</div>}
      </div>
      <canvas ref={laserCanvas} className="laser-canvas" />
      <div
        ref={eraserCursor}
        className="eraser-cursor"
        data-testid="eraser-cursor"
        aria-hidden="true"
      />
      {!!selection.length && (
        <button
          className="selection-delete"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            onChange({ ...page, strokes: page.strokes.filter((s) => !selection.includes(s.id)) });
            setSelection([]);
          }}
        >
          <Trash2 size={17} /> 選択した線を削除 ({selection.length})
        </button>
      )}
      <div className="stage-note">
        {tool === 'laser'
          ? '触れて動かすとレーザーを表示'
          : tool === 'select'
            ? '線を囲んで選択 → ドラッグで移動'
            : zoom > 1
              ? '2本指で移動・ピンチで拡大縮小'
              : fingerInk
                ? '指でも筆記できます · 2本指で拡大縮小'
                : 'Pencilで筆記 · 指でページ送り · 2本指で拡大縮小'}
      </div>
    </div>
  );
}
