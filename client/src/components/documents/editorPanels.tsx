// The Documents editor's side panels: the tools, the picked box's settings, lining boxes up, signers, patient.
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, CalendarDays, Check, CheckCircle2, Circle, Copy, CopyPlus, Eraser, FilePlus2, Highlighter, Image as ImageIcon,
  Loader2, Minus, MoveHorizontal, MoveVertical, Signature, SquareCheck, Stamp, TextCursorInput, Trash2, Type, UserRound, Wand2, X, XCircle,
} from "lucide-react";
import { DOC_FILE_ACCEPT } from "./uploadFiles";
import { Btn, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  DOC_STATUS_LABELS, FIELD_LABELS, INK_COLORS, INK_HEX, MARK_LABELS, MARK_STYLES, PREFILL_KEYS, PREFILL_LABELS, STAMP_MAX, STAMP_PRESETS, inkOf, isMarkup, signerOf, usDate,
  type Assignee, type DocField, type InkColor, type PrefillKey,
} from "@shared/documents";
import type { AlignHow } from "@shared/docEdit";
import type { BoxColor, Doc, ToolChoice } from "./editorShared";

const FILL_TOOLS: (ToolChoice & { label: string; icon: React.ElementType })[] = [
  { type: "text", label: "Text", icon: Type }, { type: "date", label: "Date", icon: CalendarDays }, { type: "checkbox", label: "Checkbox", icon: SquareCheck },
  { type: "signature", label: "Signature", icon: Signature }, { type: "initials", label: "Initials", icon: TextCursorInput },
];
const MARK_TOOLS: (ToolChoice & { label: string; icon: React.ElementType })[] = [
  { type: "whiteout", label: "White-out", icon: Eraser }, { type: "highlight", label: "Highlight", icon: Highlighter }, { type: "mark", value: "check", label: "Check", icon: Check },
  { type: "mark", value: "x", label: "X", icon: X }, { type: "mark", value: "circle", label: "Circle", icon: Circle }, { type: "line", label: "Line", icon: Minus },
  { type: "stamp", label: "Stamp", icon: Stamp }, { type: "logo", label: "Logo", icon: ImageIcon },
];
const sameTool = (a: ToolChoice | null, b: ToolChoice) => !!a && a.type === b.type && (a.value ?? "") === (b.value ?? "");
const panel = "rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800";
const heading = "mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500";

/** "Add a box" and "Mark up the page": pick one, then click (or drag) on the page. */
export function ToolPalette({ tool, onTool, isTemplate, signers, newAssignee, onNewAssignee, onSuggest, suggesting }: {
  tool: ToolChoice | null; onTool: (t: ToolChoice | null) => void; isTemplate: boolean; signers: Doc["signers"]; newAssignee: Assignee; onNewAssignee: (a: Assignee) => void;
  /** Read the words on the pages and add boxes on the blanks it finds. */
  onSuggest: () => void; suggesting: boolean;
}) {
  const grid = (tools: typeof FILL_TOOLS, cols: string) => (
    <div className={cn("grid gap-1.5", cols)}>
      {tools.map((t) => (
        <button key={`${t.type}:${t.value ?? ""}`} type="button" aria-pressed={sameTool(tool, t)} onClick={() => onTool(sameTool(tool, t) ? null : { type: t.type, value: t.value })}
          className={cn("flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11px] font-semibold", sameTool(tool, t) ? "border-brand bg-brand/10 text-slate-900 dark:text-slate-50" : "border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300")}>
          <t.icon size={16} /> {t.label}
        </button>
      ))}
    </div>
  );
  return (
    <section className={panel}>
      <p className={heading}>Add a box</p>
      {grid(FILL_TOOLS, "grid-cols-3")}
      <Btn size="sm" variant="secondary" className="mt-2 w-full" disabled={suggesting} onClick={onSuggest}
        title="MyPCP reads the words on the pages (Name: ____, Signature: ____, Date: ____, [ ]) and adds a box on each blank. You check them.">
        {suggesting ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} Suggest boxes for me
      </Btn>
      {!isTemplate && (
        <label className="mt-2 block text-xs text-slate-500">New boxes are for
          <select className={cn(inputCls, "mt-1 h-8 text-xs")} value={newAssignee} onChange={(e) => onNewAssignee(e.target.value as Assignee)}>
            <option value="preparer">Me (I fill it now)</option>
            {signers.map((s) => <option key={s.userId} value={`signer:${s.userId}`}>{s.name ?? "Signer"} (signs later)</option>)}
          </select>
        </label>
      )}
      <p className={cn(heading, "mt-3")}>Mark up the page</p>
      {grid(MARK_TOOLS, "grid-cols-4")}
      <p className={cn("mt-2 text-xs", tool ? "text-brand" : "text-slate-400")}>
        {tool ? `Click on the page where it goes, or drag to set its size. (Esc to stop)` : "Pick one, then click on the page. Drag to set the size."}
      </p>
    </section>
  );
}

/** Settings for the one box (or mark) that is picked. */
export function FieldPanel({ f, doc, onChange, onDelete, onCopy, onEveryPage, isTemplate, pageCount }: {
  f: DocField; doc: Doc; onChange: (p: Partial<DocField>) => void; onDelete: () => void; onCopy: () => void; onEveryPage: () => void; isTemplate: boolean; pageCount: number;
}) {
  const markup = isMarkup(f.type);
  const ink = inkOf(f.color, f.type === "stamp" ? "red" : "black");
  return (
    <section className={cn(panel, "space-y-2 border-brand/40")}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{FIELD_LABELS[f.type]}{markup ? "" : " box"} · page {f.page + 1}</p>
        <button type="button" onClick={onDelete} className="text-red-600" title="Delete (Delete key)"><Trash2 size={14} /></button>
      </div>
      {!markup && !isTemplate && (
        <label className="block text-xs text-slate-500">Who fills this box
          <select className={cn(inputCls, "mt-1 h-8 text-xs")} value={f.assignee} onChange={(e) => onChange({ assignee: e.target.value as Assignee, value: e.target.value === "preparer" ? f.value : null })}>
            <option value="preparer">Me</option>
            {doc.signers.map((s) => <option key={s.userId} value={`signer:${s.userId}`}>{s.name ?? "Signer"}</option>)}
          </select>
        </label>
      )}
      {!markup && (
        <label className="block text-xs text-slate-500">Label (shown to whoever fills it)
          <input className={cn(inputCls, "mt-1 h-8 text-xs")} value={f.label ?? ""} maxLength={120} onChange={(e) => onChange({ label: e.target.value })} />
        </label>
      )}
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
      {f.type === "mark" && (
        <div className="flex gap-1.5" role="group" aria-label="Kind of mark">
          {MARK_STYLES.map((m) => (
            <button key={m} type="button" aria-pressed={f.value === m} onClick={() => onChange({ value: m })}
              className={cn("flex-1 rounded-lg border px-1 py-1.5 text-xs font-semibold", f.value === m ? "border-brand bg-brand/10" : "border-slate-200 dark:border-slate-700")}>{MARK_LABELS[m]}</button>
          ))}
        </div>
      )}
      {f.type === "stamp" && (
        <>
          <label className="block text-xs text-slate-500">Stamp wording
            <input className={cn(inputCls, "mt-1 h-8 text-xs uppercase")} value={f.value ?? ""} maxLength={STAMP_MAX} onChange={(e) => onChange({ value: e.target.value })} />
          </label>
          <div className="flex flex-wrap gap-1">
            {STAMP_PRESETS.map((s) => <button key={s} type="button" onClick={() => onChange({ value: s })} className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300">{s}</button>)}
            <button type="button" onClick={() => onChange({ value: `${(f.value ?? "").replace(/\s*\d{2}\/\d{2}\/\d{4}$/, "")} ${usDate(new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }))}`.trim().slice(0, STAMP_MAX) })}
              className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300">+ today's date</button>
          </div>
        </>
      )}
      {(f.type === "mark" || f.type === "line" || f.type === "stamp") && (
        <div className="flex items-center gap-2 text-xs text-slate-500">Color
          {INK_COLORS.map((c: InkColor) => (
            <button key={c} type="button" title={c} aria-label={c} aria-pressed={ink === c} onClick={() => onChange({ color: c })}
              className={cn("size-6 rounded-full border-2", ink === c ? "border-brand ring-2 ring-brand/30" : "border-white shadow")} style={{ background: INK_HEX[c] }} />
          ))}
        </div>
      )}
      {f.type === "whiteout" && <p className="text-[11px] text-slate-500">Covers what is under it with white. Add a Text box on top to write something new there.</p>}
      {!markup && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" className="size-4 accent-teal-700" checked={!!f.required} onChange={(e) => onChange({ required: e.target.checked })} /> Required
        </label>
      )}
      <div className="flex flex-wrap gap-1.5 pt-1">
        <Btn size="sm" variant="secondary" onClick={onCopy} title="Ctrl+D"><Copy size={13} /> Copy</Btn>
        {pageCount > 1 && <Btn size="sm" variant="secondary" onClick={onEveryPage} title="The same box in the same place on every page"><CopyPlus size={13} /> On every page</Btn>}
      </div>
      <p className="text-[11px] text-slate-400">Drag to move · corner dot to resize · arrow keys to nudge · Shift+click to pick several.</p>
    </section>
  );
}

/** Several boxes picked: line them up with the first one picked, make them the same size, copy or delete them. */
export function MultiPanel({ count, onAlign, onCopy, onDelete, signers, onAssign }: {
  count: number; onAlign: (how: AlignHow) => void; onCopy: () => void; onDelete: () => void;
  /** Give all the picked fill-in boxes to one person (not offered on templates). */
  signers?: Doc["signers"]; onAssign?: (a: Assignee) => void;
}) {
  const b = (how: AlignHow, label: string, Icon: React.ElementType) => (
    <button type="button" onClick={() => onAlign(how)} className="flex flex-col items-center gap-1 rounded-lg border border-slate-200 px-1 py-2 text-[11px] font-semibold text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300">
      <Icon size={16} /> {label}
    </button>
  );
  return (
    <section className={cn(panel, "space-y-2 border-brand/40")}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{count} picked</p>
        <button type="button" onClick={onDelete} className="text-red-600" title="Delete them (Delete key)"><Trash2 size={14} /></button>
      </div>
      <p className="text-[11px] text-slate-500">Line them up with the first one you picked:</p>
      <div className="grid grid-cols-4 gap-1.5">
        {b("left", "Left", AlignStartVertical)}{b("right", "Right", AlignEndVertical)}{b("top", "Top", AlignStartHorizontal)}{b("bottom", "Bottom", AlignEndHorizontal)}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {b("width", "Same width", MoveHorizontal)}{b("height", "Same height", MoveVertical)}
      </div>
      {onAssign && (
        <label className="block text-xs text-slate-500">Who fills these boxes
          <select className={cn(inputCls, "mt-1 h-8 text-xs")} value="" onChange={(e) => e.target.value && onAssign(e.target.value as Assignee)}>
            <option value="">Choose…</option>
            <option value="preparer">Me</option>
            {(signers ?? []).map((s) => <option key={s.userId} value={`signer:${s.userId}`}>{s.name ?? "Signer"}</option>)}
          </select>
        </label>
      )}
      <Btn size="sm" variant="secondary" onClick={onCopy} title="Ctrl+D"><Copy size={13} /> Copy them</Btn>
      <p className="text-[11px] text-slate-400">Drag any of them to move them together · arrow keys to nudge.</p>
    </section>
  );
}

/** Pages: add more (another PDF, photos or scans). Moving, turning and removing a page are on the strip above each page. */
export function PagesPanel({ count, busy, onAdd }: { count: number; busy: boolean; onAdd: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section className={panel}>
      <p className={heading}>Pages ({count})</p>
      <Btn size="sm" variant="secondary" className="w-full" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <FilePlus2 size={13} />} Add pages (PDF or photos)
      </Btn>
      <input ref={input} type="file" multiple accept={DOC_FILE_ACCEPT} className="hidden"
        onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) onAdd(files); }} />
      <p className="mt-2 text-[11px] text-slate-500">They go at the end. Use the arrows above each page to move it, or turn or remove it there.</p>
    </section>
  );
}

export function SignersPanel({ doc, fields, colorOf, onChanged }: { doc: Doc; fields: DocField[]; colorOf: (a: Assignee) => BoxColor; onChanged: (ids: number[]) => void }) {
  const choices = trpc.workspace.documents.signers.useQuery();
  const setSigners = trpc.workspace.documents.setSigners.useMutation({ onError: (e) => toast.error(e.message) });
  const ids = doc.signers.map((s) => s.userId);
  const change = async (next: number[]) => { await setSigners.mutateAsync({ id: doc.id, userIds: next }); onChanged(next); };
  const available = (choices.data ?? []).filter((u) => !ids.includes(u.id));
  return (
    <section className={panel}>
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

export function PatientPanel({ doc, onLinked, onPrefilled, flush }: { doc: Doc; onLinked: () => void; onPrefilled: (fields: DocField[]) => void; flush: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const search = trpc.workspace.documents.searchPatients.useQuery({ q: q.trim() }, { enabled: q.trim().length >= 2 });
  const save = trpc.workspace.documents.save.useMutation({ onError: (e) => toast.error(e.message) });
  const prefill = trpc.workspace.documents.prefill.useMutation({ onError: (e) => toast.error(e.message) });
  const hasPrefill = doc.fields.some((f) => f.prefill);
  const link = async (key: string | null) => { await flush(); await save.mutateAsync({ id: doc.id, subjectKey: key }); setQ(""); onLinked(); };
  return (
    <section className={panel}>
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

export function ViewSummary({ doc }: { doc: Doc }) {
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
