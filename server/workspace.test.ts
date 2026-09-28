import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import {
  can,
  checkFlowTransition,
  clinicLocalToUtc,
  evaluateOpportunities,
  evaluateScheduleOpportunities,
  evaluateScheduleFill,
  providerActivity,
  type FillVisit,
  findOpenings,
  mapScheduleStatus,
  nameKey,
  nextClinicDay,
  parseDateValue,
  parseScheduleCsv,
  parseTimeValue,
  type OpportunityPatient,
  type ScheduleVisit,
} from "../shared/workspace";
import { appointmentKey } from "./workspaceDb";
import { formatPhone, mapCallLogRecord, mapCallStat, normalizePhone, parseRingCentralCall } from "../shared/phone";
import { extractPhones, matchEmailSender, parseFromHeader, stripQuotedText } from "../shared/email";
import { ageOn, evaluateTesting, parseSex, recognizeTest } from "../shared/testing";
import { PLANS, checkInsurance, patientLine } from "../shared/insurance";
import { orderMetrics, progressOf, usualPerDay, weekdaysLeftInMonth } from "../shared/metrics";
import { isFaxEmail, matchFaxPatient, parseFaxMeta, parseFaxReading } from "../shared/fax";
import { chartLine, patientInfo, patientOf, sectionType } from "../shared/fhir";
import { clinicForLocation, parseBookingEmail, parsePreferred } from "../shared/booking";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function ctxFor(role: string): TrpcContext {
  const user: AuthenticatedUser = {
    id: 99,
    openId: "ws-test",
    email: "ws@example.com",
    name: "Workspace Test",
    loginMethod: "manus",
    role: role as AuthenticatedUser["role"],
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return { user, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("workspace capabilities", () => {
  it("keeps MAs out of Opportunity Finder, schedule import and full patient records", () => {
    expect(can("medical_assistant", "flowView")).toBe(true);
    expect(can("medical_assistant", "tasks")).toBe(true);
    expect(can("medical_assistant", "opportunitiesView")).toBe(false);
    expect(can("medical_assistant", "scheduleImport")).toBe(false);
    expect(can("medical_assistant", "patientFull")).toBe(false);
    expect(can("medical_assistant", "assignTasks")).toBe(false);
  });
  it("only admins edit playbooks; everyone with a role reads them", () => {
    expect(can("admin", "playbooksEdit")).toBe(true);
    expect(can("staff", "playbooksEdit")).toBe(false);
    expect(can("billing", "playbooksView")).toBe(true);
    expect(can("user", "playbooksView")).toBe(false);
    expect(can(undefined, "tasks")).toBe(false);
  });
});

describe("workspace RBAC (rejected before any data access)", () => {
  it("blocks billing from the flow board", async () => {
    await expect(appRouter.createCaller(ctxFor("billing")).workspace.flow.board({})).rejects.toThrow(/access/);
  });
  it("blocks providers from importing the schedule", async () => {
    await expect(appRouter.createCaller(ctxFor("provider")).workspace.schedule.commit({ csv: "a,b\n1,2" })).rejects.toThrow(/access/);
  });
  it("blocks providers from acting on opportunities", async () => {
    await expect(
      appRouter.createCaller(ctxFor("provider")).workspace.opportunities.act({ category: "missed_appointment", keys: ["p:1"], action: "reviewed" }),
    ).rejects.toThrow(/access/);
  });
  it("blocks non-admins from editing playbooks", async () => {
    await expect(
      appRouter.createCaller(ctxFor("front_desk")).workspace.playbooks.save({ title: "x", category: "y", steps: [{ title: "a", detail: "" }] }),
    ).rejects.toThrow(/access/);
  });
  it("blocks the default 'user' role from tasks", async () => {
    await expect(appRouter.createCaller(ctxFor("user")).workspace.tasks.list({ view: "mine" })).rejects.toThrow(/access/);
  });
  it("blocks billing from assigning tasks", async () => {
    await expect(appRouter.createCaller(ctxFor("billing")).workspace.tasks.assignees()).rejects.toThrow(/access/);
  });
  it("still fences MAs away from CCM patient procedures", async () => {
    await expect(appRouter.createCaller(ctxFor("medical_assistant")).patients.list({})).rejects.toThrow();
  });
});

describe("patient flow transitions", () => {
  it("allows one step forward without confirmation", () => {
    expect(checkFlowTransition("scheduled", "arrived")).toEqual({ allowed: true, requiresConfirmation: false });
    expect(checkFlowTransition("roomed", "with_provider")).toEqual({ allowed: true, requiresConfirmation: false });
  });
  it("requires confirmation for skips, backward moves, completing and no-shows", () => {
    for (const [from, to] of [["scheduled", "roomed"], ["roomed", "arrived"], ["checkout", "completed"], ["scheduled", "no_show"]] as const) {
      const r = checkFlowTransition(from, to);
      expect(r.allowed && r.requiresConfirmation).toBe(true);
    }
  });
  it("refuses impossible moves", () => {
    expect(checkFlowTransition("roomed", "no_show").allowed).toBe(false);
    expect(checkFlowTransition("cancelled", "arrived").allowed).toBe(false);
    expect(checkFlowTransition("completed", "roomed").allowed).toBe(false);
    expect(checkFlowTransition("arrived", "arrived").allowed).toBe(false);
  });
});

describe("clinic-local time", () => {
  it("converts Houston wall time to UTC across DST", () => {
    expect(clinicLocalToUtc("2026-07-15", "09:00").toISOString()).toBe("2026-07-15T14:00:00.000Z"); // CDT
    expect(clinicLocalToUtc("2026-01-15", "09:00").toISOString()).toBe("2026-01-15T15:00:00.000Z"); // CST
    expect(clinicLocalToUtc("2026-03-08", "10:00").toISOString()).toBe("2026-03-08T15:00:00.000Z"); // DST starts 2am
  });
  it("skips weekends for the next clinic day", () => {
    expect(nextClinicDay("2026-09-25")).toBe("2026-09-28"); // Fri → Mon
    expect(nextClinicDay("2026-09-23")).toBe("2026-09-24");
  });
});

describe("schedule CSV parsing", () => {
  const csv = [
    "Practice Fusion Appointments Report",
    "Date,Start Time,Patient Name,DOB,Phone,Provider,Facility,Appointment Type,Chief Complaint,Status",
    '09/24/2026,8:00 AM,"Doe, Jane",03/04/58,(713) 555-0100,Dr. Smith,Katy,Follow Up,BP check,Scheduled',
    "09/24/2026,8:20 AM,John Q Public,1971-11-02,,Dr. Smith,Katy,New Patient,,Checked In",
    "09/24/2026,,Missing Time,1971-11-02,,Dr. Smith,Katy,New Patient,,Scheduled",
  ].join("\n");

  it("finds the header row, maps columns and parses rows", () => {
    const r = parseScheduleCsv(csv);
    expect(r.rows).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    const [a, b] = r.rows;
    expect(a).toMatchObject({ date: "2026-09-24", time: "08:00", dob: "1958-03-04", provider: "Dr. Smith", location: "Katy", visitType: "Follow Up", status: "scheduled" });
    expect(b).toMatchObject({ time: "08:20", dob: "1971-11-02", status: "checked_in" });
  });
  it("lets the user override a column", () => {
    const r = parseScheduleCsv(csv, { reason: 7 });
    expect(r.rows[0]!.reason).toBe("Follow Up");
  });
  it("parses dates, times and statuses leniently", () => {
    expect(parseDateValue("3/4/58", { dob: true })).toBe("1958-03-04");
    expect(parseDateValue("3/4/26")).toBe("2026-03-04");
    expect(parseDateValue("13/40/2026")).toBeNull();
    expect(parseTimeValue("2:30pm")).toBe("14:30");
    expect(parseTimeValue("12:05 AM")).toBe("00:05");
    expect(mapScheduleStatus("No Show")).toBe("no_show");
    expect(mapScheduleStatus("Checked Out")).toBe("checkout");
    expect(mapScheduleStatus("whatever")).toBe("scheduled");
  });
  it("matches 'Last, First' to 'First Last' and keys re-imports stably", () => {
    expect(nameKey("Doe, Jane")).toBe(nameKey("Jane Doe"));
    const row = parseScheduleCsv(csv).rows[0]!;
    // Status, reason and clinic can change between imports without creating a duplicate.
    expect(appointmentKey(row)).toBe(appointmentKey({ ...row, status: "completed", reason: "changed", location: "Katy" }));
    expect(appointmentKey(row)).not.toBe(appointmentKey({ ...row, time: "08:40" }));
  });
  it("reads Practice Fusion's appointment report format", () => {
    const pf = [
      "AppointmentTime,Patient,DOB,MobilePhone,HomePhone,OfficePhone,AppointmentType,AppointmentStatus,SeenBy,Copay,Eligibility,Facility",
      "01/05/2026 09:30 AM,Jane Doe,03/04/1958,(713) 555-0100,,,Video Follow-Up,Seen,Sudad Al Hadad,$0,Eligible for coverage,Dr Sudad's Schedule",
      "09/24/2026 02:15 PM,John Public,11/02/1971,(281) 555-0101,,,In-Person New Patient,In lobby,Magdalene Inyang,$25,Not available.,NP Maggie's Schedule",
      "09/28/2026 11:00 AM,Ann Smith,07/04/1949,,(713) 555-0102,,Follow-Up Visit,Pending,Yilian Almaguer Simon,$0,Error,ZNP 1",
    ].join("\n");
    const r = parseScheduleCsv(pf);
    expect(r.errors).toEqual([]);
    expect(r.mapping.datetime).toBe(0);
    expect(r.mapping.provider).toBe(8);
    expect(r.rows.map((x) => [x.date, x.time, x.status, x.provider, x.visitType, x.dob])).toEqual([
      ["2026-01-05", "09:30", "completed", "Sudad Al Hadad", "Video Follow-Up", "1958-03-04"],
      ["2026-09-24", "14:15", "arrived", "Magdalene Inyang", "In-Person New Patient", "1971-11-02"],
      ["2026-09-28", "11:00", "scheduled", "Yilian Almaguer Simon", "Follow-Up Visit", "1949-07-04"],
    ]);
    expect(r.rows[0]!.phone).toBe("(713) 555-0100");
  });
});

describe("openings", () => {
  const base = { date: "2026-09-24", clinicId: 1, providerKey: "p1", providerName: "Dr. A", durationMin: 20 };
  it("finds gaps in a provider's day and treats cancellations as free", () => {
    const o = findOpenings([
      { ...base, time: "08:00", status: "scheduled" },
      { ...base, time: "08:20", status: "cancelled" },
      { ...base, time: "08:40", status: "scheduled", durationMin: 500 },
    ]);
    expect(o).toEqual([{ date: "2026-09-24", clinicId: 1, providerKey: "p1", providerName: "Dr. A", start: "08:20", minutes: 20 }]);
  });
  it("ignores providers with nothing booked that day", () => {
    expect(findOpenings([{ ...base, time: "09:00", status: "no_show" }])).toEqual([]);
  });
});

describe("opportunity rules", () => {
  const now = new Date("2026-09-24T15:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const blank: OpportunityPatient = {
    chronicConditions: [], bhiConditions: [], ccmEnrollmentStatus: null, bhiEnrollmentStatus: null,
    rpmStatus: null, rpmEnrolled: false, lastOfficeVisit: null, nextVisit: null,
  };
  const cats = (p: Partial<OpportunityPatient>) => evaluateOpportunities({ ...blank, ...p }, now).map((m) => m.category).sort();

  it("flags overdue chronic follow-ups but not when something is scheduled", () => {
    expect(cats({ chronicConditions: ["Type 2 diabetes"], lastOfficeVisit: daysAgo(200) })).toEqual(["diabetes_follow_up", "overdue_follow_up"]);
    expect(cats({ chronicConditions: ["Type 2 diabetes"], lastOfficeVisit: daysAgo(200), nextVisit: new Date(now.getTime() + 86_400_000) })).toEqual([]);
  });
  it("respects declined enrollments", () => {
    expect(cats({ chronicConditions: ["COPD", "CKD"], ccmEnrollmentStatus: "declined", lastOfficeVisit: daysAgo(10) })).toEqual([]);
    expect(cats({ chronicConditions: ["COPD", "CKD"], ccmEnrollmentStatus: "inactive", lastOfficeVisit: daysAgo(10) })).toEqual(["ccm_eligible"]);
    expect(cats({ bhiConditions: ["Depression"], bhiEnrollmentStatus: "declined" })).toEqual([]);
  });
});

describe("schedule opportunity rules (everyone on the schedule)", () => {
  const now = new Date("2026-09-24T15:00:00Z");
  const at = (days: number) => new Date(now.getTime() + days * 86_400_000);
  const v = (days: number, status: string, visitType: string | null = "Video Follow-Up"): ScheduleVisit => ({ startsAt: at(days), status, visitType });
  const cats = (visits: ScheduleVisit[]) => evaluateScheduleOpportunities(visits, now).map((m) => m.category).sort();

  it("flags a recent no-show that was never rebooked", () => {
    expect(cats([v(-100, "completed"), v(-10, "no_show")])).toEqual(["missed_appointment"]);
    expect(cats([v(-10, "no_show"), v(5, "scheduled")])).toEqual([]); // rebooked
    expect(cats([v(-10, "no_show"), v(-3, "completed")])).toEqual([]); // came back in
    expect(cats([v(-90, "no_show")])).toEqual([]); // too old
  });
  it("flags cancellations with nothing booked since, but not twice with a no-show", () => {
    expect(cats([v(-60, "completed"), v(-7, "cancelled")])).toEqual(["cancelled_not_rebooked"]);
    expect(cats([v(-7, "cancelled"), v(3, "scheduled")])).toEqual([]);
    expect(cats([v(-9, "cancelled"), v(-5, "no_show")])).toEqual(["missed_appointment"]);
  });
  it("flags new patients who never came back", () => {
    expect(cats([v(-40, "completed", "New Patient Visit")])).toEqual(["new_patient_no_return"]);
    expect(cats([v(-40, "completed", "New Patient Visit"), v(-10, "completed")])).toEqual([]);
    expect(cats([v(-10, "completed", "New Patient Visit")])).toEqual([]); // too soon to worry
  });
  it("flags patients not seen in 3+ months with nothing booked", () => {
    expect(cats([v(-200, "completed"), v(-120, "completed")])).toEqual(["lapsed_follow_up"]);
    expect(cats([v(-120, "completed"), v(14, "scheduled")])).toEqual([]);
    expect(cats([v(-30, "completed")])).toEqual([]);
    expect(cats([v(-400, "completed")])).toEqual([]); // over a year: out of scope
  });
});

describe("fill a provider's schedule", () => {
  const now = new Date("2026-09-25T17:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const ahead = (days: number) => new Date(now.getTime() + days * 86_400_000);
  const v = (at: Date, status: string, providerKey: string, clinicId = 1, visitType: string | null = "Follow up"): FillVisit =>
    ({ startsAt: at, status, visitType, providerKey, providerName: providerKey === "id:5" ? "Narang" : providerKey === "id:1" ? "Mansour" : "Al Hadad", clinicId });
  const target = { key: "id:5", name: "Narang", clinicId: 1 };
  const stopped = new Set(["id:1"]);
  const opts = { includeOtherClinics: false, hasPhone: true, ccmActive: false };

  it("flags providers who have stopped seeing patients, but not new ones", () => {
    const visits: FillVisit[] = [
      ...Array.from({ length: 40 }, (_, i) => v(ago(200 - i), "completed", "id:1")),
      v(ago(20), "completed", "id:1"),
      ...Array.from({ length: 12 }, (_, i) => v(ago(i + 1), "completed", "id:2")),
      ...Array.from({ length: 3 }, (_, i) => v(ago(i + 2), "completed", "id:5")),
    ];
    const a = providerActivity(visits, now);
    expect(a.get("id:1")!.active).toBe(false); // 1 visit in 60 days after months on the schedule
    expect(a.get("id:2")!.active).toBe(true);
    expect(a.get("id:5")!.active).toBe(true); // too new to judge
    expect(a.get("id:1")!.stopped).toBe(true);
    // Someone named on a couple of visits (e.g. an MA) never counts as a provider who stopped.
    const ma = providerActivity([v(ago(200), "completed", "id:9"), v(ago(190), "completed", "id:9")], now);
    expect(ma.get("id:9")!.stopped).toBe(false);
  });

  it("leaves out anyone already booked, recently seen, or with an active provider", () => {
    expect(evaluateScheduleFill([v(ago(60), "completed", "id:5"), v(ahead(10), "scheduled", "id:5")], target, stopped, opts, now)).toBeNull();
    expect(evaluateScheduleFill([v(ago(10), "completed", "id:5")], target, stopped, opts, now)).toBeNull();
    expect(evaluateScheduleFill([v(ago(90), "completed", "id:2")], target, stopped, opts, now)).toBeNull();
  });

  it("puts the provider's own overdue patients first, sooner-seen ranked higher", () => {
    const recent = evaluateScheduleFill([v(ago(45), "completed", "id:5")], target, stopped, opts, now)!;
    const older = evaluateScheduleFill([v(ago(300), "completed", "id:5")], target, stopped, opts, now)!;
    expect(recent.group).toBe("own_due");
    expect(recent.score).toBeGreaterThan(older.score);
  });

  it("finds patients left behind by a provider who stopped, at the same clinic", () => {
    const same = evaluateScheduleFill([v(ago(120), "completed", "id:1", 1), v(ago(200), "completed", "id:1", 1)], target, stopped, opts, now)!;
    expect(same.group).toBe("orphaned");
    expect(same.reason).toMatch(/Mansour stopped seeing patients/);
    const elsewhere = [v(ago(120), "completed", "id:1", 3)];
    expect(evaluateScheduleFill(elsewhere, target, stopped, opts, now)).toBeNull();
    expect(evaluateScheduleFill(elsewhere, target, stopped, { ...opts, includeOtherClinics: true }, now)!.group).toBe("orphaned");
    // No clinic recorded: still a lead, just without the same-clinic bonus.
    const unknown = evaluateScheduleFill([v(ago(120), "completed", "id:1", null as unknown as number), v(ago(200), "completed", "id:1", null as unknown as number)], target, stopped, opts, now)!;
    expect(unknown.group).toBe("orphaned");
    expect(unknown.score).toBeLessThan(same.score);
  });

  it("keeps never-seen bookings as weak leads, and marks down no-shows and missing phones", () => {
    const never = evaluateScheduleFill([v(ago(90), "no_show", "id:1")], target, stopped, opts, now)!;
    expect(never.group).toBe("never_seen");
    expect(never.likelihood).toBe("possible");
    const reliable = evaluateScheduleFill([v(ago(100), "completed", "id:1")], target, stopped, opts, now)!;
    const flaky = evaluateScheduleFill([v(ago(100), "completed", "id:1"), v(ago(150), "no_show", "id:1"), v(ago(160), "no_show", "id:1")], target, stopped, opts, now)!;
    const noPhone = evaluateScheduleFill([v(ago(100), "completed", "id:1")], target, stopped, { ...opts, hasPhone: false }, now)!;
    expect(flaky.score).toBeLessThan(reliable.score);
    expect(noPhone.score).toBeLessThan(reliable.score);
  });

  it("is open to front desk but closed to billing", async () => {
    await expect(appRouter.createCaller(ctxFor("billing")).workspace.opportunities.fill({ providerId: 1 })).rejects.toThrow(/access/);
    await expect(
      appRouter.createCaller(ctxFor("provider")).workspace.opportunities.fillAct({ providerId: 1, keys: ["p:1"], action: "reviewed" }),
    ).rejects.toThrow(/access/);
  });
});

describe("RingCentral phone", () => {
  it("normalizes US numbers to 10 digits", () => {
    expect(normalizePhone("(713) 555-1234")).toBe("7135551234");
    expect(normalizePhone("+1 713.555.1234")).toBe("7135551234");
    expect(normalizePhone("555-1234")).toBeNull();
    expect(formatPhone("7135551234")).toBe("(713) 555-1234");
  });

  it("reads the call RingCentral reports when a call ends", () => {
    const out = parseRingCentralCall({ direction: "Outbound", to: { phoneNumber: "+17135551234" }, startTime: 1_790_000_000_000, endTime: 1_790_000_095_000, telephonySessionId: "s-1", result: "Call connected" });
    expect(out).toMatchObject({ direction: "outbound", otherNumber: "7135551234", durationSec: 95, sessionId: "s-1", result: "Call connected" });
    const inbound = parseRingCentralCall({ direction: "Inbound", from: { phoneNumber: "+12815550000" }, duration: 30 });
    expect(inbound).toMatchObject({ direction: "inbound", otherNumber: "2815550000", durationSec: 30 });
    expect(parseRingCentralCall(null)).toBeNull();
  });

  it("only admins change the connection; MAs can't read a patient's call log", async () => {
    await expect(appRouter.createCaller(ctxFor("front_desk")).workspace.phone.saveConfig({ enabled: true, clientId: "", allowTexting: false })).rejects.toThrow(/admin/);
    await expect(appRouter.createCaller(ctxFor("medical_assistant")).workspace.phone.forPatient(1)).rejects.toThrow(/access/);
    await expect(appRouter.createCaller(ctxFor("user")).workspace.phone.config()).rejects.toThrow(/access/);
  });

  it("rejects a client secret-looking value or junk as the client ID", async () => {
    await expect(appRouter.createCaller(ctxFor("admin")).workspace.phone.saveConfig({ enabled: true, clientId: "abc def/ghi", allowTexting: false })).rejects.toThrow();
  });
});

describe("RingCentral call-log sync", () => {
  it("reads outbound, inbound and internal call-log records", () => {
    const out = mapCallLogRecord({ id: "r1", telephonySessionId: "t1", sessionId: "s1", startTime: "2026-09-25T15:00:00.000Z", duration: 95, direction: "Outbound", result: "Call connected", from: { phoneNumber: "+12815550100", extensionNumber: "101" }, to: { phoneNumber: "+17135551234" }, extension: { id: 555 } });
    expect(out).toMatchObject({ ids: ["t1", "s1", "r1"], direction: "outbound", otherNumber: "7135551234", durationSec: 95, extensionId: "555" });
    const inbound = mapCallLogRecord({ id: "r2", startTime: "2026-09-25T16:00:00.000Z", direction: "Inbound", from: { phoneNumber: "(281) 555-0000" }, to: { phoneNumber: "+12815550100" }, legs: [{}, { extension: { id: 777 } }] });
    expect(inbound).toMatchObject({ direction: "inbound", otherNumber: "2815550000", extensionId: "777" });
    const internal = mapCallLogRecord({ id: "r3", startTime: "2026-09-25T16:00:00.000Z", direction: "Outbound", to: { extensionNumber: "102" } });
    expect(internal!.otherNumber).toBeNull();
    expect(mapCallLogRecord({})).toBeNull();
  });

  it("encrypts stored credentials so the database never holds them in the clear", async () => {
    const { ENV } = await import("./_core/env");
    if (!ENV.cookieSecret) return; // no server secret in this environment
    const { sealSecret, openSecret } = await import("./secretBox");
    const sealed = sealSecret("super-secret-jwt");
    expect(sealed).not.toContain("super-secret-jwt");
    expect(openSecret(sealed)).toBe("super-secret-jwt");
    expect(sealSecret("super-secret-jwt")).not.toBe(sealed); // fresh IV each time
  });

  it("is admin-only", async () => {
    const fd = appRouter.createCaller(ctxFor("front_desk"));
    await expect(fd.workspace.phone.syncStatus()).rejects.toThrow(/admin/);
    await expect(fd.workspace.phone.saveSync({ enabled: true, clientId: "abc", clientSecret: "x", jwt: "y" })).rejects.toThrow(/admin/);
    await expect(fd.workspace.phone.syncNow()).rejects.toThrow(/admin/);
  });
});

describe("practice mailbox matching", () => {
  it("reads the sender", () => {
    expect(parseFromHeader('"Doe, Jane" <Jane.Doe@Example.com>')).toEqual({ name: "Doe, Jane", email: "jane.doe@example.com" });
    expect(parseFromHeader("jane@example.com")).toEqual({ name: null, email: "jane@example.com" });
    expect(parseFromHeader("not an address").email).toBeNull();
  });

  it("ignores phone numbers in quoted replies (our own signature)", () => {
    const body = "Please call me back at 832-555-0101.\n\nOn Tue, Sep 22, 2026 at 9:00 AM MyPCP <care@mypcpdr.com> wrote:\n> Call us at (281) 555-0199";
    expect(extractPhones(stripQuotedText(body))).toEqual(["8325550101"]);
    expect(extractPhones("cell 713.555.1234, home +1 (281) 555-0000")).toEqual(["7135551234", "2815550000"]);
  });

  const jane = { key: "p:1", patientId: 1, name: "Jane Doe" };
  const john = { key: "s:john roe|1950-01-01", patientId: null, name: "John Roe" };
  const idx = {
    byEmail: new Map<string, typeof jane | "ignore">([["jane@x.com", jane], ["vendor@supply.com", "ignore"]]),
    byName: new Map([["jane doe", [jane]], ["john roe", [john]], ["maria lopez", [jane, john]]]),
    byPhone: new Map([["8325550101", john]]),
  };

  it("matches by remembered address first, and skips known non-patients", () => {
    expect(matchEmailSender({ email: "jane@x.com", name: "Someone Else", body: "" }, idx)).toEqual({ subject: jane, method: "address" });
    expect(matchEmailSender({ email: "vendor@supply.com", name: null, body: "" }, idx)).toEqual({ ignore: true });
  });

  it("matches a full, unique sender name — never a first name alone or a shared name", () => {
    expect(matchEmailSender({ email: "new@x.com", name: "Doe, Jane", body: "" }, idx)).toEqual({ subject: jane, method: "name" });
    expect(matchEmailSender({ email: "new@x.com", name: "Jane", body: "" }, idx)).toBeNull();
    expect(matchEmailSender({ email: "new@x.com", name: "Maria Lopez", body: "" }, idx)).toBeNull();
  });

  it("falls back to a phone number the sender wrote", () => {
    expect(matchEmailSender({ email: "new@x.com", name: "Mom", body: "This is for my father, call 832-555-0101" }, idx)).toEqual({ subject: john, method: "phone" });
    expect(matchEmailSender({ email: "new@x.com", name: null, body: "no numbers here" }, idx)).toBeNull();
  });

  it("keeps triage away from MAs and connection settings admin-only", async () => {
    await expect(appRouter.createCaller(ctxFor("medical_assistant")).workspace.email.list({ filter: "all" })).rejects.toThrow(/access/);
    await expect(appRouter.createCaller(ctxFor("billing")).workspace.email.list({ filter: "all" })).rejects.toThrow(/access/);
    await expect(appRouter.createCaller(ctxFor("front_desk")).workspace.email.status()).rejects.toThrow(/admin/);
    await expect(appRouter.createCaller(ctxFor("front_desk")).workspace.email.connectUrl({ origin: "https://mypcpcare.com" })).rejects.toThrow(/admin/);
  });
});

describe("testing & screenings rules", () => {
  const today = "2026-09-25";
  const find = (list: ReturnType<typeof evaluateTesting>, k: string) => list.find((s) => s.key === k);

  it("works out age on a date", () => {
    expect(ageOn("1960-09-26", today)).toBe(65);
    expect(ageOn("1960-09-25", today)).toBe(66);
    expect(ageOn(null, today)).toBeNull();
  });

  it("diabetes: A1c every 6 months from the last one", () => {
    const p = { age: 60, sex: "M" as const, conditions: ["Type 2 diabetes mellitus"], medicare: false };
    expect(find(evaluateTesting(p, [], today), "a1c")!.state).toBe("no_record");
    expect(find(evaluateTesting(p, [{ testKey: "a1c", performedOn: "2026-06-01", status: "done" }], today), "a1c")).toMatchObject({ state: "current", dueOn: "2026-12-01" });
    expect(find(evaluateTesting(p, [{ testKey: "a1c", performedOn: "2026-03-01", status: "done" }], today), "a1c")).toMatchObject({ state: "due", dueOn: "2026-09-01" });
    expect(find(evaluateTesting(p, [{ testKey: "a1c", performedOn: "2026-04-10", status: "done" }], today), "a1c")!.state).toBe("due_soon");
    // No diabetes → no A1c.
    expect(find(evaluateTesting({ ...p, conditions: ["Asthma"] }, [], today), "a1c")).toBeUndefined();
  });

  it("colorectal interval follows the method (colonoscopy 10 years, FIT 1 year)", () => {
    const p = { age: 55, sex: "F" as const, conditions: [], medicare: false };
    expect(find(evaluateTesting(p, [{ testKey: "colorectal", performedOn: "2019-01-01", status: "done", method: "colonoscopy" }], today), "colorectal")!.state).toBe("current");
    expect(find(evaluateTesting(p, [{ testKey: "colorectal", performedOn: "2025-01-01", status: "done", method: "fit" }], today), "colorectal")!.state).toBe("due");
    expect(find(evaluateTesting({ ...p, age: 40 }, [], today), "colorectal")).toBeUndefined();
  });

  it("sex-specific screenings need sex on file and only apply to the right ages", () => {
    const base = { age: 50, conditions: [], medicare: false };
    expect(find(evaluateTesting({ ...base, sex: null }, [], today), "mammogram")!.state).toBe("needs_info");
    expect(find(evaluateTesting({ ...base, sex: "M" }, [], today), "mammogram")).toBeUndefined();
    expect(find(evaluateTesting({ ...base, sex: "F" }, [], today), "mammogram")!.state).toBe("no_record");
    expect(find(evaluateTesting({ ...base, age: 80, sex: null }, [], today), "mammogram")).toBeUndefined(); // too old either way
    expect(find(evaluateTesting({ ...base, age: 70, sex: "F" }, [], today), "dexa")!.state).toBe("no_record");
  });

  it("once-only tests stay done; declined hides for 12 months; not needed is permanent", () => {
    const p = { age: 40, sex: "F" as const, conditions: [], medicare: false };
    expect(find(evaluateTesting(p, [{ testKey: "hcv", performedOn: "2015-05-05", status: "done" }], today), "hcv")!.state).toBe("current");
    expect(find(evaluateTesting(p, [{ testKey: "hiv", performedOn: "2026-01-01", status: "declined" }], today), "hiv")!.state).toBe("declined");
    expect(find(evaluateTesting(p, [{ testKey: "hiv", performedOn: "2024-01-01", status: "declined" }], today), "hiv")!.state).toBe("no_record");
    expect(find(evaluateTesting(p, [{ testKey: "cervical", performedOn: "2020-01-01", status: "not_applicable" }], today), "cervical")!.state).toBe("not_applicable");
  });

  it("recognizes test names from Practice Fusion / lab exports", () => {
    expect(recognizeTest("Hemoglobin A1c")).toEqual({ key: "a1c", method: null });
    expect(recognizeTest("HbA1c")).toEqual({ key: "a1c", method: null });
    expect(recognizeTest("Microalbumin/Creatinine Ratio, Urine")).toEqual({ key: "uacr", method: null });
    expect(recognizeTest("Comprehensive Metabolic Panel")).toEqual({ key: "egfr", method: null });
    expect(recognizeTest("Lipid Panel w/ Reflex")).toEqual({ key: "lipid", method: null });
    expect(recognizeTest("Cologuard")).toEqual({ key: "colorectal", method: "stool_dna" });
    expect(recognizeTest("Screening colonoscopy")).toEqual({ key: "colorectal", method: "colonoscopy" });
    expect(recognizeTest("Mammogram, bilateral screening")).toEqual({ key: "mammogram", method: null });
    expect(recognizeTest("ThinPrep Pap with HPV")).toEqual({ key: "cervical", method: "hpv" });
    expect(recognizeTest("Hepatitis C Antibody")).toEqual({ key: "hcv", method: null });
    expect(recognizeTest("CBC with differential")).toBeNull();
    expect(parseSex("Female")).toBe("F");
    expect(parseSex("m")).toBe("M");
    expect(parseSex("")).toBeNull();
  });

  it("recording tests needs the full patient record; imports are admin-only", async () => {
    await expect(appRouter.createCaller(ctxFor("medical_assistant")).workspace.testing.person("p:1")).rejects.toThrow(/access/);
    await expect(appRouter.createCaller(ctxFor("billing")).workspace.testing.overview({ states: ["due"] })).rejects.toThrow(/access/);
    await expect(appRouter.createCaller(ctxFor("front_desk")).workspace.testing.importResults({ csv: "a,b\n1,2" })).rejects.toThrow(/admin/);
  });
});

describe("insurance checker", () => {
  it("answers like the website: Medicaid/CHIP no, listed plans yes, anything else verify", () => {
    expect(checkInsurance("ae")).toBeNull();
    expect(checkInsurance("Aetna")).toMatchObject({ result: "yes" });
    expect(checkInsurance("aetna")!.plans.map((p) => p.name)).toEqual(["Aetna (PPO, HMO, EPO)", "Aetna Medicare Advantage"]);
    expect(checkInsurance("BCBS")!.plans[0]!.name).toBe("Blue Cross Blue Shield of Texas");
    expect(checkInsurance("MultiPlan")!.plans[0]!.name).toBe("Claritev (formerly MultiPlan)");
    expect(checkInsurance("Texas Medicaid")!.result).toBe("no");
    expect(checkInsurance("Superior STAR Kids")!.result).toBe("no");
    expect(checkInsurance("Aetna Better Health")!.result).toBe("no");
    expect(checkInsurance("UnitedHealthcare Community Plan")!.result).toBe("no");
    expect(checkInsurance("Kaiser")!.result).toBe("maybe");
    expect(checkInsurance("Humana")!.plans[0]!.note).toMatch(/Dallas/);
    expect(PLANS).toHaveLength(44);
    expect(patientLine(checkInsurance("cigna")!, "es")).toBe("Sí — aceptamos Cigna Healthcare of Texas en nuestras 4 clínicas.");
    expect(patientLine(checkInsurance("medicaid")!, "en")).toContain("$120 first visit, $99 follow-ups");
  });
});

describe("my progress metrics", () => {
  it("usual day = average of active days before today (needs 3+)", () => {
    const m = new Map([["2026-09-20", 10], ["2026-09-21", 20], ["2026-09-22", 0], ["2026-09-26", 99]]);
    expect(usualPerDay(m, "2026-09-26")).toBeNull();
    m.set("2026-09-23", 30);
    expect(usualPerDay(m, "2026-09-26")).toBe(20);
  });
  it("counts weekdays left in the month, including today", () => {
    expect(weekdaysLeftInMonth("2026-09-28")).toBe(3); // Mon 28, Tue 29, Wed 30
    expect(weekdaysLeftInMonth("2026-09-26")).toBe(3); // Sat → Mon–Wed
  });
  it("progress uses the goal first, then the usual day", () => {
    expect(progressOf({ value: 10, goal: 40, usual: 20 })).toBe(0.25);
    expect(progressOf({ value: 30, goal: null, usual: 20 })).toBe(1);
    expect(progressOf({ value: 3, goal: null, usual: null })).toBeNull();
  });
  it("puts each role's top-bar numbers first", () => {
    const ms = (["calls", "booked", "talk", "care_calls", "ccm_month", "tasks_done"] as const).map((key) => ({ key, label: key, value: 0 }));
    expect(orderMetrics("staff", ms).slice(0, 3).map((m) => m.key)).toEqual(["care_calls", "ccm_month", "calls"]);
    expect(orderMetrics("front_desk", ms).slice(0, 2).map((m) => m.key)).toEqual(["calls", "booked"]);
  });
  it("only admins can see or set daily goals", async () => {
    await expect(appRouter.createCaller(ctxFor("front_desk")).workspace.metrics.setGoals({ front_desk: { calls: 40 } })).rejects.toThrow(/admin/);
    await expect(appRouter.createCaller(ctxFor("staff")).workspace.metrics.goals()).rejects.toThrow(/admin/);
  });
});

describe("RingCentral call stats (every call, per person)", () => {
  it("credits outbound calls to the caller and queue calls to whoever answered", () => {
    const out = mapCallStat({ id: "a1", telephonySessionId: "t1", startTime: "2026-09-26T15:00:00.000Z", duration: 120, direction: "Outbound", result: "Call connected", to: { phoneNumber: "+17135551234" }, extension: { id: 101 } });
    expect(out).toMatchObject({ rcId: "t1", direction: "outbound", extensionId: "101", answered: false, missed: false, durationSec: 120 });
    const queue = mapCallStat({ id: "a2", startTime: "2026-09-26T16:00:00.000Z", duration: 300, direction: "Inbound", result: "Accepted", from: { phoneNumber: "+12815550000" },
      extension: { id: 900 }, legs: [{ extension: { id: 900 }, result: "Missed" }, { extension: { id: 205 }, result: "Accepted" }] });
    expect(queue).toMatchObject({ extensionId: "205", answered: true, missed: false });
  });
  it("marks unanswered inbound calls as missed and skips internal calls", () => {
    expect(mapCallStat({ id: "a3", startTime: "2026-09-26T17:00:00.000Z", direction: "Inbound", result: "Missed", from: { phoneNumber: "+12815550001" }, extension: { id: 205 } }))
      .toMatchObject({ answered: false, missed: true, extensionId: "205" });
    expect(mapCallStat({ id: "a4", startTime: "2026-09-26T17:05:00.000Z", direction: "Inbound", result: "Voicemail", duration: 40, from: { phoneNumber: "+12815550002" } })!.missed).toBe(true);
    expect(mapCallStat({ id: "a5", startTime: "2026-09-26T17:10:00.000Z", direction: "Outbound", result: "Call connected", to: { extensionNumber: "102" }, extension: { id: 101 } })).toBeNull();
  });
  it("only admins can see the team's numbers", async () => {
    await expect(appRouter.createCaller(ctxFor("staff")).workspace.metrics.team({ date: "2026-09-26" })).rejects.toThrow(/admin/);
  });
});

describe("fax inbox", () => {
  const pdf = [{ filename: "fax.pdf", mimeType: "application/pdf" }];
  it("spots fax emails: a PDF/TIFF from a fax service or with 'fax' in the subject", () => {
    expect(isFaxEmail({ fromEmail: "notify@ringcentral.com", subject: "New Fax Message from (713) 555-0199", attachments: pdf })).toBe(true);
    expect(isFaxEmail({ fromEmail: "someone@clinic.example", subject: "Incoming fax: lab results", attachments: [{ filename: "scan.TIF", mimeType: "image/tiff" }] })).toBe(true);
    expect(isFaxEmail({ fromEmail: "patient@example.com", subject: "My insurance card", attachments: pdf })).toBe(false);
    expect(isFaxEmail({ fromEmail: "notify@ringcentral.com", subject: "Voicemail", attachments: [] })).toBe(false);
    expect(isFaxEmail({ fromEmail: "faxes@ourservice.example", subject: "Doc", attachments: pdf }, ["ourservice.example"])).toBe(true);
    expect(parseFaxMeta("New Fax Message from (713) 555-0199 - 3 page(s)", "")).toEqual({ fromNumber: "7135550199", pages: 3 });
  });
  it("keeps only valid fields from the AI's answer", () => {
    expect(parseFaxReading('Here you go:\n```json\n{"patientName":"TESTPERSON, JANE Q","dob":"1960-01-02","documentType":"lab_result","sender":"Gulf Coast Lab","summary":"Lab report"}\n```'))
      .toEqual({ patientName: "TESTPERSON, JANE Q", dob: "1960-01-02", documentType: "lab_result", sender: "Gulf Coast Lab", summary: "Lab report" });
    expect(parseFaxReading('{"patientName":"null","dob":"01/02/1960","documentType":"blood work"}')).toMatchObject({ patientName: null, dob: null, documentType: "other" });
    expect(parseFaxReading("no json")).toBeNull();
  });
  it("assigns only on name + date of birth; a name alone is a suggestion", () => {
    const people = [
      { key: "p:1", patientId: 1, name: "Jane Testperson", dob: "1960-01-02" },
      { key: "p:2", patientId: 2, name: "John Sample", dob: "1970-05-05" },
      { key: "p:3", patientId: 3, name: "John Sample", dob: "1980-06-06" },
    ];
    expect(matchFaxPatient("TESTPERSON, JANE Q", "1960-01-02", people)).toMatchObject({ person: { key: "p:1" }, sure: true });
    expect(matchFaxPatient("Jane Testperson", null, people)).toMatchObject({ person: { key: "p:1" }, sure: false });
    expect(matchFaxPatient("J. Testperson", "1960-01-02", people)).toMatchObject({ person: { key: "p:1" }, sure: false });
    expect(matchFaxPatient("John Sample", null, people)).toBeNull(); // two John Samples
    expect(matchFaxPatient("John Sample", "1980-06-06", people)).toMatchObject({ person: { key: "p:3" }, sure: true });
    expect(matchFaxPatient(null, "1960-01-02", people)).toBeNull();
  });
  it("fax settings are admin-only and MAs can't see faxes", async () => {
    await expect(appRouter.createCaller(ctxFor("front_desk")).workspace.fax.status()).rejects.toThrow(/admin/);
    await expect(appRouter.createCaller(ctxFor("medical_assistant")).workspace.fax.list({ filter: "all" })).rejects.toThrow();
  });
});

describe("Practice Fusion chart (FHIR)", () => {
  it("turns records into readable chart lines", () => {
    expect(chartLine({ resourceType: "Condition", code: { coding: [{ system: "http://snomed.info/sct", code: "44054006", display: "Diabetes mellitus type 2" }] }, clinicalStatus: { coding: [{ code: "active" }] }, onsetDateTime: "2018-03-04T00:00:00Z" }))
      .toMatchObject({ title: "Diabetes mellitus type 2", status: "active", date: "2018-03-04" });
    expect(chartLine({ resourceType: "Observation", code: { text: "Hemoglobin A1c" }, valueQuantity: { value: 7.23, unit: "%" }, interpretation: [{ coding: [{ code: "H" }] }], effectiveDateTime: "2026-09-01" }))
      .toMatchObject({ title: "Hemoglobin A1c", value: "7.23 % (H)", date: "2026-09-01" });
    expect(chartLine({ resourceType: "Observation", code: { text: "Blood pressure" }, component: [{ valueQuantity: { value: 128, unit: "mmHg" } }, { valueQuantity: { value: 82, unit: "mmHg" } }], effectiveDateTime: "2026-09-02" }).value).toBe("128/82 mmHg");
    expect(chartLine({ resourceType: "Coverage", payor: [{ display: "Aetna" }], subscriberId: "W123", status: "active" })).toMatchObject({ title: "Aetna", value: "Member ID W123" });
    expect(sectionType({ resourceType: "Observation", category: [{ coding: [{ code: "vital-signs" }] }] })).toBe("Observation:vital-signs");
    expect(patientOf({ resourceType: "Coverage", beneficiary: { reference: "Patient/abc" } })).toBe("abc");
    expect(patientOf({ resourceType: "Observation", subject: { reference: "https://x.example/fhir/Patient/p9" } })).toBe("p9");
  });
  it("reads a Patient for matching and contact info", () => {
    expect(patientInfo({ resourceType: "Patient", id: "p1", name: [{ use: "official", given: ["Jane", "Q"], family: "Testperson" }], birthDate: "1960-01-02", gender: "female",
      telecom: [{ system: "phone", value: "555-0100", use: "home" }, { system: "email", value: "Jane@Example.com" }], identifier: [{ type: { coding: [{ code: "MR" }] }, value: "MRN77" }] }))
      .toEqual({ fhirId: "p1", name: "Jane Q Testperson", dob: "1960-01-02", sex: "F", phone: "555-0100", email: "jane@example.com", address: null, mrn: "MRN77" });
  });
  it("keeps the front desk to the limited chart and MAs out", async () => {
    await expect(appRouter.createCaller(ctxFor("medical_assistant")).workspace.chart.get("p:1")).rejects.toThrow(/access/);
    await expect(appRouter.createCaller(ctxFor("front_desk")).workspace.chart.note(1)).rejects.toThrow(/access/);
    await expect(appRouter.createCaller(ctxFor("staff")).workspace.pf.importNow("full")).rejects.toThrow(/admin/);
  });
});

describe("website bookings", () => {
  const sep27 = new Date("2026-09-27T20:00:00Z"); // 3 pm in Houston
  it("reads the preferred time the website sends (English and Spanish)", () => {
    expect(parsePreferred("Tue, Sep 29 · 10:00 AM", sep27)).toEqual({ date: "2026-09-29", time: "10:00 AM", spanish: false });
    expect(parsePreferred("mar, 29 sept · 2:30 PM", sep27)).toEqual({ date: "2026-09-29", time: "2:30 PM", spanish: true });
    expect(parsePreferred("Fri, Jan 8 · 9:00 AM", sep27).date).toBe("2027-01-08"); // no year: the next one
    expect(parsePreferred("", sep27)).toEqual({ date: null, time: null, spanish: false });
  });
  it("maps website locations to MyPCP clinics", () => {
    const clinics = [{ id: 1, name: "Katy" }, { id: 2, name: "Cypress" }, { id: 3, name: "Highland Knolls" }, { id: 4, name: "Westheimer" }];
    expect(clinicForLocation("Katy - Provincial Blvd", clinics)).toBe(1);
    expect(clinicForLocation("Katy - Highland Knolls", clinics)).toBe(3);
    expect(clinicForLocation("Richmond Ave", clinics)).toBe(4);
    expect(clinicForLocation("Cypress", clinics)).toBe(2);
    expect(clinicForLocation("", clinics)).toBeNull();
  });
  it("reads earlier bookings back out of the booking emails", () => {
    const text = "New appointment request from mypcpdr.com\n\nName:      Pat Example\nPhone:     (281) 555-0101\nLocation:  Cypress\nProvider:  first available\nVisit:     New patient visit\nPreferred: Wed, Sep 30 · 11:00 AM\n";
    expect(parseBookingEmail(text)).toEqual({ name: "Pat Example", phone: "(281) 555-0101", location: "Cypress", provider: null, visitType: "New patient visit", preferred: "Wed, Sep 30 · 11:00 AM" });
    expect(parseBookingEmail("Name: X\nPhone: 123")).toBeNull();
  });
  it("front desk can work bookings; MAs can't; loading old ones is admin-only", async () => {
    await expect(appRouter.createCaller(ctxFor("medical_assistant")).workspace.bookings.list({ filter: "open" })).rejects.toThrow(/access/);
    await expect(appRouter.createCaller(ctxFor("front_desk")).workspace.bookings.importEarlier({})).rejects.toThrow(/admin/);
  });
});
