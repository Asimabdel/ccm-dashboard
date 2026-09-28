import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Database, FileText, Loader2, Lock, Search } from "lucide-react";
import { EmptyState, ErrorNote, Loading, Panel, inputCls } from "@/components/workspace/ui";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDay } from "@shared/workforce";

type Chart = RouterOutputs["workspace"]["chart"]["get"];
type Section = Chart["sections"][number];
type Item = Section["items"][number];

const dateText = (s: string | null) => (s ? fmtDay(s, { month: "short", day: "numeric", year: "numeric" }) : "");
const INACTIVE = /^(resolved|inactive|remission|entered-in-error|stopped|completed|cancelled|ended)$/i;
/** Sections shown as a sortable table (many rows), the rest as lists. */
const TABLE_SECTIONS = new Set(["labs", "vitals", "otherObs"]);
const STATUS_CLS = (s: string | null) => (!s ? "" : INACTIVE.test(s) ? "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" : "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300");

/**
 * The patient's chart as copied from Practice Fusion (read-only). Clinical roles see every
 * section; the front desk sees contact, insurance, visits and allergies.
 */
export function PatientChartPanel({ subjectKey }: { subjectKey: string }) {
  const q = trpc.workspace.chart.get.useQuery(subjectKey, { retry: false });
  const [detail, setDetail] = useState<number | null>(null);
  const [note, setNote] = useState<RouterOutputs["workspace"]["chart"]["note"] & { url?: string } | null>(null);
  const openNote = trpc.workspace.chart.note.useMutation({
    onSuccess: (r) => setNote(r.base64 ? { ...r, url: URL.createObjectURL(new Blob([Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0))], { type: r.contentType })) } : r),
    onError: (e) => toast.error(e.message),
  });

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote message={q.error.message} />;
  const c = q.data!;
  if (!c.sections.length && !c.contact) {
    return <Panel><EmptyState icon={Database} title="Nothing from Practice Fusion yet" body="Once the Practice Fusion connection is set up (Admin → Integrations), this patient's chart is copied here every night: problems, medications, allergies, labs, vitals, visits, notes and more." /></Panel>;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <Database size={13} /> From Practice Fusion · read-only{c.lastSynced ? ` · updated ${new Date(c.lastSynced).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}. Practice Fusion is the official record.
        {c.level === "basic" && <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 dark:bg-slate-800"><Lock size={11} /> Front-desk view: contact, insurance, visits and allergies</span>}
      </div>
      {c.contact && (
        <Panel title="Contact & demographics">
          <dl className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-2 text-sm">
            {([["Name", c.contact.name], ["Date of birth", c.contact.dob ? dateText(c.contact.dob) : null], ["Sex", c.contact.sex === "F" ? "Female" : c.contact.sex === "M" ? "Male" : c.contact.sex ? "Other" : null], ["MRN", c.contact.mrn], ["Phone", c.contact.phone], ["Email", c.contact.email], ["Address", c.contact.address]] as const)
              .filter(([, v]) => v).map(([k, v]) => (
                <div key={k} className={k === "Address" ? "sm:col-span-2" : ""}><dt className="text-xs text-slate-500">{k}</dt><dd className="text-slate-900 dark:text-slate-100 break-words">{v}</dd></div>
              ))}
          </dl>
        </Panel>
      )}
      <div className="grid lg:grid-cols-2 gap-4">
        {c.sections.map((s) => (
          <SectionPanel key={s.key} s={s} wide={TABLE_SECTIONS.has(s.key) || s.key === "notes"}
            onOpen={(it) => (s.key === "notes" ? openNote.mutate(it.id) : setDetail(it.id))} busyId={openNote.isPending ? openNote.variables ?? null : null} />
        ))}
      </div>
      {detail && <DetailDialog id={detail} onClose={() => setDetail(null)} />}
      {note && (
        <Dialog open onOpenChange={(o) => { if (!o) { if (note.url) URL.revokeObjectURL(note.url); setNote(null); } }}>
          <DialogContent className="sm:max-w-4xl h-[88vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>{note.title ?? "Document"}</DialogTitle>
              <DialogDescription>{note.date ? dateText(note.date) : ""} · from Practice Fusion (read-only)</DialogDescription>
            </DialogHeader>
            {note.text != null
              ? (/html/i.test(note.contentType)
                ? <iframe title="Note" sandbox="" srcDoc={note.text} className="flex-1 w-full rounded-lg border border-slate-200 bg-white dark:border-slate-700" />
                : <pre className="flex-1 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">{note.text}</pre>)
              : /pdf/i.test(note.contentType) && note.url
                ? <iframe title="Document" src={note.url} className="flex-1 w-full rounded-lg border border-slate-200 dark:border-slate-700" />
                : <p className="text-sm text-slate-600">This file type can't be shown here. {note.url && <a className="underline" href={note.url} download>Download it</a>}</p>}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function SectionPanel({ s, wide, onOpen, busyId }: { s: Section; wide: boolean; onOpen: (it: Item) => void; busyId: number | null }) {
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const sortsByStatus = s.key === "problems" || s.key === "medications" || s.key === "allergies";
  const items = useMemo(() => {
    let list = s.items;
    if (filter.trim()) { const f = filter.trim().toLowerCase(); list = list.filter((i) => `${i.title} ${i.value}`.toLowerCase().includes(f)); }
    if (sortsByStatus && !showInactive) list = list.filter((i) => !INACTIVE.test(i.status ?? ""));
    return list;
  }, [s.items, filter, showInactive, sortsByStatus]);
  const inactiveCount = sortsByStatus ? s.items.filter((i) => INACTIVE.test(i.status ?? "")).length : 0;
  const shown = all ? items : items.slice(0, TABLE_SECTIONS.has(s.key) ? 25 : 12);

  return (
    <Panel className={wide ? "lg:col-span-2" : ""} title={s.label} subtitle={`${s.total}${s.total > s.items.length ? ` (latest ${s.items.length} shown)` : ""}`} bodyClassName="p-0"
      action={TABLE_SECTIONS.has(s.key) || s.items.length > 15 ? (
        <span className="relative"><Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className={cn(inputCls, "h-8 w-44 pl-7 text-xs")} placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} /></span>
      ) : undefined}>
      {TABLE_SECTIONS.has(s.key) ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
              {shown.map((i) => (
                <tr key={i.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60" onClick={() => onOpen(i)}>
                  <td className="px-4 py-2 whitespace-nowrap text-xs text-slate-500 w-28">{dateText(i.date)}</td>
                  <td className="px-2 py-2 text-slate-800 dark:text-slate-100">{i.title ?? "—"}</td>
                  <td className={cn("px-4 py-2 text-right tabular-nums whitespace-nowrap", /\((H|L|HH|LL|A|high|low|abnormal)\)$/i.test(i.value ?? "") ? "font-semibold text-rose-700 dark:text-rose-300" : "text-slate-900 dark:text-slate-50")}>{i.value ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-700">
          {shown.map((i) => (
            <li key={i.id}>
              <button type="button" onClick={() => onOpen(i)} className="w-full text-left flex items-start gap-3 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                {s.key === "notes" && (busyId === i.id ? <Loader2 size={14} className="mt-0.5 animate-spin text-slate-400" /> : <FileText size={14} className="mt-0.5 text-slate-400" />)}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-slate-900 dark:text-slate-50">{i.title ?? "—"}</span>
                  {i.value && <span className="block text-xs text-slate-500 truncate">{i.value}</span>}
                </span>
                <span className="shrink-0 text-right">
                  {i.status && <span className={cn("inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold", STATUS_CLS(i.status))}>{i.status}</span>}
                  {i.date && <span className="block text-[11px] text-slate-400 mt-0.5">{dateText(i.date)}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(items.length > shown.length || inactiveCount > 0) && (
        <div className="flex flex-wrap gap-3 border-t border-slate-100 px-4 py-2 text-xs dark:border-slate-700">
          {items.length > shown.length && <button className="font-semibold text-brand hover:underline" onClick={() => setAll(true)}>Show all {items.length}</button>}
          {inactiveCount > 0 && <button className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-800" onClick={() => setShowInactive(!showInactive)}><ChevronDown size={12} className={cn(showInactive && "rotate-180")} /> {showInactive ? "Hide" : "Show"} {inactiveCount} past/inactive</button>}
        </div>
      )}
      {!shown.length && <p className="px-4 py-3 text-sm text-slate-500">{filter ? "Nothing matches." : "Nothing active."}</p>}
    </Panel>
  );
}

function DetailDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const q = trpc.workspace.chart.item.useQuery(id);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{q.data?.title ?? "Details"}</DialogTitle>
          <DialogDescription>{q.data?.resourceType ?? ""} · the full record from Practice Fusion (read-only)</DialogDescription>
        </DialogHeader>
        {q.isLoading ? <Loader2 size={16} className="animate-spin text-slate-400" /> : q.error ? <ErrorNote message={q.error.message} /> : (
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-900">{JSON.stringify(q.data?.resource, null, 2)}</pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
