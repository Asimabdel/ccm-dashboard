// Small pictures of every page beside the editor: see where you are, jump to a page, and (while preparing)
// drag a page to a new place. Each picture is drawn only when it scrolls into view.
import { useEffect, useRef, useState } from "react";
import type { PdfDoc } from "@/lib/pdf";
import { cn } from "@/lib/utils";

export function Thumbnails({ pdf, count, current, onJump, onMove, busy }: {
  pdf: PdfDoc; count: number; current: number; onJump: (page: number) => void;
  /** Drag to reorder (only while preparing a draft). */
  onMove?: (from: number, to: number) => void;
  busy?: boolean;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);
  // Keep the page you're on in sight in the list.
  useEffect(() => { list.current?.querySelector(`[data-thumb="${current}"]`)?.scrollIntoView({ block: "nearest" }); }, [current]);
  const canDrag = !!onMove && !busy && count > 1;
  return (
    <div ref={list} className="space-y-3 px-3 py-3" role="list" aria-label="Pages">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} role="listitem">
          <button
            type="button" data-thumb={i} onClick={() => onJump(i)} aria-current={current === i ? "page" : undefined} aria-label={`Page ${i + 1}`}
            draggable={canDrag}
            onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); }}
            onDragOver={(e) => { if (drag == null) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(i); }}
            onDragLeave={() => setOver((o) => (o === i ? null : o))}
            onDrop={(e) => { e.preventDefault(); const from = drag; setDrag(null); setOver(null); if (from != null && from !== i) onMove?.(from, i); }}
            onDragEnd={() => { setDrag(null); setOver(null); }}
            className={cn("group block w-full text-center outline-none", drag === i && "opacity-40", canDrag && "cursor-grab active:cursor-grabbing")}
          >
            <Thumb pdf={pdf} index={i} active={current === i} dropHere={over === i && drag !== i} />
            <span className={cn("mt-1 block text-[11px] font-semibold tabular-nums", current === i ? "text-brand dark:text-teal-300" : "text-slate-500")}>{i + 1}</span>
          </button>
        </div>
      ))}
      {canDrag && <p className="px-1 text-center text-[10px] leading-snug text-slate-400">Drag a page to move it.</p>}
    </div>
  );
}

function Thumb({ pdf, index, active, dropHere }: { pdf: PdfDoc; index: number; active: boolean; dropHere: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [seen, setSeen] = useState(false);
  const [shape, setShape] = useState(792 / 612);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!seen) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      const page = await pdf.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 240 / base.width });
      const c = canvas.current;
      if (!c || cancelled) return;
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      setShape(vp.height / vp.width);
      task = page.render({ canvasContext: c.getContext("2d")!, viewport: vp }) as unknown as typeof task;
      try { await task!.promise; } catch { /* replaced by a newer drawing */ }
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [seen, pdf, index]);
  return (
    // Paper stays white in dark mode (inline colour: dark mode recolours bg-white).
    <div ref={box} style={{ aspectRatio: `1 / ${shape}`, background: "#fff" }}
      className={cn("mx-auto w-full overflow-hidden rounded-md shadow-sm ring-1 transition", active ? "ring-2 ring-brand" : "ring-slate-200 group-hover:ring-slate-400 dark:ring-slate-600", dropHere && "ring-2 ring-teal-400 ring-offset-2 ring-offset-white dark:ring-offset-slate-800")}>
      <canvas ref={canvas} className="block h-full w-full" />
    </div>
  );
}
