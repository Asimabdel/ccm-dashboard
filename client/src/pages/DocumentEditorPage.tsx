// The Documents editor. Three modes:
//  • edit: the person preparing it places boxes on the PDF (text, date, checkbox, signature, initials),
//    fills in their own, picks who else signs, then finishes it or sends it for signature.
//  • sign: a teammate it was sent to fills in and signs their highlighted boxes.
//  • view: read-only (the signed PDF once it's complete).
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { toast } from "sonner";
import {
  ArrowLeft, CalendarDays, CheckCircle2, Download, FileStack, Loader2, Minus, Plus, Send, Signature, SquareCheck, TextCursorInput, Trash2, Type, UserRound, X, XCircle,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Btn, ErrorNote, Loading, inputCls } from "@/components/workspace/ui";
import { SignatureDialog } from "@/components/documents/SignatureDialog";
import { openPdf, type PageViewport, type PdfDoc } from "@/lib/pdf";
import { downloadPdf } from "@/lib/pdfDownload";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  DOC_STATUS_LABELS, FIELD_DEFAULT_SIZE, FIELD_LABELS, PREFILL_KEYS, PREFILL_LABELS, missingFor, signerOf, usDate,
  type Assignee, type DocField, type FieldType, type PrefillKey,
} from "@shared/documents";

type Doc = RouterOutputs["workspace"]["documents"]["get"];
type SigMap = Record<string, { png: string; name: string | null }>;

const TOOLS: { type: FieldType; icon: React.ElementType }[] = [
  { type: "text", icon: Type }, { type: "date", icon: CalendarDays }, { type: "checkbox", icon: SquareCheck },
  { type: "signature", icon: Signature }, { type: "initials", icon: TextCursorInput },
];
// One color per person filling boxes: you (teal), then each signer.
const PALETTE = [
  { border: "border-teal-600", bg: "bg-teal-500/10", text: "text-teal-800", dot: "bg-teal-600" },
  { border: "border-violet-600", bg: "bg-violet-500/10", text: "text-violet-800", dot: "bg-violet-600" },
  { border: "border-amber-600", bg: "bg-amber-500/10", text: "text-amber-800", dot: "bg-amber-600" },
  { border: "border-sky-600", bg: "bg-sky-500/10", text: "text-sky-800", dot: "bg-sky-600" },
  { border: "border-rose-600", bg: "bg-rose-500/10", text: "text-rose-800", dot: "bg-rose-600" },
];
/** Ink on the (always white) PDF page, whatever the app's theme. */
const INK = "#0f172a";
const newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export default function DocumentEditorPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const { id } = useParams<{ id: string }>();
  const docId = Number(id);
  const q = trpc.workspace.documents.get.useQuery({ id: docId }, { enabled: !!user && docId > 0, refetchOnWindowFocus: false });
  return (
    <CCMDashboardLayout title="Documents" pageTitle={false}>
      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {q.data && <Editor key={`${q.data.id}:${q.data.status}:${q.data.mode}`} doc={q.data} refetch={() => void q.refetch()} />}
    </CCMDashboardLayout>
  );
}

function Editor({ doc, refetch }: { doc: Doc; refetch: () => void }) {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const mode = doc.mode;
  const showFinal = doc.status === "completed" && doc.hasFinal;
  const [fields, setFields] = useState<DocField[]>(doc.fields);
  const [title, setTitle] = useState(doc.title);
  const [message, setMessage] = useState(doc.message ?? "");
  const [sigs, setSigs] = useState<SigMap>(doc.signatures);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<FieldType | null>(null);
  const [newAssignee, setNewAssignee] = useState<Assignee>("preparer");
  const [zoom, setZoom] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [signing, setSigning] = useState<DocField | null>(null);

  const me: Assignee = `signer:${doc.myUserId}`;
  const signerIds = doc.signers.map((s) => s.userId);
  const colorOf = (a: Assignee) => { const s = signerOf(a); const i = s ? signerIds.indexOf(s) + 1 : 0; return PALETTE[Math.max(0, i) % PALETTE.length]!; };
  const nameOf = (a: Assignee) => { const s = signerOf(a); return s ? doc.signers.find((x) => x.userId === s)?.name ?? "Signer" : "You"; };
  /** Can the person looking at this fill that box right now? */
  const canFill = useCallback((f: DocField) => (mode === "edit" && f.assignee === "preparer") || (mode === "sign" && f.assignee === me), [mode, me]);

  // --- the PDF ---
  const fileM = trpc.workspace.documents.file.useMutation();
  const [pdf, setPdf] = useState<PdfDoc | null>(null);
  const [pdfErr, setPdfErr] = useState<string | null>(null);
  useEffect(() => {
    if (!doc.hasFile) return;
    let alive = true;
    (async () => {
      try {
        const src = await fileM.mutateAsync({ id: doc.id, which: showFinal ? "final" : "source" });
        const p = await openPdf(src);
        if (alive) setPdf(p);
      } catch (e) { if (alive) setPdfErr((e as Error).message); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, showFinal]);

  // --- autosave (drafts) ---
  const save = trpc.workspace.documents.save.useMutation();
  useEffect(() => {
    if (mode !== "edit" || !dirty) return;
    const h = window.setTimeout(() => {
      setDirty(false);
      save.mutate({ id: doc.id, title, fields: fields as unknown as Record<string, unknown>[], message }, { onError: (e) => { toast.error(e.message); setDirty(true); } });
    }, 900);
    return () => window.clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, fields, title, message, mode]);
  const flush = async () => {
    if (mode !== "edit") return;
    setDirty(false);
    await save.mutateAsync({ id: doc.id, title, fields: fields as unknown as Record<string, unknown>[], message });
  };
  const update = (fid: string, patch: Partial<DocField>) => { setFields((fs) => fs.map((f) => (f.id === fid ? { ...f, ...patch } : f))); setDirty(true); };
  const remove = (fid: string) => { setFields((fs) => fs.filter((f) => f.id !== fid)); setSelected(null); setDirty(true); };

  // Delete / Escape shortcuts while editing.
  useEffect(() => {
    if (mode !== "edit") return;
    const onKey = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName ?? "");
      if (e.key === "Escape") { setTool(null); setSelected(null); }
      if (!typing && selected && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); remove(selected); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selected]);

  const place = (page: number, vp: PageViewport, px: number, py: number) => {
    if (!tool) return;
    const size = FIELD_DEFAULT_SIZE[tool];
    const [x, top] = vp.convertToPdfPoint(px, py) as [number, number];
    const f: DocField = { id: newId(), type: tool, page, x, y: top - size.h, w: size.w, h: size.h, assignee: newAssignee, required: tool === "signature" || tool === "initials", value: tool === "date" && newAssignee === "preparer" ? todayStr() : null };
    setFields((fs) => [...fs, f]);
    setSelected(f.id);
    setTool(null);
    setDirty(true);
  };

  // --- signing a box ---
  const mySig = trpc.workspace.documents.mySignature.useQuery();
  // Providers who picked this person to apply their stored signature (only for your own boxes while preparing).
  const providerSigs = trpc.workspace.documents.signaturesICanApply.useQuery(undefined, { enabled: mode === "edit" });
  const signField = trpc.workspace.documents.signField.useMutation();
  const doProviderSign = async (f: DocField, o: { providerUserId: number; approval: "in_person" | "phone" | "text" | "other"; note: string | null }) => {
    await flush();
    const r = await signField.mutateAsync({ id: doc.id, fieldId: f.id, onBehalfOf: o });
    setSigs((s) => ({ ...s, [r.value]: { png: r.png, name: r.name } }));
    setFields((fs) => fs.map((x) => (x.id === f.id ? { ...x, value: r.value } : x)));
    setSigning(null);
    toast.success(`${r.name}'s ${f.type === "initials" ? "initials" : "signature"} applied. They've been notified.`);
  };
  const doSign = async (f: DocField, png: string, saveAsMine: boolean) => {
    if (mode === "edit") await flush();
    const r = await signField.mutateAsync({ id: doc.id, fieldId: f.id, png, saveAsMine });
    setSigs((s) => ({ ...s, [r.value]: { png: r.png, name: user?.name ?? null } }));
    setFields((fs) => fs.map((x) => (x.id === f.id ? { ...x, value: r.value } : x)));
    if (saveAsMine) void utils.workspace.documents.mySignature.invalidate();
    setSigning(null);
  };

  // --- actions ---
  const send = trpc.workspace.documents.send.useMutation();
  const finishSigning = trpc.workspace.documents.finishSigning.useMutation();
  const cancel = trpc.workspace.documents.cancel.useMutation();
  const asTemplate = trpc.workspace.documents.saveAsTemplate.useMutation();
  const fromTemplate = trpc.workspace.documents.fromTemplate.useMutation();
  const busy = send.isPending || finishSigning.isPending || cancel.isPending;
  const doSend = async () => {
    try {
      await flush();
      const r = await send.mutateAsync({ id: doc.id });
      toast.success(r.status === "completed" ? "Done. The signed PDF is ready." : "Sent. Each signer has a task to sign it.");
      void utils.workspace.documents.invalidate();
      refetch();
    } catch (e) { toast.error((e as Error).message); }
  };
  const doFinishSigning = async () => {
    const values = Object.fromEntries(fields.filter((f) => f.assignee === me && f.type !== "signature" && f.type !== "initials").map((f) => [f.id, f.value ?? ""]));
    try {
      const r = await finishSigning.mutateAsync({ id: doc.id, values });
      toast.success(r.status === "completed" ? "Signed. Everyone's done: the signed PDF is ready." : "Signed. Waiting on the other signers.");
      void utils.workspace.documents.invalidate();
      refetch();
    } catch (e) { toast.error((e as Error).message); }
  };
  const download = async () => {
    try { downloadPdf(await fileM.mutateAsync({ id: doc.id, which: "final" }), `${doc.title} (signed).pdf`); } catch (e) { toast.error((e as Error).message); }
  };

  const myMissing = mode === "sign" ? missingFor(fields, me) : mode === "edit" ? missingFor(fields, "preparer") : [];
  const sel = fields.find((f) => f.id === selected) ?? null;
  const pageCount = pdf?.numPages ?? doc.pages.length;

  return (
    <div className="-mx-2 sm:mx-0">
      {/* Top bar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link href="/documents"><Btn size="sm" variant="ghost"><ArrowLeft size={14} /> Documents</Btn></Link>
        {mode === "edit" ? (
          <input className={cn(inputCls, "h-9 max-w-md flex-1 font-semibold")} value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} maxLength={255} aria-label="Title" />
        ) : <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{doc.title}</h1>}
        {doc.isTemplate ? <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-800">Template</span>
          : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">{DOC_STATUS_LABELS[doc.status]}</span>}
        {mode === "edit" && <span className="text-xs text-slate-500">{save.isPending ? "Saving…" : dirty ? "Unsaved" : "Saved"}</span>}
        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          <div className="flex items-center rounded-lg border border-slate-200 dark:border-slate-700">
            <button type="button" className="px-2 py-1.5" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Zoom out"><Minus size={14} /></button>
            <span className="w-11 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
            <button type="button" className="px-2 py-1.5" onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.25).toFixed(2)))} aria-label="Zoom in"><Plus size={14} /></button>
          </div>
          {mode === "edit" && !doc.isTemplate && (
            <>
              <Btn size="sm" variant="secondary" disabled={asTemplate.isPending} onClick={async () => {
                const t = window.prompt("Template name", title);
                if (!t) return;
                try { await flush(); await asTemplate.mutateAsync({ id: doc.id, title: t }); toast.success("Saved as a template (see the Templates tab)."); } catch (e) { toast.error((e as Error).message); }
              }}><FileStack size={13} /> Save as template</Btn>
              <Btn size="sm" disabled={busy} onClick={doSend}>
                {send.isPending ? <Loader2 size={13} className="animate-spin" /> : doc.signers.length ? <Send size={13} /> : <CheckCircle2 size={13} />}
                {doc.signers.length ? "Send for signature" : "Finish & create PDF"}
              </Btn>
            </>
          )}
          {mode === "edit" && doc.isTemplate && (
            <Btn size="sm" disabled={fromTemplate.isPending} onClick={async () => {
              try { await flush(); const r = await fromTemplate.mutateAsync({ templateId: doc.id, subjectKey: null }); navigate(`/documents/${r.id}`); } catch (e) { toast.error((e as Error).message); }
            }}>Use this template</Btn>
          )}
          {mode === "sign" && (
            <Btn size="sm" disabled={busy} onClick={doFinishSigning}>{finishSigning.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Finish signing</Btn>
          )}
          {doc.status === "completed" && <Btn size="sm" onClick={download}><Download size={13} /> Download signed PDF</Btn>}
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Side panel */}
        {mode !== "view" && (
          <aside className="w-full shrink-0 space-y-3 text-sm lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:w-72 lg:overflow-y-auto">
            {mode === "edit" ? (
              <>
                <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Add a box</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {TOOLS.map((t) => (
                      <button key={t.type} type="button" onClick={() => setTool(tool === t.type ? null : t.type)}
                        className={cn("flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11px] font-semibold", tool === t.type ? "border-brand bg-brand/10 text-slate-900" : "border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300")}>
                        <t.icon size={16} /> {FIELD_LABELS[t.type]}
                      </button>
                    ))}
                  </div>
                  {tool && <p className="mt-2 text-xs text-brand">Click on the page where the {FIELD_LABELS[tool].toLowerCase()} box goes. (Esc to stop)</p>}
                  {!doc.isTemplate && (
                    <label className="mt-2 block text-xs text-slate-500">New boxes are for
                      <select className={cn(inputCls, "mt-1 h-8 text-xs")} value={newAssignee} onChange={(e) => setNewAssignee(e.target.value as Assignee)}>
                        <option value="preparer">Me (I fill it now)</option>
                        {doc.signers.map((s) => <option key={s.userId} value={`signer:${s.userId}`}>{s.name ?? "Signer"} (signs later)</option>)}
                      </select>
                    </label>
                  )}
                </section>

                {sel && (
                  <FieldPanel f={sel} doc={doc} onChange={(p) => update(sel.id, p)} onDelete={() => remove(sel.id)} isTemplate={doc.isTemplate} />
                )}

                {!doc.isTemplate && (
                  <SignersPanel doc={doc} fields={fields} colorOf={colorOf} onChanged={(ids) => {
                    // Boxes of someone removed go back to you (like the server does).
                    setFields((fs) => fs.map((f) => { const s = signerOf(f.assignee); return s && !ids.includes(s) ? { ...f, assignee: "preparer", value: null } : f; }));
                    if (signerOf(newAssignee) && !ids.includes(signerOf(newAssignee)!)) setNewAssignee("preparer");
                    refetch();
                  }} />
                )}

                {!doc.isTemplate && (
                  <PatientPanel doc={doc} onLinked={() => refetch()} onPrefilled={(fs) => { setFields(fs); }} flush={flush} />
                )}

                {!doc.isTemplate && doc.signers.length > 0 && (
                  <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Message to signers (optional)</p>
                    <textarea className={cn(inputCls, "h-20 text-xs")} value={message} maxLength={1000} onChange={(e) => { setMessage(e.target.value); setDirty(true); }} />
                  </section>
                )}

                {myMissing.length > 0 && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{myMissing.length} required box{myMissing.length === 1 ? "" : "es"} of yours still empty.</p>}
                <button type="button" className="flex items-center gap-1 text-xs font-semibold text-red-600 hover:underline" disabled={cancel.isPending}
                  onClick={async () => { if (!window.confirm(doc.isTemplate ? "Delete this template?" : "Cancel this document?")) return; try { await cancel.mutateAsync({ id: doc.id }); navigate("/documents"); } catch (e) { toast.error((e as Error).message); } }}>
                  <Trash2 size={12} /> {doc.isTemplate ? "Delete template" : "Cancel document"}
                </button>
              </>
            ) : (
              <section className="rounded-xl border border-violet-200 bg-violet-50 p-3 dark:border-violet-900 dark:bg-violet-950/40">
                <p className="font-semibold">Your part</p>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{doc.creator ?? "A teammate"} sent you this to fill in and sign. Your boxes are highlighted.</p>
                {doc.message && <p className="mt-2 rounded-md bg-white/70 p-2 text-xs italic dark:bg-slate-900/40">"{doc.message}"</p>}
                <p className="mt-2 text-xs">{myMissing.length ? `${myMissing.length} required box${myMissing.length === 1 ? "" : "es"} left.` : "All your required boxes are done."}</p>
                <Btn className="mt-3 w-full" disabled={busy} onClick={doFinishSigning}>{finishSigning.isPending && <Loader2 size={13} className="animate-spin" />} Finish signing</Btn>
              </section>
            )}
          </aside>
        )}

        {/* Pages */}
        <div className="min-w-0 flex-1">
          {mode === "view" && <ViewSummary doc={doc} />}
          {!doc.hasFile && <ErrorNote message="This document has no PDF yet." />}
          {pdfErr && <ErrorNote message={`The PDF couldn't be shown: ${pdfErr}`} />}
          {doc.hasFile && !pdf && !pdfErr && <Loading label="Opening the PDF…" />}
          {pdf && (
            <Pages pdf={pdf} count={pageCount} zoom={zoom} crosshair={!!tool}
              onPageClick={(page, vp, x, y) => { if (tool) place(page, vp, x, y); else setSelected(null); }}
              overlay={(page, vp) => showFinal ? null : fields.filter((f) => f.page === page).map((f) => (
                <FieldBox key={f.id} f={f} vp={vp} color={colorOf(f.assignee)} who={nameOf(f.assignee)} editable={mode === "edit"}
                  fillable={canFill(f)} selected={selected === f.id} sig={f.value ? sigs[f.value] ?? null : null}
                  onSelect={() => mode === "edit" && setSelected(f.id)} onMove={(p) => update(f.id, p)}
                  onValue={(v) => { if (mode === "edit") update(f.id, { value: v }); else setFields((fs) => fs.map((x) => (x.id === f.id ? { ...x, value: v } : x))); }}
                  onSign={() => setSigning(f)} />
              ))} />
          )}
        </div>
      </div>

      <SignatureDialog open={!!signing} kind={signing?.type === "initials" ? "initials" : "signature"}
        saved={(signing?.type === "initials" ? mySig.data?.initialsPng : mySig.data?.signaturePng) ?? null}
        defaultName={user?.name ?? ""} onClose={() => setSigning(null)}
        onDone={async (png, saveAsMine) => { if (signing) await doSign(signing, png, saveAsMine); }}
        providers={mode === "edit" && signing?.assignee === "preparer"
          ? (providerSigs.data ?? []).map((p) => ({ providerUserId: p.providerUserId, name: p.name, png: signing.type === "initials" ? p.initialsPng : p.signaturePng }))
          : []}
        onProviderApply={async (o) => { if (signing) await doProviderSign(signing, o); }} />
    </div>
  );
}

const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

// ---------------------------------------------------------------------------
// Pages (pdf.js canvases) with a layer for the boxes
// ---------------------------------------------------------------------------

function Pages({ pdf, count, zoom, crosshair, onPageClick, overlay }: {
  pdf: PdfDoc; count: number; zoom: number; crosshair: boolean;
  onPageClick: (page: number, vp: PageViewport, x: number, y: number) => void;
  overlay: (page: number, vp: PageViewport) => React.ReactNode;
}) {
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
      {width > 0 && Array.from({ length: count }, (_, i) => (
        <PdfPage key={i} pdf={pdf} index={i} width={pageWidth} crosshair={crosshair} onClick={onPageClick} overlay={overlay} />
      ))}
    </div>
  );
}

function PdfPage({ pdf, index, width, crosshair, onClick, overlay }: {
  pdf: PdfDoc; index: number; width: number; crosshair: boolean;
  onClick: (page: number, vp: PageViewport, x: number, y: number) => void;
  overlay: (page: number, vp: PageViewport) => React.ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [vp, setVp] = useState<PageViewport | null>(null);
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
  return (
    <div className="relative mx-auto mb-3 shadow-sm" style={{ background: "#fff", width: vp?.width ?? width, height: vp?.height, minHeight: vp ? undefined : width * 1.29 }}
      onClick={(e) => {
        if (!vp || e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.page) return;
        const r = e.currentTarget.getBoundingClientRect();
        onClick(index, vp, e.clientX - r.left, e.clientY - r.top);
      }}>
      <canvas ref={canvas} data-page="1" className={cn("block", crosshair && "cursor-crosshair")} />
      <div className="pointer-events-none absolute right-2 top-2 rounded bg-slate-900/60 px-1.5 text-[10px] font-semibold text-white">{index + 1}</div>
      {vp && overlay(index, vp)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One box on the page
// ---------------------------------------------------------------------------

function FieldBox({ f, vp, color, who, editable, fillable, selected, sig, onSelect, onMove, onValue, onSign }: {
  f: DocField; vp: PageViewport; color: (typeof PALETTE)[number]; who: string; editable: boolean; fillable: boolean; selected: boolean;
  sig: { png: string } | null; onSelect: () => void; onMove: (p: Partial<DocField>) => void; onValue: (v: string) => void; onSign: () => void;
}) {
  const [x1, y1, x2, y2] = vp.convertToViewportRectangle([f.x, f.y, f.x + f.w, f.y + f.h]);
  const left = Math.min(x1, x2), top = Math.min(y1, y2), width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
  const scale = vp.scale;
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; f: DocField } | null>(null);
  const down = (e: React.PointerEvent, m: "move" | "resize") => {
    if (!editable) return;
    e.stopPropagation();
    onSelect();
    drag.current = { mode: m, sx: e.clientX, sy: e.clientY, f };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / scale, dy = (e.clientY - d.sy) / scale;
    if (d.mode === "move") onMove({ x: d.f.x + dx, y: d.f.y - dy });
    else {
      const w = Math.max(8, d.f.w + dx), h = Math.max(8, d.f.h + dy);
      onMove({ w, h, y: d.f.y + d.f.h - h });
    }
  };
  const up = () => { drag.current = null; };
  const fontPx = (f.fontSize ?? Math.max(6, Math.min(11, f.h * 0.72))) * scale;
  const filled = f.type === "checkbox" ? f.value === "x" : !!f.value;

  let content: React.ReactNode;
  if (f.type === "signature" || f.type === "initials") {
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
  } else if (fillable) {
    const common = {
      value: f.type === "date" ? f.value ?? "" : f.value ?? "",
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onValue(e.target.value),
      onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      placeholder: f.label ?? "",
      style: { fontSize: fontPx },
      className: "h-full w-full px-0.5 outline-none",
    };
    content = f.type === "date" ? <input type="date" {...common} />
      : f.h * scale > 34 ? <textarea {...common} className={cn(common.className, "resize-none leading-tight")} /> : <input type="text" {...common} />;
  } else {
    content = f.value
      ? <span className="block truncate px-0.5" style={{ fontSize: fontPx, color: INK }}>{f.type === "date" ? usDate(f.value) : f.value}</span>
      : <span className={cn("truncate px-1 text-[10px] font-semibold", color.text)}>{who}{f.label ? `: ${f.label}` : ""}</span>;
  }
  const showFrame = editable || fillable || !filled;
  return (
    <div role="group" aria-label={`${f.label ?? f.type} (${who})`}
      onPointerDown={(e) => down(e, "move")} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      className={cn("pdf-field absolute flex items-center overflow-hidden rounded-sm", showFrame && cn("border", color.border, color.bg),
        fillable && !filled && "border-2 border-dashed", selected && "ring-2 ring-brand ring-offset-1", editable && "cursor-move")}
      style={{ left, top, width, height }}>
      {content}
      {f.required && !filled && (fillable || editable) && <span className="pointer-events-none absolute -right-1 -top-1 text-xs font-bold text-red-600">*</span>}
      {editable && selected && (
        <span onPointerDown={(e) => down(e, "resize")} onPointerMove={move} onPointerUp={up}
          className="absolute bottom-0 right-0 size-3 translate-x-1/2 translate-y-1/2 cursor-nwse-resize rounded-full border-2 border-white bg-brand" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side panels
// ---------------------------------------------------------------------------

function FieldPanel({ f, doc, onChange, onDelete, isTemplate }: { f: DocField; doc: Doc; onChange: (p: Partial<DocField>) => void; onDelete: () => void; isTemplate: boolean }) {
  return (
    <section className="space-y-2 rounded-xl border border-brand/40 bg-white p-3 dark:bg-slate-800">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{FIELD_LABELS[f.type]} box · page {f.page + 1}</p>
        <button type="button" onClick={onDelete} className="text-red-600" title="Delete box"><Trash2 size={14} /></button>
      </div>
      {!isTemplate && (
        <label className="block text-xs text-slate-500">Who fills this box
          <select className={cn(inputCls, "mt-1 h-8 text-xs")} value={f.assignee} onChange={(e) => onChange({ assignee: e.target.value as Assignee, value: e.target.value === "preparer" ? f.value : null })}>
            <option value="preparer">Me</option>
            {doc.signers.map((s) => <option key={s.userId} value={`signer:${s.userId}`}>{s.name ?? "Signer"}</option>)}
          </select>
        </label>
      )}
      <label className="block text-xs text-slate-500">Label (shown to whoever fills it)
        <input className={cn(inputCls, "mt-1 h-8 text-xs")} value={f.label ?? ""} maxLength={120} onChange={(e) => onChange({ label: e.target.value })} />
      </label>
      {(f.type === "text" || f.type === "date") && (
        <label className="block text-xs text-slate-500">Fill in automatically with
          <select className={cn(inputCls, "mt-1 h-8 text-xs")} value={f.prefill ?? ""} onChange={(e) => onChange({ prefill: (e.target.value || null) as PrefillKey | null })}>
            <option value="">Nothing</option>
            {PREFILL_KEYS.filter((k) => (f.type === "date" ? k === "today" || k === "patient_dob" : k !== "today")).map((k) => <option key={k} value={k}>{PREFILL_LABELS[k]}</option>)}
          </select>
        </label>
      )}
      {f.type === "text" && (
        <label className="block text-xs text-slate-500">Text size (points; blank = fit the box)
          <input type="number" min={5} max={36} className={cn(inputCls, "mt-1 h-8 text-xs")} value={f.fontSize ?? ""} onChange={(e) => onChange({ fontSize: e.target.value ? Number(e.target.value) : null })} />
        </label>
      )}
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" className="size-4 accent-teal-700" checked={!!f.required} onChange={(e) => onChange({ required: e.target.checked })} /> Required
      </label>
      <p className="text-[11px] text-slate-400">Drag to move · drag the corner dot to resize · Delete key removes it.</p>
    </section>
  );
}

function SignersPanel({ doc, fields, colorOf, onChanged }: { doc: Doc; fields: DocField[]; colorOf: (a: Assignee) => (typeof PALETTE)[number]; onChanged: (ids: number[]) => void }) {
  const choices = trpc.workspace.documents.signers.useQuery();
  const setSigners = trpc.workspace.documents.setSigners.useMutation({ onError: (e) => toast.error(e.message) });
  const ids = doc.signers.map((s) => s.userId);
  const change = async (next: number[]) => { await setSigners.mutateAsync({ id: doc.id, userIds: next }); onChanged(next); };
  const available = (choices.data ?? []).filter((u) => !ids.includes(u.id));
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Who else signs</p>
      <p className="mb-2 text-[11px] text-slate-500">Add a provider or teammate, then give them boxes ("New boxes are for…" or "Who fills this box").</p>
      <ul className="space-y-1">
        {doc.signers.map((s) => {
          const n = fields.filter((f) => signerOf(f.assignee) === s.userId).length;
          return (
            <li key={s.userId} className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5"><span className={cn("size-2.5 shrink-0 rounded-full", colorOf(`signer:${s.userId}`).dot)} /><span className="truncate">{s.name}</span><span className="text-[11px] text-slate-400">({n} box{n === 1 ? "" : "es"})</span></span>
              <button type="button" className="text-slate-400 hover:text-red-600" onClick={() => void change(ids.filter((x) => x !== s.userId))} title="Remove"><XCircle size={14} /></button>
            </li>
          );
        })}
      </ul>
      <select className={cn(inputCls, "mt-2 h-8 text-xs")} value="" disabled={setSigners.isPending} onChange={(e) => e.target.value && void change([...ids, Number(e.target.value)])}>
        <option value="">+ Add a signer…</option>
        {available.map((u) => <option key={u.id} value={u.id}>{u.name}{u.role === "provider" ? " (provider)" : ""}</option>)}
      </select>
    </section>
  );
}

function PatientPanel({ doc, onLinked, onPrefilled, flush }: { doc: Doc; onLinked: () => void; onPrefilled: (fields: DocField[]) => void; flush: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const search = trpc.workspace.documents.searchPatients.useQuery({ q: q.trim() }, { enabled: q.trim().length >= 2 });
  const save = trpc.workspace.documents.save.useMutation({ onError: (e) => toast.error(e.message) });
  const prefill = trpc.workspace.documents.prefill.useMutation({ onError: (e) => toast.error(e.message) });
  const hasPrefill = doc.fields.some((f) => f.prefill);
  const link = async (key: string | null) => { await flush(); await save.mutateAsync({ id: doc.id, subjectKey: key }); setQ(""); onLinked(); };
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Patient (optional)</p>
      {doc.patientName ? (
        <div className="space-y-2">
          <p className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5"><UserRound size={13} /> <b>{doc.patientName}</b></span>
            <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => void link(null)}>Remove</button></p>
          {hasPrefill && (
            <Btn size="sm" variant="secondary" className="w-full" disabled={prefill.isPending} onClick={async () => { await flush(); const r = await prefill.mutateAsync({ id: doc.id }); onPrefilled(r.fields); toast.success("Filled in the patient's details."); }}>
              Fill in the patient's details
            </Btn>
          )}
        </div>
      ) : (
        <>
          <input className={cn(inputCls, "h-8 text-xs")} placeholder="Search patients by name" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
            {(search.data ?? []).map((s) => (
              <li key={s.key}><button type="button" className="w-full rounded px-1.5 py-1 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-700" onClick={() => void link(s.key)}>
                <b>{s.name}</b> <span className="text-slate-500">{s.dob ? `DOB ${s.dob}` : ""}</span>
              </button></li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ViewSummary({ doc }: { doc: Doc }) {
  const signedBy = doc.signers.filter((s) => s.status === "signed");
  return (
    <div className="mb-3 rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-800">
      {doc.status === "completed" ? (
        <p className="flex items-center gap-2 font-semibold text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={16} /> Completed {doc.completedAt ? new Date(doc.completedAt).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}. Below is the signed PDF (with its certificate page).</p>
      ) : doc.status === "signing" ? (
        <p>Out for signature: {doc.signers.map((s) => `${s.name}${s.status === "signed" ? " ✓" : ""}`).join(", ")}. {signedBy.length}/{doc.signers.length} signed.</p>
      ) : <p>{DOC_STATUS_LABELS[doc.status]}.</p>}
      {doc.patientName && <p className="mt-1 text-xs text-slate-500">Patient: {doc.patientName}</p>}
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer font-semibold text-slate-600 dark:text-slate-300">History</summary>
        <ol className="mt-1 space-y-0.5">
          {doc.events.filter((e) => e.type !== "viewed").map((e, i) => (
            <li key={i} className="flex gap-2"><span className="w-32 shrink-0 text-slate-500">{new Date(e.at).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              <span>{e.type.replace(/_/g, " ")}{e.name ? ` · ${e.name}` : ""}{e.detail ? ` · ${e.detail}` : ""}</span></li>
          ))}
        </ol>
      </details>
    </div>
  );
}

