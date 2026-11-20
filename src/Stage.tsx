import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PointerEvent as ReactPointerEvent, Ref } from 'react';
import { flushSync } from 'react-dom';
import { drawLaser, strokeHit, transformStroke, uid } from './model';
import type { Page, PenKind, Point, Stroke, Tool, Video } from './model';
import { renderPage } from './pdf';
import VideoBox from './VideoBox';
import type { RegisterPlayback } from './VideoBox';
import { effectiveTool, PalmGuard } from './input';
import type { InkPriority, PencilTool } from './input';
import type { PencilDiagnostics } from './pencil-diagnostics';
import { clampPageZoom, usePageViewport } from './usePageViewport';
import type { PageView, StageLocation } from './usePageViewport';
import { panVelocity, recordPan } from './touch-momentum';
import type { PanHistory } from './touch-momentum';
import { useInkLayer } from './useInkLayer';
import { usePdfDetail } from './usePdfDetail';
import { usePageStack } from './usePageStack';
import PageStackPreview from './PageStackPreview';
import { applyErasure } from './eraser';
import InkSelectionControls from './InkSelectionControls';
import {
  centerOf,
  hitBounds,
  inkSelection,
  lassoStrokes,
  selectionTransform,
} from './ink-selection';
import type { InkSelection, Position } from './ink-selection';

export type { StageLocation } from './usePageViewport';

type InkTransform = ReturnType<typeof selectionTransform>;
type GestureKind = 'draw' | 'erase' | 'lasso' | 'move' | 'resize' | 'pan' | 'laser';
type StylusTouch = { touchType?: string; force?: number };
type ContactStart = Pick<
  ReactPointerEvent,
  | 'pointerId'
  | 'pointerType'
  | 'button'
  | 'clientX'
  | 'clientY'
  | 'pressure'
  | 'target'
  | 'timeStamp'
>;
type PencilContact = {
  downAt: number;
  recoveredStart?: 'pointermove' | 'touchmove';
  confirmedStart?: boolean;
  endAt?: number;
  pointerId?: number;
  touchId?: number;
  touchDownAt?: number;
  shortTouchEnd?: Point;
  pointerEnded?: boolean;
  touchEnded?: boolean;
  lastPointerAt?: number;
  lastPointerPacket?: { points: Point[]; receivedAt: number };
  lastWasTouch?: boolean;
};
const nativePencil = Symbol('native Pencil contact');
type Pinch = { distance: number; zoom: number; mid: Position; anchor: Position };
const changeSelection = (strokes: Stroke[], ids: Set<string>, { scale, x, y }: InkTransform) =>
  strokes.map((stroke) => (ids.has(stroke.id) ? transformStroke(stroke, scale, x, y) : stroke));

type Props = {
  page: Page;
  captureViewRef?: Ref<() => StageLocation>;
  restoreLocation?: StageLocation | null;
  continuousPages?: Page[];
  onFocusPage: (id: string) => void;
  tool: Tool;
  penKind?: PenKind;
  color: string;
  width: number;
  laserWidth: number;
  eraserWidth: number;
  fingerInk: boolean;
  pencilPressure: boolean;
  pencilTool: PencilTool;
  palmRejection: boolean;
  twoFingerTap: boolean;
  onToggleEraser: () => void;
  trail: boolean;
  registerPlayback: RegisterPlayback;
  fitWidth: boolean;
  zoom: number;
  onInkScaleChange: (scale: number) => void;
  inkClipboard: Stroke[];
  inkPriority: InkPriority;
  pencilDiagnostics: PencilDiagnostics | null;
  onCopyInk: (strokes: Stroke[]) => void;
  setZoom: (z: number) => void;
  onChange: (pageId: string, edit: (previous: Page) => Page) => void;
  onNavigate: (delta: number) => void;
  onError: (s: string) => void;
};
export default function Stage({
  page,
  captureViewRef,
  restoreLocation,
  continuousPages,
  onFocusPage,
  tool,
  penKind,
  color,
  width,
  laserWidth,
  eraserWidth,
  fingerInk,
  pencilPressure,
  pencilTool,
  palmRejection,
  twoFingerTap,
  onToggleEraser,
  trail,
  registerPlayback,
  fitWidth,
  zoom,
  onInkScaleChange,
  inkClipboard,
  inkPriority,
  pencilDiagnostics,
  onCopyInk,
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
    laserCanvas = useRef<HTMLCanvasElement>(null),
    eraserCursor = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 700 }),
    [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<string[]>([]),
    [lasso, setLasso] = useState<Point[]>([]),
    [selectionPreview, setSelectionPreview] = useState<InkTransform | null>(null),
    [pasteAnchor, setPasteAnchor] = useState<Position | null>(null);
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null);
  const [playingVideo, setPlayingVideo] = useState<string | null>(null);
  const [videoControls, setVideoControls] = useState<HTMLDivElement | null>(null);
  const closePlayback = useCallback((key: string) => {
    setPlayingVideo((current) => (current === key ? null : current));
  }, []);
  useEffect(() => setSelectedVideo(null), [page.id, tool]);
  useEffect(() => setPlayingVideo(null), [page.id, !!continuousPages]);
  const selectionIds = useMemo(() => new Set(selection), [selection]);
  const selected = useMemo(
    () => (selectionIds.size ? page.strokes.filter((stroke) => selectionIds.has(stroke.id)) : []),
    [page.strokes, selectionIds],
  );
  const selectionShape = useMemo(() => inkSelection(selected), [selected]);
  const working = useMemo(
    () => selectionPreview && changeSelection(page.strokes, selectionIds, selectionPreview),
    [page.strokes, selectionIds, selectionPreview],
  );
  const gesture = useRef<{
    pageId: string;
    kind: GestureKind;
    id: number;
    pointerType: string;
    started: number;
    start: Point;
    client: { x: number; y: number };
    original: Stroke[];
    pan: { x: number; y: number };
    panHistory?: PanHistory;
    points: Point[];
    paperRect: DOMRect;
    stroke?: Stroke;
    selection: Set<string>;
    shape: InkSelection | null;
    moved?: boolean;
    playbackTap?: string;
    pencil?: PencilContact;
    erasure?: { id: string; width: number };
  } | null>(null);
  const stylusContact = useRef<number | null>(null);
  // Do not adopt stale motion from a finished contact or one that started on a control.
  const knownPencilIds = useRef(new Set<number>());
  const latestPencilEnd = useRef(-Infinity);
  const pencilFinish = useRef<{ timer: ReturnType<typeof setTimeout>; finish: () => void } | null>(
    null,
  );
  const touches = useRef(new Map<number, Position>()),
    pinch = useRef<Pinch | null>(null);
  const palm = useRef(new PalmGuard());
  const nativePinch = useRef<
    | (Pinch & {
        ids: [number, number];
        starts: Map<number, { x: number; y: number }>;
        ending: boolean;
      })
    | null
  >(null);
  const swipe = useRef<{
    id: number;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    pan: { x: number; y: number };
    panning: boolean;
    history: PanHistory;
    interrupted: boolean;
  } | null>(null);
  const tap = useRef<{
    ids: Set<number>;
    starts: Map<number, { x: number; y: number }>;
    at: number;
    cancelled: boolean;
  } | null>(null);
  const lasers = useRef<{ x: number; y: number; t: number }[]>([]);
  const paintPreview = useRef<(view: PageView) => void>(() => {});
  const observePdf = useRef<(view: PageView) => void>(() => {});
  const preparingInk = useRef<() => boolean>(() => false);
  const showInkPreview = useCallback(() => {
    const stage = viewport.current;
    if (stage && !stage.hasAttribute('data-ink-preview'))
      stage.setAttribute('data-ink-preview', '');
  }, []);
  const stack = usePageStack(continuousPages, page, size, fitWidth, onFocusPage);
  const {
    fit,
    captureLocation,
    contentBounds,
    paintStack,
    pagePosition,
    settleStack,
    takePagePan,
  } = stack;
  const paintOverlays = useCallback(
    (view: PageView) => {
      paintPreview.current(view);
      observePdf.current(view);
      onInkScaleChange(fit * view.zoom);
    },
    [fit, onInkScaleChange],
  );
  const {
    view,
    pan,
    interacting,
    coastSpeed,
    rasterScale,
    settled,
    showDetail,
    limit,
    begin: beginView,
    move: moveView,
    commit: commitView,
    commitSoon,
    coast,
    stopCoast,
  } = usePageViewport({
    viewport,
    paper,
    backdrop,
    detail,
    pageId: page.id,
    width: page.width,
    height: page.height,
    contentBounds,
    size,
    fit,
    zoom,
    restoreLocation: restoreLocation?.fitWidth === fitWidth ? restoreLocation : null,
    setZoom,
    showInkPreview,
    paintOverlays,
    paintStack,
    pagePosition,
    settleStack,
    takePagePan,
  });
  useImperativeHandle(captureViewRef, () => () => captureLocation(view.current), [
    captureLocation,
    view,
  ]);
  const continuous = Boolean(stack.active);
  useEffect(() => {
    const stage = viewport.current!;
    const wheel = (event: WheelEvent) => {
      const current = view.current;
      if (event.ctrlKey || event.metaKey) {
        // Cancel browser zoom on the PDF surface, including at the document's zoom limits.
        event.preventDefault();
        const box = stage.getBoundingClientRect();
        const mode = event.deltaMode;
        const unit =
          mode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : mode === WheelEvent.DOM_DELTA_PAGE
              ? box.height
              : 1;
        const nextZoom = clampPageZoom(current.zoom * Math.exp(-event.deltaY * unit * 0.0016));
        if (nextZoom === current.zoom) return;
        const x = event.clientX - box.left - box.width / 2;
        const y = event.clientY - box.top - box.height / 2;
        const ratio = nextZoom / current.zoom;
        beginView();
        moveView(
          nextZoom,
          limit(
            { x: x + (current.pan.x - x) * ratio, y: y + (current.pan.y - y) * ratio },
            nextZoom,
          ),
        );
      } else {
        if (!continuous && current.zoom === 1) return;
        beginView();
        moveView(
          current.zoom,
          limit({ x: current.pan.x - event.deltaX, y: current.pan.y - event.deltaY }, current.zoom),
        );
      }
      commitSoon();
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => stage.removeEventListener('wheel', wheel);
  }, [beginView, commitSoon, continuous, limit, moveView, view]);
  const penBusy = inkPriority.isBusy;
  const pdfBusy = useCallback(() => interacting.current || penBusy(), [interacting, penBusy]);
  const stackPdfBusy = useCallback(
    () => (interacting.current && coastSpeed.current === 0) || penBusy(),
    [coastSpeed, interacting, penBusy],
  );
  const livePdfBusy = useCallback(() => penBusy() || preparingInk.current(), [penBusy]);
  observePdf.current = usePdfDetail({
    page,
    fit,
    zoom,
    pan,
    size,
    baseScale: rasterScale,
    view,
    interacting,
    isBusy: pdfBusy,
    liveBusy: livePdfBusy,
    showDetail,
  });
  const {
    inkCanvas,
    draftCanvas,
    inkPreview,
    liveInk,
    preparingLiveInk,
    paintInkPreview: paintInk,
    previewStroke,
    previewPencilStroke,
    clearDraft,
    previewErasure,
    finishErasure,
  } = useInkLayer({
    page,
    viewport,
    size,
    fit,
    zoom,
    pan,
    settled,
    interacting,
    coastSpeed,
    working,
    lasso,
    neighbors: stack.nearby,
    center: stack.active?.center ?? 0,
    shouldPausePreview: pdfBusy,
  });
  paintPreview.current = paintInk;
  preparingInk.current = preparingLiveInk;
  const clearInkGesture = useCallback(() => {
    clearTimeout(pencilFinish.current?.timer);
    pencilFinish.current = null;
    inkPriority.end();
    clearDraft();
    finishErasure();
    setSelectionPreview(null);
    setLasso((points) => (points.length ? [] : points));
  }, [inkPriority, clearDraft, finishErasure]);
  useEffect(
    () => () => {
      clearTimeout(pencilFinish.current?.timer);
      inkPriority.end();
    },
    [inkPriority],
  );
  const screenScale = () => fit * view.current.zoom;
  const hideEraser = () => {
    const cursor = eraserCursor.current;
    if (cursor && cursor.style.display !== 'none') cursor.style.display = 'none';
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
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth,
        h = el.clientHeight;
      setSize((current) => (current.w === w && current.h === h ? current : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    pencilFinish.current?.finish();
    setSelection([]);
    setPasteAnchor(null);
    clearInkGesture();
    gesture.current = null;
    touches.current.clear();
    pinch.current = null;
    nativePinch.current = null;
    lasers.current = [];
    tap.current = null;
    swipe.current = null;
    stylusContact.current = null;
    palm.current.penUp(nativePencil, performance.now());
  }, [page.id, clearInkGesture]);
  useEffect(() => {
    const reset = () => {
      pencilFinish.current?.finish();
      hideEraser();
      commitView();
      palm.current.reset(performance.now());
      gesture.current = null;
      touches.current.clear();
      pinch.current = null;
      nativePinch.current = null;
      tap.current = null;
      swipe.current = null;
      stylusContact.current = null;
      clearInkGesture();
    };
    const stopOutsideStage = (e: PointerEvent | KeyboardEvent) => {
      if (coastSpeed.current && e.target instanceof Node && !viewport.current?.contains(e.target))
        flushSync(() => commitView());
    };
    const finishWhenHidden = () => {
      if (document.visibilityState === 'hidden') pencilFinish.current?.finish();
    };
    window.addEventListener('blur', reset);
    // Settle the stroke before App takes its final IndexedDB snapshot.
    document.addEventListener('visibilitychange', finishWhenHidden, true);
    window.addEventListener('pointerdown', stopOutsideStage, true);
    window.addEventListener('keydown', stopOutsideStage, true);
    return () => {
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', finishWhenHidden, true);
      window.removeEventListener('pointerdown', stopOutsideStage, true);
      window.removeEventListener('keydown', stopOutsideStage, true);
    };
  }, [commitView, clearInkGesture, coastSpeed]);
  useEffect(() => {
    setSelection([]);
    setLasso([]);
    setPasteAnchor(null);
  }, [tool]);
  useEffect(() => {
    const remember = (id: number) => {
      const ids = knownPencilIds.current;
      ids.delete(id);
      ids.add(id);
      if (ids.size > 64) ids.delete(ids.values().next().value!);
    };
    const pointer = (event: PointerEvent) => {
      if (event.pointerType !== 'pen') return;
      remember(event.pointerId);
      if (event.type !== 'pointerdown')
        latestPencilEnd.current = Math.max(latestPencilEnd.current, event.timeStamp);
    };
    const touch = (event: TouchEvent) => {
      for (const contact of Array.from(event.changedTouches)) {
        if ((contact as StylusTouch).touchType !== 'stylus') continue;
        remember(contact.identifier);
        if (event.type !== 'touchstart')
          latestPencilEnd.current = Math.max(latestPencilEnd.current, event.timeStamp);
      }
    };
    const pointerEvents = [
      'pointerdown',
      'pointerup',
      'pointercancel',
      'lostpointercapture',
    ] as const;
    const touchEvents = ['touchstart', 'touchend', 'touchcancel'] as const;
    for (const type of pointerEvents)
      document.addEventListener(type, pointer, { capture: true, passive: true });
    for (const type of touchEvents)
      document.addEventListener(type, touch, { capture: true, passive: true });
    return () => {
      for (const type of pointerEvents) document.removeEventListener(type, pointer, true);
      for (const type of touchEvents) document.removeEventListener(type, touch, true);
    };
  }, []);
  useEffect(() => {
    const stage = viewport.current;
    if (stage && pencilDiagnostics) return pencilDiagnostics.attach(stage);
  }, [pencilDiagnostics]);
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    if (pdfCanvas.current?.dataset.page !== page.id) setLoading(true);
    const target = pdfCanvas.current!;
    // Keep the fit-size backing bitmap across zoom and pan.
    const temp = document.createElement('canvas');
    const output = rasterScale;
    void renderPage(page, temp, output, abort.signal, undefined, pdfBusy)
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
  }, [
    page.id,
    page.assetId,
    page.sourcePage,
    page.width,
    page.height,
    rasterScale,
    onError,
    pdfBusy,
  ]);
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
  const point = (
    e: {
      clientX: number;
      clientY: number;
      pressure?: number;
      pointerType?: string;
    },
    r = paper.current!.getBoundingClientRect(),
  ): Point => {
    return {
      x: ((e.clientX - r.left) / r.width) * page.width,
      y: ((e.clientY - r.top) / r.height) * page.height,
      p: pencilPressure && e.pointerType === 'pen' ? (e.pressure ?? 0.5) : 0.5,
    };
  };
  const appendPoint = (points: Point[], p: Point, spacing: number) => {
    const last = points.at(-1)!;
    if (Math.hypot(p.x - last.x, p.y - last.y) <= spacing) return false;
    points.push(p);
    return true;
  };
  const appendPencilPoint = (points: Point[], p: Point) =>
    appendPoint(points, p, (points.length === 1 ? 1 : 0.25) / screenScale());
  const appendSamples = (e: ReactPointerEvent, g: NonNullable<typeof gesture.current>) => {
    const { points, paperRect } = g;
    const event = e.nativeEvent;
    const samples = event.getCoalescedEvents?.();
    const spacing = 0.25 / screenScale();
    for (const sample of samples?.length ? samples : [event])
      appendPoint(points, point(sample, paperRect), spacing);
  };
  const appendPencilSamples = (
    event: PointerEvent,
    g: NonNullable<typeof gesture.current>,
    ending = false,
  ) => {
    const pencil = g.pencil!;
    const inContact = (sample: PointerEvent) =>
      (sample.pointerId === undefined || sample.pointerId === event.pointerId) &&
      ((sample.buttons & 1) !== 0 || sample.pressure > 0);
    const samples = (event.getCoalescedEvents?.() ?? []).filter(
      (sample) =>
        inContact(sample) &&
        (!ending || sample.type === 'pointermove' || sample.type === 'pointerrawupdate'),
    );
    // Some WebKit packets carry earlier contact moves even on the release event.
    // Only those moves qualify. The parent release location never contributes ink.
    if (!ending && !samples.length && inContact(event)) samples.push(event);
    if (!samples.length) return false;
    const packet: Point[] = [];
    const spacing = 0.25 / screenScale();
    for (const sample of samples) {
      const time = sample.timeStamp ?? event.timeStamp;
      if (
        time < Math.max(pencil.downAt, pencil.lastPointerAt ?? 0) ||
        time > Math.min(event.timeStamp, pencil.endAt ?? Infinity)
      )
        continue;
      pencil.lastPointerAt = time;
      packet.push(
        point(
          {
            clientX: sample.clientX,
            clientY: sample.clientY,
            pressure: sample.pressure,
            pointerType: 'pen',
          },
          g.paperRect,
        ),
      );
    }
    if (!packet.length) return false;
    const previous = g.points.at(-1)!;
    let start = 0;
    if (pencil.lastWasTouch) {
      // A coalesced packet can repeat the same contact that Touch Events already delivered.
      const matching = packet.findIndex(
        (p) => Math.hypot(p.x - previous.x, p.y - previous.y) <= spacing * 2,
      );
      if (matching !== -1) start = matching + 1;
    }
    pencil.lastPointerPacket = { points: packet, receivedAt: performance.now() };
    const count = g.points.length;
    for (let i = start; i < packet.length; i++) appendPencilPoint(g.points, packet[i]);
    if (g.points.length === count) return false;
    pencil.lastWasTouch = false;
    return true;
  };
  const removeSelection = () => {
    if (!selected.length) return;
    onChange(page.id, (prev) => ({
      ...prev,
      strokes: prev.strokes.filter((stroke) => !selectionIds.has(stroke.id)),
    }));
    setSelection([]);
    setPasteAnchor(null);
  };
  const copySelection = (cut: boolean) => {
    if (!selected.length) return;
    onCopyInk(selected);
    if (cut) removeSelection();
  };
  const commitSelection = (ids: Set<string>, transform: InkTransform) => {
    if (transform.scale === 1 && transform.x === 0 && transform.y === 0) return;
    onChange(page.id, (prev) => ({
      ...prev,
      strokes: changeSelection(prev.strokes, ids, transform),
    }));
  };
  const resizeSelection = (factor: number) => {
    if (!selectionShape) return;
    const center = centerOf(selectionShape.bounds);
    commitSelection(selectionIds, selectionTransform(selectionShape, page, center, center, factor));
  };
  const addInk = (source: Stroke[], shape: InkSelection, destination: Position) => {
    const { left, top, right, bottom } = shape.bounds;
    const fit = Math.min(1, page.width / (right - left), page.height / (bottom - top));
    const { scale, x, y } = selectionTransform(
      shape,
      page,
      centerOf(shape.bounds),
      destination,
      fit,
    );
    const copies = source.map((stroke) => ({
      ...transformStroke(stroke, scale, x, y),
      id: uid(),
    }));
    onChange(page.id, (prev) => ({ ...prev, strokes: [...prev.strokes, ...copies] }));
    setPasteAnchor(null);
    setSelection(copies.map((stroke) => stroke.id));
  };
  const duplicateSelection = () => {
    if (!selectionShape) return;
    const bounds = selectionShape.bounds;
    const center = centerOf(bounds);
    const offset = 22 / screenScale();
    addInk(selected, selectionShape, {
      x: center.x + (bounds.right + offset <= page.width ? offset : -offset),
      y: center.y + (bounds.bottom + offset <= page.height ? offset : -offset),
    });
  };
  const pasteSelection = () => {
    const shape = inkSelection(inkClipboard);
    if (!shape) return;
    const visibleCenter = {
      x: page.width / 2 - view.current.pan.x / screenScale(),
      y: page.height / 2 - view.current.pan.y / screenScale(),
    };
    const center = selectionShape ? centerOf(selectionShape.bounds) : visibleCenter;
    const offset = selectionShape ? 22 / screenScale() : 0;
    addInk(inkClipboard, shape, pasteAnchor ?? { x: center.x + offset, y: center.y + offset });
  };
  const selectAt = (p: Point, strokes: Stroke[]) => {
    const radius = 7 / screenScale();
    let picked: Stroke | undefined;
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (strokeHit(strokes[i], p, radius)) {
        picked = strokes[i];
        break;
      }
    }
    setSelection(picked ? [picked.id] : []);
    setPasteAnchor(
      !picked &&
        inkClipboard.length &&
        p.x >= 0 &&
        p.x <= page.width &&
        p.y >= 0 &&
        p.y <= page.height
        ? p
        : null,
    );
  };
  const selectionKeys = useRef<(event: KeyboardEvent) => void>(() => {});
  selectionKeys.current = (e) => {
    if (
      tool !== 'select' ||
      gesture.current ||
      e.defaultPrevented ||
      (e.target as Element | null)?.closest?.('input,textarea,select,[contenteditable],dialog') ||
      document.querySelector('dialog[open]')
    )
      return;
    const key = e.key.toLowerCase();
    const command = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    if (command && key === 'v' && inkClipboard.length) {
      e.preventDefault();
      pasteSelection();
    } else if (command && (key === 'c' || key === 'x') && selected.length) {
      e.preventDefault();
      copySelection(key === 'x');
    } else if (
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      (key === 'delete' || key === 'backspace') &&
      selected.length
    ) {
      e.preventDefault();
      removeSelection();
    }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => selectionKeys.current(event);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const dragSelection = (g: NonNullable<typeof gesture.current>, e: ReactPointerEvent) => {
    if (!g.shape || Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < 3) return null;
    const p = point(e);
    if (g.kind === 'move') return selectionTransform(g.shape, page, g.start, p, 1);
    const anchor = { x: g.shape.bounds.left, y: g.shape.bounds.top };
    const dx = g.start.x - anchor.x;
    const dy = g.start.y - anchor.y;
    const ratio = ((p.x - anchor.x) * dx + (p.y - anchor.y) * dy) / (dx * dx + dy * dy || 1);
    return selectionTransform(g.shape, page, anchor, anchor, ratio);
  };
  const turnBySwipe = (dx: number, dy: number) => {
    if (
      stack.active ||
      Math.abs(dx) < Math.min(70, Math.max(40, size.w * 0.08)) ||
      Math.abs(dx) <= Math.abs(dy) * 1.4
    )
      return false;
    gesture.current = null;
    clearInkGesture();
    swipe.current = null;
    tap.current = null;
    if (interacting.current) commitView();
    onNavigate(dx < 0 ? 1 : -1);
    return true;
  };
  const finishPan = (history: PanHistory | undefined, releasedAt: number) => {
    const velocity = history && panVelocity(history, releasedAt);
    if (velocity && coast(velocity)) return;
    if (interacting.current) commitView();
  };
  const startPinch = (a: Position, b: Position): Pinch => {
    const { zoom, pan } = view.current;
    const r = viewport.current!.getBoundingClientRect();
    const mid = { x: r.left + size.w / 2, y: r.top + size.h / 2 };
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      zoom,
      mid,
      anchor: {
        x: ((a.x + b.x) / 2 - mid.x - pan.x) / zoom,
        y: ((a.y + b.y) / 2 - mid.y - pan.y) / zoom,
      },
    };
  };
  const movePinch = (g: Pinch, a: Position, b: Position) => {
    const zoom = clampPageZoom((g.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / (g.distance || 1));
    moveView(
      zoom,
      limit(
        {
          x: (a.x + b.x) / 2 - g.mid.x - g.anchor.x * zoom,
          y: (a.y + b.y) / 2 - g.mid.y - g.anchor.y * zoom,
        },
        zoom,
      ),
    );
  };
  const down = (e: ContactStart, capture?: () => void) => {
    const { pan } = view.current;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    capture?.();
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
        clearInkGesture();
        const [a, b] = [...touches.current.values()];
        pinch.current = startPinch(a, b);
        return;
      }
      if (touches.current.size > 2) {
        if (tap.current) tap.current.cancelled = true;
        return;
      }
    }
    if (e.pointerType === 'pen') {
      if (gesture.current) {
        gesture.current = null;
        clearInkGesture();
      }
      touches.current.clear();
      pinch.current = null;
    }
    if (gesture.current) return;
    const paperRect = paper.current!.getBoundingClientRect();
    const p = point(e, paperRect);
    const selectedTool = effectiveTool(tool, pencilTool, e.pointerType, fingerInk);
    const resize = !!(e.target as Element).closest('[data-ink-resize]');
    const inSelection =
      selectionShape && (resize || hitBounds(selectionShape.bounds, p, 7 / screenScale()));
    const playbackTap = e.pointerType === 'touch' ? (playingVideo ?? undefined) : undefined;
    const isInk =
      !playbackTap &&
      (e.pointerType !== 'touch' ||
        fingerInk ||
        tool === 'laser' ||
        (selectedTool === 'select' && inSelection));
    let kind: GestureKind = 'pan';
    if (isInk) {
      if (selectedTool === 'pen' || selectedTool === 'highlighter') kind = 'draw';
      else if (selectedTool === 'select')
        kind = inSelection ? (resize ? 'resize' : 'move') : 'lasso';
      else if (selectedTool === 'eraser') kind = 'erase';
      else if (selectedTool === 'laser') kind = 'laser';
    }
    if (kind === 'pan' && (tool !== 'select' || e.pointerType !== 'touch')) beginView();
    showEraser(e);
    gesture.current = {
      pageId: page.id,
      kind,
      id: e.pointerId,
      pointerType: e.pointerType,
      started: performance.now(),
      start: p,
      client: { x: e.clientX, y: e.clientY },
      pan,
      ...(kind === 'pan' &&
        e.pointerType === 'touch' && {
          panHistory: [{ ...pan, time: e.timeStamp }],
        }),
      original: page.strokes,
      points: [p],
      paperRect,
      selection: selectionIds,
      shape: selectionShape,
      playbackTap,
    };
    if (kind === 'draw') {
      inkPriority.begin();
      const s: Stroke = {
        id: uid(),
        tool: selectedTool as 'pen' | 'highlighter',
        ...(selectedTool === 'pen' && penKind && { penKind }),
        color,
        width,
        points: gesture.current.points,
      };
      gesture.current.stroke = s;
      // A Pencil down point is only a dot if contact ends without movement.
      if (e.pointerType !== 'pen') previewStroke(s);
    }
    if (kind === 'erase') {
      inkPriority.begin();
      gesture.current.erasure = { id: uid(), width: eraserWidth / screenScale() };
      previewErasure(gesture.current.points, gesture.current.erasure.width);
    }
    if (kind === 'lasso') {
      setSelection([]);
      setPasteAnchor(null);
      setLasso([p]);
    }
    if (kind === 'laser') lasers.current.push({ ...p, t: performance.now() });
  };
  const currentDown = useRef(down);
  currentDown.current = down;
  const downOnPage = (e: ContactStart, capture?: () => void) => {
    if (
      stack.active &&
      !gesture.current &&
      !(e.target as Element).closest('[data-ink-resize]') &&
      e.button === 0 &&
      (e.pointerType !== 'touch' || (!playingVideo && (fingerInk || tool === 'laser'))) &&
      effectiveTool(tool, pencilTool, e.pointerType, fingerInk) !== 'hand'
    ) {
      const box = viewport.current!.getBoundingClientRect();
      const target = stack.pageAtPointer(e.clientX - box.left, e.clientY - box.top, view.current);
      if (!target) return;
      if (target.page.id !== page.id) flushSync(() => stack.focus(target, view.current));
    }
    currentDown.current(e, capture);
  };
  const finishStroke = (g: NonNullable<typeof gesture.current>) => {
    if (gesture.current !== g) return;
    gesture.current = null;
    if (g.pencil) {
      const { touchId, pointerId, shortTouchEnd } = g.pencil;
      const recoveredEndpoint = !!shortTouchEnd && g.points.length === 1;
      if (recoveredEndpoint) g.points.push(shortTouchEnd);
      if (pencilDiagnostics) {
        const last = g.points.at(-1)!;
        pencilDiagnostics.finishStroke({
          pointerId,
          touchId,
          pointCount: g.points.length,
          recoveredEndpoint,
          recoveredStart: g.pencil.recoveredStart,
          dx: ((last.x - g.start.x) * g.paperRect.width) / page.width,
          dy: ((last.y - g.start.y) * g.paperRect.height) / page.height,
        });
      }
      const now = performance.now();
      if (pointerId !== undefined) palm.current.penUp(pointerId, now);
      if (touchId !== undefined && stylusContact.current === touchId) {
        stylusContact.current = null;
        palm.current.penUp(nativePencil, now);
      }
    }
    const stroke = g.stroke!;
    onChange(g.pageId, (prev) => ({ ...prev, strokes: [...prev.strokes, stroke] }));
    clearInkGesture();
  };
  const endPencil = (
    g: NonNullable<typeof gesture.current>,
    source: 'pointer' | 'touch',
    time: number,
    waitForShortTouch = false,
  ) => {
    const pencil = g.pencil!;
    pencil.endAt = Math.min(pencil.endAt ?? Infinity, time);
    if (source === 'pointer') pencil.pointerEnded = true;
    else pencil.touchEnded = true;
    const waiting =
      source === 'pointer'
        ? !pencil.touchEnded && (pencil.touchId !== undefined || waitForShortTouch)
        : pencil.pointerId !== undefined && !pencil.pointerEnded;
    if (!waiting) {
      finishStroke(g);
    } else if (!pencilFinish.current) {
      // Give the second input event a turn to deliver confirmed contact samples.
      const finish = () => finishStroke(g);
      pencilFinish.current = { finish, timer: setTimeout(finish, 24) };
    }
  };
  const endTouchPointerForPencil = (id: number, time: number) => {
    const g = gesture.current;
    if (g?.pencil?.touchId === id && !g.pencil.pointerEnded) endPencil(g, 'pointer', time);
  };
  const preparePencil = () => {
    stopCoast();
    swipe.current = null;
    nativePinch.current = null;
    const g = gesture.current;
    if (g?.pointerType === 'touch') {
      if (g.kind === 'pan') moveView(view.current.zoom, g.pan);
      gesture.current = null;
      clearInkGesture();
    }
    if (interacting.current) commitView(false);
    touches.current.clear();
    pinch.current = null;
    tap.current = null;
  };
  const writingTool = effectiveTool(tool, pencilTool, 'pen', fingerInk);
  const writingWithPencil = writingTool === 'pen' || writingTool === 'highlighter';
  useLayoutEffect(() => {
    const stage = viewport.current;
    if (!stage || !writingWithPencil) return;
    // Claim Pencil taps at the DOM target before Safari interprets nearby
    // contacts as a system gesture. Let the normal ink handlers receive them.
    const claimPencilTap = (event: TouchEvent) => {
      if (!event.cancelable) return;
      for (const touch of Array.from(event.changedTouches)) {
        const { touchType } = touch as StylusTouch;
        const knownEnd =
          !touchType && event.type === 'touchend' && touch.identifier === stylusContact.current;
        if (touchType !== 'stylus' && !knownEnd) continue;
        const target = touch.target ?? event.target;
        if (
          target instanceof Element &&
          !target.closest('.video-box,[data-video-control],[data-selection-control]')
        ) {
          event.preventDefault();
          return;
        }
      }
    };
    const options = { capture: true, passive: false };
    stage.addEventListener('touchstart', claimPencilTap, options);
    stage.addEventListener('touchend', claimPencilTap, options);
    return () => {
      stage.removeEventListener('touchstart', claimPencilTap, true);
      stage.removeEventListener('touchend', claimPencilTap, true);
    };
  }, [writingWithPencil]);
  const startPencil = (e: ContactStart, source: 'pointer' | 'touch', capture?: () => void) => {
    const g = gesture.current;
    const pencil = g?.pencil;
    const otherId = source === 'pointer' ? pencil?.touchId : pencil?.pointerId;
    const ownId = source === 'pointer' ? pencil?.pointerId : pencil?.touchId;
    const lateStart =
      g &&
      pencil &&
      ownId === e.pointerId &&
      !pencil.confirmedStart &&
      pencil.recoveredStart === (source === 'pointer' ? 'pointermove' : 'touchmove') &&
      !pencil.pointerEnded &&
      !pencil.touchEnded &&
      (e.timeStamp <= pencil.downAt ||
        (e.timeStamp - pencil.downAt <= 48 &&
          Math.hypot(g.client.x - e.clientX, g.client.y - e.clientY) <= 6));
    if (lateStart) {
      pencil.confirmedStart = true;
      capture?.();
      return;
    }
    const companion =
      g &&
      pencil &&
      ownId === undefined &&
      otherId !== undefined &&
      !pencil.pointerEnded &&
      !pencil.touchEnded &&
      (otherId === e.pointerId ||
        (performance.now() - g.started < 48 &&
          Math.hypot(g.client.x - e.clientX, g.client.y - e.clientY) <= 6));
    if (companion) {
      capture?.();
    } else {
      if (g?.pencil) finishStroke(g);
      preparePencil();
      downOnPage(e, capture);
    }
    const active = gesture.current;
    if (!active || active.kind !== 'draw' || active.pointerType !== 'pen') return;
    const contact = (active.pencil ??= { downAt: e.timeStamp });
    if (source === 'pointer') {
      contact.pointerId = e.pointerId;
      contact.downAt = e.timeStamp;
      palm.current.penDown(e.pointerId, performance.now());
    } else {
      contact.touchId = e.pointerId;
      contact.touchDownAt = e.timeStamp;
      stylusContact.current = e.pointerId;
      palm.current.penDown(nativePencil, performance.now());
    }
  };
  const recoverPencil = (e: ContactStart, source: 'pointer' | 'touch') => {
    if (
      !writingWithPencil ||
      (e.target as Element).closest(
        'button, a, input, select, textarea, .video-box, [data-video-control], [data-ink-resize], [data-selection-control]',
      )
    )
      return;
    const pencil = gesture.current?.pencil;
    if (pencil) {
      // An active contact on the companion stream can verify a missing start on this stream.
      const own = source === 'pointer' ? pencil.pointerId : pencil.touchId;
      const other = source === 'pointer' ? pencil.touchId : pencil.pointerId;
      if (
        own !== undefined ||
        other !== e.pointerId ||
        pencil.pointerEnded ||
        pencil.touchEnded ||
        e.timeStamp < pencil.downAt
      )
        return;
    } else {
      if (
        knownPencilIds.current.has(e.pointerId) ||
        e.timeStamp <= latestPencilEnd.current ||
        gesture.current
      )
        return;
      if (!stack.active) {
        const r = paper.current!.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
          return;
      }
    }
    startPencil(e, source);
    if (!pencil && gesture.current?.pencil)
      gesture.current.pencil.recoveredStart = source === 'pointer' ? 'pointermove' : 'touchmove';
  };
  const move = (e: ReactPointerEvent) => {
    if (
      e.pointerType === 'pen' &&
      (e.buttons & 1) !== 0 &&
      gesture.current?.pencil?.pointerId === undefined
    ) {
      const sample =
        e.nativeEvent
          .getCoalescedEvents?.()
          .find(
            (p) =>
              (p.pointerId === undefined || p.pointerId === e.pointerId) &&
              (p.buttons & 1) !== 0 &&
              p.timeStamp <= e.timeStamp,
          ) ?? e;
      recoverPencil(
        {
          pointerId: e.pointerId,
          pointerType: 'pen',
          button: 0,
          target: e.target,
          clientX: sample.clientX,
          clientY: sample.clientY,
          pressure: sample.pressure,
          timeStamp: sample.timeStamp,
        },
        'pointer',
      );
    }
    showEraser(e);
    const initial = tap.current?.starts.get(e.pointerId);
    if (initial && Math.hypot(e.clientX - initial.x, e.clientY - initial.y) > 12)
      tap.current!.cancelled = true;
    if (touches.current.has(e.pointerId))
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === 'touch' && nativePinch.current) return;
    if (pinch.current && touches.current.size >= 2) {
      const [a, b] = [...touches.current.values()];
      movePinch(pinch.current, a, b);
      return;
    }
    const g = gesture.current;
    if (!g || (g.pencil ? g.pencil.pointerId !== e.pointerId : g.id !== e.pointerId)) {
      if (tool === 'laser' && e.pointerType === 'pen')
        lasers.current.push({ ...point(e), t: performance.now() });
      return;
    }
    if (g.kind === 'pan') {
      if (Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) >= 5) g.moved = true;
      if (tool === 'select' && e.pointerType === 'touch' && !g.moved) return;
      if (!interacting.current) beginView();
      const next = limit({
        x: g.pan.x + e.clientX - g.client.x,
        y: g.pan.y + e.clientY - g.client.y,
      });
      moveView(view.current.zoom, next);
      if (g.panHistory) recordPan(g.panHistory, next, e.timeStamp);
      return;
    }
    if (g.kind === 'laser') {
      lasers.current.push({ ...point(e), t: performance.now() });
      return;
    }
    if (g.kind === 'draw') {
      if (g.pencil) {
        if (!g.pencil.pointerEnded && !g.pencil.touchEnded && appendPencilSamples(e.nativeEvent, g))
          previewPencilStroke(g.stroke!);
      } else {
        const before = g.points.length;
        appendSamples(e, g);
        if (g.points.length > before) previewStroke(g.stroke!);
      }
    }
    if (g.kind === 'erase') {
      appendSamples(e, g);
      previewErasure(g.points, g.erasure!.width);
    }
    if (g.kind === 'lasso') {
      g.points.push(point(e));
      setLasso([...g.points]);
    }
    if (g.kind === 'move' || g.kind === 'resize') setSelectionPreview(dragSelection(g, e));
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
    if (!g || (g.pencil ? g.pencil.pointerId !== e.pointerId : g.id !== e.pointerId)) return;
    if (g.pencil) {
      if (!g.pencil.pointerEnded && e.timeStamp >= g.pencil.downAt) {
        if (!cancel) appendPencilSamples(e.nativeEvent, g, true);
        endPencil(g, 'pointer', e.timeStamp, !cancel && g.points.length === 1);
      }
      return;
    }
    if (g.kind === 'draw' && !cancel) {
      finishStroke(g);
      return;
    }
    gesture.current = null;
    if (g.kind === 'pan') {
      if (cancel || g.pointerType !== 'touch') {
        if (interacting.current) commitView();
      } else {
        const dx = e.clientX - g.client.x;
        const dy = e.clientY - g.client.y;
        const stationary = !g.moved && Math.hypot(dx, dy) < 5;
        if (
          g.playbackTap &&
          g.playbackTap === playingVideo &&
          stationary &&
          performance.now() - g.started < 500
        ) {
          closePlayback(g.playbackTap);
          setSelectedVideo(g.playbackTap);
          if (interacting.current) commitView();
        } else if (tool === 'select' && stationary) {
          selectAt(g.start, g.original);
          if (interacting.current) commitView();
        } else if (!turnBySwipe(dx, dy)) finishPan(g.panHistory, e.timeStamp);
      }
      clearInkGesture();
      return;
    }
    if (!cancel) {
      // Commit event-time data, never React's potentially deferred pointermove render.
      if (g.kind === 'move' || g.kind === 'resize') {
        const transform = dragSelection(g, e);
        if (transform) commitSelection(g.selection, transform);
      }
      if (g.kind === 'erase') {
        const p = point(e),
          last = g.points.at(-1)!;
        if (Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) g.points.push(p);
        onChange(page.id, (prev) => {
          const strokes = applyErasure(prev.strokes, { ...g.erasure!, points: g.points });
          return strokes === prev.strokes ? prev : { ...prev, strokes };
        });
      }
      if (g.kind === 'lasso') {
        g.points.push(point(e));
        const radius = 5 / screenScale();
        if (g.points.every((p) => Math.hypot(p.x - g.start.x, p.y - g.start.y) < radius)) {
          selectAt(g.start, g.original);
        } else setSelection(lassoStrokes(g.original, g.points).map((stroke) => stroke.id));
      }
    }
    clearInkGesture();
  };
  const endNativePencil = (e: React.TouchEvent, cancel = false) => {
    const g = gesture.current;
    const pencil = g?.pencil;
    const contacts = Array.from(e.changedTouches);
    const contact = contacts.find(
      (t) => t.identifier === stylusContact.current || (t as StylusTouch).touchType === 'stylus',
    );
    if (!contact) return false;
    if (stylusContact.current === contact.identifier) {
      stylusContact.current = null;
      palm.current.penUp(nativePencil, performance.now());
    }
    if (
      g &&
      pencil &&
      !pencil.touchEnded &&
      (pencil.touchId ?? pencil.pointerId) === contact.identifier
    ) {
      const elapsed = e.timeStamp - (pencil.touchDownAt ?? pencil.downAt);
      const distance = Math.hypot(contact.clientX - g.client.x, contact.clientY - g.client.y);
      if (
        !cancel &&
        !pencil.recoveredStart &&
        g.points.length === 1 &&
        elapsed >= 0 &&
        elapsed <= 120 &&
        distance > 1 &&
        distance <= 16
      ) {
        // The identified native contact can be the only source of an endpoint for a tiny mark.
        pencil.shortTouchEnd = { ...point(contact, g.paperRect), p: g.start.p };
      }
      endPencil(g, 'touch', e.timeStamp);
    }
    return true;
  };
  const renderVideos = (owner: Page, ownerFit: number, offsetY = 0) => {
    const scale = ownerFit * zoom;
    const left = owner.width / 2 - (size.w / 2 + pan.x) / scale;
    const top = owner.height / 2 - (size.h / 2 + pan.y + offsetY * zoom) / scale;
    const visibleBounds = { left, top, right: left + size.w / scale, bottom: top + size.h / scale };
    return owner.videos.map((v: Video) => {
      const key = `${owner.id}:${v.id}`;
      return (
        <VideoBox
          key={key}
          video={v}
          page={owner}
          selected={selectedVideo === key}
          playing={playingVideo === key}
          playbackKey={key}
          controls={videoControls}
          onSelect={() => setSelectedVideo(key)}
          onDeselect={() => setSelectedVideo(null)}
          onPlay={() => setPlayingVideo(key)}
          onClosePlayback={closePlayback}
          registerPlayback={registerPlayback}
          pageScale={ownerFit}
          displayZoom={zoom}
          visibleBounds={visibleBounds}
          onChange={(next) =>
            onChange(owner.id, (prev) => ({
              ...prev,
              videos: prev.videos.map((item) => (item.id === next.id ? next : item)),
            }))
          }
          onDelete={() =>
            onChange(owner.id, (prev) => ({
              ...prev,
              videos: prev.videos.filter((item) => item.id !== v.id),
            }))
          }
        />
      );
    });
  };
  const displayScale = fit * zoom;
  const paperOrigin = {
    x: (size.w - page.width * displayScale) / 2 + pan.x,
    y: (size.h - page.height * displayScale) / 2 + pan.y,
  };
  const toScreen = (p: Position) => ({
    x: paperOrigin.x + p.x * displayScale,
    y: paperOrigin.y + p.y * displayScale,
  });
  const frame =
    selectionShape &&
    (() => {
      const { left, top, right, bottom } = selectionShape.bounds;
      const { scale, x, y } = selectionPreview ?? { scale: 1, x: 0, y: 0 };
      const start = toScreen({ x: left * scale + x, y: top * scale + y });
      return {
        left: start.x - 5,
        top: start.y - 5,
        width: (right - left) * scale * displayScale + 10,
        height: (bottom - top) * scale * displayScale + 10,
      };
    })();
  return (
    <div
      className={`stage tool-${tool}`}
      ref={viewport}
      data-testid="stage"
      onPointerDownCapture={(e) => {
        const target = e.target as Element;
        if (e.pointerType === 'pen') {
          if (
            !writingWithPencil ||
            target.closest('.video-box,[data-video-control],[data-selection-control]')
          )
            preparePencil();
          palm.current.penDown(e.pointerId, performance.now());
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
          return;
        } else if (
          stopCoast() &&
          (e.pointerType !== 'touch' ||
            fingerInk ||
            tool === 'laser' ||
            tool === 'select' ||
            target.closest('.video-box,[data-video-control],[data-selection-control]'))
        ) {
          commitView(false);
        }
        if (selectedVideo && !target.closest('.video-box,[data-video-control]'))
          setSelectedVideo(null);
      }}
      onPointerMoveCapture={(e) => {
        if (e.pointerType !== 'touch') return;
        const g = gesture.current;
        if (g?.pencil?.touchId === e.pointerId && !g.pencil.touchEnded) {
          // The matching native stylus contact is stronger evidence than pointerType.
          if (!g.pencil.pointerEnded && appendPencilSamples(e.nativeEvent, g))
            previewPencilStroke(g.stroke!);
          e.preventDefault();
          e.stopPropagation();
        } else if (!palm.current.allowsTouch(e.pointerId)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onPointerUpCapture={(e) => {
        if (e.pointerType === 'pen') palm.current.penUp(e.pointerId, performance.now());
        if (e.pointerType === 'touch') {
          endTouchPointerForPencil(e.pointerId, e.timeStamp);
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
        if (e.pointerType === 'touch') {
          endTouchPointerForPencil(e.pointerId, e.timeStamp);
          palm.current.touchUp(e.pointerId);
        }
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
      onPointerDown={(e) => {
        const capture = () => e.currentTarget.setPointerCapture(e.pointerId);
        if (e.pointerType === 'pen' && writingWithPencil) startPencil(e, 'pointer', capture);
        else {
          pencilFinish.current?.finish();
          downOnPage(e, capture);
        }
      }}
      onTouchStart={(e) => {
        const stylus = Array.from(e.changedTouches).find(
          (contact) => (contact as StylusTouch).touchType === 'stylus',
        );
        if (stylus) {
          const target = e.target as Element;
          if (
            writingWithPencil &&
            !target.closest('.video-box,[data-video-control],[data-selection-control]')
          ) {
            startPencil(
              {
                target,
                pointerId: stylus.identifier,
                pointerType: 'pen',
                button: 0,
                clientX: stylus.clientX,
                clientY: stylus.clientY,
                pressure: (stylus as StylusTouch).force || 0,
                timeStamp: e.timeStamp,
              },
              'touch',
            );
          } else stylusContact.current = stylus.identifier;
          return;
        }
        const { pan } = view.current;
        const contacts = Array.from(e.touches) as Array<
          (typeof e.touches)[0] & { radiusX?: number; radiusY?: number; touchType?: string }
        >;
        const interactive = (e.target as Element).closest(
          '.video-box,[data-video-control],[data-selection-control]',
        );
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
            const [a, b] = contacts;
            nativePinch.current = {
              ...startPinch({ x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY }),
              ids: [a.identifier, b.identifier],
              starts: new Map(contacts.map((t) => [t.identifier, { x: t.clientX, y: t.clientY }])),
              ending: false,
            };
            gesture.current = null;
            pinch.current = null;
            clearInkGesture();
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
          gesture.current?.kind === 'move' ||
          gesture.current?.kind === 'resize' ||
          palm.current.blocksNavigation(performance.now(), palmRejection)
        ) {
          swipe.current = null;
          if (stopCoast()) commitView(false);
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
          pan,
          panning: false,
          history: [{ ...pan, time: e.timeStamp }],
          interrupted: stopCoast(),
        };
      }}
      onTouchMove={(e) => {
        const contact = Array.from(e.changedTouches).find(
          (t) =>
            t.identifier === stylusContact.current || (t as StylusTouch).touchType === 'stylus',
        );
        if (contact) {
          if (
            stylusContact.current !== contact.identifier &&
            (contact as StylusTouch).touchType === 'stylus' &&
            Array.from(e.touches ?? []).some((t) => t.identifier === contact.identifier)
          ) {
            recoverPencil(
              {
                pointerId: contact.identifier,
                pointerType: 'pen',
                button: 0,
                target: contact.target ?? e.target,
                clientX: contact.clientX,
                clientY: contact.clientY,
                pressure: (contact as StylusTouch).force ?? 0,
                timeStamp: e.timeStamp,
              },
              'touch',
            );
          }
          const g = gesture.current;
          const pencil = g?.pencil;
          if (
            g &&
            pencil?.touchId === contact.identifier &&
            !pencil.touchEnded &&
            e.timeStamp >= (pencil.touchDownAt ?? pencil.downAt) &&
            e.timeStamp <= (pencil.endAt ?? Infinity)
          ) {
            const p = point(
              {
                clientX: contact.clientX,
                clientY: contact.clientY,
                pointerType: 'pen',
                pressure: (contact as StylusTouch).force || g.points.at(-1)!.p,
              },
              g.paperRect,
            );
            const spacing = 0.25 / screenScale();
            const packet = pencil.lastPointerPacket;
            const repeatsPointer =
              packet &&
              performance.now() - packet.receivedAt < 8 &&
              packet.points.some(
                (sample) => Math.hypot(sample.x - p.x, sample.y - p.y) <= spacing * 2,
              );
            if (!repeatsPointer && appendPencilPoint(g.points, p)) {
              pencil.lastWasTouch = true;
              previewPencilStroke(g.stroke!);
            }
          }
          return;
        }
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
          movePinch(n, { x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY });
          return;
        }
        const g = swipe.current;
        if (!g || gesture.current?.kind === 'move' || gesture.current?.kind === 'resize') return;
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
          if (!gesture.current && (stack.active || view.current.zoom > 1 || fitWidth)) {
            if (!interacting.current) beginView();
            g.panning = true;
            const next = limit({ x: g.pan.x + t.clientX - g.x, y: g.pan.y + t.clientY - g.y });
            moveView(view.current.zoom, next);
            recordPan(g.history, next, e.timeStamp);
          }
        }
      }}
      onTouchEnd={(e) => {
        if (endNativePencil(e)) return;
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
        if (palm.current.blocksNavigation(performance.now(), palmRejection)) {
          if ((g.panning || g.interrupted) && interacting.current) commitView();
          return;
        }
        const turned = turnBySwipe((t.clientX || g.lastX) - g.x, (t.clientY || g.lastY) - g.y);
        if (!turned && (g.panning || g.interrupted)) finishPan(g.history, e.timeStamp);
      }}
      onTouchCancel={(e) => {
        if (endNativePencil(e, true)) return;
        if ((swipe.current?.panning || swipe.current?.interrupted) && interacting.current)
          commitView();
        swipe.current = null;
        if (nativePinch.current) {
          if (interacting.current) commitView();
          nativePinch.current = null;
          touches.current.clear();
          pinch.current = null;
          tap.current = null;
          if (gesture.current?.pointerType === 'touch') gesture.current = null;
          clearInkGesture();
        }
      }}
      onPointerMove={move}
      onPointerLeave={hideEraser}
      onPointerUp={(e) => up(e)}
      onPointerCancel={(e) => up(e, true)}
      onLostPointerCapture={(e) => {
        const pencil = gesture.current?.pencil;
        if (e.target === e.currentTarget && !(pencil?.touchId !== undefined && !pencil.touchEnded))
          up(e, true);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {stack.active && (
        <div ref={stack.paperLayer} className="stack-board" aria-hidden="true">
          {stack.nearby.map((item) => (
            <div
              key={item.page.id}
              className="stack-paper"
              data-current={item.page.id === page.id}
              style={{
                left: (-item.page.width * item.fit) / 2,
                top: item.top - stack.active!.center,
                width: item.page.width * item.fit,
                height: item.page.height * item.fit,
              }}
            >
              <PageStackPreview
                page={item.page}
                fit={item.fit}
                active={item.page.id === page.id}
                shouldPause={pdfBusy}
                shouldPausePdf={stackPdfBusy}
              />
            </div>
          ))}
        </div>
      )}
      <div
        ref={backdrop}
        className="pdf-backdrop"
        aria-hidden="true"
        style={{
          width: page.width * fit,
          height: page.height * fit,
          visibility:
            stack.active && pdfCanvas.current?.dataset.page !== page.id ? 'hidden' : undefined,
        }}
      >
        <canvas ref={pdfCanvas} className="pdf-canvas" />
      </div>
      <div ref={detail} className="pdf-detail-layer" aria-hidden="true" />
      <canvas ref={inkCanvas} className="ink-canvas" data-testid="ink-canvas" aria-hidden="true" />
      <canvas ref={draftCanvas} className="ink-draft-canvas" aria-hidden="true" />
      <div ref={liveInk} className="ink-live-layer" aria-hidden="true" />
      <div
        ref={paper}
        className="pdf-page"
        data-video-paper=""
        data-testid="pdf-page"
        style={{
          width: page.width * fit,
          height: page.height * fit,
        }}
      >
        <canvas ref={inkPreview} className="ink-page-preview" aria-hidden="true" />
        {!stack.active && renderVideos(page, fit)}
        {loading && (!stack.active || !pdfCanvas.current?.dataset.page) && (
          <div className="pdf-loading">ページを読み込み中…</div>
        )}
      </div>
      {stack.active && (
        <div ref={stack.videoLayer} className="stack-board stack-video-board">
          {stack.nearby
            .filter((item) => item.page.videos.length)
            .map((item) => (
              <div
                key={item.page.id}
                className="stack-video-paper"
                data-video-paper=""
                style={{
                  left: (-item.page.width * item.fit) / 2,
                  top: item.top - stack.active!.center,
                  width: item.page.width * item.fit,
                  height: item.page.height * item.fit,
                }}
              >
                {renderVideos(item.page, item.fit, item.center - stack.active!.center)}
              </div>
            ))}
        </div>
      )}
      <div ref={setVideoControls} className="stage-video-controls" />
      <canvas ref={laserCanvas} className="laser-canvas" />
      <div
        ref={eraserCursor}
        className="eraser-cursor"
        data-testid="eraser-cursor"
        aria-hidden="true"
      />
      {tool === 'select' && (
        <InkSelectionControls
          frame={frame}
          anchor={pasteAnchor && toScreen(pasteAnchor)}
          viewport={size}
          dragging={!!selectionPreview}
          onResize={resizeSelection}
          onCopy={copySelection}
          onDuplicate={duplicateSelection}
          onRemove={removeSelection}
          onPaste={inkClipboard.length ? pasteSelection : undefined}
        />
      )}
      <div className="stage-note">
        {tool === 'laser'
          ? '触れて動かすとレーザーを表示'
          : tool === 'select'
            ? inkClipboard.length
              ? '空白をタップして貼り付け先を指定'
              : '線を囲むかタップして選択'
            : zoom > 1
              ? '2本指で移動・ピンチで拡大縮小'
              : fingerInk
                ? '指でも筆記できます · 2本指で拡大縮小'
                : stack.active
                  ? 'Pencilで筆記 · 指で上下にスクロール'
                  : 'Pencilで筆記 · 指でページ送り · 2本指で拡大縮小'}
      </div>
    </div>
  );
}
