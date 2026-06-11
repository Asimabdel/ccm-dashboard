import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, validatePasswordStrength } from "./password";

describe("password helpers", () => {
  it("hashes and verifies a correct password", async () => {
    const hash = await hashPassword("CorrectHorse9");
    expect(hash).not.toEqual("CorrectHorse9");
    expect(await verifyPassword("CorrectHorse9", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("CorrectHorse9");
    expect(await verifyPassword("WrongPassword1", hash)).toBe(false);
  });

  it("returns false when no hash is stored (OAuth-only account)", async () => {
    expect(await verifyPassword("anything1", null)).toBe(false);
    expect(await verifyPassword("anything1", undefined)).toBe(false);
  });

  it("produces distinct hashes for the same password (salted)", async () => {
    const a = await hashPassword("RepeatMe123");
    const b = await hashPassword("RepeatMe123");
    expect(a).not.toEqual(b);
    expect(await verifyPassword("RepeatMe123", a)).toBe(true);
    expect(await verifyPassword("RepeatMe123", b)).toBe(true);
  });

  it("enforces the strength policy", () => {
    expect(validatePasswordStrength("short1")).toBeTruthy(); // too short
    expect(validatePasswordStrength("onlyletters")).toBeTruthy(); // no number
    expect(validatePasswordStrength("12345678")).toBeTruthy(); // no letter
    expect(validatePasswordStrength("Valid1234")).toBeNull(); // ok
  });
});
