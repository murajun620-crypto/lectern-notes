import { useEffect, useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { TextLayer } from 'pdfjs-dist';
import type { PDFPageProxy, TextContent } from 'pdfjs-dist/types/src/display/api';
import { parseYoutubeUrl, type Page } from './model';
import { getPdf } from './pdf';

type TextLink = { url: string; ranges: Range[] };
type LinkArea = { url: string; left: number; top: number; right: number; bottom: number };
type PageLinks = { pageId: string; text: TextLink[]; annotations: LinkArea[] };
const linksByLayer = new WeakMap<HTMLElement, PageLinks>();

function* printedYoutubeUrls(text: string) {
  // The prefix prevents picking up a YouTube-looking substring inside another hostname or URL.
  const address =
    /(^|[^\w./@%=?&#_+\-])((?:https?:\/\/)?(?:(?:www|m)\.)?(?:youtu\.be|youtube(?:-nocookie)?\.com)\/[a-z0-9_./~%:?&=#+!$@-]+)/gi;
  for (const match of text.matchAll(address)) {
    const printedUrl = match[2].replace(/[.,;:!?]+$/, '');
    const url = /^https?:\/\//i.test(printedUrl) ? printedUrl : `https://${printedUrl}`;
    if (!parseYoutubeUrl(url)) continue;
    const start = match.index + match[1].length;
    yield { url, start, end: start + printedUrl.length };
  }
}

function printedLinkRanges(element: HTMLElement): TextLink[] {
  const runs: { node: Text; start: number; end: number }[] = [];
  let text = '';
  for (const run of element.querySelectorAll('span:not(.markedContent), br')) {
    if (run.tagName === 'BR') {
      text += '\n';
      continue;
    }
    const node = run.firstChild;
    if (!(node instanceof Text)) continue;
    runs.push({ node, start: text.length, end: text.length + node.length });
    text += node.data;
  }

  const links: TextLink[] = [];
  let first = 0;
  for (const { url, start, end } of printedYoutubeUrls(text)) {
    while (first < runs.length && runs[first].end <= start) first++;
    const ranges: Range[] = [];
    for (let index = first; index < runs.length && runs[index].start < end; index++) {
      const run = runs[index];
      const range = document.createRange();
      range.setStart(run.node, Math.max(0, start - run.start));
      range.setEnd(run.node, Math.min(run.node.length, end - run.start));
      ranges.push(range);
    }
    if (ranges.length) links.push({ url, ranges });
  }
  return links;
}

async function annotationLinkAreas(page: PDFPageProxy) {
  const viewport = page.getViewport({ scale: 1 });
  const links: LinkArea[] = [];
  for (const annotation of await page.getAnnotations({ intent: 'display' })) {
    if (!annotation) continue;
    const { url, subtype, annotationFlags, rect } = annotation;
    // PDF annotation flag 0x02 means hidden, even for results returned with display intent.
    if (
      subtype !== 'Link' ||
      (annotationFlags & 0x02) !== 0 ||
      typeof url !== 'string' ||
      !parseYoutubeUrl(url) ||
      !Array.isArray(rect) ||
      rect.length !== 4 ||
      !rect.every(Number.isFinite)
    )
      continue;
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(rect);
    if (x1 === x2 || y1 === y2) continue;
    links.push({
      url,
      left: Math.min(x1, x2) / viewport.width,
      top: Math.min(y1, y2) / viewport.height,
      right: Math.max(x1, x2) / viewport.width,
      bottom: Math.max(y1, y2) / viewport.height,
    });
  }
  return links;
}

function inside(
  rect: Pick<DOMRectReadOnly, 'left' | 'top' | 'right' | 'bottom'>,
  x: number,
  y: number,
) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export function hitPdfYoutubeLink(stage: HTMLElement, x: number, y: number) {
  for (const layer of stage.querySelectorAll<HTMLElement>('.pdf-text-layer[data-pdf-youtube]')) {
    const targets = linksByLayer.get(layer);
    if (!targets) continue;
    const box = layer.getBoundingClientRect();
    if (!box.width || !box.height || !inside(box, x, y)) continue;

    const annotation = targets.annotations.find((area) =>
      inside(area, (x - box.left) / box.width, (y - box.top) / box.height),
    );
    if (annotation) return { pageId: targets.pageId, url: annotation.url };
    for (const link of targets.text)
      for (const range of link.ranges)
        for (const rect of range.getClientRects())
          if (inside(rect, x, y)) return { pageId: targets.pageId, url: link.url };
  }
}

function scalePageText(content: TextContent, unit: number): TextContent {
  if (unit === 1) return content;
  // PDF.js 4.10 scales raw viewport dimensions by UserUnit, while text items use PDF units.
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
  return { ...content, items };
}

function streamPageText(page: PDFPageProxy) {
  const text = page.streamTextContent();
  const unit = page.userUnit;
  if (unit === 1) return text;
  return text.pipeThrough(
    new TransformStream<TextContent, TextContent>({
      transform(content, output) {
        output.enqueue(scalePageText(content, unit));
      },
    }),
  );
}

async function linkTextSource(page: PDFPageProxy) {
  const content = await page.getTextContent();
  const text = content.items
    .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
    .join('');
  if (!printedYoutubeUrls(text).next().done) return scalePageText(content, page.userUnit);
}

export default function PDFTextLayer({
  page: { id: pageId, assetId, sourcePage },
  scale,
  selectable = true,
}: {
  page: Pick<Page, 'id' | 'assetId' | 'sourcePage'>;
  scale: number;
  selectable?: boolean;
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
    const targets: PageLinks = {
      pageId,
      text: [],
      annotations: [],
    };
    linksByLayer.set(element, targets);
    const setLinkMarker = () =>
      element.toggleAttribute(
        'data-pdf-youtube',
        Boolean(targets.text.length || targets.annotations.length),
      );
    const render = async () => {
      const pdfPage = await (await getPdf(assetId)).getPage(sourcePage);
      if (cancelled) return;

      void annotationLinkAreas(pdfPage)
        .then((annotations) => {
          if (cancelled) return;
          targets.annotations = annotations;
          setLinkMarker();
        })
        .catch(() => {});
      // Hand mode only needs rendered runs on pages with printed YouTube URLs.
      const source = selectable ? streamPageText(pdfPage) : await linkTextSource(pdfPage);
      if (cancelled || !source) return;
      layer = new TextLayer({
        textContentSource: source,
        container: element,
        viewport: pdfPage.getViewport({ scale: fittingScale.current }),
      });
      const textLayer = layer;
      await textLayer.render();
      if (cancelled) return;
      updateViewport.current = (nextScale) =>
        textLayer.update({ viewport: pdfPage.getViewport({ scale: nextScale }) });
      updateViewport.current(fittingScale.current);
      targets.text = printedLinkRanges(element);
      setLinkMarker();
    };
    void render().catch(() => {
      if (!cancelled) element.replaceChildren();
    });

    return () => {
      cancelled = true;
      updateViewport.current = null;
      layer?.cancel();
      linksByLayer.delete(element);
      element.removeAttribute('data-pdf-youtube');
      element.removeAttribute('data-main-rotation');
      element.style.removeProperty('width');
      element.style.removeProperty('height');
      element.replaceChildren();
    };
  }, [assetId, pageId, selectable, sourcePage]);

  if (!assetId || sourcePage === undefined) return null;
  return (
    <div
      ref={container}
      className="pdf-text-layer"
      data-testid="pdf-text-layer"
      aria-hidden={selectable ? undefined : true}
      style={
        {
          '--scale-factor': scale,
          '--scale-round-x': '0.001px',
          '--scale-round-y': '0.001px',
          pointerEvents: selectable ? undefined : 'none',
        } as CSSProperties
      }
    />
  );
}
