import { describe, expect, it } from "vitest";
import { NAV_PREFS_MAX_SHORTCUTS, cleanNavPrefs, navCountPaths } from "../shared/navMenu";

describe("side menu: starred pages and folded sections", () => {
  it("starts empty for anything that isn't a saved menu", () => {
    for (const junk of [null, undefined, "x", 7, [], { shortcuts: "nope", folded: 3 }]) {
      expect(cleanNavPrefs(junk)).toEqual({ shortcuts: [], folded: [] });
    }
  });

  it("keeps real menu paths in the order they were starred, once each", () => {
    expect(cleanNavPrefs({ shortcuts: ["/faxes", "/bookings", "/faxes", " /my-work "], folded: ["Admin", "Admin", "Care Management"] })).toEqual({
      shortcuts: ["/faxes", "/bookings", "/my-work"],
      folded: ["Admin", "Care Management"],
    });
  });

  it("drops anything that isn't a plain page path", () => {
    const { shortcuts } = cleanNavPrefs({ shortcuts: ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "/faxes?x=1", "/Faxes", "", 5, null, "/patient-emails"] });
    expect(shortcuts).toEqual(["/patient-emails"]);
  });

  it("limits how many are kept", () => {
    const many = Array.from({ length: 50 }, (_, i) => `/page-${i}`);
    expect(cleanNavPrefs({ shortcuts: many }).shortcuts).toHaveLength(NAV_PREFS_MAX_SHORTCUTS);
    expect(cleanNavPrefs({ folded: ["x".repeat(41), "Me"] }).folded).toEqual(["Me"]);
  });
});

describe("side menu: who gets which number bubbles", () => {
  it("gives the owner every bubble", () => {
    expect(navCountPaths("admin")).toEqual(["/my-work", "/bookings", "/faxes", "/patient-emails", "/documents", "/intake-forms", "/refill-requests", "/escalations", "/follow-ups"]);
  });

  it("follows what each role can open and act on", () => {
    expect(navCountPaths("front_desk")).toEqual(["/my-work", "/bookings", "/faxes", "/patient-emails", "/documents", "/intake-forms", "/follow-ups"]);
    expect(navCountPaths("medical_assistant")).toEqual(["/my-work", "/bookings", "/faxes", "/patient-emails", "/documents", "/intake-forms", "/follow-ups"]);
    expect(navCountPaths("staff")).toEqual(["/my-work", "/bookings", "/faxes", "/patient-emails", "/documents", "/intake-forms"]);
    // Providers: their own refills and escalations; filing forms and the patient inboxes are office work.
    expect(navCountPaths("provider")).toEqual(["/my-work", "/documents", "/refill-requests", "/escalations"]);
    // The office manager: her office's website bookings, but not the patient inboxes (Faxes, Patient emails).
    expect(navCountPaths("office_manager")).toEqual(["/my-work", "/bookings", "/documents", "/intake-forms"]);
    expect(navCountPaths("billing")).toEqual(["/my-work"]);
  });

  it("gives nothing to a login with no role yet", () => {
    expect(navCountPaths("user")).toEqual([]);
    expect(navCountPaths("")).toEqual([]);
  });
});
