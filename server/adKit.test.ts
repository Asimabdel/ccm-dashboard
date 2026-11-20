import { describe, expect, it } from "vitest";
import { AD_LIMITS, buildAdKit, kitArea, kitNegatives, kitRows, kitShortName, type KitClinic, type KitOptions } from "../shared/adKit";
import { isAdCode } from "../shared/ads";

const CLINICS: KitClinic[] = [
  { id: 1, name: "MyPCP Dr - Katy", address: "21398 Provincial Blvd, Katy, TX 77450" },
  { id: 2, name: "MyPCP Dr - Cypress", address: "7050 Lakeview Haven Dr #100, Houston, TX 77095" },
  { id: 3, name: "MyPCP Dr - Westheimer", address: "12121 Richmond Ave Suite 216, Houston, TX 77082" },
  { id: 4, name: "MyPCP Dr - Highland Knolls", address: "Highland Knolls Dr, Katy, TX 77450" },
];
const ALL: KitOptions = { monthlyBudget: 2000, spanish: true, selfPay: true, sameWeek: true };

describe("the campaign kit", () => {
  it("names each clinic's area", () => {
    expect(CLINICS.map((c) => kitArea(c).area)).toEqual(["Katy", "Cypress", "West Houston", "Katy"]);
    expect(kitArea({ id: 9, name: "Maple Clinic", address: "1 Elm St, Austin, TX 78701" }).area).toBe("Austin");
    expect(kitArea({ id: 9, name: "Maple Clinic" }).area).toBe("Maple Clinic");
    expect(kitShortName("MyPCP Dr - Highland Knolls")).toBe("Highland Knolls");
  });

  it("keeps every line inside Google's limits, with every option on", () => {
    for (const set of [CLINICS, CLINICS.slice(0, 3), [CLINICS[2]!], [{ id: 7, name: "Northwest Family Medicine of Greater Houston", address: null }]]) {
      const kit = buildAdKit(set, ALL);
      expect(kit.dropped).toEqual([]);
      for (const c of kit.campaigns) {
        expect(isAdCode(c.code)).toBe(true);
        for (const g of c.adGroups) {
          expect(g.headlines.length).toBeGreaterThanOrEqual(AD_LIMITS.minHeadlines);
          expect(g.headlines.length).toBeLessThanOrEqual(AD_LIMITS.maxHeadlines);
          expect(g.descriptions.length).toBeGreaterThanOrEqual(2);
          expect(g.descriptions.length).toBeLessThanOrEqual(AD_LIMITS.maxDescriptions);
          for (const h of g.headlines) expect(h.length, h).toBeLessThanOrEqual(AD_LIMITS.headline);
          for (const d of g.descriptions) expect(d.length, d).toBeLessThanOrEqual(AD_LIMITS.description);
          expect(g.path1.length).toBeLessThanOrEqual(AD_LIMITS.path);
          expect(g.path2.length).toBeLessThanOrEqual(AD_LIMITS.path);
          expect(new Set(g.headlines).size).toBe(g.headlines.length);
          expect(g.keywords.length).toBeGreaterThanOrEqual(5);
          for (const k of g.keywords) expect(k.text, k.text).toMatch(/^[a-z0-9ñ ]+$/);
        }
      }
      for (const s of kit.sitelinks) { expect(s.text.length).toBeLessThanOrEqual(AD_LIMITS.sitelink); expect(s.line1.length).toBeLessThanOrEqual(AD_LIMITS.sitelinkLine); expect(s.line2.length).toBeLessThanOrEqual(AD_LIMITS.sitelinkLine); }
      for (const c of kit.callouts) expect(c.length).toBeLessThanOrEqual(AD_LIMITS.callout);
      for (const v of kit.snippets.values) expect(v.length).toBeLessThanOrEqual(AD_LIMITS.snippet);
    }
  });

  it("builds one English campaign per clinic and one Spanish one, and splits the budget to the cent", () => {
    const kit = buildAdKit(CLINICS.slice(0, 3), ALL);
    expect(kit.campaigns.map((c) => c.code)).toEqual(["g-katy-en", "g-cypress-en", "g-west-houston-en", "g-espanol"]);
    expect(kit.campaigns.map((c) => c.language)).toEqual(["en", "en", "en", "es"]);
    expect(kit.campaigns.reduce((s, c) => s + c.monthlyBudgetCents, 0)).toBe(200_000);
    expect(kit.campaigns[3]!.monthlyBudgetCents).toBe(50_000);
    expect(kit.campaigns[0]!.dailyBudgetCents).toBe(1645);
    expect(kit.campaigns[3]!.areas.length).toBe(3);
    expect(kit.campaigns[3]!.clinicId).toBeNull();
    expect(kit.campaigns[0]!.suffix).toBe("utm_source=google&utm_medium=cpc&utm_campaign=g-katy-en&utm_term={keyword}&utm_content={creative}&utm_device={device}");
    expect(kit.campaigns[0]!.googleName).toContain("g-katy-en");
  });

  it("tells two clinics in the same town apart", () => {
    const kit = buildAdKit(CLINICS, { ...ALL, spanish: false });
    expect(kit.campaigns.map((c) => c.code)).toEqual(["g-katy-en", "g-cypress-en", "g-west-houston-en", "g-highland-knolls-en"]);
    expect(new Set(kit.campaigns.map((c) => c.code)).size).toBe(4);
  });

  it("leaves out what wasn't asked for", () => {
    const plain = buildAdKit(CLINICS.slice(0, 1), { monthlyBudget: 900, spanish: false, selfPay: false, sameWeek: false });
    expect(plain.campaigns.length).toBe(1);
    expect(plain.campaigns[0]!.monthlyBudgetCents).toBe(90_000);
    const text = JSON.stringify(plain);
    expect(text).not.toContain("Appointments This Week");
    expect(text).not.toContain("No Insurance?");
    expect(plain.campaigns[0]!.adGroups.map((g) => g.name)).toEqual(["Doctor near me", "New patients", "Insurance", "Physicals and checkups", "Diabetes and blood pressure"]);
    expect(buildAdKit(CLINICS.slice(0, 1), ALL).campaigns[0]!.adGroups.at(-1)!.name).toBe("No insurance");
  });

  it("blocks the plans the clinic doesn't take and job seekers", () => {
    const en = kitNegatives("en"), es = kitNegatives("es");
    for (const w of ["medicaid", "chip", "humana", "jobs", "urgent care"]) expect(en).toContain(w);
    for (const w of ["medicaid", "humana", "gratis", "empleo"]) expect(es).toContain(w);
    expect(new Set(en).size).toBe(en.length);
    // Never names a plan the clinic takes as a blocked word.
    for (const w of ["ambetter", "oscar", "medicare", "aetna", "cigna"]) expect(en).not.toContain(w);
  });

  it("never promises what Medicare rules out in an ad", () => {
    const text = JSON.stringify(buildAdKit(CLINICS, ALL).campaigns.map((c) => c.adGroups.map((g) => [g.headlines, g.descriptions]))).toLowerCase();
    for (const banned of ["best doctor", "#1", "guarantee", "cure", "free visit", "medicaid accepted", "humana"]) expect(text).not.toContain(banned);
  });

  it("flattens to spreadsheet rows of one width", () => {
    const rows = kitRows(buildAdKit(CLINICS.slice(0, 2), ALL));
    expect(rows[0]![0]).toBe("Campaign");
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
    expect(rows.filter((r) => r[2] === "Campaign").length).toBe(3);
    expect(rows.some((r) => r[2] === "Keyword" && r[4] === "Exact")).toBe(true);
    expect(rows.some((r) => r[2] === "Blocked word" && r[3] === "medicaid")).toBe(true);
  });
});
