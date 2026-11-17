import { describe, expect, it } from "vitest";
import { buildReadiness, shortDay, type ReadinessInput, type ReadyPacket } from "../shared/readiness";

// Made-up patient data only.
const today = "2026-11-16";
const none: ReadinessInput = { today, forms: null, testing: null, officeTests: null, insurance: null, highDeductible: null, carePlan: null };
const packet = (p: Partial<ReadyPacket> & { forms: ReadyPacket["forms"] }): ReadyPacket => ({ status: "completed", expired: false, sentAt: "2026-09-30T15:00:00Z", completedAt: "2026-09-30T16:00:00Z", createdAt: "2026-09-30T15:00:00Z", ...p });
const byId = (items: ReturnType<typeof buildReadiness>, id: string) => items.find((x) => x.id === id);

describe("Ready for the next visit?", () => {
  it("shows nothing a person isn't allowed to see", () => {
    expect(buildReadiness(none)).toEqual([]);
  });

  it("New patient consent: signed, waiting, or send it", () => {
    const consentKeys = ["doc:7"];
    const signed = buildReadiness({ ...none, forms: { consentKeys, packets: [packet({ forms: [{ key: "doc:7", signed: true, declined: false }] })] } });
    expect(byId(signed, "consent")).toMatchObject({ state: "done", detail: "Signed Sep 30" });

    const waiting = buildReadiness({ ...none, forms: { consentKeys, packets: [packet({ status: "opened", completedAt: null, forms: [{ key: "doc:7", signed: false, declined: false }] })] } });
    expect(byId(waiting, "consent")).toMatchObject({ state: "waiting" });

    const expired = buildReadiness({ ...none, forms: { consentKeys, packets: [packet({ status: "waiting", expired: true, completedAt: null, forms: [{ key: "doc:7", signed: false, declined: false }] })] } });
    expect(byId(expired, "consent")).toMatchObject({ state: "todo", fix: "send_forms", formKeys: ["doc:7"] });

    const never = buildReadiness({ ...none, forms: { consentKeys, packets: [] } });
    expect(byId(never, "consent")).toMatchObject({ state: "todo", detail: "Not signed in MyPCP yet", fixLabel: "Send it" });

    // No consent form set up in the library: no row at all.
    expect(byId(buildReadiness({ ...none, forms: { consentKeys: [], packets: [] } }), "consent")).toBeUndefined();
  });

  it("Insurance: fresh and active is done; old, missing or failed checks get a fix", () => {
    const at = (createdAt: string, active: boolean | null, status = "complete") => ({ ...none, insurance: { onFile: true, latest: { status, createdAt, active, statusText: active === null ? "Unclear" : null, payerName: "Sample Health" } } });
    expect(byId(buildReadiness(at("2026-11-15T10:00:00Z", true)), "insurance")).toMatchObject({ state: "done", detail: "Active · Sample Health · checked Nov 15" });
    expect(byId(buildReadiness(at("2026-11-16T10:00:00Z", true)), "insurance")?.detail).toContain("checked today");
    expect(byId(buildReadiness(at("2026-08-12T10:00:00Z", true)), "insurance")).toMatchObject({ state: "todo", fix: "insurance_check", fixLabel: "Check now" });
    expect(byId(buildReadiness(at("2026-11-15T10:00:00Z", false)), "insurance")).toMatchObject({ state: "todo", fix: "insurance_tab" });
    expect(byId(buildReadiness(at("2026-11-15T10:00:00Z", null, "error")), "insurance")).toMatchObject({ state: "todo", fix: "insurance_check" });
    expect(byId(buildReadiness(at("2026-11-16T10:00:00Z", null, "pending")), "insurance")).toMatchObject({ state: "waiting" });
    // A check from an earlier day that never got an answer: check again.
    expect(byId(buildReadiness(at("2026-11-10T10:00:00Z", null, "pending")), "insurance")).toMatchObject({ state: "todo", fix: "insurance_check", detail: "The last check never finished (Nov 10)" });
    // Nothing on file: add it on the Insurance tab (no typing in the checklist).
    expect(byId(buildReadiness({ ...none, insurance: { onFile: false, latest: null } }), "insurance")).toMatchObject({ state: "todo", fix: "insurance_tab", fixLabel: "Add insurance" });
  });

  it("PHQ-9 follows the Testing guideline, and a PHQ-9 sent back on a form counts", () => {
    const dep = (lastDone: string | null, state = "due") => [{ key: "depression", label: "Depression screening (PHQ)", state, lastDone, dueOn: null }];
    expect(byId(buildReadiness({ ...none, testing: dep("2026-07-02", "current") }), "phq9")).toMatchObject({ state: "done", detail: "Last one Jul 2" });
    // Due, and this person can send forms: the fix ticks the PHQ-9.
    expect(byId(buildReadiness({ ...none, testing: dep("2025-07-02"), forms: { consentKeys: [], packets: [] } }), "phq9")).toMatchObject({ state: "todo", detail: "Due · last one Jul 2, 2025", fix: "send_forms", formKeys: ["phq9"] });
    // Done on a form this month (the Testing record doesn't know yet).
    const fromForm = { consentKeys: [], packets: [packet({ completedAt: "2026-11-10T16:00:00Z", forms: [{ key: "phq9", signed: true, declined: false }] })] };
    expect(byId(buildReadiness({ ...none, testing: dep(null, "no_record"), forms: fromForm }), "phq9")).toMatchObject({ state: "done", detail: "Last one Nov 10" });
    // Sent and not back yet.
    const sent = { consentKeys: [], packets: [packet({ status: "waiting", completedAt: null, sentAt: "2026-11-14T16:00:00Z", forms: [{ key: "phq9", signed: false, declined: false }] })] };
    expect(byId(buildReadiness({ ...none, testing: dep(null, "no_record"), forms: sent }), "phq9")).toMatchObject({ state: "waiting", detail: "Sent Nov 14 · waiting for the patient" });
    // Not for this patient (e.g. a child): no row.
    expect(byId(buildReadiness({ ...none, testing: [] }), "phq9")).toBeUndefined();
  });

  it("In-office tests, other screenings, high deductible and the care plan", () => {
    const items = buildReadiness({
      ...none,
      officeTests: [{ label: "ABI-Q", state: "eligible", scheduledFor: null, lastDone: null }, { label: "PFT", state: "scheduled", scheduledFor: "2026-11-18", lastDone: null }],
      testing: [
        { key: "a1c", label: "A1c", state: "due", lastDone: "2026-01-02", dueOn: "2026-07-02" },
        { key: "eye", label: "Diabetic eye exam", state: "no_record", lastDone: null, dueOn: null },
        { key: "lipid", label: "Lipid panel", state: "current", lastDone: "2026-10-01", dueOn: null },
      ],
      highDeductible: { visits: 2 },
      carePlan: { status: "draft", signedByName: null, signedAt: null },
    });
    expect(byId(items, "office:ABI-Q")).toMatchObject({ state: "todo", fix: "testing_tab" });
    expect(byId(items, "office:PFT")).toMatchObject({ state: "waiting", detail: "Planned for Nov 18" });
    expect(byId(items, "tests")).toMatchObject({ state: "todo", detail: "Due: A1c · No record: Diabetic eye exam" });
    expect(byId(items, "deductible")).toMatchObject({ state: "info", title: "High deductible" });
    expect(byId(items, "careplan")).toMatchObject({ state: "waiting", fix: "careplan_tab" });
    expect(byId(buildReadiness({ ...none, carePlan: { status: "signed", signedByName: "Dr. Sample", signedAt: "2026-10-03T12:00:00Z" } }), "careplan")).toMatchObject({ state: "done", detail: "Signed by Dr. Sample · Oct 3" });
    expect(byId(buildReadiness({ ...none, testing: [{ key: "lipid", label: "Lipid panel", state: "current", lastDone: "2026-10-01", dueOn: null }] }), "tests")).toMatchObject({ state: "done" });
  });

  it("writes dates the short way", () => {
    expect(shortDay("2026-03-04", today)).toBe("Mar 4");
    expect(shortDay(new Date("2025-12-31T12:00:00Z"), today)).toBe("Dec 31, 2025");
    expect(shortDay(null, today)).toBe("");
  });
});
