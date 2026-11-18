import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { clamp, drawStrokes, drawLaser, pointInPolygon, strokeHit, uid } from './model';
import type { Page, Point, Stroke, Tool, Video } from './model';
import { renderPage } from './pdf';
import VideoBox from './VideoBox';
import { effectiveTool, PalmGuard } from './input';
import type { PencilTool } from './input';
type Props = {
  page: Page;
  tool: Tool;
  color: string;
  width: number;
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
    pdfCanvas = useRef<HTMLCanvasElement>(null),
    inkCanvas = useRef<HTMLCanvasElement>(null),
    laserCanvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 700 }),
    [pan, setPan] = useState({ x: 0, y: 0 }),
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
  } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>()),
    pinch = useRef<{ distance: number; zoom: number; anchor: { x: number; y: number } } | null>(
      null,
    );
  const palm = useRef(new PalmGuard());
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
  const scale = fit * zoom;
  const limit = useCallback(
    (next: { x: number; y: number }, z = zoom) => ({
      x: clamp(
        next.x,
        -Math.max(0, (page.width * fit * z - size.w + 40) / 2),
        Math.max(0, (page.width * fit * z - size.w + 40) / 2),
      ),
      y: clamp(
        next.y,
        -Math.max(0, (page.height * fit * z - size.h + 40) / 2),
        Math.max(0, (page.height * fit * z - size.h + 40) / 2),
      ),
    }),
    [fit, page.width, page.height, size, zoom],
  );
  useLayoutEffect(() => {
    const el = viewport.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setSelection([]);
    setWorking(null);
    setDraft(null);
    gesture.current = null;
    touches.current.clear();
    pinch.current = null;
    lasers.current = [];
    tap.current = null;
    swipe.current = null;
  }, [page.id]);
  useEffect(() => {
    const reset = () => {
      palm.current.reset(performance.now());
      gesture.current = null;
      touches.current.clear();
      pinch.current = null;
      tap.current = null;
      swipe.current = null;
      setDraft(null);
      setWorking(null);
      setLasso([]);
    };
    window.addEventListener('blur', reset);
    return () => window.removeEventListener('blur', reset);
  }, []);
  useEffect(() => {
    setPan((p) => limit(p));
  }, [limit]);
  useEffect(() => {
    setSelection([]);
    setLasso([]);
  }, [tool]);
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    setLoading(true);
    const target = pdfCanvas.current!;
    // Render offscreen to prevent overlapping PDF.js jobs during zoom/page changes.
    const temp = document.createElement('canvas');
    const output = Math.min(scale * devicePixelRatio, 4096 / Math.max(page.width, page.height));
    void renderPage(page, temp, output, abort.signal)
      .then(() => {
        if (cancelled) return;
        target.width = temp.width;
        target.height = temp.height;
        target.getContext('2d')!.drawImage(temp, 0, 0);
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setLoading(false);
          onError(`PDF表示: ${(e as Error).message}`);
        }
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [page.id, page.assetId, page.sourcePage, page.width, page.height, scale, onError]);
  useLayoutEffect(() => {
    const canvas = inkCanvas.current!,
      dpr = Math.min(devicePixelRatio, 2),
      s = Math.min(scale * dpr, 4096 / Math.max(page.width, page.height));
    canvas.width = Math.round(page.width * s);
    canvas.height = Math.round(page.height * s);
    const ctx = canvas.getContext('2d')!;
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
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([5 / scale, 4 / scale]);
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
  }, [page, scale, working, draft, lasso, selection]);
  useEffect(() => {
    let frame: number;
    let wasVisible = false;
    const canvas = laserCanvas.current!;
    const output = Math.min(scale * devicePixelRatio, 4096 / Math.max(page.width, page.height));
    canvas.width = Math.round(page.width * output);
    canvas.height = Math.round(page.height * output);
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
      drawLaser(ctx, points, scale, now, trail);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [page.width, page.height, scale, trail]);
  const point = (e: { clientX: number; clientY: number; pressure?: number }): Point => {
    const r = paper.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * page.width,
      y: ((e.clientY - r.top) / r.height) * page.height,
      p: e.pressure && e.pressure > 0 ? e.pressure : 0.5,
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
    onNavigate(dx < 0 ? 1 : -1);
    return true;
  };
  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size === 2) {
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
          page.strokes.some((s) => selection.includes(s.id) && strokeHit(s, p, 18 / scale))
            ? 'move'
            : 'lasso';
      else if (selectedTool === 'eraser') kind = 'erase';
      else if (selectedTool === 'laser') kind = 'laser';
    }
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
        width: selectedTool === 'highlighter' ? width * 5 : width,
        points: [p],
      };
      gesture.current.stroke = s;
      setDraft(s);
    }
    if (kind === 'erase') {
      gesture.current.result = page.strokes.filter((s) => !strokeHit(s, p, 12 / scale));
      setWorking(gesture.current.result);
    }
    if (kind === 'lasso') {
      setSelection([]);
      setLasso([p]);
    }
    if (kind === 'laser') lasers.current.push({ ...p, t: performance.now() });
  };
  const move = (e: ReactPointerEvent) => {
    const initial = tap.current?.starts.get(e.pointerId);
    if (initial && Math.hypot(e.clientX - initial.x, e.clientY - initial.y) > 12)
      tap.current!.cancelled = true;
    if (touches.current.has(e.pointerId))
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && touches.current.size >= 2) {
      const [a, b] = [...touches.current.values()],
        g = pinch.current,
        r = viewport.current!.getBoundingClientRect();
      const z = clamp((g.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / (g.distance || 1), 1, 5);
      setZoom(z);
      setPan(
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
      setPan(limit({ x: g.pan.x + e.clientX - g.client.x, y: g.pan.y + e.clientY - g.client.y }));
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
        const pt = point(sample);
        const last = g.points.at(-1)!;
        if (Math.hypot(pt.x - last.x, pt.y - last.y) > 0.25 / scale) g.points.push(pt);
      }
      setDraft({ ...g.stroke!, points: [...g.points] });
    }
    if (g.kind === 'erase') {
      g.points.push(p);
      g.result = (g.result || g.original).filter((s) => !strokeHit(s, p, 12 / scale));
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
        g.selection!.includes(s.id)
          ? { ...s, points: s.points.map((pt) => ({ ...pt, x: pt.x + dx, y: pt.y + dy })) }
          : s,
      );
      setWorking(g.result);
    }
  };
  const up = (e: ReactPointerEvent, cancel = false) => {
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
    if (pinch.current) {
      if (touches.current.size < 2) pinch.current = null;
      gesture.current = null;
      return;
    }
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
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
          g.selection!.includes(s.id)
            ? { ...s, points: s.points.map((pt) => ({ ...pt, x: pt.x + dx, y: pt.y + dy })) }
            : s,
        );
      }
      if (g.kind === 'erase')
        g.result = (g.result || g.original).filter((s) => !strokeHit(s, point(e), 12 / scale));
      if ((g.kind === 'erase' || g.kind === 'move') && g.result)
        onChange({ ...pageRef.current, strokes: g.result });
      if (g.kind === 'lasso')
        setSelection(
          g.original
            .filter((s) => s.points.some((p) => pointInPolygon(p, g.points)))
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
          const g = gesture.current;
          if (g?.pointerType === 'touch') {
            if (g.kind === 'pan') setPan(g.pan);
            gesture.current = null;
            setDraft(null);
            setWorking(null);
            setLasso([]);
          }
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
        if (
          e.touches.length !== 1 ||
          fingerInk ||
          tool === 'laser' ||
          (e.target as Element).closest('.video-box,.selection-delete') ||
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
          (Math.max(t.radiusX || 0, t.radiusY || 0) * 2 >= 40 && palmRejection)
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
      }}
      onPointerMove={move}
      onPointerUp={(e) => up(e)}
      onPointerCancel={(e) => up(e, true)}
      onLostPointerCapture={(e) => up(e, true)}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) => {
        if (e.ctrlKey || e.metaKey) setZoom(clamp(zoom - e.deltaY * 0.005, 1, 5));
        else if (zoom > 1) setPan(limit({ x: pan.x - e.deltaX, y: pan.y - e.deltaY }));
      }}
    >
      <div
        ref={paper}
        className="pdf-page"
        data-testid="pdf-page"
        style={{
          width: page.width * scale,
          height: page.height * scale,
          transform: `translate(${pan.x}px, ${pan.y}px)`,
        }}
      >
        <canvas ref={pdfCanvas} className="pdf-canvas" />
        <canvas ref={inkCanvas} className="ink-canvas" data-testid="ink-canvas" />
        <canvas ref={laserCanvas} className="laser-canvas" />
        {page.videos.map((v) => (
          <VideoBox
            key={v.id}
            video={v}
            page={page}
            editing={!lecture && tool === 'hand'}
            onChange={changeVideo}
            onDelete={() =>
              onChange({ ...page, videos: page.videos.filter((item) => item.id !== v.id) })
            }
          />
        ))}
        {loading && <div className="pdf-loading">ページを読み込み中…</div>}
      </div>
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
