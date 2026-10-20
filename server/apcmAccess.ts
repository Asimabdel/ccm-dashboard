// APCM access (2026-10-20, the practice's choice: Walid): named people who work the APCM tab like a care
// coordinator (see the list, open a patient, update APCM enrollment / consent), whatever their role. Admins
// and care coordinators always can. Bulk actions (standard care plans, imports) stay with admins and
// coordinators. Set by name with the IAM-only "apcm-access" job.
import { eq, inArray, notInArray } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, users } from "../drizzle/schema";

const KEY = "apcm_access";
/** Roles that have the APCM tab anyway. */
export const APCM_ROLES = ["admin", "staff"] as const;

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export async function apcmAccessIds(): Promise<number[]> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY)).limit(1);
  const ids = (row?.value as { userIds?: unknown } | undefined)?.userIds;
  return Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}

/** A named APCM person (not counting admins and coordinators, who always have it). */
export async function hasNamedApcmAccess(userId: number): Promise<boolean> {
  return (await apcmAccessIds()).includes(userId);
}

/** IAM-only job: set who else gets the APCM tab, by name (the whole list). Dry run unless apply. */
export async function apcmAccessJob(input: { names: string[]; apply: boolean }) {
  const d = await db();
  const people = await d.select({ id: users.id, name: users.name, role: users.role }).from(users).where(notInArray(users.role, ["admin", "staff", "user"]));
  const picked: { id: number; name: string | null; role: string }[] = [];
  const problems: string[] = [];
  for (const n of input.names) {
    const needle = n.trim().toLowerCase();
    const hits = people.filter((u) => needle && (u.name ?? "").toLowerCase().includes(needle));
    if (hits.length === 1) picked.push(hits[0]!);
    else problems.push(`${n}: ${hits.length ? `matches ${hits.map((h) => `${h.name} (${h.role})`).join(", ")}` : "nobody by that name who doesn't already have APCM (admins and care coordinators do)"}`);
  }
  const current = await apcmAccessIds();
  const currentNames = current.length ? (await d.select({ name: users.name, role: users.role }).from(users).where(inArray(users.id, current))).map((p) => `${p.name} (${p.role})`) : [];
  if (problems.length || !input.apply) return { wouldSet: picked.map((p) => `${p.name} (${p.role})`), problems, current: currentNames };
  const value = { userIds: picked.map((p) => p.id) };
  await d.insert(appSettings).values({ key: KEY, value }).onDuplicateKeyUpdate({ set: { value } });
  return { set: picked.map((p) => `${p.name} (${p.role})`) };
}
