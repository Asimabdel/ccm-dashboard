// One box (or mark) on a PDF page: how it looks, and dragging / resizing it while the document is being prepared.
import { useRef } from "react";
import { Signature, X } from "lucide-react";
import type { PageViewport } from "@/lib/pdf";
import { cn } from "@/lib/utils";
import { INK_HEX, inkOf, isMarkup, markPen, usDate, type DocField } from "@shared/documents";
import { INK, type BoxColor } from "./editorShared";
import { StampArt } from "./StampArt";

/** A mark the preparer drew: white-out, highlight, tick / cross / circle, line, stamp, logo. Drawn to match the signed PDF. */
function Markup({ f, scale, width, height }: { f: DocField; scale: number; width: number; height: number }) {
  if (f.type === "whiteout") return <div className="h-full w-full" style={{ background: "#fff" }} />;
  if (f.type === "highlight") return <div className="h-full w-full" style={{ background: "rgba(255, 235, 59, 0.45)", mixBlendMode: "multiply" }} />;
  if (f.type === "logo") return <StampArt type="logo" w={f.w} h={f.h} design={f.design} ink={INK} />;
  const color = INK_HEX[inkOf(f.color, f.type === "stamp" ? "red" : "black")];
  if (f.type === "stamp") return <StampArt type="stamp" w={f.w} h={f.h} value={f.value} design={f.design} ink={color} />;
  if (f.type === "line") {
    return <div className="absolute inset-x-0 top-1/2 -translate-y-1/2" style={{ height: Math.max(1, Math.max(0.75, Math.min(3, f.h / 5)) * scale), background: color }} />;
  }
  if (f.type === "mark") {
    // The same pen width as the printed mark (see markPen), whatever shape the box is stretched to.
    const sw = Math.max(1, markPen(f) * scale);
    return (
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full overflow-visible" fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {f.value === "circle" ? <ellipse cx="50" cy="50" rx={Math.max(5, 50 - (50 * sw) / Math.max(1, width))} ry={Math.max(5, 50 - (50 * sw) / Math.max(1, height))} vectorEffect="non-scaling-stroke" />
          : f.value === "x" ? <><line x1="15" y1="15" x2="85" y2="85" vectorEffect="non-scaling-stroke" /><line x1="15" y1="85" x2="85" y2="15" vectorEffect="non-scaling-stroke" /></>
          : <polyline points="12,50 40,82 90,14" vectorEffect="non-scaling-stroke" />}
      </svg>
    );
  }
  return null;
}

export function FieldBox({ f, vp, color, who, editable, fillable, selected, resizable, inert, flash, tapToFill, sig, onSelect, onMoveStart, onMove, onMoveEnd, onValue, onSign, onTapFill }: {
  f: DocField; vp: PageViewport; color: BoxColor; who: string;
  /** The document is being prepared: boxes can be picked, moved and resized. */
  editable: boolean;
  /** The person looking can fill this box in right now. */
  fillable: boolean;
  selected: boolean;
  /** The only selected box: it shows the resize dot. */
  resizable: boolean;
  /** A tool is in hand: clicks go through to the page (so a new mark can be drawn over a box). */
  inert: boolean;
  /** Just jumped to with "Next": draw attention to it. */
  flash: boolean;
  /** Phones / tablets: tapping a text or date box opens a big input instead of typing in the tiny box. */
  tapToFill: boolean;
  sig: { png: string } | null;
  onSelect: (add: boolean) => void;
  onMoveStart: () => void;
  onMove: (p: Partial<DocField>, how: "move" | "resize", scale: number) => void;
  onMoveEnd: () => void;
  onValue: (v: string) => void;
  onSign: () => void;
  onTapFill: () => void;
}) {
  const [x1, y1, x2, y2] = vp.convertToViewportRectangle([f.x, f.y, f.x + f.w, f.y + f.h]);
  const left = Math.min(x1, x2), top = Math.min(y1, y2), width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
  const scale = vp.scale;
  const markup = isMarkup(f.type);
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; f: DocField; moved: boolean } | null>(null);
  // Picked on the press already? (A press inside the box's input or button doesn't reach the box: then the click picks it.)
  const picked = useRef(false);
  const down = (e: React.PointerEvent, m: "move" | "resize") => {
    if (!editable) return;
    e.stopPropagation();
    picked.current = true;
    onSelect(e.shiftKey || e.ctrlKey || e.metaKey);
    drag.current = { mode: m, sx: e.clientX, sy: e.clientY, f, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / scale, dy = (e.clientY - d.sy) / scale;
    // A plain click (or a shaky tap) isn't a move.
    if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 3) return;
    if (!d.moved) { d.moved = true; onMoveStart(); }
    if (d.mode === "move") onMove({ x: d.f.x + dx, y: d.f.y - dy }, "move", scale);
    else {
      const min = f.type === "line" ? 4 : 8;
      const w = Math.max(min, d.f.w + dx), h = Math.max(min, d.f.h + dy);
      onMove({ w, h, y: d.f.y + d.f.h - h }, "resize", scale);
    }
  };
  const up = () => {
    if (drag.current?.moved) onMoveEnd();
    drag.current = null;
    // The click that follows this release still sees "picked"; anything later starts fresh.
    window.setTimeout(() => { picked.current = false; }, 0);
  };
  const fontPx = (f.fontSize ?? Math.max(6, Math.min(11, f.h * 0.72))) * scale;
  const filled = f.type === "checkbox" ? f.value === "x" : !!f.value;

  let content: React.ReactNode;
  if (markup) {
    content = <Markup f={f} scale={scale} width={width} height={height} />;
  } else if (f.type === "signature" || f.type === "initials") {
    content = sig ? <img src={sig.png} alt="" className="h-full w-full object-contain object-left" draggable={false} />
      : fillable ? (
        <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onSign(); }}
          className={cn("flex h-full w-full items-center justify-center gap-1 rounded-sm text-[11px] font-bold", color.text)}>
          <Signature size={Math.min(14, height * 0.6)} /> {f.type === "initials" ? "Initial" : "Sign"}
        </button>
      ) : <span className={cn("truncate px-1 text-[10px] font-semibold", color.text)}>{who}: {f.type}</span>;
  } else if (f.type === "checkbox") {
    content = (
      <button type="button" disabled={!fillable} onPointerDown={(e) => fillable && e.stopPropagation()} onClick={(e) => { e.stopPropagation(); if (fillable) onValue(f.value === "x" ? "" : "x"); }}
        className="grid h-full w-full place-items-center">
        {f.value === "x" && <X className="h-full w-full" style={{ color: INK }} strokeWidth={3} />}
      </button>
    );
  } else if (fillable && tapToFill) {
    content = (
      <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onTapFill(); }} className="block h-full w-full truncate px-0.5 text-start" style={{ fontSize: fontPx, color: f.value ? INK : "#94a3b8" }}>
        {f.value ? (f.type === "date" ? usDate(f.value) : f.value) : f.label || (f.type === "date" ? "Date" : "Tap to type")}
      </button>
    );
  } else if (fillable) {
    const common = {
      value: f.value ?? "",
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onValue(e.target.value),
      onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      placeholder: f.label ?? "",
      style: { fontSize: fontPx, fontWeight: f.bold ? 700 : undefined },
      className: "h-full w-full px-0.5 outline-none",
    };
    content = f.type === "date" ? <input type="date" {...common} />
      : f.h * scale > 34 ? <textarea {...common} className={cn(common.className, "resize-none leading-tight")} /> : <input type="text" {...common} />;
  } else {
    content = f.value
      ? <span className="block truncate px-0.5" style={{ fontSize: fontPx, color: INK, fontWeight: f.bold ? 700 : undefined }}>{f.type === "date" ? usDate(f.value) : f.value}</span>
      : <span className={cn("truncate px-1 text-[10px] font-semibold", color.text)}>{who}{f.label ? `: ${f.label}` : ""}</span>;
  }
  const showFrame = !markup && (editable || fillable || !filled);
  return (
    <div id={`box-${f.id}`} role="group" aria-label={`${f.label ?? f.type} (${markup ? "mark" : who})`}
      onPointerDown={(e) => down(e, "move")} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onClick={(e) => { e.stopPropagation(); if (editable && !picked.current) onSelect(e.shiftKey || e.ctrlKey || e.metaKey); picked.current = false; }}
      className={cn("pdf-field absolute flex items-center rounded-sm", editable && "select-none", f.type !== "line" && "overflow-hidden", showFrame && cn("border", color.border, color.bg),
        markup && editable && "outline-dashed outline-1 outline-slate-400/80",
        fillable && !filled && !markup && "border-2 border-dashed", selected && "ring-2 ring-brand ring-offset-1", flash && "animate-pulse ring-4 ring-amber-400 ring-offset-2",
        editable && "cursor-move", (inert || (markup && !editable)) && "pointer-events-none")}
      style={{ left, top, width, height }}>
      {content}
      {f.required && !filled && (fillable || editable) && <span className="pointer-events-none absolute -right-1 -top-1 text-xs font-bold text-red-600">*</span>}
      {editable && resizable && (
        <span onPointerDown={(e) => down(e, "resize")} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          className="absolute bottom-0 right-0 size-3 translate-x-1/2 translate-y-1/2 cursor-nwse-resize rounded-full border-2 border-white bg-brand" />
      )}
    </div>
  );
}
