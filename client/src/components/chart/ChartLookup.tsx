import { useState } from "react";
import { Link } from "wouter";
import { Database, Loader2, Search } from "lucide-react";
import { inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDay } from "@shared/workforce";
import { folderHref } from "@shared/folder";

/** Where a person's chart lives: roster patients' Patient 360 Chart tab, everyone else the Chart sub-folder of their folder. */
export const chartHref = (key: string) => (key.startsWith("p:") ? `/patients/${key.slice(2)}?tab=chart` : folderHref(key, "chart"));

/** Find anyone's chart, including patients who are only in Practice Fusion. */
export function ChartLookup({ className }: { className?: string }) {
  const [q, setQ] = useState("");
  const search = trpc.workspace.chart.search.useQuery(q.trim(), { enabled: q.trim().length >= 2 });
  return (
    <div className={cn("relative", className)}>
      <Database size={15} className="absolute left-3 top-[19px] -translate-y-1/2 text-slate-400" />
      <input className={cn(inputCls, "pl-9")} placeholder="Find any patient's folder (incl. Practice Fusion-only)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Chart lookup" />
      {q.trim().length >= 2 && (
        <div className="absolute z-30 mt-1 w-full max-h-80 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {search.isFetching && <Loader2 size={15} className="animate-spin text-slate-400 m-3" />}
          {search.data?.length === 0 && <p className="px-3 py-2.5 text-sm text-slate-500"><Search size={13} className="inline mr-1" />No patient by that name.</p>}
          {(search.data ?? []).map((p) => (
            <Link key={p.key} href={folderHref(p.key)} onClick={() => setQ("")} className="block px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800">
              <span className="block text-sm font-medium text-slate-900 dark:text-slate-50">{p.name}</span>
              <span className="block text-xs text-slate-500">
                DOB {p.dob ? fmtDay(p.dob, { month: "short", day: "numeric", year: "numeric" }) : "unknown"}
                {p.clinicName ? ` · ${p.clinicName}` : ""}
                {p.key.startsWith("f:") ? " · Practice Fusion only" : p.key.startsWith("s:") ? " · on the schedule" : ""}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
