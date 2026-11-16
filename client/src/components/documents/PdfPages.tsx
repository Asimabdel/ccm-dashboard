// The PDF's pages (pdf.js canvases), each with a layer on top for the boxes and marks.
import { useEffect, useRef, useState } from "react";
import type { PageViewport, PdfDoc } from "@/lib/pdf";
import { cn } from "@/lib/utils";

interface PageProps {
  pdf: PdfDoc;
  /** A tool is in hand: the page shows a crosshair, and a click (or a drag, to set the size) adds a box. */
  drawing: boolean;
  /** A plain click on the page (no tool in hand). */
  onPageClick: (page: number) => void;
  /** A tool was used on the page: where it started and ended, in page pixels (the same point twice for a click). */
  onDraw: (page: number, vp: PageViewport, x0: number, y0: number, x1: number, y1: number) => void;
  /** The mouse is over this page (where a pasted box goes). */
  onHover?: (page: number) => void;
  overlay: (page: number, vp: PageViewport) => React.ReactNode;
}

export function Pages({ count, zoom, ...rest }: PageProps & { count: number; zoom: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const pageWidth = Math.max(280, Math.min(width - 8, 900) * zoom);
  return (
    <div ref={box} className="overflow-x-auto rounded-xl bg-slate-100 p-2 dark:bg-slate-900/60">
      {width > 0 && Array.from({ length: count }, (_, i) => <PdfPage key={i} index={i} width={pageWidth} {...rest} />)}
    </div>
  );
}

function PdfPage({ pdf, index, width, drawing, onPageClick, onDraw, onHover, overlay }: PageProps & { index: number; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [vp, setVp] = useState<PageViewport | null>(null);
  // Dragging out the size of a new box.
  const start = useRef<{ x: number; y: number } | null>(null);
  const justDrew = useRef(false);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      const page = await pdf.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      const c = canvas.current;
      if (!c || cancelled) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.floor(viewport.width * ratio);
      c.height = Math.floor(viewport.height * ratio);
      c.style.width = `${viewport.width}px`;
      c.style.height = `${viewport.height}px`;
      const ctx = c.getContext("2d")!;
      task = page.render({ canvasContext: ctx, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }) as unknown as typeof task;
      try { await task!.promise; } catch { return; }
      if (!cancelled) setVp(viewport);
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, index, width]);

  const at = (e: React.PointerEvent | React.MouseEvent) => { const r = e.currentTarget.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onThePage = (e: React.SyntheticEvent) => e.target === e.currentTarget || !!(e.target as HTMLElement).dataset.page;
  return (
    <div className={cn("relative mx-auto mb-3 shadow-sm", drawing && "touch-none")} style={{ background: "#fff", width: vp?.width ?? width, height: vp?.height, minHeight: vp ? undefined : width * 1.29 }}
      onPointerEnter={() => onHover?.(index)}
      onPointerDown={(e) => {
        if (!vp || !drawing || !onThePage(e)) return;
        start.current = at(e);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const p = at(e);
        setRect({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
      }}
      onPointerUp={(e) => {
        const s = start.current;
        start.current = null;
        setRect(null);
        if (!s || !vp) return;
        const p = at(e);
        justDrew.current = true;
        onDraw(index, vp, s.x, s.y, p.x, p.y);
      }}
      onPointerCancel={() => { start.current = null; setRect(null); }}
      onClick={(e) => {
        // The click that ends a draw isn't a click on the empty page (it would un-pick the box just added).
        if (justDrew.current) { justDrew.current = false; return; }
        if (vp && !drawing && onThePage(e)) onPageClick(index);
      }}>
      <canvas ref={canvas} data-page="1" className={cn("block", drawing && "cursor-crosshair")} />
      <div className="pointer-events-none absolute right-2 top-2 rounded bg-slate-900/60 px-1.5 text-[10px] font-semibold text-white">{index + 1}</div>
      {vp && overlay(index, vp)}
      {rect && rect.w + rect.h > 6 && <div className="pointer-events-none absolute border-2 border-dashed border-teal-600 bg-teal-500/10" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />}
    </div>
  );
}
