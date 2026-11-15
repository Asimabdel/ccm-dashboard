import { useState } from "react";
import { toast } from "sonner";
import { Download, Pencil, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, ErrorNote, Loading, MetricCard, Panel, inputCls } from "@/components/workspace/ui";
import { downloadCsv } from "@/lib/masterBillingFiles";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { money } from "@shared/payments";
import { COST_CATEGORIES, COST_CATEGORY_LABELS, type CostCategory } from "@shared/costs";

type Report = RouterOutputs["masterBilling"]["costsReport"];
type Cost = Report["costs"][number];

const monthName = (m: string) => new Date(`${m}-15T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
const shortMonth = (m: string) => new Date(`${m}-15T12:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" });
const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");

/**
 * Costs (owner only): the practice's monthly bills (rent per clinic first) and money in vs. money out by month:
 * insurance payments loaded in Master Billing against estimated payroll, these costs and ZocDoc's charges.
 */
export function CostsTab() {
  const q = trpc.masterBilling.costsReport.useQuery();
  const [edit, setEdit] = useState<Cost | "new" | null>(null);
  const d = q.data;
  const done = d?.rows.filter((r) => !r.inProgress) ?? [];
  const last = done.at(-1);

  const csv = () => {
    if (!d) return;
    downloadCsv(`money-in-vs-out-${d.months[0]}-to-${d.months.at(-1)}.csv`, [
      ["Month", "Insurance paid", "Payroll (estimate)", "Rent and other costs", "ZocDoc", "Money out", "Left over", "Note"],
      ...d.rows.map((r) => [r.month, (r.insuranceCents / 100).toFixed(2), (r.payrollCents / 100).toFixed(2), (r.costsCents / 100).toFixed(2), (r.zocdocCents / 100).toFixed(2),
        (r.outCents / 100).toFixed(2), (r.leftCents / 100).toFixed(2), r.inProgress ? "month in progress" : ""]),
    ]);
  };

  const th = "px-3 py-2 text-right font-medium";
  const td = "px-3 py-2 text-right tabular-nums";
  return (
    <div className="space-y-5">
      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="Monthly costs now" value={money(d.monthlyNowCents)} hint={`${d.costs.filter((c) => c.startMonth <= d.today.slice(0, 7) && (!c.endMonth || c.endMonth >= d.today.slice(0, 7))).length} bills in ${monthName(d.today.slice(0, 7))}`} />
            {last ? <MetricCard label={`Money in, ${shortMonth(last.month)}`} value={money(last.insuranceCents)} hint="insurance payments loaded here" /> : <MetricCard label="Money in" value="—" hint="no full month yet" />}
            {last ? <MetricCard label={`Money out, ${shortMonth(last.month)}`} value={money(last.outCents)} hint="payroll + costs + ZocDoc" /> : <MetricCard label="Money out" value="—" />}
            {last ? <MetricCard label={`Left over, ${shortMonth(last.month)}`} value={money(last.leftCents)} tone={last.leftCents >= 0 ? "good" : "warn"} hint={last.leftCents >= 0 ? "before taxes and anything not listed here" : "more went out than came in"} />
              : <MetricCard label="Left over" value="—" />}
          </div>

          <Panel title="Money in vs. money out" subtitle="By month, from October 2026 (when payroll's time-clock hours start)." bodyClassName="p-0"
            action={<Btn size="sm" variant="secondary" onClick={csv}><Download size={13} /> CSV</Btn>}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Month</th><th className={th}>Insurance paid</th><th className={th}>Payroll</th><th className={th}>Rent &amp; costs</th>
                    <th className={th}>ZocDoc</th><th className={th}>Money out</th><th className={th}>Left over</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.month} className="border-t border-slate-100 dark:border-slate-700/60">
                      <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-100">{monthName(r.month)}{r.inProgress && <span className="block text-[11px] font-normal text-amber-700 dark:text-amber-300">in progress: so far</span>}</td>
                      <td className={td}>{money(r.insuranceCents)}</td>
                      <td className={td}>{money(r.payrollCents)}</td>
                      <td className={td}>{money(r.costsCents)}</td>
                      <td className={td}>{money(r.zocdocCents)}</td>
                      <td className={td}>{money(r.outCents)}</td>
                      <td className={cn(td, "font-semibold", r.leftCents < 0 ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300")}>{money(r.leftCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <p className="text-xs text-slate-500">
            Money in is only the insurance payments loaded in Master Billing (Office Ally payment files, by payment date{d.latestPaymentDate ? `, loaded through ${day(d.latestPaymentDate)}` : ""}). Insurers whose
            payment files aren&rsquo;t loaded, and what patients pay you, aren&rsquo;t in it yet. Payroll is the Payroll tab&rsquo;s estimate of gross pay (before employer taxes). ZocDoc is its
            per-booking charges by appointment date. Rent &amp; costs are the monthly bills listed below. The month in progress shows money in and payroll so far, but its full rent.
          </p>

          <Panel title="Monthly costs" subtitle="Rent and other bills paid every month. A change in amount: end the old one the month before and add the new one."
            action={<Btn size="sm" onClick={() => setEdit("new")}><Plus size={13} /> Add a cost</Btn>} bodyClassName="p-0">
            {d.costs.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Cost</th><th className="px-3 py-2 text-left font-medium">Clinic</th><th className={th}>Per month</th>
                      <th className="px-3 py-2 text-left font-medium">From</th><th className="px-3 py-2 text-left font-medium">Through</th><th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {d.costs.map((c) => (
                      <tr key={c.id} className="border-t border-slate-100 dark:border-slate-700/60">
                        <td className="px-3 py-2"><span className="font-medium text-slate-800 dark:text-slate-100">{c.name}</span>
                          <span className="block text-xs text-slate-500">{COST_CATEGORY_LABELS[c.category] ?? c.category}{c.note ? ` · ${c.note}` : ""}</span></td>
                        <td className="px-3 py-2">{c.clinicName ?? "Whole practice"}</td>
                        <td className={td}>{money(c.amountCents)}</td>
                        <td className="px-3 py-2">{shortMonth(c.startMonth)}</td>
                        <td className="px-3 py-2">{c.endMonth ? shortMonth(c.endMonth) : "ongoing"}</td>
                        <td className="px-3 py-2 text-right"><button type="button" className="text-blue-700 hover:underline dark:text-blue-300" onClick={() => setEdit(c)} aria-label={`Change ${c.name}`}><Pencil size={14} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t-2 border-slate-200 font-semibold dark:border-slate-700">
                    <tr><td className="px-3 py-2" colSpan={2}>This month</td><td className={td}>{money(d.monthlyNowCents)}</td><td colSpan={3} /></tr>
                  </tfoot>
                </table>
              </div>
            ) : <p className="px-4 py-6 text-sm text-slate-500">No costs yet. Add each clinic&rsquo;s rent to start.</p>}
          </Panel>

          {d.byClinic.length > 0 && (
            <Panel title="By clinic" subtitle={`${shortMonth(d.months[0]!)} – ${shortMonth(d.months.at(-1)!)}: each clinic's insurance payments next to its own costs (payroll and ZocDoc aren't split by clinic).`} bodyClassName="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr><th className="px-3 py-2 text-left font-medium">Clinic</th><th className={th}>Costs per month now</th><th className={th}>Insurance paid</th><th className={th}>Costs</th><th className={th}>Costs as % of insurance</th></tr>
                  </thead>
                  <tbody>
                    {d.byClinic.map((c) => (
                      <tr key={c.key} className="border-t border-slate-100 dark:border-slate-700/60">
                        <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-100">{c.name}</td>
                        <td className={td}>{c.monthlyNowCents ? money(c.monthlyNowCents) : "—"}</td>
                        <td className={td}>{money(c.insuranceCents)}</td>
                        <td className={td}>{money(c.costsCents)}</td>
                        <td className={td}>{c.costsCents ? pct(c.costsCents, c.insuranceCents) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}
      {edit && d && <CostDialog cost={edit === "new" ? null : edit} clinics={d.clinics} thisMonth={d.today.slice(0, 7)} onClose={() => setEdit(null)} />}
    </div>
  );
}

function CostDialog({ cost, clinics, thisMonth, onClose }: { cost: Cost | null; clinics: { id: number; name: string }[]; thisMonth: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(cost?.name ?? "Rent");
  const [category, setCategory] = useState<CostCategory>(cost?.category ?? "rent");
  const [clinicId, setClinicId] = useState<string>(cost ? String(cost.clinicId ?? "") : "");
  const [amount, setAmount] = useState(cost ? String(cost.amountCents / 100) : "");
  const [startMonth, setStartMonth] = useState(cost?.startMonth ?? thisMonth);
  const [endMonth, setEndMonth] = useState(cost?.endMonth ?? "");
  const [note, setNote] = useState(cost?.note ?? "");
  const done = () => { void utils.masterBilling.costsReport.invalidate(); onClose(); };
  const save = trpc.masterBilling.saveCost.useMutation({ onSuccess: () => { toast.success("Saved."); done(); }, onError: (e) => toast.error(e.message) });
  const remove = trpc.masterBilling.removeCost.useMutation({ onSuccess: () => { toast.success("Removed."); done(); }, onError: (e) => toast.error(e.message) });
  const cents = Math.round(Number(amount.replace(/[$,\s]/g, "")) * 100);
  const valid = !!name.trim() && Number.isFinite(cents) && cents > 0 && /^\d{4}-\d{2}$/.test(startMonth) && (!endMonth || endMonth >= startMonth);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{cost ? `Change: ${cost.name}` : "Add a monthly cost"}</DialogTitle>
          <DialogDescription>Only you can see this. It counts every month from the first month through the last (leave the last month empty if it&rsquo;s ongoing).</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate({ id: cost?.id ?? null, name: name.trim(), category, clinicId: clinicId ? Number(clinicId) : null, amountCents: cents, startMonth, endMonth: endMonth || null, note: note || null });
        }}>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Name</span>
              <input className={cn(inputCls, "mt-1")} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Rent" /></label>
            <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Kind</span>
              <select aria-label="Kind" className={cn(inputCls, "mt-1")} value={category} onChange={(e) => setCategory(e.target.value as CostCategory)}>
                {COST_CATEGORIES.map((c) => <option key={c} value={c}>{COST_CATEGORY_LABELS[c]}</option>)}
              </select></label>
            <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Clinic</span>
              <select aria-label="Clinic" className={cn(inputCls, "mt-1")} value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
                <option value="">Whole practice</option>
                {clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
            <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Per month</span>
              <input className={cn(inputCls, "mt-1")} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 3000" autoFocus /></label>
            <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">First month</span>
              <input type="month" aria-label="First month" className={cn(inputCls, "mt-1")} value={startMonth} onChange={(e) => setStartMonth(e.target.value)} /></label>
            <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Last month (optional)</span>
              <input type="month" aria-label="Last month" className={cn(inputCls, "mt-1")} value={endMonth} onChange={(e) => setEndMonth(e.target.value)} /></label>
          </div>
          <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Note (optional)</span>
            <input className={cn(inputCls, "mt-1")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} placeholder="e.g. lease ends June 2027" /></label>
          <div className="flex items-center justify-between gap-2">
            {cost ? <Btn type="button" variant="danger" size="sm" disabled={remove.isPending} onClick={() => remove.mutate({ id: cost.id })}><Trash2 size={13} /> Remove</Btn> : <span />}
            <div className="flex gap-2">
              <Btn type="button" variant="secondary" onClick={onClose}>Cancel</Btn>
              <Btn type="submit" disabled={!valid || save.isPending}>Save</Btn>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
