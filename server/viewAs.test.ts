import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

/** "View as" is a preview in a cookie: the admin's stored role never changes. */
function ctxFor(role: string, realRole?: string) {
  const set: { name: string; value?: string; cleared?: boolean }[] = [];
  const user = { id: 94, openId: "viewas-test", email: "viewas@example.com", name: "View As", loginMethod: "manus", role, realRole, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
  const ctx = {
    user: user as NonNullable<TrpcContext["user"]>,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {
      cookie: (name: string, value: string) => { set.push({ name, value }); },
      clearCookie: (name: string) => { set.push({ name, cleared: true }); },
    } as unknown as TrpcContext["res"],
  } as TrpcContext;
  return { ctx, set };
}

describe("View as (role preview)", () => {
  it("sets a preview cookie for an admin and clears it when they switch back, even while previewing", async () => {
    const a = ctxFor("admin");
    await appRouter.createCaller(a.ctx).auth.setRole({ role: "staff" });
    expect(a.set).toEqual([{ name: "mypcp_view_as", value: "staff" }]);
    const b = ctxFor("staff", "admin"); // an admin currently previewing
    await appRouter.createCaller(b.ctx).auth.setRole({ role: "admin" });
    expect(b.set).toEqual([{ name: "mypcp_view_as", cleared: true }]);
  });

  it("isn't available to anyone else", async () => {
    await expect(appRouter.createCaller(ctxFor("staff").ctx).auth.setRole({ role: "admin" })).rejects.toThrow(/admin/);
  });
});
