// Depression (PHQ-9) and anxiety (GAD-7) screenings for Patient forms.
//
// The questions, answer choices and scoring are the published instruments WORD FOR WORD, taken
// from phqscreeners.com: English, "Spanish for the USA" and "Arabic for Tunisia" (the site's
// footer on every form: "No permission required to reproduce, translate, display or distribute").
// Do not reword, reorder or "tidy" them: a score only means what it means with this exact wording.
// Everything else here (titles, the safety notes) is our own wording and can be changed.
//
// A screening score is not a diagnosis; the provider decides what it means.
import type { L10n } from "./intake";

export const PHQ9_KEY = "phq9";
export const GAD7_KEY = "gad7";

export interface ScreeningItem { id: string; text: L10n }
export interface ScreeningBand { min: number; max: number; label: string }
export interface Screening {
  key: string;
  version: number;
  /** What staff see. */
  name: string;
  short: string;
  /** What the patient sees in their list of forms. */
  title: L10n;
  /** The instrument's own title, for the printed copy. */
  official: L10n;
  minutes: number;
  /** The question above every item ("Over the last 2 weeks, how often…"). */
  stem: L10n;
  items: ScreeningItem[];
  /** The four answers, worth 0, 1, 2 and 3 points, in that order. */
  options: L10n[];
  /** PHQ-9 only: the last, unscored question (answers stored as "0".."3"). */
  difficulty?: { question: L10n; options: L10n[] };
  bands: ScreeningBand[];
  /** From this score up the screening is "positive": worth a closer look by the provider. */
  cutoff: number;
  /** The question about self-harm: any answer above "Not at all" is a safety flag. */
  riskItem?: string;
  credit: L10n;
}

const l = (en: string, es: string, ar: string): L10n => ({ en, es, ar });

const OPTIONS: L10n[] = [
  l("Not at all", "Ningún día", "أبداً"),
  l("Several days", "Varios días", "بعض الأيام"),
  l("More than half the days", "Más de la mitad de los días", "أكثر من نصف الأيام"),
  l("Nearly every day", "Casi todos los días", "كل يوم تقريباً"),
];

const CREDIT = l(
  "Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.",
  "Elaborado por los doctores Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke y colegas, mediante una subvención educativa otorgada por Pfizer Inc. No se requiere permiso para reproducir, traducir, presentar o distribuir.",
  "إعداد الأطباء روبرت إل سبيتزر، جانيت بي دبليو وليامز، كيرت كرونك والزملاء، بمنحة تعليمية من شركة Pfizer Inc. لا يلزم الحصول على إذن لإعادة النسخ أو الترجمة أو العرض أو التوزيع.",
);

export const PHQ9: Screening = {
  key: PHQ9_KEY,
  version: 1,
  name: "Depression screening (PHQ-9)",
  short: "PHQ-9",
  title: l("Questions about your mood (PHQ-9)", "Preguntas sobre su estado de ánimo (PHQ-9)", "أسئلة عن حالتك المزاجية (PHQ-9)"),
  official: l("Patient Health Questionnaire-9 (PHQ-9)", "Cuestionario sobre la salud del paciente-9 (PHQ-9)", "استبيان حول صحة المريض-9 (PHQ-9)"),
  minutes: 2,
  stem: l(
    "Over the last 2 weeks, how often have you been bothered by any of the following problems?",
    "Durante las últimas 2 semanas, ¿qué tan seguido ha tenido molestias debido a los siguientes problemas?",
    "كم عانيت من المشاكل التالية خلال الأسبوعين الماضيين؟",
  ),
  items: [
    { id: "q1", text: l("Little interest or pleasure in doing things", "Poco interés o placer en hacer cosas", "قلة الاهتمام أو الاستمتاع بممارسة الأشياء.") },
    { id: "q2", text: l("Feeling down, depressed, or hopeless", "Se ha sentido decaído(a), deprimido(a) o sin esperanzas", "الشعور بالحزن أو ضيق الصدر أو اليأس.") },
    { id: "q3", text: l("Trouble falling or staying asleep, or sleeping too much", "Ha tenido dificultad para quedarse o permanecer dormido(a), o ha dormido demasiado", "الصعوبة في الركون إلى النوم أو النوم بانتظام أو النوم أكثر من العادة.") },
    { id: "q4", text: l("Feeling tired or having little energy", "Se ha sentido cansado(a) o con poca energía", "الشعور بالتعب أو بقلة الحيوية.") },
    { id: "q5", text: l("Poor appetite or overeating", "Sin apetito o ha comido en exceso", "قلة الشهية أو كثرة الأكل.") },
    { id: "q6", text: l(
      "Feeling bad about yourself — or that you are a failure or have let yourself or your family down",
      "Se ha sentido mal con usted mismo(a) – o que es un fracaso o que ha quedado mal con usted mismo(a) o con su familia",
      "الشعور بعدم الرضا عن النفس أو بالفشل أو الإحباط تجاه ذويك.",
    ) },
    { id: "q7", text: l(
      "Trouble concentrating on things, such as reading the newspaper or watching television",
      "Ha tenido dificultad para concentrarse en ciertas actividades, tales como leer el periódico o ver la televisión",
      "الصعوبة في التركيز على الأشياء، مثل قراءة الصحف أو مشاهدة التليفزيون.",
    ) },
    { id: "q8", text: l(
      "Moving or speaking so slowly that other people could have noticed? Or the opposite — being so fidgety or restless that you have been moving around a lot more than usual",
      "¿Se ha movido o hablado tan lento que otras personas podrían haberlo notado? o lo contrario – muy inquieto(a) o agitado(a) que ha estado moviéndose mucho más de lo normal",
      "بطء في الحركة أو الكلام بدرجة ملحوظة من الآخرين؟ أو على العكس من ذلك كثرة التململ والتحرك إلى درجة فوق العادة.",
    ) },
    { id: "q9", text: l(
      "Thoughts that you would be better off dead or of hurting yourself in some way",
      "Pensamientos de que estaría mejor muerto(a) o de lastimarse de alguna manera",
      "الشعور بتفضيل الموت عن الحياة أو بإيذاء النفس بطريقة ما.",
    ) },
  ],
  options: OPTIONS,
  difficulty: {
    question: l(
      "If you checked off any problems, how difficult have these problems made it for you to do your work, take care of things at home, or get along with other people?",
      "Si marcó cualquiera de los problemas, ¿qué tanta dificultad le han dado estos problemas para hacer su trabajo, encargarse de las tareas del hogar, o llevarse bien con otras personas?",
      "إذا حددت أي مشاكل، إلى أي مدى منعتك هذه المشاكل من القيام بعملك أو الاعتناء بشؤونك المنزلية أو التعامل مع الناس؟",
    ),
    options: [
      l("Not difficult at all", "No ha sido difícil", "غير صعب بالمرة"),
      l("Somewhat difficult", "Un poco difícil", "صعب نوعا ما"),
      l("Very difficult", "Muy difícil", "صعب جدا"),
      l("Extremely difficult", "Extremadamente difícil", "صعب للغاية"),
    ],
  },
  bands: [
    { min: 0, max: 4, label: "Minimal or none" },
    { min: 5, max: 9, label: "Mild" },
    { min: 10, max: 14, label: "Moderate" },
    { min: 15, max: 19, label: "Moderately severe" },
    { min: 20, max: 27, label: "Severe" },
  ],
  cutoff: 10,
  riskItem: "q9",
  credit: CREDIT,
};

export const GAD7: Screening = {
  key: GAD7_KEY,
  version: 1,
  name: "Anxiety screening (GAD-7)",
  short: "GAD-7",
  title: l("Questions about worry (GAD-7)", "Preguntas sobre preocupación y nervios (GAD-7)", "أسئلة عن القلق (GAD-7)"),
  official: l("GAD-7", "GAD-7", "GAD-7"),
  minutes: 2,
  stem: l(
    "Over the last 2 weeks, how often have you been bothered by the following problems?",
    "Durante las últimas 2 semanas, ¿qué tan seguido ha tenido molestias debido a los siguientes problemas?",
    "خلال الأسبوعين الماضيين، كم مرّة أقلقتك المشاكل التّالية؟",
  ),
  items: [
    { id: "q1", text: l("Feeling nervous, anxious or on edge", "Se ha sentido nervioso(a), ansioso(a) o con los nervios de punta", "الشعور بالغضب أو القلق أو الانفعال الشديد.") },
    { id: "q2", text: l("Not being able to stop or control worrying", "No ha sido capaz de parar o controlar su preocupación", "عدم القدرة على إنهاء القلق أو التحكّم فيه.") },
    { id: "q3", text: l("Worrying too much about different things", "Se ha preocupado demasiado por motivos diferentes", "القلق المفرط على أشياء مختلفة.") },
    { id: "q4", text: l("Trouble relaxing", "Ha tenido dificultad para relajarse", "الصعوبة في الاسترخاء.") },
    { id: "q5", text: l("Being so restless that it is hard to sit still", "Se ha sentido tan inquieto(a) que no ha podido quedarse quieto(a)", "شدة الاضطراب لدرجة صعوبة البقاء في هدوء.") },
    { id: "q6", text: l("Becoming easily annoyed or irritable", "Se ha molestado o irritado fácilmente", "السرعة في الانزعاج أو الانفعال.") },
    // "فضيعا" is how the published Arabic form spells it; kept as published.
    { id: "q7", text: l("Feeling afraid as if something awful might happen", "Ha tenido miedo de que algo terrible fuera a pasar", "الشّعور بالخوف كما لو أن شيئا فضيعا قد يحدث.") },
  ],
  options: OPTIONS,
  bands: [
    { min: 0, max: 4, label: "Minimal" },
    { min: 5, max: 9, label: "Mild" },
    { min: 10, max: 14, label: "Moderate" },
    { min: 15, max: 21, label: "Severe" },
  ],
  cutoff: 10,
  credit: CREDIT,
};

export const SCREENINGS: Screening[] = [PHQ9, GAD7];
export const screeningFor = (key: string | null | undefined): Screening | null => SCREENINGS.find((s) => s.key === key) ?? null;
export const isScreeningKey = (key: string | null | undefined) => !!screeningFor(key);

// ---- Answers and scoring ----

/** Item id → "0".."3" (points), plus "difficulty" → "0".."3" on the PHQ-9. */
export type ScreeningAnswers = Record<string, string>;
export const DIFFICULTY_ID = "difficulty";
const POINTS = ["0", "1", "2", "3"];

const pointsOf = (a: ScreeningAnswers, id: string) => (POINTS.includes(a[id] ?? "") ? Number(a[id]) : null);

/** Keep only this screening's questions with a valid answer (answers come from the public page). */
export function cleanScreeningAnswers(s: Screening, raw: unknown): ScreeningAnswers {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: ScreeningAnswers = {};
  for (const item of s.items) {
    const v = a[item.id];
    if (typeof v === "string" && POINTS.includes(v)) out[item.id] = v;
  }
  // The difficulty question only applies when a problem was checked.
  const total = s.items.reduce((n, item) => n + (pointsOf(out, item.id) ?? 0), 0);
  const d = a[DIFFICULTY_ID];
  if (s.difficulty && total > 0 && typeof d === "string" && POINTS.includes(d)) out[DIFFICULTY_ID] = d;
  return out;
}

export interface ScreeningResult {
  score: number;
  max: number;
  answered: number;
  complete: boolean;
  /** The published severity range the score falls in (only once every question is answered). */
  band: ScreeningBand | null;
  /** Score at or above the cutoff: worth a closer look by the provider. Not a diagnosis. */
  positive: boolean;
  /** The self-harm question was answered with anything above "Not at all". */
  risk: boolean;
  /** Points on the self-harm question (0-3), or null when this screening has none / it is blank. */
  riskPoints: number | null;
  /** Whether the difficulty question is asked (PHQ-9, and only when some problem was checked). */
  asksDifficulty: boolean;
  /** 0-3, or null when not asked / blank. */
  difficulty: number | null;
}

export function screeningResult(s: Screening, a: ScreeningAnswers): ScreeningResult {
  let score = 0, answered = 0;
  for (const item of s.items) {
    const p = pointsOf(a, item.id);
    if (p == null) continue;
    score += p;
    answered++;
  }
  const complete = answered === s.items.length;
  const riskPoints = s.riskItem ? pointsOf(a, s.riskItem) : null;
  return {
    score, max: s.items.length * 3, answered, complete,
    band: complete ? s.bands.find((b) => score >= b.min && score <= b.max) ?? null : null,
    positive: complete && score >= s.cutoff,
    risk: (riskPoints ?? 0) > 0,
    riskPoints,
    asksDifficulty: !!s.difficulty && score > 0,
    difficulty: s.difficulty && score > 0 ? pointsOf(a, DIFFICULTY_ID) : null,
  };
}

/** Questions still blank, in order (the difficulty question counts once a problem was checked). */
export function screeningMissing(s: Screening, a: ScreeningAnswers): string[] {
  const out = s.items.filter((item) => pointsOf(a, item.id) == null).map((item) => item.id);
  const r = screeningResult(s, a);
  if (r.asksDifficulty && r.difficulty == null) out.push(DIFFICULTY_ID);
  return out;
}

/** "12 of 27 · Moderate (10–14)" for staff. */
export function screeningSummary(s: Screening, r: ScreeningResult) {
  return `${r.score} of ${r.max}${r.band ? ` · ${r.band.label} (${r.band.min}–${r.band.max})` : ""}`;
}

/** How a screening was sent in (no signature is asked for these): stored in the signature record's "method". */
export const SCREENING_METHOD = "sent";

// ---- Our own wording around the screenings (patient page) ----

export const SCREENING_INTRO = l(
  "There are no right or wrong answers. Your answers go to your care team at MyPCP Dr.",
  "No hay respuestas correctas ni incorrectas. Sus respuestas llegan a su equipo de atención en MyPCP Dr.",
  "لا توجد إجابات صحيحة أو خاطئة. تصل إجاباتك إلى فريق رعايتك في MyPCP Dr.",
);
/** Shown at the start of every screening: nobody is reading the answers as they come in. */
export const SCREENING_NOT_LIVE = l(
  "This form is not watched live. If you are in danger, or thinking about hurting yourself, call or text 988 (free, 24 hours a day) or call 911.",
  "Nadie revisa este formulario en tiempo real. Si está en peligro o piensa en hacerse daño, llame o envíe un mensaje de texto al 988 (gratis, las 24 horas) o llame al 911.",
  "لا أحد يراقب هذا النموذج لحظة بلحظة. إذا كنت في خطر أو تفكّر في إيذاء نفسك، اتصل أو أرسل رسالة نصية إلى 988 (مجانًا، على مدار 24 ساعة) أو اتصل بالرقم 911.",
);
/** Shown as soon as the self-harm question gets any answer above "Not at all", and again after sending. */
export const RISK_NOTE = {
  title: l("You are not alone. Help is available right now.", "No está solo(a). Hay ayuda disponible ahora mismo.", "لست وحدك. المساعدة متوفرة الآن."),
  body: l(
    "Call or text 988 to talk with someone at the Suicide & Crisis Lifeline. It is free and open 24 hours a day. If you are in danger, call 911.",
    "Llame o envíe un mensaje de texto al 988 para hablar con alguien de la Línea de Prevención del Suicidio y Crisis. Es gratis y atiende las 24 horas (para español, oprima 2). Si está en peligro, llame al 911.",
    "اتصل أو أرسل رسالة نصية إلى 988 للتحدث مع شخص في خط الأزمات ومنع الانتحار. الخدمة مجانية ومتاحة على مدار 24 ساعة. إذا كنت في خطر، اتصل بالرقم 911.",
  ),
  followUp: l(
    "Our office will see your answer and contact you. That may not be right away, so if you need help now, please call 988 or 911.",
    "Nuestra oficina verá su respuesta y se comunicará con usted. Puede que no sea de inmediato; si necesita ayuda ahora, llame al 988 o al 911.",
    "سيرى مكتبنا إجابتك وسيتواصل معك. قد لا يكون ذلك فورًا، فإذا احتجت إلى المساعدة الآن، يُرجى الاتصال بالرقم 988 أو 911.",
  ),
  call988: l("Call 988", "Llamar al 988", "اتصل بـ 988"),
  call911: l("Call 911", "Llamar al 911", "اتصل بـ 911"),
};
