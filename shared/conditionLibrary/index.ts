// The starting (draft) condition library and the helpers both server and client use. Providers review,
// edit and approve each item in MyPCP; the database copy wins over these defaults (server/carePlansDb.ts).
// Items are specialized: exact diagnoses and add-ons for complications / overlaps (./registry).
import { GROUP_A } from "./groupA";
import { GROUP_B } from "./groupB";
import { GROUP_C } from "./groupC";
import { GROUP_D } from "./groupD";
import { SPEC_DIABETES, SPEC_DIABETES_NOTES } from "./spec_diabetes";
import { SPEC_CARDIO, SPEC_CARDIO_NOTES } from "./spec_cardio";
import { SPEC_RENAL_ENDO, SPEC_RENAL_ENDO_NOTES } from "./spec_renal_endo";
import { SPEC_LIVER_SUBSTANCE, SPEC_LIVER_SUBSTANCE_NOTES } from "./spec_liver_substance";
import { SPEC_BEHAVIORAL, SPEC_BEHAVIORAL_NOTES } from "./spec_behavioral";
import { REVIEW_NOTES as GENERAL_NOTES } from "./reviewNotes";
import type { ConditionLibraryEntry, EducationDoc, LibraryLang } from "./types";

export * from "./types";
export * from "./registry";

const ALL = [...GROUP_A, ...GROUP_B, ...GROUP_C, ...GROUP_D, ...SPEC_DIABETES, ...SPEC_CARDIO, ...SPEC_RENAL_ENDO, ...SPEC_LIVER_SUBSTANCE, ...SPEC_BEHAVIORAL];
export const DEFAULT_LIBRARY: ReadonlyMap<string, ConditionLibraryEntry> = new Map(ALL.map((e) => [e.key, e]));

/** Points in the built-in drafts the reviewing provider should check before approving. */
export const REVIEW_NOTES: Record<string, string[]> = {
  ...GENERAL_NOTES, ...SPEC_DIABETES_NOTES, ...SPEC_CARDIO_NOTES, ...SPEC_RENAL_ENDO_NOTES, ...SPEC_LIVER_SUBSTANCE_NOTES, ...SPEC_BEHAVIORAL_NOTES,
};

/** "heart_failure" ↔ "heart-failure" (the patient page address). */
export const slugOf = (key: string) => key.replace(/_/g, "-");
export const keyOfSlug = (slug: string) => slug.toLowerCase().replace(/-/g, "_");
export const learnPath = (key: string, lang: LibraryLang = "en") => `/learn/${slugOf(key)}${lang === "en" ? "" : `?lang=${lang}`}`;

export const LIBRARY_LANG_LABELS: Record<LibraryLang, string> = { en: "English", es: "Español" };

/** Handout section headings. */
export const EDUCATION_HEADINGS: Record<LibraryLang, Record<Exclude<keyof EducationDoc, "title" | "whatItIs">, string> & { print: string; moreTopics: string; footer: string; reviewed: string }> = {
  en: {
    whyItMatters: "Why it matters",
    whatYouCanDo: "What you can do",
    numbers: "Know your numbers",
    medicines: "Your medicines",
    callUs: "When to call us",
    call911: "Emergency: call 911",
    print: "Print",
    moreTopics: "More health topics",
    footer: "This information is for learning. It does not replace advice from your care team. Ask us about anything that is not clear.",
    reviewed: "Reviewed by your MyPCP Dr care team",
  },
  es: {
    whyItMatters: "Por qué es importante",
    whatYouCanDo: "Lo que usted puede hacer",
    numbers: "Conozca sus números",
    medicines: "Sus medicinas",
    callUs: "Cuándo llamarnos",
    call911: "Emergencia: llame al 911",
    print: "Imprimir",
    moreTopics: "Más temas de salud",
    footer: "Esta información es para aprender. No reemplaza los consejos de su equipo de salud. Pregúntenos sobre cualquier cosa que no esté clara.",
    reviewed: "Revisado por su equipo de MyPCP Dr",
  },
};

/** A sent set of handouts opens at /learn/s/<code>: the link names no condition (texts show on lock screens). */
export const sentLearnPath = (code: string) => `/learn/s/${code}`;

/** The text message / email body that sends a patient their handouts. No condition names in it. */
export function educationMessage(lang: LibraryLang, url: string, phone: string | null) {
  return lang === "es"
    ? [`MyPCP Dr: Su equipo de cuidado le envió información de salud: ${url}`, phone ? `¿Preguntas? Llámenos al ${phone}.` : "¿Preguntas? Llame a la clínica."].join("\n")
    : [`MyPCP Dr: Your care team sent you health information: ${url}`, phone ? `Questions? Call us at ${phone}.` : "Questions? Call the clinic."].join("\n");
}
