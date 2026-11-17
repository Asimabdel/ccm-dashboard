import { describe, expect, it } from "vitest";
import { cleanGoalChecks, goalIdOf, goalProgress, planChanges, planGoalSummary, problemIdOf, reviewDueOf, type GoalCheck } from "../shared/carePlanProgress";
import { emptyProblem, renderPlanText, type PlanGeneral, type PlanProblem } from "../shared/carePlanDoc";
import { callExtrasText, cleanCallExtras, readingsFor } from "../shared/ccmCall";

// Made-up plan content only.
const dm: PlanProblem = { ...emptyProblem("diabetes_t2", "Type 2 diabetes mellitus (E11.9)", "Type 2 diabetes"), goals: ["A1c below 7.5%", "No low blood sugars"], interventions: ["Monthly call"] };
const htn: PlanProblem = { ...emptyProblem("hypertension", "Essential hypertension", "High blood pressure"), goals: ["Blood pressure below 130/80"], interventions: ["Home BP log"] };
const general: PlanGeneral = { patientGoals: "", medications: "Reconcile monthly.", careTeam: "", community: "", advanceCare: "", followUp: "" };
const check = (p: PlanProblem, goal: string, status: GoalCheck["status"], value = ""): GoalCheck => ({ problemId: problemIdOf(p), goalId: goalIdOf(problemIdOf(p), goal), problem: p.problem, goal, status, value });

describe("Care-plan goals checked on calls", () => {
  it("keeps only well-formed checks, one per goal, and works out each goal's identity itself", () => {
    const clean = cleanGoalChecks([
      { problemId: "diabetes_t2", goal: "A1c below 7.5%", status: "on_track", value: " 7.2 " },
      { problemId: "diabetes_t2", goal: "A1c below 7.5%.", status: "not_yet" }, // same goal (trailing dot): dropped
      { problemId: "diabetes_t2", goal: "No low blood sugars", status: "great" }, // unknown status
      { problemId: "", goal: "x", status: "met" },
      "nonsense",
    ]);
    expect(clean).toEqual([{ problemId: "diabetes_t2", goalId: "diabetes_t2|a1c below 7.5%", problem: "", goal: "A1c below 7.5%", status: "on_track", value: "7.2" }]);
    expect(problemIdOf(emptyProblem(null, "Chronic back pain", "Back pain"))).toBe("dx:chronic back pain");
  });

  it("builds each goal's history, newest first, and flags 3 'not yet' calls in a row", () => {
    const g = "Blood pressure below 130/80";
    const notes = [
      { at: "2026-08-10T15:00:00Z", checks: [check(htn, g, "on_track", "128/80")] },
      { at: "2026-11-12T15:00:00Z", checks: [check(htn, g, "not_yet", "142/90")] },
      { at: "2026-09-12T15:00:00Z", checks: [check(htn, g, "not_yet", "138/86")] },
      { at: "2026-10-12T15:00:00Z", checks: [check(htn, g, "not_yet", "140/88"), check(dm, "A1c below 7.5%", "met", "7.0")] },
    ];
    const pr = goalProgress(notes);
    const bp = pr[goalIdOf("hypertension", g)]!;
    expect(bp.history.map((h) => h.value)).toEqual(["142/90", "140/88", "138/86", "128/80"]);
    expect(bp.latest?.status).toBe("not_yet");
    expect(bp.notYetStreak).toBe(3);
    expect(bp.flag).toBe(true);
    const sum = planGoalSummary([dm, htn], pr);
    expect(sum).toEqual({ total: 3, checked: 2, onTrack: 0, met: 1, notYet: 1, flagged: 1 });
  });

  it("a goal back on track clears the flag", () => {
    const g = "Blood pressure below 130/80";
    const pr = goalProgress([
      { at: "2026-09-01", checks: [check(htn, g, "not_yet")] }, { at: "2026-10-01", checks: [check(htn, g, "not_yet")] },
      { at: "2026-10-15", checks: [check(htn, g, "not_yet")] }, { at: "2026-11-01", checks: [check(htn, g, "on_track")] },
    ]);
    expect(pr[goalIdOf("hypertension", g)]).toMatchObject({ notYetStreak: 0, flag: false });
  });
});

describe("What changed since the provider signed", () => {
  it("lists added and removed lines, and added / removed sections", () => {
    const signed = { problems: [dm, htn], general };
    const now = {
      problems: [{ ...dm, goals: ["A1c below 7%", "No low blood sugars"] }, { ...emptyProblem("copd", "COPD", "COPD"), goals: ["No flare-ups"], interventions: ["Inhaler check"] }],
      general: { ...general, patientGoals: "Walk with my grandkids" },
    };
    const c = planChanges(signed, now);
    expect(c.sections).toEqual([
      { kind: "changed", title: "Type 2 diabetes", fields: [{ label: "Measurable goals", added: ["A1c below 7%"], removed: ["A1c below 7.5%"] }] },
      { kind: "added", title: "COPD", fields: [] },
      { kind: "removed", title: "High blood pressure", fields: [] },
    ]);
    expect(c.general).toEqual([{ label: "Patient's own goals and priorities", before: "", after: "Walk with my grandkids" }]);
    expect(planChanges(signed, signed)).toEqual({ sections: [], general: [] });
  });

  it("the yearly review is due a year after the signature", () => {
    expect(reviewDueOf("2026-11-17T15:00:00Z")).toBe("2027-11-17");
    expect(reviewDueOf(null)).toBeNull();
  });

  it("the text copy names the patient and each section's diagnosis", () => {
    const text = renderPlanText({ problems: [dm], general }, { patientName: "Made-up Patient", dob: "01/02/1950", signedBy: "Dr. Example", signedAt: "2026-11-17T15:00:00Z" });
    expect(text).toContain("Patient: Made-up Patient (DOB 01/02/1950)");
    expect(text).toContain("1. TYPE 2 DIABETES\n  Diagnosis: Type 2 diabetes mellitus (E11.9)");
    expect(text).toContain("Established and signed by Dr. Example on 2026-11-17.");
  });
});

describe("Calls shaped by the patient's conditions", () => {
  it("asks for the readings their conditions call for", () => {
    expect(readingsFor(["diabetes_t2"])).toEqual(["sugar"]);
    expect(readingsFor(["hypertension", "hf_reduced"])).toEqual(["bp", "weight"]);
    expect(readingsFor(["dm_kidney", "obesity"])).toEqual(["bp", "sugar", "weight"]);
    expect(readingsFor(["copd", "depression"])).toEqual([]);
  });

  it("keeps only answered questions and real readings", () => {
    const x = cleanCallExtras({
      readings: { bp: " 132/84 ", sugar: "", weight: 5, other: "x" },
      conditions: [
        { key: "diabetes_t2", label: "Type 2 diabetes", answers: [{ q: "Any lows?", a: "One, on Tuesday" }, { q: "Feet ok?", a: "  " }] },
        { key: "copd", label: "COPD", answers: [{ q: "Inhaler?", a: "" }] },
      ],
    });
    expect(x).toEqual({ readings: { bp: "132/84" }, conditions: [{ key: "diabetes_t2", label: "Type 2 diabetes", answers: [{ q: "Any lows?", a: "One, on Tuesday" }] }] });
    expect(callExtrasText(x)).toEqual(["Blood pressure: 132/84", "Type 2 diabetes:", "  - Any lows? → One, on Tuesday"]);
  });
});
