import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  addDays, clinicDayStart, clinicRange, guessCategory, methodOf, methodText, money, parseDollars, paymentLinkText, squareItemName,
} from "../shared/payments";
import { matchOne, signatureMatches, squareSignature } from "./squareDb";
import { base64Lines } from "./gmailSync";

describe("Square webhook signature", () => {
  const key = "test-signature-key";
  const url = "https://mypcpcare.com/api/square/webhook";
  const body = JSON.stringify({ type: "payment.updated", data: { object: { payment: { id: "P1" } } } });

  it("is base64 HMAC-SHA256 of the notification URL + raw body", () => {
    const expected = createHmac("sha256", key).update(url + body).digest("base64");
    expect(squareSignature(key, url, body)).toBe(expected);
  });

  it("rejects a changed body, a different URL, a different key and junk", () => {
    const good = squareSignature(key, url, body);
    expect(signatureMatches(good, good)).toBe(true);
    expect(signatureMatches(squareSignature(key, url, body.replace("P1", "P2")), good)).toBe(false);
    expect(signatureMatches(squareSignature(key, "https://evil.example/api/square/webhook", body), good)).toBe(false);
    expect(signatureMatches(squareSignature("other-key", url, body), good)).toBe(false);
    expect(signatureMatches(good, "")).toBe(false);
    expect(signatureMatches(good, "x")).toBe(false);
  });
});

describe("payment helpers", () => {
  it("sorts Square items into categories, or leaves them for staff", () => {
    expect(guessCategory("DEXA Scan ×1")).toBe("dexafit");
    expect(guessCategory("Body Composition, RMR test")).toBe("dexafit");
    expect(guessCategory("Weight loss program - month 2")).toBe("weight_loss");
    expect(guessCategory("Copay")).toBe("copay");
    expect(guessCategory("Balance due")).toBe("copay");
    expect(guessCategory("Self-pay visit")).toBe("self_pay");
    expect(guessCategory("Self pay")).toBe("self_pay");
    expect(guessCategory("Custom amount")).toBeNull();
    expect(guessCategory("")).toBeNull();
    expect(guessCategory(null)).toBeNull();
  });

  it("never puts what a payment is for into what Square sees", () => {
    for (const c of ["copay", "weight_loss", "self_pay", null] as const) expect(squareItemName(c)).toBe("MyPCP Dr payment");
    expect(squareItemName("dexafit")).toBe("DexaFit Katy payment");
    const text = paymentLinkText("en", 4500, "https://square.link/u/abc", "(713) 555-0100");
    expect(text).toContain("$45.00");
    expect(text).toContain("https://square.link/u/abc");
    expect(text).not.toMatch(/weight|copay|tirzepatide|semaglutide/i);
    expect(paymentLinkText("es", 4500, "https://x", null)).toContain("enlace seguro");
  });

  it("groups payment methods and describes them", () => {
    expect(methodOf("CARD")).toBe("card");
    expect(methodOf("WALLET")).toBe("card");
    expect(methodOf("CASH")).toBe("cash");
    expect(methodOf("EXTERNAL")).toBe("other");
    expect(methodText({ sourceType: "CARD", cardBrand: "VISA", cardLast4: "1234" })).toBe("Visa ••1234");
    expect(methodText({ sourceType: "CARD", cardBrand: "AMERICAN_EXPRESS", cardLast4: "0005" })).toBe("American Express ••0005");
    expect(methodText({ sourceType: "CASH", cardBrand: null, cardLast4: null })).toBe("Cash");
    expect(methodText({ sourceType: "BANK_ACCOUNT", cardBrand: null, cardLast4: null })).toBe("Bank account");
  });

  it("reads dollar amounts safely", () => {
    expect(parseDollars("45")).toBe(4500);
    expect(parseDollars("$1,200.50")).toBe(120050);
    expect(parseDollars("0.5")).toBe(50);
    expect(parseDollars("0")).toBeNull();
    expect(parseDollars("-5")).toBeNull();
    expect(parseDollars("12.345")).toBeNull();
    expect(parseDollars("abc")).toBeNull();
    expect(parseDollars("60000")).toBeNull();
    expect(money(123456)).toBe("$1,234.56");
  });

  it("finds where a clinic (Central time) day starts, across daylight saving", () => {
    expect(clinicDayStart("2026-07-01").toISOString()).toBe("2026-07-01T05:00:00.000Z"); // CDT
    expect(clinicDayStart("2026-01-15").toISOString()).toBe("2026-01-15T06:00:00.000Z"); // CST
    expect(clinicDayStart("2026-03-08").toISOString()).toBe("2026-03-08T06:00:00.000Z"); // DST starts at 2am
    expect(clinicDayStart("2026-11-01").toISOString()).toBe("2026-11-01T05:00:00.000Z"); // DST ends at 2am
    const r = clinicRange("2026-09-01", "2026-09-30");
    expect(r.start.toISOString()).toBe("2026-09-01T05:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-10-01T05:00:00.000Z");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("matching Square customers to patients (made-up people)", () => {
  const phones = new Map([["7135550101", { key: "p:1", name: "Maria Testperson" }], ["7135550102", { key: "p:2", name: "John Sample" }]]);
  const emails = new Map([["jo.example@example.com", { key: "s:jo example|1980-01-01", name: "Jo Example" }]]);
  const names = new Map([
    ["alex placeholder", [{ key: "p:3", name: "Alex Placeholder" }]],
    ["sam twin", [{ key: "p:4", name: "Sam Twin" }, { key: "p:5", name: "Sam Twin" }]],
  ]);

  it("links on phone + last name", () => {
    const r = matchOne({ givenName: "Maria", familyName: "Testperson", phone: "+1 (713) 555-0101" }, phones, emails, names);
    expect(r).toMatchObject({ subjectKey: "p:1", matchedBy: "phone" });
  });

  it("doesn't link on a phone number alone (family members share phones)", () => {
    const r = matchOne({ givenName: "Luis", familyName: "Otherfamily", phone: "713-555-0101" }, phones, emails, names);
    expect(r.subjectKey).toBeNull();
  });

  it("links on email + last name", () => {
    const r = matchOne({ givenName: "Jo", familyName: "Example", email: "Jo.Example@example.com" }, phones, emails, names);
    expect(r).toMatchObject({ subjectKey: "s:jo example|1980-01-01", matchedBy: "email" });
  });

  it("only suggests on a unique full name, and never guesses between two", () => {
    expect(matchOne({ givenName: "Alex", familyName: "Placeholder" }, phones, emails, names)).toMatchObject({ subjectKey: null, suggestKey: "p:3" });
    expect(matchOne({ givenName: "Sam", familyName: "Twin" }, phones, emails, names)).toMatchObject({ subjectKey: null, suggestKey: null });
    expect(matchOne({ givenName: "Nobody", familyName: null, phone: "7135550102" }, phones, emails, names).subjectKey).toBeNull();
  });
});

describe("practice email encoding", () => {
  it("wraps base64 at 76 characters and keeps the content intact", () => {
    const text = "Hello, here is your link: https://example.com/".repeat(10);
    const out = base64Lines(text);
    const lines = out.split("\r\n").filter(Boolean);
    expect(lines.every((l) => l.length <= 76)).toBe(true);
    expect(Buffer.from(lines.join(""), "base64").toString("utf8")).toBe(text);
  });
});
