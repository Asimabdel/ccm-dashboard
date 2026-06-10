import { describe, it, expect } from "vitest";
import { parsePatientCsv, findInBatchDuplicates, splitCsvLine } from "../shared/csvImport";

describe("CSV bulk import parser", () => {
  it("rejects CSV missing required headers", () => {
    const { headerError } = parsePatientCsv("firstname,phone\nJane,555");
    expect(headerError).toBeTruthy();
    expect(headerError).toContain("name");
  });

  it("parses a valid CSV with all optional fields", () => {
    const csv = [
      "name,dateOfBirth,phoneNumber,clinic,provider,preferredLanguage,chronicConditions,insurance,riskLevel,consentStatus,rpmEnrolled,rpmDeviceType",
      "Jane Doe,1955-03-12,555-201-3344,Northside,Dr. Lee,English,Hypertension;Type 2 Diabetes,Medicare,high,consented,yes,BP cuff",
    ].join("\n");
    const { rows, headerError } = parsePatientCsv(csv);
    expect(headerError).toBeUndefined();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.name).toBe("Jane Doe");
    expect(r.phoneNumber).toBe("555-201-3344");
    expect(r.chronicConditions).toEqual(["Hypertension", "Type 2 Diabetes"]);
    expect(r.riskLevel).toBe("high");
    expect(r.rpmEnrolled).toBe(true);
    expect(r.rpmDeviceType).toBe("BP cuff");
    expect(r.errors).toHaveLength(0);
  });

  it("flags rows missing name or phone", () => {
    const csv = "name,phoneNumber\n,555-1234\nJohn,";
    const { rows } = parsePatientCsv(csv);
    expect(rows[0].errors).toContain("Name is required");
    expect(rows[1].errors).toContain("Phone number is required");
  });

  it("flags invalid riskLevel and consentStatus", () => {
    const csv = "name,phoneNumber,riskLevel,consentStatus\nJane,555,urgent,maybe";
    const { rows } = parsePatientCsv(csv);
    expect(rows[0].errors.some((e) => e.includes("riskLevel"))).toBe(true);
    expect(rows[0].errors.some((e) => e.includes("consentStatus"))).toBe(true);
  });

  it("flags invalid date of birth", () => {
    const csv = "name,phoneNumber,dateOfBirth\nJane,555,not-a-date";
    const { rows } = parsePatientCsv(csv);
    expect(rows[0].errors.some((e) => e.includes("dateOfBirth"))).toBe(true);
  });

  it("parses rpmEnrolled no/false as false", () => {
    const csv = "name,phoneNumber,rpmEnrolled\nJane,555,no\nJohn,556,false";
    const { rows } = parsePatientCsv(csv);
    expect(rows[0].rpmEnrolled).toBe(false);
    expect(rows[1].rpmEnrolled).toBe(false);
  });

  it("handles quoted fields with embedded commas", () => {
    expect(splitCsvLine('"Doe, Jane",555,"a;b"')).toEqual(["Doe, Jane", "555", "a;b"]);
  });

  it("detects duplicate names within the batch (case-insensitive)", () => {
    const csv = "name,phoneNumber\nJane Doe,555\njane  doe,556\nJohn Smith,557";
    const { rows } = parsePatientCsv(csv);
    const dups = findInBatchDuplicates(rows);
    // both Jane Doe rows flagged (row 2 and 3), John not flagged
    expect(dups.has(2)).toBe(true);
    expect(dups.has(3)).toBe(true);
    expect(dups.has(4)).toBe(false);
  });
});
