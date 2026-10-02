import { describe, expect, it } from "vitest";
import { formatProviderReport, injectionTag, reportDate } from "../shared/dailyReport";
import { can } from "../shared/workspace";

// Made-up patients.
describe("providers' daily report", () => {
  it("matches the practice's format line for line", () => {
    const text = formatProviderReport({
      date: "2026-07-31", provider: "Dr. Sudad", seen: 21,
      testing: [{ name: "Alex Rivera", tests: ["PFT"] }, { name: "Jamie Cole", tests: ["PFT", "RMR"] }],
      newCcm: 4, newRpm: 0,
      injections: [{ name: "Sam Lee", tag: "WL #11" }, { name: "Pat Moss", tag: "WL #8" }],
    });
    expect(text).toBe([
      "Date: 07/31/26",
      "Provider’s Name - Dr. Sudad",
      "Seen: 21",
      "Testing: Alex Rivera (PFT), Jamie Cole (PFT & RMR)",
      "New CCMs: 4",
      "New RPMs: 0",
      "Injections: Sam Lee (WL #11), Pat Moss (WL #8)",
    ].join("\n"));
  });

  it("says None when there's nothing", () => {
    const text = formatProviderReport({ date: "2026-10-02", provider: "NP Maggie", seen: 0, testing: [], newCcm: 0, newRpm: 0, injections: [] });
    expect(text).toContain("Testing: None");
    expect(text).toContain("Injections: None");
  });

  it("names injections", () => {
    expect(injectionTag("wl", null, 11)).toBe("WL #11");
    expect(injectionTag("b12", null, 3)).toBe("B12 #3");
    expect(injectionTag("other", "Vitamin D", null)).toBe("Vitamin D");
    expect(reportDate("2026-01-05")).toBe("01/05/26");
  });

  it("reports are for admins and office managers; anyone with patient access logs injections", () => {
    expect(can("admin", "dailyReports")).toBe(true);
    expect(can("office_manager", "dailyReports")).toBe(true);
    expect(can("provider", "dailyReports")).toBe(false);
    expect(can("medical_assistant", "dailyReports")).toBe(false);
    for (const r of ["admin", "office_manager", "staff", "provider", "front_desk", "medical_assistant"]) expect(can(r, "injections")).toBe(true);
    expect(can("billing", "injections")).toBe(false);
  });
});
