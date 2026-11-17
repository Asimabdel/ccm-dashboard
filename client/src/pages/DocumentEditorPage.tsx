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
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CheckCircle2, ChevronDown, Download, FileStack, FileText, Loader2, Maximize2, Minus, MoveHorizontal, PanelRight, Plus, Redo2, RotateCw, Send, Trash2, Undo2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Btn, ErrorNote, Loading, inputCls } from "@/components/workspace/ui";
import { SignatureDialog } from "@/components/documents/SignatureDialog";
import { FieldBox } from "@/components/documents/FieldBox";
import { FillDialog } from "@/components/documents/FillDialog";
import { Pages, type PageFit } from "@/components/documents/PdfPages";
import { Thumbnails } from "@/components/documents/Thumbnails";
import { DocHistory, DocProgress } from "@/components/documents/DocProgress";
import { EditorToolbar } from "@/components/documents/EditorToolbar";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FieldPanel, MultiPanel, PagesPanel, PatientPanel, SignersPanel, WhoPanel, officeLine } from "@/components/documents/editorPanels";
import { PRACTICE_FAX, PRACTICE_PHONE, STAMP_GALLERY, logoKindOf, logoSize, officeShortName, stampSize } from "@shared/stamps";
import { PALETTE, useTouchScreen, type Doc, type SigMap, type ToolChoice } from "@/components/documents/editorShared";
import { addPagesFromFile, isDocFile, uploadPart } from "@/components/documents/uploadFiles";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AnnotationMode, openPdf, type PageViewport, type PdfDoc } from "@/lib/pdf";
import { downloadPdf } from "@/lib/pdfDownload";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { DOC_STATUS_LABELS, FIELD_DEFAULT_SIZE, isFilled, isMarkup, missingFor, signerOf, type Assignee, type DocField } from "@shared/documents";
import {
  alignFields, duplicateFields, editTextBoxes, emptyHistory, fillOrder, keepOnPage, newFieldId, nudgeFields, redo, remember, repeatOnPages, snapMove, undo, type AlignHow, type History,
} from "@shared/docEdit";
import { whiteoutPages, type PageChange } from "@shared/docPages";
import { AI_WHO, suggestBoxes, textRunAt, whoOfLabel, type PageText } from "@shared/docSuggest";

const MAX_BOXES = 600;
/** Marks that are usually added several at a time (ticking boxes, covering lines): the tool stays in hand until Esc. */
const STICKY_TOOLS = ["mark", "whiteout", "highlight", "line"];

export default function DocumentEditorPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const { id } = useParams<{ id: string }>();
  const docId = Number(id);
  const q = trpc.workspace.documents.get.useQuery({ id: docId }, { enabled: !!user && docId > 0, refetchOnWindowFocus: false });
  return (
    <CCMDashboardLayout title={q.data?.title ?? "Documents"} pageTitle={false} focus>
      {q.isLoading && <Loading />}
      {q.error && <div className="p-6"><ErrorNote message={q.error.message} /></div>}
      {/* A new file (pages added, removed, moved, turned) starts the editor fresh on it. */}
      {q.data && <Editor key={`${q.data.id}:${q.data.status}:${q.data.mode}:${q.data.fileRev}`} doc={q.data} refetch={() => void q.refetch()} />}
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

  // --- the words printed on each page (read once per page): for "Edit text" and "Suggest boxes" ---
  const textCache = useRef(new Map<number, PageText[]>());
  const pageText = async (i: number): Promise<PageText[]> => {
    const have = textCache.current.get(i);
    if (have || !pdf) return have ?? [];
    const page = await pdf.getPage(i + 1);
    const content = await page.getTextContent();
    // Is a piece of text in a bold font? Known once the page has been drawn (its fonts are loaded then).
    const boldFont = (name: string) => {
      try {
        if (!page.commonObjs.has(name)) return false;
        const font = page.commonObjs.get(name) as { name?: string; bold?: boolean } | null;
        return !!font?.bold || /bold|black|heavy|semibold|demi/i.test(font?.name ?? "");
      } catch { return false; }
    };
    const items: PageText[] = [];
    for (const it of content.items) {
      if (!("str" in it) || !it.str.trim()) continue;
      items.push({ str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, w: it.width, h: it.height || Math.abs(it.transform[3] as number), bold: boldFont(it.fontName) });
    }
    textCache.current.set(i, items);
    return items;
  };

  /** "Edit text": pick up the printed words that were clicked, cover them, and put the same words in a box to retype. */
  const editTextAt = async (page: number, vp: PageViewport, px: number, py: number) => {
    if (pages[page]?.rotate) { toast.info("This page is lying on its side. Turn it upright first (the turn button above the page), then edit its text."); return; }
    const [x, y] = vp.convertToPdfPoint(px, py) as [number, number];
    const run = textRunAt(await pageText(page).catch(() => []), x, y);
    if (!run) { toast.info("No printed words there that MyPCP can pick up. On a scanned or photographed page, cover the words with White-out and add a Text box on top."); return; }
    if (fieldsRef.current.length + 2 > MAX_BOXES) return;
    const [white, text] = editTextBoxes(page, pages[page]!, run);
    change((fs) => [...fs, white, text]);
    setTool(null);
    setSelected([text.id]);
    window.setTimeout(() => { const el = document.querySelector(`#box-${text.id} input, #box-${text.id} textarea`) as HTMLInputElement | null; el?.focus(); el?.select(); }, 60);
  };

  /** A tool was used on a page: a click adds a box of the usual size, a drag sets its size. */
  const place = (page: number, vp: PageViewport, x0: number, y0: number, x1: number, y1: number) => {
    if (!tool || fieldsRef.current.length >= MAX_BOXES) return;
    if (tool.type === "edittext") { void editTextAt(page, vp, x1, y1); return; }
    // A stamp or the logo: the one picked in the gallery, with today's date, my name and the office filled in.
    const preset = tool.type === "stamp" ? STAMP_GALLERY.find((p) => p.id === tool.value) ?? STAMP_GALLERY[0]! : null;
    const logoKind = tool.type === "logo" ? logoKindOf({ kind: tool.value }) : null;
    const office = doc.offices.find((o) => o.id === doc.officeId) ?? null;
    const def = preset ? stampSize(preset.kind, preset.word) : logoKind ? logoSize(logoKind) : FIELD_DEFAULT_SIZE[tool.type];
    const dragged = Math.abs(x1 - x0) + Math.abs(y1 - y0) > 6;
    const min = tool.type === "line" ? 4 : 8;
    let w = dragged ? Math.max(min, Math.abs(x1 - x0) / vp.scale) : def.w;
    let h = dragged && tool.type !== "line" ? Math.max(min, Math.abs(y1 - y0) / vp.scale) : def.h;
    // A round seal stays round.
    if (preset?.kind === "seal" && dragged) w = h = Math.max(w, h);
    let [x, top] = vp.convertToPdfPoint(Math.min(x0, x1), Math.min(y0, y1)) as [number, number];
    // A tick, cross or circle lands centered on the click (to tick a printed box); a line sits where it was drawn.
    if (!dragged && tool.type === "mark") { x -= w / 2; top += h / 2; }
    if (tool.type === "line") top += h / 2 - (dragged ? Math.abs(y1 - y0) / vp.scale / 2 : 0);
    const assignee: Assignee = isMarkup(tool.type) ? "preparer" : newAssignee;
    const f: DocField = keepOnPage({
      id: newFieldId(), type: tool.type, page, x, y: top - h, w, h, assignee, required: tool.type === "signature" || tool.type === "initials",
      value: tool.type === "mark" ? tool.value ?? "check" : preset ? preset.word : tool.type === "date" && assignee === "preparer" ? todayStr() : null,
      ...(preset ? { color: preset.color, design: { kind: preset.kind, date: preset.kind === "plain" ? null : todayStr(), by: preset.kind === "signed" ? doc.myName : null, place: preset.kind === "dated" || preset.kind === "seal" ? officeLine(office?.name) : null } } : {}),
      ...(logoKind ? { design: { kind: logoKind, place: officeShortName(office?.name), address: office?.address ?? null, phone: PRACTICE_PHONE, fax: PRACTICE_FAX } } : {}),
    }, pages[page]);
    change((fs) => [...fs, f]);
    if (STICKY_TOOLS.includes(tool.type)) setSelected([]);
    else { setSelected([f.id]); setTool(null); }
  };

  // --- page tools: move, turn, remove a page; add pages from other files. The server rebuilds the PDF. ---
  const changePages = trpc.workspace.documents.changePages.useMutation();
  const [pageBusy, setPageBusy] = useState(false);
  // A question before something that can't be undone (removing a page, cancelling the document), in a real window.
  const [ask, setAsk] = useState<{ title: string; text: string; yes: string; danger?: boolean; run: () => void } | null>(null);
  const pageChange = async (c: PageChange, confirmText?: string, confirmed = false) => {
    if (pageBusy) return;
    if (confirmText && !confirmed) { setAsk({ title: "Remove this page?", text: confirmText, yes: "Remove page", danger: true, run: () => void pageChange(c, confirmText, true) }); return; }
    setPageBusy(true);
    try {
      await flush();
      await changePages.mutateAsync({ id: doc.id, change: c });
      refetch();
    } catch (e) { toast.error((e as Error).message); } finally { setPageBusy(false); }
  };
  const addPages = async (files: File[]) => {
    const bad = files.find((f) => !isDocFile(f));
    if (bad) { toast.error(`"${bad.name}" isn't a PDF or a photo.`); return; }
    setPageBusy(true);
    let added = 0;
    try {
      await flush();
      for (const f of files) added += (await addPagesFromFile(utils.client, doc.id, f)).added;
      toast.success(`Added ${added} page${added === 1 ? "" : "s"} at the end.`);
    } catch (e) {
      toast.error(`${(e as Error).message}${added ? ` (${added} page${added === 1 ? " was" : "s were"} added before that.)` : ""}`);
    } finally { setPageBusy(false); refetch(); }
  };

  // --- "Suggest boxes": read the words on each page and add a box on every blank it finds ---
  // Quick: plain pattern matching on the page's own words, in the browser. Pages with no words (scans, photos) are
  // read by the practice's AI model when it is set up. "ai": every upright page is read by the AI (it also says
  // who fills each box). Either way the boxes are only proposed: one undo step, all picked, for the preparer to check.
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const aiRead = trpc.workspace.documents.aiReadPage.useMutation();
  const AI_MAX_PAGES = 12;
  /** A picture of one page (about 1100 px wide, JPEG) for the AI to look at. */
  const pageJpeg = async (i: number) => {
    const page = await pdf!.getPage(i + 1);
    const vp = page.getViewport({ scale: Math.min(2, 1100 / page.getViewport({ scale: 1 }).width) });
    const c = document.createElement("canvas");
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    // "print" draws in one go instead of frame by frame, so it also finishes when the tab is in the background.
    await page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise;
    return c.toDataURL("image/jpeg", 0.8);
  };
  const suggest = async (how: "quick" | "ai") => {
    if (!pdf || suggesting) return;
    setSuggesting("Reading the pages…");
    const proposed: DocField[] = [];
    const propose = (list: Omit<DocField, "id" | "assignee">[]) => { for (const s of list) proposed.push({ id: `${newFieldId()}${proposed.length}`, assignee: "preparer", value: null, ...s }); };
    let turned = 0, skipped = 0, aiFailed: string | null = null;
    try {
      const count = Math.min(pdf.numPages, pages.length);
      const forAi: number[] = [];
      for (let i = 0; i < count; i++) {
        if (pages[i]!.rotate) { turned++; continue; }
        if (how === "ai") { forAi.push(i); continue; }
        const items = await pageText(i);
        if (!items.length) forAi.push(i);
        else propose(suggestBoxes(i, pages[i]!, items, [...fieldsRef.current, ...proposed]));
      }
      if (forAi.length && doc.aiReady) {
        await flush(); // the server leaves out anything on top of a box that is already there
        const read = forAi.slice(0, AI_MAX_PAGES);
        skipped = forAi.length - read.length;
        for (let n = 0; n < read.length; n++) {
          setSuggesting(`AI is reading page ${read[n]! + 1} (${n + 1} of ${read.length})…`);
          try { propose((await aiRead.mutateAsync({ id: doc.id, page: read[n]!, image: await pageJpeg(read[n]!) })).boxes); } catch (e) { aiFailed = (e as Error).message; break; }
        }
      }
      const added = proposed.slice(0, Math.max(0, MAX_BOXES - fieldsRef.current.length));
      if (aiFailed) toast.error(aiFailed);
      if (!added.length) {
        if (!aiFailed) toast.info(turned ? "No blanks found. Pages lying on their side are skipped: turn them upright first (the turn button above the page)."
          : forAi.length && !doc.aiReady ? "No blanks found. These pages are scans or photos with no words to read, and AI reading isn't set up here: add the boxes by hand."
          : "No blanks found to put boxes on.");
        return;
      }
      change((fs) => [...fs, ...added]);
      setTool(null);
      setSelected(added.map((f) => f.id));
      const by = AI_WHO.map((w) => [w, added.filter((f) => whoOfLabel(f.label) === w).length] as const).filter(([, n]) => n > 0);
      toast.success(`Added ${added.length} suggested box${added.length === 1 ? "" : "es"}${by.length ? ` (${by.map(([w, n]) => `${n} for the ${w === "other" ? "form" : w}`).join(", ")})` : ""}. Please check each one. Undo (Ctrl+Z) takes them all back.${skipped ? ` Only the first ${AI_MAX_PAGES} pages were read by AI.` : ""}`);
    } catch (e) { toast.error(`Couldn't read the pages: ${(e as Error).message}`); } finally { setSuggesting(null); }
  };
  /** Boxes grouped by who the AI said fills them ("Provider: …"), to pick a whole group and hand it to a signer. */
  const whoGroups = AI_WHO.map((who) => ({ who, ids: fields.filter((f) => !isMarkup(f.type) && whoOfLabel(f.label) === who).map((f) => f.id) })).filter((g) => g.ids.length > 0);

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
  // --- white-out for real: a white box on top only hides what's under it (it could still be copied out of the
  // PDF). Before finishing or sending, each page with white-out becomes a picture of the page with the white-out
  // painted in, so what was covered is gone from the file. ---
  const applyWhiteoutM = trpc.workspace.documents.applyWhiteout.useMutation();
  const [whiteoutAsk, setWhiteoutAsk] = useState<number[] | null>(null);
  const [whiteoutBusy, setWhiteoutBusy] = useState<string | null>(null);
  const busy = send.isPending || finishSigning.isPending || cancel.isPending || !!whiteoutBusy;
  /** The page drawn without its fill-in boxes (they print later), at about 200 dpi, with the white-out painted in. */
  const whiteoutPicture = async (i: number, covers: DocField[]): Promise<Blob> => {
    const page = await pdf!.getPage(i + 1);
    // Drawn upright as stored (the page keeps its own turn), so box positions match the picture exactly.
    const base = page.getViewport({ scale: 1, rotation: 0 });
    const vp = page.getViewport({ scale: Math.min(3, 2200 / Math.max(base.width, base.height)), rotation: 0 });
    const c = document.createElement("canvas");
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: "print", annotationMode: AnnotationMode.DISABLE }).promise;
    ctx.fillStyle = "#fff";
    for (const f of covers) {
      const [x1, y1] = vp.convertToViewportPoint(f.x, f.y + f.h) as [number, number];
      const [x2, y2] = vp.convertToViewportPoint(f.x + f.w, f.y) as [number, number];
      ctx.fillRect(Math.floor(Math.min(x1, x2)) - 1, Math.floor(Math.min(y1, y2)) - 1, Math.ceil(Math.abs(x2 - x1)) + 2, Math.ceil(Math.abs(y2 - y1)) + 2);
    }
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.92));
    if (!blob) throw new Error("This browser couldn't draw the page.");
    return blob;
  };
  /** Apply every white-out, page by page. Returns false if it didn't finish (the editor then reloads what's saved). */
  const applyWhiteouts = async (): Promise<boolean> => {
    const list = whiteoutPages(fieldsRef.current);
    try {
      for (let n = 0; n < list.length; n++) {
        const p = list[n]!;
        setWhiteoutBusy(`Removing what's under the white-out: page ${p + 1}${list.length > 1 ? ` (${n + 1} of ${list.length})` : ""}…`);
        const part = await uploadPart(utils.client, doc.id, await whiteoutPicture(p, fieldsRef.current.filter((f) => f.type === "whiteout" && f.page === p)));
        await applyWhiteoutM.mutateAsync({ id: doc.id, part, page: p });
      }
      return true;
    } catch (e) {
      toast.error(`The white-out couldn't be applied: ${(e as Error).message}`);
      refetch();
      return false;
    } finally { setWhiteoutBusy(null); }
  };
  const doSend = async (whiteoutOk = false) => {
    try {
      await flush();
      if (whiteoutPages(fieldsRef.current).length) {
        // Required boxes first, so the white-out isn't applied to a document that can't go out yet.
        const miss = missingFor(fieldsRef.current, "preparer");
        if (miss.length) { toast.error(`Fill in ${miss.length === 1 ? `"${miss[0]!.label || "the required box"}"` : `the ${miss.length} required boxes`} first.`); goTo(miss[0]!); return; }
        if (!whiteoutOk) { setWhiteoutAsk(whiteoutPages(fieldsRef.current)); return; }
        if (!(await applyWhiteouts())) return;
      }
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
  /** "final" = with the certificate page (the record); "copy" = the pages alone, to hand to the patient, an employer or a school. */
  const download = async (which: "final" | "copy") => {
    try { downloadPdf(await fileM.mutateAsync({ id: doc.id, which }), `${doc.title}${which === "copy" ? "" : " (signed)"}.pdf`); } catch (e) { toast.error((e as Error).message); }
  };
  const excuseNote = doc.fileName === "excuse-note.pdf";

  const myMissing = mode === "sign" ? missingFor(fields, me) : mode === "edit" ? missingFor(fields, "preparer") : [];
  const sel = selected.length === 1 ? fields.find((f) => f.id === selected[0]) ?? null : null;
  const fillingField = filling ? fields.find((f) => f.id === filling) ?? null : null;
  const pageCount = pdf?.numPages ?? pages.length;
  const stepBtn = "flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent dark:text-slate-300 dark:hover:bg-slate-700";
  const pageBtn = "rounded-md p-1.5 text-slate-500 hover:bg-slate-200 hover:text-slate-900 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-slate-700 dark:hover:text-slate-100";

  // --- the full-screen layout: page thumbnails · the pages · the side panel; zoom and fit ---
  const scroller = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<PageFit>(null);
  const [current, setCurrent] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [templateName, setTemplateName] = useState<string | null>(null);
  const zoomBy = (d: number) => { setFit(null); setZoom((z) => Math.min(2.5, Math.max(0.5, +(z + d).toFixed(2)))); };
  // Ctrl + mouse wheel zooms the pages (not the whole browser page).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoomBy(e.deltaY < 0 ? 0.1 : -0.1); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** Which page is in view (the one whose top passed a third of the way down). */
  const onScroll = () => {
    const sc = scroller.current;
    if (!sc) return;
    const line = sc.getBoundingClientRect().top + sc.clientHeight * 0.33;
    let cur = 0;
    sc.querySelectorAll<HTMLElement>("[data-page-index]").forEach((el) => { if (el.getBoundingClientRect().top <= line) cur = Number(el.dataset.pageIndex); });
    setCurrent((c) => (c === cur ? c : cur));
  };
  const jumpTo = (i: number) => scroller.current?.querySelector(`[data-page-index="${i}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const first = pages[0];
  const aspect = first ? (first.rotate % 180 ? first.w / first.h : first.h / first.w) : 792 / 612;
  const zoomLabel = fit === "width" ? "Fit width" : fit === "page" ? "Whole page" : `${Math.round(zoom * 100)}%`;
  const saveTemplate = async (t: string) => {
    try { await flush(); await asTemplate.mutateAsync({ id: doc.id, title: t }); toast.success("Saved as a template (see the Templates tab)."); } catch (e) { toast.error((e as Error).message); }
  };
  const cancelDoc = () => setAsk({
    title: doc.isTemplate ? "Delete this template?" : "Cancel this document?",
    text: doc.isTemplate ? "Documents already made from it stay as they are." : "Signers' tasks are closed and nobody can sign it anymore. It stays on file as cancelled.",
    yes: doc.isTemplate ? "Delete template" : "Cancel document", danger: true,
    run: async () => { try { await cancel.mutateAsync({ id: doc.id }); navigate("/documents"); } catch (e) { toast.error((e as Error).message); } },
  });
  const sectionCls = "rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800";
  const sectionHead = "mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500";

  // The side panel (right on big screens; a drawer on phones and tablets).
  const history = doc.events.length > 0 && (
    <details className={sectionCls} open={mode === "view"}>
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">History</summary>
      <div className="mt-3"><DocHistory doc={doc} /></div>
    </details>
  );
  const side = mode === "edit" ? (
    <>
      {selected.length > 1 ? (
        <>
          <button type="button" className="text-xs font-semibold text-brand hover:underline dark:text-teal-300" onClick={() => setSelected([])}>← Back to the document</button>
          <MultiPanel count={selected.length} onAlign={(how: AlignHow) => change((fs) => alignFields(fs, selected, how, pages))} onCopy={copySelected} onDelete={removeSelected}
            signers={doc.signers}
            onAssign={doc.isTemplate ? undefined : (who) => change((fs) => fs.map((f) => (selected.includes(f.id) && !isMarkup(f.type) && f.assignee !== who ? { ...f, assignee: who, value: who === "preparer" ? f.value ?? null : null } : f)))} />
        </>
      ) : sel ? (
        <>
          <button type="button" className="text-xs font-semibold text-brand hover:underline dark:text-teal-300" onClick={() => setSelected([])}>← Back to the document</button>
          <FieldPanel f={sel} doc={doc} isTemplate={doc.isTemplate} pageCount={pages.length}
            onChange={(p) => update(sel.id, p, `panel:${sel.id}:${Object.keys(p).join(",")}`)} onDelete={removeSelected} onCopy={copySelected} onEveryPage={() => everyPage(sel.id)} />
        </>
      ) : (
        <>
          {myMissing.length > 0 && (
            <p className="flex items-center justify-between gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <span>{myMissing.length} required box{myMissing.length === 1 ? "" : "es"} of yours still empty.</span>
              {todo[0] && <button type="button" className="shrink-0 font-bold underline" onClick={() => { setPanelOpen(false); goTo(todo[0]!); }}>Show me</button>}
            </p>
          )}
          {whoGroups.length > 0 && <WhoPanel groups={whoGroups} onPick={(ids) => { setTool(null); setSelected(ids); }} />}
          {!doc.isTemplate && (
            <SignersPanel doc={doc} fields={fields} colorOf={colorOf} onChanged={(ids) => {
              // Boxes of someone removed go back to you (like the server does).
              replaceFields(fieldsRef.current.map((f) => { const s = signerOf(f.assignee); return s && !ids.includes(s) ? { ...f, assignee: "preparer", value: null } : f; }));
              if (signerOf(newAssignee) && !ids.includes(signerOf(newAssignee)!)) setNewAssignee("preparer");
              refetch();
            }} />
          )}
          {!doc.isTemplate && <PatientPanel doc={doc} onLinked={() => refetch()} onPrefilled={(fs) => replaceFields(fs)} flush={flush} />}
          {!doc.isTemplate && doc.signers.length > 0 && (
            <section className={sectionCls}>
              <p className={sectionHead}>Message to signers (optional)</p>
              <textarea className={cn(inputCls, "h-20 text-xs")} value={message} maxLength={1000} onChange={(e) => { setMessage(e.target.value); setDirty(true); }} />
            </section>
          )}
          <PagesPanel count={pages.length} busy={pageBusy} onAdd={(files) => void addPages(files)} />
          {history}
          <button type="button" className="flex items-center gap-1 text-xs font-semibold text-red-600 hover:underline" disabled={cancel.isPending} onClick={cancelDoc}>
            <Trash2 size={12} /> {doc.isTemplate ? "Delete template" : "Cancel document"}
          </button>
        </>
      )}
    </>
  ) : mode === "sign" ? (
    <>
      <section className="rounded-xl border border-violet-200 bg-violet-50 p-3 dark:border-violet-900 dark:bg-violet-950/40">
        <p className="font-semibold">Your part</p>
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{doc.creator ?? "A teammate"} sent you this to fill in and sign. Your boxes are highlighted. "Next box" takes you to each one.</p>
        {doc.message && <p className="mt-2 rounded-md bg-white/70 p-2 text-xs italic dark:bg-slate-900/40">"{doc.message}"</p>}
        <p className="mt-2 text-xs">{myMissing.length ? `${myMissing.length} required box${myMissing.length === 1 ? "" : "es"} left.` : "All your required boxes are done."}</p>
        {(lastSig.signature || lastSig.initials) && (
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">One tap now signs a box with the signature you just made. <button type="button" className="font-semibold underline" onClick={() => setLastSig({})}>Sign differently</button></p>
        )}
        {todo[0]
          ? <Btn className="mt-3 w-full" onClick={() => { setPanelOpen(false); goTo(todo[0]!); }}>Next box <ArrowRight size={14} /></Btn>
          : <Btn className="mt-3 w-full" disabled={busy} onClick={doFinishSigning}>{finishSigning.isPending && <Loader2 size={13} className="animate-spin" />} Finish signing</Btn>}
      </section>
      {history}
    </>
  ) : (
    <>
      <section className={sectionCls}>
        {doc.status === "completed" ? (
          <p className="flex items-start gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={16} className="mt-0.5 shrink-0" /> Completed {doc.completedAt ? new Date(doc.completedAt).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</p>
        ) : <p className="text-sm font-semibold">{DOC_STATUS_LABELS[doc.status]}</p>}
        <p className="mt-1 text-xs text-slate-500">{showFinal ? "You're looking at the signed PDF, with its certificate page at the end." : doc.status === "signing" ? "Out for signature. You can follow each signer in the line above." : ""}</p>
        {doc.patientName && <p className="mt-2 text-xs text-slate-500">Patient: <b className="text-slate-700 dark:text-slate-200">{doc.patientName}</b></p>}
        {doc.status === "completed" && (
          <div className="mt-3 flex flex-col gap-1.5">
            {excuseNote
              ? <><Btn size="sm" onClick={() => void download("copy")}><Download size={13} /> Download the note</Btn><Btn size="sm" variant="secondary" onClick={() => void download("final")}>With certificate page</Btn></>
              : <><Btn size="sm" onClick={() => void download("final")}><Download size={13} /> Download signed PDF</Btn><Btn size="sm" variant="secondary" onClick={() => void download("copy")}>Without certificate page</Btn></>}
          </div>
        )}
      </section>
      {history}
    </>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-2 sm:px-3 dark:border-slate-700 dark:bg-slate-800">
        <Link href="/documents" className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700" title="Back to Documents">
          <ArrowLeft size={16} /><span className="hidden md:inline">Documents</span>
        </Link>
        <span className="hidden h-6 w-px shrink-0 bg-slate-200 sm:block dark:bg-slate-700" />
        <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand sm:flex dark:text-teal-300"><FileText size={16} /></span>
        {mode === "edit" ? (
          <input className="h-9 min-w-0 max-w-md flex-1 rounded-lg border border-transparent bg-transparent px-2 text-[15px] font-semibold text-slate-900 hover:border-slate-200 focus:border-brand/60 focus:outline-none focus:ring-2 focus:ring-brand/20 dark:text-slate-50 dark:hover:border-slate-600"
            value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} maxLength={255} aria-label="Title" />
        ) : <h1 className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold">{doc.title}</h1>}
        {doc.isTemplate ? <span className="hidden shrink-0 rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-800 sm:inline dark:bg-teal-500/15 dark:text-teal-300">Template</span>
          : <span className="hidden shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 sm:inline dark:bg-slate-700 dark:text-slate-300">{DOC_STATUS_LABELS[doc.status]}</span>}
        {mode === "edit" && <span className="hidden shrink-0 text-xs text-slate-500 lg:inline">{save.isPending ? "Saving…" : dirty ? "Unsaved" : "Saved"}</span>}
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {mode === "edit" && (
            <div className="hidden items-center sm:flex">
              <button type="button" className={stepBtn} disabled={!hist.current.past.length} onClick={doUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={15} /></button>
              <button type="button" className={stepBtn} disabled={!hist.current.future.length} onClick={doRedo} title="Redo (Ctrl+Y)" aria-label="Redo"><Redo2 size={15} /></button>
            </div>
          )}
          <div className="hidden items-center rounded-lg border border-slate-200 sm:flex dark:border-slate-700">
            <button type="button" className={stepBtn} onClick={() => zoomBy(-0.25)} aria-label="Zoom out" title="Zoom out (Ctrl + mouse wheel)"><Minus size={14} /></button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="flex h-8 min-w-[72px] items-center justify-center gap-1 px-1.5 text-xs font-semibold tabular-nums hover:bg-slate-100 dark:hover:bg-slate-700" aria-label="Zoom">{zoomLabel}<ChevronDown size={12} /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem onClick={() => setFit("width")}><MoveHorizontal size={14} className="mr-2" /> Fit width</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFit("page")}><Maximize2 size={14} className="mr-2" /> Whole page</DropdownMenuItem>
                <DropdownMenuSeparator />
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((z) => <DropdownMenuItem key={z} onClick={() => { setFit(null); setZoom(z); }}>{Math.round(z * 100)}%</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
            <button type="button" className={stepBtn} onClick={() => zoomBy(0.25)} aria-label="Zoom in" title="Zoom in (Ctrl + mouse wheel)"><Plus size={14} /></button>
          </div>
          {mode === "edit" && !doc.isTemplate && (
            <>
              <Btn size="sm" variant="secondary" className="hidden md:inline-flex" disabled={asTemplate.isPending} onClick={() => setTemplateName(title)}><FileStack size={13} /> Save as template</Btn>
              <Btn size="sm" disabled={busy} onClick={() => void doSend()}>
                {send.isPending || whiteoutBusy ? <Loader2 size={13} className="animate-spin" /> : doc.signers.length ? <Send size={13} /> : <CheckCircle2 size={13} />}
                <span className="hidden sm:inline">{doc.signers.length ? "Send for signature" : "Finish & create PDF"}</span><span className="sm:hidden">{doc.signers.length ? "Send" : "Finish"}</span>
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
          {doc.status === "completed" && (
            <Btn size="sm" onClick={() => void download(excuseNote ? "copy" : "final")}><Download size={13} /> <span className="hidden sm:inline">{excuseNote ? "Download the note" : "Download signed PDF"}</span></Btn>
          )}
          <button type="button" className={cn(stepBtn, "lg:hidden")} onClick={() => setPanelOpen(true)} aria-label="Details" title="Details"><PanelRight size={17} /></button>
        </div>
      </header>

      {mode === "edit" && (
        <EditorToolbar tool={tool} onTool={(t) => { setTool(t); if (t) setSelected([]); }} isTemplate={doc.isTemplate} signers={doc.signers} newAssignee={newAssignee} onNewAssignee={setNewAssignee}
          onSuggest={() => void suggest("quick")} onAiRead={doc.aiReady ? () => void suggest("ai") : undefined} suggesting={suggesting} myName={doc.myName ?? ""} />
      )}
      <DocProgress doc={doc} />

      <div className="flex min-h-0 flex-1">
        {/* Page thumbnails */}
        {pdf && pageCount > 0 && (
          <aside className="hidden w-[132px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white md:block dark:border-slate-700 dark:bg-slate-800">
            <Thumbnails pdf={pdf} count={pageCount} current={current} onJump={jumpTo}
              onMove={mode === "edit" && !showFinal ? (from, to) => void pageChange({ op: "move", page: from, to }) : undefined} busy={pageBusy} />
          </aside>
        )}

        {/* The pages */}
        <div ref={scroller} data-scroll onScroll={onScroll} className="relative min-w-0 flex-1 overflow-auto">
          <div className="px-2 py-4 sm:px-6">
            {!doc.hasFile && <ErrorNote message="This document has no PDF yet." />}
            {pdfErr && <ErrorNote message={`The PDF couldn't be shown: ${pdfErr}`} />}
            {doc.hasFile && !pdf && !pdfErr && <Loading label="Opening the PDF…" />}
            {pdf && (
              <Pages pdf={pdf} count={pageCount} zoom={zoom} fit={fit} aspect={aspect} className="overflow-x-auto pb-16" drawing={mode === "edit" && !!tool}
                onPageClick={() => setSelected([])} onDraw={place} onHover={(p) => { hoverPage.current = p; }}
                pageBar={mode !== "edit" || showFinal ? undefined : (i) => (
                  <>
                    <span className="font-semibold text-slate-500">Page {i + 1} of {pages.length}{pageBusy ? " · updating…" : ""}</span>
                    <span className="flex items-center gap-0.5">
                      <button type="button" className={pageBtn} disabled={pageBusy || i === 0} title="Move this page up" aria-label={`Move page ${i + 1} up`} onClick={() => void pageChange({ op: "move", page: i, to: i - 1 })}><ArrowUp size={14} /></button>
                      <button type="button" className={pageBtn} disabled={pageBusy || i >= pages.length - 1} title="Move this page down" aria-label={`Move page ${i + 1} down`} onClick={() => void pageChange({ op: "move", page: i, to: i + 1 })}><ArrowDown size={14} /></button>
                      <button type="button" className={pageBtn} disabled={pageBusy} title="Turn this page a quarter turn" aria-label={`Turn page ${i + 1}`} onClick={() => void pageChange({ op: "turn", page: i, turn: 90 })}><RotateCw size={14} /></button>
                      <button type="button" className={cn(pageBtn, "hover:text-red-600")} disabled={pageBusy || pages.length <= 1} title="Remove this page" aria-label={`Remove page ${i + 1}`}
                        onClick={() => void pageChange({ op: "remove", page: i }, `Page ${i + 1} and any boxes on it will be taken out of the document. This can't be undone.`)}><Trash2 size={14} /></button>
                    </span>
                  </>
                )}
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
          </div>
          {/* Signing: a bar that stays in view and walks through the boxes that are left. */}
          {mode === "sign" && pdf && (
            <div className="sticky bottom-3 z-20 flex justify-center px-2">
              <div className="flex w-full max-w-md items-center justify-between gap-3 rounded-2xl border border-violet-300 bg-white/95 p-2 ps-4 shadow-lg backdrop-blur dark:border-violet-800 dark:bg-slate-900/95">
                <p className="text-sm font-semibold">{todo.length ? `${todo.length} box${todo.length === 1 ? "" : "es"} left for you` : "All your boxes are done"}</p>
                {todo[0]
                  ? <Btn onClick={() => goTo(todo[0]!)}>Next box <ArrowRight size={14} /></Btn>
                  : <Btn disabled={busy} onClick={doFinishSigning}>{finishSigning.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Finish signing</Btn>}
              </div>
            </div>
          )}
          {/* Phones and tablets: a picked box's settings are one tap away. */}
          {mode === "edit" && selected.length > 0 && !panelOpen && (
            <div className="sticky bottom-3 z-20 flex justify-end px-3 lg:hidden">
              <Btn onClick={() => setPanelOpen(true)}><PanelRight size={14} /> {selected.length > 1 ? `${selected.length} picked` : "Box settings"}</Btn>
            </div>
          )}
        </div>

        {/* The side panel */}
        <aside className="hidden w-[320px] shrink-0 overflow-y-auto border-l border-slate-200 bg-slate-50 p-3 lg:block dark:border-slate-700 dark:bg-slate-900/60">
          <div className="space-y-3 text-sm">{side}</div>
        </aside>
      </div>

      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent side="right" className="w-[340px] max-w-[92vw] overflow-y-auto bg-slate-50 p-3 sm:max-w-[360px] dark:bg-slate-900">
          <SheetHeader className="p-0 pb-2"><SheetTitle className="text-sm">{mode === "edit" && sel ? "Box settings" : mode === "edit" && selected.length > 1 ? "Picked boxes" : "Details"}</SheetTitle></SheetHeader>
          <div className="space-y-3 text-sm">{side}</div>
        </SheetContent>
      </Sheet>

      {/* A question before something that can't be undone. */}
      <Dialog open={!!ask} onOpenChange={(o) => !o && setAsk(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{ask?.title}</DialogTitle>
            <DialogDescription>{ask?.text}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setAsk(null)}>Keep it</Btn>
            <Btn variant={ask?.danger ? "danger" : "primary"} onClick={() => { const run = ask?.run; setAsk(null); run?.(); }}>{ask?.yes}</Btn>
          </div>
        </DialogContent>
      </Dialog>

      {/* Save as template: name it. */}
      <Dialog open={templateName != null} onOpenChange={(o) => !o && setTemplateName(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save as a template</DialogTitle>
            <DialogDescription>The pages and boxes are kept; what was typed in them is not, so no patient's details carry over.</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const t = (templateName ?? "").trim(); if (!t) return; setTemplateName(null); void saveTemplate(t); }}>
            <input className={inputCls} autoFocus value={templateName ?? ""} maxLength={255} onChange={(e) => setTemplateName(e.target.value)} aria-label="Template name" />
            <div className="flex justify-end gap-2">
              <Btn type="button" variant="ghost" onClick={() => setTemplateName(null)}>Cancel</Btn>
              <Btn type="submit" disabled={!(templateName ?? "").trim()}><FileStack size={13} /> Save template</Btn>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* White-out for real: say what will happen before the pages are replaced. */}
      <Dialog open={!!whiteoutAsk} onOpenChange={(o) => !o && setWhiteoutAsk(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove what's under the white-out?</DialogTitle>
            <DialogDescription>
              Right now the white-out only covers the words: they are still inside the PDF and could be copied out. MyPCP will remove them for good
              on page {(whiteoutAsk ?? []).map((p) => p + 1).join(", ")}. {(whiteoutAsk ?? []).length === 1 ? "That page is" : "Those pages are"} then saved
              as a picture of the page: it looks and prints the same, but its words can't be searched or copied anymore. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setWhiteoutAsk(null)}>Not now</Btn>
            <Btn onClick={() => { setWhiteoutAsk(null); void doSend(true); }}>Remove it and {doc.signers.length ? "send" : "finish"}</Btn>
          </div>
        </DialogContent>
      </Dialog>
      {whiteoutBusy && (
        <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          <p className="flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-lg"><Loader2 size={15} className="animate-spin" /> {whiteoutBusy}</p>
        </div>
      )}
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
