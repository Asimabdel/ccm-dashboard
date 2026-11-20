import { describe, expect, it } from "vitest";
import {
  AD_JUDGE_DAYS, adCode, adVerdict, adsSummary, budgetPace, channelForSource, cleanAdTouch, followLead, isAdCode, matchSpendCampaign, parseAdDay, parseSpendFile, spreadSpend,
  trackingSuffix, trackingUrl, type ACampaign, type ALead, type AdRow,
} from "../shared/ads";
import type { ZClaim, ZVisit } from "../shared/zocdoc";

// Made-up campaigns, people and dates throughout.
const TODAY = "2026-11-20";
const NOW = new Date("2026-11-20T20:00:00Z"); // 2 PM Houston, a Friday
const at = (day: string, hhmm = "16:00") => new Date(`${day}T${hhmm}:00Z`); // 10 AM Houston in November
const camp = (id: number, over: Partial<ACampaign> = {}): ACampaign => ({ id, name: `Campaign ${id}`, channel: "google_search", code: `c-${id}00`, clinicId: 1, clinicName: "Maple Clinic", language: "en", monthlyBudgetCents: 100_000, status: "active", ...over });
let nextId = 1;
const lead = (over: Partial<ALead> = {}): ALead => {
  const day = over.day ?? "2026-10-01";
  const id = nextId++;
  return { id, campaignId: 1, kind: "web", at: at(day), day, person: `p:${id}`, matched: true, booking: { status: "new", firstContactAt: null }, calls: 0, answered: false, calledBackAt: null, outcome: null, keyword: null, adName: null, ...over };
};
const claim = (date: string, paidCents = 10_000, owesCents = 0): ZClaim => ({ date, paidCents, owesCents, billedCents: paidCents + owesCents });
const visit = (date: string, kind: ZVisit["kind"]): ZVisit => ({ date, kind });
const follow = (l: ALead, claims: ZClaim[] = [], visits: ZVisit[] = [], earlier = false) => followLead(l, earlier, claims, visits, NOW, TODAY);

describe("campaign codes and tracking links", () => {
  it("turns a name into a code", () => {
    expect(adCode("Google · Katy (EN)")).toBe("google-katy-en");
    expect(adCode("  Señor Flyer!! ")).toBe("senor-flyer");
    expect(adCode("ab")).toBe("");
    expect(isAdCode("g-katy-en")).toBe(true);
    expect(isAdCode("G Katy")).toBe(false);
    expect(isAdCode("-katy")).toBe(false);
  });
  it("builds the link endings each ad service fills in", () => {
    expect(trackingSuffix({ channel: "google_search", code: "g-katy-en" })).toBe("utm_source=google&utm_medium=cpc&utm_campaign=g-katy-en&utm_term={keyword}&utm_content={creative}&utm_device={device}");
    expect(trackingSuffix({ channel: "facebook", code: "fb-es" })).toContain("utm_content={{ad.name}}");
    expect(trackingUrl({ channel: "mail", code: "flyer-1" })).toBe("https://mypcpdr.com/?utm_source=mail&utm_medium=print&utm_campaign=flyer-1");
    expect(trackingUrl({ channel: "mail", code: "flyer-1", landingUrl: "https://mypcpdr.com/es?x=1" })).toBe("https://mypcpdr.com/es?x=1&utm_source=mail&utm_medium=print&utm_campaign=flyer-1");
  });
  it("guesses the channel for a code it has never seen", () => {
    expect(channelForSource("google", "cpc")).toBe("google_search");
    expect(channelForSource("google", "organic")).toBe("google_profile");
    expect(channelForSource("fb", "paid")).toBe("facebook");
    expect(channelForSource("mail", "print")).toBe("mail");
    expect(channelForSource(null, null)).toBe("other");
  });
});

describe("what the website hands over", () => {
  it("keeps a clean tag and drops anything odd", () => {
    const t = cleanAdTouch({ campaign: "G-Katy-EN", source: "Google", medium: "cpc", term: "doctor%20near%20me", content: "ad 12", clickId: "Cj0KCQ_abc-123<script>", device: "m", landing: "/katy?utm_source=x#top" });
    expect(t).toEqual({ campaign: "g-katy-en", source: "google", medium: "cpc", keyword: "doctor near me", adName: "ad 12", clickId: "Cj0KCQ_abc-123script", device: "phone", landing: "/katy" });
  });
  it("is nothing without a campaign", () => {
    expect(cleanAdTouch(null)).toBeNull();
    expect(cleanAdTouch("google")).toBeNull();
    expect(cleanAdTouch({ source: "google" })).toBeNull();
    expect(cleanAdTouch({ campaign: "<>" })).toBeNull();
  });
  it("clips long values", () => {
    const t = cleanAdTouch({ campaign: "x".repeat(90), term: "k".repeat(500) })!;
    expect(t.campaign.length).toBe(40);
    expect(t.keyword!.length).toBe(120);
  });
});

describe("spend", () => {
  it("spreads one amount over the days, to the cent", () => {
    const days = spreadSpend("2026-11-01", "2026-11-30", 100_000);
    expect(days.length).toBe(30);
    expect(days.reduce((s, d) => s + d.costCents, 0)).toBe(100_000);
    expect(days[0]).toEqual({ day: "2026-11-01", costCents: 3334 });
    expect(days[29]).toEqual({ day: "2026-11-30", costCents: 3333 });
    expect(spreadSpend("2026-11-02", "2026-11-01", 100)).toEqual([]);
  });
  it("reads days the way the reports write them", () => {
    expect(parseAdDay("2026-11-03")).toBe("2026-11-03");
    expect(parseAdDay("11/3/2026")).toBe("2026-11-03");
    expect(parseAdDay("Nov 3, 2026")).toBe("2026-11-03");
    expect(parseAdDay("3 Nov 2026")).toBe("2026-11-03");
    expect(parseAdDay("soon")).toBeNull();
  });
  it("reads a Google Ads report with title lines and totals", () => {
    const f = parseSpendFile([
      ["Campaign report"], ["November 1, 2026 - November 3, 2026"],
      ["Day", "Campaign", "Clicks", "Impr.", "Cost"],
      ["2026-11-01", "Search g-katy-en", "12", "1,240", "38.20"],
      ["2026-11-02", "Search g-katy-en", "9", "980", "$29.05"],
      ["2026-11-02", "Search g-cy-es", "0", "40", "0.00"],
      ["Total: Campaigns", "", "21", "2,260", "67.25"],
    ]);
    expect(f.kind).toBe("google");
    expect(f.hasDays).toBe(true);
    expect(f.rows).toEqual([
      { campaignName: "Search g-katy-en", day: "2026-11-01", costCents: 3820, clicks: 12, impressions: 1240 },
      { campaignName: "Search g-katy-en", day: "2026-11-02", costCents: 2905, clicks: 9, impressions: 980 },
      { campaignName: "Search g-cy-es", day: "2026-11-02", costCents: 0, clicks: 0, impressions: 40 },
    ]);
  });
  it("reads a Facebook export and says when a file has no days", () => {
    const fb = parseSpendFile([["Reporting starts", "Reporting ends", "Campaign name", "Impressions", "Link clicks", "Amount spent (USD)"], ["2026-11-01", "2026-11-01", "FB Familias", "5000", "44", "20"]]);
    expect(fb.kind).toBe("facebook");
    expect(fb.rows[0]).toEqual({ campaignName: "FB Familias", day: "2026-11-01", costCents: 2000, clicks: 44, impressions: 5000 });
    const noDays = parseSpendFile([["Campaign", "Cost"], ["Flyer", "450.00"]]);
    expect(noDays.hasDays).toBe(false);
    expect(noDays.rows[0]!.day).toBeNull();
    expect(parseSpendFile([["Name", "Amount"], ["x", "1"]]).problem).toMatch(/Campaign/);
  });
  it("matches a report's campaign to ours", () => {
    const ours = [{ id: 1, name: "Google Katy", code: "g-katy-en", outsideName: null }, { id: 2, name: "Google Cypress", code: "g-cy-es", outsideName: "Cypress Español" }];
    expect(matchSpendCampaign("Search | g-katy-en | Nov", ours)?.id).toBe(1);
    expect(matchSpendCampaign("search g_katy_en", ours)?.id).toBe(1);
    expect(matchSpendCampaign("cypress español", ours)?.id).toBe(2);
    expect(matchSpendCampaign("google katy", ours)?.id).toBe(1);
    expect(matchSpendCampaign("Something else", ours)).toBeNull();
  });
  it("compares this month's spend with the budget so far", () => {
    expect(budgetPace(50_000, null, TODAY)).toBeNull();
    expect(budgetPace(66_000, 100_000, TODAY)).toEqual({ expectedCents: 66_667, pace: "on" });
    expect(budgetPace(90_000, 100_000, TODAY)!.pace).toBe("over");
    expect(budgetPace(20_000, 100_000, TODAY)!.pace).toBe("under");
  });
});

describe("following one lead", () => {
  it("came in: a visit or a claim on or after the lead's day", () => {
    const l = lead({ day: "2026-10-01", booking: { status: "scheduled", firstContactAt: at("2026-10-01", "16:10") } });
    const r = follow(l, [claim("2026-10-06", 12_000, 2_000), claim("2026-12-01", 5_000)], [visit("2026-10-06", "seen")]);
    expect(r).toMatchObject({ called: true, minutesToCall: 10, booked: true, cameIn: true, firstVisit: "2026-10-06", outcome: "came_in", lostReason: null, counted: true });
    expect(r.paidFirstCents).toBe(12_000);
    expect(r.paidLaterCents).toBe(5_000);
    expect(r.owesCents).toBe(2_000);
  });
  it("already our patient: no credit for the ad", () => {
    const r = follow(lead({ day: "2026-10-01" }), [claim("2026-06-01"), claim("2026-10-05")]);
    expect(r).toMatchObject({ existing: true, counted: false, cameIn: true, paidFirstCents: 0, paidLaterCents: 0 });
  });
  it("counts office minutes to the first call and flags the ones still waiting", () => {
    // Asked Thursday 4:50 PM Houston, called Friday 9:20 AM: 10 + 20 office minutes.
    const slow = follow(lead({ day: "2026-11-19", at: new Date("2026-11-19T22:50:00Z"), booking: { status: "no_answer", firstContactAt: new Date("2026-11-20T15:20:00Z") } }));
    expect(slow.minutesToCall).toBe(30);
    expect(slow.waiting).toBe(false);
    const waiting = follow(lead({ day: TODAY, at: new Date("2026-11-20T18:00:00Z") }));
    expect(waiting).toMatchObject({ called: false, waiting: true, outcome: "pending" });
    const justIn = follow(lead({ day: TODAY, at: new Date("2026-11-20T19:55:00Z") }));
    expect(justIn.waiting).toBe(false);
  });
  it("says why a lead was lost", () => {
    const old = "2026-09-01";
    expect(follow(lead({ day: old }))).toMatchObject({ lostReason: "not_called", waiting: false }); // too late to count as waiting
    expect(follow(lead({ day: old, booking: { status: "no_answer", firstContactAt: at(old, "17:00") } })).lostReason).toBe("no_answer");
    expect(follow(lead({ day: old, booking: { status: "not_booked", firstContactAt: at(old, "17:00") } })).lostReason).toBe("didnt_book");
    expect(follow(lead({ day: old, booking: { status: "scheduled", firstContactAt: at(old, "17:00") } })).lostReason).toBe("no_visit");
    expect(follow(lead({ day: old, booking: { status: "scheduled", firstContactAt: at(old, "17:00") } }), [], [visit("2026-09-08", "no_show")]).lostReason).toBe("no_show");
    expect(follow(lead({ day: old, booking: { status: "scheduled", firstContactAt: at(old, "17:00") } }), [], [visit("2026-09-08", "cancelled")]).lostReason).toBe("canceled");
  });
  it("is too soon to tell inside the first month, and upcoming when a visit is booked", () => {
    const recent = "2026-11-05";
    expect(AD_JUDGE_DAYS).toBe(30);
    expect(follow(lead({ day: recent, booking: { status: "scheduled", firstContactAt: at(recent, "17:00") } })).outcome).toBe("pending");
    expect(follow(lead({ day: "2026-09-01" }), [], [visit("2026-11-25", "upcoming")])).toMatchObject({ outcome: "upcoming", booked: true, called: true });
  });
  it("phone leads: answered, missed and called back", () => {
    const answered = follow(lead({ kind: "call", booking: null, calls: 1, answered: true, day: "2026-09-01" }));
    expect(answered).toMatchObject({ called: true, minutesToCall: 0, lostReason: "didnt_book" });
    const missed = follow(lead({ kind: "call", booking: null, calls: 2, answered: false, day: "2026-09-01" }));
    expect(missed).toMatchObject({ called: false, lostReason: "not_called" });
    const back = follow(lead({ kind: "call", booking: null, calls: 1, answered: false, day: "2026-09-01", at: at("2026-09-01", "15:00"), calledBackAt: at("2026-09-01", "15:25") }));
    expect(back).toMatchObject({ called: true, minutesToCall: 25, lostReason: "no_answer" });
  });
  it("leaves tests and junk out", () => {
    expect(follow(lead({ booking: { status: "spam", firstContactAt: null } }))).toMatchObject({ spam: true, counted: false, waiting: false });
    expect(follow(lead({ kind: "manual", booking: null, outcome: "spam" })).spam).toBe(true);
  });
});

describe("the numbers", () => {
  const campaigns = [camp(1), camp(2, { name: "Flyer", channel: "mail", language: "es", clinicId: 2, clinicName: "Oak Clinic" })];
  const build = () => {
    nextId = 100;
    const leads: ALead[] = [
      lead({ person: "p:1", day: "2026-10-01", keyword: "doctor near me", booking: { status: "scheduled", firstContactAt: at("2026-10-01", "16:05") } }),
      lead({ person: "p:2", day: "2026-10-02", keyword: "doctor near me", booking: { status: "not_booked", firstContactAt: at("2026-10-02", "18:00") } }),
      lead({ person: "p:3", day: "2026-10-03", booking: { status: "spam", firstContactAt: null } }),
      lead({ person: "p:1", day: "2026-10-20", campaignId: 2, kind: "call", booking: null, calls: 1, answered: true }), // same person again
      lead({ person: "p:4", day: "2026-09-15", campaignId: 2, kind: "call", booking: null, calls: 1, answered: false }), // before the range
      lead({ person: "p:5", day: "2026-11-18", campaignId: 2, kind: "manual", booking: null }),
    ];
    return adsSummary({
      campaigns, leads, from: "2026-10-01", to: "2026-11-20", now: NOW, today: TODAY,
      spend: [
        { campaignId: 1, day: "2026-10-01", costCents: 20_000, clicks: 80, impressions: 4000 },
        { campaignId: 1, day: "2026-11-02", costCents: 10_000, clicks: 30, impressions: 1500 },
        { campaignId: 2, day: "2026-09-30", costCents: 99_999, clicks: 0, impressions: 0 }, // before the range
      ],
      claimsByPerson: new Map([["p:1", [claim("2026-10-07", 15_000, 2_500)]]]),
      visitsByPerson: new Map([["p:1", [visit("2026-10-07", "seen")]]]),
    });
  };
  it("adds up spend, leads, patients and insurance", () => {
    const s = build();
    expect(s.spam).toBe(1);
    expect(s.totals).toMatchObject({ spendCents: 30_000, clicks: 110, impressions: 5500, leads: 4, webLeads: 2, callLeads: 1, repeats: 1, counted: 3, called: 3, booked: 1, cameIn: 1, judged: 2, lost: 1, paidCents: 15_000, owesCents: 2_500 });
    const c1 = s.campaigns.find((r) => r.key === "1")!, c2 = s.campaigns.find((r) => r.key === "2")!;
    expect(c1).toMatchObject({ label: "Campaign 1", spendCents: 30_000, leads: 2, counted: 2, cameIn: 1, lost: 1, paidCents: 15_000 });
    expect(c2).toMatchObject({ label: "Flyer", spendCents: 0, leads: 2, repeats: 1, counted: 1, cameIn: 0, judged: 0 });
    expect(s.months.map((m) => [m.key, m.spendCents, m.leads])).toEqual([["2026-10", 20_000, 3], ["2026-11", 10_000, 1]]);
    expect(s.languages.map((r) => r.label).sort()).toEqual(["English", "Spanish"]);
    expect(s.clinics.map((r) => r.label).sort()).toEqual(["Maple Clinic", "Oak Clinic"]);
    expect(s.lost.reasons.find((r) => r.key === "didnt_book")!.leads).toBe(1);
    expect(s.keywords).toEqual([{ key: "doctor near me", leads: 2, booked: 1, cameIn: 1, paidCents: 15_000 }]);
    expect(s.speed).toMatchObject({ called: 3, within15: 2, medianMinutes: 5, waitingNow: 0 });
  });
  it("keeps the first campaign's credit when the same person comes back", () => {
    const again = build().results.find((r) => r.campaignId === 2 && r.person === "p:1")!;
    expect(again).toMatchObject({ repeat: true, counted: false, paidFirstCents: 0 });
  });
  it("lists a campaign that only has clicks", () => {
    nextId = 500;
    const s = adsSummary({ campaigns: [camp(1)], leads: [], from: "2026-11-01", to: "2026-11-20", now: NOW, today: TODAY, spend: [{ campaignId: 1, day: "2026-11-05", costCents: 18_000, clicks: 140, impressions: 9000 }], claimsByPerson: new Map(), visitsByPerson: new Map() });
    expect(s.clicksNoLeads).toEqual({ campaigns: 1, clicks: 140, spendCents: 18_000 });
    expect(adVerdict(s.campaigns[0]!, 10_000)).toBe("fix_page");
    // One stray lead on hundreds of clicks is still a page problem; a normal share of leads is not.
    expect(adVerdict({ ...s.campaigns[0]!, clicks: 800, leads: 1, spendCents: 85_000 }, 10_000)).toBe("fix_page");
    expect(adVerdict({ ...s.campaigns[0]!, clicks: 450, leads: 20, spendCents: 20_000 }, 10_000)).toBe("too_soon");
  });
});

describe("the verdict", () => {
  const row = (over: Partial<AdRow>): AdRow => ({ key: "1", label: "x", spendCents: 0, impressions: 0, clicks: 0, leads: 0, webLeads: 0, callLeads: 0, repeats: 0, existing: 0, counted: 0, called: 0, calledFast: 0, booked: 0, cameIn: 0, judged: 0, lost: 0, paidCents: 0, owesCents: 0, ...over });
  const BENCH = 10_000; // $100 per patient through ZocDoc
  it("waits for enough spend and leads", () => {
    expect(adVerdict(row({ spendCents: 20_000, leads: 6, judged: 6, cameIn: 4 }), BENCH)).toBe("too_soon");
    expect(adVerdict(row({ spendCents: 90_000, leads: 5, judged: 5, cameIn: 3 }), BENCH)).toBe("too_soon");
  });
  it("says to add budget when it beats ZocDoc", () => {
    expect(adVerdict(row({ spendCents: 60_000, leads: 20, judged: 16, cameIn: 9 }), BENCH)).toBe("scale");
  });
  it("points at the follow-up when leads don't come in", () => {
    expect(adVerdict(row({ spendCents: 40_000, leads: 12, judged: 12, cameIn: 2 }), BENCH)).toBe("fix_followup");
    expect(adVerdict(row({ spendCents: 40_000, leads: 12, judged: 12, cameIn: 0 }), BENCH)).toBe("fix_followup");
  });
  it("says to pause when it costs far more than ZocDoc or brings nobody", () => {
    expect(adVerdict(row({ spendCents: 80_000, leads: 12, judged: 10, cameIn: 0 }), BENCH)).toBe("pause");
    expect(adVerdict(row({ spendCents: 150_000, leads: 14, judged: 12, cameIn: 5 }), BENCH)).toBe("pause");
    expect(adVerdict(row({ spendCents: 75_000, leads: 14, judged: 12, cameIn: 5 }), BENCH)).toBe("keep");
  });
  it("calls unpaid channels free", () => {
    expect(adVerdict(row({ leads: 3 }), BENCH)).toBe("free");
    expect(adVerdict(row({ spendCents: 0 }), BENCH, false)).toBe("free");
  });
});
