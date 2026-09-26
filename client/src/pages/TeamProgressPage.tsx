import { Fragment, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, PhoneCall, PhoneMissed, Clock, CalendarCheck } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { ICON, MetricRow, SHORT } from "@/components/workspace/MyProgress";
import { Btn, ErrorNote, Loading, PageHeader, Panel, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { addDays, fmtDay, localDateStr } from "@shared/workforce";
import { ROLE_METRIC_LABELS, ROLE_PRIMARY, fmtMinutes, progressOf, type Metric, type MetricKey } from "@shared/metrics";

const ROLE_ORDER = ["front_desk", "staff", "medical_assistant", "provider", "billing", "admin"];
/** After each role's key numbers: the columns everyone shares. */
const COMMON: MetricKey[] = ["calls", "missed", "talk", "tasks_done", "hours"];

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** Everyone's numbers for a day — the same ones each person sees in their top bar. Admins only. */
export default function TeamProgressPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const today = localDateStr();
  const [date, setDate] = useState(today);
  const q = trpc.workspace.metrics.team.useQuery({ date }, { enabled: user?.role === "admin", refetchInterval: date === today ? 60_000 : false });
  const [open, setOpen] = useState<number | null>(null);
  const data = q.data;

  return (
    <CCMDashboardLayout title="Team progress" pageTitle={false}>
      <PageHeader
        title="Team progress"
        subtitle="Everyone's numbers for the day: the same ones each person sees in their top bar. Click a person to see their full view."
        actions={
          <div className="flex items-center gap-1.5">
            <Btn size="sm" variant="secondary" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}><ChevronLeft size={15} /></Btn>
            <input type="date" max={today} className={cn(inputCls, "w-auto py-1.5")} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            <Btn size="sm" variant="secondary" aria-label="Next day" disabled={date >= today} onClick={() => setDate(addDays(date, 1))}><ChevronRight size={15} /></Btn>
            {date !== today && <Btn size="sm" variant="ghost" onClick={() => setDate(today)}>Today</Btn>}
          </div>
        }
      />
      {user && user.role !== "admin" && <ErrorNote message="Only an admin can see the team's numbers." />}
      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {data && (
        <div className="space-y-5">
          <p className="text-xs text-slate-500">
            {data.ringcentral.active
              ? <>Calls are every RingCentral call (patients or not), credited to the person whose extension made or answered it · last synced {ago(data.ringcentral.lastSuccessAt)} · {data.ringcentral.linkedExtensions} extensions matched to a login.</>
              : <>RingCentral's call log isn't connected, so only calls placed from MyPCP are counted (Admin → Integrations).</>}
          </p>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile icon={PhoneCall} label="Calls" value={data.totals.calls} sub={`${data.totals.made} made · ${data.totals.answered} answered`} />
            <Tile icon={PhoneMissed} label="Missed" value={data.totals.missed} sub={data.ringcentral.active ? "Rang and nobody picked up" : "Needs RingCentral"} />
            <Tile icon={Clock} label="Time on the phone" value={fmtMinutes(data.totals.talkMin)} sub="All calls" />
            <Tile icon={CalendarCheck} label="Appointments booked" value={data.totals.booked} sub="From call outcomes" />
          </div>

          {ROLE_ORDER.map((role) => {
            const people = data.people.filter((p) => p.role === role);
            if (!people.length) return null;
            const keys = [...(ROLE_PRIMARY[role] ?? []), ...COMMON].filter((k, i, a) => a.indexOf(k) === i)
              .filter((k) => people.some((p) => p.metrics.some((m) => m.key === k)));
            const val = (p: (typeof people)[number], k: MetricKey) => p.metrics.find((m) => m.key === k);
            const sorted = [...people].sort((a, b) => (val(b, keys[0]!)?.value ?? -1) - (val(a, keys[0]!)?.value ?? -1));
            return (
              <Panel key={role} title={ROLE_METRIC_LABELS[role] ?? role} subtitle={`${people.length} ${people.length === 1 ? "person" : "people"}`} bodyClassName="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-100 dark:border-slate-700">
                        <th className="px-4 py-2.5 font-semibold">Name</th>
                        {keys.map((k) => { const I = ICON[k]; return <th key={k} className="px-3 py-2.5 font-semibold whitespace-nowrap"><span className="inline-flex items-center gap-1"><I size={12} /> {SHORT[k]}</span></th>; })}
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                      {sorted.map((p) => (
                        <Fragment key={p.id}>
                          <tr className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60" onClick={() => setOpen(open === p.id ? null : p.id)}>
                            <td className="px-4 py-2.5 font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">{p.name}</td>
                            {keys.map((k) => <td key={k} className="px-3 py-2.5"><Cell m={val(p, k)} /></td>)}
                            <td className="pr-3"><ChevronDown size={15} className={cn("text-slate-400 transition-transform", open === p.id && "rotate-180")} /></td>
                          </tr>
                          {open === p.id && (
                            <tr className="bg-slate-50/60 dark:bg-slate-900/40">
                              <td colSpan={keys.length + 2} className="px-2 py-2">
                                <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">What {p.name.split(" ")[0]} sees for {fmtDay(data.date)}</p>
                                <ul className="grid md:grid-cols-2 xl:grid-cols-3">{p.metrics.map((m) => <MetricRow key={m.key} m={m} />)}</ul>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            );
          })}

          {data.lines.length > 0 && (
            <Panel title="Phone lines not linked to a person" subtitle="Shared phones, call queues, or RingCentral users without a matching MyPCP login. To credit someone, give their RingCentral extension the same email (or name) as their MyPCP login." bodyClassName="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-100 dark:border-slate-700">
                      <th className="px-4 py-2.5 font-semibold">Line</th><th className="px-3 py-2.5 font-semibold">Made</th><th className="px-3 py-2.5 font-semibold">Answered</th><th className="px-3 py-2.5 font-semibold">Missed</th><th className="px-3 py-2.5 font-semibold">On phone</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                    {data.lines.map((l) => (
                      <tr key={l.name}>
                        <td className="px-4 py-2.5 text-slate-800 dark:text-slate-100">{l.name}</td>
                        <td className="px-3 py-2.5 tabular-nums">{l.made}</td>
                        <td className="px-3 py-2.5 tabular-nums">{l.answered}</td>
                        <td className={cn("px-3 py-2.5 tabular-nums", l.missed && "text-rose-600 font-semibold")}>{l.missed}</td>
                        <td className="px-3 py-2.5 tabular-nums">{fmtMinutes(l.talkMin)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </div>
      )}
    </CCMDashboardLayout>
  );
}

function Tile({ icon: Icon, label, value, sub }: { icon: React.ElementType; label: string; value: number | string; sub: string }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-slate-500"><Icon size={13} /> {label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{value}</p>
      <p className="text-[11px] text-slate-500">{sub}</p>
    </div>
  );
}

function Cell({ m }: { m: Metric | undefined }) {
  if (!m) return <span className="text-slate-300 dark:text-slate-600">—</span>;
  const p = progressOf(m);
  return (
    <div className="min-w-[56px]" title={[m.label, m.goal ? `goal ${m.goal}` : m.usual ? `usual ${m.usual}` : null, m.hint].filter(Boolean).join(" · ")}>
      <span className={cn("tabular-nums font-semibold", m.key === "missed" && m.value > 0 ? "text-rose-600" : "text-slate-900 dark:text-slate-100")}>
        {m.display ?? m.value}{m.goal ? <span className="font-normal text-slate-400">/{m.goal}</span> : null}
      </span>
      {p != null && (
        <span className="mt-1 block h-1 w-14 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
          <span className={cn("block h-full rounded-full", p >= 1 ? "bg-emerald-500" : "bg-brand")} style={{ width: `${Math.round(p * 100)}%` }} />
        </span>
      )}
    </div>
  );
}
