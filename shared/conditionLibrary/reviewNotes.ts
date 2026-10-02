// Points in the built-in drafts the reviewing provider should check before approving (shown on the
// condition's library page until it's approved). Written when the drafts were made, 2026-10-01.
export const REVIEW_NOTES: Record<string, string[]> = {
  diabetes: [
    "Targets follow the ADA Standards of Care 2025; confirm against the current (2026) edition.",
    "\"Call us if blood sugar is over 300 twice in a row\" is a common-practice threshold, not a guideline number.",
  ],
  hypertension: [
    "Cites the 2025 AHA/ACC blood pressure guideline (goal under 130/80) alongside 2017; confirm the details.",
    "180/120 is split into \"call us\" (no symptoms) and \"call 911\" (with symptoms), per AHA public guidance.",
  ],
  heart_failure: ["Salt under 2,000 mg a day is common practice; the 2022 guideline only says to avoid excess salt."],
  lipids: ["LDL goals (under 70; under 55 very high risk; under 100 otherwise) follow the 2018 guideline and 2022 ACC pathway; check for a newer cholesterol guideline."],
  afib: [
    "Patient heart-rate goal \"below about 100 to 110\" follows the 2023 guideline's relaxed target; you may prefer one number.",
    "\"Call if resting pulse often above 110, or below 50 with symptoms\" is a common-practice threshold.",
  ],
  pvd: ["Care plan uses Medicare's supervised exercise format (30–60 min, 3×/week, 12 weeks); the handout says to work up to 30+ minutes 3+ times a week."],
  stroke: [
    "I69 covers both ischemic and hemorrhagic stroke: blood-thinner and LDL-under-70 wording is hedged (\"if prescribed\"); specify the stroke type per patient.",
    "Spanish handout uses the AHA's Spanish mnemonic RÁPIDO instead of BE FAST; check the letter meanings against AHA Spanish materials.",
  ],
  copd: ["Oxygen goal \"88% or higher at rest\"; some practices use 90% or higher, or 88–92% on home oxygen."],
  asthma: ["Cites GINA 2024; check for a newer edition."],
  ckd: [
    "Handout BP goal under 130/80; the care plan adds KDIGO's systolic under 120 (standardized, if tolerated), which may be too aggressive for frail patients.",
    "Lab frequency by risk level, team-care (2-year kidney failure risk over 10%) and kidney-replacement planning (over 40%) thresholds, and the 3–5% 5-year-risk referral point were written from memory; confirm against the KDIGO 2024 chart.",
    "A1c wording is \"usually under 7% to 8%, depending on your health\" rather than one number.",
    "Mentions Medicare kidney-disease education sessions for stage 4 and nutrition counseling coverage; billing should confirm these are current.",
  ],
  thyroid: [
    "TSH recheck 6–8 weeks after a dose change (guidance ranges 4–8 weeks); allows TSH about 4–6 for patients over 70–80 (an ATA-supported option, not a firm rule).",
    "Biotin: the handout says to stop it \"a few days\" before thyroid labs and to ask first; some labs want 2–3 days or longer.",
  ],
  obesity: ["Mentions Medicare's weight-counseling visit schedule; billing should confirm it is current."],
  sleep_apnea: ["Includes Medicare's CPAP adherence rule (4+ hours on 70% of nights; re-check between days 31 and 91); billing should confirm it is current."],
  liver: [
    "Fibrosis score cutoff 2.0 for patients 65 and older reflects common practice; confirm it matches the practice.",
    "A1c wording is \"usually under 7% to 8%, depending on your health\" rather than one number.",
  ],
  osteoarthritis: [],
  rheumatoid: [
    "DMARD lab monitoring written as \"about every 1 to 3 months\" (depends on the drug; left to rheumatology).",
    "Fever threshold for patients on immune-suppressing medicines is 100.4°F (38°C).",
  ],
  osteoporosis: [
    "Vitamin D 800–1,000 IU/day for adults over 50 (Bone Health & Osteoporosis Foundation); the RDA is lower (600 IU age 51–70, 800 IU over 70). Calcium 1,000–1,200 mg.",
    "Warns that stopping some bone medicines suddenly can raise spine-fracture risk (no drug named).",
  ],
  dementia: [
    "\"Sudden confusion\" is under call 911 (possible stroke); a milder change over hours is often a same-day call instead.",
    "Alzheimer's Association helpline (1-800-272-3900) appears in staff talking points and the care plan only; please re-check the number.",
    "Basis names (Alzheimer's Association 2024 diagnostic-evaluation guideline, AAN measure sets) were written from memory; confirm titles.",
  ],
  parkinsons: ["Handout warns that some medicines for nausea or mental health can make Parkinson's worse (no drug named)."],
  epilepsy: ["A typical seizure in someone already diagnosed is \"call us\", not 911, unless an emergency sign applies (5+ minutes, back-to-back, injury, breathing trouble)."],
  ms: [
    "Brain MRI \"about once a year\" while on treatment is a simplification; schedules vary by neurologist.",
    "Sudden loss of vision is listed under call 911.",
  ],
  chronic_pain: [],
  depression: ["All behavioral handouts: the Spanish 988 line says 988 offers help in Spanish; you may want to add \"press 2 for Spanish\"."],
  ptsd: ["PCL-5: a 10-point drop is used as meaningful progress and a probable-PTSD cutoff of about 31–33; published cutoffs vary."],
  bipolar: [
    "Antipsychotic metabolic monitoring written as weight monthly for 3 months then quarterly, and BP, glucose/A1c and lipids at baseline, about 3–4 months, then yearly; ADA/APA consensus and the APA schizophrenia guideline differ slightly.",
    "Handout lists vomiting, diarrhea, bad shaking, unsteady walking or confusion while on \"a medicine that needs blood level checks\" as a reason to call right away (no drug named).",
    "Basis cites the ADA/APA metabolic consensus (2004) and NICE CG113, which are older; you may want newer sources.",
  ],
  substance: [
    "Example targets (80% of days abstinent; heavy-use days down 50%) are illustrations, not guideline figures.",
    "\"Don't stop all at once\" covers heavy daily drinking and daily sleeping or nerve pills (withdrawal risk).",
  ],
  cancer: [
    "Fever 100.4°F (38°C) or higher during chemotherapy is in \"call us right away\" (not a number goal).",
    "Example targets (symptoms 3 or lower out of 10; weight within 5% of baseline) are illustrations.",
  ],
  hiv: [
    "Handout calls CD4 over 500 the usual healthy range; the monitoring schedule is a simplified version of DHHS guidance.",
    "U=U: says you will not pass HIV to a partner through sex when undetectable, that most people reach undetectable within 6 months, and that it doesn't protect against other STIs.",
    "\"At least 95% adherence\" is an illustrative target.",
  ],
  anxiety: [],
  cad: [],
};
