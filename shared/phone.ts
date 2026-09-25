// Phone calls through RingCentral — pure helpers shared by server and client.

/** Last 10 digits of a US phone number, or null if it doesn't look like one. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/** "7135551234" → "(713) 555-1234". */
export function formatPhone(raw: string | null | undefined): string {
  const n = normalizePhone(raw);
  return n ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : String(raw ?? "");
}

export const CALL_OUTCOMES = {
  booked: "Booked an appointment",
  voicemail: "Left a voicemail",
  no_answer: "No answer",
  call_back: "Asked to call back",
  declined: "Declined",
  wrong_number: "Wrong number",
  other: "Other",
} as const;
export type CallOutcome = keyof typeof CALL_OUTCOMES;
export const CALL_OUTCOME_LIST = Object.keys(CALL_OUTCOMES) as CallOutcome[];

/** Outcomes that close the lead: nobody needs to call this person again for now. */
export const CLOSING_OUTCOMES: CallOutcome[] = ["booked", "declined", "wrong_number"];

export interface RingCentralSettings {
  enabled: boolean;
  /** Client ID of the practice's RingCentral app; empty = RingCentral's demo app (shows a demo banner). */
  clientId: string;
  /** Let staff send texts from the built-in phone. */
  allowTexting: boolean;
}

export const DEFAULT_RINGCENTRAL: RingCentralSettings = { enabled: false, clientId: "", allowTexting: false };

export interface ParsedRcCall {
  sessionId: string | null;
  direction: "outbound" | "inbound";
  otherNumber: string | null;
  startedAt: Date;
  durationSec: number;
  result: string | null;
}

const pickNumber = (party: unknown): string | null => {
  if (!party) return null;
  if (typeof party === "string") return party;
  const p = party as { phoneNumber?: string; extensionNumber?: string };
  return p.phoneNumber ?? null;
};

/**
 * Read the call object RingCentral Embeddable sends with "rc-call-end-notify". Field names
 * differ between call types (web phone vs. RingOut), so every lookup is defensive.
 */
export function parseRingCentralCall(call: Record<string, unknown> | null | undefined, now: Date = new Date()): ParsedRcCall | null {
  if (!call || typeof call !== "object") return null;
  const dir = String(call.direction ?? "").toLowerCase().startsWith("in") ? "inbound" : "outbound";
  const other = dir === "outbound"
    ? pickNumber(call.to) ?? (call.toNumber as string | undefined) ?? (call.toNumberData as { calleeNumber?: string } | undefined)?.calleeNumber ?? null
    : pickNumber(call.from) ?? (call.fromNumber as string | undefined) ?? null;
  const startMs = Number(call.startTime ?? call.creationTime ?? call.startedAt ?? 0);
  const startedAt = startMs > 0 ? new Date(startMs) : now;
  const endMs = Number(call.endTime ?? 0);
  const rawDuration = Number(call.duration ?? 0);
  const durationSec = rawDuration > 0 ? Math.round(rawDuration) : endMs > startMs && startMs > 0 ? Math.round((endMs - startMs) / 1000) : 0;
  const sessionId = [call.telephonySessionId, call.sessionId, call.partyId, call.id].find((x) => typeof x === "string" && x) as string | undefined;
  const result = [call.result, call.callStatus, call.telephonyStatus].find((x) => typeof x === "string" && x) as string | undefined;
  return { sessionId: sessionId ?? null, direction: dir, otherNumber: normalizePhone(other), startedAt, durationSec, result: result ?? null };
}

/** One record from RingCentral's company call log, reduced to what MyPCP keeps. */
export interface MappedCallLogRecord {
  /** Every id RingCentral gives the call; any match means "same call". The first is stored. */
  ids: string[];
  direction: "outbound" | "inbound";
  otherNumber: string | null;
  startedAt: Date;
  durationSec: number;
  result: string | null;
  extensionId: string | null;
}

type RcParty = { phoneNumber?: string; extensionNumber?: string; name?: string } | undefined;
interface RcCallLogRecord {
  id?: string; sessionId?: string; telephonySessionId?: string;
  startTime?: string; duration?: number; direction?: string; result?: string;
  from?: RcParty; to?: RcParty;
  extension?: { id?: string | number };
  legs?: { extension?: { id?: string | number } }[];
}

/**
 * Map a call-log record (account-level, Detailed view). Internal extension-to-extension
 * calls have no outside number and come back with otherNumber = null.
 */
export function mapCallLogRecord(r: RcCallLogRecord): MappedCallLogRecord | null {
  if (!r || !r.startTime) return null;
  const direction = String(r.direction ?? "").toLowerCase().startsWith("in") ? "inbound" : "outbound";
  const party = direction === "outbound" ? r.to : r.from;
  const ext = r.extension?.id ?? r.legs?.find((l) => l.extension?.id != null)?.extension?.id;
  const ids = [r.telephonySessionId, r.sessionId, r.id].filter((x): x is string => typeof x === "string" && x.length > 0);
  return {
    ids,
    direction,
    otherNumber: normalizePhone(party?.phoneNumber),
    startedAt: new Date(r.startTime),
    durationSec: Math.max(0, Math.round(Number(r.duration ?? 0))),
    result: r.result ?? null,
    extensionId: ext != null ? String(ext) : null,
  };
}
