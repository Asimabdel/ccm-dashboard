import { describe, expect, it } from "vitest";
import { matchProviderId, matchWorklistStatus, normalizeProviderName, parsePatientCsv } from "../shared/csvImport";

const PROVIDERS = [
  { id: 1, name: "Sudad Al Hadad" },
  { id: 2, name: "Yilian Almaguer Simon" },
  { id: 3, name: "Mai Ismail" },
];

describe("normalizeProviderName", () => {
  it("strips titles, credentials, and punctuation", () => {
    expect(normalizeProviderName("Dr. Sudad")).toBe("sudad");
    expect(normalizeProviderName("Sudad Al Hadad, MD")).toBe("sudad al hadad");
    expect(normalizeProviderName("  DR   SUDAD  ")).toBe("sudad");
  });
});

describe("matchProviderId — consolidates name variations onto one provider", () => {
  it("matches the full canonical name", () => {
    expect(matchProviderId("Sudad Al Hadad", PROVIDERS)).toBe(1);
    expect(matchProviderId("sudad al hadad", PROVIDERS)).toBe(1);
    expect(matchProviderId("Sudad Al Hadad, MD", PROVIDERS)).toBe(1);
  });

  it("matches partial / titled variations to the same provider", () => {
    expect(matchProviderId("Dr Sudad", PROVIDERS)).toBe(1);
    expect(matchProviderId("Dr. Sudad", PROVIDERS)).toBe(1);
    expect(matchProviderId("Dr. Mai", PROVIDERS)).toBe(3);
    expect(matchProviderId("Yilian Almaguer", PROVIDERS)).toBe(2);
  });

  it("returns null when nothing matches (left unset on import)", () => {
    expect(matchProviderId("Dr. Nobody", PROVIDERS)).toBeNull();
    expect(matchProviderId("", PROVIDERS)).toBeNull();
    expect(matchProviderId(undefined, PROVIDERS)).toBeNull();
  });

  it("does not match on a single shared first name alone", () => {
    // "John Smith" shares only "john" with "John Doe" — not enough to match.
    expect(matchProviderId("John Smith", [{ id: 9, name: "John Doe" }])).toBeNull();
  });

  it("matches via aliases when the file name shares no words with the stored name", () => {
    // Real case: system stores "Al Hadad" / "Maggie" but the sheet says Dr. Sudad / Dr. Magdalene.
    const withAliases = [
      { id: 2, name: "Al Hadad", aliases: ["Sudad"] },
      { id: 4, name: "Maggie", aliases: ["Magdalene"] },
      { id: 1, name: "Mansour", aliases: [] },
    ];
    expect(matchProviderId("Dr. Sudad", withAliases)).toBe(2);
    expect(matchProviderId("Dr. Magdalene", withAliases)).toBe(4);
    expect(matchProviderId("Dr. Mansour", withAliases)).toBe(1);
    expect(matchProviderId("Dr. Nobody", withAliases)).toBeNull();
  });
});

describe("matchWorklistStatus — maps file status to the dropdown options", () => {
  it("maps the real values seen in exports", () => {
    expect(matchWorklistStatus("Completed")).toBe("completed");
    expect(matchWorklistStatus("Not Answer try again")).toBe("called_no_answer");
    expect(matchWorklistStatus("Wellness Call")).toBe("not_started");
    expect(matchWorklistStatus("Left VM")).toBe("voicemail_left");
    expect(matchWorklistStatus("Wrong Number")).toBe("wrong_number");
    expect(matchWorklistStatus("Needs appointment")).toBe("needs_appointment");
  });

  it("matches canonical labels exactly (case-insensitive)", () => {
    expect(matchWorklistStatus("ready for billing")).toBe("ready_for_billing");
    expect(matchWorklistStatus("DECLINED")).toBe("declined_ccm");
    expect(matchWorklistStatus("In Progress")).toBe("in_progress");
  });

  it("handles the administrative / no-response values in real sheets", () => {
    expect(matchWorklistStatus("No response")).toBe("called_no_answer");
    expect(matchWorklistStatus("No response twice")).toBe("called_no_answer");
    expect(matchWorklistStatus("Not Completed")).toBe("not_started");
    expect(matchWorklistStatus("Completed by Salma")).toBe("completed");
    expect(matchWorklistStatus("Deny CCM Care")).toBe("declined_ccm");
    expect(matchWorklistStatus("Insurance Inactive")).toBe("inactive");
    expect(matchWorklistStatus("PCP Changed")).toBe("inactive");
    expect(matchWorklistStatus("Insurance Changed")).toBe("inactive");
  });

  it("returns null for blank/unknown so the task uses the default", () => {
    expect(matchWorklistStatus("")).toBeNull();
    expect(matchWorklistStatus(undefined)).toBeNull();
    expect(matchWorklistStatus("xyzzy")).toBeNull();
  });
});

describe("parsePatientCsv — Patient/Provider/Completion Status sheet", () => {
  const CSV = [
    "Patient,Provider,Completion Status,Date CCM Completed ,,,,,,,,,,Notes ",
    "Saarah Sultana,Dr. Sudad,Completed,6/1,,,,,,,,,,",
    '"Thompson, Sonya",Dr. Sudad,Completed,6/2,,,,,,,,,,',
    "Terrell Taylor,Dr. Sudad,Insurance Inactive ,,,,,,,,,,,",
    ",,,,,,,,,,,,,",
    ",,,,,,,,,,,,,",
  ].join("\n");

  it("recognizes the header (no longer 'unknown')", () => {
    const { template, headerError } = parsePatientCsv(CSV);
    expect(headerError).toBeUndefined();
    expect(template).toBe("drmai");
  });

  it("parses names (incl. 'Last, First'), provider, and status; skips blank rows", () => {
    const { rows } = parsePatientCsv(CSV);
    expect(rows).toHaveLength(3); // two trailing blank rows dropped
    expect(rows[0].name).toBe("Saarah Sultana");
    expect(rows[0].provider).toBe("Dr. Sudad");
    expect(rows[0].wellnessCallStatus).toBe("Completed");
    expect(rows[1].name).toBe("Sonya Thompson");
    expect(rows[0].errors).toHaveLength(0);
  });
});

describe("parsePatientCsv — header-less CCM call list", () => {
  const CSV = [
    "Elvon Jarrett,Dr. Mansour,Active,Completed,06/09,,,,Elvis Angulo,Active,Completed,06/15",
    "Dalia,Mendoza,Active,Completed,Done,,,,,,,",
    '"Mirza, Afaf",Dr. Sudad,Active,Completed,Done by Ahmad,,,,,,,',
    "ROBIN WILLIAMS,Dr. Mansour,Inactive,Not Completed,Insurance INACTIVE,,,,,,,",
  ].join("\n");

  it("detects the header-less list (first row is data, not a header)", () => {
    const { template, headerError } = parsePatientCsv(CSV);
    expect(headerError).toBeUndefined();
    expect(template).toBe("ccmlist");
  });

  it("handles full names + provider, split first/last names, 'Last, First', enrollment, and the side-by-side second patient", () => {
    const { rows } = parsePatientCsv(CSV);
    expect(rows.map((r) => r.name)).toEqual([
      "Elvon Jarrett", "Elvis Angulo", "Dalia Mendoza", "Afaf Mirza", "ROBIN WILLIAMS",
    ]);
    expect(rows[0].provider).toBe("Dr. Mansour");
    expect(rows[0].enrollmentStatus).toBe("active");
    expect(rows[1].provider).toBeUndefined(); // second patient block has no provider
    expect(rows[2].provider).toBeUndefined(); // "Dalia Mendoza" was a split name, not a provider
    expect(rows[3].provider).toBe("Dr. Sudad");
    expect(rows[4].enrollmentStatus).toBe("inactive");
    expect(rows[4].wellnessCallStatus).toBe("Not Completed");
    expect(rows[4].completed).toBe(false);
  });
});
