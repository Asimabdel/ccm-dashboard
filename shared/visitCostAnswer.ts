// "How much does this patient pay today?" (2026-11-17): the one answer the Copays & deductibles search
// shows, with the line to read to the patient in English and Spanish. Today's visit only (no old
// balances: MyPCP can't see payments taken at the desk). Pure rules; the numbers come from
// shared/visitCost.ts (what insurance said on the patient's past visits).
import { checkInsurance, SELF_PAY } from "./insurance";
import { shortDay, usd, type CollectNote, type PersonCost } from "./visitCost";

export type VisitKind = "wellness" | "new" | "followup";

/** The booked visit's type, from the schedule's visit type / reason ("Annual Wellness", "New Patient", …). */
export function visitKindOf(visitType: string | null | undefined, reason?: string | null): VisitKind {
  const t = `${visitType ?? ""} ${reason ?? ""}`.toLowerCase();
  if (/\b(annual|wellness|awv|physical|preventive|preventative|well (woman|man|child|visit))\b/.test(t)) return "wellness";
  if (/\bnew (patient|pt)\b|^\s*np\b/.test(t)) return "new";
  return "followup";
}

const SELF_PAY_WORDS = /\b(self.?pay|cash|uninsured|no insurance|none)\b/i;

/**
 * The plan we don't take, if their insurance is one (the website's rules), else null. Medicare with
 * Medicaid behind it (dual eligible) is billed to Medicare first, which the practice takes.
 */
export function notAcceptedPlan(insurance: string | null | undefined): string | null {
  if (!insurance) return null;
  const a = checkInsurance(insurance);
  if (a?.result !== "no") return null;
  if (!a.carrier && /medicare/i.test(insurance)) return null;
  return a.carrier ?? "Medicaid / CHIP";
}

export interface AnswerInput {
  today: string;
  /** The patient's own past office visits (null = none in the payment files). */
  pc: PersonCost | null;
  /** For a patient with no visits of their own: what other patients on the same plan paid. */
  planNote: CollectNote | null;
  /** The insurance we go by: their latest paid claim, else Practice Fusion's insurance list, else the roster. */
  insurance: string | null;
  insuranceFrom: "claim" | "chart" | "roster" | null;
  /** Their visit today, or else their next booked one. */
  visit: { date: string; type: string | null; reason: string | null } | null;
  /** Seen at the practice before (a paid claim or a past visit on the schedule). */
  seenBefore: boolean;
  /** What this insurance usually allows for a new-patient office visit (the cost while a deductible applies). */
  newVisitCents: number | null;
  /** Their latest wellness visit in the payment files and what insurance left to them. */
  lastWellness: { date: string; owesCents: number } | null;
}

export type AnswerKind = "collect" | "nothing" | "selfpay" | "unknown";
export type Sureness = "sure" | "likely" | "guess";

export interface VisitAnswer {
  kind: AnswerKind;
  /** null = we don't know. */
  cents: number | null;
  /** An "about" amount (a deductible or a percentage), not a set copay. */
  approx: boolean;
  /** The big line: "Collect $25", "Collect about $128", "Nothing to collect", "Self-pay $99", "Not sure: check their card". */
  headline: string;
  /** One to three short lines on why. */
  why: string[];
  sure: Sureness | null;
  visitKind: VisitKind;
  /** What to read to the patient. */
  say: { en: string; es: string };
}

export const SURENESS_LABELS: Record<Sureness, string> = { sure: "Sure", likely: "Likely", guess: "Best guess" };

const visitsWord = (n: number) => `${n} visit${n === 1 ? "" : "s"}`;
const ESTIMATE = { en: " This is an estimate; the final amount comes from your insurance.", es: " Es un estimado; el monto final lo decide su seguro." };
const ASK_CARD = {
  en: "Could I see your insurance card, please? I'll check what today's visit will cost.",
  es: "¿Me permite su tarjeta de seguro, por favor? Voy a verificar cuánto costará la visita de hoy.",
};

function selfPayCents(input: AnswerInput, kind: VisitKind) {
  return (kind === "new" || !input.seenBefore ? SELF_PAY.firstVisit : SELF_PAY.followUp) * 100;
}

/** The one answer for the search. */
export function visitAnswer(input: AnswerInput): VisitAnswer {
  const kind = visitKindOf(input.visit?.type, input.visit?.reason);
  const pc = input.pc;
  const base = { visitKind: kind };
  const cardOld = input.insuranceFrom === "roster" || input.insuranceFrom === "chart" ? " (from their chart, may be out of date)" : pc ? ` (on their last visit, ${shortDay(pc.lastVisit)})` : "";

  // 1) A plan the practice doesn't take: they'd pay the self-pay price.
  const plan = notAcceptedPlan(input.insurance);
  if (plan) {
    const cents = selfPayCents(input, kind);
    const carrier = plan !== "Medicaid / CHIP";
    return {
      ...base, kind: "selfpay", cents, approx: false, sure: "likely", headline: `Self-pay ${usd(cents)}`,
      why: [`Their insurance is ${input.insurance}${cardOld}. We don't take ${plan}.`, "If they have other insurance now, check that card instead."],
      say: carrier
        ? { en: `We're not able to bill ${plan}. If you have other insurance, we can check it. Otherwise, today's visit is ${usd(cents)} without insurance.`,
            es: `No podemos facturarle a ${plan}. Si tiene otro seguro, lo podemos verificar. Si no, la visita de hoy cuesta ${usd(cents)} sin seguro.` }
        : { en: `We don't accept Medicaid or CHIP plans. If you have other insurance, we can check it. Otherwise, today's visit is ${usd(cents)} without insurance.`,
            es: `No aceptamos planes de Medicaid ni CHIP. Si tiene otro seguro, lo podemos verificar. Si no, la visita de hoy cuesta ${usd(cents)} sin seguro.` },
    };
  }
  // 2) No insurance at all on their record.
  if (!pc && input.insurance && SELF_PAY_WORDS.test(input.insurance)) {
    const cents = selfPayCents(input, kind);
    return {
      ...base, kind: "selfpay", cents, approx: false, sure: "likely", headline: `Self-pay ${usd(cents)}`,
      why: [`Their record says "${input.insurance}".`, "If they have insurance now, check their card."],
      say: { en: `Without insurance, today's visit is ${usd(cents)}. If you have insurance now, I can check it.`, es: `Sin seguro, la visita de hoy cuesta ${usd(cents)}. Si ahora tiene seguro, lo puedo verificar.` },
    };
  }

  // 3) A wellness visit: usually covered in full.
  if (kind === "wellness" && (pc || input.insurance)) {
    const w = input.lastWellness;
    const copayNote = pc?.copay ? ` If the provider also treats a problem that day, their usual ${usd(pc.copay.cents)} copay can apply.` : "";
    if (w && w.owesCents > 0) {
      return {
        ...base, kind: "collect", cents: w.owesCents, approx: true, sure: "guess", headline: `Collect about ${usd(w.owesCents)}`,
        why: [`Booked for a wellness visit. On their last one (${shortDay(w.date)}) insurance left ${usd(w.owesCents)} to them.${copayNote}`],
        say: { en: `On your last wellness visit, your part was about ${usd(w.owesCents)}.${ESTIMATE.en}`, es: `En su última visita de bienestar, su parte fue de aproximadamente ${usd(w.owesCents)}.${ESTIMATE.es}` },
      };
    }
    return {
      ...base, kind: "nothing", cents: 0, approx: false, sure: w ? "sure" : "likely", headline: "Likely nothing to collect",
      why: [w ? `Booked for a wellness visit. Their last one (${shortDay(w.date)}) was covered in full.` : "Booked for a wellness visit: preventive visits are usually covered in full.", ...(copayNote ? [copayNote.trim()] : [])],
      say: {
        en: "Your annual wellness visit is usually covered in full by your insurance, so there's likely nothing to pay today.",
        es: "Su visita anual de bienestar normalmente está cubierta por completo por su seguro, así que probablemente no tenga que pagar nada hoy.",
      },
    };
  }

  // 4) Their own past visits.
  if (pc) {
    const d = pc.deductible;
    const c = pc.copay;
    if ((d.state === "applies" || d.state === "reset") && d.lastOwedCents != null) {
      // While the deductible applies they pay the whole visit: a new-patient visit costs more than their last follow-up.
      const cents = kind === "new" && input.newVisitCents ? Math.max(input.newVisitCents, d.lastOwedCents) : d.lastOwedCents;
      const reset = d.state === "reset";
      return {
        ...base, kind: "collect", cents, approx: true, sure: reset ? "guess" : "likely", headline: `Collect about ${usd(cents)}`,
        why: reset
          ? [`In ${d.year - 1} insurance applied their deductible on ${visitsWord(d.visitsLastYear)}. It starts over each January, and they have no visit yet this year.`, `On ${shortDay(d.lastDate)} they owed ${usd(d.lastOwedCents)} for the visit.`]
          : [`Deductible not met: insurance paid nothing for their last visit (${shortDay(d.lastDate)}), and they owed ${usd(d.lastOwedCents)}.`, `Applied on ${visitsWord(d.visitsThisYear)} this year (${usd(d.centsThisYear)} so far).`, ...(kind === "new" && cents > d.lastOwedCents ? ["A new-patient visit costs more than a follow-up."] : [])],
        say: reset
          ? { en: `Your deductible started over in January, so today's visit will be about ${usd(cents)} until it's met.${ESTIMATE.en}`, es: `Su deducible se reinició en enero, así que la visita de hoy costará aproximadamente ${usd(cents)} hasta que lo cubra.${ESTIMATE.es}` }
          : { en: `Your deductible hasn't been met yet this year, so today's visit will be about ${usd(cents)}.${ESTIMATE.en}`, es: `Todavía no ha cubierto su deducible de este año, así que la visita de hoy costará aproximadamente ${usd(cents)}.${ESTIMATE.es}` },
      };
    }
    if (c) {
      const every = c.seenOn === c.outOf;
      const sure: Sureness = c.fromLastYear || c.latestCents !== c.cents ? "guess" : every && c.outOf >= 3 ? "sure" : c.outOf >= 2 && c.seenOn / c.outOf >= 0.6 ? "likely" : "guess";
      return {
        ...base, kind: "collect", cents: c.cents, approx: false, sure, headline: `Collect ${usd(c.cents)}`,
        why: [
          `Copay ${usd(c.cents)} on ${every ? (c.outOf === 1 ? "their last visit" : `all of their last ${c.outOf} visits`) : `${c.seenOn} of their last ${c.outOf} visits`} (latest ${shortDay(c.lastDate)}).`,
          ...(c.latestCents !== c.cents ? [`Their most recent copay was ${usd(c.latestCents)}: check their card if their plan changed.`] : []),
          ...(c.fromLastYear ? [`From ${d.year - 1}: plans can change in January, so check their card.`] : []),
        ],
        say: { en: `Your copay for today's visit is ${usd(c.cents)}.`, es: `Su copago para la visita de hoy es de ${usd(c.cents)}.` },
      };
    }
    if (pc.coinsurancePct && pc.coinsuranceCents) {
      return {
        ...base, kind: "collect", cents: pc.coinsuranceCents, approx: true, sure: "likely", headline: `Collect about ${usd(pc.coinsuranceCents)}`,
        why: [`They pay ${pc.coinsurancePct}% of each visit (coinsurance)${d.state === "met" ? `; the deductible looks met for ${d.year}` : ""}.`],
        say: { en: `Your insurance covers most of the visit; your part is about ${usd(pc.coinsuranceCents)}.${ESTIMATE.en}`, es: `Su seguro cubre la mayor parte de la visita; su parte es de aproximadamente ${usd(pc.coinsuranceCents)}.${ESTIMATE.es}` },
      };
    }
    if (pc.nothingOwed) {
      return {
        ...base, kind: "nothing", cents: 0, approx: false, sure: pc.lookedAt >= 3 ? "sure" : "likely", headline: "Nothing to collect",
        why: [`Insurance left nothing to pay on ${pc.lookedAt === 1 ? "their last visit" : `their last ${pc.lookedAt} visits`} (latest ${shortDay(pc.lastVisit)}).`],
        say: { en: "Your insurance has covered your recent visits in full, so there's nothing to pay today.", es: "Su seguro ha cubierto sus visitas recientes por completo, así que hoy no tiene que pagar nada." },
      };
    }
    if (pc.usualOwesCents > 0) {
      return {
        ...base, kind: "collect", cents: pc.usualOwesCents, approx: true, sure: "guess", headline: `Collect about ${usd(pc.usualOwesCents)}`,
        why: [`On ${pc.lookedAt === 1 ? "their last visit" : `their last ${pc.lookedAt} visits`} insurance left about ${usd(pc.usualOwesCents)} to them.`],
        say: { en: `Based on your recent visits, your part today is about ${usd(pc.usualOwesCents)}.${ESTIMATE.en}`, es: `Según sus visitas recientes, su parte hoy es de aproximadamente ${usd(pc.usualOwesCents)}.${ESTIMATE.es}` },
      };
    }
  }

  // 5) No visits of their own: other patients on the same plan.
  const pn = input.planNote;
  if (!pc && pn && pn.cents != null) {
    const nothing = pn.kind === "nothing" || pn.cents === 0;
    return {
      ...base, kind: nothing ? "nothing" : "collect", cents: pn.cents, approx: pn.kind === "deductible", sure: "guess",
      headline: nothing ? "Likely nothing to collect" : pn.kind === "deductible" ? `Collect about ${usd(pn.cents)}` : `Collect ${usd(pn.cents)}`,
      why: [pn.detail],
      say: nothing
        ? { en: "Patients with your plan usually have nothing to pay for this visit.", es: "Los pacientes con su plan normalmente no tienen que pagar nada por esta visita." }
        : pn.kind === "deductible"
          ? { en: `With your plan, today's visit will likely be about ${usd(pn.cents)} until your deductible is met.${ESTIMATE.en}`, es: `Con su plan, la visita de hoy probablemente costará aproximadamente ${usd(pn.cents)} hasta que cubra su deducible.${ESTIMATE.es}` }
          : { en: `Your copay for today's visit is likely ${usd(pn.cents)}.${ESTIMATE.en}`, es: `Su copago para la visita de hoy probablemente es de ${usd(pn.cents)}.${ESTIMATE.es}` },
    };
  }

  // 6) Nothing to go on.
  const firstVisit = SELF_PAY.firstVisit * 100, followUp = SELF_PAY.followUp * 100;
  return {
    ...base, kind: "unknown", cents: null, approx: false, sure: null, headline: "Not sure: check their card",
    why: [
      input.insurance ? `Their insurance is ${input.insurance}${cardOld}, but no payments from it for this patient are in the uploaded files yet.` : pc ? "Their past visits don't show a clear amount." : "No insurance and no paid visits on file for this patient.",
      ...(kind === "wellness" ? ["Booked for a wellness visit: preventive visits are usually covered in full."] : []),
      `Without insurance: ${usd(firstVisit)} first visit, ${usd(followUp)} follow-up.`,
    ],
    say: ASK_CARD,
  };
}
