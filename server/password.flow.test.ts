import { afterAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb, getUserByEmail, getUserByOpenId } from "./db";
import { users, auditLogs } from "../drizzle/schema";
import { eq } from "drizzle-orm";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

// These tests exercise the real password procedures end to end and therefore need a DB.
// If DATABASE_URL is not configured (e.g. isolated CI), we skip rather than fail.
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

function adminCtx(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "owner-admin-test",
    email: "owner@example.com",
    name: "Owner",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  } as AuthenticatedUser;
  return makeCtx(user);
}

// Build a context whose res captures Set-Cookie so passwordLogin doesn't crash.
function makeCtx(user: AuthenticatedUser | null): TrpcContext {
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { cookie: () => {}, clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

const EMAIL = `pwflow-${Date.now()}@example.test`;
const TEMP_PW = "TempPass123";
const NEW_PW = "BrandNew456";

d("password procedures (live DB)", () => {
  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    const u = await getUserByEmail(EMAIL);
    if (!u) return;
    // Audit logs reference users via FK (immutable trail) — remove the test user's
    // audit rows first so the temporary test account can be cleaned up.
    await db.delete(auditLogs).where(eq(auditLogs.userId, u.id));
    await db.delete(users).where(eq(users.id, u.id));
  });

  it("admin creates a worker with a temporary password (immediately active, must change)", async () => {
    const admin = appRouter.createCaller(adminCtx());
    const res = await admin.members.create({ email: EMAIL, name: "PW Flow", role: "staff", password: TEMP_PW });
    expect(res.success).toBe(true);
    expect(res.pending).toBe(false); // has password => active, not pending

    const u = await getUserByEmail(EMAIL);
    expect(u).toBeTruthy();
    expect(u!.openId.startsWith("local:")).toBe(true);
    expect(u!.mustChangePassword).toBe(true);
    // resolvable by openId so authenticateRequest can rebuild the session user
    expect(await getUserByOpenId(u!.openId)).toBeTruthy();
  });

  it("logs in with the temp password and reports mustChangePassword", async () => {
    const pub = appRouter.createCaller(makeCtx(null));
    const res = await pub.auth.passwordLogin({ email: EMAIL, password: TEMP_PW });
    expect(res.success).toBe(true);
    expect(res.mustChangePassword).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const pub = appRouter.createCaller(makeCtx(null));
    await expect(pub.auth.passwordLogin({ email: EMAIL, password: "TotallyWrong9" })).rejects.toThrow();
  });

  it("forced first-login change clears the flag (no current password required)", async () => {
    const u = await getUserByEmail(EMAIL);
    const self = appRouter.createCaller(makeCtx({ ...(u as AuthenticatedUser) }));
    const res = await self.auth.changePassword({ newPassword: NEW_PW });
    expect(res.success).toBe(true);

    const after = await getUserByEmail(EMAIL);
    expect(after!.mustChangePassword).toBe(false);
  });

  it("after change, new password works and old password is rejected", async () => {
    const pub = appRouter.createCaller(makeCtx(null));
    const ok = await pub.auth.passwordLogin({ email: EMAIL, password: NEW_PW });
    expect(ok.success).toBe(true);
    expect(ok.mustChangePassword).toBe(false);
    await expect(pub.auth.passwordLogin({ email: EMAIL, password: TEMP_PW })).rejects.toThrow();
  });

  it("a normal change now requires the correct current password", async () => {
    const u = await getUserByEmail(EMAIL);
    const self = appRouter.createCaller(makeCtx({ ...(u as AuthenticatedUser) }));
    // wrong current password is rejected
    await expect(self.auth.changePassword({ currentPassword: "wrong", newPassword: "AnotherOne7" })).rejects.toThrow();
    // correct current password succeeds
    const res = await self.auth.changePassword({ currentPassword: NEW_PW, newPassword: "AnotherOne7" });
    expect(res.success).toBe(true);
  });

  it("admin reset re-forces a password change and sets the new password", async () => {
    const before = await getUserByEmail(EMAIL);
    const admin = appRouter.createCaller(adminCtx());
    const res = await admin.users.resetPassword({ userId: before!.id, password: "ResetPass900" });
    expect(res.success).toBe(true);

    const after = await getUserByEmail(EMAIL);
    expect(after!.mustChangePassword).toBe(true);

    const pub = appRouter.createCaller(makeCtx(null));
    const login = await pub.auth.passwordLogin({ email: EMAIL, password: "ResetPass900" });
    expect(login.success).toBe(true);
    expect(login.mustChangePassword).toBe(true);
  });
});
