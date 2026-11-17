// Pieces of the care-plan screen: goal progress (latest result + the last few calls), the list editor,
// "what changed since the provider signed", and the Copy / PDF / Print menus.
import { useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ChevronDown, Copy, Download, FileText, FolderInput, Loader2, Minus, Plus, Printer, X } from "lucide-react";
import { Btn, fmtShortDate } from "@/components/workspace/ui";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { downloadPdf } from "@/lib/pdfDownload";
import { GOAL_STATUS_LABELS, NOT_YET_FLAG, type GoalPoint, type GoalProgress, type GoalStatus, type PlanChanges } from "@shared/carePlanProgress";

export const GOAL_TONE: Record<GoalStatus, { chip: string; dot: string }> = {
  on_track: { chip: "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-500/30", dot: "bg-emerald-500" },
  not_yet: { chip: "bg-amber-50 text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/30", dot: "bg-amber-500" },
  met: { chip: "bg-teal-50 text-teal-800 ring-1 ring-teal-200 dark:bg-teal-500/10 dark:text-teal-200 dark:ring-teal-500/30", dot: "bg-teal-600" },
};

export function GoalChip({ status, className }: { status: GoalStatus; className?: string }) {
  return <span className={cn("inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold", GOAL_TONE[status].chip, className)}>{GOAL_STATUS_LABELS[status]}</span>;
}

/** The last few calls for one goal, oldest on the left. */
export function HistoryDots({ history }: { history: GoalPoint[] }) {
  const pts = [...history].reverse();
  return (
    <span className="inline-flex items-center gap-1" aria-label={`Last ${pts.length} check${pts.length === 1 ? "" : "s"}`}>
      {pts.map((p, i) => (
        <span key={i} title={`${fmtShortDate(p.at)}: ${GOAL_STATUS_LABELS[p.status]}${p.value ? ` · ${p.value}` : ""}`}
          className={cn("size-2.5 rounded-full", GOAL_TONE[p.status].dot, i === pts.length - 1 && "ring-2 ring-offset-1 ring-slate-300 dark:ring-slate-600 dark:ring-offset-slate-900")} />
      ))}
    </span>
  );
}

/** One goal on the plan: the goal, how it went on the latest call, and the calls before. */
export function GoalLine({ goal, progress }: { goal: string; progress?: GoalProgress }) {
  const l = progress?.latest;
  return (
    <li className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-4 sm:gap-y-1.5">
      <p className="min-w-0 flex-1 text-sm text-slate-800 dark:text-slate-100">{goal}</p>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:w-64 sm:justify-end">
        {l ? (
          <>
            {progress!.history.length > 1 && <HistoryDots history={progress!.history} />}
            <GoalChip status={l.status} />
            <span className="text-xs text-slate-500">{l.value ? <b className="font-semibold text-slate-700 dark:text-slate-200">{l.value}</b> : null}{l.value ? " · " : ""}{fmtShortDate(l.at)}</span>
          </>
        ) : null}
      </div>
      {progress?.flag && (
        <p className="w-full basis-full rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          "Not yet" on the last {progress.notYetStreak} calls ({NOT_YET_FLAG} or more): bring this goal to the provider to review.
        </p>
      )}
    </li>
  );
}

/** A list edited item by item: Enter adds the next item, Backspace on an empty item removes it. */
export function ListEditor({ label, value, onChange, placeholder }: { label: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
  // Every item as tall as its words (long goals wrap onto several lines).
  useLayoutEffect(() => { for (const el of refs.current) if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }, [value]);
  const focus = (i: number) => setTimeout(() => { const el = refs.current[i]; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 0);
  const set = (i: number, v: string) => onChange(value.map((x, j) => (j === i ? v : x)));
  const insert = (i: number) => { onChange([...value.slice(0, i + 1), "", ...value.slice(i + 1)]); focus(i + 1); };
  const remove = (i: number) => { onChange(value.filter((_, j) => j !== i)); focus(Math.max(0, i - 1)); };
  const move = (i: number, by: -1 | 1) => { const j = i + by; if (j < 0 || j >= value.length) return; const next = [...value]; [next[i], next[j]] = [next[j]!, next[i]!]; onChange(next); focus(j); };
  return (
    <div>
      <p className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{label}</p>
      <ul className="space-y-1.5">
        {value.map((x, i) => (
          <li key={i} className="group flex items-start gap-1.5">
            <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-teal-600" />
            <textarea ref={(el) => { refs.current[i] = el; }} value={x} rows={1} placeholder={placeholder}
              onChange={(e) => set(i, e.target.value.replace(/\n/g, " "))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); insert(i); }
                else if (e.key === "Backspace" && !x && value.length > 0) { e.preventDefault(); remove(i); }
              }}
              className="min-h-[2.25rem] w-full resize-none overflow-hidden rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm leading-relaxed text-slate-800 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100" />
            <div className="flex shrink-0 opacity-40 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              <button type="button" title="Move up" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ArrowUp size={13} /></button>
              <button type="button" title="Move down" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === value.length - 1} className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ArrowDown size={13} /></button>
              <button type="button" title="Remove" aria-label="Remove" onClick={() => remove(i)} className="rounded p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"><X size={13} /></button>
            </div>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => insert(value.length - 1)} className="mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50 dark:text-teal-300 dark:hover:bg-teal-500/10">
        <Plus size={13} /> Add
      </button>
    </div>
  );
}

/** What changed since the provider last signed: added and removed lines, section by section. */
export function ChangesPanel({ changes, signedByName, signedAt, version }: { changes: PlanChanges; signedByName: string | null; signedAt: Date | string | null; version: number }) {
  const [open, setOpen] = useState(true);
  const n = changes.sections.length + changes.general.length;
  if (!n) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/5">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <span className="flex-1 text-sm font-semibold text-amber-900 dark:text-amber-100">
          What changed since {signedByName ?? "the provider"} signed version {version}{signedAt ? ` on ${fmtShortDate(signedAt)}` : ""} ({n} {n === 1 ? "part" : "parts"})
        </span>
        <ChevronDown size={16} className={cn("text-amber-700 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-amber-200 px-4 py-3 text-sm dark:border-amber-500/30">
          {changes.sections.map((s, i) => (
            <div key={i}>
              <p className="font-semibold text-slate-900 dark:text-slate-50">
                {s.kind === "added" ? <span className="text-emerald-700 dark:text-emerald-300">Added: </span> : s.kind === "removed" ? <span className="text-rose-700 dark:text-rose-300">Removed: </span> : null}{s.title}
              </p>
              {s.fields.map((f, j) => (
                <div key={j} className="mt-1 ps-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{f.label}</p>
                  {f.added.map((x, k) => <p key={`a${k}`} className="flex gap-1.5 text-emerald-800 dark:text-emerald-200"><Plus size={13} className="mt-0.5 shrink-0" />{x}</p>)}
                  {f.removed.map((x, k) => <p key={`r${k}`} className="flex gap-1.5 text-rose-700 line-through decoration-rose-300 dark:text-rose-300"><Minus size={13} className="mt-0.5 shrink-0" />{x}</p>)}
                </div>
              ))}
            </div>
          ))}
          {changes.general.map((g, i) => (
            <div key={`g${i}`}>
              <p className="font-semibold text-slate-900 dark:text-slate-50">{g.label}</p>
              {g.after && <p className="flex gap-1.5 ps-3 text-emerald-800 dark:text-emerald-200"><Plus size={13} className="mt-0.5 shrink-0" /><span className="whitespace-pre-line">{g.after}</span></p>}
              {g.before && <p className="flex gap-1.5 ps-3 text-rose-700 line-through decoration-rose-300 dark:text-rose-300"><Minus size={13} className="mt-0.5 shrink-0" /><span className="whitespace-pre-line">{g.before}</span></p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export async function copyText(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast.success(`${what} copied. Paste it where you need it (for example a Practice Fusion note).`); }
  catch { toast.error("Your browser didn't allow copying. Try again, or use Download PDF."); }
}

/** Copy, PDF (download or file in the folder) and Print, for one patient's plan. */
export function PlanActions({ patientId, language, onCopyPlan, onCopyGoals }: { patientId: number; language: "en" | "es"; onCopyPlan: () => void; onCopyGoals: () => void }) {
  const pdf = trpc.workspace.carePlans.pdf.useMutation();
  const save = trpc.workspace.carePlans.saveToFolder.useMutation();
  const utils = trpc.useUtils();
  const busy = pdf.isPending || save.isPending;
  const download = async (kind: "full" | "patient", lang?: "en" | "es") => {
    try { const r = await pdf.mutateAsync({ patientId, kind, lang }); downloadPdf({ url: null, base64: r.base64 }, r.fileName); }
    catch (e) { toast.error((e as Error).message); }
  };
  const file = async (kind: "full" | "patient") => {
    try {
      const r = await save.mutateAsync({ patientId, kind, lang: kind === "patient" ? language : undefined });
      toast.success(`Saved in the patient's folder (Files): ${r.title}.`);
      void utils.workspace.folder.invalidate();
    } catch (e) { toast.error((e as Error).message); }
  };
  const langName = language === "es" ? "Spanish" : "English";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Btn variant="secondary" size="sm"><Copy size={14} /> Copy <ChevronDown size={13} /></Btn></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onSelect={onCopyPlan}><FileText size={14} /> The whole plan (text)</DropdownMenuItem>
          <DropdownMenuItem onSelect={onCopyGoals}><Copy size={14} /> Just the goals</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Btn variant="secondary" size="sm" disabled={busy}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} PDF <ChevronDown size={13} /></Btn></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="text-xs text-slate-500">Download</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => void download("full")}><Download size={14} /> Full plan (for the chart)</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void download("patient", "en")}><Download size={14} /> Patient copy · English</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void download("patient", "es")}><Download size={14} /> Patient copy · Spanish</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-slate-500">Save in the patient's folder</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => void file("full")}><FolderInput size={14} /> Full plan</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void file("patient")}><FolderInput size={14} /> Patient copy ({langName})</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Btn variant="secondary" size="sm"><Printer size={14} /> Print <ChevronDown size={13} /></Btn></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem asChild><a href={`/care-plans/${patientId}/print`} target="_blank" rel="noreferrer"><Printer size={14} /> Patient copy</a></DropdownMenuItem>
          <DropdownMenuItem asChild><a href={`/care-plans/${patientId}/print?full=1`} target="_blank" rel="noreferrer"><Printer size={14} /> Full plan</a></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
