// Assigners (2026-10-05, the practice's choice: Mai Ismail for CCM; 2026-10-19: Nusaybah for BHI): named people
// who hand out a program's patients to the coordinators the way an admin does (Staff Assignment: assign,
// re-assign, auto-balance), whatever their role. Each program has its own list; admins always can. Set by
// name with the IAM-only "ccm-assigners" / "bhi-assigners" jobs.
import { eq, ne } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, users } from "../drizzle/schema";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export type AssignProgram = "ccm" | "bhi";
export const ASSIGN_PROGRAMS: AssignProgram[] = ["ccm", "bhi"];
const KEYS: Record<AssignProgram, string> = { ccm: "ccm_assigners", bhi: "bhi_assigners" };

/** APCM follows CCM (same patients, same coordinators); only BHI has its own assigners. */
export const assignProgramOf = (program: string | null | undefined): AssignProgram => (program === "bhi" ? "bhi" : "ccm");

export async function assignerIds(program: AssignProgram): Promise<number[]> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEYS[program])).limit(1);
  const ids = (row?.value as { userIds?: unknown } | undefined)?.userIds;
  return Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}

/** The programs this person is a named assigner for (not counting admins, who always can). */
export async function assignerPrograms(userId: number): Promise<AssignProgram[]> {
  const lists = await Promise.all(ASSIGN_PROGRAMS.map(async (p) => [p, await assignerIds(p)] as const));
  return lists.filter(([, ids]) => ids.includes(userId)).map(([p]) => p);
}

export async function canAssign(user: { id: number; role: string }, program: AssignProgram): Promise<boolean> {
  return user.role === "admin" || (await assignerIds(program)).includes(user.id);
}

/** Admins, or a named assigner for any program (for the staff list behind the assignment pickers). */
export async function canAssignAny(user: { id: number; role: string }): Promise<boolean> {
  return user.role === "admin" || (await assignerPrograms(user.id)).length > 0;
}

/** IAM-only job: set who assigns a program's patients, by name (the whole list). Dry run unless apply. */
export async function assignersJob(input: { program: AssignProgram; names: string[]; apply: boolean }) {
  const d = await db();
  const people = await d.select({ id: users.id, name: users.name, role: users.role }).from(users).where(ne(users.role, "admin"));
  const picked: { id: number; name: string | null; role: string }[] = [];
  const problems: string[] = [];
  for (const n of input.names) {
    const needle = n.trim().toLowerCase();
    const hits = people.filter((u) => needle && (u.name ?? "").toLowerCase().includes(needle));
    if (hits.length === 1) picked.push(hits[0]!);
    else problems.push(`${n}: ${hits.length ? `matches ${hits.map((h) => h.name).join(", ")}` : "nobody (who isn't already an admin) by that name"}`);
  }
  const current = await assignerIds(input.program);
  const currentNames = people.filter((p) => current.includes(p.id)).map((p) => `${p.name} (${p.role})`);
  if (problems.length || !input.apply) return { program: input.program, wouldSet: picked.map((p) => `${p.name} (${p.role})`), problems, current: currentNames };
  const value = { userIds: picked.map((p) => p.id) };
  await d.insert(appSettings).values({ key: KEYS[input.program], value }).onDuplicateKeyUpdate({ set: { value } });
  return { program: input.program, set: picked.map((p) => `${p.name} (${p.role})`) };
}
