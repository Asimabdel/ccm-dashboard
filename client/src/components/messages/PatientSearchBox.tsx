import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { fmtDob, inputCls } from "@/components/workspace/ui";
import { cn } from "@/lib/utils";

export interface PickedPatient { key: string; name: string }

/** Find a patient by name, date of birth or phone (the Patients directory) and pick them. */
export function PatientSearchBox({ onPick, autoFocus, dropUp, placeholder = "Search by name, date of birth or phone" }: { onPick: (p: PickedPatient) => void; autoFocus?: boolean; /** Open the results above the box (at the bottom of the screen). */ dropUp?: boolean; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const results = trpc.workspace.directory.list.useQuery({ q: debounced, status: "all", sort: "name", page: 1 }, { enabled: debounced.length >= 2 });
  return (
    <div className="relative">
      <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} aria-label="Find a patient" />
      {debounced.length >= 2 && (
        <div className={cn("absolute z-20 w-full max-h-56", dropUp ? "bottom-full mb-1" : "mt-1", "overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-600 dark:bg-slate-800")}>
          {results.isFetching && <p className="px-3 py-2 text-xs text-slate-400">Searching…</p>}
          {!results.isFetching && (results.data?.rows ?? []).length === 0 && <p className="px-3 py-2 text-xs text-slate-400">No matches</p>}
          {(results.data?.rows ?? []).slice(0, 8).map((r) => (
            <button type="button" key={r.key} onClick={() => { onPick({ key: r.key, name: r.name }); setQ(""); }} className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-700">
              {r.name} <span className="text-xs text-slate-400">{[r.dob ? `DOB ${fmtDob(r.dob)}` : null, r.clinicName].filter(Boolean).join(" · ")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
