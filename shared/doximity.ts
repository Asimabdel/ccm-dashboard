// Doximity Dialer (the practice's choice, 2026-10-02): providers call or video-visit a patient through
// their own Doximity app, so the patient sees the office number. Doximity has no API for this; these are
// the app links its own public calling library uses (github.com/doximity/CallWithDoxDialer):
//   doximity://dialer/call/voice?target_number=5551234567   (starts a voice call)
//   doximity://dialer/call/video?target_number=5551234567   (starts a video visit: the patient gets a text link)
// On a computer (no app), Doximity's web Dialer opens instead and the number is copied to paste in.
import { normalizePhone } from "./phone";

export type DoximityCall = "voice" | "video";

/** The link that opens Doximity Dialer on a phone, or null for a number that isn't a 10-digit US number. */
export function doximityAppLink(phone: string | null | undefined, kind: DoximityCall): string | null {
  const digits = normalizePhone(phone);
  if (!digits || digits.length !== 10) return null;
  return `doximity://dialer/call/${kind}?target_number=${digits}&utm_source=mypcp`;
}

/** Doximity's web Dialer (computers). */
export const DOXIMITY_WEB_DIALER = "https://www.doximity.com/dialer/home";

/** Visits that are video / telehealth by their visit type or reason (from the Practice Fusion schedule). */
export function isTelehealthVisit(visitType: string | null | undefined, reason?: string | null): boolean {
  return /tele|video|virtual|telemed|e-?visit/i.test(`${visitType ?? ""} ${reason ?? ""}`);
}
