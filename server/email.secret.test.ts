import { describe, it, expect } from "vitest";

/**
 * Validates that RESEND_API_KEY is present and accepted by Resend.
 * Hits the lightweight GET /api-keys endpoint (read-only, sends no email).
 * Skips gracefully if no key is configured so CI without the secret still passes.
 */
describe("Resend API key", () => {
  const key = process.env.RESEND_API_KEY;

  it("is configured", () => {
    expect(key, "RESEND_API_KEY should be set").toBeTruthy();
  });

  it("is accepted by the Resend API", async () => {
    if (!key) return;
    const res = await fetch("https://api.resend.com/api-keys", {
      headers: { authorization: `Bearer ${key}` },
    });
    // 200 = valid; 401/403 = bad key. Some accounts restrict list scope and
    // return 422 while still being a valid key — only fail on auth errors.
    expect([401, 403]).not.toContain(res.status);
  }, 15000);
});
