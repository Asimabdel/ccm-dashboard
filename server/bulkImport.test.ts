import { describe, it, expect } from "vitest";
import {
  parsePatientCsv,
  findInBatchDuplicates,
  splitCsvLine,
  normalizePersonName,
  parseFlexibleDate,
  detectTemplate,
} from "../shared/csvImport";

describe("CSV bulk import parser", () => {
  it("rejects files with no recognizable name column", () => {
    const { headerError } = parsePatientCsv("foo,bar\nJane,555");
    expect(headerError).toBeTruthy();
    expect(headerError).toContain("name");
  });

  it("detects the Dr.Mai CCMs template", () => {
    const csv = `Name,Provider,Wellness Call,Date Completed,Next Appointment,Notes
"Doe, Jane",Dr. Mai,Completed,6/3,8/15,Doing well`;
    expect(detectTemplate(splitCsvLine(csv.split("\n")[0]))).toBe("drmai");
    const { rows, template, headerError } = parsePatientCsv(csv, { defaultYear: 2026 });
    expect(headerError).toBeUndefined();
    expect(template).toBe("drmai");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Jane Doe"); // "Last, First" normalized
    expect(rows[0].provider).toBe("Dr. Mai");
    expect(rows[0].completed).toBe(true);
    expect(rows[0].lastCalled).toBe("2026-06-03");
    expect(rows[0].nextAppointment).toBe("2026-08-15");
    expect(rows[0].errors).toHaveLength(0);
  });

  it("detects the Chart Notes Report template and marks rows completed", () => {
    const csv = `PATIENT NAME,CHART NOTE TYPE,SERVICE DATE,PROVIDER,SIGNED
"Bello, Idris",CCM,05/31/2026,Dr. Smith,Yes`;
    const { rows, template } = parsePatientCsv(csv, { defaultYear: 2026 });
    expect(template).toBe("chartnotes");
    expect(rows[0].name).toBe("Idris Bello");
    expect(rows[0].completed).toBe(true);
    expect(rows[0].lastCalled).toBe("2026-05-31");
  });

  it("requires only the patient name (other info optional)", () => {
    const csv = `Name,Provider,Wellness Call,Date Completed,Next Appointment,Notes
,Dr. Mai,Completed,6/3,,
"Smith, John",,,,`;
    const { rows } = parsePatientCsv(csv);
    expect(rows[0].errors).toContain("Patient name is required");
    expect(rows[1].errors).toHaveLength(0); // missing everything except name is fine
  });

  it("normalizes 'Last, First' names and leaves 'First Last' untouched", () => {
    expect(normalizePersonName("Doe, Jane")).toBe("Jane Doe");
    expect(normalizePersonName("Jane Doe")).toBe("Jane Doe");
    expect(normalizePersonName("  Smith ,  John ")).toBe("John Smith");
  });

  it("parses flexible date formats", () => {
    expect(parseFlexibleDate("6/3", 2026)).toBe("2026-06-03");
    expect(parseFlexibleDate("06/03/2026")).toBe("2026-06-03");
    expect(parseFlexibleDate("6/3/24")).toBe("2024-06-03");
    expect(parseFlexibleDate("2026-06-03")).toBe("2026-06-03");
    expect(parseFlexibleDate("")).toBeUndefined();
    expect(parseFlexibleDate("not a date")).toBeUndefined();
  });

  it("handles quoted fields containing commas", () => {
    expect(splitCsvLine('a,"b, c",d')).toEqual(["a", "b, c", "d"]);
  });

  it("flags duplicate names within the same batch", () => {
    const csv = `Name,Provider,Wellness Call,Date Completed,Next Appointment,Notes
"Doe, Jane",P1,Completed,,,
"Doe, Jane",P2,Completed,,,
"Smith, John",P3,Completed,,,`;
    const { rows } = parsePatientCsv(csv);
    const dups = findInBatchDuplicates(rows);
    expect(dups.size).toBe(2); // both Jane Doe rows flagged
    expect(dups.has(2)).toBe(true);
    expect(dups.has(3)).toBe(true);
    expect(dups.has(4)).toBe(false); // John not flagged
  });
});
