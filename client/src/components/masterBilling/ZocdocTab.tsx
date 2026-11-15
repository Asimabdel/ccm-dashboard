import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { CalendarCheck, Download, ExternalLink, FileUp, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, EmptyState, ErrorNote, Loading, MetricCard, Panel, SelectBox } from "@/components/workspace/ui";
import { downloadCsv, niceName, readTableFile } from "@/lib/masterBillingFiles";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { headerSignature } from "@shared/billSheet";
import { addDays, money } from "@shared/payments";
import { localDateStr } from "@shared/workforce";
import {
  CAME_IN_DAYS, ZOCDOC_FIELDS, ZOCDOC_FIELD_KEYS, ZOCDOC_LOST_REASONS, ZOCDOC_OUTCOME_LABELS, ZOCDOC_STATUS_LABELS, parseZocdocRows,
  type ZLostReason, type ZOutcome, type ZocdocField, type ZocdocMapping, type ZocdocPatientFilter,
} from "@shared/zocdoc";

type Report = RouterOutputs["masterBilling"]["zocdocReport"];
type ZRow = Report["months"][number];
type LostRow = Report["lost"]["months"][number];
type Filter = ZocdocPatientFilter;

type Preset = "ytd" | "12m" | "3m" | "lastMonth" | "month" | "all";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "ytd", label: "This year" }, { key: "12m", label: "Last 12 months" }, { key: "3m", label: "Last 3 months" },
  { key: "lastMonth", label: "Last month" }, { key: "month", label: "This month" }, { key: "all", label: "Everything" },
];
function presetRange(p: Preset, today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const first = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  switch (p) {
    case "ytd": return { from: `${y}-01-01`, to: today };
    case "12m": return { from: addDays(today, -365), to: today };
    case "3m": return { from: addDays(today, -91), to: today };
    case "month": return { from: first(y, m), to: today };
    case "lastMonth": { const ly = m === 1 ? y - 1 : y; const lm = m === 1 ? 12 : m - 1; return { from: first(ly, lm), to: addDays(first(y, m), -1) }; }
    case "all": return { from: "2000-01-01", to: addDays(today, 365) };
  }
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Everyone" }, { key: "never", label: "Never came in (money lost)" }, { key: "seen_no_payment", label: "Seen, no insurance payment found" },
  { key: "came_later", label: `Came in after ${CAME_IN_DAYS} days` }, { key: "upcoming", label: "Has a visit booked" }, { key: "no_visit", label: `No billed visit within ${CAME_IN_DAYS} days` },
  { key: "practice_canceled", label: "Charged, practice canceled" }, { key: "not_matched", label: "Not found in MyPCP" }, { key: "already_ours", label: "Already our patient" },
  { key: "came_in", label: "Came in" },
];
const REASON_LABEL = Object.fromEntries(ZOCDOC_LOST_REASONS.map((r) => [r.key, r.label])) as Record<ZLostReason, string>;
const OUTCOME_TONE: Record<ZOutcome, string> = {
  came_in: "text-emerald-700 dark:text-emerald-300", came_later: "text-emerald-700 dark:text-emerald-300", pending: "text-slate-400",
  seen_no_payment: "text-amber-700 dark:text-amber-300", upcoming: "text-blue-700 dark:text-blue-300", never: "text-rose-700 dark:text-rose-300",
};

const day = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const monthLabel = (m: string) => (/^\d{4}-\d{2}$/.test(m) ? new Date(`${m}-15T12:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : m);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const ratio = (paid: number, spent: number) => (spent ? `$${(paid / spent).toFixed(2)}` : "—");
const th = "px-3 py-2 text-right font-medium";
const td = "px-3 py-2 text-right tabular-nums";

/**
 * ZocDoc (owner only): what ZocDoc cost and what the patients it booked brought in. ZocDoc has no data feed,
 * so its "Appointment report" download is uploaded here; insurance payments come from Master Billing's claims.
 */
export function ZocdocTab() {
  const today = localDateStr();
  const [preset, setPreset] = useState<Preset | "custom">("ytd");
  const [range, setRange] = useState(presetRange("ytd", today));
  const [upload, setUpload] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const patientsRef = useRef<HTMLDivElement>(null);
  const q = trpc.masterBilling.zocdocReport.useQuery(range);
  const d = q.data;
  const t = d?.totals;
  const showPatients = (f: Filter) => { setFilter(f); setTimeout(() => patientsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); };

  const monthsCsv = () => d && downloadCsv(`zocdoc-by-month-${range.from}-to-${range.to}.csv`, [
    ["Month", "Bookings", "Charged bookings", "ZocDoc cost", "New patients charged", "Came in", "Judged so far", "Insurance paid", "Patient responsibility", "Insurance per $1"],
    ...d.months.map((m) => [m.key, m.bookings, m.chargedBookings, (m.costCents / 100).toFixed(2), m.patients, m.cameIn, m.judged, (m.paidCents / 100).toFixed(2), (m.owesCents / 100).toFixed(2), m.costCents ? (m.paidCents / m.costCents).toFixed(2) : ""]),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => <Btn key={p.key} size="sm" variant={preset === p.key ? "primary" : "secondary"} onClick={() => { setPreset(p.key); setRange(presetRange(p.key, today)); }}>{p.label}</Btn>)}
        <input type="date" value={range.from} max={range.to} onChange={(e) => { if (e.target.value) { setPreset("custom"); setRange((r) => ({ ...r, from: e.target.value })); } }} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800" aria-label="From" />
        <span className="text-sm text-slate-400">to</span>
        <input type="date" value={range.to} min={range.from} onChange={(e) => { if (e.target.value) { setPreset("custom"); setRange((r) => ({ ...r, to: e.target.value })); } }} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800" aria-label="To" />
        <div className="ml-auto"><Btn size="sm" onClick={() => setUpload(true)}><FileUp size={13} /> Upload ZocDoc report</Btn></div>
      </div>

      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {d && !d.bookingsOnFile && (
        <Panel>
          <EmptyState icon={CalendarCheck} title="No ZocDoc report uploaded yet"
            body={<>In ZocDoc, open <b>Performance → Appointment report</b>, pick the dates (for example this year), and click <b>Download</b>. Upload that file here. Uploading again later is safe: the same bookings are updated, never counted twice.</>}
            action={<Btn onClick={() => setUpload(true)}><FileUp size={15} /> Upload ZocDoc report</Btn>} />
        </Panel>
      )}
      {d && t && d.bookingsOnFile > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="Spent on ZocDoc" value={money(t.spentCents)} hint={`${t.chargedBookings.toLocaleString()} charged of ${t.bookings.toLocaleString()} bookings`} />
            <MetricCard label="New patients ZocDoc charged for" value={t.chargedPatients.toLocaleString()} hint={`${t.matchedPatients.toLocaleString()} found in MyPCP`} />
            <MetricCard label="Came in" value={pct(t.cameIn, t.judged)} tone={t.judged && t.cameIn / t.judged < 0.5 ? "warn" : "neutral"}
              hint={`${t.cameIn.toLocaleString()} of ${t.judged.toLocaleString()} had a billed visit within ${CAME_IN_DAYS} days${t.pending ? ` · ${t.pending} too recent to tell` : ""}`} />
            <MetricCard label="Insurance paid" value={money(t.paidCents)} tone="good" hint={`${money(t.paidFirstCents)} first visits · ${money(t.paidLaterCents)} later visits`} />
            <MetricCard label="Insurance per $1 spent" value={ratio(t.paidCents, t.spentCents)} tone={t.spentCents && t.paidCents >= t.spentCents ? "good" : "warn"} hint="insurance paid ÷ ZocDoc cost" />
            <MetricCard label="Cost per patient who came in" value={t.cameIn ? money(Math.round(t.spentCents / t.cameIn)) : "—"} hint="ZocDoc cost ÷ patients with a billed visit" />
            <MetricCard label="Billed to the patients" value={money(t.owesCents)} hint="deductibles / copays (what was collected isn't tracked)" />
            <MetricCard label="Already our patients" value={t.alreadyOurs.toLocaleString()} tone={t.alreadyOurs ? "warn" : "neutral"} hint="charged as new, but had a visit before" />
          </div>

          <MoneyLost lost={d.lost} spentCents={t.spentCents} noVisit={d.leaks.noVisit.patients} onShow={showPatients} />

          <Panel title="By month booked" bodyClassName="p-0" action={<Btn size="sm" variant="secondary" onClick={monthsCsv}><Download size={13} /> CSV</Btn>}
            subtitle={`Cost by each booking's month; patients and insurance by the month of their first ZocDoc booking. Recent months fill in as insurance pays (Master Billing has payments through the last Office Ally upload).`}>
            <ZTable rows={d.months} label="Month" fmt={monthLabel} totals={t} />
          </Panel>

          <Panel title="Charges worth a look" subtitle="Per booking, whether or not the patient came in later. Click one to see the patients.">
            <div className="grid gap-3 md:grid-cols-2">
              <Leak title="Charged, but the practice canceled" count={d.leaks.practiceCanceled.bookings} unit="booking" cents={d.leaks.practiceCanceled.costCents} onClick={() => showPatients("practice_canceled")}
                note="Worth asking ZocDoc about: the practice canceled these bookings and was still charged." />
              <Leak title="Charged, but the patient canceled" count={d.leaks.patientCanceled.bookings} unit="booking" cents={d.leaks.patientCanceled.costCents}
                note="The patient canceled and ZocDoc still charged. Some of them booked again and came in." />
              <Leak title="Charged as new, but already our patient" count={d.leaks.alreadyOurs.patients} unit="patient" cents={d.leaks.alreadyOurs.costCents} onClick={() => showPatients("already_ours")}
                note="Insurance paid us for a visit before their first ZocDoc booking. Worth asking ZocDoc about." />
              {d.leaks.cancellationCharges.bookings > 0 && <Leak title="Cancellation charges" count={d.leaks.cancellationCharges.bookings} unit="booking" cents={d.leaks.cancellationCharges.costCents}
                note="ZocDoc's own reason says the charge was for a cancellation." />}
              {d.leaks.noShow.bookings > 0 && <Leak title="Charged no-shows" count={d.leaks.noShow.bookings} unit="booking" cents={d.leaks.noShow.costCents} note="Marked as a no-show in ZocDoc." />}
            </div>
          </Panel>

          <div className="grid gap-5 xl:grid-cols-2">
            <Panel title="By provider" bodyClassName="p-0"><ZTable rows={d.providers} label="Provider" compact /></Panel>
            <Panel title="By insurance (as booked)" bodyClassName="p-0"><ZTable rows={d.insurances} label="Insurance" compact /></Panel>
          </div>

          <div ref={patientsRef}><Patients range={range} filter={filter} setFilter={setFilter} /></div>

          <p className="text-xs text-slate-500">
            Spend is ZocDoc&apos;s cost per booking from its report (invoices can differ a little by credits). Patients are matched to MyPCP by name and date of birth. Insurance paid counts every claim
            for a patient from their first ZocDoc booking on, from Office Ally payment files in Master Billing. These totals are revenue, not profit: provider time, staff and supplies aren&apos;t taken out.
            {d.lastUpload ? ` Last ZocDoc upload: ${d.lastUpload.fileName}, ${new Date(d.lastUpload.createdAt).toLocaleDateString()}.` : ""}
          </p>
        </>
      )}

      {upload && <ZocdocUpload onClose={() => setUpload(false)} />}
    </div>
  );
}

function ZTable({ rows, label, fmt, totals, compact }: { rows: ZRow[]; label: string; fmt?: (k: string) => string; totals?: Report["totals"]; compact?: boolean }) {
  if (!rows.length) return <p className="px-4 py-6 text-sm text-slate-500">Nothing in this range.</p>;
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full text-sm", compact ? "min-w-[560px]" : "min-w-[900px]")}>
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
          <tr>
            <th className="px-3 py-2 text-left font-medium">{label}</th>
            {!compact && <th className={th}>Bookings</th>}<th className={th}>Charged</th><th className={th}>Cost</th><th className={th}>New pts</th><th className={th}>Came in</th>
            <th className={th}>Insurance paid</th>{!compact && <th className={th}>Billed to patients</th>}<th className={th}>Per $1</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-slate-100 dark:border-slate-700/60">
              <td className="px-3 py-2">{fmt ? fmt(r.key) : r.key}</td>
              {!compact && <td className={td}>{r.bookings.toLocaleString()}</td>}<td className={td}>{r.chargedBookings.toLocaleString()}</td><td className={td}>{money(r.costCents)}</td>
              <td className={td}>{r.patients.toLocaleString()}</td>
              <td className={td}>{r.judged ? `${r.cameIn.toLocaleString()} (${pct(r.cameIn, r.judged)})` : r.patients ? "too soon" : "—"}</td>
              <td className={td}>{money(r.paidCents)}</td>{!compact && <td className={td}>{money(r.owesCents)}</td>}<td className={td}>{ratio(r.paidCents, r.costCents)}</td>
            </tr>
          ))}
        </tbody>
        {totals && (
          <tfoot className="border-t-2 border-slate-200 font-semibold dark:border-slate-700">
            <tr>
              <td className="px-3 py-2">Total</td>
              {!compact && <td className={td}>{totals.bookings.toLocaleString()}</td>}<td className={td}>{totals.chargedBookings.toLocaleString()}</td><td className={td}>{money(totals.spentCents)}</td>
              <td className={td}>{totals.chargedPatients.toLocaleString()}</td><td className={td}>{`${totals.cameIn.toLocaleString()} (${pct(totals.cameIn, totals.judged)})`}</td>
              <td className={td}>{money(totals.paidCents)}</td>{!compact && <td className={td}>{money(totals.owesCents)}</td>}<td className={td}>{ratio(totals.paidCents, totals.spentCents)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** What ZocDoc was paid for new patients who never came in at all, and why. */
function MoneyLost({ lost, spentCents, noVisit, onShow }: { lost: Report["lost"]; spentCents: number; noVisit: number; onShow: (f: Filter) => void }) {
  const csv = () => downloadCsv("zocdoc-money-lost-by-month.csv", [
    ["Month of first booking", "New patients charged (window over)", "Never came in", "Share never came", "ZocDoc cost lost"],
    ...lost.months.map((m) => [m.key, m.judged, m.lost, m.judged ? (m.lost / m.judged).toFixed(3) : "", (m.costCents / 100).toFixed(2)]),
  ]);
  const notLost: { key: "came_later" | "seen_no_payment" | "upcoming"; note: string }[] = [
    { key: "seen_no_payment", note: "on our schedule or in the chart; check the claim was sent and paid" },
    { key: "came_later", note: "a billed visit, just later" },
    { key: "upcoming", note: "on our schedule; not lost yet" },
  ];
  const maxReason = Math.max(1, ...lost.reasons.map((r) => r.costCents));
  return (
    <Panel title="Money lost: paid ZocDoc, patient never came"
      subtitle={`New patients ZocDoc charged for with no billed visit, no visit on our schedule or in the Practice Fusion chart, and nothing booked since. Only counts people booked at least ${CAME_IN_DAYS} days ago.`}
      action={<Btn size="sm" variant="secondary" onClick={() => onShow("never")}>See these patients</Btn>}>
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricCard label="Money lost" value={money(lost.costCents)} tone={lost.costCents ? "bad" : "neutral"} hint={`${pct(lost.costCents, spentCents)} of what ZocDoc cost`} />
          <MetricCard label="Never came in" value={lost.patients.toLocaleString()} tone={lost.judged && lost.patients / lost.judged > 0.3 ? "bad" : "neutral"}
            hint={`${pct(lost.patients, lost.judged)} of ${lost.judged.toLocaleString()} new patients charged`} />
          <MetricCard label="Not in MyPCP at all" value={lost.notInMyPcp.toLocaleString()} hint="never became a patient of the practice" />
          <MetricCard label="No-show on our schedule" value={lost.noShowOnSchedule.toLocaleString()} hint="booked with us too, didn't come" />
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Why they never came (their last ZocDoc booking)</p>
            <ul className="space-y-2">
              {ZOCDOC_LOST_REASONS.map((r) => {
                const row = lost.reasons.find((x) => x.key === r.key) ?? { patients: 0, costCents: 0 };
                return (
                  <li key={r.key}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-slate-700 dark:text-slate-200">{r.label}</span>
                      <span className="shrink-0 tabular-nums text-slate-900 dark:text-slate-50">{money(row.costCents)} <span className="text-xs text-slate-500">· {row.patients.toLocaleString()}</span></span>
                    </div>
                    <div className="mt-1 h-2 rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-2 rounded-full bg-rose-500/80" style={{ width: `${(row.costCents / maxReason) * 100}%` }} /></div>
                    <p className="mt-0.5 text-xs text-slate-500">{r.note}</p>
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Not counted as lost</p>
            <p className="mb-2 text-xs text-slate-500">{noVisit.toLocaleString()} charged new patients had no billed visit within {CAME_IN_DAYS} days. Besides the {lost.patients.toLocaleString()} who never came:</p>
            <div className="space-y-2">
              {notLost.map((n) => (
                <button key={n.key} type="button" onClick={() => onShow(n.key)}
                  className="flex w-full items-baseline justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/40">
                  <span><span className="text-slate-700 dark:text-slate-200">{ZOCDOC_OUTCOME_LABELS[n.key]}</span><span className="block text-xs text-slate-500">{n.note}</span></span>
                  <span className="shrink-0 tabular-nums font-medium text-slate-900 dark:text-slate-50">{lost.notLost[n.key].patients.toLocaleString()}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">By month of first booking</p>
            <Btn size="sm" variant="secondary" onClick={csv}><Download size={13} /> CSV</Btn>
          </div>
          <LostTable rows={lost.months} label="Month" fmt={monthLabel} bars />
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          <div><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">By provider booked</p><LostTable rows={lost.providers} label="Provider" top={10} /></div>
          <div><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">By insurance (as booked)</p><LostTable rows={lost.insurances} label="Insurance" top={10} /></div>
        </div>
      </div>
    </Panel>
  );
}

function LostTable({ rows, label, fmt, bars, top }: { rows: LostRow[]; label: string; fmt?: (k: string) => string; bars?: boolean; top?: number }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return <p className="py-3 text-sm text-slate-500">Nothing in this range yet.</p>;
  const shown = top && !all ? rows.slice(0, top) : rows;
  const max = Math.max(1, ...rows.map((r) => r.costCents));
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-100 dark:border-slate-700/60">
      <table className="w-full min-w-[480px] text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
          <tr><th className="px-3 py-2 text-left font-medium">{label}</th><th className={th}>New pts</th><th className={th}>Never came</th><th className={th}>Money lost</th>{bars && <th className="w-1/4 px-3 py-2" />}</tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.key} className="border-t border-slate-100 dark:border-slate-700/60">
              <td className="px-3 py-2">{fmt ? fmt(r.key) : r.key}</td>
              <td className={td}>{r.judged.toLocaleString()}</td>
              <td className={td}>{r.lost.toLocaleString()} <span className="text-xs text-slate-500">({pct(r.lost, r.judged)})</span></td>
              <td className={td}>{money(r.costCents)}</td>
              {bars && <td className="px-3 py-2"><div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-2 rounded-full bg-rose-500/80" style={{ width: `${(r.costCents / max) * 100}%` }} /></div></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {top && rows.length > top && (
        <button type="button" onClick={() => setAll((x) => !x)} className="w-full border-t border-slate-100 px-3 py-2 text-xs font-medium text-blue-700 hover:bg-slate-50 dark:border-slate-700/60 dark:text-blue-300 dark:hover:bg-slate-800/40">
          {all ? "Show the top 10" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

function Leak({ title, count, unit, cents, note, onClick }: { title: string; count: number; unit: string; cents: number; note: string; onClick?: () => void }) {
  const body = (
    <>
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50">{money(cents)} <span className="text-sm font-normal text-slate-500">· {count.toLocaleString()} {unit}{count === 1 ? "" : "s"}</span></p>
      <p className="mt-1 text-xs text-slate-500">{note}</p>
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} className="rounded-xl border border-slate-200 p-3 text-left hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/40">{body}</button>
    : <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">{body}</div>;
}

function Patients({ range, filter, setFilter }: { range: { from: string; to: string }; filter: Filter; setFilter: (f: Filter) => void }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [filter, range.from, range.to]);
  const q = trpc.masterBilling.zocdocPatients.useQuery({ ...range, filter, page });
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;

  const csv = async () => {
    setBusy(true);
    try {
      const all: NonNullable<typeof d>["rows"] = [];
      for (let p = 1; ; p++) {
        const r = await utils.masterBilling.zocdocPatients.fetch({ ...range, filter, page: p });
        all.push(...r.rows);
        if (p * r.pageSize >= r.total) break;
      }
      downloadCsv(`zocdoc-patients-${filter}-${range.from}-to-${range.to}.csv`, [
        ["Patient", "Date of birth", "First ZocDoc date", "Bookings", "Charged bookings", "ZocDoc cost", "Statuses", "In MyPCP", "Outcome", "Why (never came)", "No-show on our schedule", "Insurance paid", "Billed to patient", "Provider", "Insurance"],
        ...all.map((r) => [niceName(r.name), r.dob ?? "", r.firstDate, r.bookings, r.chargedBookings, (r.costCents / 100).toFixed(2), r.statuses.map((s) => ZOCDOC_STATUS_LABELS[s]).join("; "),
          r.matched ? "yes" : "no", ZOCDOC_OUTCOME_LABELS[r.outcome], r.lostReason ? REASON_LABEL[r.lostReason] : "", r.noShowOnSchedule ? "yes" : "",
          ((r.paidFirstCents + r.paidLaterCents) / 100).toFixed(2), (r.owesCents / 100).toFixed(2), r.provider ?? "", r.insurance ?? ""]),
      ]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Patients" bodyClassName="p-0"
      action={(
        <div className="flex items-center gap-2">
          <SelectBox value={filter} onChange={(v) => setFilter(v as Filter)} ariaLabel="Which patients">{FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</SelectBox>
          <Btn size="sm" variant="secondary" onClick={() => void csv()} disabled={busy || !d?.total}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} CSV</Btn>
        </div>
      )}
      subtitle={d ? `${d.total.toLocaleString()} patient${d.total === 1 ? "" : "s"}` : undefined}>
      {q.isLoading && <Loading />}
      {q.error && <div className="p-4"><ErrorNote message={q.error.message} /></div>}
      {d && (d.rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Patient</th><th className="px-3 py-2 text-left font-medium">First ZocDoc date</th><th className="px-3 py-2 text-left font-medium">ZocDoc status</th>
                <th className={th}>Charged</th><th className="px-3 py-2 text-left font-medium">Outcome</th><th className={th}>Insurance paid</th><th className="px-3 py-2 text-left font-medium">Provider</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.person} className="border-t border-slate-100 dark:border-slate-700/60">
                  <td className="px-3 py-2">
                    {r.subjectKey
                      ? <Link href={`/patients/${encodeURIComponent(r.subjectKey)}`} className="inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-300">{niceName(r.name)} <ExternalLink size={12} /></Link>
                      : <span>{niceName(r.name)} <span className="text-xs text-amber-700 dark:text-amber-300">not in MyPCP</span></span>}
                    <span className="block text-xs text-slate-400">{r.dob ? `DOB ${day(r.dob)}` : "no date of birth in the file"}{r.alreadyOurs ? " · already our patient" : ""}</span>
                  </td>
                  <td className="px-3 py-2">{day(r.firstDate)}{r.bookings > 1 ? <span className="text-xs text-slate-400"> · {r.bookings} bookings</span> : null}</td>
                  <td className="px-3 py-2 text-xs">{Array.from(new Set(r.statuses)).map((s) => ZOCDOC_STATUS_LABELS[s]).join(", ")}</td>
                  <td className={td}>{r.costCents ? money(r.costCents) : "—"}</td>
                  <td className="px-3 py-2">
                    <span className={OUTCOME_TONE[r.outcome]}>{ZOCDOC_OUTCOME_LABELS[r.outcome]}</span>
                    {(r.lostReason || r.noShowOnSchedule) && <span className="block text-xs text-slate-400">{[r.lostReason ? REASON_LABEL[r.lostReason] : null, r.noShowOnSchedule ? "no-show on our schedule" : null].filter(Boolean).join(" · ")}</span>}
                  </td>
                  <td className={td}>{money(r.paidFirstCents + r.paidLaterCents)}</td>
                  <td className="px-3 py-2 text-xs">{r.provider ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-3 py-2 text-sm dark:border-slate-700">
              <Btn size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Btn>
              <span className="text-slate-500">Page {page} of {pages}</span>
              <Btn size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Btn>
            </div>
          )}
        </div>
      ) : <p className="px-4 py-6 text-sm text-slate-500">Nobody here.</p>)}
    </Panel>
  );
}

const CHUNK = 500;

/** Pick ZocDoc's Appointment report (CSV or Excel), check the columns, save. */
function ZocdocUpload({ onClose }: { onClose: () => void }) {
  const utils = trpc.useUtils();
  const [file, setFile] = useState<{ name: string; sha256: string; rows: string[][] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState<ZocdocMapping | null>(null);
  const [showCols, setShowCols] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; matched: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const start = trpc.masterBilling.zocdocImportStart.useMutation();
  const send = trpc.masterBilling.zocdocImportRows.useMutation();
  const saveMap = trpc.masterBilling.saveSheetMapping.useMutation();

  const parsed = useMemo(() => (file ? parseZocdocRows(file.rows, override ?? undefined) : null), [file, override]);
  const signature = parsed ? `zocdoc|${headerSignature(parsed.headers)}` : "";
  const saved = trpc.masterBilling.sheetMapping.useQuery({ signature: signature.slice(0, 600) }, { enabled: !!parsed, staleTime: Infinity });
  useEffect(() => {
    // -1 = "not in this file" (kept, so it isn't re-detected); fields the saved mapping doesn't list are detected.
    if (saved.data && !override) setOverride(Object.fromEntries(Object.entries(saved.data as Record<string, number>).map(([k, v]) => [k, v >= 0 ? v : undefined])) as ZocdocMapping);
  }, [saved.data, override]);
  const mapping = parsed?.mapping ?? {};
  const rows = parsed?.rows ?? [];
  const dates = rows.map((r) => r.appointmentDate).sort();
  const charged = rows.filter((r) => r.costCents > 0);
  const blocking = parsed ? parsed.missing.filter((f) => f === "patientName" || f === "appointmentDate") : [];

  const pick = async (f: File | undefined) => {
    setError(null); setFile(null); setOverride(null); setProgress(null);
    if (!f) return;
    const r = await readTableFile(f);
    if ("error" in r) setError(r.error); else setFile(r);
  };
  const choose = (field: ZocdocField, col: number) => setOverride({ ...mapping, [field]: col < 0 ? undefined : col });

  const save = async () => {
    if (!file || !parsed || !rows.length) return;
    setSaving(true);
    try {
      const s = await start.mutateAsync({ fileName: file.name, sha256: file.sha256, rowCount: rows.length, firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null });
      let matched = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const r = await send.mutateAsync({ importId: s.importId, rows: rows.slice(i, i + CHUNK) });
        matched += r.matched;
        setProgress({ done: Math.min(rows.length, i + CHUNK), total: rows.length, matched });
      }
      if (override) await saveMap.mutateAsync({ signature: signature.slice(0, 600), mapping: Object.fromEntries(Object.entries(override).map(([k, v]) => [k, v ?? -1])) });
      await Promise.all([utils.masterBilling.zocdocReport.invalidate(), utils.masterBilling.zocdocPatients.invalidate(), utils.masterBilling.zocdocImports.invalidate()]);
      toast.success(`Saved ${rows.length.toLocaleString()} ZocDoc bookings (${matched.toLocaleString()} matched to a MyPCP patient).${s.seenBefore ? " This same file was uploaded before; its bookings were just updated." : ""}`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Upload ZocDoc report</DialogTitle>
          <DialogDescription>
            In ZocDoc: Performance → Appointment report → pick the dates → Download. Pick that file here (CSV or Excel). The same booking in a later upload is updated, not counted twice.
          </DialogDescription>
        </DialogHeader>
        <input type="file" accept=".csv,.xlsx,.txt" disabled={saving} onChange={(e) => void pick(e.target.files?.[0])} className="text-sm" aria-label="ZocDoc report file" />
        {error && <ErrorNote message={error} />}
        {parsed && (
          <div className="space-y-2 text-sm">
            <p className="text-slate-700 dark:text-slate-200">
              {rows.length.toLocaleString()} booking{rows.length === 1 ? "" : "s"}{dates.length ? `, ${day(dates[0])} – ${day(dates.at(-1))}` : ""} · {charged.length.toLocaleString()} charged · {money(charged.reduce((s, r) => s + r.costCents, 0))}
              {parsed.skipped ? <span className="text-slate-500"> · {parsed.skipped} row{parsed.skipped === 1 ? "" : "s"} skipped (no patient or no date)</span> : null}
            </p>
            {blocking.length > 0 && <p className="text-amber-700 dark:text-amber-300">Pick the {blocking.map((f) => ZOCDOC_FIELDS[f].toLowerCase()).join(" and the ")} column below.</p>}
            {parsed.missing.includes("cost") && <p className="text-amber-700 dark:text-amber-300">No cost column found: spend will show $0 unless you pick it below.</p>}
            {parsed.missing.includes("dob") && <p className="text-amber-700 dark:text-amber-300">No date of birth found: patients can&apos;t be matched to MyPCP (and their insurance payments) without it.</p>}
            <button type="button" className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-300" onClick={() => setShowCols((x) => !x)}>{showCols ? "Hide columns" : "Check the columns"}</button>
            {showCols && (
              <div className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                {ZOCDOC_FIELD_KEYS.map((k) => (
                  <label key={k} className="text-xs text-slate-500">
                    {ZOCDOC_FIELDS[k]}
                    <SelectBox value={String(mapping[k] ?? -1)} onChange={(v) => choose(k, Number(v))} className="mt-0.5 w-full" ariaLabel={ZOCDOC_FIELDS[k]}>
                      <option value="-1">— not in this file —</option>
                      {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                    </SelectBox>
                  </label>
                ))}
              </div>
            )}
            {rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-slate-400"><tr><th className="py-1 text-left font-medium">Patient</th><th className="text-left font-medium">DOB</th><th className="text-left font-medium">Appointment</th><th className="text-left font-medium">Status</th><th className="text-left font-medium">Type</th><th className="text-right font-medium">Cost</th></tr></thead>
                  <tbody>
                    {rows.slice(0, 5).map((r, i) => (
                      <tr key={i} className="border-t border-slate-100 dark:border-slate-700/60">
                        <td className="py-1">{niceName(`${r.patientFirst ?? ""} ${r.patientLast ?? ""}`.trim())}</td><td>{r.patientDob ?? "—"}</td><td>{r.appointmentAt}</td>
                        <td>{ZOCDOC_STATUS_LABELS[r.status]}{r.statusText && ZOCDOC_STATUS_LABELS[r.status] === "Other" ? ` (${r.statusText})` : ""}</td><td>{r.patientType ?? "—"}</td><td className="text-right">{money(r.costCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > 5 && <p className="mt-1 text-xs text-slate-400">…and {(rows.length - 5).toLocaleString()} more</p>}
              </div>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-3 pt-2">
          <p className="text-xs text-slate-500">{progress ? `Saving… ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}` : "Phone numbers, emails and addresses in the file are not saved."}</p>
          <div className="flex gap-2">
            <Btn variant="secondary" onClick={onClose} disabled={saving}>Cancel</Btn>
            <Btn onClick={() => void save()} disabled={saving || !rows.length || blocking.length > 0}>{saving ? <Loader2 size={14} className="animate-spin" /> : null} Save {rows.length ? rows.length.toLocaleString() : ""} bookings</Btn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
