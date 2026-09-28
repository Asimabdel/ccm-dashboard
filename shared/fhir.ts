// Practice Fusion chart (FHIR R4) → what MyPCP shows. Pure helpers shared by the sync (server)
// and the Chart tab (client). Everything here is read-only: Practice Fusion stays the record.

/** Resource types the Chart shows, grouped into sections. */
export const CHART_SECTIONS = {
  problems: { label: "Problems", types: ["Condition"], full: true },
  medications: { label: "Medications", types: ["MedicationRequest", "MedicationStatement"], full: true },
  allergies: { label: "Allergies", types: ["AllergyIntolerance"], full: false },
  labs: { label: "Labs", types: ["Observation:laboratory"], full: true },
  vitals: { label: "Vitals", types: ["Observation:vital-signs"], full: true },
  otherObs: { label: "Other observations", types: ["Observation:other"], full: true },
  reports: { label: "Reports", types: ["DiagnosticReport"], full: true },
  immunizations: { label: "Immunizations", types: ["Immunization"], full: true },
  procedures: { label: "Procedures", types: ["Procedure"], full: true },
  visits: { label: "Visits", types: ["Encounter"], full: false },
  notes: { label: "Notes & documents", types: ["DocumentReference"], full: true },
  careTeam: { label: "Care team", types: ["CareTeam"], full: true },
  goals: { label: "Goals & care plans", types: ["Goal", "CarePlan"], full: true },
  insurance: { label: "Insurance", types: ["Coverage"], full: false },
  devices: { label: "Devices", types: ["Device"], full: true },
} as const;
export type ChartSection = keyof typeof CHART_SECTIONS;

type Coding = { system?: string; code?: string; display?: string };
type CodeableConcept = { text?: string; coding?: Coding[] };
type Ref = { reference?: string; display?: string };
type Quantity = { value?: number; unit?: string; code?: string };
// A loose FHIR resource: only the fields we read.
export interface FhirResource {
  resourceType: string;
  id?: string;
  meta?: { lastUpdated?: string };
  [k: string]: unknown;
}

const cc = (c: unknown): string | null => {
  const x = c as CodeableConcept | undefined;
  if (!x) return null;
  return x.text?.trim() || x.coding?.find((k) => k.display)?.display?.trim() || x.coding?.[0]?.code || null;
};
const firstCode = (c: unknown): string | null => {
  const x = c as CodeableConcept | undefined;
  const k = x?.coding?.find((y) => y.code);
  return k ? `${k.system?.split("/").pop() ?? ""}|${k.code}`.slice(0, 80) : null;
};
const qty = (q: unknown): string | null => {
  const x = q as Quantity | undefined;
  if (x?.value == null) return null;
  const v = Math.round(x.value * 100) / 100;
  return `${v}${x.unit ? ` ${x.unit}` : x.code ? ` ${x.code}` : ""}`;
};
const ymd = (s: unknown): string | null => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : typeof s === "string" && /^\d{4}(-\d{2})?$/.test(s) ? `${s}${s.length === 4 ? "-01-01" : "-01"}` : null);
const period = (p: unknown) => (p as { start?: string } | undefined)?.start;
const refId = (r: unknown): string | null => {
  const s = (r as Ref | undefined)?.reference;
  const m = s?.match(/(?:^|\/)Patient\/([^/]+)$/);
  return m ? m[1]! : null;
};

/** The patient a resource belongs to (its FHIR Patient id). */
export function patientOf(r: FhirResource): string | null {
  if (r.resourceType === "Patient") return r.id ?? null;
  return refId(r.subject) ?? refId(r.patient) ?? refId(r.beneficiary) ?? null;
}

/** Observation category → labs / vitals / other. */
export function observationKind(r: FhirResource): "laboratory" | "vital-signs" | "other" {
  const cats = ((r.category as CodeableConcept[] | undefined) ?? []).flatMap((c) => (c.coding ?? []).map((k) => k.code));
  if (cats.includes("laboratory")) return "laboratory";
  if (cats.includes("vital-signs")) return "vital-signs";
  return "other";
}

/** The section key used to store/query a resource ("Observation:laboratory", "Condition", …). */
export function sectionType(r: FhirResource): string {
  return r.resourceType === "Observation" ? `Observation:${observationKind(r)}` : r.resourceType;
}

export interface ChartLine {
  /** Main text: "Type 2 diabetes mellitus", "Hemoglobin A1c", "Metformin 500 mg". */
  title: string | null;
  /** Value / detail: "7.2 %", "120/80 mmHg", "Take 1 tablet twice daily". */
  value: string | null;
  /** active, resolved, completed, … */
  status: string | null;
  /** Clinically relevant date (onset, taken, given, visit). */
  date: string | null;
  code: string | null;
}

/** Turn any supported resource into one readable chart line. */
export function chartLine(r: FhirResource): ChartLine {
  const status = (s: unknown) => (typeof s === "string" ? s : cc(s)) ?? null;
  switch (r.resourceType) {
    case "Condition":
      return { title: cc(r.code), value: cc((r.category as unknown[] | undefined)?.[0]), status: status(r.clinicalStatus), date: ymd(r.onsetDateTime) ?? ymd(period(r.onsetPeriod)) ?? ymd(r.recordedDate), code: firstCode(r.code) };
    case "Observation": {
      const comps = (r.component as { code?: CodeableConcept; valueQuantity?: Quantity }[] | undefined) ?? [];
      const bp = comps.length >= 2 && comps.every((c) => c.valueQuantity?.value != null)
        ? `${comps.map((c) => Math.round(c.valueQuantity!.value!)).join("/")} ${comps[0]!.valueQuantity!.unit ?? ""}`.trim() : null;
      const value = qty(r.valueQuantity) ?? (typeof r.valueString === "string" ? r.valueString : null) ?? cc(r.valueCodeableConcept) ?? bp
        ?? (typeof r.valueBoolean === "boolean" ? (r.valueBoolean ? "Yes" : "No") : null);
      const flag = cc((r.interpretation as unknown[] | undefined)?.[0]);
      return { title: cc(r.code), value: value ? `${value}${flag && /^(H|L|HH|LL|A|high|low|abnormal)$/i.test(flag) ? ` (${flag})` : ""}` : null, status: status(r.status), date: ymd(r.effectiveDateTime) ?? ymd(period(r.effectivePeriod)) ?? ymd(r.issued), code: firstCode(r.code) };
    }
    case "MedicationRequest":
    case "MedicationStatement": {
      const med = cc(r.medicationCodeableConcept) ?? (r.medicationReference as Ref | undefined)?.display ?? null;
      const dose = ((r.dosageInstruction ?? r.dosage) as { text?: string }[] | undefined)?.[0]?.text ?? null;
      return { title: med, value: dose, status: status(r.status), date: ymd(r.authoredOn) ?? ymd(r.effectiveDateTime) ?? ymd(period(r.effectivePeriod)) ?? ymd(r.dateAsserted), code: firstCode(r.medicationCodeableConcept) };
    }
    case "AllergyIntolerance": {
      const reaction = ((r.reaction as { manifestation?: CodeableConcept[] }[] | undefined) ?? []).flatMap((x) => x.manifestation ?? []).map(cc).filter(Boolean).join(", ");
      return { title: cc(r.code), value: [reaction, typeof r.criticality === "string" ? `${r.criticality} risk` : null].filter(Boolean).join(" · ") || null, status: status(r.clinicalStatus), date: ymd(r.recordedDate) ?? ymd(r.onsetDateTime), code: firstCode(r.code) };
    }
    case "Immunization":
      return { title: cc(r.vaccineCode), value: typeof r.lotNumber === "string" ? `Lot ${r.lotNumber}` : null, status: status(r.status), date: ymd(r.occurrenceDateTime) ?? ymd(r.recorded), code: firstCode(r.vaccineCode) };
    case "Procedure":
      return { title: cc(r.code), value: cc((r.reasonCode as unknown[] | undefined)?.[0]), status: status(r.status), date: ymd(r.performedDateTime) ?? ymd(period(r.performedPeriod)), code: firstCode(r.code) };
    case "Encounter": {
      const who = ((r.participant as { individual?: Ref }[] | undefined) ?? []).map((p) => p.individual?.display).filter(Boolean)[0] ?? null;
      const reason = cc((r.reasonCode as unknown[] | undefined)?.[0]);
      return { title: cc((r.type as unknown[] | undefined)?.[0]) ?? (r.class as Coding | undefined)?.display ?? "Visit", value: [reason, who].filter(Boolean).join(" · ") || null, status: status(r.status), date: ymd(period(r.period)), code: firstCode((r.type as unknown[] | undefined)?.[0]) };
    }
    case "DiagnosticReport":
      return { title: cc(r.code), value: typeof r.conclusion === "string" ? r.conclusion.slice(0, 200) : null, status: status(r.status), date: ymd(r.effectiveDateTime) ?? ymd(period(r.effectivePeriod)) ?? ymd(r.issued), code: firstCode(r.code) };
    case "DocumentReference": {
      const att = ((r.content as { attachment?: { title?: string; contentType?: string } }[] | undefined) ?? [])[0]?.attachment;
      return { title: cc(r.type) ?? (typeof r.description === "string" ? r.description : null) ?? att?.title ?? "Document", value: att?.contentType ?? null, status: status(r.docStatus) ?? status(r.status), date: ymd(r.date) ?? ymd(period((r.context as { period?: unknown } | undefined)?.period)), code: firstCode(r.type) };
    }
    case "Coverage": {
      const payor = ((r.payor as Ref[] | undefined) ?? []).map((p) => p.display).filter(Boolean)[0] ?? null;
      const plan = ((r.class as { type?: CodeableConcept; value?: string; name?: string }[] | undefined) ?? []).map((c) => c.name ?? c.value).filter(Boolean).join(" · ") || null;
      const member = typeof r.subscriberId === "string" ? r.subscriberId : ((r.identifier as { value?: string }[] | undefined) ?? [])[0]?.value ?? null;
      return { title: payor ?? cc(r.type) ?? "Insurance", value: [member ? `Member ID ${member}` : null, plan].filter(Boolean).join(" · ") || null, status: status(r.status), date: ymd(period(r.period)), code: null };
    }
    case "CareTeam": {
      const people = ((r.participant as { member?: Ref; role?: CodeableConcept[] }[] | undefined) ?? []).map((p) => [p.member?.display, cc(p.role?.[0])].filter(Boolean).join(" — ")).filter(Boolean);
      return { title: typeof r.name === "string" ? r.name : "Care team", value: people.join("; ") || null, status: status(r.status), date: ymd(period(r.period)), code: null };
    }
    case "Goal":
      return { title: cc(r.description), value: null, status: status(r.lifecycleStatus), date: ymd(r.startDate) ?? ymd(r.statusDate), code: null };
    case "CarePlan":
      return { title: (typeof r.title === "string" ? r.title : null) ?? cc((r.category as unknown[] | undefined)?.[0]) ?? "Care plan", value: typeof r.description === "string" ? r.description.slice(0, 200) : null, status: status(r.status), date: ymd(period(r.period)) ?? ymd(r.created), code: null };
    case "Device":
      return { title: cc(r.type) ?? ((r.deviceName as { name?: string }[] | undefined) ?? [])[0]?.name ?? "Device", value: null, status: status(r.status), date: null, code: firstCode(r.type) };
    default:
      return { title: cc(r.code) ?? r.resourceType, value: null, status: typeof r.status === "string" ? r.status : null, date: null, code: null };
  }
}

export interface PatientInfo {
  fhirId: string;
  name: string | null;
  dob: string | null;
  sex: "F" | "M" | "X" | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  mrn: string | null;
}

/** The parts of a FHIR Patient MyPCP uses for matching and contact info. */
export function patientInfo(r: FhirResource): PatientInfo {
  const names = (r.name as { use?: string; text?: string; given?: string[]; family?: string }[] | undefined) ?? [];
  const n = names.find((x) => x.use === "official") ?? names.find((x) => x.use === "usual") ?? names[0];
  const name = n ? (n.text?.trim() || [...(n.given ?? []), n.family].filter(Boolean).join(" ").trim() || null) : null;
  const telecom = (r.telecom as { system?: string; value?: string; use?: string; rank?: number }[] | undefined) ?? [];
  const phone = telecom.find((t) => t.system === "phone" && t.use === "mobile") ?? telecom.find((t) => t.system === "phone");
  const email = telecom.find((t) => t.system === "email");
  const addr = ((r.address as { text?: string; line?: string[]; city?: string; state?: string; postalCode?: string }[] | undefined) ?? [])[0];
  const address = addr ? (addr.text ?? [...(addr.line ?? []), addr.city, [addr.state, addr.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")) || null : null;
  const g = typeof r.gender === "string" ? r.gender : "";
  const ids = (r.identifier as { type?: CodeableConcept; value?: string }[] | undefined) ?? [];
  const mrn = ids.find((i) => (i.type?.coding ?? []).some((k) => k.code === "MR"))?.value ?? null;
  return {
    fhirId: r.id ?? "",
    name,
    dob: ymd(r.birthDate),
    sex: g === "female" ? "F" : g === "male" ? "M" : g === "other" ? "X" : null,
    phone: phone?.value?.slice(0, 40) ?? null,
    email: email?.value?.trim().toLowerCase().slice(0, 320) ?? null,
    address: address?.slice(0, 255) ?? null,
    mrn: mrn?.slice(0, 64) ?? null,
  };
}

/** Condition still active (for the testing tracker's diabetes/hypertension rules). */
export function isActiveCondition(r: FhirResource): boolean {
  if (r.resourceType !== "Condition") return false;
  const s = cc(r.clinicalStatus)?.toLowerCase() ?? "active";
  return !["resolved", "inactive", "remission", "entered-in-error"].includes(s);
}
