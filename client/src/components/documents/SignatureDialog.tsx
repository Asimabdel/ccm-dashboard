import { useEffect, useRef, useState } from "react";
import { Loader2, PenLine, Stethoscope, Type } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, inputCls } from "@/components/workspace/ui";
import { cn } from "@/lib/utils";
import { APPROVAL_LABELS, APPROVAL_METHODS, PROVIDER_SIGNATURE_RULE, type ApprovalMethod } from "@shared/documents";

const SCRIPT_FONT = '"Segoe Script","Brush Script MT","Snell Roundhand","Apple Chancery",cursive';
const INK = "#0b1b4d";

/** Crop a canvas to its drawn pixels (plus a little margin) so the signature fills its box on the PDF. */
function trimmed(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const px = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (px[(y * width + x) * 4 + 3]! > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const m = 6;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(width - 1, x1 + m); y1 = Math.min(height - 1, y1 + m);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

/**
 * A photo or scan of a signature → a clean PNG: the paper (light pixels) becomes transparent so only the ink
 * lands on the PDF, cropped to the ink.
 */
export async function imageToSignaturePng(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file isn't a picture.")); i.src = url; });
    const scale = Math.min(1, 1400 / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * scale)); c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const lum = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
      if (lum > 185) px[i + 3] = 0; // paper
      else { px[i + 3] = Math.min(255, Math.round((185 - lum) * 2.2)); } // ink, softly anti-aliased
    }
    ctx.putImageData(data, 0, 0);
    const png = trimmed(c);
    if (!png) throw new Error("No signature found in that picture. Try a darker, closer photo.");
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface ProviderOption { providerUserId: number; name: string; png: string | null }

/** A typed name drawn in a handwriting-style font, as a PNG. */
function typedPng(text: string, initials: boolean): string | null {
  if (!text.trim()) return null;
  const c = document.createElement("canvas");
  c.width = 900; c.height = 220;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = INK;
  ctx.font = `${initials ? 120 : 96}px ${SCRIPT_FONT}`;
  ctx.textBaseline = "middle";
  ctx.fillText(text.trim(), 20, 110, 860);
  return trimmed(c);
}

/**
 * Sign a box: draw it, type it, or use your saved signature (one tap). Optionally save what you made as
 * your signature for next time.
 */
export function SignatureDialog({ open, kind, saved, defaultName, onClose, onDone, setupOnly = false, providers = [], onProviderApply }: {
  open: boolean;
  kind: "signature" | "initials";
  saved: string | null;
  defaultName: string;
  onClose: () => void;
  onDone: (png: string, saveAsMine: boolean) => Promise<void> | void;
  /** Just set up "my signature" (no box to sign). */
  setupOnly?: boolean;
  /** Providers whose stored signature this person may apply (with the provider's approval). */
  providers?: ProviderOption[];
  onProviderApply?: (o: { providerUserId: number; approval: ApprovalMethod; note: string | null }) => Promise<void>;
}) {
  const [tab, setTab] = useState<"saved" | "draw" | "type" | "provider">(saved && !setupOnly ? "saved" : "draw");
  const usable = providers.filter((p) => p.png);
  const [providerId, setProviderId] = useState<number | null>(null);
  const [approved, setApproved] = useState(false);
  const [approval, setApproval] = useState<ApprovalMethod | "">("");
  const [approvalNote, setApprovalNote] = useState("");
  const [typed, setTyped] = useState("");
  const [save, setSave] = useState(!saved || setupOnly);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);
  const initialsOf = (n: string) => n.split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).join("").slice(0, 4);

  useEffect(() => {
    if (!open) return;
    setTab(saved && !setupOnly ? "saved" : "draw");
    setTyped(kind === "initials" ? initialsOf(defaultName) : defaultName);
    setSave(!saved || setupOnly);
    setErr(null);
    inked.current = false;
    setProviderId(usable.length === 1 ? usable[0]!.providerUserId : null);
    setApproved(false); setApproval(""); setApprovalNote("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, saved, kind, defaultName, setupOnly]);

  // Size the drawing canvas to its box (sharp on high-DPI screens).
  useEffect(() => {
    if (!open || tab !== "draw") return;
    const t = window.setTimeout(() => {
      const c = canvas.current;
      if (!c) return;
      const r = c.getBoundingClientRect();
      const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      c.width = Math.round(r.width * ratio); c.height = Math.round(r.height * ratio);
      const ctx = c.getContext("2d")!;
      ctx.scale(ratio, ratio);
      ctx.lineWidth = kind === "initials" ? 3 : 2.6; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = INK;
      inked.current = false;
    }, 30);
    return () => window.clearTimeout(t);
  }, [open, tab, kind]);

  const pos = (e: React.PointerEvent) => { const r = canvas.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    canvas.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = canvas.current!.getContext("2d")!;
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.1, p.y + 0.1); ctx.stroke();
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = canvas.current!.getContext("2d")!;
    const p = pos(e);
    ctx.lineTo(p.x, p.y); ctx.stroke();
    inked.current = true;
  };
  const up = () => { drawing.current = false; };
  const clear = () => { const c = canvas.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); inked.current = false; };

  const finish = async () => {
    setErr(null);
    if (tab === "provider") {
      const p = usable.find((x) => x.providerUserId === providerId);
      if (!p) { setErr("Pick the provider."); return; }
      if (!approved) { setErr(`Confirm ${p.name} approved this.`); return; }
      if (!approval) { setErr("Say how they approved it."); return; }
      if (approval === "other" && !approvalNote.trim()) { setErr("Add a short note on how they approved it."); return; }
      setBusy(true);
      try { await onProviderApply?.({ providerUserId: p.providerUserId, approval, note: approvalNote.trim() || null }); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
      return;
    }
    let png: string | null = null;
    if (tab === "saved") png = saved;
    else if (tab === "type") png = typedPng(typed, kind === "initials");
    else png = inked.current && canvas.current ? trimmed(canvas.current) : null;
    if (!png) { setErr(tab === "type" ? "Type your name first." : "Sign in the box first."); return; }
    setBusy(true);
    try { await onDone(png, tab !== "saved" && save); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const label = kind === "initials" ? "initials" : "signature";
  const tabBtn = (t: typeof tab, text: string, Icon?: React.ElementType) => (
    <button type="button" onClick={() => setTab(t)} className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold", tab === t ? "border-brand bg-brand/5" : "border-slate-200 dark:border-slate-700")}>
      {Icon && <Icon size={12} />} {text}
    </button>
  );
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{setupOnly ? `Your ${label}` : `Add your ${label}`}</DialogTitle>
          <DialogDescription>{setupOnly ? `Save your ${label} once; then one tap signs any box.` : "It's stamped on the PDF with your name, the time and where you signed from."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-1.5">
            {saved && !setupOnly && tabBtn("saved", `My saved ${label}`)}
            {tabBtn("draw", "Draw", PenLine)}
            {tabBtn("type", "Type", Type)}
            {!setupOnly && usable.length > 0 && onProviderApply && tabBtn("provider", `A provider's ${label}`, Stethoscope)}
          </div>
          {tab === "provider" && (
            <div className="space-y-2">
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{PROVIDER_SIGNATURE_RULE}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {usable.map((p) => (
                  <button key={p.providerUserId} type="button" onClick={() => { setProviderId(p.providerUserId); setApproved(false); }}
                    className={cn("rounded-lg border-2 p-2 text-left", providerId === p.providerUserId ? "border-brand" : "border-slate-200 dark:border-slate-700")}>
                    <span className="block text-xs font-semibold">{p.name}</span>
                    <span className="mt-1 grid h-14 place-items-center rounded" style={{ background: "#fff" }}><img src={p.png!} alt="" className="max-h-12 max-w-full" /></span>
                  </button>
                ))}
              </div>
              {providerId && (
                <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                  <label className="flex items-start gap-2 text-sm font-semibold">
                    <input type="checkbox" className="mt-0.5 size-4 accent-teal-700" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
                    {usable.find((p) => p.providerUserId === providerId)?.name} approved me signing this for them.
                  </label>
                  <select className={cn(inputCls, "h-9 text-xs")} value={approval} onChange={(e) => setApproval(e.target.value as ApprovalMethod)}>
                    <option value="">How did they approve it?</option>
                    {APPROVAL_METHODS.map((m) => <option key={m} value={m}>{APPROVAL_LABELS[m]}</option>)}
                  </select>
                  <input className={cn(inputCls, "h-9 text-xs")} value={approvalNote} maxLength={255} onChange={(e) => setApprovalNote(e.target.value)}
                    placeholder={approval === "other" ? "How they approved it (required)" : "Note (optional), e.g. approved at 2:10 pm"} />
                  <p className="text-[11px] text-slate-500">They'll get a notification, and it's shown on the PDF's certificate page.</p>
                </div>
              )}
            </div>
          )}
          {tab === "saved" && saved && (
            <div className="grid h-32 place-items-center rounded-lg border border-slate-200 p-2" style={{ background: "#fff" }}><img src={saved} alt="" className="max-h-28" /></div>
          )}
          {tab === "draw" && (
            <div>
              <canvas ref={canvas} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up}
                className={cn("w-full touch-none rounded-lg border-2 border-dashed border-slate-300", kind === "initials" ? "h-32" : "h-40")} style={{ background: "#fff" }} aria-label="Draw here" />
              <div className="mt-1 flex justify-between text-xs text-slate-500"><span>Draw with your mouse, finger or stylus.</span><button type="button" className="font-semibold text-brand hover:underline" onClick={clear}>Clear</button></div>
            </div>
          )}
          {tab === "type" && (
            <div className="space-y-2">
              <input className={inputCls} value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={kind === "initials" ? 6 : 80} placeholder={kind === "initials" ? "Initials" : "Full name"} />
              {typed.trim() && <div className="rounded-lg border border-slate-200 px-4 py-3 text-4xl" style={{ fontFamily: SCRIPT_FONT, color: INK, background: "#fff" }}>{typed}</div>}
            </div>
          )}
          {tab !== "saved" && tab !== "provider" && !setupOnly && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" className="size-4 accent-teal-700" checked={save} onChange={(e) => setSave(e.target.checked)} />
              Save as my {label} for next time
            </label>
          )}
          {err && <p className="text-xs font-semibold text-red-600">{err}</p>}
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
            <Btn disabled={busy} onClick={finish}>{busy && <Loader2 size={14} className="animate-spin" />} {setupOnly ? "Save" : tab === "provider" ? "Apply their signature" : "Sign"}</Btn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
