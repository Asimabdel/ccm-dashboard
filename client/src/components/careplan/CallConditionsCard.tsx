import { useState } from "react";
import { Link } from "wouter";
import { BookOpen, ChevronDown, ClipboardCheck, Gauge, MessageCircleQuestion } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtShortDate } from "@/components/workspace/ui";
import { READINGS, type ReadingKey } from "@shared/ccmCall";
import { PLAN_STATUS } from "./status";

type Ctx = RouterOutputs["workspace"]["carePlans"]["forCall"];
type Section = Ctx["sections"][number];
/** The call's condition part, kept by the call page (so it saves with the note). */
export interface CallConditionState {
  /** By section key, then by question. */
  answers: Record<string, Record<string, string>>;
  readings: Partial<Record<ReadingKey, string>>;
  covered: string[];
  reviewed: boolean;
}
export const sectionKey = (s: Pick<Section, "key" | "id">) => s.key ?? s.id;

const field = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-teal-500/40 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100";

/**
 * The guided CCM call, condition by condition, after the check-in questions: the readings that matter for
 * the patient's conditions; for each condition ONE question this patient hasn't been asked before, and its
 * teaching points. The coordinator records what the patient says; nothing is judged.
 */
export function CallConditionsCard({ patientId, taskId, state, setState }: { patientId: number; taskId: number; state: CallConditionState; setState: (fn: (s: CallConditionState) => CallConditionState) => void }) {
  const q = trpc.workspace.carePlans.forCall.useQuery({ patientId, ccmTaskId: taskId });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (q.isLoading || q.error || !q.data) return null;
  const { plan, sections } = q.data;
  const readings: ReadingKey[] = q.data.readings.length ? q.data.readings : ["bp", "sugar"];
  const st = PLAN_STATUS[plan?.status ?? "none"]!;
  const isOpen = (s: Section, i: number) => open[s.id] ?? i === 0;

  const setAnswer = (s: Section, question: string, a: string) => setState((x) => ({ ...x, answers: { ...x.answers, [sectionKey(s)]: { ...(x.answers[sectionKey(s)] ?? {}), [question]: a } } }));
  const toggleCovered = (k: string) => setState((x) => ({ ...x, covered: x.covered.includes(k) ? x.covered.filter((y) => y !== k) : [...x.covered, k] }));

  return (
    <div className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <ClipboardCheck size={16} className="text-teal-600" />
        <h3 className="font-bold text-slate-900 dark:text-slate-50">Condition by condition</h3>
        <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-semibold", st.cls)}>{st.label}</span>
        <Link href={`/patients/${patientId}?tab=careplan`} className="ml-auto text-xs font-medium text-slate-500 underline hover:text-slate-800">Open care plan</Link>
      </div>
      <p className="mb-4 text-xs text-slate-500">One question per condition, never one this patient was asked before. Record what the patient tells you; the provider decides on any changes.</p>

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

      <div className="space-y-3">
        {sections.map((s, i) => {
          const o = isOpen(s, i);
          const k = sectionKey(s);
          const question = s.ask[0];
          const answered = !!(question && state.answers[k]?.[question]?.trim());
          return (
            <div key={s.id} className={cn("rounded-2xl border", o ? "border-teal-200 dark:border-teal-500/30" : "border-slate-100 dark:border-slate-700")}>
              <button type="button" onClick={() => setOpen((x) => ({ ...x, [s.id]: !o }))} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-teal-50 text-xs font-bold text-teal-800 dark:bg-teal-500/10 dark:text-teal-200">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
                    {s.label}
                    {s.kind === "addon" && <span className="ml-2 rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">Add-on</span>}
                    {!s.onPlan && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">Not on the plan yet</span>}
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    {[question ? (answered ? "question answered ✓" : "1 question") : s.allAsked ? "all its questions asked before" : null, s.key && state.covered.includes(s.key) ? "taught ✓" : null].filter(Boolean).join(" · ") || (s.teach.length ? "Teaching points" : "Nothing to go over")}
                  </span>
                </span>
                <ChevronDown size={16} className={cn("text-slate-400 transition-transform", o && "rotate-180")} />
              </button>
              {o && (
                <div className="space-y-4 border-t border-slate-100 px-4 py-4 dark:border-slate-800">
                  {question ? (
                    <label className="block">
                      <span className="mb-1 flex items-start gap-1.5 text-sm text-slate-700 dark:text-slate-200"><MessageCircleQuestion size={15} className="mt-0.5 shrink-0 text-teal-600" />{question}</span>
                      <textarea rows={1} value={state.answers[k]?.[question] ?? ""} maxLength={1000} placeholder="What the patient said…" onChange={(e) => setAnswer(s, question, e.target.value)}
                        onInput={(e) => { const el = e.currentTarget; el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }}
                        className={cn(field, "resize-none overflow-hidden")} />
                    </label>
                  ) : s.allAsked ? (
                    <p className="text-xs text-slate-500">This patient has been asked all of this condition's questions on earlier calls.</p>
                  ) : null}
                  {s.teach.length > 0 && (
                    <div className="rounded-xl border border-slate-100 p-3 dark:border-slate-700">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="flex flex-1 items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500"><BookOpen size={13} className="text-teal-600" /> Teach</p>
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
              )}
            </div>
          );
        })}
        {sections.length === 0 && <p className="text-sm text-slate-500">No chronic conditions on record.</p>}
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
  const conditions = sections.map((s) => ({ key: sectionKey(s), label: s.label, answers: s.ask.map((qq) => ({ q: qq, a: (state.answers[sectionKey(s)]?.[qq] ?? "").trim() })).filter((x) => x.a) })).filter((c) => c.answers.length);
  const readings = Object.fromEntries(Object.entries(state.readings).map(([k, v]) => [k, (v ?? "").trim()]).filter(([, v]) => v));
  return { callExtras: { readings, conditions }, coveredLabels: sections.filter((s) => s.key && state.covered.includes(s.key)).map((s) => s.label) };
}
