// "My progress" in the top bar: a few numbers per employee for today, picked by role.
// Counts only (no patient details), so every role can see their own.

export type MetricKey =
  | "calls" | "talk" | "booked" | "missed"
  | "tasks_done" | "tasks_left" | "hours"
  | "care_calls" | "ccm_month"
  | "checkins" | "roomed"
  | "seen" | "waiting"
  | "ready_to_bill" | "billed_month"
  | "practice_visits" | "practice_calls" | "practice_ccm";

export interface Metric {
  key: MetricKey;
  label: string;
  value: number;
  /** Formatted value when it isn't a plain count ("2h 15m"). */
  display?: string;
  /** Target to show progress against: an admin-set daily goal, a monthly goal, or today's schedule. */
  goal?: number | null;
  goalLabel?: string;
  /** Average on this person's active days over the last 30 days (for comparison when there's no goal). */
  usual?: number | null;
  hint?: string;
  href?: string;
}

export interface MyMetrics {
  date: string;
  role: string;
  metrics: Metric[];
  /** Metrics an admin can set a daily goal for, for this role. */
  goalKeys: MetricKey[];
}

/** Daily goals an admin can set, per role. Stored in appSettings "daily_goals". */
export const GOAL_METRICS: Partial<Record<MetricKey, string>> = {
  calls: "Calls",
  booked: "Appointments booked",
  care_calls: "Care calls completed",
  checkins: "Patients checked in",
  roomed: "Patients roomed",
  tasks_done: "Tasks done",
};
export type DailyGoals = Partial<Record<string, Partial<Record<MetricKey, number>>>>;

/** Which goals make sense for which role (the goals dialog shows only these). */
export const ROLE_GOAL_KEYS: Record<string, MetricKey[]> = {
  staff: ["care_calls", "calls", "booked", "tasks_done"],
  front_desk: ["calls", "booked", "checkins", "tasks_done"],
  office_manager: ["calls", "booked", "checkins", "tasks_done"],
  medical_assistant: ["roomed", "tasks_done"],
  provider: ["tasks_done"],
  billing: ["tasks_done"],
  admin: ["tasks_done"],
};

export const ROLE_METRIC_LABELS: Record<string, string> = {
  office_manager: "Office managers",
  staff: "Care coordinators",
  front_desk: "Front desk",
  medical_assistant: "Medical assistants",
  provider: "Providers",
  billing: "Billing",
  admin: "Admins",
};

/** Share of the target reached, 0–1 (null when there's nothing to compare to). */
export function progressOf(m: Pick<Metric, "value" | "goal" | "usual">): number | null {
  const target = m.goal ?? m.usual ?? null;
  if (!target || target <= 0) return null;
  return Math.max(0, Math.min(1, m.value / target));
}

/** Average per active day (days with at least one), ignoring today. Null with fewer than 3 active days. */
export function usualPerDay(countsByDay: Map<string, number>, today: string): number | null {
  const days = Array.from(countsByDay.entries()).filter(([d, n]) => d !== today && n > 0);
  if (days.length < 3) return null;
  return Math.round(days.reduce((s, [, n]) => s + n, 0) / days.length);
}

/** Weekdays (Mon–Fri) from `date` to the end of its month, including `date`. */
export function weekdaysLeftInMonth(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  let n = 0;
  for (let day = d!; day <= last; day++) {
    const wd = new Date(Date.UTC(y!, m! - 1, day)).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

export function fmtMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** The three numbers shown in the top bar for each role, most important first. */
export const ROLE_PRIMARY: Record<string, MetricKey[]> = {
  staff: ["care_calls", "ccm_month", "calls"],
  front_desk: ["calls", "booked", "checkins"],
  office_manager: ["calls", "booked", "checkins"],
  medical_assistant: ["roomed", "tasks_done", "hours"],
  provider: ["seen", "waiting", "tasks_left"],
  billing: ["ready_to_bill", "billed_month", "tasks_left"],
  admin: ["practice_visits", "practice_calls", "practice_ccm"],
};

/** Put the role's top-bar metrics first (in order), keep the rest as they came. */
export function orderMetrics(role: string, metrics: Metric[]): Metric[] {
  const primary = ROLE_PRIMARY[role] ?? [];
  const rank = (k: MetricKey) => { const i = primary.indexOf(k); return i < 0 ? primary.length : i; };
  return metrics.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m.key) - rank(b.m.key) || a.i - b.i).map((x) => x.m);
}
