// Simple questions for the monthly CCM call: short, plain, answered with one tap (Yes / No, Better / Same /
// Worse, Every day / Missed some…), plus an optional note. One per condition per call, never one the patient
// was already asked (see ccmCall nextQuestion). The most important question for a condition comes first.
//
// `tell` = answers worth letting the provider know about: the call screen only reminds the coordinator of the
// flag for provider review. Nothing here judges or decides anything clinical; the provider does.

export interface SimpleQuestion {
  q: string;
  options: string[];
  /** Answers worth letting the provider know about. */
  tell?: string[];
}

const NY = ["No", "Yes"];
const YN = ["Yes", "No"];
const YN_UNSURE = ["Yes", "No", "Not sure"];
const TREND = ["Better", "Same", "Worse"];
const MEDS = ["Every day", "Missed some", "Not taking it"];
const SOME = ["No", "Some", "A lot"];
const SMOKE = ["No", "Yes", "Cutting down"];

const yesTell = (q: string): SimpleQuestion => ({ q, options: NY, tell: ["Yes"] });
const meds = (what: string): SimpleQuestion => ({ q: `Taking your ${what} every day?`, options: MEDS, tell: ["Not taking it"] });

/** By condition group (the library's category). */
const BY_CATEGORY: Record<string, SimpleQuestion[]> = {
  diabetes: [
    { q: "Are your sugar numbers mostly in your goal range?", options: ["Yes", "No", "Not checking"] },
    yesTell("Any low sugars (shaky, sweaty, confused)?"),
    meds("diabetes medicine"),
    yesTell("Any sores or cuts on your feet?"),
    { q: "Eye exam done this year?", options: YN_UNSURE },
  ],
  hypertension: [
    { q: "Are your home blood pressure numbers mostly under your goal?", options: ["Yes", "No", "Not checking"] },
    meds("blood pressure medicine"),
    yesTell("Any bad headaches, dizziness or blurry vision?"),
    { q: "Cutting back on salt?", options: ["Yes", "Trying", "No"] },
  ],
  heart_failure: [
    { q: "Weighing yourself every morning?", options: ["Yes", "Sometimes", "No"] },
    yesTell("Gained 3 pounds in a day or 5 in a week?"),
    yesTell("More short of breath or more swelling than last month?"),
    yesTell("Need more pillows to breathe at night?"),
    meds("heart medicines"),
  ],
  cad: [
    yesTell("Any chest pain or pressure this month?"),
    meds("heart medicines"),
    yesTell("Short of breath with light activity?"),
    { q: "Walking or staying active most days?", options: ["Yes", "Some days", "No"] },
  ],
  afib: [
    yesTell("Heart racing or fluttering this month?"),
    meds("blood thinner"),
    yesTell("Any unusual bleeding or bruising?"),
    yesTell("Any dizziness or fainting?"),
  ],
  lipids: [
    meds("cholesterol medicine"),
    { q: "Any muscle aches from the medicine?", options: NY },
    { q: "Cholesterol blood test done this year?", options: YN_UNSURE },
    { q: "Eating more vegetables and less fried food?", options: ["Yes", "Trying", "No"] },
  ],
  copd: [
    { q: "Breathing better, same or worse than last month?", options: TREND, tell: ["Worse"] },
    { q: "Using your rescue inhaler more than usual?", options: NY, tell: ["Yes"] },
    { q: "Using your daily inhaler every day?", options: ["Every day", "Missed some", "Not using it"] },
    { q: "Any flare-up, ER visit or steroid pills this month?", options: NY },
    { q: "Smoking?", options: SMOKE },
  ],
  asthma: [
    { q: "Asthma symptoms more than 2 days a week?", options: NY },
    { q: "Waking up at night from asthma?", options: NY },
    { q: "Using your controller inhaler every day?", options: ["Every day", "Missed some", "Not using it"] },
    { q: "Does your rescue inhaler help when you need it?", options: YN, tell: ["No"] },
  ],
  ckd: [
    { q: "Kidney blood and urine tests done on time?", options: YN_UNSURE },
    { q: "Taking pain pills like ibuprofen, Advil or Aleve?", options: NY },
    yesTell("Any new swelling in your legs or feet?"),
    meds("blood pressure medicine"),
  ],
  thyroid: [
    meds("thyroid pill"),
    { q: "Feeling more tired, cold or hot than usual?", options: NY },
    { q: "Thyroid blood test done this year?", options: YN_UNSURE },
  ],
  obesity: [
    { q: "Weight down, same or up since last month?", options: ["Down", "Same", "Up"] },
    { q: "Active at least 3 days this week?", options: YN },
    { q: "Working on one eating change this month?", options: YN },
  ],
  osteoarthritis: [
    { q: "Joint pain better, same or worse?", options: TREND },
    { q: "Pain stopping you from daily activities?", options: SOME },
    { q: "Taking pain pills like ibuprofen or Aleve most days?", options: NY },
    { q: "Doing your exercises or walking?", options: ["Yes", "Some days", "No"] },
  ],
  rheumatoid: [
    { q: "Any flares or new joint swelling?", options: NY },
    { q: "Taking your arthritis medicine as prescribed?", options: ["Yes", "Missed some", "Not taking it"], tell: ["Not taking it"] },
    yesTell("Any fever or infection?"),
    { q: "Stiff for more than an hour in the morning?", options: NY },
  ],
  osteoporosis: [
    yesTell("Any falls or near falls?"),
    { q: "Taking your bone medicine as prescribed?", options: ["Yes", "Missed some", "Not taking it"] },
    { q: "Taking calcium and vitamin D?", options: YN },
    { q: "Is your home clear of rugs and things to trip on?", options: YN },
  ],
  dementia: [
    yesTell("Any new confusion or getting lost?"),
    yesTell("Any falls?"),
    { q: "Is someone helping with medicines?", options: YN },
    { q: "Is the caregiver doing OK?", options: ["Yes", "Needs help"], tell: ["Needs help"] },
  ],
  parkinsons: [
    { q: "Does your medicine last until the next dose?", options: ["Yes", "Wears off early"] },
    yesTell("Any falls or near falls?"),
    yesTell("Any trouble swallowing?"),
    { q: "Doing exercise or therapy?", options: YN },
  ],
  stroke: [
    yesTell("Any new weakness, numbness or trouble speaking?"),
    meds("blood thinner or stroke medicine"),
    { q: "Are your home blood pressure numbers mostly under your goal?", options: ["Yes", "No", "Not checking"] },
    yesTell("Any falls?"),
  ],
  pvd: [
    { q: "Leg pain when walking better, same or worse?", options: TREND },
    yesTell("Any sores on your feet or legs that won't heal?"),
    { q: "Walking most days?", options: ["Yes", "Some days", "No"] },
    { q: "Smoking?", options: SMOKE },
  ],
  cancer: [
    { q: "Is your next cancer appointment scheduled?", options: YN },
    { q: "Do you have a ride to your treatments?", options: YN },
    { q: "Is your pain under control?", options: YN, tell: ["No"] },
    { q: "Eating OK?", options: YN },
  ],
  liver: [
    { q: "Any alcohol this month?", options: NY },
    yesTell("Any yellow skin or eyes, or a swollen belly?"),
    { q: "Taking any new medicines or supplements?", options: NY },
    { q: "Liver blood tests done on time?", options: YN_UNSURE },
  ],
  hiv: [
    meds("HIV medicine"),
    { q: "Viral load blood test done on time?", options: YN_UNSURE },
    { q: "Enough medicine until your next refill?", options: YN, tell: ["No"] },
    yesTell("Any fever or new infection?"),
  ],
  sleep_apnea: [
    { q: "Using your CPAP every night?", options: ["Every night", "Some nights", "Not using it"] },
    { q: "Sleepy during the day?", options: NY },
    { q: "Does your mask fit OK?", options: YN },
  ],
  epilepsy: [
    yesTell("Any seizures this month?"),
    meds("seizure medicine"),
    { q: "Sleeping OK?", options: YN },
  ],
  ms: [
    yesTell("Any new or worse symptoms?"),
    { q: "Taking your MS medicine as prescribed?", options: ["Yes", "Missed some", "Not taking it"] },
    yesTell("Any falls?"),
  ],
  chronic_pain: [
    { q: "Pain better, same or worse?", options: TREND },
    { q: "Pain stopping you from daily activities?", options: SOME },
    { q: "Taking pain medicine only as prescribed?", options: YN, tell: ["No"] },
    { q: "Sleeping OK?", options: YN },
  ],
  depression: [
    { q: "Mood better, same or worse than last month?", options: TREND, tell: ["Worse"] },
    { q: "Taking your mood medicine every day?", options: ["Every day", "Missed some", "Not taking it", "Not on one"] },
    { q: "Sleeping OK?", options: YN },
    { q: "Doing things you enjoy?", options: ["Yes", "Some", "No"] },
  ],
  anxiety: [
    { q: "Worry better, same or worse?", options: TREND, tell: ["Worse"] },
    { q: "Worry getting in the way of your day?", options: SOME },
    { q: "Sleeping OK?", options: YN },
  ],
  ptsd: [
    { q: "Sleeping OK?", options: YN },
    { q: "Bad dreams or memories more than usual?", options: NY },
    { q: "Feeling safe at home?", options: YN, tell: ["No"] },
  ],
  bipolar: [
    { q: "Mood steady this month?", options: YN, tell: ["No"] },
    meds("mood medicine"),
    { q: "Sleeping OK?", options: YN },
  ],
  substance: [
    { q: "Any drinking or drug use since we last talked?", options: NY },
    { q: "Cravings better, same or worse?", options: TREND },
    { q: "Going to counseling or a support group?", options: YN },
  ],
  adhd: [
    { q: "Taking your ADHD medicine as prescribed?", options: ["Yes", "Missed some", "Not taking it"] },
    { q: "Keeping up with daily tasks?", options: ["Yes", "Some", "No"] },
    { q: "Sleeping and eating OK?", options: YN },
  ],
  ocd: [
    { q: "Worries or rituals better, same or worse?", options: TREND },
    { q: "Getting in the way of your day?", options: SOME },
    { q: "Going to therapy?", options: YN },
  ],
};

/** Exact diagnoses that need their own questions (the rest use their group's). */
const BY_ITEM: Record<string, SimpleQuestion[]> = {
  diabetes_t1: [
    { q: "Are your sugar numbers mostly in your goal range?", options: ["Yes", "No", "Not checking"] },
    yesTell("Any low sugars (shaky, sweaty, confused)?"),
    { q: "Have unexpired glucagon at home?", options: YN_UNSURE },
    { q: "Pump, sensor and supplies working OK?", options: ["Yes", "No", "Don't use one"] },
    yesTell("Any sores or cuts on your feet?"),
  ],
  ckd_5: [
    yesTell("Missed or cut short any dialysis sessions?"),
    { q: "Following your fluid limit?", options: ["Yes", "Mostly", "No"] },
    yesTell("Any new swelling or shortness of breath?"),
    { q: "Do you have a ride to dialysis?", options: YN },
  ],
  thyroid_hyper: [
    yesTell("Heart racing or feeling shaky?"),
    meds("thyroid medicine"),
    { q: "Thyroid blood test done on time?", options: YN_UNSURE },
  ],
  liver_hepatitis: [
    meds("hepatitis medicine"),
    { q: "Any alcohol this month?", options: NY },
    yesTell("Any yellow skin or eyes, or a swollen belly?"),
    { q: "Liver blood tests done on time?", options: YN_UNSURE },
  ],
  substance_opioid: [
    { q: "Any opioid or drug use since we last talked?", options: NY },
    { q: "Taking your treatment medicine every day?", options: MEDS },
    { q: "Have naloxone (Narcan) at home?", options: YN },
    { q: "Going to counseling or a support group?", options: YN },
  ],
  psychotic: [
    { q: "Feeling like yourself this month?", options: YN, tell: ["No"] },
    meds("medicine"),
    { q: "Sleeping OK?", options: YN },
  ],
};

/** A condition's simple questions (by its exact library key, else its group), most important first. */
export function simpleQuestionsFor(key: string, category: string | undefined): SimpleQuestion[] {
  return BY_ITEM[key] ?? (category ? BY_CATEGORY[category] : undefined) ?? [];
}

/** "Yes — only on weekends" → the tapped answer and the note (an answer that isn't one of the options is all note). */
export function splitAnswer(a: string, options: string[]): { choice: string; note: string } {
  const i = a.indexOf(" — ");
  const head = i >= 0 ? a.slice(0, i) : a;
  if (options.includes(head)) return { choice: head, note: i >= 0 ? a.slice(i + 3) : "" };
  return { choice: "", note: a };
}

/** The answer as saved with the note: the tapped answer, then the note. */
export const joinAnswer = (choice: string, note: string) => [choice.trim(), note.trim()].filter(Boolean).join(" — ");
