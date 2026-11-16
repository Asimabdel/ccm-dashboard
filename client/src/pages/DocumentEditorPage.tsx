// The Documents editor. Three modes:
//  • edit: the person preparing it places boxes on the PDF (text, date, checkbox, signature, initials) and
//    marks it up (white-out, highlight, ticks, lines, stamps), fills in their own boxes, picks who else
//    signs, then finishes it or sends it for signature. Boxes can be copied, repeated on every page,
//    nudged, lined up and undone.
//  • sign: a teammate it was sent to fills in and signs their highlighted boxes ("Next box" walks them through).
//  • view: read-only (the signed PDF once it's complete).
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, CheckCircle2, Download, FileStack, Loader2, Minus, Plus, Redo2, Send, Trash2, Undo2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Btn, ErrorNote, Loading, inputCls } from "@/components/workspace/ui";
import { SignatureDialog } from "@/components/documents/SignatureDialog";
import { FieldBox } from "@/components/documents/FieldBox";
import { FillDialog } from "@/components/documents/FillDialog";
import { Pages } from "@/components/documents/PdfPages";
import { FieldPanel, MultiPanel, PatientPanel, SignersPanel, ToolPalette, ViewSummary } from "@/components/documents/editorPanels";
import { PALETTE, useTouchScreen, type Doc, type SigMap, type ToolChoice } from "@/components/documents/editorShared";
import { openPdf, type PageViewport, type PdfDoc } from "@/lib/pdf";
import { downloadPdf } from "@/lib/pdfDownload";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { DOC_STATUS_LABELS, FIELD_DEFAULT_SIZE, isFilled, isMarkup, missingFor, signerOf, type Assignee, type DocField } from "@shared/documents";
import {
  alignFields, duplicateFields, emptyHistory, fillOrder, keepOnPage, newFieldId, nudgeFields, redo, remember, repeatOnPages, snapMove, undo, type AlignHow, type History,
} from "@shared/docEdit";

const MAX_BOXES = 600;
/** Marks that are usually added several at a time (ticking boxes, covering lines): the tool stays in hand until Esc. */
const STICKY_TOOLS = ["mark", "whiteout", "highlight", "line"];

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

const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

function Editor({ doc, refetch }: { doc: Doc; refetch: () => void }) {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const mode = doc.mode;
  const pages = doc.pages;
  const showFinal = doc.status === "completed" && doc.hasFinal;
  const [fields, setFields] = useState<DocField[]>(doc.fields);
  const fieldsRef = useRef(fields);
  const [title, setTitle] = useState(doc.title);
  const [message, setMessage] = useState(doc.message ?? "");
  const [sigs, setSigs] = useState<SigMap>(doc.signatures);
  const [selected, setSelected] = useState<string[]>([]);
  const [tool, setTool] = useState<ToolChoice | null>(null);
  const [newAssignee, setNewAssignee] = useState<Assignee>("preparer");
  const [zoom, setZoom] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [signing, setSigning] = useState<DocField | null>(null);
  const [filling, setFilling] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ page: number; x: number | null; y: number | null } | null>(null);
  // The signature / initials made a moment ago: the next box of that kind is signed with one tap.
  const [lastSig, setLastSig] = useState<{ signature?: string; initials?: string }>({});
  const touch = useTouchScreen();

  const me: Assignee = `signer:${doc.myUserId}`;
  const signerIds = doc.signers.map((s) => s.userId);
  const colorOf = (a: Assignee) => { const s = signerOf(a); const i = s ? signerIds.indexOf(s) + 1 : 0; return PALETTE[Math.max(0, i) % PALETTE.length]!; };
  const nameOf = (a: Assignee) => { const s = signerOf(a); return s ? doc.signers.find((x) => x.userId === s)?.name ?? "Signer" : "You"; };
  /** Can the person looking at this fill that box right now? (Marks are never filled in.) */
  const canFill = useCallback((f: DocField) => !isMarkup(f.type) && ((mode === "edit" && f.assignee === "preparer") || (mode === "sign" && f.assignee === me)), [mode, me]);

  /** Put new boxes in place without an undo step (they came from the server, or a signature was made). */
  const replaceFields = (v: DocField[]) => { fieldsRef.current = v; setFields(v); };

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
      save.mutate({ id: doc.id, title, fields: fieldsRef.current as unknown as Record<string, unknown>[], message }, { onError: (e) => { toast.error(e.message); setDirty(true); } });
    }, 900);
    return () => window.clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, fields, title, message, mode]);
  const flush = async () => {
    if (mode !== "edit") return;
    setDirty(false);
    await save.mutateAsync({ id: doc.id, title, fields: fieldsRef.current as unknown as Record<string, unknown>[], message });
  };

  // --- changing the boxes, with undo / redo ---
  const hist = useRef<History<DocField[]>>(emptyHistory());
  const lastTag = useRef<{ tag: string; at: number } | null>(null);
  const [, bump] = useState(0);
  /** Every change to the boxes while preparing goes through here so it can be undone. Quick changes of the same kind (a drag, typing) count as one step. */
  const change = (next: DocField[] | ((fs: DocField[]) => DocField[]), tag?: string) => {
    const before = fieldsRef.current;
    const value = typeof next === "function" ? next(before) : next;
    if (value === before) return;
    const now = Date.now();
    if (!(tag && lastTag.current?.tag === tag && now - lastTag.current.at < 1000)) { hist.current = remember(hist.current, before); bump((n) => n + 1); }
    lastTag.current = tag ? { tag, at: now } : null;
    replaceFields(value);
    setDirty(true);
  };
  const applyHistory = (r: { h: History<DocField[]>; value: DocField[] } | null) => {
    if (!r) return;
    hist.current = r.h;
    lastTag.current = null;
    // Signing isn't something to undo: a box that is signed now stays signed.
    const now = fieldsRef.current;
    const value = r.value.map((f) => { if (f.type !== "signature" && f.type !== "initials") return f; const cur = now.find((x) => x.id === f.id); return cur ? { ...f, value: cur.value ?? null } : f; });
    replaceFields(value);
    setSelected((s) => s.filter((id) => value.some((f) => f.id === id)));
    setDirty(true);
    bump((n) => n + 1);
  };
  const doUndo = () => applyHistory(undo(hist.current, fieldsRef.current));
  const doRedo = () => applyHistory(redo(hist.current, fieldsRef.current));

  const update = (fid: string, patch: Partial<DocField>, tag?: string) => change((fs) => fs.map((f) => (f.id === fid ? { ...f, ...patch } : f)), tag);
  const removeSelected = () => {
    if (!selected.length) return;
    change((fs) => fs.filter((f) => !selected.includes(f.id)));
    setSelected([]);
  };
  /** A value typed / ticked in a box: undoable while preparing; a signer's own answers are just kept. */
  const fillValue = (fid: string, v: string) => {
    if (mode === "edit") update(fid, { value: v }, `value:${fid}`);
    else replaceFields(fieldsRef.current.map((x) => (x.id === fid ? { ...x, value: v } : x)));
  };

  // --- copy, paste, every page ---
  const clipboard = useRef<DocField[]>([]);
  const hoverPage = useRef<number | null>(null);
  const addCopies = (copies: DocField[]) => {
    const room = MAX_BOXES - fieldsRef.current.length;
    if (!copies.length || room <= 0) return [];
    const added = copies.slice(0, room);
    change((fs) => [...fs, ...added]);
    setSelected(added.map((c) => c.id));
    return added;
  };
  const copySelected = () => { addCopies(duplicateFields(fieldsRef.current, selected, pages)); };
  const paste = () => {
    const src = clipboard.current;
    const onPage = hoverPage.current;
    // Pasted again and again, each copy steps a little further (the copies become what is pasted next).
    const added = addCopies(duplicateFields(src, src.map((f) => f.id), pages, onPage != null && src.every((f) => f.page !== onPage) ? { page: onPage, dx: 0, dy: 0 } : {}));
    if (added.length) clipboard.current = added;
  };
  const everyPage = (id: string) => {
    const copies = repeatOnPages(fieldsRef.current, id, pages).slice(0, Math.max(0, MAX_BOXES - fieldsRef.current.length));
    if (!copies.length) { toast.info("It's already on every page."); return; }
    change((fs) => [...fs, ...copies]);
    toast.success(`Added to ${copies.length} more page${copies.length === 1 ? "" : "s"}. (Undo takes them all back.)`);
  };

  // Keyboard while preparing: Esc, Delete, undo / redo, copy / paste / duplicate, select all, arrow keys.
  useEffect(() => {
    if (mode !== "edit") return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = /INPUT|TEXTAREA|SELECT/.test(el?.tagName ?? "") || !!el?.isContentEditable;
      if (signing || filling) return;
      if (e.key === "Escape") { setTool(null); setSelected([]); return; }
      if (typing) return;
      const cmd = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (cmd && k === "z") { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
      if (cmd && k === "y") { e.preventDefault(); doRedo(); return; }
      if (cmd && k === "c") { if (selected.length) clipboard.current = fieldsRef.current.filter((f) => selected.includes(f.id)); return; }
      if (cmd && k === "v") { if (clipboard.current.length) { e.preventDefault(); paste(); } return; }
      if (cmd && k === "d") { if (selected.length) { e.preventDefault(); copySelected(); } return; }
      if (cmd && k === "a") { e.preventDefault(); setSelected(fieldsRef.current.map((f) => f.id)); return; }
      if (!selected.length || cmd) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelected(); return; }
      const step = e.shiftKey ? 10 : 1;
      const d = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
      if (d) { e.preventDefault(); change((fs) => nudgeFields(fs, selected, d[0]!, d[1]!, pages), `nudge:${selected.join(",")}`); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selected, signing, filling]);

  /** A tool was used on a page: a click adds a box of the usual size, a drag sets its size. */
  const place = (page: number, vp: PageViewport, x0: number, y0: number, x1: number, y1: number) => {
    if (!tool || fieldsRef.current.length >= MAX_BOXES) return;
    const def = FIELD_DEFAULT_SIZE[tool.type];
    const dragged = Math.abs(x1 - x0) + Math.abs(y1 - y0) > 6;
    const min = tool.type === "line" ? 4 : 8;
    const w = dragged ? Math.max(min, Math.abs(x1 - x0) / vp.scale) : def.w;
    const h = dragged && tool.type !== "line" ? Math.max(min, Math.abs(y1 - y0) / vp.scale) : def.h;
    let [x, top] = vp.convertToPdfPoint(Math.min(x0, x1), Math.min(y0, y1)) as [number, number];
    // A tick, cross or circle lands centered on the click (to tick a printed box); a line sits where it was drawn.
    if (!dragged && tool.type === "mark") { x -= w / 2; top += h / 2; }
    if (tool.type === "line") top += h / 2 - (dragged ? Math.abs(y1 - y0) / vp.scale / 2 : 0);
    const assignee: Assignee = isMarkup(tool.type) ? "preparer" : newAssignee;
    const f: DocField = keepOnPage({
      id: newFieldId(), type: tool.type, page, x, y: top - h, w, h, assignee, required: tool.type === "signature" || tool.type === "initials",
      value: tool.type === "mark" ? tool.value ?? "check" : tool.type === "stamp" ? "COPY" : tool.type === "date" && assignee === "preparer" ? todayStr() : null,
    }, pages[page]);
    change((fs) => [...fs, f]);
    if (STICKY_TOOLS.includes(tool.type)) setSelected([]);
    else { setSelected([f.id]); setTool(null); }
  };

  // --- picking and dragging boxes ---
  const select = (fid: string, add: boolean) => {
    if (mode !== "edit") return;
    // A plain click on one of several picked boxes keeps them all picked, so they can be dragged together.
    setSelected((s) => (add ? (s.includes(fid) ? s.filter((x) => x !== fid) : [...s, fid]) : s.includes(fid) && s.length > 1 ? s : [fid]));
  };
  const dragStart = useRef<DocField[] | null>(null);
  const onMoveStart = () => { dragStart.current = fieldsRef.current; lastTag.current = null; };
  const onMove = (f: DocField, patch: Partial<DocField>, how: "move" | "resize", scale: number) => {
    if (how === "resize") { change((fs) => fs.map((x) => (x.id === f.id ? { ...x, ...patch } : x)), "drag"); return; }
    const start = dragStart.current ?? fieldsRef.current;
    const s0 = start.find((x) => x.id === f.id);
    if (!s0) return;
    const group = selected.includes(f.id) && selected.length > 1 ? selected : [f.id];
    let x = patch.x ?? s0.x, y = patch.y ?? s0.y;
    if (group.length === 1) {
      // One box: pull it onto the edges of the boxes near it and show the guide lines.
      const snap = snapMove(s0, x, y, fieldsRef.current, 5 / scale);
      x = snap.x; y = snap.y;
      setGuides(snap.guideX != null || snap.guideY != null ? { page: s0.page, x: snap.guideX, y: snap.guideY } : null);
    }
    const dx = x - s0.x, dy = y - s0.y;
    change((fs) => fs.map((o) => { if (!group.includes(o.id)) return o; const st = start.find((z) => z.id === o.id) ?? o; return keepOnPage({ ...o, x: st.x + dx, y: st.y + dy }, pages[o.page]); }), "drag");
  };
  const onMoveEnd = () => { dragStart.current = null; lastTag.current = null; setGuides(null); };

  // --- signing a box ---
  const mySig = trpc.workspace.documents.mySignature.useQuery();
  // Providers who picked this person to apply their stored signature (only for your own boxes while preparing).
  const providerSigs = trpc.workspace.documents.signaturesICanApply.useQuery(undefined, { enabled: mode === "edit" });
  const signField = trpc.workspace.documents.signField.useMutation();
  const doProviderSign = async (f: DocField, o: { providerUserId: number; approval: "in_person" | "phone" | "text" | "other"; note: string | null }) => {
    await flush();
    const r = await signField.mutateAsync({ id: doc.id, fieldId: f.id, onBehalfOf: o });
    setSigs((s) => ({ ...s, [r.value]: { png: r.png, name: r.name } }));
    replaceFields(fieldsRef.current.map((x) => (x.id === f.id ? { ...x, value: r.value } : x)));
    setSigning(null);
    toast.success(`${r.name}'s ${f.type === "initials" ? "initials" : "signature"} applied. They've been notified.`);
  };
  const doSign = async (f: DocField, png: string, saveAsMine: boolean) => {
    if (mode === "edit") await flush();
    const r = await signField.mutateAsync({ id: doc.id, fieldId: f.id, png, saveAsMine });
    setSigs((s) => ({ ...s, [r.value]: { png: r.png, name: user?.name ?? null } }));
    replaceFields(fieldsRef.current.map((x) => (x.id === f.id ? { ...x, value: r.value } : x)));
    setLastSig((s) => ({ ...s, [f.type === "initials" ? "initials" : "signature"]: png }));
    if (saveAsMine) void utils.workspace.documents.mySignature.invalidate();
    setSigning(null);
  };
  /** Sign this box: with the signature made a moment ago (one tap), or by opening the signature window. */
  const startSign = (f: DocField) => {
    // Only for someone signing their part: while preparing, the signature window also offers a provider's signature.
    const again = mode === "sign" ? lastSig[f.type === "initials" ? "initials" : "signature"] : undefined;
    if (again) void doSign(f, again, false).catch((e) => toast.error((e as Error).message));
    else setSigning(f);
  };

  // --- "Next box": walk the person through what they still have to fill in ---
  const todo = fillOrder(fields).filter((f) => canFill(f) && f.required && !isFilled(f));
  const goTo = (f: DocField) => {
    setFlash(f.id);
    window.setTimeout(() => setFlash((x) => (x === f.id ? null : x)), 2400);
    const el = document.getElementById(`box-${f.id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (f.type === "signature" || f.type === "initials") window.setTimeout(() => startSign(f), 450);
    else if (f.type !== "checkbox") {
      if (touch) window.setTimeout(() => setFilling(f.id), 450);
      else window.setTimeout(() => (el?.querySelector("input, textarea") as HTMLElement | null)?.focus({ preventScroll: true }), 450);
    }
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
    const values = Object.fromEntries(fieldsRef.current.filter((f) => f.assignee === me && f.type !== "signature" && f.type !== "initials").map((f) => [f.id, f.value ?? ""]));
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
  const sel = selected.length === 1 ? fields.find((f) => f.id === selected[0]) ?? null : null;
  const fillingField = filling ? fields.find((f) => f.id === filling) ?? null : null;
  const pageCount = pdf?.numPages ?? pages.length;
  const stepBtn = "px-2 py-1.5 disabled:opacity-30";

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
          {mode === "edit" && (
            <div className="flex items-center rounded-lg border border-slate-200 dark:border-slate-700">
              <button type="button" className={stepBtn} disabled={!hist.current.past.length} onClick={doUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={14} /></button>
              <button type="button" className={stepBtn} disabled={!hist.current.future.length} onClick={doRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><Redo2 size={14} /></button>
            </div>
          )}
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
                <ToolPalette tool={tool} onTool={(t) => { setTool(t); if (t) setSelected([]); }} isTemplate={doc.isTemplate} signers={doc.signers} newAssignee={newAssignee} onNewAssignee={setNewAssignee} />

                {selected.length > 1 ? (
                  <MultiPanel count={selected.length} onAlign={(how: AlignHow) => change((fs) => alignFields(fs, selected, how, pages))} onCopy={copySelected} onDelete={removeSelected} />
                ) : sel ? (
                  <FieldPanel f={sel} doc={doc} isTemplate={doc.isTemplate} pageCount={pages.length}
                    onChange={(p) => update(sel.id, p, `panel:${sel.id}:${Object.keys(p).join(",")}`)} onDelete={removeSelected} onCopy={copySelected} onEveryPage={() => everyPage(sel.id)} />
                ) : null}

                {!doc.isTemplate && (
                  <SignersPanel doc={doc} fields={fields} colorOf={colorOf} onChanged={(ids) => {
                    // Boxes of someone removed go back to you (like the server does).
                    replaceFields(fieldsRef.current.map((f) => { const s = signerOf(f.assignee); return s && !ids.includes(s) ? { ...f, assignee: "preparer", value: null } : f; }));
                    if (signerOf(newAssignee) && !ids.includes(signerOf(newAssignee)!)) setNewAssignee("preparer");
                    refetch();
                  }} />
                )}

                {!doc.isTemplate && (
                  <PatientPanel doc={doc} onLinked={() => refetch()} onPrefilled={(fs) => replaceFields(fs)} flush={flush} />
                )}

                {!doc.isTemplate && doc.signers.length > 0 && (
                  <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Message to signers (optional)</p>
                    <textarea className={cn(inputCls, "h-20 text-xs")} value={message} maxLength={1000} onChange={(e) => { setMessage(e.target.value); setDirty(true); }} />
                  </section>
                )}

                {myMissing.length > 0 && (
                  <p className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    <span>{myMissing.length} required box{myMissing.length === 1 ? "" : "es"} of yours still empty.</span>
                    {todo[0] && <button type="button" className="shrink-0 font-bold underline" onClick={() => goTo(todo[0]!)}>Show me</button>}
                  </p>
                )}
                <button type="button" className="flex items-center gap-1 text-xs font-semibold text-red-600 hover:underline" disabled={cancel.isPending}
                  onClick={async () => { if (!window.confirm(doc.isTemplate ? "Delete this template?" : "Cancel this document?")) return; try { await cancel.mutateAsync({ id: doc.id }); navigate("/documents"); } catch (e) { toast.error((e as Error).message); } }}>
                  <Trash2 size={12} /> {doc.isTemplate ? "Delete template" : "Cancel document"}
                </button>
              </>
            ) : (
              <section className="rounded-xl border border-violet-200 bg-violet-50 p-3 dark:border-violet-900 dark:bg-violet-950/40">
                <p className="font-semibold">Your part</p>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{doc.creator ?? "A teammate"} sent you this to fill in and sign. Your boxes are highlighted. "Next box" takes you to each one.</p>
                {doc.message && <p className="mt-2 rounded-md bg-white/70 p-2 text-xs italic dark:bg-slate-900/40">"{doc.message}"</p>}
                <p className="mt-2 text-xs">{myMissing.length ? `${myMissing.length} required box${myMissing.length === 1 ? "" : "es"} left.` : "All your required boxes are done."}</p>
                {(lastSig.signature || lastSig.initials) && (
                  <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">One tap now signs a box with the signature you just made. <button type="button" className="font-semibold underline" onClick={() => setLastSig({})}>Sign differently</button></p>
                )}
                {todo[0]
                  ? <Btn className="mt-3 w-full" onClick={() => goTo(todo[0]!)}>Next box <ArrowRight size={14} /></Btn>
                  : <Btn className="mt-3 w-full" disabled={busy} onClick={doFinishSigning}>{finishSigning.isPending && <Loader2 size={13} className="animate-spin" />} Finish signing</Btn>}
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
            <Pages pdf={pdf} count={pageCount} zoom={zoom} drawing={mode === "edit" && !!tool}
              onPageClick={() => setSelected([])} onDraw={place} onHover={(p) => { hoverPage.current = p; }}
              overlay={(page, vp) => showFinal ? null : (
                <>
                  {fields.filter((f) => f.page === page).map((f) => (
                    <FieldBox key={f.id} f={f} vp={vp} color={colorOf(f.assignee)} who={nameOf(f.assignee)} editable={mode === "edit"} inert={!!tool}
                      fillable={canFill(f)} selected={selected.includes(f.id)} resizable={selected.length === 1 && selected[0] === f.id} flash={flash === f.id}
                      tapToFill={touch} sig={f.value ? sigs[f.value] ?? null : null}
                      onSelect={(add) => select(f.id, add)} onMoveStart={onMoveStart} onMove={(p, how, scale) => onMove(f, p, how, scale)} onMoveEnd={onMoveEnd}
                      onValue={(v) => fillValue(f.id, v)} onSign={() => startSign(f)} onTapFill={() => setFilling(f.id)} />
                  ))}
                  {guides && guides.page === page && guides.x != null && <div className="pointer-events-none absolute inset-y-0 w-px bg-fuchsia-500" style={{ left: (vp.convertToViewportPoint(guides.x, 0) as number[])[0] }} />}
                  {guides && guides.page === page && guides.y != null && <div className="pointer-events-none absolute inset-x-0 h-px bg-fuchsia-500" style={{ top: (vp.convertToViewportPoint(0, guides.y) as number[])[1] }} />}
                </>
              )} />
          )}
          {/* Signing: a bar that stays in view and walks through the boxes that are left. */}
          {mode === "sign" && pdf && (
            <div className="sticky bottom-3 z-20 mt-2 flex justify-center px-2">
              <div className="flex w-full max-w-md items-center justify-between gap-3 rounded-2xl border border-violet-300 bg-white/95 p-2 ps-4 shadow-lg backdrop-blur dark:border-violet-800 dark:bg-slate-900/95">
                <p className="text-sm font-semibold">{todo.length ? `${todo.length} box${todo.length === 1 ? "" : "es"} left for you` : "All your boxes are done"}</p>
                {todo[0]
                  ? <Btn onClick={() => goTo(todo[0]!)}>Next box <ArrowRight size={14} /></Btn>
                  : <Btn disabled={busy} onClick={doFinishSigning}>{finishSigning.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Finish signing</Btn>}
              </div>
            </div>
          )}
        </div>
      </div>

      <FillDialog field={fillingField} onClose={() => setFilling(null)} onSave={(v) => { if (fillingField) fillValue(fillingField.id, v); }} />
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
