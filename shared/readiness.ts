// Patient 360 → "Ready for the next visit?": one list of what is done and what is still missing
// (consent, insurance, screenings, in-office tests, care plan), each with a one-click fix.
// Every rule here comes from a part of MyPCP that already exists (Patient forms, Availity, the Testing
// guidelines and in-office test criteria, care plans, Master Billing's high-deductible flag); nothing
// here is a clinical decision. Pure: the server builds the list, the tests check it.

export type ReadyState = "done" | "todo" | "waiting" | "info";
/** What the item's button does on Patient 360. */
export type ReadyFix = "send_forms" | "insurance_check" | "insurance_tab" | "testing_tab" | "careplan_tab" | "forms_tab";

export interface ReadyItem {
  id: string;
  state: ReadyState;
  title: string;
  detail: string;
  fix?: ReadyFix | null;
  fixLabel?: string | null;
  /** send_forms: which forms to tick when the Send forms window opens. */
  formKeys?: string[];
}

export interface ReadyPacket {
  status: string;
  expired: boolean;
  sentAt: Date | string | null;
  completedAt: Date | string | null;
  createdAt: Date | string | null;
  forms: { key: string; signed: boolean; declined: boolean }[];
}

export interface ReadinessInput {
  /** YYYY-MM-DD (clinic time). */
  today: string;
  /** Patient forms (null = this person can't see forms). Packets newest first. */
  forms: { packets: ReadyPacket[]; consentKeys: string[] } | null;
  /** The Testing guidelines for this person (null = not available to this person, or not for this patient). */
  testing: { key: string; label: string; state: string; lastDone: string | null; dueOn: string | null }[] | null;
  /** In-office tests that qualify (ABI-Q, PFT, RMR). */
  officeTests: { label: string; state: string; scheduledFor: string | null; lastDone: string | null }[] | null;
  /** Availity, only when it is connected for real (not demo). */
  insurance: { latest: { status: string; createdAt: Date | string; active: boolean | null; statusText: string | null; payerName: string | null } | null; onFile: boolean } | null;
  highDeductible: { visits: number } | null;
  /** CCM care plan (roster patients in CCM, for the roles that handle care plans). */
  carePlan: { status: "none" | "draft" | "changed" | "signed"; signedByName: string | null; signedAt: Date | string | null } | null;
}

export const PHQ9_FORM = "phq9";
const OPEN_PACKET = new Set(["waiting", "opened", "in_progress"]);
const INSURANCE_FRESH_DAYS = 30;

const ymd = (d: Date | string | null | undefined) => (!d ? null : typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** "Nov 3" this year, "Nov 3, 2025" otherwise. */
export function shortDay(d: Date | string | null | undefined, today: string): string {
  const s = ymd(d);
  if (!s) return "";
  const dt = new Date(`${s}T12:00:00Z`);
  const sameYear = s.slice(0, 4) === today.slice(0, 4);
  return dt.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

const listWords = (xs: string[], max = 3) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} +${xs.length - max} more`);

/** The newest packet that has one of these forms in it, and how that form went. */
function latestWith(packets: ReadyPacket[], keys: string[]) {
  for (const p of packets) {
    const f = p.forms.find((x) => keys.includes(x.key));
    if (f) return { p, f };
  }
  return null;
}

export function buildReadiness(x: ReadinessInput): ReadyItem[] {
  const items: ReadyItem[] = [];
  const day = (d: Date | string | null | undefined) => shortDay(d, x.today);

  // 1) The New Patient Consent (the practice's consent form with the Yes/No questions).
  if (x.forms && x.forms.consentKeys.length) {
    const hit = latestWith(x.forms.packets.filter((p) => p.status !== "cancelled"), x.forms.consentKeys);
    const signed = x.forms.packets.map((p) => ({ p, f: p.forms.find((f) => x.forms!.consentKeys.includes(f.key) && f.signed && !f.declined) })).find((r) => r.f);
    const base = { id: "consent", title: "New patient consent" };
    if (signed) items.push({ ...base, state: "done", detail: `Signed ${day(signed.p.completedAt ?? signed.p.sentAt)}` });
    else if (hit && OPEN_PACKET.has(hit.p.status) && !hit.p.expired) items.push({ ...base, state: "waiting", detail: `Sent ${day(hit.p.sentAt ?? hit.p.createdAt)} · waiting for the patient` });
    else items.push({
      ...base, state: "todo",
      detail: hit?.f.declined ? `Not signed (said no on ${day(hit.p.completedAt)})` : hit ? `Sent ${day(hit.p.sentAt ?? hit.p.createdAt)} · the link ran out` : "Not signed in MyPCP yet",
      fix: "send_forms", fixLabel: "Send it", formKeys: x.forms.consentKeys.slice(0, 1),
    });
  }

  // 2) Insurance (Availity).
  if (x.insurance) {
    const c = x.insurance.latest;
    const base = { id: "insurance", title: "Insurance check" };
    const fixCheck = x.insurance.onFile ? { fix: "insurance_check" as const, fixLabel: "Check now" } : { fix: "insurance_tab" as const, fixLabel: "Add insurance" };
    if (!c) items.push({ ...base, state: "todo", detail: x.insurance.onFile ? "Not checked yet" : "No insurance on file in MyPCP", ...fixCheck });
    else if (c.status === "pending" && ymd(c.createdAt) === x.today) items.push({ ...base, state: "waiting", detail: `Waiting for ${c.payerName ?? "the insurance company"}` });
    else if (c.status === "pending") items.push({ ...base, state: "todo", detail: `The last check never finished (${day(c.createdAt)})`, ...fixCheck });
    else if (c.status === "error") items.push({ ...base, state: "todo", detail: `The last check didn't go through (${day(c.createdAt)})`, ...fixCheck });
    else if (c.active === false) items.push({ ...base, state: "todo", detail: `Not active · checked ${day(c.createdAt)}`, fix: "insurance_tab", fixLabel: "Open Insurance" });
    else if (c.active == null) items.push({ ...base, state: "info", detail: `${c.statusText ?? "No clear answer"} · checked ${day(c.createdAt)}`, fix: "insurance_tab", fixLabel: "Open Insurance" });
    else {
      const age = daysBetween(ymd(c.createdAt)!, x.today);
      if (age > INSURANCE_FRESH_DAYS) items.push({ ...base, state: "todo", detail: `Active when checked ${day(c.createdAt)} · check again`, ...fixCheck });
      else items.push({ ...base, state: "done", detail: `Active${c.payerName ? ` · ${c.payerName}` : ""} · checked ${age === 0 ? "today" : day(c.createdAt)}` });
    }
  }

  // 3) High deductible: collect at check-in (from the payment files).
  if (x.highDeductible) {
    items.push({ id: "deductible", state: "info", title: "High deductible", detail: `Collect at check-in · applied on ${x.highDeductible.visits} visit${x.highDeductible.visits === 1 ? "" : "s"} this past year` });
  }

  // 4) Depression screening (PHQ-9), by the Testing guideline; a PHQ-9 sent back on a form counts too.
  const dep = x.testing?.find((t) => t.key === "depression");
  if (dep && dep.state !== "not_applicable") {
    const fromForm = x.forms ? x.forms.packets.find((p) => p.forms.some((f) => f.key === PHQ9_FORM && f.signed)) : undefined;
    const last = [dep.lastDone, ymd(fromForm?.completedAt)].filter((v): v is string => !!v).sort().pop() ?? null;
    const sent = x.forms ? latestWith(x.forms.packets, [PHQ9_FORM]) : null;
    const base = { id: "phq9", title: "PHQ-9 screening" };
    if (last && daysBetween(last, x.today) < 365) items.push({ ...base, state: "done", detail: `Last one ${day(last)}` });
    else if (dep.state === "declined") items.push({ ...base, state: "info", detail: "Declined this year" });
    else if (sent && OPEN_PACKET.has(sent.p.status) && !sent.p.expired && !sent.f.signed) items.push({ ...base, state: "waiting", detail: `Sent ${day(sent.p.sentAt ?? sent.p.createdAt)} · waiting for the patient` });
    else items.push({ ...base, state: "todo", detail: last ? `Due · last one ${day(last)}` : "Due · none on record", ...(x.forms ? { fix: "send_forms" as const, fixLabel: "Send to patient", formKeys: [PHQ9_FORM] } : { fix: "testing_tab" as const, fixLabel: "Open Testing" }) });
  }

  // 5) In-office tests that qualify by the practice's criteria (ABI-Q, PFT, RMR).
  for (const t of x.officeTests ?? []) {
    const base = { id: `office:${t.label}`, title: `${t.label} test` };
    if (t.state === "eligible") items.push({ ...base, state: "todo", detail: "Qualifies by the practice's criteria · not done yet", fix: "testing_tab", fixLabel: "Open Testing" });
    else if (t.state === "scheduled") items.push({ ...base, state: "waiting", detail: t.scheduledFor ? `Planned for ${day(t.scheduledFor)}` : "Planned" });
    else if (t.state === "missed") items.push({ ...base, state: "todo", detail: `Missed${t.scheduledFor ? ` on ${day(t.scheduledFor)}` : ""} · book it again`, fix: "testing_tab", fixLabel: "Open Testing" });
  }

  // 6) Other screenings and tests from the Testing guidelines.
  if (x.testing) {
    const rest = x.testing.filter((t) => t.key !== "depression");
    const due = rest.filter((t) => t.state === "due").map((t) => t.label);
    const none = rest.filter((t) => t.state === "no_record").map((t) => t.label);
    if (due.length || none.length) {
      items.push({
        id: "tests", state: "todo", title: "Screenings and tests",
        detail: [due.length ? `Due: ${listWords(due)}` : "", none.length ? `No record: ${listWords(none)}` : ""].filter(Boolean).join(" · "),
        fix: "testing_tab", fixLabel: "Open Testing",
      });
    } else if (rest.length) {
      items.push({ id: "tests", state: "done", title: "Screenings and tests", detail: "Up to date" });
    }
  }

  // 7) CCM care plan.
  if (x.carePlan) {
    const p = x.carePlan;
    const base = { id: "careplan", title: "Care plan" };
    if (p.status === "signed") items.push({ ...base, state: "done", detail: `Signed${p.signedByName ? ` by ${p.signedByName}` : ""}${p.signedAt ? ` · ${day(p.signedAt)}` : ""}` });
    else if (p.status === "draft") items.push({ ...base, state: "waiting", detail: "Waiting for the provider's signature", fix: "careplan_tab", fixLabel: "Open care plan" });
    else if (p.status === "changed") items.push({ ...base, state: "waiting", detail: "Changed since it was signed · needs the provider's signature", fix: "careplan_tab", fixLabel: "Open care plan" });
    else items.push({ ...base, state: "todo", detail: "No care plan yet", fix: "careplan_tab", fixLabel: "Open care plan" });
  }

  return items;
}
