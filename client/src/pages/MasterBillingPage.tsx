import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Download, FileUp, Landmark, Loader2, Search, Trash2, UserX, X } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAuth } from "@/_core/hooks/useAuth";
import { useTheme } from "@/contexts/ThemeContext";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, MetricCard, PageHeader, Panel, SelectBox, inputCls } from "@/components/workspace/ui";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { UploadDialog } from "@/components/masterBilling/UploadDialog";
import { ClaimDrawer } from "@/components/masterBilling/ClaimDrawer";
import { STATUS_CLASS, StatusBadge } from "@/components/masterBilling/StatusBadge";
import { downloadCsv, niceName } from "@/lib/masterBillingFiles";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { BILL_STATUSES, BILL_STATUS_HELP, BILL_STATUS_LABELS, INSURANCE_TYPES, type BillStatus } from "@shared/billCodes";
import { BREAKDOWN_DIMS, BREAKDOWN_DIM_KEYS, SOURCE_LABELS, type BillSource, type BreakdownDim, type DateBasis } from "@shared/masterBilling";
import { addDays, money } from "@shared/payments";
import { localDateStr } from "@shared/workforce";

interface Filters {
  from: string;
  to: string;
  basis: DateBasis;
  status?: BillStatus[] | null;
  payer?: string | null;
  payerType?: string | null;
  providerId?: number | null;
  clinicId?: number | null;
  cpt?: string | null;
  reason?: string | null;
  q?: string | null;
  needsPatient?: boolean | null;
}
type Tab = "summary" | "breakdown" | "claims" | "denials" | "uploads";
const TABS: { key: Tab; label: string }[] = [
  { key: "summary", label: "Summary" }, { key: "breakdown", label: "Breakdown" }, { key: "claims", label: "Claims" }, { key: "denials", label: "Denials" }, { key: "uploads", label: "Uploads" },
];

type Preset = "month" | "lastMonth" | "3m" | "ytd" | "12m" | "all";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "month", label: "This month" }, { key: "lastMonth", label: "Last month" }, { key: "3m", label: "Last 3 months" },
  { key: "ytd", label: "This year" }, { key: "12m", label: "Last 12 months" }, { key: "all", label: "Everything" },
];
function presetRange(p: Preset, today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const first = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  switch (p) {
    case "month": return { from: first(y, m), to: today };
    case "lastMonth": { const ly = m === 1 ? y - 1 : y; const lm = m === 1 ? 12 : m - 1; return { from: first(ly, lm), to: addDays(first(y, m), -1) }; }
    case "3m": return { from: addDays(today, -91), to: today };
    case "ytd": return { from: `${y}-01-01`, to: today };
    case "12m": return { from: addDays(today, -365), to: today };
    case "all": return { from: "2000-01-01", to: addDays(today, 365) };
  }
}

// Okabe–Ito (color-blind safe): billed = blue, paid = green; lighter steps on the dark surface.
const BAR = { light: { billed: "#0072B2", paid: "#009E73", denied: "#D55E00" }, dark: { billed: "#4FA3E0", paid: "#2BC49A", denied: "#F07A3A" } };
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const day = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const monthLabel = (m: string) => (/^\d{4}-\d{2}$/.test(m) ? new Date(`${m}-15T12:00:00`).toLocaleDateString("en-US", { month: "short", year: "2-digit" }) : m);

/** Master Billing: every bill that came back from the clearinghouse, broken down any way. Only for the owner. */
export default function MasterBillingPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const [params, setParams] = useUrlParams();
  const tab = (TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "summary") as Tab;
  const today = localDateStr();
  const [preset, setPreset] = useState<Preset | "custom">("12m");
  const [f, setF] = useState<Filters>({ ...presetRange("12m", today), basis: "service" });
  const [upload, setUpload] = useState(false);
  const [claimId, setClaimId] = useState<number | null>(null);
  const allowed = ws.masterBilling;
  const options = trpc.masterBilling.options.useQuery(undefined, { enabled: allowed });

  if (!user || ws.loading) return null;
  if (!allowed) {
    return (
      <CCMDashboardLayout title="Master Billing">
        <EmptyState icon={Landmark} title="Master Billing is only open to the owner" body="Ask the owner if you need billing numbers." />
      </CCMDashboardLayout>
    );
  }

  const patch = (p: Partial<Filters>) => setF((x) => ({ ...x, ...p }));
  const drill = (p: Partial<Filters>) => { patch(p); setParams({ tab: "claims" }); };
  const active = [f.status?.length ? `Status: ${f.status.map((s) => BILL_STATUS_LABELS[s]).join(", ")}` : null, f.payer ? `Insurance: ${f.payer}` : null, f.payerType ? `Type: ${f.payerType}` : null,
    f.providerId ? `Provider: ${options.data?.providers.find((p) => p.id === f.providerId)?.name ?? "#" + f.providerId}` : null,
    f.clinicId ? `Clinic: ${options.data?.clinics.find((c) => c.id === f.clinicId)?.name ?? "#" + f.clinicId}` : null,
    f.cpt ? `CPT ${f.cpt}` : null, f.reason ? `Reason ${f.reason}` : null, f.q ? `"${f.q}"` : null, f.needsPatient ? "Needs a patient" : null].filter(Boolean) as string[];

  return (
    <CCMDashboardLayout title="Master Billing" pageTitle={false}>
      <PageHeader title="Master Billing" subtitle="Bills that came back from Office Ally: billed, paid, written off, denied. Only you can see this page."
        actions={<Btn onClick={() => setUpload(true)}><FileUp size={15} /> Upload bills</Btn>} />

      <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-700" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setParams({ tab: t.key === "summary" ? null : t.key })}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", tab === t.key ? "border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-100" : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400")}>
            {t.label}
          </button>
        ))}
      </div>

      {tab !== "uploads" && (
        <div className="mb-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => <Btn key={p.key} size="sm" variant={preset === p.key ? "primary" : "secondary"} onClick={() => { setPreset(p.key); patch(presetRange(p.key, today)); }}>{p.label}</Btn>)}
            <input type="date" value={f.from} max={f.to} onChange={(e) => { if (e.target.value) { setPreset("custom"); patch({ from: e.target.value }); } }} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800" aria-label="From" />
            <span className="text-sm text-slate-400">to</span>
            <input type="date" value={f.to} min={f.from} onChange={(e) => { if (e.target.value) { setPreset("custom"); patch({ to: e.target.value }); } }} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800" aria-label="To" />
            <SelectBox value={f.basis} onChange={(v) => patch({ basis: v as DateBasis })} ariaLabel="Which date">
              <option value="service">by date of service</option>
              <option value="paid">by date paid</option>
            </SelectBox>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SelectBox value={f.payer ?? ""} onChange={(v) => patch({ payer: v || null })} ariaLabel="Insurance" className="max-w-[220px]">
              <option value="">All insurances</option>
              {(options.data?.payers ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
            </SelectBox>
            <SelectBox value={f.payerType ?? ""} onChange={(v) => patch({ payerType: v || null })} ariaLabel="Insurance type">
              <option value="">All insurance types</option>
              {INSURANCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </SelectBox>
            <SelectBox value={String(f.providerId ?? "")} onChange={(v) => patch({ providerId: v ? Number(v) : null })} ariaLabel="Provider">
              <option value="">All providers</option>
              {(options.data?.providers ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </SelectBox>
            <SelectBox value={String(f.clinicId ?? "")} onChange={(v) => patch({ clinicId: v ? Number(v) : null })} ariaLabel="Clinic">
              <option value="">All clinics</option>
              {(options.data?.clinics ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectBox>
            <SelectBox value={f.cpt ?? ""} onChange={(v) => patch({ cpt: v || null })} ariaLabel="CPT code">
              <option value="">All CPT codes</option>
              {(options.data?.codes ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </SelectBox>
            <SelectBox value={f.status?.length === 1 ? f.status[0]! : ""} onChange={(v) => patch({ status: v ? [v as BillStatus] : null })} ariaLabel="Status">
              <option value="">All statuses</option>
              {BILL_STATUSES.map((s) => <option key={s} value={s}>{BILL_STATUS_LABELS[s]}</option>)}
            </SelectBox>
          </div>
          {active.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {active.map((a) => <span key={a} className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700 dark:bg-slate-800 dark:text-slate-200">{a}</span>)}
              <button type="button" className="inline-flex items-center gap-1 text-slate-500 hover:underline" onClick={() => patch({ status: null, payer: null, payerType: null, providerId: null, clinicId: null, cpt: null, reason: null, q: null, needsPatient: null })}><X size={12} /> Clear filters</button>
            </div>
          )}
        </div>
      )}

      {tab === "summary" && <Summary f={f} onDrill={drill} onUpload={() => setUpload(true)} />}
      {tab === "breakdown" && <Breakdown f={f} onDrill={drill} />}
      {tab === "claims" && <Claims f={f} patch={patch} onOpen={setClaimId} />}
      {tab === "denials" && <Denials f={f} onDrill={drill} onOpen={setClaimId} />}
      {tab === "uploads" && <Uploads onUpload={() => setUpload(true)} />}

      <UploadDialog open={upload} onOpenChange={setUpload} />
      <ClaimDrawer id={claimId} onClose={() => setClaimId(null)} />
    </CCMDashboardLayout>
  );
}

// ---------------------------------------------------------------------------

function Summary({ f, onDrill, onUpload }: { f: Filters; onDrill: (p: Partial<Filters>) => void; onUpload: () => void }) {
  const { theme } = useTheme();
  const colors = theme === "dark" ? BAR.dark : BAR.light;
  const q = trpc.masterBilling.summary.useQuery(f);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote message={q.error.message} />;
  const s = q.data!;
  if (!s.uploads) return <Panel><HowToGetFiles onUpload={onUpload} /></Panel>;
  const t = s.totals;
  const waiting = (s.byStatus.waiting?.billed ?? 0) + (s.byStatus.rejected?.billed ?? 0);
  const chart = s.byMonth.map((m) => ({ month: monthLabel(m.month), Billed: m.billed / 100, Paid: m.paid / 100, Denied: m.denied / 100 }));
  return (
    <div className="space-y-5">
      {s.capped && <ErrorNote message="This range has too many lines to add up at once. Pick a shorter range." />}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Billed" value={money(t.billed)} hint={`${t.claims.toLocaleString()} claims`} />
        <MetricCard label="Insurance paid" value={money(t.paid)} hint={`${pct(t.paid, t.billed)} of billed · ${pct(t.paid, t.allowed)} of allowed`} />
        <MetricCard label="Patient owes" value={money(t.patientOwes)} hint="deductible, copay, coinsurance" />
        <MetricCard label="Written off" value={money(t.writtenOff)} hint="contract and normal adjustments" />
        <MetricCard label="Denied" value={money(t.denied)} hint={`${((s.byStatus.denied?.claims ?? 0) + (s.byStatus.partly_paid?.claims ?? 0)).toLocaleString()} claims with a denial`} />
        <MetricCard label="Waiting" value={money(waiting)} hint={`${((s.byStatus.waiting?.claims ?? 0) + (s.byStatus.rejected?.claims ?? 0)).toLocaleString()} claims not paid yet`} />
      </div>

      <Panel title="By status" subtitle="Click one to see those claims.">
        <div className="flex flex-wrap gap-2">
          {BILL_STATUSES.filter((st) => s.byStatus[st]).map((st) => (
            <button key={st} type="button" title={BILL_STATUS_HELP[st]} onClick={() => onDrill({ status: [st] })}
              className={cn("rounded-lg px-3 py-2 text-left ring-1 ring-inset", STATUS_CLASS[st])}>
              <p className="text-xs font-medium">{BILL_STATUS_LABELS[st]}</p>
              <p className="text-sm font-semibold tabular-nums">{s.byStatus[st]!.claims.toLocaleString()} · {money(s.byStatus[st]!.billed)}</p>
            </button>
          ))}
        </div>
        {s.needsPatient > 0 && (
          <button type="button" onClick={() => onDrill({ needsPatient: true })} className="mt-3 inline-flex items-center gap-1.5 text-sm text-amber-800 hover:underline dark:text-amber-300">
            <UserX size={14} /> {s.needsPatient.toLocaleString()} claim{s.needsPatient === 1 ? "" : "s"} couldn't be matched to a patient. Review them
          </button>
        )}
      </Panel>

      {chart.length > 0 && (
        <Panel title="Billed and paid by month" subtitle={f.basis === "paid" ? "By the month insurance paid" : "By the month of the visit"}>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={theme === "dark" ? "#334155" : "#e2e8f0"} />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke={theme === "dark" ? "#94a3b8" : "#64748b"} />
                <YAxis tick={{ fontSize: 12 }} stroke={theme === "dark" ? "#94a3b8" : "#64748b"} tickFormatter={(v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : `$${v}`)} />
                <Tooltip formatter={(v: number) => money(Math.round(v * 100))} contentStyle={{ fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Billed" fill={colors.billed} radius={[3, 3, 0, 0]} />
                <Bar dataKey="Paid" fill={colors.paid} radius={[3, 3, 0, 0]} />
                <Bar dataKey="Denied" fill={colors.denied} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Top insurances" bodyClassName="p-0">
          <SmallTable head={["Insurance", "Claims", "Billed", "Paid", "Paid %"]}
            rows={s.topPayers.map((p) => ({ key: p.key, cells: [p.key, p.claims.toLocaleString(), money(p.billed), money(p.paid), pct(p.paid, p.billed)], onClick: p.key.startsWith("(") ? undefined : () => onDrill({ payer: p.key }) }))} />
        </Panel>
        <Panel title="Top CPT codes" subtitle="By insurance paid" bodyClassName="p-0">
          <SmallTable head={["CPT", "Units", "Billed", "Paid", "Paid per unit"]}
            rows={s.topCpt.map((c) => ({ key: c.key, cells: [c.key, c.units.toLocaleString(), money(c.billed), money(c.paid), c.units ? money(Math.round(c.paid / c.units)) : "—"], onClick: () => onDrill({ cpt: c.key }) }))} />
        </Panel>
      </div>
      <p className="text-xs text-slate-400">Status rules and reason wording are the practice's working rules; check anything that matters for a claim with your biller. {s.lastUpload ? `Last upload ${new Date(s.lastUpload).toLocaleDateString("en-US")}.` : ""}</p>
    </div>
  );
}

function SmallTable({ head, rows }: { head: string[]; rows: { key: string; cells: React.ReactNode[]; onClick?: () => void }[] }) {
  if (!rows.length) return <p className="px-4 py-6 text-sm text-slate-500">Nothing in this range.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800/60"><tr>{head.map((h, i) => <th key={h} className={cn("px-4 py-2 font-medium", i ? "text-right" : "text-left")}>{h}</th>)}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} onClick={r.onClick} className={cn("border-t border-slate-100 dark:border-slate-700/60", r.onClick && "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40")}>
            {r.cells.map((c, i) => <td key={i} className={cn("px-4 py-2", i ? "text-right tabular-nums" : "font-medium text-slate-800 dark:text-slate-100")}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HowToGetFiles({ onUpload }: { onUpload: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-6 text-sm text-slate-600 dark:text-slate-300">
      <p className="text-base font-semibold text-slate-800 dark:text-slate-100">Upload your first bills</p>
      <p className="mt-2">The best file is Office Ally's payment file (ERA / 835): it has every claim, CPT line, payment, write-off and denial exactly as the insurance sent it.</p>
      <ol className="mt-3 list-decimal space-y-1 pl-5">
        <li>Sign in to Office Ally's Service Center.</li>
        <li>Open the ERA / EOB 835 download (Office Ally's guide calls it "Download EOB/ERA 835").</li>
        <li>Pick the dates and download. You get a zip file.</li>
        <li>Upload that zip here as it is. No need to unzip it.</li>
      </ol>
      <p className="mt-3">Claims that are sent but not paid yet come from Office Ally's claim reports: download one as CSV or Excel and upload it too. PDF EOBs also work (the AI reads them, and you check every row).</p>
      <Btn className="mt-4" onClick={onUpload}><FileUp size={15} /> Upload bills</Btn>
    </div>
  );
}

// ---------------------------------------------------------------------------

const DIM_FILTER: Partial<Record<BreakdownDim, (key: string) => Partial<Filters>>> = {
  cpt: (k) => ({ cpt: k }),
  insurance: (k) => (k ? { payer: k } : {}),
  insuranceType: (k) => (k ? { payerType: k } : {}),
  provider: (k) => (k.startsWith("id:") ? { providerId: Number(k.slice(3)) } : {}),
  clinic: (k) => (k ? { clinicId: Number(k) } : {}),
  status: (k) => ({ status: [k as BillStatus] }),
  reason: (k) => (k ? { reason: k } : {}),
  month: (k) => {
    if (!/^\d{4}-\d{2}$/.test(k)) return {};
    const [y, m] = k.split("-").map(Number) as [number, number];
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    return { from: `${k}-01`, to: addDays(next, -1) };
  },
  week: (k) => (k ? { from: k, to: addDays(k, 6) } : {}),
  day: (k) => (k ? { from: k, to: k } : {}),
};

function Breakdown({ f, onDrill }: { f: Filters; onDrill: (p: Partial<Filters>) => void }) {
  const [dims, setDims] = useState<BreakdownDim[]>(["cpt"]);
  const q = trpc.masterBilling.breakdown.useQuery({ ...f, dims }, { enabled: dims.length > 0 });
  const toggle = (d: BreakdownDim) => setDims((x) => (x.includes(d) ? x.filter((y) => y !== d) : x.length >= 3 ? x : [...x, d]));
  const rows = q.data?.rows ?? [];
  const csv = () => downloadCsv(`billing-by-${dims.join("-")}-${f.from}-to-${f.to}.csv`, [
    [...dims.map((d) => BREAKDOWN_DIMS[d]), "Claims", "Lines", "Units", "Billed", "Allowed", "Insurance paid", "Patient owes", "Written off", "Denied", "Paid per unit"],
    ...rows.map((r) => [...r.keys.map((k) => k.label), r.claims, r.lines, r.units, r.billed / 100, r.allowed / 100, r.paid / 100, r.patientOwes / 100, r.writtenOff / 100, r.denied / 100, r.units ? Math.round(r.paid / r.units) / 100 : null]),
  ]);
  const drill = (keys: { dim: BreakdownDim; key: string; label: string }[]) => {
    const p: Partial<Filters> = {};
    for (const k of keys) {
      if (k.dim === "patient") Object.assign(p, { q: k.label });
      else Object.assign(p, DIM_FILTER[k.dim]?.(k.key) ?? {});
    }
    onDrill(p);
  };
  const th = "px-3 py-2 text-right font-medium";
  const td = "px-3 py-2 text-right tabular-nums";
  return (
    <Panel title="Group by" subtitle="Pick up to 3. Click a row to see its claims." action={rows.length > 0 ? <Btn size="sm" variant="secondary" onClick={csv}><Download size={14} /> Download CSV</Btn> : undefined} bodyClassName="p-0">
      <div className="flex flex-wrap gap-2 px-4 pb-3 pt-1">
        {BREAKDOWN_DIM_KEYS.map((d) => {
          const i = dims.indexOf(d);
          return (
            <button key={d} type="button" onClick={() => toggle(d)} disabled={i < 0 && dims.length >= 3}
              className={cn("rounded-full px-3 py-1 text-sm ring-1 ring-inset disabled:opacity-40", i >= 0 ? "bg-slate-900 text-white ring-slate-900 dark:bg-slate-100 dark:text-slate-900" : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-600")}>
              {i >= 0 ? `${i + 1}. ` : ""}{BREAKDOWN_DIMS[d]}
            </button>
          );
        })}
      </div>
      {!dims.length && <p className="px-4 pb-4 text-sm text-slate-500">Pick at least one.</p>}
      {q.data?.capped && <div className="px-4 pb-3"><ErrorNote message="This range has too many lines to add up at once. Pick a shorter range." /></div>}
      {q.isLoading && dims.length > 0 && <Loading />}
      {q.error && <div className="px-4 pb-4"><ErrorNote message={q.error.message} /></div>}
      {q.data && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <tr>
                {dims.map((d) => <th key={d} className="px-3 py-2 text-left font-medium">{BREAKDOWN_DIMS[d]}</th>)}
                <th className={th}>Claims</th><th className={th}>Units</th><th className={th}>Billed</th><th className={th}>Allowed</th><th className={th}>Paid</th>
                <th className={th}>Patient owes</th><th className={th}>Written off</th><th className={th}>Denied</th><th className={th}>Paid / unit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.keys.map((k) => k.key).join("|")} onClick={() => drill(r.keys)} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-800/40">
                  {r.keys.map((k) => <td key={k.dim} className="max-w-[280px] truncate px-3 py-2 font-medium text-slate-800 dark:text-slate-100" title={k.label}>{k.dim === "patient" ? niceName(k.label) : k.dim === "month" ? monthLabel(k.label) : k.label}</td>)}
                  <td className={td}>{r.claims.toLocaleString()}</td><td className={td}>{r.units.toLocaleString()}</td><td className={td}>{money(r.billed)}</td><td className={td}>{money(r.allowed)}</td>
                  <td className={td}>{money(r.paid)}</td><td className={td}>{money(r.patientOwes)}</td><td className={td}>{money(r.writtenOff)}</td><td className={td}>{money(r.denied)}</td>
                  <td className={td}>{r.units ? money(Math.round(r.paid / r.units)) : "—"}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={dims.length + 9} className="px-4 py-6 text-center text-slate-500">Nothing in this range.</td></tr>}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold dark:border-slate-600 dark:bg-slate-800/60">
                <tr>
                  <td colSpan={dims.length} className="px-3 py-2">Total{q.data.groups > rows.length ? ` (first ${rows.length.toLocaleString()} of ${q.data.groups.toLocaleString()} rows shown)` : ""}</td>
                  <td className={td}>{q.data.totals.claims.toLocaleString()}</td><td className={td}>{q.data.totals.units.toLocaleString()}</td><td className={td}>{money(q.data.totals.billed)}</td>
                  <td className={td}>{money(q.data.totals.allowed)}</td><td className={td}>{money(q.data.totals.paid)}</td><td className={td}>{money(q.data.totals.patientOwes)}</td>
                  <td className={td}>{money(q.data.totals.writtenOff)}</td><td className={td}>{money(q.data.totals.denied)}</td>
                  <td className={td}>{q.data.totals.units ? money(Math.round(q.data.totals.paid / q.data.totals.units)) : "—"}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function Claims({ f, patch, onOpen, title = "Claims", lockStatus }: { f: Filters; patch?: (p: Partial<Filters>) => void; onOpen: (id: number) => void; title?: string; lockStatus?: BillStatus[] }) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<"date" | "billed" | "paid" | "denied">(lockStatus ? "denied" : "date");
  const [search, setSearch] = useState(f.q ?? "");
  const input = { ...f, status: lockStatus ?? f.status, page, sort };
  const q = trpc.masterBilling.claims.useQuery(input);
  const key = JSON.stringify({ ...f, sort, lockStatus });
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) { setLastKey(key); setPage(1); }
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;
  const th = "px-3 py-2 text-right font-medium";
  const td = "px-3 py-2 text-right tabular-nums";
  return (
    <Panel title={title} subtitle={q.data ? `${q.data.total.toLocaleString()} claim${q.data.total === 1 ? "" : "s"}` : undefined} bodyClassName="p-0"
      action={
        <div className="flex flex-wrap items-center gap-2">
          {patch && (
            <form onSubmit={(e) => { e.preventDefault(); patch({ q: search.trim() || null }); }} className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className={cn(inputCls, "h-8 w-56 pl-8 text-sm")} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Patient, claim # or member ID" aria-label="Search claims" />
            </form>
          )}
          {patch && <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={!!f.needsPatient} onChange={(e) => patch({ needsPatient: e.target.checked || null })} /> Needs a patient</label>}
          <SelectBox value={sort} onChange={(v) => setSort(v as typeof sort)} ariaLabel="Sort">
            <option value="date">Newest first</option><option value="billed">Most billed</option><option value="paid">Most paid</option><option value="denied">Most denied</option>
          </SelectBox>
        </div>
      }>
      {q.isLoading && <Loading />}
      {q.error && <div className="p-4"><ErrorNote message={q.error.message} /></div>}
      {q.data && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{f.basis === "paid" ? "Paid" : "Service"}</th><th className="px-3 py-2 text-left font-medium">Patient</th>
                  <th className="px-3 py-2 text-left font-medium">Insurance</th><th className="px-3 py-2 text-left font-medium">Provider</th><th className="px-3 py-2 text-left font-medium">CPT</th>
                  <th className={th}>Billed</th><th className={th}>Paid</th><th className={th}>Patient owes</th><th className={th}>Denied</th><th className="px-3 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {q.data.rows.map((r) => (
                  <tr key={r.id} onClick={() => onOpen(r.id)} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-800/40">
                    <td className="whitespace-nowrap px-3 py-2">{day(f.basis === "paid" ? r.lastPaidDate : r.firstServiceDate)}</td>
                    <td className="px-3 py-2"><span className="font-medium text-slate-800 dark:text-slate-100">{niceName(r.patientName) || "—"}</span>{!r.subjectKey && <span className="ml-1.5 rounded bg-amber-100 px-1 text-[11px] text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">no match</span>}</td>
                    <td className="max-w-[200px] truncate px-3 py-2" title={r.payerName ?? ""}>{r.payerName ?? "—"}</td>
                    <td className="max-w-[160px] truncate px-3 py-2">{r.providerLabel ?? "—"}</td>
                    <td className="px-3 py-2">{r.codes.join(", ") || "—"}</td>
                    <td className={td}>{money(r.billedCents)}</td><td className={td}>{money(r.paidCents)}</td><td className={td}>{money(r.patientOwesCents)}</td>
                    <td className={td}>{r.deniedCents ? <span title={r.denialCodes.join(", ")}>{money(r.deniedCents)}</span> : "—"}</td>
                    <td className="px-3 py-2"><StatusBadge status={r.status as BillStatus} /></td>
                  </tr>
                ))}
                {!q.data.rows.length && <tr><td colSpan={10} className="px-4 py-6 text-center text-slate-500">No claims match.</td></tr>}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-sm dark:border-slate-700/60">
              <span className="text-slate-500">Page {page} of {pages.toLocaleString()}</span>
              <div className="flex gap-2">
                <Btn size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Btn>
                <Btn size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Btn>
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function Denials({ f, onDrill, onOpen }: { f: Filters; onDrill: (p: Partial<Filters>) => void; onOpen: (id: number) => void }) {
  const denied: BillStatus[] = ["denied", "partly_paid"];
  const q = trpc.masterBilling.breakdown.useQuery({ ...f, status: denied, dims: ["reason"] });
  const reasons = (q.data?.rows ?? []).filter((r) => r.denied > 0);
  return (
    <div className="space-y-5">
      <Panel title="Denial reasons" subtitle="What insurance said, in plain words. Click one to see its claims." bodyClassName="p-0">
        {q.isLoading && <Loading />}
        {q.error && <div className="p-4"><ErrorNote message={q.error.message} /></div>}
        {q.data && (reasons.length ? (
          <SmallTable head={["Reason", "Claims", "Denied", "Billed"]}
            rows={reasons.map((r) => ({ key: r.keys[0]!.key, cells: [r.keys[0]!.label, r.claims.toLocaleString(), money(r.denied), money(r.billed)], onClick: () => onDrill({ reason: r.keys[0]!.key, status: denied }) }))} />
        ) : <p className="px-4 py-6 text-sm text-slate-500">No denials in this range.</p>)}
      </Panel>
      <Claims f={f} onOpen={onOpen} title="Denied and partly paid claims" lockStatus={denied} />
    </div>
  );
}

// ---------------------------------------------------------------------------

type ImportRow = RouterOutputs["masterBilling"]["imports"][number];
interface CheckInfo { payerName: string | null; checkNumber: string | null; paymentDate: string | null; amountCents: number; balanced: boolean | null }

function Uploads({ onUpload }: { onUpload: () => void }) {
  const utils = trpc.useUtils();
  const q = trpc.masterBilling.imports.useQuery();
  const remove = trpc.masterBilling.removeImport.useMutation();
  const original = trpc.masterBilling.originalFile.useMutation();
  const [confirm, setConfirm] = useState<ImportRow | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);

  async function doRemove(r: ImportRow) {
    setConfirm(null);
    setRemoving(r.id);
    try {
      let cursor = 0;
      for (;;) {
        const res = await remove.mutateAsync({ importId: r.id, cursor });
        if (res.done) break;
        cursor = res.next;
      }
      toast.success(`Removed ${r.fileName}.`);
      void utils.masterBilling.invalidate();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRemoving(null);
    }
  }

  async function open(r: ImportRow) {
    try {
      const f = await original.mutateAsync({ importId: r.id });
      if (f.url) window.open(f.url, "_blank", "noopener");
      else if (f.base64) {
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([bytes], { type: f.contentType }));
        a.download = f.fileName;
        a.click();
        URL.revokeObjectURL(a.href);
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const rows = useMemo(() => q.data ?? [], [q.data]);
  return (
    <>
      <Panel title="Uploads" subtitle="Every file you uploaded. Removing one takes its claims out (claims also in another upload stay)." action={<Btn size="sm" onClick={onUpload}><FileUp size={14} /> Upload bills</Btn>} bodyClassName="p-0">
        {q.isLoading && <Loading />}
        {q.error && <div className="p-4"><ErrorNote message={q.error.message} /></div>}
        {q.data && !rows.length && <HowToGetFiles onUpload={onUpload} />}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Uploaded</th><th className="px-3 py-2 text-left font-medium">File</th><th className="px-3 py-2 text-left font-medium">Payments</th>
                  <th className="px-3 py-2 text-right font-medium">Claims</th><th className="px-3 py-2 text-right font-medium">Billed</th><th className="px-3 py-2 text-right font-medium">Paid</th>
                  <th className="px-3 py-2 text-right font-medium">Matched</th><th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const checks = (r.checks as CheckInfo[] | null) ?? [];
                  const gone = r.status !== "saved";
                  return (
                    <tr key={r.id} className={cn("border-t border-slate-100 align-top dark:border-slate-700/60", gone && "opacity-50")}>
                      <td className="whitespace-nowrap px-3 py-2">{new Date(r.createdAt).toLocaleDateString("en-US")}<p className="text-xs text-slate-400">{r.uploadedBy}</p></td>
                      <td className="max-w-[260px] px-3 py-2"><p className="truncate font-medium text-slate-800 dark:text-slate-100" title={r.fileName}>{r.fileName}</p><p className="text-xs text-slate-400">{SOURCE_LABELS[r.kind as BillSource]}{gone ? ` · ${r.status === "removing" ? "being removed" : "removed"}` : ""}</p></td>
                      <td className="px-3 py-2 text-xs">
                        {checks.slice(0, 3).map((c, i) => (
                          <p key={i}>{c.payerName ?? "—"} · {c.checkNumber ?? "—"} · {money(c.amountCents)}{c.balanced === false && <span className="ml-1 inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-300"><AlertTriangle size={11} /> doesn't add up</span>}</p>
                        ))}
                        {checks.length > 3 && <p className="text-slate-400">+{checks.length - 3} more</p>}
                        {!checks.length && <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.claimCount.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(r.billedCents)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(r.paidCents)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{pct(r.matchedCount, r.claimCount)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        {r.hasFile && !gone && <Btn size="sm" variant="ghost" onClick={() => void open(r)} title="Download the original file"><Download size={14} /></Btn>}
                        {!gone && <Btn size="sm" variant="ghost" onClick={() => setConfirm(r)} disabled={removing !== null} title="Remove this upload">{removing === r.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}</Btn>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this upload?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.fileName}: its {confirm?.claimCount.toLocaleString()} claims are taken out of every total. Claims that also came in another upload stay. You can upload the file again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && void doRemove(confirm)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
