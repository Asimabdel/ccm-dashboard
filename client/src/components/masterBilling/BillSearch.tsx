// Master Billing search (2026-11-17): one box at the top of the page finds claims by patient, claim or
// check #, CPT code, insurance, provider or clinic. The server does the searching (any date, newest 50).
import { useEffect, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Btn, ErrorNote, Panel, inputCls } from "@/components/workspace/ui";
import { niceName } from "@/lib/masterBillingFiles";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { type BillStatus } from "@shared/billCodes";
import { money } from "@shared/payments";
import { StatusBadge } from "./StatusBadge";

const day = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

/** What's typed, and the same text once typing pauses (what's searched). */
export function useBillSearch() {
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]);
  return { text, setText, term, clear: () => { setText(""); setTerm(""); } };
}

export function BillSearchBox({ text, onChange, onClear }: { text: string; onChange: (v: string) => void; onClear: () => void }) {
  return (
    <div className="relative">
      <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
      <input
        type="search" value={text} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") onClear(); }}
        placeholder="Search claims: patient, claim or check #, CPT, insurance…" aria-label="Search claims"
        title="Finds claims by patient name, claim number, check number, member ID, CPT code, insurance, provider or clinic. Every word has to match."
        className={cn(inputCls, "h-9 w-[min(22rem,80vw)] pl-8 pr-8 text-sm")}
      />
      {text && (
        <button type="button" onClick={onClear} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200" aria-label="Clear search">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** The claims found, with their key numbers. Click one to open it. */
export function BillSearchResults({ term, onOpen, onClear }: { term: string; onOpen: (id: number) => void; onClear: () => void }) {
  const q = trpc.masterBilling.search.useQuery({ q: term }, { enabled: term.length >= 2, placeholderData: (prev) => prev });
  if (term.length < 2) return null;
  const d = q.data;
  const subtitle = !d ? "Searching every claim, any date…"
    : !d.total ? "Every claim, any date."
    : d.total > d.rows.length ? `${d.total.toLocaleString()} claims found, any date. Showing the newest ${d.rows.length}: add another word (a CPT code, insurance or provider) to narrow it down.`
    : `${d.total.toLocaleString()} claim${d.total === 1 ? "" : "s"} found, any date. Newest first.`;
  const th = "px-3 py-2 text-right font-medium";
  const td = "px-3 py-2 text-right tabular-nums";
  return (
    <Panel className="mb-4" bodyClassName="p-0"
      title={<span className="inline-flex items-center gap-2">Search: “{term}”{q.isFetching && <Loader2 size={13} className="animate-spin text-slate-400" />}</span>}
      subtitle={subtitle}
      action={<Btn size="sm" variant="secondary" onClick={onClear}><X size={13} /> Close</Btn>}>
      {q.error && <div className="p-4"><ErrorNote message={q.error.message} /></div>}
      {d && !d.rows.length && <p className="px-5 py-6 text-sm text-slate-500">No claims match. Try part of a name, a claim or check number, a CPT code, an insurance, a provider or a clinic.</p>}
      {d && d.rows.length > 0 && (
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full min-w-[1080px] text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Service</th><th className="px-3 py-2 text-left font-medium">Patient</th>
                <th className="px-3 py-2 text-left font-medium">Insurance</th><th className="px-3 py-2 text-left font-medium">Provider · clinic</th><th className="px-3 py-2 text-left font-medium">CPT</th>
                <th className={th}>Billed</th><th className={th}>Paid</th><th className="px-3 py-2 text-left font-medium">Status</th><th className="px-3 py-2 text-left font-medium">Found by</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.id} onClick={() => onOpen(r.id)} title="Open this claim" className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-800/40">
                  <td className="whitespace-nowrap px-3 py-2">{day(r.firstServiceDate)}{r.lastPaidDate && <span className="block text-xs text-slate-400">paid {day(r.lastPaidDate)}</span>}</td>
                  <td className="px-3 py-2">
                    <span className="font-medium text-slate-800 dark:text-slate-100">{niceName(r.patientName) || "—"}</span>
                    {!r.subjectKey && <span className="ml-1.5 rounded bg-amber-100 px-1 text-[11px] text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">no match</span>}
                    {r.claimNo && <span className="block text-xs text-slate-400">claim {r.claimNo}</span>}
                  </td>
                  <td className="max-w-[200px] truncate px-3 py-2" title={r.payerName ?? ""}>{r.payerName ?? "—"}</td>
                  <td className="max-w-[200px] truncate px-3 py-2 text-slate-600 dark:text-slate-300" title={[r.providerLabel, r.clinicName].filter(Boolean).join(" · ")}>{[r.providerLabel, r.clinicName].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="max-w-[140px] truncate px-3 py-2" title={r.codes.join(", ")}>{r.codes.join(", ") || "—"}</td>
                  <td className={td}>{money(r.billedCents)}</td>
                  <td className={td}>{money(r.paidCents)}</td>
                  <td className="px-3 py-2"><StatusBadge status={r.status as BillStatus} /></td>
                  <td className="px-3 py-2">
                    <div className="flex max-w-[220px] flex-wrap gap-1">
                      {r.hits.map((h) => <span key={h} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">{h}</span>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
