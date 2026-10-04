// Patient texting (2026-10-04, the practice's choices): one main number and a shared inbox; each
// conversation goes to the patient's clinic (that clinic's front desk, MAs and office manager, and the
// admins); texts that come in after hours get an automatic reply in English and Spanish.
import { CLINIC_TZ } from "./workforce";

/** RingCentral takes up to 1,000 characters in one text (long ones arrive as several parts). */
export const MAX_TEXT_LENGTH = 1000;

export interface TextingHours {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** "09:00" (clinic time). */
  start: string;
  end: string;
}

export interface TextingSettings {
  enabled: boolean;
  /** The RingCentral user whose number patients text (extension id), and that number (10 digits). */
  extensionId: string | null;
  extensionName: string | null;
  number: string | null;
  /** Optional sign-in key made by that RingCentral user (sealed); otherwise the server app sends as them. */
  jwtEnc: string | null;
  hours: TextingHours;
  autoReply: { enabled: boolean; en: string; es: string };
}

export const DEFAULT_TEXTING: TextingSettings = {
  enabled: false,
  extensionId: null,
  extensionName: null,
  number: null,
  jwtEnc: null,
  hours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  autoReply: {
    enabled: true,
    en: "Thank you for your message. Our office is closed now; we'll reply during office hours. If this is an emergency, call 911.",
    es: "Gracias por su mensaje. Nuestra oficina está cerrada; le responderemos en horario de oficina. Si es una emergencia, llame al 911.",
  },
};

/** One auto-reply per number at most this often. */
export const AUTO_REPLY_EVERY_HOURS = 12;

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The clinic-local weekday (0–6) and minutes since midnight of a moment. */
export function clinicDayMinutes(d: Date): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: CLINIC_TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return { day: DAY_INDEX[get("weekday")] ?? 0, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Is the office closed at this moment (clinic time)? */
export function isAfterHours(d: Date, hours: TextingHours): boolean {
  const { day, minutes } = clinicDayMinutes(d);
  if (!hours.days.includes(day)) return true;
  return minutes < toMinutes(hours.start) || minutes >= toMinutes(hours.end);
}

/** The auto-reply for a patient: in their language when we know it, otherwise English then Spanish. */
export function autoReplyText(settings: TextingSettings["autoReply"], language: string | null | undefined): string {
  const lang = (language ?? "").toLowerCase();
  if (lang.startsWith("es") || lang.startsWith("span")) return settings.es;
  if (lang.startsWith("en")) return settings.en;
  return `${settings.en}\n\n${settings.es}`.slice(0, MAX_TEXT_LENGTH);
}

/** The carriers' opt-out words (a patient who texts one gets no more texts until they text START or UNSTOP). */
const STOP_WORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout"];
const START_WORDS = ["start", "unstop"];
const keyword = (body: string) => body.trim().toLowerCase().replace(/[.!]+$/, "");
export const isStopText = (body: string) => STOP_WORDS.includes(keyword(body));
export const isStartText = (body: string) => START_WORDS.includes(keyword(body));

/** How many SMS parts a text takes (160 plain characters each; 70 with emoji or accents beyond GSM). */
export function textSegments(body: string): number {
  if (!body) return 0;
  // Characters outside the basic GSM alphabet (most emoji, some accents) make a text Unicode.
  const unicode = /[^\n\r\x20-\x7E£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉÄÖÑÜ§¿äöñüà¡]/.test(body);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return body.length <= single ? 1 : Math.ceil(body.length / multi);
}

/** RingCentral's message status → ours. */
export type TextStatus = "sending" | "sent" | "delivered" | "failed" | "received";
export function textStatusFrom(rc: string | null | undefined, direction: "in" | "out"): TextStatus {
  if (direction === "in") return "received";
  const s = (rc ?? "").toLowerCase();
  if (s === "delivered") return "delivered";
  if (s === "sent") return "sent";
  if (s.includes("fail") || s === "deliveryfailed" || s === "sendingfailed") return "failed";
  return "sending";
}

export const TEXT_STATUS_LABELS: Record<TextStatus, string> = { sending: "Sending", sent: "Sent", delivered: "Delivered", failed: "Not delivered", received: "Received" };

/** Inbox filters. */
export const TEXT_FILTERS = { open: "Open", mine: "Assigned to me", unknown: "Who is this?", closed: "Closed" } as const;
export type TextFilter = keyof typeof TEXT_FILTERS;
