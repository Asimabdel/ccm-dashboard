import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Banknote, CalendarDays, ChevronLeft, ChevronRight, Search, Users } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, Panel, inputCls } from "@/components/workspace/ui";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { chartHref } from "@/components/chart/ChartLookup";
import { CollectChip, ESTIMATE_NOTE } from "@/components/billing/CollectChip";
import { cn } from "@/lib/utils";
import { addDays, localDateStr } from "@shared/workforce";
import { shortDay, usd } from "@shared/visitCost";

type DayRow = RouterOutputs["workspace"]["visitCost"]["schedule"]["rows"][number];
type ListRow = RouterOutputs["workspace"]["visitCost"]["list"]["rows"][number];
type Row = Pick<DayRow, "note" | "payer" | "copay" | "nothingOwed" | "deductible" | "coinsurancePct" | "coinsuranceCents" | "lastVisit" | "visits">;
type Kind = "all" | "copay" | "deductible" | "coinsurance" | "nothing" | "info" | "none";

const KIND_LABELS: Record<Kind, string> = { all: "Everyone", copay: "Copay", deductible: "Deductible", coinsurance: "Coinsurance", nothing: "Nothing to pay", info: "Other", none: "No estimate" };
const time = (d: Date | string) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
const longDay = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
const visitsWord = (n: number) => `${n} visit${n === 1 ? "" : "s"}`;
const patientHref = (r: { patientId: number | null; subjectKey: string }) => (r.patientId ? `/patients/${r.patientId}?tab=insurance` : chartHref(r.subjectKey));

/**
 * Copays & deductibles (2026-11-17): what each patient will likely owe at check-in, read from what
 * insurance said on their past visits (the payment files in Master Billing). A day's schedule for the
 * front desk, and everyone with paid visits for people who work across every office.
 */
export default function CopaysPage() {
  useAuth({ redirectOnUnauthenticated: true });
  const { visitCost, loading, limitedToClinics } = useWorkspace();
  const [params, setParams] = useUrlParams();
  const view = params.get("view") === "all" && !limitedToClinics ? "all" : "day";
  return (
    <CCMDashboardLayout title="Copays & deductibles" pageTitle={false}>
      <PageHeader title="Copays & deductibles" subtitle="What each patient will likely owe at check-in, from what insurance said on their past visits." />
      {loading ? <Loading /> : !visitCost ? (
        <Panel><EmptyState icon={Banknote} title="Not switched on for your role yet" body="An admin is checking these estimates first. They will show here once they are opened to the team." /></Panel>
      ) : (
        <>
          {!limitedToClinics && (
            <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-700" role="tablist">
              {([{ k: "day", label: "Schedule", icon: CalendarDays }, { k: "all", label: "All patients", icon: Users }] as const).map((t) => (
                <button key={t.k} role="tab" aria-selected={view === t.k} onClick={() => setParams({ view: t.k === "day" ? null : t.k })}
                  className={cn("-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium", view === t.k ? "border-brand text-slate-900 dark:text-slate-50" : "border-transparent text-slate-500 hover:text-slate-800")}>
                  <t.icon size={15} /> {t.label}
                </button>
              ))}
            </div>
          )}
          {view === "all" ? <AllPatients /> : <DaySchedule />}
        </>
      )}
    </CCMDashboardLayout>
  );
}

function Footer({ through }: { through: string | null | undefined }) {
  return <p className="mt-3 text-xs text-slate-500">{ESTIMATE_NOTE}{through ? ` Insurance payments uploaded through ${shortDay(through)}.` : ""} Patients whose insurance has no payment files uploaded show no estimate.</p>;
}

// ---- The cells both views share ----

function CopayCell({ r }: { r: Row }) {
  if (r.copay) {
    return (
      <>
        <span className="font-semibold tabular-nums">{usd(r.copay.cents)}</span>
        <span className="block text-[11px] text-slate-500">{r.copay.seenOn === r.copay.outOf ? `on ${r.copay.outOf === 1 ? "their last visit" : r.copay.outOf === 2 ? "both visits" : `all ${r.copay.outOf} visits`}` : `on ${r.copay.seenOn} of ${visitsWord(r.copay.outOf)}`}{r.copay.fromLastYear ? ", last year" : ""}</span>
      </>
    );
  }
  return <span className="text-slate-400">{r.visits ? "None" : "–"}</span>;
}

function DeductibleCell({ r }: { r: Row }) {
  const d = r.deductible;
  if (!d) return <span className="text-slate-400">{r.visits ? "Not applied" : "–"}</span>;
  const label = d.state === "applies" ? "Not met" : d.state === "met" ? "Looks met" : `Applied in ${d.year - 1}`;
  return (
    <>
      <span className={cn("font-semibold", d.state === "applies" ? "text-violet-700 dark:text-violet-300" : d.state === "met" ? "text-emerald-700 dark:text-emerald-300" : "text-slate-700 dark:text-slate-200")}>{label}</span>
      <span className="block text-[11px] text-slate-500 tabular-nums">{usd(d.cents)} on {visitsWord(d.visits)}{d.state === "reset" ? "; starts over in January" : " this year"}</span>
    </>
  );
}

function CoinsuranceCell({ r }: { r: Row }) {
  if (!r.coinsurancePct) return <span className="text-slate-400">–</span>;
  return <><span className="font-semibold tabular-nums">{r.coinsurancePct}%</span>{r.coinsuranceCents ? <span className="block text-[11px] text-slate-500 tabular-nums">about {usd(r.coinsuranceCents)}</span> : null}</>;
}

function ExpectCell({ r }: { r: Row }) {
  return r.note ? <CollectChip note={r.note} className="px-2 py-1 text-[11px]" /> : <span className="text-xs text-slate-400">No estimate</span>;
}

function BasedOnCell({ r }: { r: Row }) {
  if (r.visits) return <>{visitsWord(r.visits)} paid<span className="block text-[11px] text-slate-500">latest {shortDay(r.lastVisit)}</span></>;
  return <span className="text-slate-500">{r.note?.basis === "plan" ? "Others on the same plan" : "No paid visits on file"}</span>;
}

const th = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500";
const td = "px-3 py-2.5 align-top text-sm";

// ---- A day's schedule ----

function DaySchedule() {
  const [params, setParams] = useUrlParams();
  const today = localDateStr();
  const urlDate = params.get("date");
  const date = urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate) ? urlDate : today;
  const setDate = (d: string) => setParams({ date: d === today ? null : d });
  const q = trpc.workspace.visitCost.schedule.useQuery({ date }, { retry: false, staleTime: 5 * 60_000 });
  const rows = q.data?.rows ?? [];
  const count = (f: (r: DayRow) => boolean) => rows.filter(f).length;
  // What the front desk can expect to collect that day: the copays, and the visits a deductible or coinsurance leaves to the patient.
  const expected = rows.reduce((s, r) => s + (r.note && r.note.kind !== "nothing" && r.note.cents ? r.note.cents : 0), 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Btn variant="secondary" size="sm" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day"><ChevronLeft size={15} /></Btn>
        <input type="date" className={cn(inputCls, "w-auto")} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Date" />
        <Btn variant="secondary" size="sm" onClick={() => setDate(addDays(date, 1))} aria-label="Next day"><ChevronRight size={15} /></Btn>
        {date !== today && <Btn variant="ghost" size="sm" onClick={() => setDate(today)}>Today</Btn>}
        <span className="text-sm font-medium text-slate-600 dark:text-slate-300">{longDay(date)}{date === today ? " (today)" : ""}</span>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorNote message={q.error.message} /> : rows.length === 0 ? (
        <Panel><EmptyState icon={CalendarDays} title="Nobody booked that day" body="Patients show up here from the imported Practice Fusion schedule." /></Panel>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Tile label="Visits" value={String(rows.length)} />
            <Tile label="Expect to collect" value={usd(expected)} hint="copays, deductibles and coinsurance" strong />
            <Tile label="With a copay" value={String(count((r) => r.note?.kind === "copay" || !!r.copay))} />
            <Tile label="Deductible not met" value={String(count((r) => r.note?.kind === "deductible"))} />
            <Tile label="No estimate" value={String(count((r) => !r.note))} hint="new, or no payment files" />
          </div>
          <Panel bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem]">
                <thead className="border-b border-slate-200 dark:border-slate-700">
                  <tr><th className={th}>Time</th><th className={th}>Patient</th><th className={th}>Insurance</th><th className={th}>Copay</th><th className={th}>Deductible</th><th className={th}>Coinsurance</th><th className={th}>Expect at check-in</th><th className={th}>Based on</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rows.map((r) => (
                    <tr key={r.appointmentId} className={cn(r.status === "no_show" && "opacity-60")}>
                      <td className={cn(td, "whitespace-nowrap tabular-nums text-slate-500")}>{time(r.startsAt)}</td>
                      <td className={td}>
                        <Link href={patientHref(r)} className="font-semibold hover:underline">{r.name}</Link>
                        <span className="block text-[11px] text-slate-500">{[r.provider, r.clinic, r.visitType, r.status === "no_show" ? "no-show" : null].filter(Boolean).join(" · ")}</span>
                      </td>
                      <td className={cn(td, "text-slate-600 dark:text-slate-300")}>{r.payer ?? <span className="text-slate-400">–</span>}</td>
                      <td className={td}><CopayCell r={r} /></td>
                      <td className={td}><DeductibleCell r={r} /></td>
                      <td className={td}><CoinsuranceCell r={r} /></td>
                      <td className={td}><ExpectCell r={r} /></td>
                      <td className={td}><BasedOnCell r={r} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
      <Footer through={q.data?.through} />
    </div>
  );
}

function Tile({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className={cn("rounded-xl border px-4 py-3", strong ? "border-teal-200 bg-teal-50 dark:border-teal-900 dark:bg-teal-950/30" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900")}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{value}</p>
      {hint && <p className="text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

// ---- Everyone with paid visits ----

function AllPatients() {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [page, setPage] = useState(1);
  // Search a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => { setQ(text.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [text]);
  const list = trpc.workspace.visitCost.list.useQuery({ q, kind, page }, { retry: false, staleTime: 5 * 60_000, placeholderData: (prev) => prev });
  const d = list.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1 sm:max-w-sm">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className={cn(inputCls, "pl-9")} placeholder="Search by patient name" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search by patient name" autoComplete="off" />
        </div>
        {(Object.keys(KIND_LABELS) as Kind[]).map((k) => (
          <button key={k} type="button" onClick={() => { setKind(k); setPage(1); }}
            className={cn("rounded-full border px-3 py-1 text-xs font-semibold", kind === k ? "border-brand bg-brand/5" : "border-slate-200 dark:border-slate-700")}>
            {KIND_LABELS[k]}{d ? ` ${(d.counts[k] ?? 0).toLocaleString("en-US")}` : ""}
          </button>
        ))}
      </div>
      {list.isLoading ? <Loading /> : list.error ? <ErrorNote message={list.error.message} /> : !d || d.rows.length === 0 ? (
        <Panel><EmptyState icon={Users} title="Nobody matches" body="Only patients with paid office visits in the uploaded payment files are listed here." /></Panel>
      ) : (
        <>
          <Panel bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem]">
                <thead className="border-b border-slate-200 dark:border-slate-700">
                  <tr><th className={th}>Patient</th><th className={th}>Insurance</th><th className={th}>Copay</th><th className={th}>Deductible</th><th className={th}>Coinsurance</th><th className={th}>Expect at check-in</th><th className={th}>Based on</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {d.rows.map((r: ListRow) => (
                    <tr key={r.subjectKey}>
                      <td className={td}>
                        <Link href={patientHref(r)} className="font-semibold hover:underline">{r.name}</Link>
                        {r.dob && <span className="block text-[11px] text-slate-500">born {shortDay(r.dob)}</span>}
                      </td>
                      <td className={cn(td, "text-slate-600 dark:text-slate-300")}>{r.payer ?? <span className="text-slate-400">–</span>}</td>
                      <td className={td}><CopayCell r={r} /></td>
                      <td className={td}><DeductibleCell r={r} /></td>
                      <td className={td}><CoinsuranceCell r={r} /></td>
                      <td className={td}><ExpectCell r={r} /></td>
                      <td className={td}><BasedOnCell r={r} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600 dark:text-slate-300">
            <span>{d.total.toLocaleString("en-US")} patient{d.total === 1 ? "" : "s"} · page {d.page} of {pages}</span>
            <span className="flex gap-2">
              <Btn variant="secondary" size="sm" disabled={d.page <= 1} onClick={() => setPage(d.page - 1)}><ChevronLeft size={15} /> Previous</Btn>
              <Btn variant="secondary" size="sm" disabled={d.page >= pages} onClick={() => setPage(d.page + 1)}>Next <ChevronRight size={15} /></Btn>
            </span>
          </div>
        </>
      )}
      <Footer through={d?.through} />
    </div>
  );
}
