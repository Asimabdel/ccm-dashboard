import { useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, CircleDashed, HelpCircle, ShieldCheck, XCircle } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, EmptyState, ErrorNote, Loading, Panel, inputCls } from "@/components/workspace/ui";
import { chartHref } from "@/components/chart/ChartLookup";
import { InsurancePanel } from "./InsurancePanel";
import { cn } from "@/lib/utils";

type Row = RouterOutputs["workspace"]["eligibility"]["schedule"]["rows"][number];
type Kind = "active" | "inactive" | "error" | "unchecked" | "none";

const kindOf = (r: Row): Kind => {
  if (!r.onFile && !r.check) return "none";
  if (!r.check || r.check.status === "pending") return "unchecked";
  if (r.check.status === "error") return "error";
  return r.check.summary?.active === true ? "active" : r.check.summary?.active === false ? "inactive" : "error";
};
const KINDS: { k: Kind; label: string; icon: React.ElementType; cls: string }[] = [
  { k: "inactive", label: "Not active", icon: XCircle, cls: "text-red-600" },
  { k: "error", label: "Couldn't check", icon: AlertTriangle, cls: "text-amber-600" },
  { k: "none", label: "No insurance on file", icon: HelpCircle, cls: "text-slate-500" },
  { k: "unchecked", label: "Not checked yet", icon: CircleDashed, cls: "text-slate-500" },
  { k: "active", label: "Active", icon: CheckCircle2, cls: "text-emerald-600" },
];
const time = (d: Date | string) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

/** The next clinic day's patients and how their insurance checked out (nightly Availity checks). */
export function ScheduleCoverage() {
  const [date, setDate] = useState<string | null>(null);
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [open, setOpen] = useState<Row | null>(null);
  const q = trpc.workspace.eligibility.schedule.useQuery({ date }, { refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote message={q.error.message} />;
  const data = q.data!;
  const rows = data.rows;
  const counts = Object.fromEntries(KINDS.map((x) => [x.k, rows.filter((r) => kindOf(r) === x.k).length])) as Record<Kind, number>;
  const shown = filter === "all" ? rows : rows.filter((r) => kindOf(r) === filter);
  const n = data.lastNightly;
  return (
    <div className="space-y-4">
      {!data.configured ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">Availity isn't connected yet. An admin sets it up under Integrations → Availity.</p>
      ) : !data.nightly ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300">The nightly check is off (Integrations → Availity). You can still check anyone below.</p>
      ) : (
        <p className="text-xs text-slate-500">
          Checked automatically each evening for everyone with insurance on file.{data.mode === "demo" ? " Demo plan: answers are Availity's samples, not real coverage." : ""}
          {n && n.date === data.date ? ` Last run ${new Date(n.lastRunAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })}.` : ""}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" className={cn(inputCls, "w-auto")} value={date ?? data.date} onChange={(e) => setDate(e.target.value || null)} aria-label="Date" />
        <button type="button" onClick={() => setFilter("all")} className={cn("rounded-full border px-3 py-1 text-xs font-semibold", filter === "all" ? "border-brand bg-brand/5" : "border-slate-200 dark:border-slate-700")}>All {rows.length}</button>
        {KINDS.map((x) => (
          <button key={x.k} type="button" onClick={() => setFilter(x.k)} className={cn("flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold", filter === x.k ? "border-brand bg-brand/5" : "border-slate-200 dark:border-slate-700")}>
            <x.icon size={12} className={x.cls} /> {x.label} {counts[x.k]}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <Panel><EmptyState icon={ShieldCheck} title="Nobody booked that day" body="Patients show up here from the imported Practice Fusion schedule." /></Panel>
      ) : (
        <Panel bodyClassName="p-0">
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {shown.map((r) => {
              const k = kindOf(r);
              const K = KINDS.find((x) => x.k === k)!;
              const s = r.check?.summary;
              return (
                <li key={r.appointmentId} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="w-16 shrink-0 tabular-nums text-slate-500">{time(r.startsAt)}</span>
                  <div className="min-w-[12rem] flex-1">
                    {r.patientId ? <Link href={`/patients/${r.patientId}?tab=insurance`} className="font-semibold hover:underline">{r.name}</Link> : <Link href={chartHref(r.subjectKey)} className="font-semibold hover:underline">{r.name}</Link>}
                    <p className="text-xs text-slate-500">{[r.providerName, r.clinicName].filter(Boolean).join(" · ")}{r.onFile ? ` · ${r.onFile.payerName} ${r.onFile.memberId}` : ""}</p>
                  </div>
                  <div className="min-w-[10rem] text-xs">
                    <p className={cn("flex items-center gap-1 font-semibold", K.cls)}><K.icon size={13} /> {k === "error" && r.check?.error ? "Couldn't check" : K.label}</p>
                    {s && r.check?.status === "complete" && <p className="text-slate-500">{[s.officeCopay ? `copay ${s.officeCopay}` : null, s.pcp ? `PCP ${s.pcp}` : null].filter(Boolean).join(" · ")}</p>}
                    {r.check?.status === "error" && r.check.error && <p className="text-slate-500">{r.check.error}</p>}
                  </div>
                  <Btn size="sm" variant={k === "none" ? "primary" : "secondary"} onClick={() => setOpen(r)}>{k === "none" ? "Add insurance" : "Open"}</Btn>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
      <Dialog open={!!open} onOpenChange={(o) => { if (!o) { setOpen(null); void q.refetch(); } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{open?.name}</DialogTitle>
            <DialogDescription>{open ? `${time(open.startsAt)} · ${[open.providerName, open.clinicName].filter(Boolean).join(" · ")}` : ""}</DialogDescription>
          </DialogHeader>
          {open && <InsurancePanel subjectKey={open.subjectKey} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
