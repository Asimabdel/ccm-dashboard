import { describe, expect, it } from "vitest";
import { matchProviderId, matchWorklistStatus, normalizeProviderName } from "../shared/csvImport";

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

  it("returns null for blank/unknown so the task uses the default", () => {
    expect(matchWorklistStatus("")).toBeNull();
    expect(matchWorklistStatus(undefined)).toBeNull();
    expect(matchWorklistStatus("xyzzy")).toBeNull();
  });
});
