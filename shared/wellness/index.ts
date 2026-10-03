// Prevention & wellness handouts: the built-in drafts (an admin reviews and approves each before any
// patient sees it), the topic registry and who each is suggested for.
import type { WellnessEntry } from "./types";
import { WELLNESS_VACCINES, WELLNESS_VACCINES_NOTES } from "./vaccines";
import { WELLNESS_SCREENINGS, WELLNESS_SCREENINGS_NOTES } from "./screenings";
import { WELLNESS_CHECKUPS, WELLNESS_CHECKUPS_NOTES } from "./checkups";
import { WELLNESS_LIVING, WELLNESS_LIVING_NOTES } from "./living";

export * from "./types";
export * from "./registry";

const ALL: WellnessEntry[] = [...WELLNESS_VACCINES, ...WELLNESS_SCREENINGS, ...WELLNESS_CHECKUPS, ...WELLNESS_LIVING];
export const DEFAULT_WELLNESS: ReadonlyMap<string, WellnessEntry> = new Map(ALL.map((e) => [e.key, e]));

/** Points in the built-in drafts the reviewer should double-check. */
export const WELLNESS_REVIEW_NOTES: Record<string, string[]> = {
  ...WELLNESS_VACCINES_NOTES, ...WELLNESS_SCREENINGS_NOTES, ...WELLNESS_CHECKUPS_NOTES, ...WELLNESS_LIVING_NOTES,
};
