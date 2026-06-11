import { describe, it, expect, beforeEach } from "vitest";
import {
  sanitizeUser,
  recordFailedLogin,
  getLockoutRemaining,
  clearLoginAttempts,
} from "./db";
import type { User } from "../drizzle/schema";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    openId: "local:test@clinic.com",
    name: "Test Worker",
    email: "test@clinic.com",
    loginMethod: "password",
    passwordHash: "$2a$10$superSecretHashValueThatMustNeverLeak",
    passwordSetAt: new Date(),
    mustChangePassword: true,
    role: "staff" as const,
    clinicLocation: null,
    languagesSpoken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    ...overrides,
  } as User;
}

describe("sanitizeUser (PHI/secret stripping)", () => {
  it("removes passwordHash and passwordSetAt", () => {
    const safe = sanitizeUser(makeUser());
    expect(safe).not.toBeNull();
    expect((safe as Record<string, unknown>).passwordHash).toBeUndefined();
    expect((safe as Record<string, unknown>).passwordSetAt).toBeUndefined();
  });

  it("retains non-secret fields needed by the client", () => {
    const safe = sanitizeUser(makeUser({ role: "admin", email: "a@b.com" }))!;
    expect(safe.id).toBe(1);
    expect(safe.role).toBe("admin");
    expect(safe.email).toBe("a@b.com");
    expect(safe.mustChangePassword).toBe(true);
  });

  it("returns null for null/undefined input", () => {
    expect(sanitizeUser(null)).toBeNull();
    expect(sanitizeUser(undefined)).toBeNull();
  });

  it("never serializes a password hash to JSON", () => {
    const json = JSON.stringify(sanitizeUser(makeUser()));
    expect(json).not.toContain("superSecretHashValue");
    expect(json).not.toContain("passwordHash");
  });
});

describe("brute-force login lockout", () => {
  const id = "attacker@clinic.com";
  beforeEach(() => clearLoginAttempts(id));

  it("does not lock before the 5th failed attempt", () => {
    for (let i = 0; i < 4; i++) recordFailedLogin(id);
    expect(getLockoutRemaining(id)).toBe(0);
  });

  it("locks the account after 5 failed attempts within the window", () => {
    for (let i = 0; i < 5; i++) recordFailedLogin(id);
    expect(getLockoutRemaining(id)).toBeGreaterThan(0);
  });

  it("clears lockout state after a successful login", () => {
    for (let i = 0; i < 5; i++) recordFailedLogin(id);
    expect(getLockoutRemaining(id)).toBeGreaterThan(0);
    clearLoginAttempts(id);
    expect(getLockoutRemaining(id)).toBe(0);
  });

  it("is case-insensitive on the identifier", () => {
    for (let i = 0; i < 5; i++) recordFailedLogin(id.toUpperCase());
    expect(getLockoutRemaining(id.toLowerCase())).toBeGreaterThan(0);
  });
});
