import { describe, expect, it } from "vitest";
import { doximityAppLink, isTelehealthVisit } from "../shared/doximity";

describe("Doximity Dialer links", () => {
  it("uses the link format from Doximity's own calling library", () => {
    expect(doximityAppLink("(713) 555-0100", "voice")).toBe("doximity://dialer/call/voice?target_number=7135550100&utm_source=mypcp");
    expect(doximityAppLink("+1 713 555 0100", "video")).toBe("doximity://dialer/call/video?target_number=7135550100&utm_source=mypcp");
  });
  it("no link without a usable number", () => {
    expect(doximityAppLink(null, "voice")).toBeNull();
    expect(doximityAppLink("555-0100", "voice")).toBeNull();
  });
});

describe("telehealth visits", () => {
  it("spots video / virtual visit types and reasons", () => {
    expect(isTelehealthVisit("Telehealth Follow-up")).toBe(true);
    expect(isTelehealthVisit("Follow-up", "video visit")).toBe(true);
    expect(isTelehealthVisit("Virtual visit")).toBe(true);
    expect(isTelehealthVisit("Telemedicine")).toBe(true);
    expect(isTelehealthVisit("Follow-up", "BP check")).toBe(false);
    expect(isTelehealthVisit(null)).toBe(false);
  });
});
