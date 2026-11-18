import { Banknote } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Panel } from "@/components/workspace/ui";
import { CollectChip, ESTIMATE_NOTE } from "@/components/billing/CollectChip";
import { isPatientKey } from "@shared/folder";
import { PLAN_TIER_WORDS, shortDay, usd, VISIT_CODE_NAMES, type StaffOwn, type StaffPastVisit } from "@shared/visitCost";

type Cost = RouterOutputs["workspace"]["visitCost"]["patient"];
type Bills = NonNullable<Cost["bills"]>;
type BillsOwn = NonNullable<Bills["own"]>;

const visitsWord = (n: number) => `${n} visit${n === 1 ? "" : "s"}`;

/** The deductible in words; the dollar totals only for the owner (they come from the bills). */
function deductibleLine(own: StaffOwn, bills: BillsOwn | null): string {
  const d = own.deductible;
  const b = bills?.deductible;
  if (d.state === "applies") return `Not met as of ${shortDay(d.lastDate)}: applied on ${visitsWord(d.visitsThisYear)} this year${b ? ` (${usd(b.centsThisYear)} so far)` : ""}`;
  if (d.state === "met") return `Looks met for ${d.year}: applied on ${visitsWord(d.visitsThisYear)}${b ? ` (${usd(b.centsThisYear)})` : ""}`;
  if (d.state === "reset") return `Applied on ${visitsWord(d.visitsLastYear)} in ${d.year - 1}${b ? ` (${usd(b.centsLastYear)})` : ""}. No visit yet in ${d.year}: it starts over each January`;
  return "Not applied on their office visits";
}

function copayLine(own: StaffOwn): string {
  const c = own.copay;
  if (!c) return own.nothingOwed ? "None: nothing to pay on their visits" : "None on their office visits";
  return `${usd(c.cents)} on ${c.seenOn} of the last ${visitsWord(c.outOf)}${c.latestCents !== c.cents ? ` (most recent ${usd(c.latestCents)})` : ""}${c.fromLastYear ? `, all in ${own.deductible.year - 1}` : ""}`;
}

/** What applied at a past visit, without amounts from the bill (the copay is the plan's, so it shows). */
function appliedText(v: StaffPastVisit): string {
  const parts = [v.copayCents ? `Copay ${usd(v.copayCents)}` : null, v.deductible ? "Deductible" : null, v.coinsurance ? "Coinsurance" : null].filter(Boolean);
  return parts.length ? parts.join(" + ") : v.nothingOwed ? "Nothing to pay" : "–";
}

/**
 * Insurance tab: what the patient will likely owe at check-in, worked out from their past visits (the payment
 * files in Master Billing). Staff see what to collect and what applied; what insurance paid, visit prices and
 * past balances come only to Master Billing people (the server leaves them out for everyone else).
 */
export function VisitCostCard({ subjectKey }: { subjectKey: string }) {
  const q = trpc.workspace.visitCost.patient.useQuery({ key: subjectKey }, { enabled: isPatientKey(subjectKey), retry: false, staleTime: 5 * 60_000 });
  const c = q.data;
  const prices = c?.bills?.prices ?? [];
  // Nothing to show while loading, when this person can't see it, or when there is nothing to go on at all.
  if (!c || (!c.own && !c.plan && !prices.length)) return null;
  const own = c.own;
  const billsOwn = c.bills?.own ?? null;
  const ins = c.insurance;
  const others = c.plan && !own ? c.plan : null;
  return (
    <Panel
      title={<span className="flex items-center gap-2"><Banknote size={16} className="text-brand" /> What they'll likely owe</span>}
      subtitle={`From their past visits${c.through ? ` (on file through ${shortDay(c.through)})` : ""}.`}
    >
      <div className="space-y-3 text-sm">
        {c.note ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
            <CollectChip note={c.note} className="px-2.5 py-1 text-xs" />
            <p className="mt-2 text-slate-700 dark:text-slate-200">{c.note.detail}</p>
          </div>
        ) : (
          <p className="text-slate-500">{own ? "Their past visits don't show a clear copay or deductible." : "No past office visits on file for this patient yet, and not enough other patients on the same plan to go by."}</p>
        )}

        <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {ins?.payer && <Fact label={own ? "Insurance on their latest visit" : "Insurance on file"} value={[ins.payer, ins.plan, ins.group ? `group ${ins.group}` : null].filter(Boolean).join(" · ")} />}
          {own && <Fact label="Copay" value={copayLine(own)} />}
          {own && <Fact label="Deductible" value={deductibleLine(own, billsOwn)} />}
          {own?.coinsurancePct && <Fact label="Coinsurance" value={`${own.coinsurancePct}% of the visit`} />}
          {prices.length > 0 && (
            <Fact label="What a visit usually costs with this insurance" value={prices.map((p) => `${VISIT_CODE_NAMES[p.code] ?? "Visit"} (${p.code}) about ${usd(p.cents)}`).join(" · ")} />
          )}
        </div>

        {others && others.copays.length > 0 && (
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Other patients with the same {PLAN_TIER_WORDS[others.tier]} ({others.patients}): {others.copays.map((x) => `${x.cents ? `${usd(x.cents)} copay` : "nothing to pay"} for ${x.patients}`).join(", ")}
            {others.deductiblePatients > 0 ? `; a deductible applied for ${others.deductiblePatients}` : ""}.
            {others.tier === "payer" && !others.copay ? " Copays differ by plan, so this is a range, not this patient's copay." : ""}
          </p>
        )}

        {billsOwn && billsOwn.recent.length > 0 ? <OwnerVisits own={billsOwn} /> : own && own.recent.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[20rem] text-xs">
              <caption className="pb-1 text-left font-semibold text-slate-500">Their past office visits</caption>
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500 dark:border-slate-700">
                  <th className="py-1 pr-3 font-medium">Date</th><th className="py-1 pr-3 font-medium">Visit</th><th className="py-1 font-medium">What applied</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {own.recent.map((v) => (
                  <tr key={v.date} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="py-1 pr-3">{shortDay(v.date)}</td><td className="py-1 pr-3">{v.code ? `${VISIT_CODE_NAMES[v.code] ?? "Visit"} (${v.code})` : "Visit"}</td><td className="py-1">{appliedText(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-slate-500">{ESTIMATE_NOTE}</p>
      </div>
    </Panel>
  );
}

/** The owner's view of the same visits, with what insurance paid and what was left to the patient. */
function OwnerVisits({ own }: { own: BillsOwn }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[30rem] text-xs">
        <caption className="pb-1 text-left font-semibold text-slate-500">Their past office visits (the visit itself, not that day's tests). Amounts: only you see these.</caption>
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500 dark:border-slate-700">
            <th className="py-1 pr-3 font-medium">Date</th><th className="py-1 pr-3 font-medium">Visit</th>
            <th className="py-1 pr-3 text-right font-medium">Copay</th><th className="py-1 pr-3 text-right font-medium">Deductible</th>
            <th className="py-1 pr-3 text-right font-medium">Coinsurance</th><th className="py-1 pr-3 text-right font-medium">Patient owed</th><th className="py-1 text-right font-medium">Insurance paid</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {own.recent.map((v) => (
            <tr key={v.date} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
              <td className="py-1 pr-3">{shortDay(v.date)}</td><td className="py-1 pr-3">{v.code}</td>
              <td className="py-1 pr-3 text-right">{v.copayCents ? usd(v.copayCents) : "–"}</td><td className="py-1 pr-3 text-right">{v.deductibleCents ? usd(v.deductibleCents) : "–"}</td>
              <td className="py-1 pr-3 text-right">{v.coinsuranceCents ? usd(v.coinsuranceCents) : "–"}</td><td className="py-1 pr-3 text-right font-semibold">{usd(v.owesCents)}</td><td className="py-1 text-right">{usd(v.paidCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <p className="min-w-0"><span className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</span><span className="text-slate-800 dark:text-slate-100">{value}</span></p>
  );
}
