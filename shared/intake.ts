// Patient forms (replaces BoldSign for intake): a built-in health-history questionnaire plus
// agreements/consents whose wording an admin pastes into MyPCP (Form library). Patients open a
// private link, confirm their date of birth, fill everything in on their phone and sign.
// Shared by the server (validation, hashing) and both UIs (patient page, staff page).

export const INTAKE_LANGS = ["en", "es", "ar"] as const;
export type IntakeLang = (typeof INTAKE_LANGS)[number];
export const LANG_LABELS: Record<IntakeLang, string> = { en: "English", es: "Español", ar: "العربية" };
export const langDir = (l: string) => (l === "ar" ? "rtl" : "ltr");
export const isIntakeLang = (l: unknown): l is IntakeLang => typeof l === "string" && (INTAKE_LANGS as readonly string[]).includes(l);
/** A patient's preferred-language field ("Spanish", "Español", "Arabic"…) → the form language. */
export function langFromPreferred(s: string | null | undefined): IntakeLang {
  const v = (s ?? "").toLowerCase();
  if (/span|espa/.test(v)) return "es";
  if (/arab|عرب/.test(v)) return "ar";
  return "en";
}

export type L10n = Record<IntakeLang, string>;
export const tr = (t: L10n | Partial<L10n> | undefined, lang: string) => (t ? (t as Record<string, string | undefined>)[lang] || t.en || "" : "");

export const PACKET_STATUSES = ["waiting", "opened", "in_progress", "completed", "filed", "cancelled"] as const;
export type PacketStatus = (typeof PACKET_STATUSES)[number];
export const PACKET_STATUS_LABELS: Record<PacketStatus, string> = {
  waiting: "Not opened yet",
  opened: "Opened",
  in_progress: "In progress",
  completed: "Done: file in Practice Fusion",
  filed: "Filed",
  cancelled: "Cancelled",
};
export const OPEN_PACKET: PacketStatus[] = ["waiting", "opened", "in_progress"];
export const PACKET_EXPIRY_DAYS = 14;

export const MEDICAL_INTAKE_KEY = "medical_intake";
export const docKey = (id: number) => `doc:${id}`;
export const docIdOf = (key: string) => (/^doc:\d+$/.test(key) ? Number(key.slice(4)) : null);

export const PHOTO_KINDS = ["insurance_front", "insurance_back", "photo_id"] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

export type FieldType = "text" | "textarea" | "phone" | "email" | "zip" | "choice" | "multi" | "list" | "photo";
export interface IntakeOption { value: string; label: L10n }
export interface IntakeField {
  id: string;
  type: FieldType;
  label: L10n;
  hint?: L10n;
  required?: boolean;
  options?: IntakeOption[];
  /** multi: picking one of these clears the others (e.g. "None of these"). */
  exclusive?: string[];
  columns?: { id: string; label: L10n; required?: boolean }[];
  showIf?: { field: string; in: string[] };
  prefill?: "name" | "phone" | "email";
  photo?: PhotoKind;
}
export interface IntakeSection { id: string; title: L10n; intro?: L10n; fields: IntakeField[] }
export interface Questionnaire { key: string; version: number; title: L10n; minutes: number; sections: IntakeSection[]; attestation: L10n }

const o = (value: string, en: string, es: string, ar: string): IntakeOption => ({ value, label: { en, es, ar } });
const l = (en: string, es: string, ar: string): L10n => ({ en, es, ar });

export const MEDICAL_INTAKE: Questionnaire = {
  key: MEDICAL_INTAKE_KEY,
  version: 1,
  title: l("Health history form", "Formulario de historial médico", "نموذج التاريخ الصحي"),
  minutes: 8,
  attestation: l(
    "The information I gave is true and complete to the best of my knowledge. I will tell the clinic if anything changes.",
    "La información que di es verdadera y completa según mi mejor conocimiento. Le avisaré a la clínica si algo cambia.",
    "المعلومات التي قدّمتها صحيحة وكاملة على حدّ علمي، وسأُبلغ العيادة إذا تغيّر أي شيء.",
  ),
  sections: [
    {
      id: "about", title: l("About you", "Sobre usted", "معلومات عنك"),
      fields: [
        { id: "fullName", type: "text", required: true, prefill: "name", label: l("Full legal name", "Nombre legal completo", "الاسم القانوني الكامل") },
        { id: "preferredName", type: "text", label: l("Name you like to be called (optional)", "Nombre que prefiere que le digamos (opcional)", "الاسم الذي تفضّل أن نناديك به (اختياري)") },
        { id: "sex", type: "choice", label: l("Sex", "Sexo", "الجنس"), options: [
          o("female", "Female", "Femenino", "أنثى"), o("male", "Male", "Masculino", "ذكر"), o("other", "Other / prefer not to say", "Otro / prefiero no decir", "آخر / أفضّل عدم الإجابة"),
        ] },
        { id: "phone", type: "phone", required: true, prefill: "phone", label: l("Best phone number", "Mejor número de teléfono", "أفضل رقم هاتف للتواصل") },
        { id: "email", type: "email", prefill: "email", label: l("Email (optional)", "Correo electrónico (opcional)", "البريد الإلكتروني (اختياري)") },
        { id: "street", type: "text", required: true, label: l("Street address", "Dirección", "عنوان الشارع") },
        { id: "city", type: "text", required: true, label: l("City", "Ciudad", "المدينة") },
        { id: "zip", type: "zip", required: true, label: l("ZIP code", "Código postal", "الرمز البريدي") },
      ],
    },
    {
      id: "contacts", title: l("Emergency contact & pharmacy", "Contacto de emergencia y farmacia", "جهة اتصال للطوارئ والصيدلية"),
      fields: [
        { id: "ecName", type: "text", label: l("Emergency contact name", "Nombre del contacto de emergencia", "اسم الشخص الذي نتصل به في حالة الطوارئ") },
        { id: "ecRelation", type: "text", label: l("Relationship to you", "Parentesco con usted", "صلة القرابة بك") },
        { id: "ecPhone", type: "phone", label: l("Their phone number", "Su número de teléfono", "رقم هاتفه") },
        { id: "pharmacy", type: "text", label: l("Your pharmacy (name and street or city)", "Su farmacia (nombre y calle o ciudad)", "الصيدلية التي تتعامل معها (الاسم والشارع أو المدينة)"),
          hint: l("Example: CVS on Westheimer", "Ejemplo: CVS en Westheimer", "مثال: CVS في شارع Westheimer") },
      ],
    },
    {
      id: "insurance", title: l("Insurance", "Seguro médico", "التأمين الصحي"),
      intro: l("You can skip the photos and bring your cards to your visit.", "Puede omitir las fotos y traer sus tarjetas a su cita.", "يمكنك تخطي الصور وإحضار بطاقاتك معك إلى الموعد."),
      fields: [
        { id: "hasInsurance", type: "choice", required: true, label: l("Do you have health insurance?", "¿Tiene seguro médico?", "هل لديك تأمين صحي؟"), options: [
          o("yes", "Yes, I have insurance", "Sí, tengo seguro", "نعم، لدي تأمين صحي"), o("no", "No, I'll pay myself", "No, pagaré por mi cuenta", "لا، سأدفع بنفسي"),
        ] },
        { id: "insuranceName", type: "text", showIf: { field: "hasInsurance", in: ["yes"] }, label: l("Insurance company or plan", "Compañía o plan de seguro", "شركة التأمين أو الخطة"),
          hint: l("Example: Medicare, Humana, Blue Cross", "Ejemplo: Medicare, Humana, Blue Cross", "مثال: Medicare أو Humana أو Blue Cross") },
        { id: "memberId", type: "text", showIf: { field: "hasInsurance", in: ["yes"] }, label: l("Member ID (on your card)", "Número de miembro (en su tarjeta)", "رقم العضوية (مكتوب على بطاقتك)") },
        { id: "cardFront", type: "photo", photo: "insurance_front", showIf: { field: "hasInsurance", in: ["yes"] }, label: l("Photo of the FRONT of your insurance card", "Foto del FRENTE de su tarjeta de seguro", "صورة الوجه الأمامي لبطاقة التأمين") },
        { id: "cardBack", type: "photo", photo: "insurance_back", showIf: { field: "hasInsurance", in: ["yes"] }, label: l("Photo of the BACK of your insurance card", "Foto del REVERSO de su tarjeta de seguro", "صورة الوجه الخلفي لبطاقة التأمين") },
        { id: "photoId", type: "photo", photo: "photo_id", label: l("Photo of your driver's license or ID (optional)", "Foto de su licencia de conducir o identificación (opcional)", "صورة رخصة القيادة أو بطاقة الهوية (اختياري)") },
      ],
    },
    {
      id: "health", title: l("Your health", "Su salud", "صحتك"),
      fields: [
        { id: "conditions", type: "multi", exclusive: ["none"], label: l("Do you have any of these? Tap all that apply.", "¿Tiene alguna de estas condiciones? Toque todas las que apliquen.", "هل لديك أيّ من هذه الحالات؟ اضغط على كل ما ينطبق عليك."), options: [
          o("diabetes", "Diabetes", "Diabetes", "السكري"),
          o("hypertension", "High blood pressure", "Presión alta", "ارتفاع ضغط الدم"),
          o("cholesterol", "High cholesterol", "Colesterol alto", "ارتفاع الكوليسترول"),
          o("heart", "Heart disease", "Enfermedad del corazón", "أمراض القلب"),
          o("stroke", "Stroke", "Derrame cerebral", "سكتة دماغية"),
          o("lung", "Asthma or COPD", "Asma o EPOC", "الربو أو الانسداد الرئوي المزمن"),
          o("kidney", "Kidney disease", "Enfermedad de los riñones", "أمراض الكلى"),
          o("thyroid", "Thyroid problems", "Problemas de tiroides", "مشاكل الغدة الدرقية"),
          o("arthritis", "Arthritis", "Artritis", "التهاب المفاصل"),
          o("mood", "Depression or anxiety", "Depresión o ansiedad", "الاكتئاب أو القلق"),
          o("cancer", "Cancer", "Cáncer", "السرطان"),
          o("none", "None of these", "Ninguna de estas", "لا شيء مما سبق"),
        ] },
        { id: "otherConditions", type: "textarea", label: l("Any other ongoing health conditions? (optional)", "¿Alguna otra condición de salud continua? (opcional)", "هل لديك أي حالات صحية مزمنة أخرى؟ (اختياري)") },
        { id: "surgeries", type: "textarea", label: l("Past surgeries or major medical events, with the approximate date (optional)", "Cirugías o eventos médicos importantes anteriores, con la fecha aproximada (opcional)", "العمليات الجراحية أو الأحداث الطبية الكبرى السابقة، مع التاريخ التقريبي (اختياري)"),
          hint: l("Example: knee surgery 2019", "Ejemplo: cirugía de rodilla 2019", "مثال: عملية في الركبة 2019") },
        { id: "pregnancy", type: "choice", label: l("Pregnancy status (if it applies)", "Estado de embarazo (si aplica)", "حالة الحمل (إن كانت تنطبق)"), options: [
          o("not_pregnant", "Not pregnant", "No estoy embarazada", "لستُ حاملًا"), o("pregnant", "Pregnant", "Embarazada", "حامل"),
          o("unsure", "Not sure", "No estoy segura", "لستُ متأكدة"), o("na", "Doesn't apply to me", "No aplica", "لا ينطبق عليّ"),
        ] },
        { id: "devices", type: "choice", label: l("Do you have any implanted medical devices (like a pacemaker or insulin pump)?", "¿Tiene algún dispositivo médico implantado (como un marcapasos o una bomba de insulina)?", "هل لديك أي جهاز طبي مزروع (مثل منظّم ضربات القلب أو مضخة الأنسولين)؟"), options: [
          o("no", "No", "No", "لا"), o("yes", "Yes", "Sí", "نعم"),
        ] },
        { id: "deviceWhich", type: "text", showIf: { field: "devices", in: ["yes"] }, label: l("Which device?", "¿Qué dispositivo?", "ما هو الجهاز؟") },
      ],
    },
    {
      id: "medications", title: l("Your medicines", "Sus medicamentos", "أدويتك"),
      fields: [
        { id: "medsMode", type: "choice", required: true, label: l("Tell us about the medicines you take", "Díganos qué medicamentos toma", "أخبرنا عن الأدوية التي تتناولها"),
          hint: l("Include prescriptions, over-the-counter medicines, vitamins and supplements.", "Incluya recetas, medicinas sin receta, vitaminas y suplementos.", "اذكر الأدوية الموصوفة، والأدوية التي تُصرف دون وصفة، والفيتامينات والمكمّلات."), options: [
          o("list", "I'll list them here", "Los voy a escribir aquí", "سأكتبها هنا"),
          o("bring", "I'll bring my medicine bottles to my visit", "Traeré mis frascos de medicina a mi cita", "سأُحضر علب أدويتي معي إلى الموعد"),
          o("none", "I don't take any medicines", "No tomo ningún medicamento", "لا أتناول أي أدوية"),
        ] },
        { id: "meds", type: "list", showIf: { field: "medsMode", in: ["list"] }, label: l("Your medicines", "Sus medicamentos", "أدويتك"), columns: [
          { id: "name", required: true, label: l("Medicine name", "Nombre del medicamento", "اسم الدواء") },
          { id: "dose", label: l("How much and how often (optional)", "Cuánto y cada cuándo (opcional)", "الجرعة وعدد المرات (اختياري)") },
        ] },
      ],
    },
    {
      id: "allergies", title: l("Allergies", "Alergias", "الحساسية"),
      fields: [
        { id: "allergyMode", type: "choice", required: true, label: l("Are you allergic to any medicines, foods, or other things (like pollen or latex)?", "¿Es alérgico a algún medicamento, comida u otra cosa (como polen o látex)?", "هل لديك حساسية من أي دواء أو طعام أو أشياء أخرى (مثل حبوب اللقاح أو اللاتكس)؟"), options: [
          o("none", "No allergies that I know of", "No tengo alergias que yo sepa", "ليس لدي حساسية على حدّ علمي"),
          o("yes", "Yes, I have allergies", "Sí, tengo alergias", "نعم، لدي حساسية"),
        ] },
        { id: "allergies", type: "list", showIf: { field: "allergyMode", in: ["yes"] }, label: l("Your allergies", "Sus alergias", "أنواع الحساسية لديك"), columns: [
          { id: "allergy", required: true, label: l("Allergic to (medicine, food, pollen…)", "Alérgico a (medicina, comida, polen…)", "الحساسية من (دواء، طعام، حبوب اللقاح…)") },
          { id: "reaction", label: l("What happens (optional)", "Qué le pasa (opcional)", "ماذا يحدث لك (اختياري)") },
        ] },
      ],
    },
    {
      id: "family", title: l("Family & habits", "Familia y hábitos", "العائلة والعادات"),
      fields: [
        { id: "familyHistory", type: "multi", exclusive: ["unknown"], label: l("Do your parents, brothers or sisters have any of these?", "¿Sus padres o hermanos tienen alguna de estas condiciones?", "هل يعاني أحد والديك أو إخوتك من أيّ مما يلي؟"), options: [
          o("diabetes", "Diabetes", "Diabetes", "السكري"),
          o("heart", "Heart disease", "Enfermedad del corazón", "أمراض القلب"),
          o("hypertension", "High blood pressure", "Presión alta", "ارتفاع ضغط الدم"),
          o("stroke", "Stroke", "Derrame cerebral", "سكتة دماغية"),
          o("cancer", "Cancer", "Cáncer", "السرطان"),
          o("unknown", "None / I don't know", "Ninguna / No sé", "لا شيء / لا أعرف"),
        ] },
        { id: "familyMother", type: "textarea", label: l("Mother's side: other health problems in the family (optional)", "Lado de su madre: otros problemas de salud en la familia (opcional)", "من جهة الأم: مشاكل صحية أخرى في العائلة (اختياري)") },
        { id: "familyFather", type: "textarea", label: l("Father's side: other health problems in the family (optional)", "Lado de su padre: otros problemas de salud en la familia (opcional)", "من جهة الأب: مشاكل صحية أخرى في العائلة (اختياري)") },
        { id: "tobacco", type: "choice", label: l("Do you use tobacco or vape?", "¿Usa tabaco o vapea?", "هل تستخدم التبغ أو السجائر الإلكترونية؟"), options: [
          o("no", "No", "No", "لا"), o("yes", "Yes", "Sí", "نعم"),
        ] },
        { id: "tobaccoType", type: "text", showIf: { field: "tobacco", in: ["yes"] }, label: l("What kind? (cigarettes, vaping, chewing tobacco…)", "¿De qué tipo? (cigarrillos, vapeo, tabaco de mascar…)", "ما النوع؟ (سجائر، سجائر إلكترونية، تبغ للمضغ…)") },
      ],
    },
    {
      id: "visit", title: l("Your visit", "Su cita", "زيارتك"),
      intro: l(
        "If you've had any recent lab work, imaging, ER or urgent care visits, or specialist appointments, please bring those records to your visit or email them to care@mypcpdr.com.",
        "Si recientemente tuvo análisis de laboratorio, estudios de imagen, visitas a emergencias o urgencias, o citas con especialistas, por favor traiga esos documentos a su cita o envíelos a care@mypcpdr.com.",
        "إذا أجريت مؤخرًا تحاليل مخبرية أو صورًا طبية، أو زرت الطوارئ أو الرعاية العاجلة أو طبيبًا مختصًا، يرجى إحضار هذه السجلات إلى موعدك أو إرسالها إلى care@mypcpdr.com.",
      ),
      fields: [
        { id: "reason", type: "textarea", label: l("What would you like help with at your visit? (optional)", "¿En qué le gustaría que le ayudemos en su cita? (opcional)", "بماذا تودّ أن نساعدك في زيارتك؟ (اختياري)") },
        { id: "height", type: "text", label: l("Height (video visits only)", "Estatura (solo citas por video)", "الطول (لزيارات الفيديو فقط)"),
          hint: l("If your visit is in the office, leave this blank; we'll measure you there.", "Si su cita es en la clínica, déjelo en blanco; la mediremos allí.", "إذا كانت زيارتك في العيادة، اترك هذا فارغًا؛ سنقيسه هناك.") },
        { id: "weight", type: "text", label: l("Weight (video visits only)", "Peso (solo citas por video)", "الوزن (لزيارات الفيديو فقط)") },
      ],
    },
  ],
};

// ---- Answers ----

export type ListRow = Record<string, string>;
export type AnswerValue = string | string[] | ListRow[];
export type Answers = Record<string, AnswerValue>;

export function isVisible(f: IntakeField, a: Answers) {
  if (!f.showIf) return true;
  const v = a[f.showIf.field];
  return typeof v === "string" && f.showIf.in.includes(v);
}

const filled = (f: IntakeField, v: AnswerValue | undefined) => {
  if (v == null) return false;
  if (f.type === "list") return Array.isArray(v) && (v as ListRow[]).some((r) => f.columns!.filter((c) => c.required).every((c) => (r[c.id] ?? "").trim()));
  if (Array.isArray(v)) return v.length > 0;
  return String(v).trim().length > 0;
};

/** Required questions in one section that are still blank (hidden ones don't count). */
export function missingInSection(s: IntakeSection, a: Answers) {
  const out: string[] = [];
  for (const f of s.fields) {
    if (!isVisible(f, a)) continue;
    // A "list them" choice needs at least one row.
    const needsRows = f.type === "list";
    if ((f.required || needsRows) && !filled(f, a[f.id])) out.push(f.id);
    else if (f.type === "phone" && a[f.id] && String(a[f.id]).replace(/\D/g, "").length < 10) out.push(f.id);
    else if (f.type === "email" && a[f.id] && !/^\S+@\S+\.\S+$/.test(String(a[f.id]).trim())) out.push(f.id);
    else if (f.type === "zip" && a[f.id] && !/^\d{5}(-?\d{4})?$/.test(String(a[f.id]).trim())) out.push(f.id);
  }
  return out;
}
export const missingRequired = (q: Questionnaire, a: Answers) => q.sections.flatMap((s) => missingInSection(s, a));

/** Keep only known questions, trimmed and size-limited (answers come from the public page). */
export function cleanAnswers(q: Questionnaire, raw: unknown): Answers {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Answers = {};
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max) : "");
  for (const s of q.sections) for (const f of s.fields) {
    const v = a[f.id];
    if (v == null || f.type === "photo") continue;
    if (f.type === "multi") {
      if (Array.isArray(v)) out[f.id] = v.filter((x) => typeof x === "string" && f.options!.some((opt) => opt.value === x)).slice(0, 30) as string[];
    } else if (f.type === "choice") {
      if (typeof v === "string" && f.options!.some((opt) => opt.value === v)) out[f.id] = v;
    } else if (f.type === "list") {
      if (Array.isArray(v)) out[f.id] = v.slice(0, 40).map((r) => Object.fromEntries(f.columns!.map((c) => [c.id, str((r as Record<string, unknown>)?.[c.id], 200)])));
    } else {
      out[f.id] = str(v, f.type === "textarea" ? 2000 : 200);
    }
  }
  return out;
}

/** An answer as plain English text, for the staff view and the printed copy. */
export function answerText(f: IntakeField, v: AnswerValue | undefined, lang: string = "en"): string {
  if (v == null || (Array.isArray(v) && !v.length) || v === "") return "";
  if (f.type === "choice") return tr(f.options!.find((x) => x.value === v)?.label, lang) || String(v);
  if (f.type === "multi") return (v as string[]).map((x) => tr(f.options!.find((y) => y.value === x)?.label, lang) || x).join(", ");
  if (f.type === "list") return (v as ListRow[]).filter((r) => Object.values(r).some((x) => x.trim())).map((r) => f.columns!.map((c) => r[c.id]?.trim()).filter(Boolean).join(" — ")).join("\n");
  return String(v);
}

// ---- Agreements (Form library) ----

export interface AgreementText { title: Partial<L10n>; body: Partial<L10n> }
/** The wording in the patient's language, or English when that language wasn't pasted in. */
export function agreementIn(doc: AgreementText, lang: string): { title: string; body: string; lang: IntakeLang } {
  const has = (x: string) => !!(doc.body as Record<string, string | undefined>)[x]?.trim();
  const use: IntakeLang = isIntakeLang(lang) && has(lang) ? lang : "en";
  return { title: tr(doc.title, use), body: (doc.body as Record<string, string>)[use] ?? "", lang: use };
}

export type Block = { kind: "heading" | "para" | "bullets"; text: string; items?: string[] };
/** Pasted wording → headings ("# …"), bullet lists ("- …" / "• …") and paragraphs (blank-line separated). */
export function textBlocks(body: string): Block[] {
  const out: Block[] = [];
  for (const chunk of body.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const lines = chunk.split("\n").map((x) => x.trimEnd()).filter((x) => x.trim());
    if (!lines.length) continue;
    if (lines.length === 1 && /^#{1,3}\s+/.test(lines[0]!)) { out.push({ kind: "heading", text: lines[0]!.replace(/^#{1,3}\s+/, "") }); continue; }
    if (lines.every((x) => /^\s*[-•*]\s+/.test(x))) { out.push({ kind: "bullets", text: "", items: lines.map((x) => x.replace(/^\s*[-•*]\s+/, "")) }); continue; }
    if (/^#{1,3}\s+/.test(lines[0]!)) { out.push({ kind: "heading", text: lines[0]!.replace(/^#{1,3}\s+/, "") }); lines.shift(); }
    out.push({ kind: "para", text: lines.join("\n") });
  }
  return out;
}

// ---- Signing ----

export const SIGNER_RELATIONS = ["self", "spouse", "child", "parent", "caregiver", "guardian", "other"] as const;
export type SignerRelation = (typeof SIGNER_RELATIONS)[number];
export const RELATION_LABELS: Record<SignerRelation, L10n> = {
  self: l("Myself", "Yo mismo(a)", "أنا"),
  spouse: l("Spouse or partner", "Esposo(a) o pareja", "الزوج / الزوجة"),
  child: l("Son or daughter", "Hijo o hija", "الابن / الابنة"),
  parent: l("Parent", "Padre o madre", "الأب / الأم"),
  caregiver: l("Caregiver", "Cuidador(a)", "مقدّم الرعاية"),
  guardian: l("Legal guardian", "Tutor legal", "الوصي القانوني"),
  other: l("Other", "Otro", "آخر"),
};
export const ESIGN_CONSENT: L10n = l(
  "I agree that typing or drawing my name here is my electronic signature, just like signing on paper.",
  "Acepto que escribir o dibujar mi nombre aquí es mi firma electrónica, igual que firmar en papel.",
  "أوافق على أن كتابة اسمي أو رسمه هنا يُعدّ توقيعي الإلكتروني، تمامًا مثل التوقيع على الورق.",
);

/** Saying no to a consent is recorded too (CMS asks practices to document "accepted or declined"). */
export const DECLINE_CONSENT: L10n = l(
  "I choose NOT to agree to this form. Typing my name records my choice.",
  "Elijo NO aceptar este formulario. Escribir mi nombre registra mi decisión.",
  "أختار عدم الموافقة على هذا النموذج. كتابة اسمي تُسجّل قراري.",
);
export type SignDecision = "signed" | "declined";

// ---- Consents: forms whose answer MyPCP records on the patient (they may agree or decline) ----

export const CONSENT_KINDS = ["communications", "ccm", "bhi", "apcm"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];
export const isConsentKind = (k: unknown): k is ConsentKind => typeof k === "string" && (CONSENT_KINDS as readonly string[]).includes(k);
export const CONSENT_LABELS: Record<ConsentKind, string> = {
  communications: "Texts, calls & email",
  ccm: "Chronic Care Management (CCM)",
  bhi: "Behavioral Health Integration (BHI)",
  apcm: "Advanced Primary Care Management (APCM)",
};

// ---- Answering for someone else: only a legal representative may agree (or decline) for the patient ----

export const SIGNER_AUTHORITIES = ["poa", "guardian", "parent_minor", "other"] as const;
export type SignerAuthority = (typeof SIGNER_AUTHORITIES)[number];
export const AUTHORITY_LABELS: Record<SignerAuthority, L10n> = {
  poa: l("I have their medical power of attorney", "Tengo un poder legal para las decisiones médicas del paciente", "لديّ توكيل طبي رسمي عن المريض"),
  guardian: l("I am their court-appointed guardian", "Soy su tutor(a) legal nombrado(a) por un tribunal", "أنا الوصي القانوني على المريض بقرار من المحكمة"),
  parent_minor: l("I am the parent of a patient under 18", "Soy el padre o la madre de un paciente menor de 18 años", "أنا أحد والدَي مريض عمره أقل من 18 سنة"),
  other: l("Another legal reason (please explain)", "Otra razón legal (explique)", "سبب قانوني آخر (يرجى التوضيح)"),
};
/** Agreements need the signer's legal authority when someone other than the patient answers; the health history doesn't. */
export const needsAuthority = (formKey: string, relation: string) => formKey !== MEDICAL_INTAKE_KEY && relation !== "self";

// ---- Open website links (mypcpcare.com/sign/<slug>) ----

export const PUBLIC_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** A website visitor's session: long enough to read, sign and save a copy. */
export const WEBSITE_PACKET_HOURS = 24;
export const PACKET_SOURCES = ["staff", "website"] as const;
export type PacketSource = (typeof PACKET_SOURCES)[number];

/** Deterministic JSON (sorted keys) so the same content always hashes the same. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Date of birth typed as month / day / year → YYYY-MM-DD (null when it isn't a real date). */
export function dobFromParts(m: string | number, d: string | number, y: string | number): string | null {
  const mm = Number(m), dd = Number(d), yy = Number(y);
  if (!Number.isInteger(mm) || !Number.isInteger(dd) || !Number.isInteger(yy) || yy < 1900 || yy > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  if (dt.getUTCMonth() !== mm - 1) return null;
  return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** The text message / email wording. No health details: just the link and how to reach us. */
export function inviteText(lang: string, link: string, clinicPhone: string | null) {
  const phone = clinicPhone ? formatUsPhone(clinicPhone) : null;
  if (lang === "es") return `MyPCP Dr: Por favor llene sus formularios antes de su cita (unos 10 minutos): ${link}${phone ? ` ¿Preguntas? Llame al ${phone}` : ""}`;
  if (lang === "ar") return `MyPCP Dr: يرجى تعبئة النماذج قبل موعدك (حوالي 10 دقائق): ${link}${phone ? ` للاستفسار اتصل على ${phone}` : ""}`;
  return `MyPCP Dr: Please fill out your forms before your visit (about 10 minutes): ${link}${phone ? ` Questions? Call ${phone}` : ""}`;
}
export function formatUsPhone(p: string) {
  const d = p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}
