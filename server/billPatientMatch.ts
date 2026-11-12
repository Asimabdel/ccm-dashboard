// Master Billing: finding the patient behind a bill when the insurance wrote the name differently
// (2026-11-12). Insurance files often cut a long last name short ("Panesso Gonzal" for "Panesso"
// or "Panesso Gonzalez"), add a second last name or a middle name, drop a hyphen, misspell a letter,
// or use a nickname. Pure (no database): masterBillingDb loads the people and member IDs.
//
// How sure: "strong" = the same first name (or a nickname / longer form) and the same last name with
// only extra words, a cut-off or a hyphen in between. "close" = one letter off, or goes by the middle
// name, or first and last swapped: used on its own only when something else points to the same
// person (a visit that day, the same provider, a visit within two months). "weak" = only shown as a
// suggestion for the owner to pick.
import { similarSpelling, tok } from "./rosterMatch";

export type NameLevel = "strong" | "close" | "weak";
export interface NameComparison { level: NameLevel; why: string }

/** A name's words for matching (accents, hyphens, suffixes and initials left out; "Last, First" turned around). */
export const nameWords = (name: string | null | undefined) => tok(name).words.filter((w) => w.length > 1);

// Common nicknames and spellings of the same first name (each line is one group).
const NICKNAME_GROUPS = [
  "william bill billy will willie", "robert bob bobby rob robbie", "richard rick ricky rich dick", "james jim jimmy jamie", "john jack johnny",
  "joseph joe joey", "jose pepe", "francisco frank paco pancho", "frank franklin frankie", "guadalupe lupe", "jesus chuy", "alejandro alex", "alexander alex",
  "alexandra alex sandra", "elizabeth liz beth betty lisa eliza", "margaret maggie peggy meg", "katherine kathy kate katie catherine cathy kathryn",
  "patricia pat patty trish", "patrick pat", "michael mike mikey", "thomas tom tommy", "anthony tony", "antonio tony", "charles charlie chuck",
  "daniel dan danny", "david dave", "edward ed eddie ted", "jennifer jen jenny", "susan sue susie", "deborah debbie deb debra", "rebecca becky",
  "samuel sam sammy", "samantha sam", "steven stephen steve", "christopher chris", "christina chris tina christine", "nicholas nick",
  "matthew matt", "andrew andy drew", "benjamin ben", "jonathan jon", "timothy tim", "gregory greg", "kenneth ken kenny", "ronald ron ronnie",
  "donald don donnie", "raymond ray", "lawrence larry", "gerald jerry", "jeffrey jeff", "douglas doug", "victoria vicky tori", "cynthia cindy",
  "pamela pam", "barbara barb", "theresa teresa terry tess", "angela angie", "jacqueline jackie", "maria mary", "guillermo memo", "eduardo lalo",
  "roberto beto", "alberto beto", "ignacio nacho", "enrique kike", "rosa rosie", "rafael raphael", "jeffrey geoffrey", "philip phillip",
  "mohamed mohammed muhammad mohammad mohamad muhamed mohammod", "ahmed ahmad", "abdul abdel", "hussein husain hussain", "ibrahim ebrahim",
  "fatima fatimah", "aisha ayesha aysha", "mustafa mostafa moustafa", "yusuf yousef youssef yousif",
];
const NICKNAMES = new Map<string, Set<number>>();
NICKNAME_GROUPS.forEach((line, i) => line.split(" ").forEach((n) => { const g = NICKNAMES.get(n); if (g) g.add(i); else NICKNAMES.set(n, new Set([i])); }));
const nicknamesOf = (w: string): string[] => {
  const groups = NICKNAMES.get(w);
  if (!groups) return [];
  return NICKNAME_GROUPS.filter((_, i) => groups.has(i)).flatMap((g) => g.split(" ")).filter((n) => n !== w);
};
const sameNickname = (a: string, b: string) => { const g = NICKNAMES.get(a); return !!g && Array.from(NICKNAMES.get(b) ?? []).some((i) => g.has(i)); };

type FirstKind = "same" | "short" | "nick" | "shortish" | "typo" | "middle";
const FIRST_WHY: Record<FirstKind, string> = {
  same: "same first name", short: "first name shortened", nick: "nickname", shortish: "first name shortened", typo: "first name spelled a little differently", middle: "goes by the middle name",
};

function firstKind(a: string[], b: string[]): FirstKind | null {
  const fa = a[0]!, fb = b[0]!;
  if (fa === fb) return "same";
  const [s, l] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  if (s.length >= 4 && l.length - s.length >= 3 && l.startsWith(s)) return "short"; // "Chris" / "Christopher", "Alex" / "Alexander"
  if (sameNickname(fa, fb)) return "nick";
  // "Ana" / "Anabel", "Daniel" / "Daniela", "Gabriel" / "Gabriela": can be two different people.
  if (s.length >= 3 && l.startsWith(s)) return "shortish";
  if (similarSpelling(fa, fb)) return "typo";
  if ((a.length > 2 && a[1] === fb) || (b.length > 2 && b[1] === fa)) return "middle";
  return null;
}

type LastKind = "same" | "extra" | "cut" | "joined" | "typo";
const LAST_WHY: Record<LastKind, string> = {
  same: "same last name", extra: "one has an extra last or middle name", cut: "last name cut short", joined: "last name written with or without a hyphen or space", typo: "last name spelled a little differently",
};

function lastKind(a: string[], b: string[]): LastKind | null {
  const ra = a.slice(1), rb = b.slice(1);
  const la = a[a.length - 1]!, lb = b[b.length - 1]!;
  if (la === lb && ra.length === rb.length) return "same";
  // The family name of one is among the other's last / middle names ("Panesso Gonzal" and "Panesso").
  if (rb.includes(la) || ra.includes(lb)) return "extra";
  // Cut short at the end, as insurance files do with long names ("Gonzal" for "Gonzalez").
  if ((la.length >= 4 && rb.some((y) => y !== la && y.startsWith(la))) || (lb.length >= 4 && ra.some((x) => x !== lb && x.startsWith(lb)))) return "cut";
  const ja = ra.join(""), jb = rb.join("");
  if (Math.min(ja.length, jb.length) >= 4 && (ja.startsWith(jb) || jb.startsWith(ja))) return "joined"; // "De La Cruz" / "Delacruz"
  if (similarSpelling(la, lb) || (ja !== la && jb !== lb && similarSpelling(ja, jb))) return "typo";
  return null;
}

function compareWords(a: string[], b: string[]): NameComparison | null {
  if (a.length < 2 || b.length < 2) return null;
  if (a.join(" ") === b.join(" ")) return { level: "strong", why: "same name" };
  const f = firstKind(a, b);
  const l = lastKind(a, b);
  const why = [f ? FIRST_WHY[f] : null, l ? LAST_WHY[l] : null].filter(Boolean).join(", ");
  const goodFirst = f === "same" || f === "short" || f === "nick";
  const goodLast = l === "same" || l === "extra" || l === "cut" || l === "joined";
  // Both have middle names and none of them agree ("Maria Elena Garcia" / "Maria Luisa Garcia"): maybe two people.
  // (A word the other name has anywhere is a shared last name, not a middle name: "Adriana Panesso Gonzal" / "Adriana Maria Panesso".)
  const ma = a.slice(1, -1).filter((x) => !b.includes(x)), mb = b.slice(1, -1).filter((y) => !a.includes(y));
  const middlesDiffer = ma.length > 0 && mb.length > 0 && !ma.some((x) => mb.some((y) => x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)))));
  if (goodFirst && goodLast && middlesDiffer) return { level: "close", why: `${why}, different middle names` };
  if (goodFirst && goodLast) return { level: "strong", why };
  if ((goodFirst && l === "typo") || ((f === "typo" || f === "middle" || f === "shortish") && goodLast)) return { level: "close", why };
  // First and last name swapped on one of them.
  if (a[0] === b[b.length - 1] && a[a.length - 1] === b[0]) return { level: "close", why: "first and last name swapped" };
  // Only as a suggestion: same last name and the same first letter, or the same first name and a last name that starts the same.
  if (goodLast && a[0]![0] === b[0]![0]) return { level: "weak", why: `${LAST_WHY[l!]}, first name starts the same` };
  if (goodFirst && a[a.length - 1]!.slice(0, 3) === b[b.length - 1]!.slice(0, 3)) return { level: "weak", why: `${FIRST_WHY[f!]}, last name starts the same` };
  if (f === "typo" && l === "typo") return { level: "weak", why: "first and last name spelled a little differently" };
  return null;
}

/** How alike two names are (null = not alike). */
export const compareNames = (billName: string | null | undefined, personName: string | null | undefined) => compareWords(nameWords(billName), nameWords(personName));

/**
 * Does the bill's first name fit this person? Used for member ID matches, where a family can share one
 * ID: the ID alone could be a spouse's or child's, so the first name must agree too.
 */
export function firstNameFits(billName: string | null | undefined, personName: string | null | undefined): boolean {
  const a = nameWords(billName), b = nameWords(personName);
  if (!a.length || !b.length) return true; // nothing to contradict the ID
  const c = compareWords(a, b);
  if (c && c.level !== "weak") return true;
  const f = firstKind(a, b);
  return f === "same" || f === "short" || f === "nick" || f === "typo" || f === "middle";
}

/** Ways one member ID gets written: as is, without a 3-letter plan prefix ("XOD…"), without a 2-digit card suffix ("…01"). */
export function memberVariants(raw: string | null | undefined): string[] {
  const full = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (full.length < 5) return [];
  const out = [full];
  const noPrefix = full.replace(/^[A-Z]{3}(?=\d)/, "");
  if (noPrefix !== full && noPrefix.length >= 6) out.push(noPrefix);
  for (const v of [...out]) if (v.length >= 10 && /\d\d$/.test(v)) out.push(v.slice(0, -2));
  return Array.from(new Set(out));
}

// ---------------------------------------------------------------------------
// Everyone a bill could be for
// ---------------------------------------------------------------------------

export interface PersonInput { key: string; patientId: number | null; name: string; dob: string | null; providerIds: number[]; visitDays: string[] }
export interface Person { key: string; keys: string[]; patientId: number | null; name: string; dob: string | null; words: string[]; providerIds: Set<number>; visitDays: Set<string> }
export interface PeopleIndex { people: Person[]; byKey: Map<string, Person>; byWord: Map<string, Person[]>; byStart: Map<string, Person[]> }

/** Roster key first, then a schedule key, then a Practice Fusion-only key. */
const keyRank = (k: string) => (k.startsWith("p:") ? 0 : k.startsWith("s:") ? 1 : 2);
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

/**
 * One entry per person. The roster, the schedule and Practice Fusion can each hold the same person
 * under their own key; the same name and birthday is one person (the roster key wins). A record with
 * no birthday joins the only birthday that name has.
 */
export function buildPeopleIndex(list: PersonInput[]): PeopleIndex {
  const byKey = new Map<string, Person>();
  const each: Person[] = [];
  for (const x of list) {
    const p = byKey.get(x.key);
    if (p) {
      x.providerIds.forEach((id) => p.providerIds.add(id));
      x.visitDays.forEach((d) => p.visitDays.add(d));
      if (!p.dob) p.dob = x.dob;
      if (p.words.length < 2) { p.name = x.name; p.words = nameWords(x.name); }
      continue;
    }
    const n: Person = { key: x.key, keys: [x.key], patientId: x.patientId, name: x.name, dob: x.dob, words: nameWords(x.name), providerIds: new Set(x.providerIds), visitDays: new Set(x.visitDays) };
    byKey.set(x.key, n);
    each.push(n);
  }
  const groups = new Map<string, Person[]>();
  for (const p of each) push(groups, p.words.length ? p.words.join(" ") : `#${p.key}`, p);
  const people: Person[] = [];
  for (const ps of Array.from(groups.values())) {
    const byDob = new Map<string, Person[]>();
    const noDob: Person[] = [];
    for (const p of ps) if (p.dob) push(byDob, p.dob, p); else noDob.push(p);
    const sets = Array.from(byDob.values());
    if (sets.length === 1) sets[0]!.push(...noDob);
    else if (!sets.length) sets.push(noDob);
    else sets.push(...noDob.map((p) => [p]));
    for (const s of sets) {
      if (!s.length) continue;
      s.sort((x, y) => keyRank(x.key) - keyRank(y.key));
      const main = s[0]!;
      for (const o of s.slice(1)) {
        main.keys.push(...o.keys);
        o.providerIds.forEach((id) => main.providerIds.add(id));
        o.visitDays.forEach((d) => main.visitDays.add(d));
        if (!main.dob) main.dob = o.dob;
        if (main.patientId == null) main.patientId = o.patientId;
      }
      for (const k of main.keys) byKey.set(k, main);
      people.push(main);
    }
  }
  const byWord = new Map<string, Person[]>();
  const byStart = new Map<string, Person[]>();
  for (const p of people) {
    if (p.words.length < 2) continue;
    for (const w of Array.from(new Set(p.words))) {
      push(byWord, w, p);
      if (w.length >= 4) push(byStart, w.slice(0, 4), p);
    }
  }
  return { people, byKey, byWord, byStart };
}

export interface Candidate { person: Person; level: NameLevel; why: string; support: number; supportWhy: string | null }
export interface FindInput { name: string | null | undefined; dates: string[]; providerId: number | null }

const dayNum = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
const LEVEL_RANK: Record<NameLevel, number> = { strong: 0, close: 1, weak: 2 };

/** What else points to this person: a visit that day (3), the same provider (2), a visit within two months (1). */
function supportOf(p: Person, input: FindInput): { score: number; why: string | null } {
  if (input.dates.some((d) => p.visitDays.has(d))) return { score: 3, why: "had a visit that day" };
  if (input.providerId && p.providerIds.has(input.providerId)) return { score: 2, why: "same provider" };
  const days = input.dates.map(dayNum);
  if (Array.from(p.visitDays).some((v) => days.some((d) => Math.abs(dayNum(v) - d) <= 60))) return { score: 1, why: "had a visit within two months" };
  return { score: 0, why: null };
}

/** People whose name is like the bill's, best first (weak ones only when asked, for suggestions). */
export function findPeople(idx: PeopleIndex, input: FindInput, withWeak = false): Candidate[] {
  const a = nameWords(input.name);
  if (a.length < 2) return [];
  const pool = new Set<Person>();
  const add = (l?: Person[]) => { if (l) for (const p of l) pool.add(p); };
  for (const w of a) {
    add(idx.byWord.get(w));
    if (w.length >= 4) add(idx.byStart.get(w.slice(0, 4)));
    for (const n of nicknamesOf(w)) add(idx.byWord.get(n));
  }
  const out: Candidate[] = [];
  for (const p of Array.from(pool)) {
    const c = compareWords(a, p.words);
    if (!c || (c.level === "weak" && !withWeak)) continue;
    const s = supportOf(p, input);
    out.push({ person: p, level: c.level, why: c.why, support: s.score, supportWhy: s.why });
  }
  return out.sort((x, y) => LEVEL_RANK[x.level] - LEVEL_RANK[y.level] || y.support - x.support || x.person.name.localeCompare(y.person.name));
}

/**
 * The one person a bill is for, or null when it isn't clear. A strong name that only one person has
 * wins (unless a near name has more pointing to it). Otherwise the one person with the most pointing to
 * them; nothing pointing to anyone, or a tie, is left for the owner.
 */
export function pickPerson(cands: Candidate[]): Candidate | null {
  const strong = cands.filter((c) => c.level === "strong");
  const close = cands.filter((c) => c.level === "close");
  if (strong.length === 1) {
    const s = strong[0]!;
    return close.some((c) => c.support > s.support) ? null : s;
  }
  const pool = strong.length > 1 ? strong : close;
  if (!pool.length) return null;
  const best = Math.max(...pool.map((c) => c.support));
  if (best === 0) return null;
  const top = pool.filter((c) => c.support === best);
  if (top.length !== 1) return null;
  if (strong.length > 1 && close.some((c) => c.support > best)) return null;
  return top[0]!;
}

/**
 * The person a member ID belongs to: Practice Fusion's insurance list and insurance checks, the whole ID
 * first, then without a plan prefix or card suffix. The first name must fit (a family can share an ID).
 */
export function personByMember(idx: PeopleIndex, members: Map<string, Set<string>>, memberId: string | null | undefined, billName: string | null | undefined, checkName = true): Person[] {
  const vs = memberVariants(memberId);
  if (!vs.length) return [];
  let keys = Array.from(members.get(vs[0]!) ?? []);
  if (!keys.length) keys = vs.slice(1).flatMap((v) => Array.from(members.get(v) ?? []));
  const found = new Map<string, Person>();
  for (const k of keys) {
    const p = idx.byKey.get(k);
    if (p && (!checkName || firstNameFits(billName, p.name))) found.set(p.key, p);
  }
  return Array.from(found.values());
}

/** Member ID → the people it was seen on, under every way it's written. */
export function addMember(members: Map<string, Set<string>>, memberId: string | null | undefined, key: string | null | undefined) {
  if (!key) return;
  for (const v of memberVariants(memberId)) {
    const s = members.get(v);
    if (s) s.add(key); else members.set(v, new Set([key]));
  }
}
