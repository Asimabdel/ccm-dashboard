// Which patients are "automatic APCM" for a month, and the order the APCM list goes in.
// Practice rule (from August 2026): a patient who did a CCM with us before, but had no CCM
// completed that month, is on that month's APCM list. Billing APCM still needs the patient's
// APCM consent, care plan and initiating visit on file (Medicare: CCM consent doesn't count).

/** First month of the automatic APCM list. */
export const APCM_AUTO_START = "2026-08";

/**
 * APCM priority for a month (lower goes first): 1 = did a CCM with us in an earlier month
 * (automatic APCM from APCM_AUTO_START on), 2 = reached this year but no CCM done yet,
 * 3 = not reached this year. Patients whose CCM was completed THAT month bill CCM (no tier).
 */
export function apcmPriority(r: { ccmDoneThisMonth: boolean; ccmCompletedBefore: number; reachedThisYear: boolean }): 1 | 2 | 3 | null {
  if (r.ccmDoneThisMonth) return null;
  if (r.ccmCompletedBefore > 0) return 1;
  return r.reachedThisYear ? 2 : 3;
}

/** Whether the month uses the automatic APCM list ("YYYY-MM" compares as text). */
export const isAutoApcmMonth = (month: string) => month >= APCM_AUTO_START;

/** Months from APCM_AUTO_START through `current`, oldest first. */
export function autoApcmMonths(current: string): string[] {
  const out: string[] = [];
  let [y, m] = APCM_AUTO_START.split("-").map(Number);
  for (let i = 0; i < 120; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > current) break;
    out.push(key);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
