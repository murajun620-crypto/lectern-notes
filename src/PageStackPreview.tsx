import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Page } from './model';
import { drawStrokes } from './model';
import { renderPage } from './pdf';

/** Reuse the same page-space rendering for neighbors while the focused page stays interactive. */
export default function PageStackPreview({
  page,
  fit,
  active,
}: {
  page: Page;
  fit: number;
  active: boolean;
}) {
  const pdf = useRef<HTMLCanvasElement>(null);
  const ink = useRef<HTMLCanvasElement>(null);
  const { id, width, height, sourcePage, assetId, strokes } = page;
  const scale = Math.min(fit * (devicePixelRatio || 1), 1200 / Math.max(width, height));
  useEffect(() => {
    const canvas = pdf.current!;
    const temp = document.createElement('canvas');
    const abort = new AbortController();
    void renderPage({ width, height, sourcePage, assetId }, temp, scale, abort.signal)
      .then(() => {
        if (abort.signal.aborted) return;
        canvas.width = temp.width;
        canvas.height = temp.height;
        canvas.getContext('2d')?.drawImage(temp, 0, 0);
      })
      .catch(() => {
        /* The full renderer reports errors when this page becomes active. */
      })
      .finally(() => {
        temp.width = temp.height = 1;
      });
    return () => abort.abort();
  }, [id, width, height, sourcePage, assetId, scale]);

  useLayoutEffect(() => {
    const canvas = ink.current!;
    canvas.width = strokes.length ? Math.max(1, Math.round(width * scale)) : 1;
    canvas.height = strokes.length ? Math.max(1, Math.round(height * scale)) : 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(scale, scale);
    drawStrokes(ctx, strokes);
  }, [id, width, height, scale, strokes]);

  return (
    <>
      <canvas ref={pdf} className="stack-pdf-canvas" />
      <canvas ref={ink} className="stack-ink-canvas" hidden={active} />
    </>
  );
}
