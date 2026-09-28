// Tiny store around the RingCentral Embeddable widget: is it loaded / signed in, and
// "who did we just dial from which list" so the finished call is logged against them.
import { useSyncExternalStore } from "react";
import { normalizePhone } from "@shared/phone";

export const RC_ORIGIN = "https://apps.ringcentral.com";

export interface DialContext {
  patientId?: number | null;
  subjectKey?: string | null;
  name?: string | null;
  source?: string | null;
}

let state = { loaded: false, loggedIn: false };
const listeners = new Set<() => void>();
const pending = new Map<string, DialContext & { at: number }>();

export function setRcState(patch: Partial<typeof state>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useRingCentral() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

/** Dial through the built-in phone. Returns false when it isn't loaded (use tel: instead). */
export function rcDial(rawPhone: string, context?: DialContext): boolean {
  const phone = normalizePhone(rawPhone);
  const frame = document.querySelector<HTMLIFrameElement>("#rc-widget-adapter-frame");
  if (!phone || !state.loaded || !frame?.contentWindow) return false;
  pending.set(phone, { ...(context ?? {}), at: Date.now() });
  (window as unknown as { RCAdapter?: { setMinimized?: (v: boolean) => void } }).RCAdapter?.setMinimized?.(false);
  frame.contentWindow.postMessage({ type: "rc-adapter-new-call", phoneNumber: `+1${phone}`, toCall: true }, RC_ORIGIN);
  return true;
}

/** The list row a finished call was dialed from (kept for 4 hours). */
export function takeDialContext(phone: string | null): DialContext | null {
  if (!phone) return null;
  const c = pending.get(phone);
  pending.delete(phone);
  return c && Date.now() - c.at < 4 * 3600_000 ? c : null;
}

/** Open a new text message in the built-in phone, filled in and ready to send (staff press Send).
 *  Returns false when the phone isn't loaded (copy the message instead). */
export function rcText(rawPhone: string, text: string): boolean {
  const phone = normalizePhone(rawPhone);
  const frame = document.querySelector<HTMLIFrameElement>("#rc-widget-adapter-frame");
  if (!phone || !state.loaded || !frame?.contentWindow) return false;
  (window as unknown as { RCAdapter?: { setMinimized?: (v: boolean) => void } }).RCAdapter?.setMinimized?.(false);
  frame.contentWindow.postMessage({ type: "rc-adapter-new-sms", phoneNumber: `+1${phone}`, text }, RC_ORIGIN);
  return true;
}
