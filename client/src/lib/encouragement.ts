// Daily encouragement for care coordinators. One message per person per day:
// picked deterministically from the pool using (day-of-year, userId), so it
// changes every day, differs between coordinators, and stays stable across
// reloads within the same day.

const MESSAGES = [
  "Every call you make today is a patient who isn't facing their health alone.",
  "Small check-ins prevent big emergencies. Your calls matter more than they feel.",
  "You might be the only person who asks how they're doing today.",
  "Consistency beats intensity — one steady call at a time.",
  "Behind every completed CCM is someone sleeping easier tonight.",
  "The best care is the kind that shows up every month. That's you.",
  "A five-minute call can change the direction of someone's whole week.",
  "You're the bridge between a worried patient and their doctor.",
  "Voicemails count too — persistence is a form of caring.",
  "Your voice may be the calmest part of a patient's day.",
  "Today's no-answers are tomorrow's completed calls. Keep dialing.",
  "Good coordinators track numbers. Great ones hear the person behind them.",
  "Every medication question you catch is a complication you prevented.",
  "One conversation at a time, you're keeping people out of the hospital.",
  "The patients you call today have been waiting to be heard.",
  "Progress isn't always loud. Sometimes it's a quiet call that went well.",
  "You don't just complete tasks — you close the gaps care falls through.",
  "Somebody's blood pressure is under control because you kept calling.",
  "Start with the hardest call. The rest of the day gets lighter.",
  "Your worklist is long because so many people trust this practice with their health.",
  "Being checked on regularly is a luxury most patients never had — until you.",
  "Listen for what they don't say. That's where the real escalations hide.",
  "Yesterday is logged. Today is a fresh list.",
  "The goal isn't perfection — it's showing up for every name on the list.",
  "You've talked people through fear, confusion, and refills. That's skill.",
  "Every chronic condition is easier to live with when someone's paying attention.",
  "Your follow-through is the difference between a plan and actual care.",
  "Even a short call tells a patient: you haven't been forgotten.",
  "Coffee first, then compassion at scale.",
  "Nobody sees most of what you do. The patients feel all of it.",
  "A well-documented note today saves a scramble tomorrow.",
  "You carry a lot of people's worries so their doctors can act on them.",
  "Trust your instincts — if something feels off on a call, flag it.",
  "The month is won in the mornings. Nice and steady.",
  "Care isn't a grand gesture. It's a phone that keeps ringing until it's answered.",
  "You're allowed to be proud of a day that was just... solid.",
] as const;

/** Deterministic day-of-year (local time). */
function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}

/** The coordinator's encouragement for today — stable all day, new tomorrow. */
export function dailyEncouragement(userId: number, now: Date = new Date()): string {
  const idx = (dayOfYear(now) * 31 + userId * 7 + now.getFullYear()) % MESSAGES.length;
  return MESSAGES[idx];
}

/** Time-of-day greeting, e.g. "Good morning". */
export function greetingForNow(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** First name only, for a personal but tidy greeting. */
export function firstNameOf(name?: string | null): string {
  return (name || "").trim().split(/\s+/)[0] || "there";
}
