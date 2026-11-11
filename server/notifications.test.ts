import { describe, expect, it } from "vitest";
import { cleanOffKinds, notificationKind } from "../shared/notifications";

describe("notification kinds", () => {
  it("sorts every sender's notifications into the kinds people switch on and off", () => {
    expect(notificationKind("task", "New task assigned to you")).toBe("my_tasks");
    expect(notificationKind("task", "Task assigned to you")).toBe("my_tasks");
    expect(notificationKind("task", "New task for your team")).toBe("team_tasks");
    expect(notificationKind("task", "12 patients qualify for care programs")).toBe("program_approvals");
    expect(notificationKind("task", "1 patient qualify for care programs")).toBe("program_approvals");
    expect(notificationKind("task", "Document to sign")).toBe("documents");
    expect(notificationKind("task", "Document signed by everyone")).toBe("documents");
    expect(notificationKind("task", "Your signature was used")).toBe("documents");
    expect(notificationKind("task", "Your stored signature was updated")).toBe("documents");
    expect(notificationKind("workforce", "Time-off request: Jordan Lee")).toBe("time_off");
    expect(notificationKind("workforce", "Time off approved")).toBe("time_off");
    expect(notificationKind("workforce", "Time clock")).toBe("time_clock");
    expect(notificationKind("workforce", "Punch fix approved")).toBe("time_clock");
    expect(notificationKind("workforce", "Late: Jordan Lee hasn't clocked in (9:00 AM shift Katy)")).toBe("time_clock");
    expect(notificationKind("workforce", "No-show: Jordan Lee (9:00 AM–5:00 PM Katy)")).toBe("time_clock");
    expect(notificationKind("workforce", "Clocked out automatically: Jordan Lee, Mon Nov 9")).toBe("time_clock");
    expect(notificationKind("workforce", "Call-out: Jordan Lee")).toBe("shifts");
    expect(notificationKind("workforce", "A shift is up for grabs")).toBe("shifts");
    expect(notificationKind("workforce", "Schedule change approved")).toBe("shifts");
    expect(notificationKind("refill_request", "New refill request")).toBe("care_updates");
    expect(notificationKind("urgent_symptom", "Urgent symptom flagged")).toBe("patient_safety");
    expect(notificationKind("escalation", "Patient escalated for review")).toBe("patient_safety");
  });
  it("never lets urgent patient alerts be switched off, and drops unknown kinds", () => {
    expect(cleanOffKinds(["team_tasks", "patient_safety", "nonsense", "time_clock"])).toEqual(["team_tasks", "time_clock"]);
    expect(cleanOffKinds(null)).toEqual([]);
  });
});
