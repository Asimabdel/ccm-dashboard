// Ads (Master Billing, owner only, 2026-11-20): the pure rules behind the Ads tab.
//
// A campaign has a short CODE that rides in its tracking link (utm_campaign) and, optionally, its own phone
// number. A LEAD is one person's first contact from a campaign: a website booking that arrived with the code,
// a call to the campaign's number, or one added by hand. Each lead is then followed the same way ZocDoc
// bookings are: were they called, did they book, did they come in, and what did insurance pay.
import { WAIT_ALERT_MIN, officeMinutesBetween, type BookingStatus } from "./booking";
import { sheetCents } from "./billSheet";
import { parseDateValue } from "./workspace";
import type { ZClaim, ZVisit } from "./zocdoc";

// ── Campaigns ────────────────────────────────────────────────────────────────

export const AD_CHANNELS = [
  { key: "google_search", label: "Google Search", source: "google", medium: "cpc", paid: true },
  { key: "google_profile", label: "Google clinic page (free)", source: "google", medium: "organic", paid: false },
  { key: "facebook", label: "Facebook / Instagram", source: "facebook", medium: "paid_social", paid: true },
  { key: "nextdoor", label: "Nextdoor", source: "nextdoor", medium: "paid_social", paid: true },
  { key: "mail", label: "Mail / flyer", source: "mail", medium: "print", paid: true },
  { key: "other", label: "Other", source: "other", medium: "ad", paid: true },
] as const;
export type AdChannel = (typeof AD_CHANNELS)[number]["key"];
export const AD_CHANNEL_KEYS = AD_CHANNELS.map((c) => c.key) as [AdChannel, ...AdChannel[]];
export const adChannel = (key: string) => AD_CHANNELS.find((c) => c.key === key) ?? AD_CHANNELS[AD_CHANNELS.length - 1]!;

export const AD_LANGUAGES = [{ key: "en", label: "English" }, { key: "es", label: "Spanish" }, { key: "ar", label: "Arabic" }] as const;
export type AdLanguage = (typeof AD_LANGUAGES)[number]["key"];
export const AD_LANGUAGE_KEYS = AD_LANGUAGES.map((l) => l.key) as [AdLanguage, ...AdLanguage[]];
export const adLanguageLabel = (key: string) => AD_LANGUAGES.find((l) => l.key === key)?.label ?? key;

export const AD_STATUSES = ["active", "paused", "ended"] as const;
export type AdStatus = (typeof AD_STATUSES)[number];

/** A campaign code: lowercase letters, digits and dashes, 3–40 long ("g-katy-en"). */
export const isAdCode = (s: string) => /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s);
/** Any text → a code ("Google · Katy (EN)" → "google-katy-en"). */
export function adCode(text: string): string {
  const s = String(text ?? "").toLowerCase().normalize("NFKD").replace(/[^\x00-\x7f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return s.length >= 3 ? s : "";
}

export const AD_SITE = "https://mypcpdr.com/";

/**
 * What goes on the end of the ad's web address so MyPCP knows which campaign a booking came from. Google and
 * Facebook fill in the {curly} parts themselves (the keyword typed, the ad shown, phone or computer).
 */
export function trackingSuffix(c: { channel: string; code: string }): string {
  const ch = adChannel(c.channel);
  const base = `utm_source=${ch.source}&utm_medium=${ch.medium}&utm_campaign=${c.code}`;
  if (c.channel === "google_search") return `${base}&utm_term={keyword}&utm_content={creative}&utm_device={device}`;
  if (c.channel === "facebook") return `${base}&utm_content={{ad.name}}`;
  return base;
}
/** The plain link for a campaign (for a flyer's QR code, a post, or a Google clinic page). */
export function trackingUrl(c: { channel: string; code: string; landingUrl?: string | null }): string {
  const ch = adChannel(c.channel);
  const page = (c.landingUrl || AD_SITE).trim();
  return `${page}${page.includes("?") ? "&" : "?"}utm_source=${ch.source}&utm_medium=${ch.medium}&utm_campaign=${c.code}`;
}

// ── What the website hands over with a booking ───────────────────────────────

export interface AdTouch {
  /** utm_campaign = the campaign's code. */
  campaign: string;
  source: string | null;
  medium: string | null;
  /** The search words that showed the ad (utm_term). */
  keyword: string | null;
  /** Which ad (utm_content). */
  adName: string | null;
  /** Google's / Facebook's click number. Kept in MyPCP only; never sent anywhere. */
  clickId: string | null;
  device: string | null;
  /** The page they landed on (path only). */
  landing: string | null;
}

const clip = (v: unknown, max: number) => {
  if (typeof v !== "string") return null;
  let s = v;
  try { s = decodeURIComponent(v); } catch { /* keep it as sent */ }
  s = s.replace(/[\u0000-\u001f<>"'`\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return s || null;
};
const DEVICES: Record<string, string> = { m: "phone", c: "computer", t: "tablet", mobile: "phone", desktop: "computer", tablet: "tablet", phone: "phone", computer: "computer" };

/** The "ad" part of a website booking → what we keep. Null when it names no campaign. Nothing here is trusted. */
export function cleanAdTouch(raw: unknown): AdTouch | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const campaign = adCode(clip(r.campaign ?? r.c, 60) ?? "");
  if (!campaign) return null;
  const landing = clip(r.landing ?? r.l, 160);
  return {
    campaign,
    source: clip(r.source ?? r.s, 40)?.toLowerCase() ?? null,
    medium: clip(r.medium ?? r.m, 40)?.toLowerCase() ?? null,
    keyword: clip(r.keyword ?? r.term ?? r.t, 120)?.toLowerCase() ?? null,
    adName: clip(r.adName ?? r.content ?? r.n, 120),
    clickId: clip(r.clickId ?? r.k, 200)?.replace(/[^\w.\-:]/g, "") || null,
    device: DEVICES[(clip(r.device ?? r.d, 12) ?? "").toLowerCase()] ?? null,
    landing: landing ? landing.split(/[?#]/)[0]!.slice(0, 160) || null : null,
  };
}
/** Which channel a tracking link's source belongs to (for a campaign MyPCP first hears of from a booking). */
export function channelForSource(source: string | null, medium: string | null): AdChannel {
  const s = `${source ?? ""} ${medium ?? ""}`;
  if (/facebook|instagram|meta|\bfb\b|\big\b/.test(s)) return "facebook";
  if (/nextdoor/.test(s)) return "nextdoor";
  if (/mail|print|flyer|qr/.test(s)) return "mail";
  if (/google|adwords/.test(s)) return /organic|gbp|profile|maps|local/.test(s) ? "google_profile" : "google_search";
  return "other";
}

// ── Spend ────────────────────────────────────────────────────────────────────

const plusDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** One amount for a stretch of days → the same amount each day, in whole cents that add back up exactly. */
export function spreadSpend(from: string, to: string, cents: number): { day: string; costCents: number }[] {
  const n = daysBetween(from, to) + 1;
  if (n < 1 || n > 400 || cents < 0) return [];
  const each = Math.floor(cents / n);
  let extra = cents - each * n;
  return Array.from({ length: n }, (_, i) => ({ day: plusDays(from, i), costCents: each + (extra-- > 0 ? 1 : 0) }));
}

export interface SpendFileRow { campaignName: string; day: string | null; costCents: number; clicks: number; impressions: number }
export interface SpendFile {
  /** Which report it looks like. */
  kind: "google" | "facebook" | "other";
  rows: SpendFileRow[];
  /** True when the file has a day on every row (else the owner gives the dates it covers). */
  hasDays: boolean;
  skipped: number;
  problem: string | null;
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "2026-11-01", "11/1/2026", "Nov 1, 2026", "1 Nov 2026" → "2026-11-01". */
export function parseAdDay(raw: string): string | null {
  const s = String(raw ?? "").trim();
  const direct = parseDateValue(s);
  if (direct) return direct;
  const m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(s) ?? null;
  const dmy = /^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.?,? (\d{4})$/.exec(s);
  const mon = MONTHS.indexOf((m?.[1] ?? dmy?.[2] ?? "").toLowerCase());
  const dd = Number(m?.[2] ?? dmy?.[1]), yy = Number(m?.[3] ?? dmy?.[3]);
  if (mon < 0 || !(dd >= 1 && dd <= 31) || !yy) return null;
  return `${yy}-${String(mon + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}
const num = (raw: string | undefined) => {
  const n = Number(String(raw ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/**
 * Read a spend report downloaded from Google Ads (Campaigns → Download, with the "Day" column) or Facebook Ads
 * (Campaigns → Export, broken down by day). Title lines above the header and "Total" lines are ignored.
 */
export function parseSpendFile(rows: string[][]): SpendFile {
  const norm = (c: string | undefined) => String(c ?? "").trim().toLowerCase();
  const find = (cells: string[], re: RegExp) => cells.findIndex((c) => re.test(c));
  let headerRow = -1, col = { campaign: -1, cost: -1, day: -1, clicks: -1, impressions: -1 };
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i] ?? []).map(norm);
    const campaign = find(cells, /^campaign( name)?$/), cost = find(cells, /^(cost|spend|amount spent.*)$/);
    if (campaign < 0 || cost < 0) continue;
    headerRow = i;
    col = { campaign, cost, day: find(cells, /^(day|date|reporting starts)$/), clicks: find(cells, /^(clicks|link clicks|clicks \(all\))$/), impressions: find(cells, /^(impr\.?|impressions)$/) };
    break;
  }
  if (headerRow < 0) return { kind: "other", rows: [], hasDays: false, skipped: 0, problem: "This file needs a \"Campaign\" column and a \"Cost\" (or \"Amount spent\") column." };
  const header = (rows[headerRow] ?? []).map(norm);
  const kind = header.some((c) => /amount spent|reporting starts/.test(c)) ? "facebook" : header.some((c) => /^impr\.?$/.test(c) || c === "cost") ? "google" : "other";
  const out: SpendFileRow[] = [];
  let skipped = 0;
  for (const r of rows.slice(headerRow + 1)) {
    const name = String(r[col.campaign] ?? "").trim();
    if (!name || /^total\b/i.test(name) || /^total\b/i.test(String(r[0] ?? "").trim())) continue;
    const costCents = sheetCents(r[col.cost]);
    const day = col.day >= 0 ? parseAdDay(String(r[col.day] ?? "")) : null;
    if (costCents == null || costCents < 0 || (col.day >= 0 && !day)) { skipped++; continue; }
    out.push({ campaignName: name.slice(0, 160), day, costCents, clicks: col.clicks >= 0 ? num(r[col.clicks]) : 0, impressions: col.impressions >= 0 ? num(r[col.impressions]) : 0 });
  }
  return { kind, rows: out, hasDays: col.day >= 0, skipped, problem: out.length ? null : "No spend rows were found in this file." };
}

/** Which of our campaigns a report's campaign name belongs to: its saved report name, its code inside the name, or the same name. */
export function matchSpendCampaign<T extends { id: number; name: string; code: string; outsideName?: string | null }>(reportName: string, campaigns: T[]): T | null {
  const n = reportName.trim().toLowerCase();
  if (!n) return null;
  const hits = (f: (c: T) => boolean) => { const l = campaigns.filter(f); return l.length === 1 ? l[0]! : null; };
  return hits((c) => (c.outsideName ?? "").trim().toLowerCase() === n)
    ?? hits((c) => new RegExp(`(^|[^a-z0-9])${c.code.replace(/[-]/g, "[-_ ]?")}([^a-z0-9]|$)`).test(n))
    ?? hits((c) => c.name.trim().toLowerCase() === n);
}

// ── Following each lead ──────────────────────────────────────────────────────

export type AdLeadKind = "web" | "call" | "manual";
export const AD_LEAD_KIND_LABELS: Record<AdLeadKind, string> = { web: "Website booking", call: "Phone call", manual: "Added by hand" };
/** What staff marked for a phone or hand-added lead (website bookings carry their own status). */
export const AD_LEAD_OUTCOMES = ["scheduled", "not_booked", "spam"] as const;
export type AdLeadOutcome = (typeof AD_LEAD_OUTCOMES)[number];

/** A lead with no visit this many days later counts as lost; before that it's "too soon to tell". */
export const AD_JUDGE_DAYS = 30;
/** The same person again within this many days is the same lead (the first campaign keeps the credit). */
export const AD_REPEAT_DAYS = 90;
/** Insurance paid in the first visits vs later ones (same split as the ZocDoc tab). */
export const AD_FIRST_DAYS = 45;

export interface ACampaign {
  id: number; name: string; channel: AdChannel; code: string; clinicId: number | null; clinicName: string | null; language: string;
  monthlyBudgetCents: number | null; status: AdStatus;
}
export interface ASpend { campaignId: number; day: string; costCents: number; clicks: number; impressions: number }
export interface ALead {
  id: number;
  campaignId: number;
  kind: AdLeadKind;
  at: Date;
  /** Clinic-local day of `at`. */
  day: string;
  /** The person: their MyPCP key when known, else their phone ("ph:…"), else the lead itself ("l:…"). */
  person: string;
  matched: boolean;
  /** Website booking: its status and when staff first called. */
  booking: { status: BookingStatus; firstContactAt: Date | null } | null;
  /** Calls to the campaign's number. */
  calls: number;
  answered: boolean;
  calledBackAt: Date | null;
  outcome: AdLeadOutcome | null;
  keyword: string | null;
  adName: string | null;
}

export type AdOutcome = "came_in" | "upcoming" | "pending" | "never";
export const AD_OUTCOME_LABELS: Record<AdOutcome, string> = { came_in: "Came in", upcoming: "Has a visit booked", pending: "Too soon to tell", never: "Never came in" };
export type AdLostReason = "not_called" | "no_answer" | "didnt_book" | "no_show" | "canceled" | "no_visit";
export const AD_LOST_REASONS: { key: AdLostReason; label: string; note: string }[] = [
  { key: "not_called", label: "Never called back", note: "A booking request or a missed call that nobody returned. The ad was paid for; the patient never heard from us." },
  { key: "no_answer", label: "Called, never reached", note: "We called and they didn't pick up. More tries, a text, or a faster first call usually fixes this." },
  { key: "didnt_book", label: "Reached, didn't book", note: "We talked and they didn't book: wrong insurance, no times that worked, or just looking." },
  { key: "no_show", label: "Booked, didn't show", note: "A visit was booked and they didn't come. A reminder call or text the day before helps." },
  { key: "canceled", label: "Booked, then canceled", note: "The visit was canceled and never rebooked." },
  { key: "no_visit", label: "Booked, no visit on file", note: "Marked as booked, but no visit shows on the schedule or in the chart." },
];

export interface ALeadResult {
  id: number;
  campaignId: number;
  kind: AdLeadKind;
  day: string;
  person: string;
  matched: boolean;
  keyword: string | null;
  /** A test or junk request: left out of every number. */
  spam: boolean;
  /** The same person as an earlier lead: counted as a lead here, the patient belongs to the first one. */
  repeat: boolean;
  /** Was our patient before the ad (a visit or a claim earlier). */
  existing: boolean;
  /** Counts as a new patient lead: not spam, not a repeat, not already ours. */
  counted: boolean;
  called: boolean;
  /** Office minutes from the request (or missed call) to our first call. 0 when we answered their call. */
  minutesToCall: number | null;
  /** Not called yet, the 15 office minutes are up, and still recent enough to save. */
  waiting: boolean;
  /** A phone lead whose call we picked up. */
  answered: boolean;
  booked: boolean;
  cameIn: boolean;
  firstVisit: string | null;
  outcome: AdOutcome;
  lostReason: AdLostReason | null;
  paidFirstCents: number;
  paidLaterCents: number;
  owesCents: number;
}

/** Follow one lead: called → booked → came in → paid. `earlier` = the same person's earlier lead exists. */
export function followLead(lead: ALead, earlier: boolean, claims: ZClaim[], visits: ZVisit[], now: Date, today: string): ALeadResult {
  const spam = lead.booking?.status === "spam" || lead.outcome === "spam";
  const before = plusDays(lead.day, -1);
  const existing = claims.some((c) => c.date < before) || visits.some((v) => v.kind === "seen" && v.date < before);
  const after = visits.filter((v) => v.date >= lead.day);
  const claimsAfter = claims.filter((c) => c.date >= lead.day);
  const seen = after.filter((v) => v.kind === "seen" && v.date <= today).map((v) => v.date).concat(claimsAfter.map((c) => c.date)).sort();
  const cameIn = seen.length > 0;
  const upcoming = after.some((v) => v.kind === "upcoming" && v.date >= today);

  // Called: a website booking once staff mark anything on it; a phone lead when we picked up or called back.
  let called = false, minutesToCall: number | null = null;
  if (lead.kind === "web") {
    called = !!lead.booking?.firstContactAt;
    if (called) minutesToCall = officeMinutesBetween(lead.at, lead.booking!.firstContactAt!);
  } else if (lead.kind === "call") {
    called = lead.answered || !!lead.calledBackAt || !!lead.outcome;
    minutesToCall = lead.answered ? 0 : lead.calledBackAt ? officeMinutesBetween(lead.at, lead.calledBackAt) : null;
  } else called = true;
  if (cameIn || upcoming) called = true;

  const markedBooked = lead.booking?.status === "scheduled" || lead.outcome === "scheduled";
  const booked = markedBooked || cameIn || upcoming || after.some((v) => v.kind === "no_show" || v.kind === "cancelled");
  const outcome: AdOutcome = cameIn ? "came_in" : upcoming ? "upcoming" : plusDays(lead.day, AD_JUDGE_DAYS) > today ? "pending" : "never";
  // Waiting = still worth a call: not called, the 15 office minutes are up, and not yet old enough to count as lost.
  const waiting = !spam && !called && outcome === "pending" && officeMinutesBetween(lead.at, now) >= WAIT_ALERT_MIN;
  let lostReason: AdLostReason | null = null;
  if (outcome === "never") {
    const status = lead.booking?.status;
    lostReason = after.some((v) => v.kind === "no_show") ? "no_show"
      : after.some((v) => v.kind === "cancelled") ? "canceled"
      : markedBooked ? "no_visit"
      : !called ? "not_called"
      : status === "no_answer" || (lead.kind === "call" && !lead.answered && !lead.outcome) ? "no_answer"
      : "didnt_book";
  }
  const counted = !spam && !earlier && !existing;
  const firstEnd = plusDays(lead.day, AD_FIRST_DAYS);
  const sum = (list: ZClaim[], f: (c: ZClaim) => number) => list.reduce((s, c) => s + f(c), 0);
  return {
    id: lead.id, campaignId: lead.campaignId, kind: lead.kind, day: lead.day, person: lead.person, matched: lead.matched, keyword: lead.keyword,
    spam, repeat: !spam && earlier, existing: !spam && existing, counted, called, minutesToCall, waiting, answered: lead.kind === "call" && lead.answered, booked, cameIn, firstVisit: seen[0] ?? null, outcome, lostReason,
    paidFirstCents: counted ? sum(claimsAfter.filter((c) => c.date <= firstEnd), (c) => c.paidCents) : 0,
    paidLaterCents: counted ? sum(claimsAfter.filter((c) => c.date > firstEnd), (c) => c.paidCents) : 0,
    owesCents: counted ? sum(claimsAfter, (c) => c.owesCents) : 0,
  };
}

// ── The numbers ──────────────────────────────────────────────────────────────

export interface AdRow {
  key: string;
  label: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  /** Every real lead (tests left out). */
  leads: number;
  webLeads: number;
  callLeads: number;
  repeats: number;
  existing: number;
  /** New-patient leads: what the rest of the row counts. */
  counted: number;
  called: number;
  /** Called within 15 office minutes. */
  calledFast: number;
  booked: number;
  cameIn: number;
  /** New-patient leads old enough to judge (or already came in). */
  judged: number;
  lost: number;
  paidCents: number;
  owesCents: number;
}
const blank = (key: string, label: string): AdRow => ({
  key, label, spendCents: 0, impressions: 0, clicks: 0, leads: 0, webLeads: 0, callLeads: 0, repeats: 0, existing: 0, counted: 0, called: 0, calledFast: 0,
  booked: 0, cameIn: 0, judged: 0, lost: 0, paidCents: 0, owesCents: 0,
});

export type AdVerdict = "scale" | "keep" | "fix_followup" | "fix_page" | "pause" | "too_soon" | "free";
export const AD_VERDICTS: Record<AdVerdict, { label: string; note: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  scale: { label: "Working: add budget", tone: "good", note: "It brings in patients for less than ZocDoc does. Raise the budget a step at a time and watch that the cost per patient holds." },
  keep: { label: "OK: keep watching", tone: "neutral", note: "Patients are coming in at a fair cost. Leave it running." },
  fix_followup: { label: "Leads aren't coming in", tone: "warn", note: "People are asking for visits but most never come in. Look at the follow-up first: how fast they're called and how many no-show." },
  fix_page: { label: "Clicks, hardly any leads", tone: "warn", note: "People click the ad and leave without booking or calling. Check the page it opens, the phone number on it, and the search words." },
  pause: { label: "Pause or change it", tone: "bad", note: "It has cost real money and brought in nobody. Pause it, or change who it's aimed at." },
  too_soon: { label: "Too soon to tell", tone: "neutral", note: "Not enough spend or leads yet to judge. Give it more time." },
  free: { label: "Free", tone: "neutral", note: "Nothing is spent here; every patient is a bonus." },
};
/**
 * A plain verdict for one campaign. `benchmarkCents` = what a patient who came in costs through ZocDoc
 * (the number to beat); the dollar and lead counts below are deliberately simple.
 */
export function adVerdict(r: AdRow, benchmarkCents: number, paid = true): AdVerdict {
  if (!paid || (r.spendCents === 0 && r.leads > 0)) return "free";
  if (r.clicks >= 100 && r.leads * 200 < r.clicks && r.spendCents >= 15_000) return "fix_page";
  if (r.spendCents < 30_000 || r.judged < 8) return "too_soon";
  if (r.cameIn === 0) return r.spendCents >= 50_000 ? "pause" : "fix_followup";
  const perPatient = r.spendCents / r.cameIn;
  if (r.cameIn / r.judged < 0.25) return "fix_followup";
  if (perPatient <= benchmarkCents && r.cameIn >= 5) return "scale";
  return perPatient > benchmarkCents * 2 ? "pause" : "keep";
}

export interface AdsSummary {
  totals: AdRow;
  campaigns: AdRow[];
  channels: AdRow[];
  clinics: AdRow[];
  languages: AdRow[];
  months: AdRow[];
  /** Website leads by the search words that showed the ad (no spend: Google's own report has the cost per word). */
  keywords: { key: string; leads: number; booked: number; cameIn: number; paidCents: number }[];
  speed: {
    /** Website and missed-call leads we called: the middle time, in office minutes. */
    medianMinutes: number | null;
    called: number;
    within15: number;
    /** Not called yet, 15+ office minutes old (right now). */
    waitingNow: number;
  };
  lost: { judged: number; lost: number; reasons: { key: AdLostReason; leads: number }[] };
  spam: number;
  /** Clicks paid for on campaigns that brought no lead at all in the range. */
  clicksNoLeads: { campaigns: number; clicks: number; spendCents: number };
  results: ALeadResult[];
}

/**
 * Spend vs. what the leads became. `leads` may start before `from` (so a repeat is recognised); only leads on or
 * after `from` are counted. Spend and clicks land in the month they were paid; patients and insurance in the month
 * of the lead.
 */
export function adsSummary(input: {
  campaigns: ACampaign[]; spend: ASpend[]; leads: ALead[]; from: string; to: string;
  claimsByPerson: Map<string, ZClaim[]>; visitsByPerson: Map<string, ZVisit[]>; now: Date; today: string;
}): AdsSummary {
  const { campaigns, from, to, now, today } = input;
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const sorted = [...input.leads].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id);
  const lastGood = new Map<string, string>();
  const results: ALeadResult[] = [];
  for (const lead of sorted) {
    const prev = lastGood.get(lead.person);
    const earlier = !!prev && daysBetween(prev, lead.day) <= AD_REPEAT_DAYS;
    const r = followLead(lead, earlier, input.claimsByPerson.get(lead.person) ?? [], input.visitsByPerson.get(lead.person) ?? [], now, today);
    if (!r.spam && !earlier) lastGood.set(lead.person, lead.day);
    if (lead.day >= from && lead.day <= to) results.push(r);
  }

  const totals = blank("", "Total");
  const maps = { campaigns: new Map<string, AdRow>(), channels: new Map<string, AdRow>(), clinics: new Map<string, AdRow>(), languages: new Map<string, AdRow>(), months: new Map<string, AdRow>() };
  const row = (m: Map<string, AdRow>, key: string, label: string) => { if (!m.has(key)) m.set(key, blank(key, label)); return m.get(key)!; };
  const rowsFor = (c: ACampaign | undefined, campaignId: number, month: string) => [
    totals,
    row(maps.campaigns, String(campaignId), c?.name ?? "(removed campaign)"),
    row(maps.channels, c?.channel ?? "other", adChannel(c?.channel ?? "other").label),
    row(maps.clinics, c?.clinicId ? String(c.clinicId) : "", c?.clinicId ? c.clinicName ?? "Clinic" : "All clinics"),
    row(maps.languages, c?.language ?? "en", adLanguageLabel(c?.language ?? "en")),
    row(maps.months, month, month),
  ];
  for (const c of campaigns) row(maps.campaigns, String(c.id), c.name);
  for (const s of input.spend) {
    if (s.day < from || s.day > to) continue;
    for (const r of rowsFor(byId.get(s.campaignId), s.campaignId, s.day.slice(0, 7))) { r.spendCents += s.costCents; r.clicks += s.clicks; r.impressions += s.impressions; }
  }
  const minutes: number[] = [];
  let spam = 0, waitingNow = 0, timed = 0, within15 = 0;
  const reasons = new Map<AdLostReason, number>();
  const keywords = new Map<string, { key: string; leads: number; booked: number; cameIn: number; paidCents: number }>();
  for (const r of results) {
    if (r.spam) { spam++; continue; }
    if (r.waiting) waitingNow++;
    const timedLead = r.kind !== "manual" && r.minutesToCall != null;
    if (timedLead) { timed++; minutes.push(r.minutesToCall!); if (r.minutesToCall! <= WAIT_ALERT_MIN) within15++; }
    for (const x of rowsFor(byId.get(r.campaignId), r.campaignId, r.day.slice(0, 7))) {
      x.leads++;
      if (r.kind === "web") x.webLeads++; else if (r.kind === "call") x.callLeads++;
      if (r.repeat) x.repeats++;
      if (r.existing) x.existing++;
      if (!r.counted) continue;
      x.counted++;
      if (r.called) x.called++;
      if (timedLead && r.minutesToCall! <= WAIT_ALERT_MIN) x.calledFast++;
      if (r.booked) x.booked++;
      if (r.cameIn) x.cameIn++;
      if (r.outcome === "came_in" || r.outcome === "never") x.judged++;
      if (r.outcome === "never") x.lost++;
      x.paidCents += r.paidFirstCents + r.paidLaterCents;
      x.owesCents += r.owesCents;
    }
    if (r.counted && r.outcome === "never" && r.lostReason) reasons.set(r.lostReason, (reasons.get(r.lostReason) ?? 0) + 1);
    if (r.counted && r.kind === "web" && r.keyword) {
      const k = keywords.get(r.keyword) ?? { key: r.keyword, leads: 0, booked: 0, cameIn: 0, paidCents: 0 };
      k.leads++; if (r.booked) k.booked++; if (r.cameIn) k.cameIn++; k.paidCents += r.paidFirstCents + r.paidLaterCents;
      keywords.set(r.keyword, k);
    }
  }
  minutes.sort((a, b) => a - b);
  const list = (m: Map<string, AdRow>) => Array.from(m.values());
  const bySpend = (a: AdRow, b: AdRow) => b.spendCents - a.spendCents || b.leads - a.leads || a.label.localeCompare(b.label);
  const silent = list(maps.campaigns).filter((r) => r.clicks > 0 && r.leads === 0);
  return {
    totals,
    campaigns: list(maps.campaigns).sort(bySpend),
    channels: list(maps.channels).sort(bySpend),
    clinics: list(maps.clinics).sort(bySpend),
    languages: list(maps.languages).sort(bySpend),
    months: list(maps.months).sort((a, b) => a.key.localeCompare(b.key)),
    keywords: Array.from(keywords.values()).sort((a, b) => b.cameIn - a.cameIn || b.leads - a.leads || a.key.localeCompare(b.key)).slice(0, 40),
    speed: { medianMinutes: minutes.length ? minutes[Math.floor(minutes.length / 2)]! : null, called: timed, within15, waitingNow },
    lost: { judged: totals.judged, lost: totals.lost, reasons: AD_LOST_REASONS.map(({ key }) => ({ key, leads: reasons.get(key) ?? 0 })) },
    spam,
    clicksNoLeads: { campaigns: silent.length, clicks: silent.reduce((s, r) => s + r.clicks, 0), spendCents: silent.reduce((s, r) => s + r.spendCents, 0) },
    results,
  };
}

/** How this month's spend compares with the budget so far ("on pace" = within 15% of where the month should be). */
export function budgetPace(spentCents: number, budgetCents: number | null, today: string): { expectedCents: number; pace: "under" | "on" | "over" } | null {
  if (!budgetCents) return null;
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const expectedCents = Math.round((budgetCents * d) / daysInMonth);
  return { expectedCents, pace: spentCents > expectedCents * 1.15 ? "over" : spentCents < expectedCents * 0.85 ? "under" : "on" };
}
