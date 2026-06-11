import { afterAll, describe, expect, it } from "vitest";
import { sdk } from "./_core/sdk";
import { COOKIE_NAME } from "@shared/const";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb, getUserByEmail } from "./db";
import { users, auditLogs } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import type { Request } from "express";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

function adminCtx(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "owner-admin-test-session",
    email: "owner-session@example.com",
    name: "Owner",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  } as AuthenticatedUser;
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { cookie: () => {}, clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

const EMAIL = `sessflow-${Date.now()}@example.test`;
const TEMP_PW = "TempPass123";

d("password session round-trip (live DB)", () => {
  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    const u = await getUserByEmail(EMAIL);
    if (!u) return;
    await db.delete(auditLogs).where(eq(auditLogs.userId, u.id));
    await db.delete(users).where(eq(users.id, u.id));
  });

  it("a worker created with a password can be authenticated via their session cookie", async () => {
    // 1. Admin creates the worker login with a temporary password.
    const admin = appRouter.createCaller(adminCtx());
    await admin.members.create({ email: EMAIL, name: "Session Flow", role: "staff", password: TEMP_PW });

    const u = await getUserByEmail(EMAIL);
    expect(u).toBeTruthy();
    expect(u!.openId.startsWith("local:")).toBe(true);

    // 2. Mint a session token EXACTLY as passwordLogin does.
    const token = await sdk.createSessionToken(u!.openId, { name: u!.name || u!.email || "" });

    // 3. Simulate the next request carrying that cookie and run the real auth path.
    const req = {
      protocol: "https",
      headers: { cookie: `${COOKIE_NAME}=${token}` },
    } as unknown as Request;

    // This is the production code path that runs on every authenticated request.
    const authed = await sdk.authenticateRequest(req);
    expect(authed).toBeTruthy();
    expect(authed.openId).toBe(u!.openId);
    expect(authed.role).toBe("staff");
  });
});
