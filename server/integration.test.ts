import { describe, it, expect } from "vitest";
import { secretsMatch, parseWhen, parseGroupBy } from "./integration";

describe("integration API key comparison", () => {
  it("matches identical secrets", () => {
    expect(secretsMatch("super-secret-key", "super-secret-key")).toBe(true);
  });

  it("rejects a wrong key", () => {
    expect(secretsMatch("super-secret-key", "wrong-key")).toBe(false);
  });

  it("rejects keys of differing length without throwing", () => {
    expect(secretsMatch("short", "a-much-longer-secret-value")).toBe(false);
  });

  it("rejects an empty provided key", () => {
    expect(secretsMatch("", "super-secret-key")).toBe(false);
  });
});

describe("integration date parsing", () => {
  it("parses ISO dates", () => {
    expect(parseWhen("2026-05-01")?.toISOString().slice(0, 10)).toBe("2026-05-01");
  });

  it("parses unix-ms strings", () => {
    const ms = Date.UTC(2026, 4, 1);
    expect(parseWhen(String(ms))?.getTime()).toBe(ms);
  });

  it("returns undefined for empty/garbage", () => {
    expect(parseWhen("")).toBeUndefined();
    expect(parseWhen(undefined)).toBeUndefined();
    expect(parseWhen("not-a-date")).toBeUndefined();
  });
});

describe("integration groupBy parsing", () => {
  it("defaults to provider", () => {
    expect(parseGroupBy(undefined)).toEqual(["provider"]);
    expect(parseGroupBy("")).toEqual(["provider"]);
  });

  it("accepts valid dimensions and dedupes", () => {
    expect(parseGroupBy("clinic,provider,clinic")).toEqual(["clinic", "provider"]);
  });

  it("drops invalid dimensions", () => {
    expect(parseGroupBy("provider,bogus,week")).toEqual(["provider", "week"]);
  });

  it("caps at 3 dimensions", () => {
    expect(parseGroupBy("date,week,provider,employee,clinic").length).toBe(3);
  });
});
