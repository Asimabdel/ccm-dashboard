// Practice-mailbox helpers shared by server and client: reading the sender, finding phone
// numbers in an email, and working out which patient an email is from.
import { normalizePhone } from "./phone";
import { nameKey } from "./workspace";

/** '"Jane Doe" <jane@x.com>' → { name: "Jane Doe", email: "jane@x.com" }. */
export function parseFromHeader(raw: string | null | undefined): { name: string | null; email: string | null } {
  const v = String(raw ?? "").trim();
  const angle = v.match(/^(.*)<([^>]+)>\s*$/);
  const email = (angle ? angle[2] : v).trim().toLowerCase();
  const name = angle ? angle[1].trim().replace(/^"|"$/g, "").trim() : "";
  return { name: name || null, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null };
}

/**
 * The part of an email the sender actually wrote: drops quoted replies ("On … wrote:",
 * "-----Original Message-----", Outlook "From: … Sent:" blocks, "> " lines), so phone
 * numbers in OUR quoted signature never count as the patient's.
 */
export function stripQuotedText(text: string): string {
  const cut = [/^On .{3,200}wrote:\s*$/m, /^-{2,}\s*Original Message\s*-{2,}/im, /^From: .+\r?\n(Sent|Date): /m, /^_{10,}\s*$/m];
  let out = text;
  for (const re of cut) {
    const m = out.match(re);
    if (m && m.index != null) out = out.slice(0, m.index);
  }
  return out.split(/\r?\n/).filter((l) => !l.trimStart().startsWith(">")).join("\n").trim();
}

/** Distinct 10-digit US numbers mentioned in the text. */
export function extractPhones(text: string): string[] {
  const out = new Set<string>();
  for (const m of Array.from(text.matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g))) {
    const n = normalizePhone(m[0]);
    if (n) out.add(n);
  }
  return Array.from(out);
}

export interface EmailSubject {
  /** Opportunity Finder key: "p:<patientId>" or "s:<name>|<dob>". */
  key: string;
  patientId: number | null;
  name: string;
}

export type EmailMatchMethod = "address" | "name" | "phone";

export interface EmailMatchIndex {
  /** Remembered/imported addresses → patient, or "ignore" for known non-patients. */
  byEmail: Map<string, EmailSubject | "ignore">;
  /** nameKey(full name) → everyone with that name (more than one = ambiguous). */
  byName: Map<string, EmailSubject[]>;
  byPhone: Map<string, EmailSubject>;
}

/**
 * Who an email is from: a remembered/imported address first, then the sender's display name
 * (only a full name that matches exactly one person), then a phone number the sender wrote
 * (only if every number found points to the same person). Null = a person needs to pick.
 */
export function matchEmailSender(
  msg: { email: string | null; name: string | null; body: string },
  idx: EmailMatchIndex,
): { ignore: true } | { subject: EmailSubject; method: EmailMatchMethod } | null {
  if (msg.email) {
    const known = idx.byEmail.get(msg.email);
    if (known === "ignore") return { ignore: true };
    if (known) return { subject: known, method: "address" };
  }
  if (msg.name) {
    const k = nameKey(msg.name);
    if (k.split(" ").length >= 2) {
      const people = idx.byName.get(k) ?? [];
      if (people.length === 1) return { subject: people[0]!, method: "name" };
    }
  }
  const found = new Map<string, EmailSubject>();
  for (const p of extractPhones(stripQuotedText(msg.body))) {
    const s = idx.byPhone.get(p);
    if (s) found.set(s.key, s);
  }
  if (found.size === 1) return { subject: Array.from(found.values())[0]!, method: "phone" };
  return null;
}

/** Link that opens one message in Gmail by its Message-ID (works for anyone with access to the mailbox). */
export function gmailMessageLink(mailbox: string, messageIdHeader: string | null, threadId: string): string {
  const base = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(mailbox)}`;
  if (messageIdHeader) return `${base}#search/rfc822msgid%3A${encodeURIComponent(messageIdHeader.replace(/^<|>$/g, ""))}`;
  return `${base}#all/${threadId}`;
}
