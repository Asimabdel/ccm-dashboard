import { useEffect } from "react";
import { useParams, useSearch } from "wouter";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { BrandMark } from "@/components/BrandMark";
import { fmtShortDate } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { GENERAL_LABELS, PLAN_FIELD_LABELS, PLAN_LIST_FIELDS, type PlanGeneral, type PlanProblem } from "@shared/carePlanDoc";
import { categoryLabel } from "@shared/programRules";

/** The patient copy names conditions plainly ("Diabetes"); the full plan uses the clinical wording. */
const nameOf = (p: PlanProblem, full: boolean) => (!full && p.key ? categoryLabel(p.key) : p.problem || p.diagnosis);

/**
 * The care plan on paper. Default: the patient's copy (CMS: the patient gets a copy of their plan),
 * in plain sections: goals, what they can do, what to watch for, the care team and 24/7 access.
 * ?full=1: the whole clinical plan (for the chart or another provider).
 */
export default function CarePlanPrintPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const { patientId = "" } = useParams<{ patientId: string }>();
  const full = new URLSearchParams(useSearch()).get("full") === "1";
  const q = trpc.workspace.carePlans.get.useQuery({ patientId: Number(patientId) }, { enabled: !!user && /^\d+$/.test(patientId) });
  useEffect(() => { if (q.data?.plan) { const t = setTimeout(() => window.print(), 400); return () => clearTimeout(t); } }, [q.data]);

  if (!user || q.isLoading) return <div className="flex justify-center p-16"><Loader2 className="size-8 animate-spin text-slate-400" /></div>;
  if (q.error) return <p className="p-10 text-slate-600">{q.error.message}</p>;
  const d = q.data!;
  const plan = d.plan;
  if (!plan) return <p className="p-10 text-slate-600">This patient has no care plan yet.</p>;
  const g = plan.general;

  return (
    <div className="mx-auto max-w-3xl bg-white px-8 py-8 text-slate-900 print:max-w-none print:p-0" style={{ colorScheme: "light" }}>
      <header className="mb-5 flex items-center gap-3 border-b-2 border-teal-700 pb-3">
        <BrandMark size={36} />
        <div className="flex-1">
          <p className="text-xl font-bold text-teal-800">MyPCP Dr</p>
          <p className="text-sm text-slate-600">{d.patient.clinicName ?? ""}{d.patient.clinicPhone ? ` · ${d.patient.clinicPhone}` : ""}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold">{full ? "Comprehensive Care Plan" : "My Care Plan"}</p>
          <p className="text-sm text-slate-600">{d.patient.name}</p>
        </div>
      </header>

      <section className="mb-5 grid gap-1 text-[15px] sm:grid-cols-2">
        <p><b>My provider:</b> {d.patient.providerName ?? "—"}</p>
        <p><b>My care coordinator:</b> {d.patient.coordinatorName ?? "—"}</p>
        <p className="sm:col-span-2"><b>Reach the care team 24 hours a day, 7 days a week{d.patient.clinicPhone ? ` at ${d.patient.clinicPhone}` : ""}.</b> In an emergency, call 911.</p>
      </section>

      {g.patientGoals && <Block title={full ? GENERAL_LABELS.patientGoals : "What matters most to me"}><p className="whitespace-pre-line">{g.patientGoals}</p></Block>}

      <Block title={full ? "Problem list" : "My health conditions"}>
        <ol className="list-decimal ps-6">{plan.problems.map((p, i) => <li key={i}>{nameOf(p, full)}</li>)}</ol>
      </Block>

      {plan.problems.map((p, i) => (
        <section key={i} className="mb-5 break-inside-avoid rounded-xl border border-slate-300 p-4">
          <h2 className="text-lg font-bold text-teal-800">{i + 1}. {nameOf(p, full)}</h2>
          {full && p.diagnosis && p.diagnosis !== p.problem && <p className="text-sm text-slate-600">{p.diagnosis}</p>}
          {full && p.expectedOutcome && <p className="mt-1 text-[15px]"><b>{PLAN_FIELD_LABELS.expectedOutcome}:</b> {p.expectedOutcome}</p>}
          {full ? PLAN_LIST_FIELDS.map((f) => p[f].length > 0 && <Items key={f} title={PLAN_FIELD_LABELS[f]} items={p[f]} />) : (
            <>
              <Items title="My goals" items={p.goals} plain />
              <Items title="What I can do" items={p.selfManagement} plain />
              <Items title="Checks and tests" items={p.monitoring} plain />
              <Items title="Watch for, and call us" items={p.symptomManagement} plain />
            </>
          )}
        </section>
      ))}

      {(full ? (Object.keys(GENERAL_LABELS) as (keyof PlanGeneral)[]).filter((k) => k !== "patientGoals") : (["medications", "followUp"] as const)).map((k) => g[k] && (
        <Block key={k} title={full ? GENERAL_LABELS[k] : k === "medications" ? "My medicines" : "Follow-up"}><p className="whitespace-pre-line">{g[k]}</p></Block>
      ))}

      <footer className="mt-8 border-t border-slate-300 pt-3 text-sm text-slate-600">
        {plan.signedByName && plan.status === "signed"
          ? <p>Care plan established and signed by <b>{plan.signedByName}</b> on {fmtShortDate(plan.signedAt)}.</p>
          : <p><b>Draft:</b> this plan has not been signed by a provider yet.</p>}
        {!full && <p className="mt-1">Bring this plan to your visits. Ask your care team about anything that is not clear.</p>}
        <p className="mt-1 text-xs text-slate-400">Printed {fmtShortDate(new Date())}</p>
      </footer>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mb-5 break-inside-avoid text-[15px]"><h2 className="mb-1 text-lg font-bold text-teal-800">{title}</h2>{children}</section>;
}
/** Template wording meant for clinicians, dropped from the patient's copy. */
const forPatient = (s: string) => s.replace(/\s*\((?:or )?as individualized by the provider\)/gi, "").trim();

function Items({ title, items, plain }: { title: string; items: string[]; plain?: boolean }) {
  if (!items.length) return null;
  return <div className="mt-2 text-[15px]"><p className="font-semibold">{title}</p><ul className="list-disc ps-6">{items.map((x, i) => <li key={i}>{plain ? forPatient(x) : x}</li>)}</ul></div>;
}
