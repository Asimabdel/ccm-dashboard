import { describe, expect, it } from "vitest";
import {
  STATUS_LABELS,
  PRIORITY_LABELS,
  ESCALATION_STATUS_LABELS,
  BILLING_STATUS_LABELS,
  statusBadgeClass,
  priorityBadgeClass,
  escalationBadgeClass,
  fmtDate,
  fmtDateTime,
  currentMonthStr,
} from "../client/src/lib/ccm";

describe("CCM status labels", () => {
  it("uses the exact required wording for core statuses", () => {
    expect(STATUS_LABELS.not_started).toBe("Not Started");
    expect(STATUS_LABELS.called_no_answer).toBe("Called No Answer");
    expect(STATUS_LABELS.in_progress).toBe("In Progress");
    expect(STATUS_LABELS.completed).toBe("Completed");
    expect(STATUS_LABELS.ready_for_billing).toBe("Ready for Billing");
    expect(STATUS_LABELS.billed).toBe("Billed");
    expect(STATUS_LABELS.cancelled).toBe("Cancelled");
    expect(STATUS_LABELS.unable_to_reach).toBe("Unable to Reach");
  });
});

describe("CCM priority labels", () => {
  it("maps high/medium/low exactly", () => {
    expect(PRIORITY_LABELS).toEqual({ high: "High", medium: "Medium", low: "Low" });
  });
});

describe("escalation status labels", () => {
  it("maps the four escalation action states exactly", () => {
    expect(ESCALATION_STATUS_LABELS.pending).toBe("Pending");
    expect(ESCALATION_STATUS_LABELS.reviewed).toBe("Reviewed");
    expect(ESCALATION_STATUS_LABELS.action_needed).toBe("Action Needed");
    expect(ESCALATION_STATUS_LABELS.completed).toBe("Completed");
  });
});

describe("billing status labels", () => {
  it("includes ready_for_billing and billed", () => {
    expect(BILLING_STATUS_LABELS.ready_for_billing).toBe("Ready for Billing");
    expect(BILLING_STATUS_LABELS.billed).toBe("Billed");
  });
});

describe("badge class helpers", () => {
  it("return non-empty class strings and fall back for unknown values", () => {
    expect(statusBadgeClass("completed")).toContain("emerald");
    expect(priorityBadgeClass("high")).toContain("rose");
    expect(escalationBadgeClass("action_needed")).toContain("rose");
    expect(statusBadgeClass("__unknown__")).toContain("slate");
  });
});

describe("date + month helpers", () => {
  it("formats dates and returns em dash for nullish", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDateTime(undefined)).toBe("—");
    expect(typeof fmtDate(new Date("2025-01-15"))).toBe("string");
  });

  it("currentMonthStr returns YYYY-MM", () => {
    expect(currentMonthStr()).toMatch(/^\d{4}-\d{2}$/);
  });
});
