// CCM assigners (2026-10-05, the practice's choice: Mai Ismail): named people who hand out CCM patients to
// the coordinators the way an admin does (Staff Assignment: assign, re-assign, auto-balance), whatever their
// role. Admins always can. Set by name with the IAM-only "ccm-assigners" job.
import { eq, ne } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, users } from "../drizzle/schema";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const KEY = "ccm_assigners";

export async function ccmAssignerIds(): Promise<number[]> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY)).limit(1);
  const ids = (row?.value as { userIds?: unknown } | undefined)?.userIds;
  return Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}

/** One of the named assigners (not counting admins, who always can). */
export async function isCcmAssigner(userId: number): Promise<boolean> {
  return (await ccmAssignerIds()).includes(userId);
}

export async function canAssignCcm(user: { id: number; role: string }): Promise<boolean> {
  return user.role === "admin" || isCcmAssigner(user.id);
}

/** IAM-only job: set who assigns CCM patients, by name (the whole list). Dry run unless apply. */
export async function ccmAssignersJob(input: { names: string[]; apply: boolean }) {
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
  const current = await ccmAssignerIds();
  if (problems.length || !input.apply) return { wouldSet: picked.map((p) => `${p.name} (${p.role})`), problems, currentIds: current };
  const value = { userIds: picked.map((p) => p.id) };
  await d.insert(appSettings).values({ key: KEY, value }).onDuplicateKeyUpdate({ set: { value } });
  return { set: picked.map((p) => `${p.name} (${p.role})`) };
}
