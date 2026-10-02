// Internal messages: rules shared by the server and the page (mentions, reactions, quick replies,
// and who's in today from Workforce).
import { fmtTime, timeToMinutes } from "./workforce";

/** The reactions on offer (a quick acknowledgement without typing a reply). */
export const REACTIONS = ["👍", "✅", "🙏", "❤️", "😂"] as const;
export type Reaction = (typeof REACTIONS)[number];

/** One-tap replies (the ⚡ menu, and under a "patient is ready" message). */
export const QUICK_REPLIES = ["On my way", "5 minutes", "Got it, thanks", "Patient is here", "Room is ready", "Can you call me?"] as const;
export const FLOW_QUICK_REPLIES = ["On my way", "5 minutes", "Got it"] as const;

/** How someone is @mentioned: their name without a note in brackets ("Rosa Diaz (MA)" → "Rosa Diaz"). */
export function mentionName(name: string | null | undefined): string {
  return (name ?? "").replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Which people a message @mentions ("@Rosa Diaz", any capitalisation, not part of a longer word). */
export function findMentions<T extends { id: number; name: string | null }>(text: string, people: T[]): number[] {
  if (!text.includes("@")) return [];
  const out = new Set<number>();
  for (const p of people) {
    const n = mentionName(p.name);
    if (n.length < 2) continue;
    if (new RegExp(`(^|[^\\w@])@${escapeRe(n)}(?![\\w])`, "i").test(text)) out.add(p.id);
  }
  return Array.from(out);
}

/** Split a message into plain text and @mention pieces (for highlighting). */
export function splitMentions(text: string, names: string[]): { text: string; mention: boolean }[] {
  const ns = names.map(mentionName).filter((n) => n.length >= 2).sort((a, b) => b.length - a.length);
  if (!ns.length || !text.includes("@")) return [{ text, mention: false }];
  const re = new RegExp(`@(?:${ns.map(escapeRe).join("|")})(?![\\w])`, "gi");
  const out: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const m of Array.from(text.matchAll(re))) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), mention: false });
    out.push({ text: m[0], mention: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: false });
  return out;
}

/** "Smith, James" or "James Smith" → "James S." (a patient in a "ready" message; the chip has the full name). */
export function shortPatientName(name: string): string {
  const s = name.trim();
  const [first, last] = s.includes(",") ? [s.split(",")[1]!.trim().split(/\s+/)[0] ?? "", s.split(",")[0]!.trim()] : [s.split(/\s+/)[0] ?? "", s.split(/\s+/).slice(-1)[0] ?? ""];
  if (!first) return s;
  return last && last !== first ? `${first} ${last[0]!.toUpperCase()}.` : first;
}

// ---------------------------------------------------------------------------
// Who's in today (from the time clock, shifts and time off)
// ---------------------------------------------------------------------------

export type PresenceStatus = "in" | "scheduled" | "away" | "off" | "none";
export interface Presence { status: PresenceStatus; label: string }

export function presenceFor(p: {
  clockedIn: boolean;
  clockedOutToday: boolean;
  timeOff: boolean;
  /** Today's shifts (scheduled or called out). */
  shifts: { startTime: string; endTime: string; status: string }[];
  usesTimeClock: boolean;
  /** Minutes since clinic-local midnight. */
  now: number;
}): Presence {
  if (p.clockedIn) return { status: "in", label: "On the clock" };
  if (p.timeOff) return { status: "off", label: "On time off today" };
  const working = p.shifts.filter((s) => s.status !== "called_out");
  if (!working.length) return p.shifts.length ? { status: "off", label: "Out today" } : { status: "none", label: "Not scheduled today" };
  const start = working.map((s) => s.startTime).sort()[0]!;
  const end = working.map((s) => s.endTime).sort().slice(-1)[0]!;
  const hours = `${fmtTime(start)}–${fmtTime(end)}`;
  if (p.now >= timeToMinutes(end)) return { status: "away", label: "Done for today" };
  if (p.now < timeToMinutes(start)) return { status: "scheduled", label: `In at ${fmtTime(start)}` };
  // During their hours: people on the time clock are "in" only once they clock in.
  if (p.usesTimeClock) return p.clockedOutToday ? { status: "away", label: "Clocked out" } : { status: "scheduled", label: `Scheduled ${hours}, not clocked in` };
  return { status: "in", label: `Working until ${fmtTime(end)}` };
}
