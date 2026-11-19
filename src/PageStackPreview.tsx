import { memo, useEffect, useRef } from 'react';
import type { Page } from './model';
import { drawStrokes } from './model';
import { renderPage } from './pdf';

/** Reuse the same page-space rendering for neighbors while the focused page stays interactive. */
export default memo(function PageStackPreview({
  page,
  fit,
  active,
  shouldPause,
  shouldPausePdf,
}: {
  page: Page;
  fit: number;
  active: boolean;
  shouldPause: () => boolean;
  shouldPausePdf: () => boolean;
}) {
  const pdf = useRef<HTMLCanvasElement>(null);
  const ink = useRef<HTMLCanvasElement>(null);
  const { id, width, height, sourcePage, assetId, strokes } = page;
  const scale = Math.min(fit * (devicePixelRatio || 1), 1200 / Math.max(width, height));
  useEffect(() => {
    if (active) return;
    const canvas = pdf.current!;
    const temp = document.createElement('canvas');
    const abort = new AbortController();
    void renderPage(
      { width, height, sourcePage, assetId },
      temp,
      scale,
      abort.signal,
      undefined,
      shouldPausePdf,
    )
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
  }, [id, width, height, sourcePage, assetId, scale, active, shouldPausePdf]);

  useEffect(() => {
    const canvas = ink.current!;
    if (!strokes.length) {
      if (canvas.width !== 1) canvas.width = 1;
      if (canvas.height !== 1) canvas.height = 1;
      return;
    }
    if (active) return;
    let timer: ReturnType<typeof setTimeout>;
    const paint = () => {
      if (shouldPause()) {
        timer = setTimeout(paint, 80);
        return;
      }
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(scale, scale);
      drawStrokes(ctx, strokes);
    };
    timer = setTimeout(paint, 80);
    return () => clearTimeout(timer);
  }, [id, width, height, scale, strokes, active, shouldPause]);

  return (
    <>
      <canvas ref={pdf} className="stack-pdf-canvas" />
      <canvas ref={ink} className="stack-ink-canvas" />
    </>
  );
});
