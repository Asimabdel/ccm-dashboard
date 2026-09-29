import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, HelpCircle, Loader2, RefreshCw, Search, ShieldCheck, XCircle } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Btn, ErrorNote, Loading, Panel, inputCls } from "@/components/workspace/ui";
import { cn } from "@/lib/utils";
import { localDateStr } from "@shared/workforce";

type Check = RouterOutputs["workspace"]["eligibility"]["history"][number];

const when = (d: Date | string) => new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
const fmtDate = (s: string | null) => {
  if (!s) return null;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : s;
};

/** One check's answer: active or not, plan, what the visit costs, and the PCP the payer has on file. */
export function EligibilityResult({ check, compact = false }: { check: Check; compact?: boolean }) {
  const [showRaw, setShowRaw] = useState(false);
  const raw = trpc.workspace.eligibility.raw.useQuery({ id: check.id }, { enabled: showRaw });
  const s = check.summary;
  const tone = check.status === "error" ? "error" : check.status === "pending" ? "pending" : s?.active === true ? "ok" : s?.active === false ? "bad" : "unknown";
  const Icon = { ok: CheckCircle2, bad: XCircle, error: AlertTriangle, pending: Loader2, unknown: HelpCircle }[tone];
  const label = check.status === "error" ? "Couldn't check" : check.status === "pending" ? "Waiting for the payer…" : s?.statusText ?? "Checked";
  const plan = s?.plans[0];
  return (
    <div className={cn("rounded-xl border p-3 text-sm", {
      ok: "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30",
      bad: "border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30",
      error: "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30",
      pending: "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50",
      unknown: "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50",
    }[tone])}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold">
          <Icon size={16} className={cn(tone === "pending" && "animate-spin", { ok: "text-emerald-600", bad: "text-red-600", error: "text-amber-600", pending: "text-slate-400", unknown: "text-slate-500" }[tone])} />
          {label}
          {check.mode === "demo" && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700 dark:bg-violet-900/40 dark:text-violet-200">Demo: sample answer</span>}
        </p>
        <span className="text-xs text-slate-500">{check.payerName ?? check.payerId} · member {check.memberId} · for {fmtDate(check.asOfDate)} · {check.trigger === "nightly" ? "nightly check" : "checked"} {when(check.updatedAt)}</span>
      </div>
      {check.error && <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">{check.error}</p>}
      {s && check.status === "complete" && (
        <div className={cn("mt-2 grid gap-x-6 gap-y-1", compact ? "sm:grid-cols-2" : "sm:grid-cols-3")}>
          {plan?.name && <Fact label="Plan" value={[plan.name, plan.insuranceType && plan.insuranceType !== plan.name ? plan.insuranceType : null].filter(Boolean).join(" · ")} />}
          {(plan?.start || plan?.end) && <Fact label="Coverage dates" value={`${fmtDate(plan?.start ?? null) ?? "?"} to ${fmtDate(plan?.end ?? null) ?? "no end date"}`} />}
          {plan?.groupNumber && <Fact label="Group" value={plan.groupNumber} />}
          <Fact label="Office visit copay" value={s.officeCopay ?? "Not listed"} />
          <Fact label="Deductible left" value={s.deductibleRemaining ?? "Not listed"} />
          {s.coinsurance && <Fact label="Coinsurance" value={s.coinsurance} />}
          <Fact label="PCP on file with the payer" value={s.pcp ? `${s.pcp}${check.pcpIsOurs === false ? " (not a MyPCP provider)" : ""}` : "None listed"} />
        </div>
      )}
      {!compact && s && s.highlights.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-slate-600 dark:text-slate-300">{s.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>
      )}
      {s && s.messages.length > 0 && <p className="mt-1 text-xs text-slate-500">Payer notes: {s.messages.join(" · ")}</p>}
      {!compact && check.status !== "pending" && (
        <button type="button" onClick={() => setShowRaw(!showRaw)} className="mt-2 flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800">
          {showRaw ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Everything the payer sent
        </button>
      )}
      {showRaw && (raw.isLoading ? <Loader2 size={14} className="mt-2 animate-spin" /> : <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-white p-2 text-[11px] dark:bg-slate-900">{JSON.stringify(raw.data, null, 2)}</pre>)}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

/** Search Availity's payer list (or type a payer ID). */
function PayerPicker({ value, onChange }: { value: { id: string; name: string | null }; onChange: (v: { id: string; name: string | null }) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const payers = trpc.workspace.eligibility.payers.useQuery({ q }, { enabled: open, staleTime: 60_000 });
  return (
    <div className="relative">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input className={cn(inputCls, "pl-8")} placeholder="Search payer (e.g. Humana, Medicare)…" value={open ? q : value.id ? `${value.name ?? value.id} (${value.id})` : ""}
          onFocus={() => { setOpen(true); setQ(""); }} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={(e) => setQ(e.target.value)} />
      </div>
      {open && (
        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {payers.isFetching && <p className="px-3 py-2 text-xs text-slate-500">Searching…</p>}
          {(payers.data?.payers ?? []).map((p) => (
            <button key={p.id} type="button" onMouseDown={() => { onChange({ id: p.id, name: p.name }); setOpen(false); }} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
              <span>{p.name}</span><span className="font-mono text-xs text-slate-500">{p.id}</span>
            </button>
          ))}
          {payers.data && !payers.data.listLoaded && (
            <p className="px-3 py-2 text-xs text-slate-500">Availity's payer list isn't loaded (subscribe your Availity app to the Payer List API). You can type the payer ID below.</p>
          )}
          {q.trim().length >= 2 && (
            <button type="button" onMouseDown={() => { onChange({ id: q.trim().toUpperCase(), name: null }); setOpen(false); }} className="w-full px-3 py-2 text-left text-xs font-semibold text-brand hover:bg-slate-50 dark:hover:bg-slate-800">
              Use "{q.trim().toUpperCase()}" as the payer ID
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Insurance on file + eligibility checks for one person (Patient 360 tab, or a dialog elsewhere). */
export function InsurancePanel({ subjectKey }: { subjectKey: string }) {
  const utils = trpc.useUtils();
  const defaults = trpc.workspace.eligibility.defaults.useQuery({ subjectKey });
  const history = trpc.workspace.eligibility.history.useQuery({ subjectKey });
  const [form, setForm] = useState<{ payer: { id: string; name: string | null }; memberId: string; groupNumber: string; firstName: string; lastName: string; dob: string; sex: string; asOfDate: string } | null>(null);
  const [showForm, setShowForm] = useState(false);
  useEffect(() => {
    const d = defaults.data;
    if (!d || form) return;
    setForm({
      payer: { id: d.onFile?.payerId ?? "", name: d.onFile?.payerName ?? null }, memberId: d.onFile?.memberId ?? "", groupNumber: d.onFile?.groupNumber ?? "",
      firstName: d.firstName, lastName: d.lastName, dob: d.dob ?? "", sex: d.sex ?? "U", asOfDate: localDateStr(),
    });
    setShowForm(!d.onFile);
  }, [defaults.data, form]);
  const refresh = () => { void utils.workspace.eligibility.history.invalidate({ subjectKey }); void utils.workspace.eligibility.defaults.invalidate({ subjectKey }); void utils.workspace.eligibility.schedule.invalidate(); };
  const check = trpc.workspace.eligibility.check.useMutation({ onSuccess: () => { refresh(); setShowForm(false); }, onError: (e) => toast.error(e.message) });
  const poll = trpc.workspace.eligibility.refresh.useMutation({ onSuccess: refresh });
  const latest = history.data?.[0];
  // A check still waiting on the payer: ask again every few seconds.
  useEffect(() => {
    if (latest?.status !== "pending") return;
    const t = setInterval(() => poll.mutate({ id: latest.id }), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id, latest?.status]);
  const canRun = !!form && !!form.payer.id && !!form.memberId.trim() && !!form.firstName.trim() && !!form.lastName.trim() && /^\d{4}-\d{2}-\d{2}$/.test(form.dob);
  const run = () => form && check.mutate({
    subjectKey, payerId: form.payer.id, payerName: form.payer.name, memberId: form.memberId, groupNumber: form.groupNumber || null,
    firstName: form.firstName, lastName: form.lastName, dob: form.dob, sex: (["F", "M", "X", "U"].includes(form.sex) ? form.sex : "U") as "F" | "M" | "X" | "U", asOfDate: form.asOfDate || null,
  });
  const older = useMemo(() => (history.data ?? []).slice(1), [history.data]);

  if (defaults.isLoading) return <Loading />;
  if (defaults.error) return <ErrorNote message={defaults.error.message} />;
  const d = defaults.data!;
  return (
    <div className="space-y-4">
      {!d.configured && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> Availity isn't connected yet. An admin sets it up under Integrations → Availity.
        </p>
      )}
      <Panel
        title={<span className="flex items-center gap-2"><ShieldCheck size={16} className="text-brand" /> Insurance</span>}
        subtitle={d.onFile ? `${d.onFile.payerName ?? d.onFile.payerId} · member ${d.onFile.memberId}${d.onFile.groupNumber ? ` · group ${d.onFile.groupNumber}` : ""}` : d.insuranceText ? `Roster says: ${d.insuranceText}. Add the member ID to check it.` : "No insurance on file yet."}
        action={d.onFile && !showForm ? (
          <div className="flex gap-2">
            <Btn size="sm" variant="secondary" onClick={() => setShowForm(true)}>Change</Btn>
            <Btn size="sm" disabled={!d.configured || check.isPending || !canRun} onClick={run}>{check.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Check now</Btn>
          </div>
        ) : undefined}
      >
        <div className="space-y-3 text-sm">
          {showForm && form && (
            <div className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block sm:col-span-2"><span className="mb-1 block font-medium">Payer</span>
                  <PayerPicker value={form.payer} onChange={(payer) => setForm({ ...form, payer })} />
                </label>
                <label className="block"><span className="mb-1 block font-medium">Member ID</span>
                  <input className={inputCls} value={form.memberId} onChange={(e) => setForm({ ...form, memberId: e.target.value })} maxLength={60} />
                </label>
                <label className="block"><span className="mb-1 block font-medium">Group number <span className="font-normal text-slate-400">(optional)</span></span>
                  <input className={inputCls} value={form.groupNumber} onChange={(e) => setForm({ ...form, groupNumber: e.target.value })} maxLength={60} />
                </label>
                <label className="block"><span className="mb-1 block font-medium">First name (as on the card)</span>
                  <input className={inputCls} value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} maxLength={60} />
                </label>
                <label className="block"><span className="mb-1 block font-medium">Last name (as on the card)</span>
                  <input className={inputCls} value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} maxLength={60} />
                </label>
                <label className="block"><span className="mb-1 block font-medium">Date of birth</span>
                  <input type="date" className={inputCls} value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} />
                </label>
                <label className="block"><span className="mb-1 block font-medium">Sex</span>
                  <select className={inputCls} value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}>
                    <option value="F">Female</option><option value="M">Male</option><option value="U">Unknown</option>
                  </select>
                </label>
                <label className="block"><span className="mb-1 block font-medium">Date of service</span>
                  <input type="date" className={inputCls} value={form.asOfDate} onChange={(e) => setForm({ ...form, asOfDate: e.target.value })} />
                </label>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {d.onFile && <Btn variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Btn>}
                <Btn disabled={!d.configured || !canRun || check.isPending} onClick={run}>
                  {check.isPending ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} {check.isPending ? "Asking the payer…" : "Save & check eligibility"}
                </Btn>
              </div>
              <p className="text-xs text-slate-500">Saved insurance is also checked automatically the evening before each visit.</p>
            </div>
          )}
          {history.isLoading && <Loader2 size={16} className="animate-spin text-slate-400" />}
          {latest ? <EligibilityResult check={latest} /> : !showForm && <p className="text-slate-500">Not checked yet.</p>}
          {older.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer font-semibold text-slate-500">Earlier checks ({older.length})</summary>
              <div className="mt-2 space-y-2">{older.map((c) => <EligibilityResult key={c.id} check={c} compact />)}</div>
            </details>
          )}
        </div>
      </Panel>
    </div>
  );
}
