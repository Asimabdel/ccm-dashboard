// ZocDoc in Master Billing: reading the report and the spend-vs-revenue math. Made-up patients only.
import { describe, expect, it } from "vitest";
import { parseCsvRows } from "../shared/workspace";
import { bookingKeySource, detectZocdocMapping, parseZocdocRows, splitZocdocName, zocdocStatus, zocdocSummary, type ZBooking, type ZClaim, type ZVisit } from "../shared/zocdoc";
import { bookingKeyOf } from "./zocdocDb";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const CSV = [
  "Professional,Patient First Name,Patient Last Name,Patient DOB,Appointment Time,Booked,Insurance,Booking Source,Appointment Type,Patient Type,Cost,Cost Reason,Status",
  "Dr. Test One,Jane,Sample,2/12/00,11/13/26 5:40 PM,11/10/26 8:30 PM,Sample Health PPO,Marketplace,Annual Physical,New,$45.00,cost_initial,Confirmed",
  "Dr. Test One,John,Example,05/30/1991,11/12/26 9:00 AM,11/01/26 1:00 PM,,Marketplace,Sick Visit,New,45,cost_latecancellation,PatientCanceled",
  "Dr. Test Two,Ann,Demo,1980-01-01,11/11/26 2:00 PM,,Sample Health PPO,Marketplace,Sick Visit,Existing,$0.00,,PracticeCanceled",
  ",,,,,,,,,,,,",
  "Dr. Test Two,,,1970-01-01,11/11/26 2:00 PM,,,,,,$45,,Confirmed",
].join("\n");

describe("reading ZocDoc's appointment report", () => {
  it("finds the columns and reads bookings (two-digit birth years land in the past, money in cents)", () => {
    const rows = parseCsvRows(CSV);
    const det = detectZocdocMapping(rows);
    expect(det.mapping.firstName).toBe(1);
    expect(det.mapping.cost).toBe(10);
    expect(det.mapping.appointmentAt).toBe(4);
    const p = parseZocdocRows(rows);
    expect(p.rows).toHaveLength(3);
    expect(p.skipped).toBe(1); // no patient name
    expect(p.missing).toEqual([]);
    expect(p.rows[0]).toMatchObject({ patientFirst: "Jane", patientLast: "Sample", patientDob: "2000-02-12", appointmentAt: "2026-11-13 17:40", appointmentDate: "2026-11-13", bookedAt: "2026-11-10 20:30", status: "confirmed", patientType: "new", costCents: 4500, providerName: "Dr. Test One", insuranceCarrier: "Sample Health PPO" });
    expect(p.rows[1]).toMatchObject({ patientDob: "1991-05-30", status: "patient_canceled", costCents: 4500, costReason: "cost_latecancellation" });
    expect(p.rows[2]).toMatchObject({ status: "practice_canceled", patientType: "existing", costCents: 0, bookedAt: null });
  });

  it("reads ZocDoc's real download layout (run-together headers, local times, ISO birth dates, a redacted DOB)", () => {
    const head = "AppointmentId,Professional,Location,LocationAddress,PatientFirstName,PatientLastName,PatientDateOfBirth,PatientType,PatientPhoneNumber,PatientEmail,PatientAddress,AppointmentTimeLocal,AppointmentTimeUtc,BookingTimeLocal,BookingTimeUtc,AppointmentStatus,InsuranceCarrier,InsurancePlan,BookingSource,SourceChannel,VisitReason,SupervisingProfessional,Cost,AppointmentType,OrganizationName,PracticeName,ProfessionalNpi,ProviderType,Specialty,SupervisingProviderNpi,PatientGender,InsuranceProgram,InsurancePlanType,ChargedAppointment,DaysBetweenBookingAndLatestAppointment,InitialAppointmentTimestampEst,AppointmentOutcomeTimestampEst";
    const row = (id: string, dob: string, at: string, status: string, cost: string) =>
      [id, "Dr. Test One", "Test Clinic", "1 Test St", "Jane", "Sample", dob, "New", "555-0100", "jane@example.com", "1 Test St", at, "1/1/2026 3:00 PM", "12/30/2025 8:05 PM", "12/31/2025 2:05 AM", status, "Sample Health", "Sample PPO", "Zocdoc Marketplace", "Zocdoc.com & app", "Sick Visit", "", cost, "Video Visit", "Test Org", "Test Practice", "1234567890", "Doctor", "Family Physician", "", "F", "Commercial", "PPO", cost === "0" ? "No" : "Yes", "2", at, at].join(",");
    const p = parseZocdocRows(parseCsvRows(["﻿" + head, row("apt_test-1", "2000-02-12", "1/1/2026 9:05 AM", "PatientCanceled", "45"), row("apt_test-2", "[Redacted]", "11/13/2026 12:30 PM", "Confirmed", "0")].join("\r\n")));
    expect(p.missing).toEqual([]);
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]).toMatchObject({ appointmentId: "apt_test-1", patientDob: "2000-02-12", appointmentAt: "2026-01-01 09:05", appointmentDate: "2026-01-01", bookedAt: "2025-12-30 20:05", status: "patient_canceled", patientType: "new", costCents: 4500, providerName: "Dr. Test One", locationName: "Test Clinic", insuranceCarrier: "Sample Health", insurancePlan: "Sample PPO", bookingSource: "Zocdoc Marketplace", visitReason: "Sick Visit" });
    expect(p.rows[1]).toMatchObject({ patientDob: null, appointmentAt: "2026-11-13 12:30", costCents: 0 });
    const s = zocdocSummary(p.rows.map((r) => ({ person: "u:jane", matched: false, appointmentDate: r.appointmentDate, status: r.status, patientType: r.patientType, costCents: r.costCents, costReason: r.costReason, providerName: r.providerName, insuranceCarrier: r.insuranceCarrier })), new Map(), "2026-11-14");
    expect(s.leaks.patientCanceled).toEqual({ bookings: 1, costCents: 4500 });
    expect(s.leaks.cancellationCharges).toEqual({ bookings: 0, costCents: 0 });
  });

  it("reads a single patient column (Last, First / with DOB under it) and separate date + time columns", () => {
    const rows = parseCsvRows(["Patient,Appointment Date,Time,Cost,Status", `"Sample, Jane Q\nDOB 2/12/2000",2026-03-04,9:30 AM,45,Practice Rescheduled`].join("\n"));
    const p = parseZocdocRows(rows);
    expect(p.rows[0]).toMatchObject({ patientFirst: "Jane", patientLast: "Sample", patientDob: "2000-02-12", appointmentAt: "2026-03-04 09:30", status: "practice_rescheduled", costCents: 4500 });
    expect(splitZocdocName("Jane Q Sample")).toEqual({ first: "Jane", last: "Sample" });
  });

  it("says what's missing when the file lacks the cost or birth dates", () => {
    const p = parseZocdocRows(parseCsvRows("Patient Name,Appointment Date\nJane Sample,2026-01-05"));
    expect(p.missing).toEqual(["cost", "dob"]);
  });

  it("maps ZocDoc's status words", () => {
    expect(zocdocStatus("PracticeCanceled")).toBe("practice_canceled");
    expect(zocdocStatus("Cancelled by patient")).toBe("patient_canceled");
    expect(zocdocStatus("PatientCanceled")).toBe("patient_canceled");
    expect(zocdocStatus("No Show")).toBe("no_show");
    expect(zocdocStatus("Confirmed")).toBe("confirmed");
    expect(zocdocStatus("")).toBe("other");
  });

  it("keys a booking by ZocDoc's ID when there is one, else by who / when / provider (same booking = same key)", () => {
    const base = { appointmentId: null, patientFirst: "Jane", patientLast: "Sample", patientDob: "2000-02-12", appointmentAt: "2026-11-13 17:40", providerName: "Dr. Test One" };
    expect(bookingKeySource({ ...base, appointmentId: "app_123" })).toBe("id:app_123");
    const row = (over: object) => ({ ...base, appointmentDate: "2026-11-13", bookedAt: null, status: "confirmed" as const, statusText: null, patientType: null, costCents: 0, costReason: null, bookingSource: null, locationName: null, insuranceCarrier: null, insurancePlan: null, visitReason: null, ...over });
    expect(bookingKeyOf(row({}))).toBe(bookingKeyOf(row({ status: "patient_canceled", patientFirst: "JANE" })));
    expect(bookingKeyOf(row({}))).not.toBe(bookingKeyOf(row({ appointmentAt: "2026-11-14 17:40" })));
    expect(bookingKeyOf(row({})).length).toBeLessThanOrEqual(80);
  });
});

describe("ZocDoc spend vs. revenue", () => {
  const b = (person: string, appointmentDate: string, over: Partial<ZBooking> = {}): ZBooking => ({
    person, matched: !person.startsWith("u:"), appointmentDate, status: "confirmed", patientType: "new", costCents: 4500, costReason: "cost_initial", providerName: "Dr. Test One", insuranceCarrier: "Sample Health", ...over,
  });
  const c = (date: string, paid: number, owes = 0): ZClaim => ({ date, paidCents: paid, owesCents: owes, billedCents: paid * 2 });

  it("counts spend on every booking, and revenue from charged new patients from their first booking on", () => {
    const bookings = [
      b("p:1", "2026-03-10"),                                                    // came in, paid first visit + later
      b("p:2", "2026-03-15", { status: "practice_canceled" }),                     // charged, practice canceled, never came
      b("p:3", "2026-04-02", { patientType: "existing", costCents: 0 }),           // existing, free
      b("u:jane sample|2000-02-12", "2026-04-20", { status: "no_show" }),          // not in MyPCP
      b("p:4", "2026-11-10"),                                                    // too recent to judge
      b("p:5", "2026-05-01"),                                                    // already our patient (claim before), came in
    ];
    const claims = new Map<string, ZClaim[]>([
      ["p:1", [c("2026-03-11", 20000, 3000), c("2026-03-30", 5000), c("2026-07-01", 7000, 1000)]],
      ["p:3", [c("2026-04-02", 9000)]],
      ["p:5", [c("2026-01-15", 4000), c("2026-05-02", 6000)]],
    ]);
    const s = zocdocSummary(bookings, claims, "2026-11-14");
    expect(s.totals).toMatchObject({
      bookings: 6, chargedBookings: 5, spentCents: 22500, patients: 6, newPatients: 5, chargedPatients: 5, matchedPatients: 4,
      cameIn: 2, judged: 4, pending: 1, alreadyOurs: 1,
      paidFirstCents: 20000 + 5000 + 6000, paidLaterCents: 7000, paidCents: 38000, owesCents: 4000,
    });
    expect(s.leaks.noVisit).toEqual({ patients: 2, notInMyPcp: 1, costCents: 9000 });
    expect(s.leaks.practiceCanceled).toEqual({ bookings: 1, costCents: 4500 });
    expect(s.leaks.noShow).toEqual({ bookings: 1, costCents: 4500 });
    const march = s.months.find((m) => m.key === "2026-03")!;
    expect(march).toMatchObject({ bookings: 2, chargedBookings: 2, costCents: 9000, patients: 2, cameIn: 1, judged: 2, paidCents: 32000 });
    // The existing patient's claims don't count as ZocDoc revenue.
    expect(s.months.find((m) => m.key === "2026-04")!.paidCents).toBe(0);
  });

  it("counts a later booking for the same patient once (first booking sets the window)", () => {
    const s = zocdocSummary([b("p:1", "2026-02-01"), b("p:1", "2026-02-20", { costCents: 0 })], new Map([["p:1", [c("2026-02-21", 10000)]]]), "2026-11-14");
    expect(s.totals).toMatchObject({ patients: 1, chargedPatients: 1, cameIn: 1, paidFirstCents: 10000, spentCents: 4500 });
    expect(s.people[0]).toMatchObject({ bookings: 2, chargedBookings: 1, firstDate: "2026-02-01" });
  });

  it("money lost: only patients who never came (no claim, not seen, nothing booked), with why", () => {
    const bookings = [
      b("p:1", "2026-03-10"),                                                     // came in
      b("p:2", "2026-03-15", { status: "practice_canceled" }),                      // never: practice canceled
      b("p:3", "2026-04-01"),                                                     // came after 45 days
      b("p:4", "2026-05-01"),                                                     // seen, insurance hasn't paid
      b("p:5", "2026-05-05", { status: "patient_canceled" }),                       // has a visit booked
      b("p:6", "2026-06-01"),                                                     // never: kept the booking, no-show on our schedule
      b("u:x|1990-01-01", "2026-07-01", { status: "practice_rescheduled" }),        // never: last booking = patient canceled
      b("u:x|1990-01-01", "2026-07-03", { status: "patient_canceled", costCents: 0 }),
      b("p:7", "2026-11-01"),                                                     // too soon
      b("p:8", "2026-02-01"),                                                     // never (their only visit was before the booking)
      b("p:9", "2026-08-01", { status: "practice_rescheduled" }),                   // never: rescheduled
    ];
    const claims = new Map<string, ZClaim[]>([["p:1", [c("2026-03-11", 9000)]], ["p:3", [c("2026-06-20", 8000)]]]);
    const visits = new Map<string, ZVisit[]>([
      ["p:4", [{ date: "2026-05-02", kind: "seen" }]],
      ["p:5", [{ date: "2026-11-20", kind: "upcoming" }]],
      ["p:6", [{ date: "2026-06-01", kind: "no_show" }]],
      ["p:8", [{ date: "2026-01-15", kind: "seen" }]],
    ]);
    const s = zocdocSummary(bookings, claims, "2026-11-14", visits);
    expect(s.lost).toMatchObject({ patients: 5, judged: 9, costCents: 22500, notInMyPcp: 1, noShowOnSchedule: 1 });
    expect(Object.fromEntries(s.lost.reasons.map((r) => [r.key, r.patients]))).toEqual({ kept_booking: 2, patient_canceled: 1, rescheduled: 1, practice_canceled: 1 });
    expect(s.lost.notLost).toEqual({ came_later: { patients: 1, costCents: 4500 }, seen_no_payment: { patients: 1, costCents: 4500 }, upcoming: { patients: 1, costCents: 4500 } });
    expect(s.lost.months.find((m) => m.key === "2026-03")).toEqual({ key: "2026-03", judged: 2, lost: 1, costCents: 4500 });
    expect(s.lost.months.some((m) => m.key === "2026-11")).toBe(false); // too soon isn't judged
    const outcome = (k: string) => s.people.find((p) => p.person === k)!.outcome;
    expect([outcome("p:1"), outcome("p:3"), outcome("p:4"), outcome("p:5"), outcome("p:7")]).toEqual(["came_in", "came_later", "seen_no_payment", "upcoming", "pending"]);
    // The old 45-day "no visit" count is exactly lost + the three "not lost" groups.
    expect(s.leaks.noVisit.patients).toBe(5 + 3);
    expect(s.leaks.alreadyOurs).toEqual({ patients: 0, costCents: 0 });
  });

  it("is only open to the owner (other admins and staff are refused before anything is read)", async () => {
    const ctxFor = (role: string, realRole?: string): TrpcContext => ({
      user: { id: 97, openId: "zd-test", email: "zd@example.com", name: "ZD Test", loginMethod: "manus", role, realRole, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as NonNullable<TrpcContext["user"]>,
      req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"],
    });
    for (const role of ["staff", "front_desk", "office_manager", "medical_assistant", "billing"]) {
      await expect(appRouter.createCaller(ctxFor(role)).masterBilling.zocdocReport({ from: "2026-01-01", to: "2026-11-14" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(appRouter.createCaller(ctxFor(role)).masterBilling.zocdocImportStart({ fileName: "x.csv", sha256: "a".repeat(64), rowCount: 1, firstDate: null, lastDate: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(appRouter.createCaller(ctxFor("billing", "admin")).masterBilling.zocdocPatients({ from: "2026-01-01", to: "2026-11-14", filter: "all", page: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
