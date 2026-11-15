import { can } from "./workspace";

/**
 * The menu pages that can show a number bubble ("this many are waiting") for a role.
 * Each follows who can really open that page and act on it there:
 *  - Website bookings opens only for people who also handle the patient inboxes;
 *  - filing finished patient forms is office work, so providers get no bubble for it;
 *  - Refill Requests / Escalations are for providers and admins; Follow-ups for admins, front desk and MAs.
 */
export function navCountPaths(role: string): string[] {
  if (!can(role, "tasks")) return [];
  const out = ["/my-work"];
  if (can(role, "bookings") && can(role, "emailTriage")) out.push("/bookings");
  if (can(role, "emailTriage")) out.push("/faxes", "/patient-emails");
  if (can(role, "documents")) out.push("/documents");
  if (can(role, "intakeForms") && role !== "provider") out.push("/intake-forms");
  if (role === "admin" || role === "provider") out.push("/refill-requests", "/escalations");
  if (role === "admin" || role === "front_desk" || role === "medical_assistant") out.push("/follow-ups");
  return out;
}

/**
 * The side menu, per person: starred pages ("My shortcuts") and folded sections.
 * Saved on the person's account so the menu looks the same on any computer.
 */
export interface NavPrefs {
  /** Menu paths the person starred, in the order they starred them (e.g. "/faxes"). */
  shortcuts: string[];
  /** Section names the person folded shut (e.g. "Admin"). */
  folded: string[];
}

export const NAV_PREFS_MAX_SHORTCUTS = 12;
export const NAV_PREFS_MAX_FOLDED = 20;
/** The section that holds the starred pages. */
export const NAV_SHORTCUTS_SECTION = "My shortcuts";

const PATH_RE = /^\/[a-z0-9][a-z0-9/-]{0,59}$/;

function cleanList(value: unknown, ok: (s: string) => boolean, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!ok(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Whatever was stored (or sent) → a safe, de-duplicated NavPrefs. Never throws. */
export function cleanNavPrefs(value: unknown): NavPrefs {
  const v = (value && typeof value === "object" ? value : {}) as { shortcuts?: unknown; folded?: unknown };
  return {
    shortcuts: cleanList(v.shortcuts, (s) => PATH_RE.test(s), NAV_PREFS_MAX_SHORTCUTS),
    folded: cleanList(v.folded, (s) => s.length > 0 && s.length <= 40, NAV_PREFS_MAX_FOLDED),
  };
}
