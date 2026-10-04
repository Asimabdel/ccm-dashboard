import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { can } from "../shared/workspace";
import { DEFAULT_TEXTING, autoReplyText, isAfterHours, isStartText, isStopText, textSegments, textStatusFrom } from "../shared/texts";

function callerFor(role: string) {
  const user = { id: 94, openId: "texts-test", email: "texts@example.com", name: "Texts Test", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
  return appRouter.createCaller({
    user: user as NonNullable<TrpcContext["user"]>,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { cookie: () => {}, clearCookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext);
}

describe("patient texting access", () => {
  it("is for front desk, MAs, care coordinators, office managers and admins", () => {
    for (const r of ["admin", "office_manager", "staff", "front_desk", "medical_assistant"]) expect(can(r, "texts")).toBe(true);
    for (const r of ["provider", "billing", "user"]) expect(can(r, "texts")).toBe(false);
  });

  it("refuses people without access, and their badge is just zero", async () => {
    const c = callerFor("billing");
    await expect(c.workspace.texts.list({ filter: "open" })).rejects.toThrow(/access/);
    await expect(c.workspace.texts.send({ threadId: 1, body: "hi" })).rejects.toThrow(/access/);
    await expect(c.workspace.texts.get({ id: 1 })).rejects.toThrow(/access/);
    expect(await c.workspace.texts.unread()).toEqual({ total: 0, newest: null });
    expect((await c.workspace.texts.status()).canUse).toBe(false);
  });

  it("keeps the setup for admins", async () => {
    await expect(callerFor("front_desk").workspace.texts.setup()).rejects.toThrow(/admin/);
    await expect(callerFor("office_manager").workspace.texts.numbers()).rejects.toThrow(/admin/);
  });
});

describe("texting rules", () => {
  const hours = DEFAULT_TEXTING.hours; // Mon–Fri 9–5, clinic time (Central)
  it("knows when the office is closed (clinic time)", () => {
    expect(isAfterHours(new Date("2026-10-05T15:00:00Z"), hours)).toBe(false); // Mon 10:00 CDT
    expect(isAfterHours(new Date("2026-10-05T13:30:00Z"), hours)).toBe(true); // Mon 8:30 CDT
    expect(isAfterHours(new Date("2026-10-05T22:00:00Z"), hours)).toBe(true); // Mon 17:00 CDT
    expect(isAfterHours(new Date("2026-10-04T16:00:00Z"), hours)).toBe(true); // Sunday
    expect(isAfterHours(new Date("2026-12-07T16:00:00Z"), hours)).toBe(false); // Mon 10:00 CST
  });

  it("answers in the patient's language, or both", () => {
    const a = DEFAULT_TEXTING.autoReply;
    expect(autoReplyText(a, "Spanish")).toBe(a.es);
    expect(autoReplyText(a, "English")).toBe(a.en);
    expect(autoReplyText(a, null)).toBe(`${a.en}\n\n${a.es}`);
  });

  it("recognizes the carriers' STOP / START words, not ordinary replies", () => {
    for (const w of ["STOP", "stop.", " Unsubscribe ", "CANCEL"]) expect(isStopText(w)).toBe(true);
    for (const w of ["Please stop by tomorrow", "yes", "Can I cancel my 2pm?"]) expect(isStopText(w)).toBe(false);
    expect(isStartText("START")).toBe(true);
    expect(isStartText("yes")).toBe(false);
  });

  it("counts SMS parts", () => {
    expect(textSegments("")).toBe(0);
    expect(textSegments("a".repeat(160))).toBe(1);
    expect(textSegments("a".repeat(161))).toBe(2);
    expect(textSegments("Hola 😀")).toBe(1);
    expect(textSegments("😀".repeat(40))).toBe(2);
  });

  it("maps RingCentral's statuses", () => {
    expect(textStatusFrom("Queued", "out")).toBe("sending");
    expect(textStatusFrom("Sent", "out")).toBe("sent");
    expect(textStatusFrom("Delivered", "out")).toBe("delivered");
    expect(textStatusFrom("DeliveryFailed", "out")).toBe("failed");
    expect(textStatusFrom("Received", "in")).toBe("received");
  });
});
