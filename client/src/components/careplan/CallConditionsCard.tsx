import { useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, BookOpen, ChevronDown, ClipboardCheck, Gauge, MessageCircleQuestion, Target } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtShortDate } from "@/components/workspace/ui";
import { GOAL_STATUSES, GOAL_STATUS_LABELS, type GoalStatus } from "@shared/carePlanProgress";
import { READINGS, type ReadingKey } from "@shared/ccmCall";
import { GOAL_TONE, GoalChip } from "./planBits";
import { PLAN_STATUS } from "./status";

type Ctx = RouterOutputs["workspace"]["carePlans"]["forCall"];
type Section = Ctx["sections"][number];
export type GoalEntry = { problemId: string; problem: string; goal: string; status: GoalStatus | null; value: string };
/** The call's condition part, kept by the call page (so it saves with the note). */
export interface CallConditionState {
  goals: Record<string, GoalEntry>;
  /** By section key, then by question. */
  answers: Record<string, Record<string, string>>;
  readings: Partial<Record<ReadingKey, string>>;
  covered: string[];
  reviewed: boolean;
}
export const sectionKey = (s: Pick<Section, "key" | "id">) => s.key ?? s.id;

const field = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-teal-500/40 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100";

/**
 * The guided CCM call, condition by condition: the readings that matter for the patient's conditions;
 * for each condition its care-plan goals (on track / not yet / met, and what the patient says), its own
 * questions, and its teaching points. The coordinator records what the patient reports; nothing is judged.
 */
export function CallConditionsCard({ patientId, state, setState }: { patientId: number; state: CallConditionState; setState: (fn: (s: CallConditionState) => CallConditionState) => void }) {
  const q = trpc.workspace.carePlans.forCall.useQuery({ patientId });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (q.isLoading || q.error || !q.data) return null;
  const { plan, sections } = q.data;
  const readings: ReadingKey[] = q.data.readings.length ? q.data.readings : ["bp", "sugar"];
  const st = PLAN_STATUS[plan?.status ?? "none"]!;
  const isOpen = (s: Section, i: number) => open[s.id] ?? i === 0;
  const allGoals = sections.flatMap((s) => s.goals);
  const checkedNow = allGoals.filter((g) => state.goals[g.goalId]?.status).length;

  const setGoal = (s: Section, g: Section["goals"][number], patch: Partial<GoalEntry>) => setState((x) => {
    const cur = x.goals[g.goalId] ?? { problemId: s.id, problem: s.label, goal: g.goal, status: null, value: "" };
    const next = { ...cur, ...patch };
    return { ...x, goals: { ...x.goals, [g.goalId]: next }, reviewed: x.reviewed || !!next.status };
  });
  const setAnswer = (s: Section, question: string, a: string) => setState((x) => ({ ...x, answers: { ...x.answers, [sectionKey(s)]: { ...(x.answers[sectionKey(s)] ?? {}), [question]: a } } }));
  const toggleCovered = (k: string) => setState((x) => ({ ...x, covered: x.covered.includes(k) ? x.covered.filter((y) => y !== k) : [...x.covered, k] }));

  return (
    <div className="rounded-3xl border border-slate-100 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.18)] dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <ClipboardCheck size={16} className="text-teal-600" />
        <h3 className="font-bold text-slate-900 dark:text-slate-50">Care plan, condition by condition</h3>
        <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-semibold", st.cls)}>{st.label}</span>
        <Link href={`/patients/${patientId}?tab=careplan`} className="ml-auto text-xs font-medium text-slate-500 underline hover:text-slate-800">Open care plan</Link>
      </div>
      <p className="mb-4 text-xs text-slate-500">
        {allGoals.length ? `${checkedNow} of ${allGoals.length} goals checked on this call.` : plan ? "The plan has no goals yet." : "No care plan yet: a provider signs one on the Care plan tab."} Record what the patient tells you; the provider decides on any changes.
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

      <div className="space-y-3">
        {sections.map((s, i) => {
          const o = isOpen(s, i);
          const k = sectionKey(s);
          const done = s.goals.filter((g) => state.goals[g.goalId]?.status).length;
          const answered = s.ask.filter((qq) => state.answers[k]?.[qq]?.trim()).length;
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
                    {[s.goals.length ? `${done}/${s.goals.length} goals` : null, s.ask.length ? `${answered}/${s.ask.length} questions` : null, state.covered.includes(k) ? "taught ✓" : null].filter(Boolean).join(" · ") || "Nothing to go over"}
                  </span>
                </span>
                {s.goals.some((g) => g.flag) && <AlertTriangle size={15} className="text-amber-600" aria-label="A goal to bring to the provider" />}
                <ChevronDown size={16} className={cn("text-slate-400 transition-transform", o && "rotate-180")} />
              </button>
              {o && (
                <div className="space-y-4 border-t border-slate-100 px-4 py-4 dark:border-slate-800">
                  {s.goals.length > 0 && (
                    <div>
                      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500"><Target size={13} className="text-teal-600" /> Goals: how is it going?</p>
                      <div className="space-y-3">
                        {s.goals.map((g) => {
                          const cur = state.goals[g.goalId];
                          return (
                            <div key={g.goalId} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
                              <p className="text-sm text-slate-800 dark:text-slate-100">{g.goal}</p>
                              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                                {g.latest ? <>Last call: <GoalChip status={g.latest.status as GoalStatus} />{g.latest.value ? <b className="font-semibold text-slate-700 dark:text-slate-200">{g.latest.value}</b> : null} · {fmtShortDate(g.latest.at)}</> : "Not checked on a call before"}
                                {g.flag && <span className="font-semibold text-amber-700">· "Not yet" several calls in a row: flag for the provider if it still isn't going well</span>}
                              </p>
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <div className="flex gap-1" role="radiogroup" aria-label="How is this goal going?">
                                  {GOAL_STATUSES.map((v) => (
                                    <button key={v} type="button" role="radio" aria-checked={cur?.status === v} onClick={() => setGoal(s, g, { status: cur?.status === v ? null : v })}
                                      className={cn("rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition", cur?.status === v ? cn(GOAL_TONE[v].chip, "border-transparent") : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300")}>
                                      {GOAL_STATUS_LABELS[v]}
                                    </button>
                                  ))}
                                </div>
                                <input value={cur?.value ?? ""} maxLength={120} placeholder="Number or what they said (optional)" onChange={(e) => setGoal(s, g, { value: e.target.value })} className={cn(field, "min-w-[12rem] flex-1 py-1.5")} />
                              </div>
                              {cur?.value?.trim() && !cur.status && <p className="mt-1 text-[11px] font-medium text-amber-700">Pick on track, not yet or met so this is saved.</p>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {s.ask.length > 0 && (
                    <div>
                      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500"><MessageCircleQuestion size={13} className="text-teal-600" /> Ask</p>
                      <div className="space-y-2.5">
                        {s.ask.map((qq) => (
                          <label key={qq} className="block">
                            <span className="mb-1 block text-sm text-slate-700 dark:text-slate-200">{qq}</span>
                            <textarea rows={1} value={state.answers[k]?.[qq] ?? ""} maxLength={1000} placeholder="What the patient said…" onChange={(e) => setAnswer(s, qq, e.target.value)}
                              onInput={(e) => { const el = e.currentTarget; el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }}
                              className={cn(field, "resize-none overflow-hidden")} />
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
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
  const goalChecks = Object.entries(state.goals).filter(([, g]) => g.status).map(([goalId, g]) => ({ goalId, problemId: g.problemId, problem: g.problem, goal: g.goal, status: g.status!, value: g.value.trim() }));
  const conditions = sections.map((s) => ({ key: sectionKey(s), label: s.label, answers: s.ask.map((qq) => ({ q: qq, a: (state.answers[sectionKey(s)]?.[qq] ?? "").trim() })).filter((x) => x.a) })).filter((c) => c.answers.length);
  const readings = Object.fromEntries(Object.entries(state.readings).map(([k, v]) => [k, (v ?? "").trim()]).filter(([, v]) => v));
  return { goalChecks, callExtras: { readings, conditions }, coveredLabels: sections.filter((s) => s.key && state.covered.includes(s.key)).map((s) => s.label) };
}
