// Care-plan goals checked with the patient on the monthly CCM call, and how each goal is going over the
// months. Also: what changed in a plan since the provider last signed it. Pure (server + client).
//
// The coordinator only RECORDS what the patient reports (on track / not yet / met, and the number they
// give); nothing here judges a result. A goal that has been "not yet" several calls in a row is flagged so
// the care team can bring it to the provider (the provider decides whether to revise it).
import { GENERAL_LABELS, PLAN_FIELD_LABELS, PLAN_LIST_FIELDS, type PlanGeneral, type PlanProblem } from "./carePlanDoc";

export const GOAL_STATUSES = ["on_track", "not_yet", "met"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = { on_track: "On track", not_yet: "Not yet", met: "Met" };

/** One goal checked on one call. */
export interface GoalCheck {
  /** The plan section (problemIdOf) and the goal (goalIdOf). */
  problemId: string;
  goalId: string;
  /** As worded on the plan at the time (so the history reads right even if the plan changes later). */
  problem: string;
  goal: string;
  status: GoalStatus;
  /** The number or words the patient gave, e.g. "A1c 7.4" or "walking 3 days a week". */
  value: string;
}

/** How many calls in a row a goal can be "not yet" before the care team is told to bring it to the provider. */
export const NOT_YET_FLAG = 3;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.;:,\s]+$/, "").trim();

/** A plan section's lasting identity: its condition key, or (written by hand) its diagnosis / name. */
export const problemIdOf = (p: Pick<PlanProblem, "key" | "diagnosis" | "problem">) => (p.key ? p.key : `dx:${norm(p.diagnosis || p.problem).slice(0, 80)}`);
/** A goal's identity inside its section: its wording (an edited goal starts a new history). */
export const goalIdOf = (problemId: string, goal: string) => `${problemId}|${norm(goal).slice(0, 160)}`;

/** Goal checks sent in with a call note: only well-formed ones, trimmed, at most 80. */
export function cleanGoalChecks(raw: unknown): GoalCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: GoalCheck[] = [];
  const seen = new Set<string>();
  for (const r of raw.slice(0, 120)) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    const status = GOAL_STATUSES.find((s) => s === x.status);
    const problemId = typeof x.problemId === "string" ? x.problemId.slice(0, 120) : "";
    const goal = typeof x.goal === "string" ? x.goal.trim().slice(0, 600) : "";
    if (!status || !problemId || !goal) continue;
    const goalId = goalIdOf(problemId, goal);
    if (seen.has(goalId)) continue;
    seen.add(goalId);
    out.push({ problemId, goalId, problem: typeof x.problem === "string" ? x.problem.trim().slice(0, 400) : "", goal, status, value: typeof x.value === "string" ? x.value.trim().slice(0, 120) : "" });
    if (out.length >= 80) break;
  }
  return out;
}

export interface GoalPoint { status: GoalStatus; value: string; at: string }
export interface GoalProgress {
  /** Newest first, at most `keep`. */
  history: GoalPoint[];
  latest: GoalPoint | null;
  /** How many of the latest checks in a row were "not yet". */
  notYetStreak: number;
  /** Not yet NOT_YET_FLAG calls in a row: bring it to the provider. */
  flag: boolean;
}

/** Each goal's history from the call notes (any order; each note = one call). */
export function goalProgress(notes: { at: Date | string; checks: GoalCheck[] }[], keep = 6): Record<string, GoalProgress> {
  const sorted = [...notes].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const all = new Map<string, GoalPoint[]>();
  for (const n of sorted) {
    const at = new Date(n.at).toISOString();
    for (const c of n.checks) {
      const list = all.get(c.goalId) ?? [];
      list.push({ status: c.status, value: c.value, at });
      all.set(c.goalId, list);
    }
  }
  const out: Record<string, GoalProgress> = {};
  for (const [id, list] of Array.from(all)) {
    let streak = 0;
    for (const p of list) { if (p.status !== "not_yet") break; streak++; }
    out[id] = { history: list.slice(0, keep), latest: list[0] ?? null, notYetStreak: streak, flag: streak >= NOT_YET_FLAG };
  }
  return out;
}

/** The plan's goals with their latest result, for the summary line ("5 of 8 goals on track"). */
export function planGoalSummary(problems: PlanProblem[], progress: Record<string, GoalProgress>) {
  let total = 0, checked = 0, onTrack = 0, met = 0, notYet = 0, flagged = 0;
  for (const p of problems) {
    const pid = problemIdOf(p);
    for (const g of p.goals) {
      if (!g.trim()) continue;
      total++;
      const pr = progress[goalIdOf(pid, g)];
      if (!pr?.latest) continue;
      checked++;
      if (pr.latest.status === "on_track") onTrack++;
      else if (pr.latest.status === "met") met++;
      else notYet++;
      if (pr.flag) flagged++;
    }
  }
  return { total, checked, onTrack, met, notYet, flagged };
}

// ---------------------------------------------------------------------------
// What changed since the provider signed
// ---------------------------------------------------------------------------

export interface SectionChange {
  title: string;
  kind: "added" | "removed" | "changed";
  fields: { label: string; added: string[]; removed: string[] }[];
}
export interface PlanChanges { sections: SectionChange[]; general: { label: string; before: string; after: string }[] }

type PlanLike = { problems: PlanProblem[]; general: PlanGeneral };
const lines = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);

/** The differences between the signed copy and the plan as it is now (section by section, line by line). */
export function planChanges(signed: PlanLike, now: PlanLike): PlanChanges {
  const sections: SectionChange[] = [];
  const before = new Map(signed.problems.map((p) => [problemIdOf(p), p]));
  const after = new Map(now.problems.map((p) => [problemIdOf(p), p]));
  const titleOf = (p: PlanProblem) => p.problem || p.diagnosis || "Problem";
  for (const p of now.problems) {
    const id = problemIdOf(p);
    const old = before.get(id);
    if (!old) { sections.push({ kind: "added", title: titleOf(p), fields: [] }); continue; }
    const fields: SectionChange["fields"] = [];
    const single = (label: string, a: string, b: string) => { if (a.trim() !== b.trim()) fields.push({ label, added: b.trim() ? [b.trim()] : [], removed: a.trim() ? [a.trim()] : [] }); };
    single("Problem", old.problem, p.problem);
    single(PLAN_FIELD_LABELS.expectedOutcome, old.expectedOutcome, p.expectedOutcome);
    for (const f of PLAN_LIST_FIELDS) {
      const o = lines(old[f]), n = lines(p[f]);
      const added = n.filter((x) => !o.includes(x)), removed = o.filter((x) => !n.includes(x));
      if (added.length || removed.length) fields.push({ label: PLAN_FIELD_LABELS[f], added, removed });
    }
    if (fields.length) sections.push({ kind: "changed", title: titleOf(p), fields });
  }
  for (const p of signed.problems) if (!after.has(problemIdOf(p))) sections.push({ kind: "removed", title: titleOf(p), fields: [] });
  const general: PlanChanges["general"] = [];
  for (const k of Object.keys(GENERAL_LABELS) as (keyof PlanGeneral)[]) {
    const a = (signed.general?.[k] ?? "").trim(), b = (now.general?.[k] ?? "").trim();
    if (a !== b) general.push({ label: GENERAL_LABELS[k], before: a, after: b });
  }
  return { sections, general };
}

/** When the yearly provider review is due (a year after the last signature). */
export function reviewDueOf(signedAt: Date | string | null | undefined): string | null {
  if (!signedAt) return null;
  const d = new Date(signedAt);
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}
