import { describe, expect, it } from "vitest";
import { folderHref, isPatientKey, snippetAround, sortItems } from "../shared/folder";
import { folderSectionsFor } from "./folderDb";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function ctxFor(role: string): TrpcContext {
  const user = { id: 99, openId: "folder-test", email: "folder@example.com", name: "Folder Test", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
  return { user: user as NonNullable<TrpcContext["user"]>, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("patient folders", () => {
  it("each role gets the sub-folders its existing access allows", () => {
    expect(folderSectionsFor("admin")).toEqual(["chart", "visits", "tasks", "comms", "forms", "files", "faxes", "payments", "care", "insurance"]);
    expect(folderSectionsFor("provider")).toEqual(["chart", "visits", "tasks", "comms", "forms", "files", "faxes", "care", "insurance"]); // no payments
    expect(folderSectionsFor("front_desk")).toContain("payments");
    expect(folderSectionsFor("front_desk")).toContain("faxes");
    expect(folderSectionsFor("office_manager")).not.toContain("faxes");
    expect(folderSectionsFor("medical_assistant")).toEqual(folderSectionsFor("front_desk")); // same as the front desk (their clinic only)
    expect(folderSectionsFor("billing")).toEqual([]);
    expect(folderSectionsFor("user")).toEqual([]);
  });

  it("keeps billing and people without a role out", async () => {
    await expect(appRouter.createCaller(ctxFor("billing")).workspace.folder.summary({ key: "p:1" })).rejects.toThrow();
    await expect(appRouter.createCaller(ctxFor("user")).workspace.folder.items({ key: "p:1", section: "everything" })).rejects.toThrow();
  });

  it("only takes real patient keys", async () => {
    expect(isPatientKey("p:12")).toBe(true);
    expect(isPatientKey("s:jane example|1960-01-02")).toBe(true);
    expect(isPatientKey("f:abc-123")).toBe(true);
    expect(isPatientKey("x:1")).toBe(false);
    await expect(appRouter.createCaller(ctxFor("admin")).workspace.folder.summary({ key: "drop table" })).rejects.toThrow();
  });

  it("links to the right place", () => {
    expect(folderHref("p:12")).toBe("/patients/12?tab=folder");
    expect(folderHref("p:12", "faxes")).toBe("/patients/12?tab=folder&s=faxes");
    expect(folderHref("f:abc")).toBe("/folder/f%3Aabc");
    expect(folderHref("s:jane example|1960-01-02", "chart")).toBe("/folder/s%3Ajane%20example%7C1960-01-02?s=chart");
  });

  it("finds the words around a match and sorts newest first", () => {
    expect(snippetAround("Patient reports knee pain after the fall last week", "knee", 10)).toBe("…t reports knee pain afte…");
    expect(snippetAround("nothing here", "knee")).toBeNull();
    expect(sortItems([{ date: "2026-01-02" }, { date: null }, { date: "2026-09-01T10:00:00.000Z" }]).map((x) => x.date)).toEqual(["2026-09-01T10:00:00.000Z", "2026-01-02", null]);
  });
});
