import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Download, Pencil, Plus, Trash2, UserPlus, Wallet } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, ErrorNote, Loading, MetricCard, Panel, SelectBox, inputCls } from "@/components/workspace/ui";
import { downloadCsv } from "@/lib/masterBillingFiles";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { money } from "@shared/payments";
import { localDateStr } from "@shared/workforce";
import type { PayType } from "@shared/payroll";

type Payroll = RouterOutputs["masterBilling"]["payroll"];
type Row = Payroll["rows"][number];

const hrs = (m: number) => (m / 60).toFixed(2);
const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const monthName = (m: string) => new Date(`${m}-15T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });

/**
 * Payroll (owner only): each person's estimated gross pay for a month or pay period, from time-clock
 * hours and the pay rates entered here. Before taxes and deductions; QuickBooks has the official numbers.
 */
export function PayrollTab() {
  const today = localDateStr();
  const [view, setView] = useState<"month" | "period">("month");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [start, setStart] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ userId: number; name: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const q = trpc.masterBilling.payroll.useQuery(view === "month" ? { view, month } : { view, start: start ?? today });
  const d = q.data;
  const t = d?.totals;
  const live = !!d?.inProgress;

  const csv = () => {
    if (!d) return;
    downloadCsv(`payroll-${d.from}-to-${d.to}.csv`, [
      ["Employee", "Role", "Clinic", "Pay rate", "Regular hours", "Overtime hours", "Regular pay", "Overtime pay", "Salary", live ? "Estimated pay so far" : "Estimated pay", ...(live ? ["On track for"] : []), "Missed clock-outs"],
      ...d.rows.map((r) => [r.name, r.jobRoleName ?? "", r.homeClinicName ?? "", r.rate?.label ?? "no rate", hrs(r.soFar.regularMinutes), hrs(r.soFar.overtimeMinutes),
        (r.soFar.regularCents / 100).toFixed(2), (r.soFar.overtimeCents / 100).toFixed(2), (r.soFar.salaryCents / 100).toFixed(2), (r.soFar.totalCents / 100).toFixed(2),
        ...(live ? [((r.projected ?? r.soFar).totalCents / 100).toFixed(2)] : []), r.missedClockOuts]),
    ]);
  };

  const th = "px-3 py-2 text-right font-medium";
  const td = "px-3 py-2 text-right tabular-nums";
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700" role="tablist" aria-label="Month or pay period">
          {(["month", "period"] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
              className={cn("rounded-md px-3 py-1 text-sm font-medium", view === v ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "text-slate-600 dark:text-slate-300")}>
              {v === "month" ? "Month" : "Pay period"}
            </button>
          ))}
        </div>
        {view === "month" ? (
          <SelectBox value={month} onChange={setMonth} ariaLabel="Month">
            {(d?.months ?? [month]).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
          </SelectBox>
        ) : (
          <SelectBox value={start ?? d?.periods[0]?.start ?? ""} onChange={setStart} ariaLabel="Pay period">
            {(d?.periods ?? []).map((p) => <option key={p.start} value={p.start}>{day(p.start)} – {day(p.end)}</option>)}
          </SelectBox>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Btn size="sm" variant="secondary" onClick={() => setAdding(true)}><UserPlus size={13} /> Add a salaried person</Btn>
          <Btn size="sm" variant="secondary" onClick={csv} disabled={!d?.rows.length}><Download size={13} /> CSV</Btn>
        </div>
      </div>

      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {d && t && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label={live ? "Estimated pay so far" : "Estimated pay"} value={money(t.soFar.totalCents)} hint={`${day(d.from)} – ${day(live ? d.today : d.to)}`} />
            {t.projectedCents != null
              ? <MetricCard label={view === "month" ? "On track for the month" : "On track for the period"} value={money(t.projectedCents)} hint="hours so far + shifts still scheduled" />
              : <MetricCard label="Overtime pay" value={money(t.soFar.overtimeCents)} hint={`${hrs(t.soFar.overtimeMinutes)} overtime hours`} />}
            <MetricCard label="Hours worked" value={hrs(t.soFar.regularMinutes + t.soFar.overtimeMinutes)} hint={`${hrs(t.soFar.overtimeMinutes)} of them overtime`} />
            <MetricCard label="Need a look" value={String(t.missingRates + t.missedClockOuts)} tone={t.missingRates + t.missedClockOuts ? "warn" : "good"}
              hint={t.missingRates + t.missedClockOuts ? `${t.missingRates} without a pay rate · ${t.missedClockOuts} missed clock-out${t.missedClockOuts === 1 ? "" : "s"}` : "every rate set, no missed clock-outs"} />
          </div>

          <Panel title="Pay by person" bodyClassName="p-0"
            subtitle={live ? `In progress: pay so far through today, and what it's on track for with the shifts still on the schedule.` : `${day(d.from)} – ${day(d.to)}.`}>
            {d.rows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Employee</th><th className="px-3 py-2 text-left font-medium">Pay rate</th>
                      <th className={th}>Regular hrs</th><th className={th}>Overtime hrs</th><th className={th}>Regular pay</th><th className={th}>Overtime pay</th><th className={th}>Salary</th>
                      <th className={th}>{live ? "So far" : "Estimated pay"}</th>{live && <th className={th}>On track for</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((r) => <PayRow key={r.userId} r={r} live={live} rangeName={view === "month" ? "month" : "period"} td={td} onEdit={() => setEdit({ userId: r.userId, name: r.name })} />)}
                  </tbody>
                  <tfoot className="border-t-2 border-slate-200 font-semibold dark:border-slate-700">
                    <tr>
                      <td className="px-3 py-2" colSpan={2}>Total</td>
                      <td className={td}>{hrs(t.soFar.regularMinutes)}</td><td className={td}>{hrs(t.soFar.overtimeMinutes)}</td>
                      <td className={td}>{money(d.rows.reduce((s, r) => s + r.soFar.regularCents, 0))}</td><td className={td}>{money(t.soFar.overtimeCents)}</td>
                      <td className={td}>{money(d.rows.reduce((s, r) => s + r.soFar.salaryCents, 0))}</td><td className={td}>{money(t.soFar.totalCents)}</td>
                      {live && <td className={td}>{money(t.projectedCents ?? t.soFar.totalCents)}</td>}
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : <p className="px-4 py-6 text-sm text-slate-500">Nobody on the time clock in this range.</p>}
          </Panel>
          <p className="text-xs text-slate-500">
            An estimate of gross pay before taxes and deductions, from the time clock. QuickBooks Payroll has the official numbers. Hourly: hours over 40 in a Monday–Sunday week are overtime at
            1.5× (the federal rule for hourly staff who get overtime; Texas adds none). Salary: 1/12 of the yearly amount per month, 1/26 per pay period. Missed clock-outs count 0 hours until they're
            fixed on Workforce → Timesheets. &ldquo;On track for&rdquo; assumes the scheduled shifts are worked, less a 30-minute lunch on shifts over 6 hours. Confirm the overtime rules with your accountant.
          </p>
        </>
      )}

      {edit && <RateDialog who={edit} defaultStart={d?.from ?? today} onClose={() => setEdit(null)} />}
      {adding && <AddPerson existing={new Set(d?.rows.map((r) => r.userId) ?? [])} onPick={(p) => { setAdding(false); setEdit(p); }} onClose={() => setAdding(false)} />}
    </div>
  );
}

function PayRow({ r, live, rangeName, td, onEdit }: { r: Row; live: boolean; rangeName: "month" | "period"; td: string; onEdit: () => void }) {
  const p = r.projected ?? r.soFar;
  return (
    <tr className="border-t border-slate-100 dark:border-slate-700/60">
      <td className="px-3 py-2">
        <span className="font-medium text-slate-800 dark:text-slate-100">{r.name}</span>
        <span className="block text-xs text-slate-500">{[r.jobRoleName, r.homeClinicName].filter(Boolean).join(" · ") || "—"}</span>
        {r.missedClockOuts > 0 && <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300"><AlertTriangle size={11} /> {r.missedClockOuts} missed clock-out{r.missedClockOuts === 1 ? "" : "s"} (0 hours until fixed)</span>}
      </td>
      <td className="px-3 py-2">
        {r.rate ? (
          <button type="button" onClick={onEdit} title="Change or see this person's pay rates" className="whitespace-nowrap text-left text-blue-700 hover:underline dark:text-blue-300">
            <span className="inline-flex items-center gap-1">{r.rate.label} <Pencil size={11} aria-hidden /></span>
            {r.rate.payType === "hourly" && !r.rate.overtime && <span className="block text-[11px] text-slate-500">no overtime</span>}
            {r.rateChanges > 0 && <span className="block text-[11px] text-slate-500">changed this {rangeName}</span>}
          </button>
        ) : <Btn size="sm" variant="secondary" onClick={onEdit} className="whitespace-nowrap"><Wallet size={13} /> Set pay rate</Btn>}
        {r.soFar.unpricedDays > 0 && r.rate && <span className="block text-[11px] text-amber-700 dark:text-amber-300">{r.soFar.unpricedDays} day{r.soFar.unpricedDays === 1 ? "" : "s"} before the rate starts</span>}
      </td>
      <td className={td}>{hrs(r.soFar.regularMinutes)}</td>
      <td className={cn(td, r.soFar.overtimeMinutes > 0 && "font-semibold text-amber-700 dark:text-amber-300")}>{hrs(r.soFar.overtimeMinutes)}</td>
      <td className={td}>{money(r.soFar.regularCents)}</td>
      <td className={td}>{money(r.soFar.overtimeCents)}</td>
      <td className={td}>{r.soFar.salaryCents ? money(r.soFar.salaryCents) : "—"}</td>
      <td className={cn(td, "font-semibold")}>{money(r.soFar.totalCents)}</td>
      {live && <td className={td}>{money(p.totalCents)}</td>}
    </tr>
  );
}

function RateDialog({ who, defaultStart, onClose }: { who: { userId: number; name: string }; defaultStart: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const history = trpc.masterBilling.payRates.useQuery({ userId: who.userId });
  const [payType, setPayType] = useState<PayType>("hourly");
  const [amount, setAmount] = useState("");
  const [overtime, setOvertime] = useState(true);
  const [startDate, setStartDate] = useState(defaultStart);
  const [note, setNote] = useState("");
  const done = () => { void utils.masterBilling.payroll.invalidate(); void utils.masterBilling.payRates.invalidate({ userId: who.userId }); };
  const save = trpc.masterBilling.setPayRate.useMutation({ onSuccess: () => { done(); toast.success(`Pay rate saved for ${who.name}.`); onClose(); }, onError: (e) => toast.error(e.message) });
  const remove = trpc.masterBilling.removePayRate.useMutation({ onSuccess: () => { done(); toast.success("Removed."); }, onError: (e) => toast.error(e.message) });
  const cents = Math.round(Number(amount.replace(/[$,\s]/g, "")) * 100);
  const valid = Number.isFinite(cents) && cents > 0 && !!startDate;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Pay rate: {who.name}</DialogTitle>
          <DialogDescription>Only you can see pay rates. A raise is a new rate from its start date; earlier pay keeps the old rate.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate({ userId: who.userId, payType, amountCents: cents, overtime, startDate, note: note || null }); }}>
          <div className="flex gap-2" role="radiogroup" aria-label="Pay type">
            {(["hourly", "salary"] as const).map((p) => (
              <label key={p} className={cn("flex flex-1 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm", payType === p ? "border-slate-900 dark:border-slate-100" : "border-slate-200 dark:border-slate-700")}>
                <input type="radio" name="payType" checked={payType === p} onChange={() => setPayType(p)} /> {p === "hourly" ? "Hourly" : "Salary (per year)"}
              </label>
            ))}
          </div>
          <label className="block text-sm">
            <span className="text-slate-600 dark:text-slate-300">{payType === "hourly" ? "Per hour" : "Per year"}</span>
            <input className={cn(inputCls, "mt-1")} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={payType === "hourly" ? "e.g. 18.50" : "e.g. 62000"} autoFocus />
          </label>
          {payType === "hourly" && (
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input type="checkbox" checked={overtime} onChange={(e) => setOvertime(e.target.checked)} /> Gets overtime (1.5× over 40 hours a week)
            </label>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Starting</span>
              <input type="date" className={cn(inputCls, "mt-1")} value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
            <label className="block text-sm"><span className="text-slate-600 dark:text-slate-300">Note (optional)</span>
              <input className={cn(inputCls, "mt-1")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} placeholder="e.g. raise" /></label>
          </div>
          <div className="flex justify-end gap-2">
            <Btn type="button" variant="secondary" onClick={onClose}>Cancel</Btn>
            <Btn type="submit" disabled={!valid || save.isPending}><Plus size={14} /> Save rate</Btn>
          </div>
        </form>
        <div className="mt-2">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Rates on file</p>
          {history.isLoading ? <Loading /> : history.data?.length ? (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-700">
              {history.data.map((h) => (
                <li key={h.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="flex-1">{h.label}{h.payType === "hourly" && !h.overtime ? " · no overtime" : ""} <span className="text-slate-500">from {day(h.startDate)}</span>
                    {h.note && <span className="block text-xs text-slate-500">{h.note}</span>}</span>
                  <button type="button" className="text-slate-400 hover:text-rose-600" aria-label="Remove this rate" disabled={remove.isPending} onClick={() => remove.mutate({ id: h.id })}><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-500">None yet.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddPerson({ existing, onPick, onClose }: { existing: Set<number>; onPick: (p: { userId: number; name: string }) => void; onClose: () => void }) {
  const q = trpc.masterBilling.payrollPeople.useQuery();
  const people = (q.data ?? []).filter((p) => !existing.has(p.userId));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a salaried person</DialogTitle>
          <DialogDescription>Everyone on the time clock is already listed. Pick someone off the clock (for example a salaried manager) to give them a yearly salary.</DialogDescription>
        </DialogHeader>
        {q.isLoading ? <Loading /> : people.length ? (
          <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-700">
            {people.map((p) => (
              <li key={p.userId}><button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => onPick({ userId: p.userId, name: p.name ?? "Unknown" })}>
                <span>{p.name}</span><span className="text-xs text-slate-500">{p.jobRoleName ?? ""}</span></button></li>
            ))}
          </ul>
        ) : <p className="text-sm text-slate-500">Everyone with a Workforce profile is already on the list.</p>}
      </DialogContent>
    </Dialog>
  );
}
