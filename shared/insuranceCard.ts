// Reading an insurance card photo (2026-11-17): what the AI is asked, and a strict check of its answer.
// The AI only copies what is printed on the card (insurer, plan, member ID, group number, copays); it
// never guesses a number. Used for the Copays & deductibles answer for patients with no visits yet.

export const CARD_PLAN_TYPES = ["commercial", "medicare_advantage", "original_medicare", "medicaid", "marketplace", "other"] as const;
export type CardPlanType = (typeof CARD_PLAN_TYPES)[number];

/** What a card says. Amounts in cents; null = not printed (or not readable). */
export interface CardFacts {
  isCard: boolean;
  payer: string | null;
  planName: string | null;
  planType: CardPlanType | null;
  memberId: string | null;
  groupNumber: string | null;
  /** Primary care / office visit copay. */
  pcpCopayCents: number | null;
  specialistCopayCents: number | null;
  urgentCareCopayCents: number | null;
  erCopayCents: number | null;
  /** Individual in-network deductible, when printed. */
  deductibleCents: number | null;
  coinsurancePct: number | null;
  /** The card says HSA, HDHP, high deductible or Bronze: the deductible comes first. */
  highDeductible: boolean;
}

export const EMPTY_CARD: CardFacts = {
  isCard: false, payer: null, planName: null, planType: null, memberId: null, groupNumber: null,
  pcpCopayCents: null, specialistCopayCents: null, urgentCareCopayCents: null, erCopayCents: null, deductibleCents: null, coinsurancePct: null, highDeductible: false,
};

export const CARD_PROMPT = `You are reading a photo of a United States health insurance card for a medical office's front desk.
Copy ONLY what is printed on the card. Never guess or fill in a number that is not printed. If something is not on the card or you can't read it, use null.

Answer with ONLY this JSON (no other text):
{
  "isInsuranceCard": true or false,
  "payer": the insurance company's name as printed (for example "Blue Cross Blue Shield of Texas", "Aetna", "Ambetter", "UnitedHealthcare"),
  "planName": the plan or product name as printed (for example "Blue Choice PPO", "Essential Care Silver", "Medicare Advantage HMO"), or null,
  "planType": one of "commercial", "medicare_advantage", "original_medicare", "medicaid", "marketplace", "other", or null,
  "memberId": the member / subscriber / ID number, or null,
  "groupNumber": the group number (often "Group", "Grp", "GRP #"), or null,
  "copays": {
    "pcp": the primary care / PCP / office visit copay in dollars as a number, or null,
    "specialist": the specialist copay in dollars, or null,
    "urgentCare": the urgent care copay in dollars, or null,
    "er": the emergency room copay in dollars, or null
  },
  "deductible": the individual in-network deductible in dollars if printed, or null,
  "coinsurancePercent": the coinsurance percent the member pays if printed (for example 20), or null,
  "highDeductible": true only if the card says HSA, HDHP, "high deductible" or Bronze; otherwise false
}

Rules:
- If two amounts are printed for the same service (in-network and out-of-network), use the in-network one.
- A red-white-and-blue Original Medicare card has no copays: planType "original_medicare", copays null.
- If the photo is not an insurance card (an ID, a blank page, the back with only phone numbers), set "isInsuranceCard" to false and the rest to null.`;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const text = (v: unknown, max = 120): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s && !/^(null|none|n\/?a|unknown)$/i.test(s) ? s.slice(0, max) : null;
};
/** "$25", "25.00", 25 → 2500 cents; anything else (or a silly amount) → null. */
const dollars = (v: unknown, max: number): number | null => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.replace(/[$,\s]/g, "") : "";
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= max ? Math.round(n * 100) : null;
};

/** The AI's answer → checked card facts (anything odd is dropped, never guessed). */
export function parseCardReading(raw: string): CardFacts {
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { ...EMPTY_CARD };
  let j: Json | null = null;
  try { j = obj(JSON.parse(raw.slice(start, end + 1))); } catch { return { ...EMPTY_CARD }; }
  if (!j || j.isInsuranceCard !== true) return { ...EMPTY_CARD };
  const c = obj(j.copays) ?? {};
  const type = text(j.planType, 30);
  const pct = typeof j.coinsurancePercent === "number" || typeof j.coinsurancePercent === "string" ? Number(String(j.coinsurancePercent).replace("%", "")) : NaN;
  const planName = text(j.planName);
  const facts: CardFacts = {
    isCard: true,
    payer: text(j.payer),
    planName,
    planType: (CARD_PLAN_TYPES as readonly string[]).includes(type ?? "") ? (type as CardPlanType) : null,
    memberId: text(j.memberId, 60),
    groupNumber: text(j.groupNumber, 60),
    pcpCopayCents: dollars(c.pcp, 500),
    specialistCopayCents: dollars(c.specialist, 1000),
    urgentCareCopayCents: dollars(c.urgentCare, 1000),
    erCopayCents: dollars(c.er, 5000),
    deductibleCents: dollars(j.deductible, 50_000),
    coinsurancePct: Number.isFinite(pct) && pct > 0 && pct < 100 ? Math.round(pct) : null,
    highDeductible: j.highDeductible === true || /\b(hsa|hdhp|high deductible|bronze)\b/i.test(planName ?? ""),
  };
  // Original Medicare has no copays, whatever was read.
  if (facts.planType === "original_medicare") facts.pcpCopayCents = facts.specialistCopayCents = facts.urgentCareCopayCents = facts.erCopayCents = null;
  return facts;
}

/** Image types the AI can read. */
export const CARD_IMAGE_FORMATS: Record<string, "jpeg" | "png" | "webp" | "gif"> = { "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
