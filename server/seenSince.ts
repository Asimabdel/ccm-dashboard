// The start date for Program approvals and the Testing tab: only patients seen on or after it are
// considered (the practice chose on 2026-10-01 to "start 2 weeks ago and go on from there").
// Visits after the date keep counting as they happen. Admins can move the date.
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings } from "../drizzle/schema";
import { DEFAULT_SEEN_SINCE } from "../shared/programRules";

const KEY = "eligibility_seen_since";

export async function getSeenSince(): Promise<string> {
  const d = await getDb();
  if (!d) return DEFAULT_SEEN_SINCE;
  const [row] = await d.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY)).limit(1);
  const date = (row?.value as { date?: unknown } | undefined)?.date;
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : DEFAULT_SEEN_SINCE;
}

export async function setSeenSince(userId: number, date: string) {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  const value = { date };
  await d.insert(appSettings).values({ key: KEY, value, updatedByUserId: userId }).onDuplicateKeyUpdate({ set: { value, updatedByUserId: userId } });
  return { date };
}
