// "Recent patients" in Find anything: the last patients each person opened on Patient 360.
// Kept on the server with the other per-person settings (appSettings, one row per person), never in the
// browser: a schedule-only patient's key carries their name and date of birth.
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { appSettings, clinics } from "../drizzle/schema";
import { isPatientKey } from "../shared/folder";
import { loadDirectory } from "./directoryDb";

export const RECENT_PATIENTS_MAX = 8;
const recentKey = (userId: number) => `recent_patients:${userId}`;

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

/** The saved list, cleaned: patient keys only, newest first, no repeats, at most 8. */
export function cleanRecentKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const k of value) {
    if (typeof k === "string" && isPatientKey(k) && !out.includes(k)) out.push(k);
    if (out.length >= RECENT_PATIENTS_MAX) break;
  }
  return out;
}

/** Put a patient at the top of this person's recent list. */
export function withRecent(list: string[], key: string): string[] {
  return cleanRecentKeys([key, ...list.filter((k) => k !== key)]);
}

async function readKeys(userId: number): Promise<string[]> {
  const [row] = await (await db()).select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, recentKey(userId))).limit(1);
  return cleanRecentKeys(row?.value);
}

/** Called when someone opens a patient's page. Never fails the page: a missed update only costs a recent entry. */
export async function rememberPatient(userId: number, key: string): Promise<void> {
  if (!isPatientKey(key)) return;
  try {
    const list = await readKeys(userId);
    if (list[0] === key) return;
    const next = withRecent(list, key);
    await (await db()).insert(appSettings).values({ key: recentKey(userId), value: next, updatedByUserId: userId })
      .onDuplicateKeyUpdate({ set: { value: next, updatedByUserId: userId } });
  } catch (e) {
    console.warn("[recent patients] could not save", e instanceof Error ? e.message : e);
  }
}

/** This person's recent patients, with what the search list shows (name, date of birth, clinic, phone). */
export async function recentPatients(userId: number) {
  const keys = await readKeys(userId);
  if (!keys.length) return [];
  const dir = await loadDirectory();
  const clinicName = new Map((await (await db()).select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));
  return keys.flatMap((k) => {
    const e = dir.get(k);
    if (!e) return [];
    return [{
      key: e.key, patientId: e.patientId, name: e.name, dob: e.dob, phone: e.phone,
      clinicName: e.clinicId ? clinicName.get(e.clinicId) ?? null : null, programs: e.programs,
    }];
  });
}
