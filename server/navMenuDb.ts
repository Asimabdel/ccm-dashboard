// The side menu, per person: starred pages ("My shortcuts") and folded sections.
// Kept with the other per-person settings (appSettings, one row per person), like the bell's on/off switches.
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings } from "../drizzle/schema";
import { cleanNavPrefs, type NavPrefs } from "../shared/navMenu";

const prefKey = (userId: number) => `nav_prefs:${userId}`;

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export async function getNavPrefs(userId: number): Promise<NavPrefs> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, prefKey(userId))).limit(1);
  return cleanNavPrefs(row?.value);
}

export async function setNavPrefs(userId: number, prefs: unknown): Promise<NavPrefs> {
  const clean = cleanNavPrefs(prefs);
  await (await db()).insert(appSettings).values({ key: prefKey(userId), value: clean, updatedByUserId: userId })
    .onDuplicateKeyUpdate({ set: { value: clean, updatedByUserId: userId } });
  return clean;
}
