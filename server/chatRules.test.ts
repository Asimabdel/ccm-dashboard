import { describe, expect, it } from "vitest";
import { canAnnounce, canPinIn, canPostIn, findMentions, likeContains, mentionName, presenceFor, shortPatientName, snippetAround, splitMentions } from "../shared/chat";

// Made-up staff and patients only.
const people = [
  { id: 1, name: "Rosa Diaz (MA)" },
  { id: 2, name: "Dr. Sarah Chen" },
  { id: 3, name: "Sara Lee" },
];

describe("@mentions", () => {
  it("names people without the note in brackets", () => {
    expect(mentionName("Rosa Diaz (MA)")).toBe("Rosa Diaz");
    expect(mentionName("Dr. Sarah Chen")).toBe("Dr. Sarah Chen");
  });

  it("finds who a message mentions, ignoring case, not inside other words or emails", () => {
    expect(findMentions("@rosa diaz can you room the 2pm?", people)).toEqual([1]);
    expect(findMentions("Thanks @Dr. Sarah Chen and @Rosa Diaz.", people).sort()).toEqual([1, 2]);
    expect(findMentions("email rosa@Rosa Diaz.com", people)).toEqual([]);
    expect(findMentions("@Sara Leeway is not a person", people)).toEqual([]);
    expect(findMentions("no mentions here", people)).toEqual([]);
  });

  it("splits text for highlighting", () => {
    expect(splitMentions("Hi @Rosa Diaz, ready?", ["Rosa Diaz (MA)"])).toEqual([
      { text: "Hi ", mention: false }, { text: "@Rosa Diaz", mention: true }, { text: ", ready?", mention: false },
    ]);
    expect(splitMentions("plain", [])).toEqual([{ text: "plain", mention: false }]);
  });
});

describe("Patient Flow message", () => {
  it("shortens the patient's name (the chip has the full name)", () => {
    expect(shortPatientName("Smith, James")).toBe("James S.");
    expect(shortPatientName("James Smith")).toBe("James S.");
    expect(shortPatientName("Cher")).toBe("Cher");
  });
});

describe("Who's in today", () => {
  const shift = { startTime: "09:00", endTime: "17:00", status: "scheduled" };
  const base = { clockedIn: false, clockedOutToday: false, timeOff: false, shifts: [shift], usesTimeClock: true, now: 10 * 60 };

  it("on the clock beats everything", () => {
    expect(presenceFor({ ...base, clockedIn: true, timeOff: true }).status).toBe("in");
  });
  it("time off and called out show as off", () => {
    expect(presenceFor({ ...base, timeOff: true })).toEqual({ status: "off", label: "On time off today" });
    expect(presenceFor({ ...base, shifts: [{ ...shift, status: "called_out" }] })).toEqual({ status: "off", label: "Out today" });
  });
  it("time-clock staff are scheduled until they clock in", () => {
    expect(presenceFor(base).status).toBe("scheduled");
    expect(presenceFor({ ...base, now: 8 * 60 })).toEqual({ status: "scheduled", label: "In at 9:00 AM" });
    expect(presenceFor({ ...base, clockedOutToday: true }).label).toBe("Clocked out");
    expect(presenceFor({ ...base, now: 18 * 60 }).label).toBe("Done for today");
  });
  it("people not on the time clock (providers) are in during their hours", () => {
    expect(presenceFor({ ...base, usesTimeClock: false })).toEqual({ status: "in", label: "Working until 5:00 PM" });
  });
  it("no shift: not scheduled", () => {
    expect(presenceFor({ ...base, shifts: [] })).toEqual({ status: "none", label: "Not scheduled today" });
  });
});

describe("announcements, pins and search", () => {
  it("lets only admins and office managers post in an announcement-only conversation", () => {
    expect(canPostIn("staff", { postingRestricted: false })).toBe(true);
    expect(canPostIn("medical_assistant", { postingRestricted: true })).toBe(false);
    expect(canPostIn("provider", { postingRestricted: true })).toBe(false);
    expect(canPostIn("admin", { postingRestricted: true })).toBe(true);
    expect(canPostIn("office_manager", { postingRestricted: true })).toBe(true);
    expect(canAnnounce("front_desk")).toBe(false);
  });

  it("lets anyone pin in their own conversations, but only admins / office managers in the built-in channels", () => {
    for (const kind of ["dm", "group", "patient"]) expect(canPinIn("staff", kind)).toBe(true);
    for (const kind of ["everyone", "clinic", "team"]) {
      expect(canPinIn("medical_assistant", kind)).toBe(false);
      expect(canPinIn("office_manager", kind)).toBe(true);
    }
  });

  it("searches for the words typed, with % and _ taken literally", () => {
    expect(likeContains("call back")).toBe("%call back%");
    expect(likeContains("50%_off")).toBe(String.raw`%50\%\_off%`);
    expect(likeContains(String.raw`a\b`)).toBe(String.raw`%a\\b%`);
  });

  it("shows the part of a message around the match", () => {
    const body = `Reminder for the front desk: ${"x".repeat(80)} please call Mrs. Example back about her refill today ${"y".repeat(80)}`;
    const s = snippetAround(body, "call mrs");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s.toLowerCase()).toContain("call mrs. example back");
    expect(snippetAround("Short note", "zzz")).toBe("Short note");
  });
});
