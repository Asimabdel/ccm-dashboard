import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, HelpCircle, Search, ShieldCheck, XCircle } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { PageHeader, Panel, SectionLabel, inputCls } from "@/components/workspace/ui";
import { cn } from "@/lib/utils";
import {
  CLINIC_PHONE, PLANS, PLAN_GROUP_LABELS, SELF_PAY, checkInsurance, insNorm, patientLine,
  type InsuranceAnswer, type PlanGroup,
} from "@shared/insurance";

const RESULT_STYLE = {
  yes: { icon: CheckCircle2, title: "We take it", cls: "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40", iconCls: "text-emerald-600" },
  no: { icon: XCircle, title: "Not accepted: Medicaid / CHIP", cls: "border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/40", iconCls: "text-rose-600" },
  maybe: { icon: HelpCircle, title: "Not on our list: verify before booking", cls: "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40", iconCls: "text-amber-600" },
} as const;

/**
 * "Do we take this plan?" for the front desk: the same plan list and answers as the checker on
 * mypcpdr.com, plus notes for staff and what to tell the patient in English or Spanish.
 */
export default function InsuranceCheckerPage() {
  useAuth({ redirectOnUnauthenticated: true });
  const [q, setQ] = useState("");
  const [lang, setLang] = useState<"en" | "es">("en");
  const answer = checkInsurance(q);
  const nq = insNorm(q);
  const groups = useMemo(() => (Object.keys(PLAN_GROUP_LABELS) as PlanGroup[]).map((g) => ({ g, plans: PLANS.filter((p) => p.group === g) })), []);

  return (
    <CCMDashboardLayout title="Insurance checker" pageTitle={false}>
      <PageHeader title="Insurance checker" subtitle="Do we take this plan? Same list and answers as the checker on mypcpdr.com." />
      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <Panel>
            <div className="relative">
              <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input autoFocus className={cn(inputCls, "pl-11 py-3 text-base")} placeholder="Type the plan or network on the card (e.g. Aetna, BCBS, Wellcare, MultiPlan)"
                value={q} onChange={(e) => setQ(e.target.value)} aria-label="Insurance plan" autoComplete="off" />
            </div>
            {!answer && <p className="mt-3 text-sm text-slate-500">Type at least 3 letters. Check both the plan name and the network logo on the back of the card (e.g. MultiPlan / PHCS).</p>}
            {answer && <Result answer={answer} lang={lang} setLang={setLang} />}
          </Panel>

          <Panel title={`All accepted plans (${PLANS.length})`} subtitle="Click a plan to check it. Anything not here: verify with the member ID.">
            <div className="space-y-4">
              {groups.map(({ g, plans }) => (
                <div key={g}>
                  <SectionLabel className="mb-2">{PLAN_GROUP_LABELS[g]}</SectionLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {plans.map((p) => {
                      const hit = nq.length >= 3 && insNorm(p.name + p.keys).includes(nq);
                      return (
                        <button key={p.name} type="button" onClick={() => setQ(p.name)}
                          className={cn("rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                            hit ? "border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-100"
                              : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800")}>
                          {p.name}{p.note && <AlertTriangle size={11} className="inline ml-1 -mt-0.5 text-amber-500" aria-label="has a note" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="space-y-5">
          <Panel title="Quick facts">
            <ul className="space-y-2.5 text-sm text-slate-700 dark:text-slate-200">
              <li><b>Self-pay:</b> ${SELF_PAY.firstVisit} first visit, ${SELF_PAY.followUp} follow-ups. No membership.</li>
              <li><b>Medicaid and CHIP</b> (including STAR, STAR+PLUS, STAR Kids): not accepted.</li>
              <li><b>Medicare:</b> Original Medicare and the Medicare Advantage plans listed here.</li>
              <li><b>No referral</b> needed. Same-day visits at all 4 locations.</li>
              <li><b>Phone:</b> {CLINIC_PHONE}</li>
            </ul>
            <p className="mt-3 text-xs text-slate-500">Watch for carriers that also sell Medicaid plans (e.g. Molina, Wellpoint / Amerigroup, UnitedHealthcare Community Plan): if the card says Medicaid, STAR or CHIP, we don't take it.</p>
          </Panel>
          <Panel title={<span className="flex items-center gap-2"><ShieldCheck size={15} className="text-brand" /> Verify a patient's coverage</span>}>
            <p className="text-sm text-slate-600 dark:text-slate-300">This page says whether we're in network with a plan. Whether the patient's coverage is active, and their copay or deductible, still needs their member ID.</p>
            <a href="https://apps.availity.com/" target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline">
              Open Availity <ExternalLink size={13} />
            </a>
            <p className="mt-1 text-xs text-slate-500">Or call the member services number on the back of the card.</p>
          </Panel>
        </div>
      </div>
    </CCMDashboardLayout>
  );
}

function Result({ answer, lang, setLang }: { answer: InsuranceAnswer; lang: "en" | "es"; setLang: (l: "en" | "es") => void }) {
  const st = RESULT_STYLE[answer.result];
  const line = patientLine(answer, lang);
  return (
    <div className={cn("mt-4 rounded-xl border p-4", st.cls)} role="status">
      <p className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-50"><st.icon size={18} className={st.iconCls} /> {st.title}</p>
      {answer.result === "yes" && (
        <ul className="mt-2 space-y-1.5 text-sm">
          {answer.plans.map((p) => (
            <li key={p.name}>
              <span className="font-medium text-slate-900 dark:text-slate-100">{p.name}</span>
              <span className="text-slate-500"> · {PLAN_GROUP_LABELS[p.group]}</span>
              {p.note && <span className="mt-0.5 flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300"><AlertTriangle size={12} className="mt-0.5 shrink-0" /> {p.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {answer.result === "no" && <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">Offer self-pay (${SELF_PAY.firstVisit} first visit, ${SELF_PAY.followUp} follow-ups).</p>}
      {answer.result === "maybe" && <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">We work with 40+ networks, so it may still be covered. Check the network logo on the back of the card, then verify with the member ID in Availity or with the plan before booking. If the card says Medicaid, STAR or CHIP, we don't take it.</p>}

      <div className="mt-3 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-white dark:border-slate-700 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">What to tell the patient</span>
          <div className="flex items-center gap-1">
            {(["en", "es"] as const).map((l) => (
              <button key={l} type="button" onClick={() => setLang(l)} aria-pressed={lang === l}
                className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", lang === l ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "text-slate-500 hover:text-slate-900")}>
                {l === "en" ? "English" : "Español"}
              </button>
            ))}
            <button type="button" aria-label="Copy" className="ml-1 text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              onClick={() => { void navigator.clipboard.writeText(line); toast.success("Copied"); }}><Copy size={13} /></button>
          </div>
        </div>
        <p className="mt-1 text-sm text-slate-800 dark:text-slate-100">{line}</p>
      </div>
    </div>
  );
}
