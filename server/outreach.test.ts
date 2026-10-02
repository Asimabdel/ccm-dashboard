import { describe, expect, it } from "vitest";
import { addBusinessDays, callScript, outreachState, type OutreachCall } from "../shared/outreach";

const at = (day: string, hour = 10) => Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
const call = (day: string, outcome: string | null, callBackOn: string | null = null, hour = 10): OutreachCall => ({ at: at(day, hour), day, outcome, callBackOn });
// Thursday 2026-10-01 / Friday 10-02 / Monday 10-05 / Tuesday 10-06 / Wednesday 10-07.

describe("business days", () => {
  it("skips weekends", () => {
    expect(addBusinessDays("2026-10-01", 2)).toBe("2026-10-05"); // Thu + 2 → Mon
    expect(addBusinessDays("2026-10-02", 1)).toBe("2026-10-05"); // Fri + 1 → Mon
  });
  it("skips clinic holidays", () => {
    expect(addBusinessDays("2026-12-24", 1)).toBe("2026-12-28"); // Christmas, then the weekend
  });
});

describe("where a patient stands on a call list", () => {
  it("not called yet", () => {
    expect(outreachState([], null, "2026-10-02")).toMatchObject({ status: "to_call", tries: 0, label: "Not called yet" });
  });

  it("no answer: waits 2 business days, then it's try #2", () => {
    const calls = [call("2026-10-01", "no_answer")];
    expect(outreachState(calls, null, "2026-10-02")).toMatchObject({ status: "waiting", tries: 1, next: "2026-10-05" });
    expect(outreachState(calls, null, "2026-10-05")).toMatchObject({ status: "to_call", tries: 1, label: "Try #2" });
  });

  it("several calls on one day are one try; unrecorded calls count as tries", () => {
    const calls = [call("2026-10-01", "voicemail", null, 15), call("2026-10-01", "no_answer", null, 9)];
    expect(outreachState(calls, null, "2026-10-05").tries).toBe(1);
    expect(outreachState([call("2026-10-01", null)], null, "2026-10-05").tries).toBe(1);
  });

  it("3 tries without reaching them: unreachable", () => {
    const calls = [call("2026-10-07", "voicemail"), call("2026-10-05", "no_answer"), call("2026-10-01", "no_answer")];
    expect(outreachState(calls, null, "2026-10-08")).toMatchObject({ status: "unreachable", tries: 3 });
  });

  it("tries start over once they were reached", () => {
    const calls = [call("2026-10-07", "no_answer"), call("2026-10-05", "call_back", "2026-10-06"), call("2026-10-01", "no_answer"), call("2026-09-29", "no_answer")];
    expect(outreachState(calls, null, "2026-10-08")).toMatchObject({ status: "waiting", tries: 1 });
  });

  it("call back: waits for the day they asked for", () => {
    const calls = [call("2026-10-01", "call_back", "2026-10-06")];
    expect(outreachState(calls, null, "2026-10-02")).toMatchObject({ status: "waiting", next: "2026-10-06" });
    expect(outreachState(calls, null, "2026-10-06")).toMatchObject({ status: "to_call", label: "Call back today" });
  });

  it("booked / declined / wrong number end it", () => {
    expect(outreachState([call("2026-10-01", "booked")], null, "2026-10-02").status).toBe("booked");
    expect(outreachState([call("2026-10-01", "declined")], null, "2026-10-02")).toMatchObject({ status: "closed", label: "Declined" });
    expect(outreachState([call("2026-10-01", "wrong_number")], null, "2026-10-02")).toMatchObject({ status: "closed", label: "Wrong number" });
  });

  it("a list action closes it, unless a call came after it", () => {
    expect(outreachState([], { action: "dismissed", at: at("2026-10-01") }, "2026-10-02")).toMatchObject({ status: "closed", label: "Dismissed" });
    const later = [call("2026-10-02", "no_answer", null, 14)];
    expect(outreachState(later, { action: "reviewed", at: at("2026-10-01") }, "2026-10-02").status).toBe("waiting");
  });
});

describe("what to say", () => {
  const fill = { me: "Rosa", clinic: "MyPCP Dr - Katy", clinicPhone: "(281) 555-0100", provider: "Dr. Chen", patient: "James" };
  it("fills in the script, and the voicemail has no health details", () => {
    const s = callScript("diabetes_follow_up", "en", fill)!;
    expect(s.call).toContain("diabetes");
    expect(s.call).toContain("Dr. Chen");
    expect(s.voicemail).not.toMatch(/diabetes|check-up|blood/i);
    expect(s.voicemail).toContain("(281) 555-0100");
    expect(callScript("lapsed_follow_up", "es", fill)!.call).toContain("seguimiento");
  });
  it("lists without a calling goal have no script", () => {
    expect(callScript("ccm_eligible", "en", fill)).toBeNull();
  });
});
