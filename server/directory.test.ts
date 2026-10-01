import { describe, expect, it } from "vitest";
import { directoryStatus, inStatus, matchesQuery, parseDirectoryQuery } from "../shared/directory";
import { displayName } from "./directoryDb";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function ctxFor(role: string): TrpcContext {
  const user = { id: 98, openId: "directory-test", email: "directory@example.com", name: "Directory Test", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
  return { user: user as NonNullable<TrpcContext["user"]>, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("patients list (everyone at the clinics)", () => {
  const today = "2026-10-01";

  it("counts someone as active when seen in the last 3 years or booked", () => {
    expect(directoryStatus({ lastVisit: "2024-01-15", firstVisit: "2015-03-01", nextVisit: null }, today)).toEqual({ active: true, isNew: false });
    expect(directoryStatus({ lastVisit: "2023-09-30", firstVisit: "2015-03-01", nextVisit: null }, today).active).toBe(false);
    expect(directoryStatus({ lastVisit: "2019-01-01", firstVisit: "2010-01-01", nextVisit: "2026-10-20T15:00:00.000Z" }, today).active).toBe(true);
    expect(directoryStatus({ lastVisit: null, firstVisit: null, nextVisit: null }, today).active).toBe(false);
  });

  it("marks new patients: first visit in the last 90 days, or booked and never seen", () => {
    expect(directoryStatus({ lastVisit: "2026-09-01", firstVisit: "2026-08-15", nextVisit: null }, today).isNew).toBe(true);
    expect(directoryStatus({ lastVisit: "2026-09-01", firstVisit: "2026-01-15", nextVisit: null }, today).isNew).toBe(false);
    expect(directoryStatus({ lastVisit: null, firstVisit: null, nextVisit: "2026-10-03T14:00:00.000Z" }, today).isNew).toBe(true);
    // CCM-roster patients are established, whatever the dates on file say.
    expect(directoryStatus({ lastVisit: "2026-09-01", firstVisit: "2026-08-15", nextVisit: null, established: true }, today).isNew).toBe(false);
    const s = directoryStatus({ lastVisit: "2026-09-01", firstVisit: "2026-08-15", nextVisit: null }, today);
    expect([inStatus("active", s), inStatus("new", s), inStatus("inactive", s), inStatus("all", s)]).toEqual([true, true, false, true]);
  });

  it("reads names, dates of birth and phone numbers out of the search box", () => {
    expect(parseDirectoryQuery("Garcia, Maria")).toEqual({ words: ["maria", "garcia"], dob: null, digits: null });
    expect(parseDirectoryQuery("maria 3/7/1961")).toEqual({ words: ["maria"], dob: "1961-03-07", digits: null });
    expect(parseDirectoryQuery("1961-03-07").dob).toBe("1961-03-07");
    expect(parseDirectoryQuery("03/07/61").dob).toBe("1961-03-07");
    expect(parseDirectoryQuery("(713) 555-0142")).toEqual({ words: [], dob: null, digits: "7135550142" });
    expect(parseDirectoryQuery("5550142").digits).toBe("5550142");
  });

  it("matches every name word, the exact birthday and phone or MRN digits", () => {
    const p = { nameKey: "maria elena garcia", dob: "1961-03-07", phoneDigits: "7135550142", mrn: "PF-88812" };
    expect(matchesQuery(p, parseDirectoryQuery("garcia maria"))).toBe(true);
    expect(matchesQuery(p, parseDirectoryQuery("gar mar"))).toBe(true);
    expect(matchesQuery(p, parseDirectoryQuery("garcia jose"))).toBe(false);
    expect(matchesQuery(p, parseDirectoryQuery("garcia 3/7/1961"))).toBe(true);
    expect(matchesQuery(p, parseDirectoryQuery("garcia 3/8/1961"))).toBe(false);
    expect(matchesQuery(p, parseDirectoryQuery("555-0142"))).toBe(true);
    expect(matchesQuery(p, parseDirectoryQuery("88812"))).toBe(true);
  });

  it("shows ALL-CAPS and Last, First names the same way as the rest", () => {
    expect(displayName("GARCIA, MARIA ELENA")).toBe("Maria Elena Garcia");
    expect(displayName("O'NEIL-SMITH, JOHN")).toBe("John O'Neil-Smith");
    expect(displayName("Maria McDonald")).toBe("Maria McDonald");
  });

  it("is for staff with the patient view; billing and people without a role are kept out", async () => {
    await expect(appRouter.createCaller(ctxFor("billing")).workspace.directory.list({})).rejects.toThrow(/access/);
    await expect(appRouter.createCaller(ctxFor("user")).workspace.directory.list({})).rejects.toThrow();
    await expect(appRouter.createCaller(ctxFor("billing")).workspace.patients.byKey({ key: "f:abc" })).rejects.toThrow(/access/);
    await expect(appRouter.createCaller(ctxFor("front_desk")).workspace.patients.byKey({ key: "nonsense" })).rejects.toThrow();
  });
});
