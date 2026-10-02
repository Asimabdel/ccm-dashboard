import { useState } from "react";
import { Link } from "wouter";
import { BookOpen, ChevronDown, ChevronRight, ClipboardCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtShortDate } from "@/components/workspace/ui";
import { PLAN_STATUS } from "./status";

/**
 * Guided CCM call: the patient's care plan (goals to go over) and each condition's approved teaching
 * points. The coordinator ticks what they covered; it's saved with the note and goes in the AI note.
 */
export function CallCarePlanCard({ patientId, covered, setCovered, reviewed, setReviewed }: {
  patientId: number; covered: string[]; setCovered: (v: string[]) => void; reviewed: boolean; setReviewed: (v: boolean) => void;
}) {
  const q = trpc.workspace.carePlans.forCall.useQuery({ patientId });
  const [open, setOpen] = useState<string | null>(null);
  const [goalsOpen, setGoalsOpen] = useState(false);
  if (q.isLoading || q.error || !q.data) return null;
  const { plan, conditions } = q.data;
  const toggle = (k: string) => setCovered(covered.includes(k) ? covered.filter((x) => x !== k) : [...covered, k]);
  const st = PLAN_STATUS[plan?.status ?? "none"]!;

  return (
    <div className="bg-white rounded-3xl border border-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] p-6">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <ClipboardCheck size={16} className="text-teal-600" />
        <h3 className="font-bold text-slate-900">Care plan & education</h3>
        <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-semibold", st.cls)}>{st.label}</span>
        <Link href={`/patients/${patientId}?tab=careplan`} className="ml-auto text-xs font-medium text-slate-500 underline hover:text-slate-800">Open care plan</Link>
      </div>

      {plan ? (
        <div className="mb-5">
          <button type="button" onClick={() => setGoalsOpen((v) => !v)} className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
            {goalsOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />} Goals to go over ({plan.problems.length} problem{plan.problems.length === 1 ? "" : "s"})
          </button>
          {goalsOpen && (
            <div className="mt-2 space-y-3 rounded-2xl bg-slate-50 p-4 dark:bg-slate-800/60">
              {plan.problems.map((p, i) => (
                <div key={i}>
                  <p className="text-sm font-semibold text-slate-800">{p.problem}</p>
                  <ul className="mt-1 list-disc ps-5 text-[13px] text-slate-600">{p.goals.map((g, j) => <li key={j}>{g}</li>)}</ul>
                </div>
              ))}
            </div>
          )}
          <label className="mt-3 flex items-center gap-2.5 cursor-pointer text-sm text-slate-700">
            <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} className="accent-teal-600 w-4 h-4" />
            Reviewed the care plan with the patient on this call
          </label>
          {plan.reviewedThisMonth && !reviewed && <p className="mt-1 text-[11px] text-emerald-700">Already reviewed earlier this month.</p>}
        </div>
      ) : (
        <p className="mb-5 text-sm text-slate-500">No care plan yet. <Link href={`/patients/${patientId}?tab=careplan`} className="font-medium text-slate-700 underline">Start it</Link> from the approved templates; a provider signs it.</p>
      )}

      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700"><BookOpen size={14} className="text-teal-600" /> Teach today</p>
      {conditions.length === 0 && <p className="text-sm text-slate-500">No chronic conditions on record.</p>}
      <div className="space-y-2">
        {conditions.map((c) => (
          <div key={c.key} className={cn("rounded-2xl border px-4 py-3", covered.includes(c.key) ? "border-teal-200 bg-teal-50/50 dark:border-teal-500/40 dark:bg-teal-500/10" : "border-slate-100 dark:border-slate-700")}>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setOpen(open === c.key ? null : c.key)} disabled={!c.talkingPoints} className="flex flex-1 items-center gap-1.5 text-left text-sm font-medium text-slate-800 disabled:cursor-default">
                {c.talkingPoints ? (open === c.key ? <ChevronDown size={15} /> : <ChevronRight size={15} />) : <span className="w-[15px]" />}
                {c.label}
              </button>
              <span className="text-[11px] text-slate-400">{c.lastCovered ? `Last taught ${fmtShortDate(c.lastCovered)}` : "Not taught yet"}</span>
              {c.talkingPoints ? (
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer">
                  <input type="checkbox" checked={covered.includes(c.key)} onChange={() => toggle(c.key)} className="accent-teal-600 w-4 h-4" /> Covered
                </label>
              ) : <span className="text-[11px] text-amber-700">Talking points not approved yet</span>}
            </div>
            {open === c.key && c.talkingPoints && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2 text-[13px]">
                <div><p className="font-semibold text-slate-700">Teach</p><ul className="mt-1 list-disc ps-5 space-y-1 text-slate-600">{c.talkingPoints.teach.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
                <div><p className="font-semibold text-slate-700">Ask</p><ul className="mt-1 list-disc ps-5 space-y-1 text-slate-600">{c.talkingPoints.ask.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
