// Website bookings: appointment requests from the mypcpdr.com booking wizard. The website posts to
// the clinic-booking-mailer Lambda, which emails Care@ and hands the request to MyPCP. Pure helpers.

export const BOOKING_STATUSES = ["new", "no_answer", "scheduled", "not_booked", "spam", "earlier"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  new: "Waiting for a call",
  no_answer: "Called, no answer",
  scheduled: "Scheduled",
  not_booked: "Didn't book",
  spam: "Spam / test",
  earlier: "Earlier (from email)",
};
/** Statuses that still need someone to call. */
export const OPEN_BOOKING: BookingStatus[] = ["new", "no_answer"];

const EN_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ES_MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/**
 * The website sends the preferred time as "Tue, Sep 30 · 10:00 AM" (English) or "mar, 30 sept · 10:00 AM"
 * (Spanish, which also means the patient used the Spanish site). There's no year: it's the next such date
 * on or after the day the request came in.
 */
export function parsePreferred(text: string | null | undefined, receivedAt: Date): { date: string | null; time: string | null; spanish: boolean } {
  const t = String(text ?? "").trim();
  if (!t) return { date: null, time: null, spanish: false };
  const time = t.match(/(\d{1,2}:\d{2}\s*(?:AM|PM|a\.?\s?m\.?|p\.?\s?m\.?))/i)?.[1]?.toUpperCase().replace(/\s+/g, " ").replace(/\./g, "") ?? null;
  const en = t.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/);
  const es = t.match(/\b(\d{1,2})\s+(?:de\s+)?([a-záéíóú]{3,4})\.?/i);
  let month = -1, day = 0, spanish = false;
  if (en && EN_MONTHS.includes(en[1]!.toLowerCase().slice(0, 3))) { month = EN_MONTHS.indexOf(en[1]!.toLowerCase().slice(0, 3)); day = Number(en[2]); }
  else if (es && ES_MONTHS.includes(es[2]!.toLowerCase().slice(0, 3))) { month = ES_MONTHS.indexOf(es[2]!.toLowerCase().slice(0, 3)); day = Number(es[1]); spanish = true; }
  if (/\b(lun|mar|mié|mie|jue|vie|sáb|sab|dom)\b/i.test(t) && !en) spanish = true;
  if (month < 0 || day < 1 || day > 31) return { date: null, time, spanish };
  const base = new Date(receivedAt.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  let year = base.getFullYear();
  const candidate = new Date(year, month, day);
  if (candidate.getTime() < new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime() - 86_400_000) year += 1;
  const ymd = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { date: ymd, time, spanish };
}

/** Which MyPCP clinic a website location name means ("Richmond Ave" is the Westheimer office, etc.). */
export function clinicForLocation(location: string | null | undefined, clinics: { id: number; name: string }[]): number | null {
  const l = String(location ?? "").toLowerCase();
  if (!l) return null;
  const find = (re: RegExp, not?: RegExp) => clinics.find((c) => re.test(c.name.toLowerCase()) && !(not && not.test(c.name.toLowerCase())))?.id ?? null;
  if (/highland|cinco/.test(l)) return find(/highland|cinco/);
  if (/richmond|westheimer/.test(l)) return find(/westheimer|richmond/);
  if (/cypress/.test(l)) return find(/cypress/);
  if (/katy|provincial/.test(l)) return find(/katy|provincial/, /highland|cinco/);
  const words = l.split(/[^a-z]+/).filter((w) => w.length >= 4);
  return clinics.find((c) => words.some((w) => c.name.toLowerCase().includes(w)))?.id ?? null;
}

/** Read a booking back out of the email the website sent to Care@ (for loading earlier requests). */
export function parseBookingEmail(text: string): { name: string; phone: string; location: string | null; provider: string | null; visitType: string | null; preferred: string | null } | null {
  const get = (label: string) => text.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "mi"))?.[1]?.trim() ?? null;
  const none = (v: string | null) => (v && !/^(no preference|first available|not specified)$/i.test(v) ? v : null);
  const name = get("Name");
  const phone = get("Phone");
  if (!name || !phone || phone.replace(/\D/g, "").length < 10) return null;
  return { name: name.slice(0, 120), phone: phone.slice(0, 30), location: none(get("Location")), provider: none(get("Provider")), visitType: none(get("Visit")), preferred: none(get("Preferred")) };
}
