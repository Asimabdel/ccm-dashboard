import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import {
  can,
  checkFlowTransition,
  clinicLocalToUtc,
  evaluateOpportunities,
  findOpenings,
  mapScheduleStatus,
  nameKey,
  nextClinicDay,
  parseDateValue,
  parseScheduleCsv,
  parseTimeValue,
  type OpportunityPatient,
} from "../shared/workspace";
import { appointmentKey } from "./workspaceDb";

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
      appRouter.createCaller(ctxFor("provider")).workspace.opportunities.act({ category: "missed_appointment", patientIds: [1], action: "reviewed" }),
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
    expect(appointmentKey(1, row)).toBe(appointmentKey(1, { ...row, status: "completed", reason: "changed" }));
    expect(appointmentKey(1, row)).not.toBe(appointmentKey(2, row));
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
    rpmStatus: null, rpmEnrolled: false, lastOfficeVisit: null, nextVisit: null, lastNoShow: null,
  };
  const cats = (p: Partial<OpportunityPatient>) => evaluateOpportunities({ ...blank, ...p }, now).map((m) => m.category).sort();

  it("flags overdue chronic follow-ups but not when something is scheduled", () => {
    expect(cats({ chronicConditions: ["Type 2 diabetes"], lastOfficeVisit: daysAgo(200) })).toEqual(["diabetes_follow_up", "overdue_follow_up"]);
    expect(cats({ chronicConditions: ["Type 2 diabetes"], lastOfficeVisit: daysAgo(200), nextVisit: new Date(now.getTime() + 86_400_000) })).toEqual([]);
  });
  it("flags recent no-shows only", () => {
    expect(cats({ lastNoShow: daysAgo(10) })).toEqual(["missed_appointment"]);
    expect(cats({ lastNoShow: daysAgo(90) })).toEqual([]);
    expect(cats({ lastNoShow: daysAgo(10), lastOfficeVisit: daysAgo(2) })).toEqual([]);
  });
  it("respects declined enrollments", () => {
    expect(cats({ chronicConditions: ["COPD", "CKD"], ccmEnrollmentStatus: "declined", lastOfficeVisit: daysAgo(10) })).toEqual([]);
    expect(cats({ chronicConditions: ["COPD", "CKD"], ccmEnrollmentStatus: "inactive", lastOfficeVisit: daysAgo(10) })).toEqual(["ccm_eligible"]);
    expect(cats({ bhiConditions: ["Depression"], bhiEnrollmentStatus: "declined" })).toEqual([]);
  });
});
