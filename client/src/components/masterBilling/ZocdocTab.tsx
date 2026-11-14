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
import { CAME_IN_DAYS, ZOCDOC_FIELDS, ZOCDOC_FIELD_KEYS, ZOCDOC_STATUS_LABELS, parseZocdocRows, type ZocdocField, type ZocdocMapping } from "@shared/zocdoc";

type Report = RouterOutputs["masterBilling"]["zocdocReport"];
type ZRow = Report["months"][number];
type Filter = "all" | "no_visit" | "practice_canceled" | "not_matched" | "already_ours" | "came_in";

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
  { key: "all", label: "Everyone" }, { key: "no_visit", label: "Charged, never came in" }, { key: "practice_canceled", label: "Charged, practice canceled" },
  { key: "not_matched", label: "Not found in MyPCP" }, { key: "already_ours", label: "Already our patient" }, { key: "came_in", label: "Came in" },
];

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

          <Panel title="By month booked" bodyClassName="p-0" action={<Btn size="sm" variant="secondary" onClick={monthsCsv}><Download size={13} /> CSV</Btn>}
            subtitle={`Cost by each booking's month; patients and insurance by the month of their first ZocDoc booking. Recent months fill in as insurance pays (Master Billing has payments through the last Office Ally upload).`}>
            <ZTable rows={d.months} label="Month" fmt={monthLabel} totals={t} />
          </Panel>

          <Panel title="Where money leaks" subtitle="Charges that didn't turn into a visit. Click one to see the patients.">
            <div className="grid gap-3 md:grid-cols-2">
              <Leak title="Charged, never came in" count={d.leaks.noVisit.patients} unit="patient" cents={d.leaks.noVisit.costCents} onClick={() => showPatients("no_visit")}
                note={`No billed visit within ${CAME_IN_DAYS} days (${d.leaks.noVisit.notInMyPcp.toLocaleString()} of them aren't in MyPCP at all).`} />
              <Leak title="Charged, but the practice canceled" count={d.leaks.practiceCanceled.bookings} unit="booking" cents={d.leaks.practiceCanceled.costCents} onClick={() => showPatients("practice_canceled")}
                note="Worth asking ZocDoc about: the practice canceled these bookings and was still charged." />
              <Leak title="Cancellation charges" count={d.leaks.cancellationCharges.bookings} unit="booking" cents={d.leaks.cancellationCharges.costCents}
                note="ZocDoc's own reason says the charge was for a cancellation." />
              <Leak title="Charged no-shows" count={d.leaks.noShow.bookings} unit="booking" cents={d.leaks.noShow.costCents} note="Marked as a no-show in ZocDoc." />
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
        ["Patient", "Date of birth", "First ZocDoc date", "Bookings", "Charged bookings", "ZocDoc cost", "Statuses", "In MyPCP", "Came in", "Insurance paid", "Billed to patient", "Provider", "Insurance"],
        ...all.map((r) => [niceName(r.name), r.dob ?? "", r.firstDate, r.bookings, r.chargedBookings, (r.costCents / 100).toFixed(2), r.statuses.map((s) => ZOCDOC_STATUS_LABELS[s]).join("; "),
          r.matched ? "yes" : "no", r.pending ? "too soon" : r.cameIn ? "yes" : "no", ((r.paidFirstCents + r.paidLaterCents) / 100).toFixed(2), (r.owesCents / 100).toFixed(2), r.provider ?? "", r.insurance ?? ""]),
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
                <th className={th}>Charged</th><th className="px-3 py-2 text-left font-medium">Came in</th><th className={th}>Insurance paid</th><th className="px-3 py-2 text-left font-medium">Provider</th>
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
                  <td className="px-3 py-2">{r.cameIn ? <span className="text-emerald-700 dark:text-emerald-300">Yes</span> : r.pending ? <span className="text-slate-400">Too soon</span> : <span className="text-rose-700 dark:text-rose-300">No</span>}</td>
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
    if (saved.data && !override) setOverride(Object.fromEntries(Object.entries(saved.data as Record<string, number>).filter(([, v]) => v >= 0)) as ZocdocMapping);
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
