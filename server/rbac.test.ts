import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function ctxFor(role: string): TrpcContext {
  const user: AuthenticatedUser = {
    id: 99,
    openId: "rbac-test",
    email: "rbac@example.com",
    name: "RBAC Test",
    loginMethod: "manus",
    role: role as AuthenticatedUser["role"],
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("role-based access control", () => {
  it("blocks non-admin from admin.stats", async () => {
    const caller = appRouter.createCaller(ctxFor("front_desk"));
    await expect(caller.admin.stats({ month: "2025-01" })).rejects.toThrow();
  });

  it("blocks non-billing/admin roles from billing.list", async () => {
    const caller = appRouter.createCaller(ctxFor("front_desk"));
    await expect(caller.billing.list({ month: "2025-01" })).rejects.toThrow();
  });

  it("blocks staff from staff.workload (admin-only)", async () => {
    const caller = appRouter.createCaller(ctxFor("staff"));
    await expect(caller.staff.workload({ month: "2025-01" })).rejects.toThrow();
  });
});
