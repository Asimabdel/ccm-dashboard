import { useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, BookOpen, Check, ChevronDown, ClipboardCheck, Gauge } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtShortDate } from "@/components/workspace/ui";
import { READINGS, type ReadingKey } from "@shared/ccmCall";
import { joinAnswer } from "@shared/ccmQuestions";
import { PLAN_STATUS } from "./status";

type Ctx = RouterOutputs["workspace"]["carePlans"]["forCall"];
type Section = Ctx["sections"][number];
/** The call's condition part, kept by the call page (so it saves with the note). */
export interface CallConditionState {
  /** By section key: the question asked, the tapped answer, and an optional note. */
  answers: Record<string, { q: string; choice: string; note: string }>;
  readings: Partial<Record<ReadingKey, string>>;
  covered: string[];
  reviewed: boolean;
}
export const sectionKey = (s: Pick<Section, "key" | "id">) => s.key ?? s.id;

const field = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-teal-500/40 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100";

/**
 * The guided CCM call, condition by condition, after the check-in questions: the readings that matter for
 * the patient's conditions, then for each condition ONE short question (one this patient hasn't been asked
 * before) answered with a tap, and its teaching points. The coordinator records what the patient says.
 */
export function CallConditionsCard({ patientId, taskId, state, setState }: { patientId: number; taskId: number; state: CallConditionState; setState: (fn: (s: CallConditionState) => CallConditionState) => void }) {
  const q = trpc.workspace.carePlans.forCall.useQuery({ patientId, ccmTaskId: taskId });
  const [teachOpen, setTeachOpen] = useState<Record<string, boolean>>({});
  if (q.isLoading || q.error || !q.data) return null;
  const { plan, sections } = q.data;
  const readings: ReadingKey[] = q.data.readings.length ? q.data.readings : ["bp", "sugar"];
  const st = PLAN_STATUS[plan?.status ?? "none"]!;
  const asked = sections.filter((s) => s.question);
  const answered = asked.filter((s) => state.answers[sectionKey(s)]?.choice).length;

  const setAnswer = (s: Section, patch: Partial<{ choice: string; note: string }>) => setState((x) => {
    const k = sectionKey(s);
    const cur = x.answers[k] ?? { q: s.question!.q, choice: "", note: "" };
    return { ...x, answers: { ...x.answers, [k]: { ...cur, q: s.question!.q, ...patch } } };
  });
  const toggleCovered = (k: string) => setState((x) => ({ ...x, covered: x.covered.includes(k) ? x.covered.filter((y) => y !== k) : [...x.covered, k] }));

  return (
    <div className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <ClipboardCheck size={16} className="text-teal-600" />
        <h3 className="font-bold text-slate-900 dark:text-slate-50">Condition by condition</h3>
        <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-semibold", st.cls)}>{st.label}</span>
        <Link href={`/patients/${patientId}?tab=careplan`} className="ml-auto text-xs font-medium text-slate-500 underline hover:text-slate-800">Open care plan</Link>
      </div>
      <p className="mb-4 text-xs text-slate-500">
        One quick question per condition{asked.length ? ` (${answered} of ${asked.length} answered)` : ""}. Tap the patient's answer; add a note only if needed.
      </p>

      {/* Readings for their conditions */}
      <div className="mb-4 rounded-2xl bg-slate-50 p-4 dark:bg-slate-800/60">
        <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200"><Gauge size={14} className="text-teal-600" /> Readings</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {readings.map((k) => (
            <label key={k} className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">{READINGS[k].question}</span>
              <input value={state.readings[k] ?? ""} maxLength={120} placeholder={READINGS[k].placeholder} onChange={(e) => setState((x) => ({ ...x, readings: { ...x.readings, [k]: e.target.value } }))} className={field} />
            </label>
          ))}
        </div>
      </div>

      <div className="divide-y divide-slate-100 rounded-2xl border border-slate-100 dark:divide-slate-800 dark:border-slate-700">
        {sections.map((s, i) => {
          const k = sectionKey(s);
          const a = state.answers[k];
          const tell = !!(a?.choice && s.question?.tell?.includes(a.choice));
          const tOpen = !!teachOpen[s.id];
          return (
            <div key={s.id} className="px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid size-6 shrink-0 place-items-center rounded-md bg-teal-50 text-[11px] font-bold text-teal-800 dark:bg-teal-500/10 dark:text-teal-200">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
                  {s.label}
                  {s.kind === "addon" && <span className="ml-2 rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">Add-on</span>}
                  {!s.onPlan && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">Not on the plan yet</span>}
                </span>
                {s.teach.length > 0 && (
                  <button type="button" onClick={() => setTeachOpen((x) => ({ ...x, [s.id]: !tOpen }))} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
                    <BookOpen size={12} /> Teach{s.key && state.covered.includes(s.key) ? " ✓" : ""} <ChevronDown size={12} className={cn("transition-transform", tOpen && "rotate-180")} />
                  </button>
                )}
              </div>

              {s.question ? (
                <div className="mt-2 ps-8">
                  <p className="text-[15px] font-medium text-slate-800 dark:text-slate-100">{s.question.q}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={s.question.q}>
                      {s.question.options.map((o) => {
                        const on = a?.choice === o;
                        return (
                          <button key={o} type="button" role="radio" aria-checked={on} onClick={() => setAnswer(s, { choice: on ? "" : o })}
                            className={cn("inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm font-semibold transition",
                              on ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-teal-300 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200")}>
                            {on && <Check size={13} strokeWidth={3} />}{o}
                          </button>
                        );
                      })}
                    </div>
                    <input value={a?.note ?? ""} maxLength={300} placeholder="Note (optional)" onChange={(e) => setAnswer(s, { note: e.target.value })} className={cn(field, "min-w-[10rem] flex-1 py-1.5")} />
                  </div>
                  {tell && <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300"><AlertTriangle size={12} /> Worth letting the provider know: use "Flag this patient for provider review" below.</p>}
                </div>
              ) : s.allAsked ? (
                <p className="mt-1 ps-8 text-xs text-slate-500">All of this condition's questions were asked on earlier calls.</p>
              ) : null}

              {tOpen && (
                <div className="mt-3 ms-8 rounded-xl border border-slate-100 p-3 dark:border-slate-700">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="flex-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Teach</p>
                    <span className="text-[11px] text-slate-400">{s.lastCovered ? `Last taught ${fmtShortDate(s.lastCovered)}` : "Not taught yet"}</span>
                    {s.key && (
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200">
                        <input type="checkbox" checked={state.covered.includes(s.key)} onChange={() => toggleCovered(s.key!)} className="size-4 accent-teal-600" /> Covered
                      </label>
                    )}
                  </div>
                  <ul className="mt-2 list-disc space-y-1 ps-5 text-[13px] text-slate-600 dark:text-slate-300">{s.teach.map((x, j) => <li key={j}>{x}</li>)}</ul>
                </div>
              )}
            </div>
          );
        })}
        {sections.length === 0 && <p className="px-4 py-3 text-sm text-slate-500">No chronic conditions on record.</p>}
      </div>

      {plan && (
        <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={state.reviewed} onChange={(e) => setState((x) => ({ ...x, reviewed: e.target.checked }))} className="size-4 accent-teal-600" />
          Reviewed the care plan with the patient on this call
          {plan.reviewedThisMonth && !state.reviewed && <span className="text-[11px] text-emerald-700">(already reviewed earlier this month)</span>}
        </label>
      )}
    </div>
  );
}

/** What the call page sends with the note, and to the AI note, from the condition part of the call. */
export function callConditionPayload(state: CallConditionState, ctx: Ctx | undefined) {
  const sections = ctx?.sections ?? [];
  const conditions = sections.flatMap((s) => {
    const a = state.answers[sectionKey(s)];
    const text = a && s.question && a.q === s.question.q ? joinAnswer(a.choice, a.note) : "";
    return text ? [{ key: sectionKey(s), label: s.label, answers: [{ q: s.question!.q, a: text }] }] : [];
  });
  const readings = Object.fromEntries(Object.entries(state.readings).map(([k, v]) => [k, (v ?? "").trim()]).filter(([, v]) => v));
  return { callExtras: { readings, conditions }, coveredLabels: sections.filter((s) => s.key && state.covered.includes(s.key)).map((s) => s.label) };
}
