import { describe, expect, it } from "vitest";
import { actionForWord, isFindAction, parseFindQuery } from "../shared/findAnything";
import { cleanRecentKeys, withRecent, RECENT_PATIENTS_MAX } from "./recentPatientsDb";

// Made-up names only.
describe("Find anything: reading what was typed", () => {
  it("finds the action and leaves the patient to look for", () => {
    expect(parseFindQuery("note maria")).toEqual({ action: "excuse", rest: "maria" });
    expect(parseFindQuery("forms Daniel Garcia")).toEqual({ action: "forms", rest: "Daniel Garcia" });
    expect(parseFindQuery("call 0142")).toEqual({ action: "call", rest: "0142" });
    expect(parseFindQuery("maria excuse")).toEqual({ action: "excuse", rest: "maria" });
    expect(parseFindQuery("insurance 03/14/1958")).toEqual({ action: "insurance", rest: "03/14/1958" });
  });
  it("drops the little words once it knows the action", () => {
    expect(parseFindQuery("send a note to maria")).toEqual({ action: "excuse", rest: "maria" });
    expect(parseFindQuery("follow up with dan")).toEqual({ action: "task", rest: "dan" });
    // Without an action they could be part of a name, so they stay.
    expect(parseFindQuery("ana de la cruz")).toEqual({ action: null, rest: "ana de la cruz" });
  });
  it("is just a search when no action word is typed", () => {
    expect(parseFindQuery("maria lopez")).toEqual({ action: null, rest: "maria lopez" });
    expect(parseFindQuery("  ")).toEqual({ action: null, rest: "" });
  });
  it("reads every word as the patient once an action is picked", () => {
    expect(parseFindQuery("note maria", "forms")).toEqual({ action: "forms", rest: "note maria" });
  });
  it("needs 3+ letters, and never takes a number or the middle of a word", () => {
    expect(actionForWord("no")).toBeNull();
    expect(actionForWord("not")).toBe("excuse");
    expect(actionForWord("0142")).toBeNull();
    expect(actionForWord("pham")).toBeNull();
    expect(actionForWord("FAX")).toBe("fax");
    expect(isFindAction("excuse")).toBe(true);
    expect(isFindAction("delete")).toBe(false);
    expect(isFindAction(null)).toBe(false);
  });
});

describe("Recent patients list", () => {
  it("keeps patient keys only, newest first, no repeats, at most 8", () => {
    expect(cleanRecentKeys(["p:1", "p:1", "junk", 5, "s:made up|1970-01-01", "f:abc"])).toEqual(["p:1", "s:made up|1970-01-01", "f:abc"]);
    expect(cleanRecentKeys(null)).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => `p:${i + 1}`);
    expect(cleanRecentKeys(many)).toHaveLength(RECENT_PATIENTS_MAX);
    expect(withRecent(["p:1", "p:2", "p:3"], "p:3")).toEqual(["p:3", "p:1", "p:2"]);
    expect(withRecent(many.slice(0, 8), "p:99")).toEqual(["p:99", ...many.slice(0, 7)]);
  });
});
