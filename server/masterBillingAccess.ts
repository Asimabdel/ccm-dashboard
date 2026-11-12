// Master Billing access (2026-11-11, the owner's choice: "only me"): the tab is open only to the
// admins named here, not to every admin. Set by name with the IAM-only "master-billing-access" Lambda
// job (the whole list each time). An empty list = nobody sees it.
import { eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, users } from "../drizzle/schema";

const KEY = "master_billing_access";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export async function masterBillingIds(): Promise<number[]> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY)).limit(1);
  const ids = (row?.value as { userIds?: unknown } | undefined)?.userIds;
  return Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}

/** Their own login is an admin (not previewing another role) and they're on the list. */
export async function hasMasterBilling(user: { id: number; role: string; realRole?: string | null }): Promise<boolean> {
  if (user.role !== "admin") return false;
  return (await masterBillingIds()).includes(user.id);
}

/** IAM-only job: set who has Master Billing, by name (admins only). Dry run unless apply. */
export async function masterBillingAccessJob(input: { names: string[]; apply: boolean }) {
  const d = await db();
  const admins = await d.select({ id: users.id, name: users.name }).from(users).where(eq(users.role, "admin"));
  const picked: { id: number; name: string | null }[] = [];
  const problems: string[] = [];
  for (const n of input.names) {
    const needle = n.trim().toLowerCase();
    const hits = admins.filter((u) => needle && (u.name ?? "").toLowerCase().includes(needle));
    if (hits.length === 1) picked.push(hits[0]!);
    else problems.push(`${n}: ${hits.length ? `matches ${hits.map((h) => h.name).join(", ")}` : "no admin by that name"}`);
  }
  const current = await masterBillingIds();
  const currentNames = current.length ? (await d.select({ name: users.name }).from(users).where(inArray(users.id, current))).map((p) => p.name) : [];
  if (problems.length || !input.apply) return { wouldSet: picked.map((p) => p.name), problems, current: currentNames };
  const value = { userIds: picked.map((p) => p.id) };
  await d.insert(appSettings).values({ key: KEY, value }).onDuplicateKeyUpdate({ set: { value } });
  return { set: picked.map((p) => p.name) };
}
