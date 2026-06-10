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

  it("prevents a non-admin worker from self-escalating via auth.setRole", async () => {
    const caller = appRouter.createCaller(ctxFor("staff"));
    await expect(caller.auth.setRole({ role: "admin" })).rejects.toThrow();
  });

  it("blocks non-admin from listing users (Team/Access)", async () => {
    const caller = appRouter.createCaller(ctxFor("front_desk"));
    await expect(caller.users.list()).rejects.toThrow();
  });

  it("blocks non-admin from assigning roles to others", async () => {
    const caller = appRouter.createCaller(ctxFor("staff"));
    await expect(caller.users.setRole({ userId: 1, role: "admin" })).rejects.toThrow();
  });

  it("blocks non-admin from the HIPAA audit log", async () => {
    const caller = appRouter.createCaller(ctxFor("provider"));
    await expect(caller.audit.list({ limit: 10 })).rejects.toThrow();
  });

  it("blocks staff/provider from bulk import (admin & front_desk only)", async () => {
    const caller = appRouter.createCaller(ctxFor("provider"));
    await expect(caller.patients.bulkImportPreview({ csv: "name,phoneNumber\nA,555" })).rejects.toThrow();
  });

  it("blocks non-admin from sending team invites", async () => {
    const caller = appRouter.createCaller(ctxFor("staff"));
    await expect(caller.invites.send({ email: "x@y.com", role: "staff" })).rejects.toThrow();
  });

  it("blocks non-admin from revoking invites", async () => {
    const caller = appRouter.createCaller(ctxFor("front_desk"));
    await expect(caller.invites.revoke(1)).rejects.toThrow();
  });

  it("blocks non-admin from removing a team member", async () => {
    const caller = appRouter.createCaller(ctxFor("staff"));
    await expect(caller.users.remove(1)).rejects.toThrow();
  });

  it("prevents an admin from removing their own account (lockout guard)", async () => {
    const caller = appRouter.createCaller(ctxFor("admin"));
    // ctxFor admin has id 99 — removing self must be rejected before any DB work
    await expect(caller.users.remove(99)).rejects.toThrow();
  });

  it("prevents an admin from demoting their own role (lockout guard)", async () => {
    const caller = appRouter.createCaller(ctxFor("admin"));
    await expect(caller.users.setRole({ userId: 99, role: "staff" })).rejects.toThrow();
  });

  it("blocks non-admin from creating clinics", async () => {
    const caller = appRouter.createCaller(ctxFor("staff"));
    await expect(caller.clinics.create({ name: "X", location: "Y" })).rejects.toThrow();
  });

  it("blocks non-admin from creating providers", async () => {
    const caller = appRouter.createCaller(ctxFor("front_desk"));
    await expect(caller.providers.create({ name: "Dr X" })).rejects.toThrow();
  });

  it("blocks non-admin from removing providers", async () => {
    const caller = appRouter.createCaller(ctxFor("staff"));
    await expect(caller.providers.remove(1)).rejects.toThrow();
  });
});
