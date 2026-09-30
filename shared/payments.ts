// Square payments: pure helpers shared by the server and the Payments pages.
import { CLINIC_TZ } from "./workforce";

export const PAYMENT_CATEGORIES = {
  copay: "Copay / visit balance",
  weight_loss: "Weight-loss program",
  self_pay: "Other self-pay",
  dexafit: "DexaFit",
} as const;
export type PaymentCategory = keyof typeof PAYMENT_CATEGORIES;
export const PAYMENT_CATEGORY_LIST = Object.keys(PAYMENT_CATEGORIES) as PaymentCategory[];
export const isPaymentCategory = (v: unknown): v is PaymentCategory => typeof v === "string" && v in PAYMENT_CATEGORIES;

/** DexaFit is a separate business on the same Square account: only admins see it, and it's never linked to patients. */
export const DEXAFIT: PaymentCategory = "dexafit";

/**
 * What Square sees on a payment link: a plain name, never what the payment is for. The reason
 * ("what it's for") stays in MyPCP, because Square doesn't sign a BAA.
 */
export const squareItemName = (category: PaymentCategory | null) => (category === "dexafit" ? "DexaFit Katy payment" : "MyPCP Dr payment");

/** Guess a category from what was rung up in Square (item names / note). Null = staff sort it. */
export function guessCategory(text: string | null | undefined): PaymentCategory | null {
  const s = String(text ?? "").toLowerCase();
  if (!s.trim()) return null;
  if (/dexa|body ?comp|\brmr\b|vo2|bod ?pod|metabolic test/.test(s)) return "dexafit";
  if (/weight|glp|semaglutide|tirzepatide|wegovy|ozempic|zepbound|mounjaro|phentermine/.test(s)) return "weight_loss";
  if (/co-?\s?pay|balance|office visit|visit fee/.test(s)) return "copay";
  if (/self.?pay|cash price/.test(s)) return "self_pay";
  return null;
}

/** Square payment source types, grouped for totals. */
export type PayMethod = "card" | "cash" | "other";
export function methodOf(sourceType: string | null | undefined): PayMethod {
  const s = String(sourceType ?? "").toUpperCase();
  if (s === "CASH") return "cash";
  if (s === "CARD" || s === "WALLET" || s === "SQUARE_ACCOUNT") return "card";
  return "other";
}
export const METHOD_LABELS: Record<PayMethod, string> = { card: "Card", cash: "Cash", other: "Other" };

export function methodText(p: { sourceType: string | null; cardBrand: string | null; cardLast4: string | null }): string {
  const m = methodOf(p.sourceType);
  if (m === "cash") return "Cash";
  if (p.cardBrand || p.cardLast4) {
    const brand = (p.cardBrand ?? "Card").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    return `${brand}${p.cardLast4 ? ` ••${p.cardLast4}` : ""}`;
  }
  const s = String(p.sourceType ?? "").replace(/_/g, " ").toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : "Other";
}

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  COMPLETED: "Paid",
  APPROVED: "Authorized",
  PENDING: "Pending",
  CANCELED: "Canceled",
  FAILED: "Failed",
};

export const REQUEST_KINDS = { link: "Payment link", terminal: "Square Terminal" } as const;
export type RequestKind = keyof typeof REQUEST_KINDS;
export const REQUEST_STATUSES = ["open", "paid", "canceled", "failed"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Cents → "$1,234.50". */
export function money(cents: number | null | undefined): string {
  const n = Number(cents ?? 0) / 100;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** "45", "45.5", "$1,200.00" → cents (null if it isn't a positive amount under $50,000). */
export function parseDollars(raw: string): number | null {
  const s = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents > 0 && cents <= 5_000_000 ? cents : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Minutes the clinic's clock is ahead of UTC at an instant (-300 in CDT, -360 in CST). */
function clinicOffsetMinutes(at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: CLINIC_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(at).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The instant a clinic-local day (YYYY-MM-DD) starts. */
export function clinicDayStart(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const midnightUtc = Date.UTC(y!, m! - 1, d!);
  return new Date(midnightUtc - clinicOffsetMinutes(new Date(midnightUtc + 6 * 3_600_000)) * 60_000);
}

/** YYYY-MM-DD plus n days (calendar arithmetic, no time zone involved). */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** [start, end) instants for a clinic-local date range, both ends inclusive as dates. */
export function clinicRange(from: string, to: string): { start: Date; end: Date } {
  return { start: clinicDayStart(from), end: clinicDayStart(addDays(to, 1)) };
}

/** The text sent with a payment link (patient's language; English falls back for anything else). */
export function paymentLinkText(lang: string | null | undefined, amountCents: number, url: string, clinicPhone: string | null, business: "clinic" | "dexafit" = "clinic"): string {
  const amt = money(amountCents);
  const from = business === "dexafit" ? "DexaFit Katy" : "MyPCP Dr";
  if (lang === "es") return `${from}: Aquí está su enlace seguro para pagar ${amt}: ${url}${clinicPhone ? ` ¿Preguntas? Llámenos al ${clinicPhone}.` : ""}`;
  if (lang === "ar") return `${from}: هذا رابط الدفع الآمن الخاص بك لمبلغ ${amt}: ${url}${clinicPhone ? ` للاستفسار اتصل بنا على ${clinicPhone}.` : ""}`;
  return `${from}: Here is your secure link to pay ${amt}: ${url}${clinicPhone ? ` Questions? Call us at ${clinicPhone}.` : ""}`;
}

/** Square webhook signature: base64 HMAC-SHA256 of (notification URL + raw body) with the subscription's key. */
export const SQUARE_SIGNATURE_HEADER = "x-square-hmacsha256-signature";
export const SQUARE_WEBHOOK_EVENTS = ["payment.created", "payment.updated", "refund.created", "refund.updated", "terminal.checkout.updated"] as const;

/** Square's always-approving sandbox Terminal (for testing the Terminal flow without hardware). */
export const SANDBOX_TEST_TERMINAL = { deviceId: "9fa747a2-25ff-48ee-b078-04381f7c828f", name: "Sandbox test Terminal" };
