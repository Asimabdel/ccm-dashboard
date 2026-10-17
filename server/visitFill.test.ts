import { describe, expect, it } from "vitest";
import { matchImportToChartVisits, parseVisitTitle, personKeys, planVisitFill } from "../shared/visitFill";

// Fictional people only.
const visitKeys = (name: string, dob: string, patientId: number | null = null) => personKeys({ patientId, names: [name], dob }, "visit");
const apptKeys = (name: string, dob: string | null, patientId: number | null = null) => personKeys({ patientId, names: [name], dob }, "appointment");

describe("parseVisitTitle", () => {
  it("reads the visit date, calendar and provider from Practice Fusion's visit type text", () => {
    expect(parseVisitTitle("2026-10-16; Dr Test's Schedule; Dr Test Person; Demo Practice; 10/17/2026")).toEqual({ date: "2026-10-16", calendar: "Dr Test's Schedule", provider: "Dr Test Person" });
  });
  it("returns nothing for other text", () => {
    expect(parseVisitTitle("Office visit")).toEqual({ date: null, calendar: null, provider: null });
    expect(parseVisitTitle(null).date).toBeNull();
  });
});

describe("personKeys", () => {
  it("matches across a middle name, and by roster link", () => {
    const v = personKeys({ patientId: 7, names: ["Jane Q Sample"], dob: "1950-01-02" }, "visit");
    expect(v).toContain("p:7");
    expect(apptKeys("Jane Sample", "1950-01-02").some((k) => v.includes(k))).toBe(true);
    expect(apptKeys("Someone Else", "1950-01-02", 7).some((k) => v.includes(k))).toBe(true);
  });
  it("uses the name alone only when the schedule row has no DOB", () => {
    const v = visitKeys("Jane Sample", "1950-01-02");
    expect(apptKeys("Jane Sample", null).some((k) => v.includes(k))).toBe(true);
    expect(apptKeys("Jane Sample", "1960-05-05").some((k) => v.includes(k))).toBe(false);
  });
});

describe("planVisitFill", () => {
  const day = "2026-10-15";
  it("marks a scheduled or part-way appointment Seen and leaves seen ones alone", () => {
    const plan = planVisitFill(
      [{ id: "e1", date: day, keys: visitKeys("Ann Alpha", "1940-01-01") }, { id: "e2", date: day, keys: visitKeys("Bob Beta", "1941-01-01") }, { id: "e3", date: day, keys: visitKeys("Cy Gamma", "1942-01-01") }],
      [
        { id: 1, date: day, status: "scheduled", keys: apptKeys("Ann Alpha", "1940-01-01") },
        { id: 2, date: day, status: "roomed", keys: apptKeys("Bob Beta", "1941-01-01") },
        { id: 3, date: day, status: "completed", keys: apptKeys("Cy Gamma", "1942-01-01") },
      ],
    );
    expect(plan.seen).toEqual([{ id: 1, from: "scheduled" }, { id: 2, from: "roomed" }]);
    expect(plan.alreadySeen).toBe(1);
    expect(plan.add).toHaveLength(0);
  });
  it("adds a visit that isn't on the schedule, once, and only on the same day", () => {
    const plan = planVisitFill(
      [{ id: "e1", date: day, keys: visitKeys("Dee Delta", "1943-01-01") }, { id: "e2", date: day, keys: visitKeys("Dee Delta", "1943-01-01") }],
      [{ id: 9, date: "2026-10-14", status: "scheduled", keys: apptKeys("Dee Delta", "1943-01-01") }],
    );
    expect(plan.add.map((v) => v.id)).toEqual(["e1"]);
    expect(plan.duplicates).toBe(1);
    expect(plan.seen).toHaveLength(0);
  });
  it("prefers the seen appointment, and leaves a no-show alone", () => {
    const keys = visitKeys("Eve Echo", "1944-01-01");
    const both = planVisitFill([{ id: "e1", date: day, keys }], [
      { id: 1, date: day, status: "cancelled", keys: apptKeys("Eve Echo", "1944-01-01") },
      { id: 2, date: day, status: "scheduled", keys: apptKeys("Eve Echo", "1944-01-01") },
    ]);
    expect(both.seen).toEqual([{ id: 2, from: "scheduled" }]);
    const noShow = planVisitFill([{ id: "e1", date: day, keys }], [{ id: 1, date: day, status: "no_show", keys: apptKeys("Eve Echo", "1944-01-01") }]);
    expect(noShow.notSeen).toBe(1);
    expect(noShow.add).toHaveLength(0);
  });
});

describe("matchImportToChartVisits", () => {
  const day = "2026-10-15";
  it("lets the file's row take over a visit added from the chart, but not a no-show row", () => {
    const chart = [{ id: 50, date: day, keys: visitKeys("Fay Foxtrot", "1945-01-01") }];
    expect(Array.from(matchImportToChartVisits([{ idx: 0, date: day, status: "completed", keys: apptKeys("Fay Foxtrot", "1945-01-01") }], chart).entries())).toEqual([[0, 50]]);
    expect(matchImportToChartVisits([{ idx: 0, date: day, status: "no_show", keys: apptKeys("Fay Foxtrot", "1945-01-01") }], chart).size).toBe(0);
    expect(matchImportToChartVisits([{ idx: 0, date: "2026-10-16", status: "completed", keys: apptKeys("Fay Foxtrot", "1945-01-01") }], chart).size).toBe(0);
  });
  it("uses each chart row once, preferring a seen row from the file", () => {
    const chart = [{ id: 50, date: day, keys: visitKeys("Gus Golf", "1946-01-01") }];
    const m = matchImportToChartVisits([
      { idx: 0, date: day, status: "scheduled", keys: apptKeys("Gus Golf", "1946-01-01") },
      { idx: 1, date: day, status: "completed", keys: apptKeys("Gus Golf", "1946-01-01") },
    ], chart);
    expect(Array.from(m.entries())).toEqual([[1, 50]]);
  });
});
