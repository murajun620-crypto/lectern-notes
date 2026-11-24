import { useEffect, useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { TextLayer } from 'pdfjs-dist';
import type { PDFPageProxy, TextContent } from 'pdfjs-dist/types/src/display/api';
import type { Page } from './model';
import { getPdf } from './pdf';

function streamPageText(page: PDFPageProxy) {
  const text = page.streamTextContent();
  const unit = page.userUnit;
  if (unit === 1) return text;

  // PDF.js 4.10 scales raw viewport dimensions by UserUnit, while text items use PDF units.
  return text.pipeThrough(
    new TransformStream<TextContent, TextContent>({
      transform(content, output) {
        const items = content.items.map((item) =>
          'str' in item
            ? {
                ...item,
                transform: item.transform.map((value) => value * unit),
                width: item.width * unit,
                height: item.height * unit,
              }
            : item,
        );
        output.enqueue({ ...content, items });
      },
    }),
  );
}

export default function PDFTextLayer({
  page: { assetId, sourcePage },
  scale,
}: {
  page: Pick<Page, 'assetId' | 'sourcePage'>;
  scale: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const fittingScale = useRef(scale);
  const updateViewport = useRef<((scale: number) => void) | null>(null);

  useLayoutEffect(() => {
    fittingScale.current = scale;
    updateViewport.current?.(scale);
  }, [scale]);

  useEffect(() => {
    const element = container.current;
    if (!element || !assetId || sourcePage === undefined) return;

    let cancelled = false;
    let layer: TextLayer | undefined;
    const render = async () => {
      const pdfPage = await (await getPdf(assetId)).getPage(sourcePage);
      if (cancelled) return;

      layer = new TextLayer({
        textContentSource: streamPageText(pdfPage),
        container: element,
        viewport: pdfPage.getViewport({ scale: fittingScale.current }),
      });
      const textLayer = layer;
      await textLayer.render();
      if (cancelled) return;
      updateViewport.current = (nextScale) =>
        textLayer.update({ viewport: pdfPage.getViewport({ scale: nextScale }) });
      updateViewport.current(fittingScale.current);
    };
    void render().catch(() => {
      if (!cancelled) element.replaceChildren();
    });

    return () => {
      cancelled = true;
      updateViewport.current = null;
      layer?.cancel();
      element.replaceChildren();
    };
  }, [assetId, sourcePage]);

  if (!assetId || sourcePage === undefined) return null;
  return (
    <div
      ref={container}
      className="pdf-text-layer"
      data-testid="pdf-text-layer"
      style={
        {
          '--scale-factor': scale,
          '--scale-round-x': '0.001px',
          '--scale-round-y': '0.001px',
        } as CSSProperties
      }
    />
  );
}
