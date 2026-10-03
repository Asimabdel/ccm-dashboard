// Prevention & wellness handouts (the practice's choice, 2026-10-02): vaccines, cancer screenings,
// check-ups and healthy living. English + Spanish, plain language (about a 6th-grade reading level).
// Every topic is a DRAFT until an admin approves it; patients only ever see approved topics.
import type { LibraryLang } from "../conditionLibrary/types";

/** One prevention / wellness handout. */
export interface WellnessDoc {
  /** e.g. "The flu shot" */
  title: string;
  /** 2–3 short sentences: what it is and why it matters. */
  summary: string;
  /** Who it's for, in plain words (ages, groups): 2–4 bullets. Empty for topics that are for everyone. */
  whoFor: string[];
  /** How often / when, one short sentence. Empty when it doesn't apply. */
  howOften: string;
  /** The main advice: what to do, how to get ready, how to make it a habit: 4–7 bullets. */
  whatToDo: string[];
  /** What to expect (side effects, what happens next, results): 2–4 bullets. Empty if not relevant. */
  whatToExpect: string[];
  /** When to talk with us: 2–4 bullets. */
  talkToUs: string[];
}

export interface WellnessEntry {
  /** The topic key (e.g. "w_flu"). */
  key: string;
  education: Record<LibraryLang, WellnessDoc>;
  /** The guidance the draft follows (for the reviewer), e.g. "CDC adult immunization schedule". */
  basis: string[];
}

export const WELLNESS_HEADINGS: Record<LibraryLang, Record<Exclude<keyof WellnessDoc, "title" | "summary">, string> & { group: string }> = {
  en: { whoFor: "Who it's for", howOften: "How often", whatToDo: "What you can do", whatToExpect: "What to expect", talkToUs: "Talk with us if", group: "Prevention & wellness" },
  es: { whoFor: "Para quién es", howOften: "Con qué frecuencia", whatToDo: "Lo que usted puede hacer", whatToExpect: "Qué esperar", talkToUs: "Hable con nosotros si", group: "Prevención y bienestar" },
};
