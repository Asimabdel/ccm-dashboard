import { useState } from "react";
import { BarChart3, Info } from "lucide-react";
import { EmptyState, ErrorNote, Loading, MetricCard, Panel } from "@/components/workspace/ui";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type Row = RouterOutputs["workspace"]["outreach"]["results"]["byCaller"][number];

const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
];

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");

/** Call results: calls, people reached, booked, and booked visits that showed up on the schedule. */
export function CallResults() {
  const [days, setDays] = useState(7);
  const q = trpc.workspace.outreach.results.useQuery({ days });
  const t = q.data?.total;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-1.5">
        {RANGES.map((r) => (
          <button key={r.days} onClick={() => setDays(r.days)}
            className={cn("rounded-full border px-3 py-1 text-xs font-semibold", days === r.days ? "border-brand bg-brand text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300")}>
            {r.label}
          </button>
        ))}
        {q.data?.onlyMine && <span className="ml-2 text-xs text-slate-500">Your own calls</span>}
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {q.data && !t && <Panel><EmptyState icon={BarChart3} title="No calls to patients in this period" body="Calls made through MyPCP's phone, desk phones on RingCentral, and calls logged by hand all count." /></Panel>}
      {t && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <MetricCard label="Calls" value={t.calls} hint={`${t.patients} patients`} />
            <MetricCard label="Reached" value={t.reached} hint={`${pct(t.reached, t.calls)} of calls`} />
            <MetricCard label="Booked" value={t.booked} hint={`${pct(t.booked, t.patients)} of patients`} tone="good" />
            <MetricCard label="On the schedule" value={t.onSchedule} hint={`of ${t.booked} booked`} />
            <MetricCard label="Result not recorded" value={t.notRecorded} hint="Add it from the list" tone={t.notRecorded ? "warn" : "neutral"} />
          </div>
          <ResultsTable title="By caller" rows={q.data!.byCaller} />
          <ResultsTable title="By list" rows={q.data!.byList} />
          <p className="flex items-start gap-2 text-xs text-slate-500">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span><b>Reached</b> = booked, asked to call back, or declined. <b>On the schedule</b> = a booked patient whose new visit showed up in a Practice Fusion schedule import after the call (not cancelled), so it depends on importing the schedule regularly. Desk-phone calls come from the RingCentral call log every 10 minutes.</span>
          </p>
        </>
      )}
    </div>
  );
}

function ResultsTable({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <Panel title={title} bodyClassName="p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50/70 text-xs text-slate-500 dark:bg-slate-800">
            <tr>
              <th className="px-4 py-2 text-left font-medium">{title === "By caller" ? "Caller" : "List"}</th>
              <th className="px-3 py-2 text-right font-medium">Calls</th>
              <th className="px-3 py-2 text-right font-medium">Patients</th>
              <th className="px-3 py-2 text-right font-medium">Reached</th>
              <th className="px-3 py-2 text-right font-medium">Booked</th>
              <th className="px-3 py-2 text-right font-medium">Booked rate</th>
              <th className="px-3 py-2 text-right font-medium">On schedule</th>
              <th className="px-3 py-2 text-right font-medium">Not recorded</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="px-4 py-2 font-medium text-slate-800 dark:text-slate-100">{r.label}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.calls}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.patients}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.reached}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">{r.booked}</td>
                <td className="px-3 py-2 text-right tabular-nums">{pct(r.booked, r.patients)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.onSchedule}</td>
                <td className={cn("px-3 py-2 text-right tabular-nums", r.notRecorded ? "text-amber-600" : "text-slate-400")}>{r.notRecorded}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
