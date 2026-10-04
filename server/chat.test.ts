import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { can } from "../shared/workspace";

/** Internal messages: every staff role, never someone without access ("user"). */
function callerFor(role: string) {
  const user = { id: 95, openId: "chat-test", email: "chat@example.com", name: "Chat Test", loginMethod: "manus", role, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() };
  const ctx = {
    user: user as NonNullable<TrpcContext["user"]>,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { cookie: () => {}, clearCookie: () => {} } as unknown as TrpcContext["res"],
  } as TrpcContext;
  return appRouter.createCaller(ctx);
}

describe("Internal messages access", () => {
  it("is for every staff role", () => {
    for (const r of ["admin", "office_manager", "staff", "provider", "billing", "front_desk", "medical_assistant"]) expect(can(r, "messages")).toBe(true);
    expect(can("user", "messages")).toBe(false);
  });

  it("refuses someone without access, and their badge is just zero", async () => {
    const c = callerFor("user");
    await expect(c.workspace.chat.conversations()).rejects.toThrow(/access/);
    await expect(c.workspace.chat.send({ conversationId: 1, body: "hi" })).rejects.toThrow(/access/);
    await expect(c.workspace.chat.direct({ userId: 2 })).rejects.toThrow(/access/);
    expect(await c.workspace.chat.unread()).toEqual({ total: 0, newest: null });
  });

  it("refuses the new message tools without access", async () => {
    const c = callerFor("user");
    await expect(c.workspace.chat.search({ q: "refill" })).rejects.toThrow(/access/);
    await expect(c.workspace.chat.edit({ messageId: 1, body: "x" })).rejects.toThrow(/access/);
    await expect(c.workspace.chat.pin({ messageId: 1, pinned: true })).rejects.toThrow(/access/);
    await expect(c.workspace.chat.ack({ messageId: 1 })).rejects.toThrow(/access/);
    await expect(c.workspace.chat.attachStart({ conversationId: 1, fileName: "a.pdf", mimeType: "application/pdf", size: 10 })).rejects.toThrow(/access/);
    await expect(c.workspace.chat.attachment({ id: 1 })).rejects.toThrow(/access/);
  });

  it("only takes PDFs and photos, up to 5 files a message", async () => {
    await expect(callerFor("staff").workspace.chat.send({ conversationId: 1, body: "hi", attachmentIds: [1, 2, 3, 4, 5, 6] })).rejects.toThrow();
    await expect(callerFor("staff").workspace.chat.saveToFolder({ attachmentId: 1, subjectKey: "x:1", fileType: "other", title: "t" })).rejects.toThrow();
  });

  it("only links a message to a real patient key", async () => {
    await expect(callerFor("staff").workspace.chat.send({ conversationId: 1, body: "hi", subjectKey: "x:1" })).rejects.toThrow();
  });
});
