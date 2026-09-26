// Insurance checker: "do we take this plan?" The plan list and wording mirror the checker on
// mypcpdr.com (TIOPA FY2026 plan checklist + UnitedHealthcare, built 2026-07-08). If the clinic's
// plans change, update both places. This is about network participation only; a patient's
// active coverage still has to be verified with their member ID (e.g. in Availity).

export type PlanGroup = "commercial" | "marketplace" | "medicare" | "military" | "networks" | "injury";

export const PLAN_GROUP_LABELS: Record<PlanGroup, string> = {
  commercial: "Commercial",
  marketplace: "Marketplace (ACA)",
  medicare: "Medicare & Medicare Advantage",
  military: "Military & veterans",
  networks: "PPO networks & other plans",
  injury: "Workers' comp & injury",
};

export interface Plan {
  name: string;
  /** Extra search words (normalized: lowercase letters/digits). */
  keys: string;
  group: PlanGroup;
  /** Something the front desk should know before booking. */
  note?: string;
}

const DFW_NOTE = "Listed as Dallas–Fort Worth on the network contract; confirm the member's plan covers Houston-area visits before booking.";
const BH_NOTE = "Behavioral health is carved out on the network contract. Primary care is fine; check before enrolling in BHI.";

export const PLANS: Plan[] = [
  { name: "Aetna (PPO, HMO, EPO)", keys: "aetna meritain walmart", group: "commercial" },
  { name: "Blue Cross Blue Shield of Texas", keys: "bcbs bluecross blueshield bcbstx blueadvantage blueessentials bluepremier bluechoice myblue highperformance", group: "commercial" },
  { name: "UnitedHealthcare", keys: "united unitedhealthcare uhc umr", group: "commercial" },
  { name: "Cigna Healthcare of Texas", keys: "cigna", group: "commercial", note: BH_NOTE },
  { name: "Scott and White Health Plan", keys: "scottandwhite swhp baylorscottwhite", group: "commercial" },
  { name: "Oscar Health (Marketplace)", keys: "oscar", group: "marketplace", note: BH_NOTE },
  { name: "Ambetter (Marketplace)", keys: "ambetter", group: "marketplace" },
  { name: "Molina Healthcare (Marketplace)", keys: "molina", group: "marketplace" },
  { name: "Imperial (Marketplace)", keys: "imperial", group: "marketplace" },
  { name: "Original Medicare", keys: "medicare partb", group: "medicare" },
  { name: "Aetna Medicare Advantage", keys: "aetnamedicare", group: "medicare" },
  { name: "BCBSTX Medicare Advantage", keys: "bluecrossmedicare", group: "medicare" },
  { name: "Humana / ChoiceCare Medicare Advantage", keys: "humana choicecare", group: "medicare", note: DFW_NOTE },
  { name: "HealthSpring Medicare Advantage", keys: "healthspring", group: "medicare" },
  { name: "Wellcare Medicare Advantage", keys: "wellcare texanplus allwell", group: "medicare" },
  { name: "WellPoint (Amerigroup) Medicare Advantage", keys: "wellpoint amerigroup", group: "medicare" },
  { name: "Molina Medicare Advantage", keys: "molinamedicare dsnp", group: "medicare" },
  { name: "Provider Partners Health Plan", keys: "providerpartners", group: "medicare" },
  { name: "American Health Plan of Texas", keys: "americanhealthplan", group: "medicare" },
  { name: "Texas Independence Health Plan", keys: "texasindependence", group: "medicare" },
  { name: "Abilis Health Plan", keys: "abilis", group: "medicare" },
  { name: "TRICARE", keys: "tricare military 4life", group: "military" },
  { name: "TriWest (Veterans)", keys: "triwest va veterans", group: "military" },
  { name: "Claritev (formerly MultiPlan)", keys: "claritev multiplan", group: "networks" },
  { name: "PHCS (Private Healthcare Systems)", keys: "phcs privatehealthcare", group: "networks" },
  { name: "FirstHealth", keys: "firsthealth", group: "networks" },
  { name: "Galaxy Health Network", keys: "galaxy", group: "networks" },
  { name: "Healthcare Highways", keys: "highways", group: "networks" },
  { name: "HealthSmart Preferred Care", keys: "healthsmart accel", group: "networks" },
  { name: "Imagine Health", keys: "imagine providersdirect", group: "networks", note: DFW_NOTE },
  { name: "Independent Medical Systems", keys: "ims independentmedical", group: "networks" },
  { name: "NPPN", keys: "nppn nationalpreferred", group: "networks" },
  { name: "Nexcaliber", keys: "nexcaliber", group: "networks" },
  { name: "Nomi Health", keys: "nomi", group: "networks" },
  { name: "Prime Health Services", keys: "primehealth", group: "networks" },
  { name: "Provider Select", keys: "providerselect", group: "networks" },
  { name: "USA Managed Care Organization", keys: "usamco usamanagedcare", group: "networks" },
  { name: "XO Health", keys: "xohealth", group: "networks" },
  { name: "Contigo Health", keys: "contigo threerivers", group: "networks" },
  { name: "EVRY", keys: "evry", group: "networks" },
  { name: "Curative Health Plan", keys: "curative", group: "networks" },
  { name: "MCC Health Plan", keys: "mcc markcuban", group: "networks" },
  { name: "OpenNetworks", keys: "opennetworks", group: "networks" },
  { name: "Workers compensation and injury networks", keys: "workerscomp workinjury autoinjury corvel coventry careworks sedgwick procura reny", group: "injury" },
];

/**
 * Medicaid / CHIP words (Texas STAR programs included): these are never accepted. Same list as the
 * website, plus "communityplan" (UnitedHealthcare Community Plan is its Texas Medicaid plan).
 */
export const MEDICAID_KEYS = ["medicaid", "chip", "starplus", "starkids", "fostercare", "betterhealth", "cookchildren", "star", "tmhp", "communityplan"];

export const SELF_PAY = { firstVisit: 120, followUp: 99 };
export const CLINIC_PHONE = "(346) 707-8978";

export const insNorm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

export type InsuranceAnswer =
  | { result: "no"; plans: [] }
  | { result: "yes"; plans: Plan[] }
  | { result: "maybe"; plans: [] };

/** Same rules as the website: Medicaid/CHIP words first, then any listed plan, else "call to confirm". */
export function checkInsurance(query: string): InsuranceAnswer | null {
  const q = insNorm(query);
  if (q.length < 3) return null;
  if (MEDICAID_KEYS.some((k) => q.includes(k))) return { result: "no", plans: [] };
  const plans = PLANS.filter((p) => insNorm(p.name + p.keys).includes(q));
  return plans.length ? { result: "yes", plans } : { result: "maybe", plans: [] };
}

/** What to tell the patient, in the website's words (English / Spanish). */
export function patientLine(answer: InsuranceAnswer, lang: "en" | "es"): string {
  if (answer.result === "no") {
    return lang === "es"
      ? `Por el momento no aceptamos Medicaid ni CHIP. Pregunte por el pago directo: $${SELF_PAY.firstVisit} la primera visita, $${SELF_PAY.followUp} los seguimientos.`
      : `We do not currently accept Medicaid or CHIP plans. Ask us about self-pay: $${SELF_PAY.firstVisit} first visit, $${SELF_PAY.followUp} follow-ups.`;
  }
  if (answer.result === "yes") {
    const name = answer.plans[0]!.name;
    return lang === "es" ? `Sí — aceptamos ${name} en nuestras 4 clínicas.` : `Yes — we accept ${name} at all 4 locations.`;
  }
  return lang === "es"
    ? "Posiblemente — trabajamos con más de 40 redes. Permítame confirmarlo con su número de miembro."
    : "Possibly — we work with 40+ networks. Let me confirm with your member ID.";
}
