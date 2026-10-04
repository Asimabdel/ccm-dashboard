// A personal calendar link (2026-10-04): each person can put their MyPCP shifts and approved time off into
// Google / Apple / Outlook calendar. The link carries a long random secret (staffProfiles.calendarToken); it
// shows only their own shifts (clinic and hours, nothing about patients), and resetting it kills the old one.
import { randomBytes } from "node:crypto";
import { and, eq, gte, lte } from "drizzle-orm";
import { getDb } from "./db";
import { clinics, shifts, staffProfiles, timeOffRequests } from "../drizzle/schema";
import { addDays, localDateStr } from "../shared/workforce";
import { clinicInstant } from "../shared/attendance";
import { REMOTE_LABEL } from "./workforceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

/** My calendar link's secret (null = not turned on). */
export async function myCalendarToken(userId: number): Promise<{ token: string | null; hasProfile: boolean }> {
  const [p] = await (await db()).select({ token: staffProfiles.calendarToken }).from(staffProfiles).where(eq(staffProfiles.userId, userId)).limit(1);
  return { token: p?.token ?? null, hasProfile: !!p };
}

/** Turn the link on, or make a new one (the old link stops working). */
export async function newCalendarToken(userId: number): Promise<string | null> {
  const token = randomBytes(18).toString("hex");
  const d = await db();
  const [p] = await d.select({ id: staffProfiles.id }).from(staffProfiles).where(eq(staffProfiles.userId, userId)).limit(1);
  if (!p) return null;
  await d.update(staffProfiles).set({ calendarToken: token }).where(eq(staffProfiles.id, p.id));
  return token;
}

export async function turnOffCalendar(userId: number) {
  await (await db()).update(staffProfiles).set({ calendarToken: null }).where(eq(staffProfiles.userId, userId));
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const utc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dateOnly = (s: string) => s.replace(/-/g, "");

/** The .ics for a calendar link, or null if the secret doesn't match anyone. */
export async function calendarFor(token: string): Promise<string | null> {
  if (!/^[a-f0-9]{24,40}$/.test(token)) return null;
  const d = await db();
  const [p] = await d.select({ userId: staffProfiles.userId }).from(staffProfiles).where(eq(staffProfiles.calendarToken, token)).limit(1);
  if (!p) return null;
  const today = localDateStr();
  const from = addDays(today, -14), to = addDays(today, 120);
  const [rows, off] = await Promise.all([
    d.select({ s: shifts, clinic: clinics.name }).from(shifts).leftJoin(clinics, eq(clinics.id, shifts.clinicId))
      .where(and(eq(shifts.userId, p.userId), gte(shifts.date, from), lte(shifts.date, to))),
    d.select().from(timeOffRequests).where(and(eq(timeOffRequests.userId, p.userId), eq(timeOffRequests.status, "approved"), lte(timeOffRequests.startDate, to), gte(timeOffRequests.endDate, from))),
  ]);
  const stamp = utc(new Date());
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MyPCP//Work schedule//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:MyPCP shifts", "X-PUBLISHED-TTL:PT1H", "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];
  for (const { s, clinic } of rows) {
    const place = clinic ?? REMOTE_LABEL;
    lines.push(
      "BEGIN:VEVENT", `UID:mypcp-shift-${s.id}@mypcpcare.com`, `DTSTAMP:${stamp}`,
      `DTSTART:${utc(clinicInstant(s.date, s.startTime))}`, `DTEND:${utc(clinicInstant(s.date, s.endTime))}`,
      `SUMMARY:${esc(s.status === "called_out" ? `Called out (${place})` : s.clinicId ? `Work: ${place}` : "Work: remote")}`,
      ...(s.clinicId ? [`LOCATION:${esc(place)}`] : []),
      `STATUS:${s.status === "called_out" ? "CANCELLED" : "CONFIRMED"}`, "TRANSP:OPAQUE", "END:VEVENT",
    );
  }
  for (const o of off) {
    lines.push("BEGIN:VEVENT", `UID:mypcp-off-${o.id}@mypcpcare.com`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dateOnly(o.startDate)}`, `DTEND;VALUE=DATE:${dateOnly(addDays(o.endDate, 1))}`,
      "SUMMARY:Time off", "TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
