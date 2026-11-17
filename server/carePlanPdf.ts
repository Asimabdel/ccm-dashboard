// A patient's care plan as a PDF: the whole clinical plan (for the chart, another provider, a fax) or the
// patient's own copy in plain language (English or Spanish). Letter size, the MyPCP Dr mark drawn as lines,
// page numbers on every page. Can also be filed in the patient's folder.
import { randomUUID } from "node:crypto";
import { LineCapStyle, PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { GENERAL_LABELS, PLAN_FIELD_LABELS, PLAN_LIST_FIELDS, type PlanGeneral, type PlanProblem } from "../shared/carePlanDoc";
import { GOAL_STATUS_LABELS, goalIdOf, problemIdOf, type GoalProgress } from "../shared/carePlanProgress";
import { EDUCATION_HEADINGS, itemLabel, type EducationDoc, type LibraryLang } from "../shared/conditionLibrary";
import { BRAND_CIRCLES, BRAND_PATHS, BRAND_VIEW } from "../shared/stamps";
import { WorkspaceError, audit, type WorkspaceActor } from "./workspaceDb";
import { planFor } from "./carePlansDb";

export type PlanPdfKind = "full" | "patient";

const PAGE = { w: 612, h: 792, margin: 54 };
const TEAL = rgb(0.059, 0.463, 0.431); // #0f766e
const TEAL_SOFT = rgb(0.906, 0.969, 0.961);
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.33, 0.39, 0.47);
const LINE = rgb(0.85, 0.88, 0.91);
const AMBER = rgb(0.6, 0.35, 0.02);
const hex = (h: string) => { const n = parseInt(h.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };

/** The patient copy's own wording (English / Spanish). */
const T = {
  en: {
    title: "My Care Plan", provider: "My provider", coordinator: "My care coordinator", dob: "Date of birth",
    reach: (phone: string | null) => `Reach your care team 24 hours a day, 7 days a week${phone ? ` at ${phone}` : ""}. In an emergency, call 911.`,
    matters: "What matters most to me", conditions: "My health conditions", goals: "My goals", tests: "Checks and tests", watch: "Watch for, and call us",
    signed: (who: string, when: string) => `Care plan established and signed by ${who} on ${when}.`, draft: "Draft: this plan has not been signed by a provider yet.",
    bring: "Bring this plan to your visits. Ask your care team about anything that is not clear.", page: (i: number, n: number) => `Page ${i} of ${n}`, made: "Made",
  },
  es: {
    title: "Mi plan de cuidado", provider: "Mi proveedor", coordinator: "Mi coordinador(a) de cuidado", dob: "Fecha de nacimiento",
    reach: (phone: string | null) => `Puede comunicarse con su equipo de cuidado las 24 horas, los 7 días de la semana${phone ? ` al ${phone}` : ""}. En una emergencia, llame al 911.`,
    matters: "Lo que más me importa", conditions: "Mis condiciones de salud", goals: "Mis metas", tests: "Chequeos y pruebas", watch: "Esté atento y llámenos",
    signed: (who: string, when: string) => `Plan de cuidado establecido y firmado por ${who} el ${when}.`, draft: "Borrador: un proveedor todavía no ha firmado este plan.",
    bring: "Traiga este plan a sus citas. Pregúntele a su equipo de cuidado sobre cualquier cosa que no esté clara.", page: (i: number, n: number) => `Página ${i} de ${n}`, made: "Hecho",
  },
} as const;

/** Template wording meant for clinicians, dropped from a patient's copy. */
const forPatient = (s: string) => s.replace(/\s*\((?:or )?as individualized by the provider\)/gi, "").trim();
const day = (d: Date | string | null | undefined, lang: LibraryLang = "en") =>
  d ? new Date(d).toLocaleDateString(lang === "es" ? "es-US" : "en-US", { timeZone: "America/Chicago", year: "numeric", month: "short", day: "numeric" }) : "";
const usDob = (ymd: string | null) => (ymd ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}` : "");

/** The standard PDF fonts cover Western characters only: common symbols are spelled out, anything else becomes "?". */
function safe(font: PDFFont, s: string) {
  const t = s.replace(/[\r\t]/g, " ").replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/→/g, "->").replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  try { font.encodeText(t); return t; } catch { return t.replace(/[^\x20-\x7E\xA0-\xFF–—•\n]/g, "?"); }
}

function drawBrand(page: PDFPage, left: number, top: number, size: number) {
  const k = size / BRAND_VIEW.size;
  const x0 = left - BRAND_VIEW.x * k, y0 = top + BRAND_VIEW.y * k;
  for (const p of BRAND_PATHS) page.drawSvgPath(p.d, { x: x0, y: y0, scale: k, borderColor: hex(p.color), borderWidth: p.width, borderLineCap: LineCapStyle.Round });
  for (const c of BRAND_CIRCLES) page.drawCircle({ x: x0 + c.cx * k, y: y0 - c.cy * k, size: c.r * k, ...(c.fill ? { color: hex(c.fill) } : {}), ...(c.stroke ? { borderColor: hex(c.stroke), borderWidth: c.width * k } : {}) });
}

/** Lays text out down the pages: wrapping, bullets with a hanging indent, section bars, new pages as needed. */
class Writer {
  page!: PDFPage;
  y = 0;
  readonly width = PAGE.w - PAGE.margin * 2;
  constructor(private doc: PDFDocument, private font: PDFFont, private bold: PDFFont) { this.newPage(); }
  newPage() { this.page = this.doc.addPage([PAGE.w, PAGE.h]); this.y = PAGE.h - PAGE.margin; }
  ensure(h: number) { if (this.y - h < PAGE.margin + 18) this.newPage(); }
  wrap(text: string, size: number, font: PDFFont, width: number) {
    const out: string[] = [];
    for (const para of safe(font, text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
        if (line) out.push(line);
        let w = word;
        while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
          let cut = w.length;
          while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
          out.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        line = w;
      }
      out.push(line);
    }
    return out;
  }
  text(text: string, o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; gap?: number; lead?: number } = {}) {
    if (!text.trim()) return;
    const size = o.size ?? 10.5, font = o.bold ? this.bold : this.font, x = PAGE.margin + (o.indent ?? 0), lead = o.lead ?? size * 1.38;
    for (const line of this.wrap(text, size, font, PAGE.w - PAGE.margin - x)) {
      this.ensure(lead);
      this.page.drawText(line, { x, y: this.y - size, size, font, color: o.color ?? INK });
      this.y -= lead;
    }
    this.y -= o.gap ?? 0;
  }
  /** A small heading and its bullet points (nothing when the list is empty). */
  list(title: string, items: string[], o: { indent?: number } = {}) {
    const xs = items.map((x) => x.trim()).filter(Boolean);
    if (!xs.length) return;
    const indent = o.indent ?? 0;
    this.ensure(34);
    this.text(title, { size: 10.5, bold: true, indent, gap: 1 });
    for (const x of xs) {
      const size = 10, lead = 13.6, bx = PAGE.margin + indent + 4, tx = bx + 10;
      const lines = this.wrap(x, size, this.font, PAGE.w - PAGE.margin - tx);
      lines.forEach((line, i) => {
        this.ensure(lead);
        if (i === 0) this.page.drawText("•", { x: bx, y: this.y - size, size, font: this.bold, color: TEAL });
        this.page.drawText(line, { x: tx, y: this.y - size, size, font: this.font, color: INK });
        this.y -= lead;
      });
    }
    this.y -= 5;
  }
  /** A tinted bar with a section title. */
  bar(title: string, o: { sub?: string } = {}) {
    this.ensure(o.sub ? 64 : 52);
    this.y -= 6;
    const h = 22;
    this.page.drawRectangle({ x: PAGE.margin, y: this.y - h, width: this.width, height: h, color: TEAL_SOFT });
    this.page.drawRectangle({ x: PAGE.margin, y: this.y - h, width: 3, height: h, color: TEAL });
    const lines = this.wrap(title, 12, this.bold, this.width - 20);
    this.page.drawText(lines[0] ?? "", { x: PAGE.margin + 10, y: this.y - 15.5, size: 12, font: this.bold, color: TEAL });
    this.y -= h + 6;
    for (const extra of lines.slice(1)) this.text(extra, { size: 12, bold: true, color: TEAL, indent: 10 });
    if (o.sub) this.text(o.sub, { size: 9.5, color: MUTED, indent: 10, gap: 2 });
  }
  rule(gap = 8) { this.y -= gap / 2; this.page.drawLine({ start: { x: PAGE.margin, y: this.y }, end: { x: PAGE.w - PAGE.margin, y: this.y }, thickness: 0.6, color: LINE }); this.y -= gap / 2; }
}

/** The care plan as PDF bytes, plus a file name. */
export async function carePlanPdf(actor: WorkspaceActor, patientId: number, opts: { kind: PlanPdfKind; lang?: LibraryLang }) {
  const d = await planFor(actor, patientId);
  const plan = d.plan;
  if (!plan) throw new WorkspaceError("This patient has no care plan yet.");
  const full = opts.kind === "full";
  const lang: LibraryLang = full ? "en" : opts.lang ?? d.patient.language;
  const t = T[lang];
  const h = EDUCATION_HEADINGS[lang];
  const handout = (p: PlanProblem): EducationDoc | null => (p.key ? (d.handouts as Record<string, Record<LibraryLang, EducationDoc>>)[p.key]?.[lang] ?? null : null);
  const nameOf = (p: PlanProblem) => (full ? p.problem || p.diagnosis : handout(p)?.title ?? (p.key ? itemLabel(p.key) : p.problem || p.diagnosis));
  const progress = d.progress as Record<string, GoalProgress>;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(pdf, font, bold);
  const title = full ? "Comprehensive Care Plan" : t.title;

  // Letterhead
  drawBrand(w.page, PAGE.margin, PAGE.h - PAGE.margin + 6, 40);
  w.page.drawText("MyPCP Dr", { x: PAGE.margin + 48, y: PAGE.h - PAGE.margin - 14, size: 17, font: bold, color: TEAL });
  const office = [d.patient.clinicName, d.patient.clinicPhone].filter(Boolean).join(" · ");
  if (office) w.page.drawText(safe(font, office), { x: PAGE.margin + 48, y: PAGE.h - PAGE.margin - 29, size: 9.5, font, color: MUTED });
  const tw = bold.widthOfTextAtSize(safe(bold, title), 17);
  w.page.drawText(safe(bold, title), { x: PAGE.w - PAGE.margin - tw, y: PAGE.h - PAGE.margin - 14, size: 17, font: bold, color: INK });
  const who = safe(font, `${d.patient.name}${d.patient.dob ? ` · ${full ? "DOB" : t.dob} ${usDob(d.patient.dob)}` : ""}`);
  w.page.drawText(who, { x: PAGE.w - PAGE.margin - font.widthOfTextAtSize(who, 10), y: PAGE.h - PAGE.margin - 29, size: 10, font, color: MUTED });
  w.y = PAGE.h - PAGE.margin - 44;
  w.page.drawRectangle({ x: PAGE.margin, y: w.y, width: w.width, height: 2, color: TEAL });
  w.y -= 14;

  // Care team, 24/7 access, where the plan stands
  w.text(`${full ? "Provider" : t.provider}: ${d.patient.providerName ?? "—"}     ${full ? "Care coordinator" : t.coordinator}: ${d.patient.coordinatorName ?? "—"}`, { size: 10.5 });
  w.text(full ? `The patient can reach the care team 24 hours a day, 7 days a week${d.patient.clinicPhone ? ` at ${d.patient.clinicPhone}` : ""}. In an emergency, call 911.` : t.reach(d.patient.clinicPhone), { size: 10.5, bold: true });
  if (full) {
    const status = plan.status === "signed" ? `Signed (version ${plan.signedVersion}) by ${plan.signedByName} on ${day(plan.signedAt)}.`
      : plan.signedByName ? `Version ${plan.version}: changed since ${plan.signedByName} signed version ${plan.signedVersion} on ${day(plan.signedAt)}; waiting for a provider's signature.`
        : `Version ${plan.version}: draft, not signed by a provider yet.`;
    w.text(status, { size: 10, color: plan.status === "signed" ? MUTED : AMBER });
    const extras = [d.reviewDue ? `Yearly provider review due ${day(d.reviewDue)}` : null, plan.lastReviewedAt ? `last reviewed with the patient ${day(plan.lastReviewedAt)}` : null].filter(Boolean);
    if (extras.length) w.text(`${extras.join("; ")}.`, { size: 10, color: MUTED });
  }
  w.rule(10);

  const g = plan.general as PlanGeneral;
  if (g.patientGoals?.trim()) { w.bar(full ? GENERAL_LABELS.patientGoals : t.matters); w.text(g.patientGoals, { gap: 4 }); }

  // Problem list
  w.bar(full ? "Problem list" : t.conditions);
  (plan.problems as PlanProblem[]).forEach((p, i) => w.text(`${i + 1}.  ${nameOf(p)}${full && p.diagnosis && p.diagnosis !== p.problem ? ` — ${p.diagnosis}` : ""}`, { indent: 6 }));
  w.y -= 4;

  // Each problem
  (plan.problems as PlanProblem[]).forEach((p, i) => {
    if (full) {
      w.bar(`${i + 1}. ${nameOf(p)}`, { sub: [p.kind === "addon" ? "Add-on: complication or combination of conditions" : null, p.diagnosis && p.diagnosis !== p.problem ? p.diagnosis : null].filter(Boolean).join(" · ") || undefined });
      if (p.expectedOutcome.trim()) w.text(`${PLAN_FIELD_LABELS.expectedOutcome}: ${p.expectedOutcome}`, { gap: 4 });
      // Goals, with how each went on the latest CCM call.
      const pid = problemIdOf(p);
      const goals = p.goals.map((x) => x.trim()).filter(Boolean).map((goal) => {
        const pr = progress[goalIdOf(pid, goal)];
        return pr?.latest ? `${goal}  [Latest check ${day(pr.latest.at)}: ${GOAL_STATUS_LABELS[pr.latest.status]}${pr.latest.value ? `, ${pr.latest.value}` : ""}]` : goal;
      });
      w.list(PLAN_FIELD_LABELS.goals, goals);
      for (const f of PLAN_LIST_FIELDS) if (f !== "goals") w.list(PLAN_FIELD_LABELS[f], p[f]);
    } else {
      w.bar(`${i + 1}. ${nameOf(p)}`);
      const doc = handout(p);
      if (doc) {
        w.list(h.numbers, doc.numbers);
        w.list(h.whatYouCanDo, doc.whatYouCanDo);
        w.list(h.callUs, doc.callUs);
        w.list(h.call911, doc.call911);
      } else {
        w.list(t.goals, p.goals.map(forPatient));
        w.list(h.whatYouCanDo, p.selfManagement.map(forPatient));
        w.list(t.tests, p.monitoring.map(forPatient));
        w.list(t.watch, p.symptomManagement.map(forPatient));
      }
    }
  });

  if (full) for (const k of Object.keys(GENERAL_LABELS) as (keyof PlanGeneral)[]) if (k !== "patientGoals" && g[k]?.trim()) { w.bar(GENERAL_LABELS[k]); w.text(g[k], { gap: 4 }); }

  // Signature
  w.ensure(60);
  w.y -= 10;
  w.rule(10);
  const signed = plan.status === "signed" && plan.signedByName;
  w.text(signed ? (full ? `Established and electronically signed by ${plan.signedByName} on ${day(plan.signedAt)} (version ${plan.signedVersion}).` : t.signed(plan.signedByName!, day(plan.signedAt, lang))) : (full ? "DRAFT: not signed by a provider yet." : t.draft), { bold: true, color: signed ? INK : AMBER });
  if (!full) w.text(t.bring, { size: 10, color: MUTED });

  // Footer on every page: who, which version, page x of y.
  const pages = pdf.getPages();
  const made = `${t.made} ${day(new Date(), lang)}`;
  pages.forEach((pg, i) => {
    const left = safe(font, `${d.patient.name}${d.patient.dob ? ` · ${usDob(d.patient.dob)}` : ""} · ${full ? "Care plan" : t.title} v${plan.version} · ${made}`);
    pg.drawLine({ start: { x: PAGE.margin, y: 40 }, end: { x: PAGE.w - PAGE.margin, y: 40 }, thickness: 0.5, color: LINE });
    pg.drawText(left, { x: PAGE.margin, y: 28, size: 8, font, color: MUTED });
    const right = t.page(i + 1, pages.length);
    pg.drawText(right, { x: PAGE.w - PAGE.margin - font.widthOfTextAtSize(right, 8), y: 28, size: 8, font, color: MUTED });
  });
  pdf.setTitle(`${title} — ${d.patient.name}`);
  pdf.setAuthor("MyPCP Dr");
  const bytes = Buffer.from(await pdf.save());
  const stamp = new Date().toISOString().slice(0, 10);
  const what = full ? "Care plan" : lang === "es" ? "Plan de cuidado (paciente)" : "Care plan (patient copy)";
  await audit(actor, "view_patient", { entityType: "carePlan", entityId: patientId, description: `Care plan PDF made (${full ? "full plan" : `patient copy, ${lang}`})` });
  return {
    bytes, fileName: `${what} ${stamp}.pdf`,
    title: `${what}${plan.status === "signed" ? ` · signed v${plan.signedVersion}` : ` · v${plan.version} (not signed)`}`,
  };
}

/** The PDF filed in the patient's folder (Files → Care plan). */
export async function saveCarePlanToFolder(actor: WorkspaceActor, patientId: number, opts: { kind: PlanPdfKind; lang?: LibraryLang }) {
  const made = await carePlanPdf(actor, patientId, opts);
  const { addGeneratedFile } = await import("./folderDb");
  const id = await addGeneratedFile(actor, { subjectKey: `p:${patientId}`, fileType: "care_plan", title: made.title, fileName: made.fileName, bytes: made.bytes, key: `documents/patient-files/${randomUUID()}` });
  return { id, title: made.title };
}
