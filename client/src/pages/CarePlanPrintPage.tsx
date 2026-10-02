import { useEffect } from "react";
import { useParams, useSearch } from "wouter";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { BrandMark } from "@/components/BrandMark";
import { fmtShortDate } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { GENERAL_LABELS, PLAN_FIELD_LABELS, PLAN_LIST_FIELDS, type PlanGeneral, type PlanProblem } from "@shared/carePlanDoc";
import { EDUCATION_HEADINGS, itemLabel, type EducationDoc, type LibraryLang } from "@shared/conditionLibrary";

/** The patient copy's own wording (English / Spanish). */
const T = {
  en: {
    title: "My Care Plan", provider: "My provider", coordinator: "My care coordinator",
    reach: (phone: string | null) => `Reach your care team 24 hours a day, 7 days a week${phone ? ` at ${phone}` : ""}.`, emergency: "In an emergency, call 911.",
    matters: "What matters most to me", conditions: "My health conditions", goals: "My goals", tests: "Checks and tests", watch: "Watch for, and call us",
    signed: (who: string, when: string) => <>Care plan established and signed by <b>{who}</b> on {when}.</>, draft: "Draft: this plan has not been signed by a provider yet.",
    bring: "Bring this plan to your visits. Ask your care team about anything that is not clear.", printed: "Printed",
  },
  es: {
    title: "Mi plan de cuidado", provider: "Mi proveedor", coordinator: "Mi coordinador(a) de cuidado",
    reach: (phone: string | null) => `Puede comunicarse con su equipo de cuidado las 24 horas, los 7 días de la semana${phone ? ` al ${phone}` : ""}.`, emergency: "En una emergencia, llame al 911.",
    matters: "Lo que más me importa", conditions: "Mis condiciones de salud", goals: "Mis metas", tests: "Chequeos y pruebas", watch: "Esté atento y llámenos",
    signed: (who: string, when: string) => <>Plan de cuidado establecido y firmado por <b>{who}</b> el {when}.</>, draft: "Borrador: un proveedor todavía no ha firmado este plan.",
    bring: "Traiga este plan a sus citas. Pregúntele a su equipo de cuidado sobre cualquier cosa que no esté clara.", printed: "Impreso",
  },
} as const;

/** Template wording meant for clinicians, dropped from a patient's copy. */
const forPatient = (s: string) => s.replace(/\s*\((?:or )?as individualized by the provider\)/gi, "").trim();

/**
 * The care plan on paper.
 * - Default: the patient's copy (CMS: the patient gets a copy of their plan) in plain language, in the
 *   patient's language (?lang=en|es to switch): each condition's handout wording (numbers, what to do,
 *   when to call), the care team and 24/7 access, what matters to them, and who signed it.
 * - ?full=1: the whole clinical plan (for the chart or another provider), as signed.
 */
export default function CarePlanPrintPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const { patientId = "" } = useParams<{ patientId: string }>();
  const search = new URLSearchParams(useSearch());
  const full = search.get("full") === "1";
  const q = trpc.workspace.carePlans.get.useQuery({ patientId: Number(patientId) }, { enabled: !!user && /^\d+$/.test(patientId) });
  useEffect(() => { if (q.data?.plan) { const t = setTimeout(() => window.print(), 400); return () => clearTimeout(t); } }, [q.data]);

  if (!user || q.isLoading) return <div className="flex justify-center p-16"><Loader2 className="size-8 animate-spin text-slate-400" /></div>;
  if (q.error) return <p className="p-10 text-slate-600">{q.error.message}</p>;
  const d = q.data!;
  const plan = d.plan;
  if (!plan) return <p className="p-10 text-slate-600">This patient has no care plan yet.</p>;
  const lang: LibraryLang = search.get("lang") === "es" || search.get("lang") === "en" ? (search.get("lang") as LibraryLang) : full ? "en" : d.patient.language;
  const t = T[lang];
  const h = EDUCATION_HEADINGS[lang];
  const handout = (p: PlanProblem): EducationDoc | null => (p.key ? (d.handouts as Record<string, Record<LibraryLang, EducationDoc>>)[p.key]?.[lang] ?? null : null);
  const nameOf = (p: PlanProblem) => (full ? p.problem || p.diagnosis : handout(p)?.title ?? (p.key ? itemLabel(p.key) : p.problem || p.diagnosis));
  const g = plan.general;
  const signedWhen = plan.signedAt ? fmtShortDate(plan.signedAt) : "";

  return (
    <div lang={lang} className="mx-auto max-w-3xl bg-white px-8 py-8 text-slate-900 print:max-w-none print:p-0" style={{ colorScheme: "light" }}>
      <header className="mb-5 flex items-center gap-3 border-b-2 border-teal-700 pb-3">
        <BrandMark size={36} />
        <div className="flex-1">
          <p className="text-xl font-bold text-teal-800">MyPCP Dr</p>
          <p className="text-sm text-slate-600">{d.patient.clinicName ?? ""}{d.patient.clinicPhone ? ` · ${d.patient.clinicPhone}` : ""}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold">{full ? "Comprehensive Care Plan" : t.title}</p>
          <p className="text-sm text-slate-600">{d.patient.name}</p>
        </div>
      </header>

      <section className="mb-5 grid gap-1 text-[15px] sm:grid-cols-2">
        <p><b>{full ? "Provider" : t.provider}:</b> {d.patient.providerName ?? "—"}</p>
        <p><b>{full ? "Care coordinator" : t.coordinator}:</b> {d.patient.coordinatorName ?? "—"}</p>
        <p className="sm:col-span-2"><b>{full ? T.en.reach(d.patient.clinicPhone) : t.reach(d.patient.clinicPhone)}</b> {full ? T.en.emergency : t.emergency}</p>
      </section>

      {g.patientGoals && <Block title={full ? GENERAL_LABELS.patientGoals : t.matters}><p className="whitespace-pre-line">{g.patientGoals}</p></Block>}

      <Block title={full ? "Problem list" : t.conditions}>
        <ol className="list-decimal ps-6">{plan.problems.map((p, i) => <li key={i}>{nameOf(p)}</li>)}</ol>
      </Block>

      {plan.problems.map((p, i) => {
        const doc = full ? null : handout(p);
        return (
          <section key={i} className="mb-5 break-inside-avoid rounded-xl border border-slate-300 p-4">
            <h2 className="text-lg font-bold text-teal-800">{i + 1}. {nameOf(p)}</h2>
            {full && p.diagnosis && p.diagnosis !== p.problem && <p className="text-sm text-slate-600">{p.diagnosis}</p>}
            {full && p.expectedOutcome && <p className="mt-1 text-[15px]"><b>{PLAN_FIELD_LABELS.expectedOutcome}:</b> {p.expectedOutcome}</p>}
            {full && PLAN_LIST_FIELDS.map((f) => p[f].length > 0 && <Items key={f} title={PLAN_FIELD_LABELS[f]} items={p[f]} />)}
            {!full && doc && (
              <>
                <Items title={h.numbers} items={doc.numbers} />
                <Items title={h.whatYouCanDo} items={doc.whatYouCanDo} />
                <Items title={h.callUs} items={doc.callUs} />
                <Items title={h.call911} items={doc.call911} />
              </>
            )}
            {!full && !doc && (
              <>
                <Items title={t.goals} items={p.goals.map(forPatient)} />
                <Items title={h.whatYouCanDo} items={p.selfManagement.map(forPatient)} />
                <Items title={t.tests} items={p.monitoring.map(forPatient)} />
                <Items title={t.watch} items={p.symptomManagement.map(forPatient)} />
              </>
            )}
          </section>
        );
      })}

      {full && (Object.keys(GENERAL_LABELS) as (keyof PlanGeneral)[]).filter((k) => k !== "patientGoals").map((k) => g[k] && (
        <Block key={k} title={GENERAL_LABELS[k]}><p className="whitespace-pre-line">{g[k]}</p></Block>
      ))}

      <footer className="mt-8 border-t border-slate-300 pt-3 text-sm text-slate-600">
        {plan.signedByName && plan.status === "signed"
          ? <p>{(full ? T.en : t).signed(plan.signedByName, signedWhen)}</p>
          : <p><b>{(full ? T.en : t).draft}</b></p>}
        {!full && <p className="mt-1">{t.bring}</p>}
        <p className="mt-1 text-xs text-slate-400">{(full ? T.en : t).printed} {fmtShortDate(new Date())}</p>
      </footer>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mb-5 break-inside-avoid text-[15px]"><h2 className="mb-1 text-lg font-bold text-teal-800">{title}</h2>{children}</section>;
}

function Items({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div className="mt-2 text-[15px]"><p className="font-semibold">{title}</p><ul className="list-disc ps-6">{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>;
}
