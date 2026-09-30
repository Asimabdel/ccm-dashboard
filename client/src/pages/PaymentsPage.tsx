import { useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Banknote, CreditCard, Download, Link2, Loader2, PlugZap, RefreshCw, Search, UserX, Wallet, X } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, MetricCard, PageHeader, Panel, inputCls } from "@/components/workspace/ui";
import { TakePaymentDialog, type TakeMode } from "@/components/payments/TakePaymentDialog";
import { PaymentDrawer } from "@/components/payments/PaymentDrawer";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { localDateStr } from "@shared/workforce";
import { PAYMENT_CATEGORIES, PAYMENT_STATUS_LABELS, REQUEST_KINDS, addDays, methodText, money, type PaymentCategory } from "@shared/payments";

type Range = "today" | "yesterday" | "7d" | "month" | "last_month" | "custom";
type Tab = "payments" | "needs_patient" | "requests";
const RANGES: { k: Range; label: string }[] = [
  { k: "today", label: "Today" },
  { k: "yesterday", label: "Yesterday" },
  { k: "7d", label: "Last 7 days" },
  { k: "month", label: "This month" },
  { k: "last_month", label: "Last month" },
  { k: "custom", label: "Custom" },
];

function rangeDates(r: Range, from: string | null, to: string | null): { from: string; to: string } {
  const today = localDateStr();
  const first = `${today.slice(0, 8)}01`;
  switch (r) {
    case "yesterday": return { from: addDays(today, -1), to: addDays(today, -1) };
    case "7d": return { from: addDays(today, -6), to: today };
    case "month": return { from: first, to: today };
    case "last_month": { const end = addDays(first, -1); return { from: `${end.slice(0, 8)}01`, to: end }; }
    case "custom": return { from: from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : today, to: to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : today };
    default: return { from: today, to: today };
  }
}

const time = (iso: string, multiDay: boolean) => new Date(iso).toLocaleString("en-US", multiDay ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" } : { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const csvEscape = (v: unknown) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

const STATUS_CLS: Record<string, string> = {
  COMPLETED: "",
  APPROVED: "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  PENDING: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  CANCELED: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  FAILED: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};
const pill = "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap";

type PaymentRow = RouterOutputs["workspace"]["payments"]["list"]["rows"][number];

/** Square payments: what came in, from whom, for what, and which patient it belongs to. */
export default function PaymentsPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const isAdmin = user?.role === "admin";
  const [params, setParams] = useUrlParams();
  const range = (params.get("range") as Range) || "today";
  const { from, to } = rangeDates(range, params.get("from"), params.get("to"));
  const tab = (params.get("tab") as Tab) || "payments";
  const business = (isAdmin ? params.get("biz") : null) === "dexafit" ? "dexafit" : "clinic";
  const clinicParam = params.get("clinic");
  const clinicId = clinicParam === "none" ? 0 : clinicParam ? Number(clinicParam) : null;
  const category = (params.get("cat") as PaymentCategory | "none" | null) || null;
  const [q, setQ] = useState("");
  const [take, setTake] = useState<TakeMode | null>(null);
  const enabled = !!user && !!ws.caps?.payments;

  const status = trpc.workspace.payments.status.useQuery(undefined, { enabled, refetchInterval: 60_000 });
  const list = trpc.workspace.payments.list.useQuery(
    { from, to, clinicId, business, category, view: tab === "needs_patient" ? "needs_patient" : "all", q: q.trim() || null },
    { enabled: enabled && !!status.data?.configured && tab !== "requests", refetchInterval: 60_000, placeholderData: (prev) => prev },
  );
  const requests = trpc.workspace.payments.requests.useQuery({ status: "open" }, { enabled: enabled && !!status.data?.configured, refetchInterval: 30_000 });
  const utils = trpc.useUtils();
  const sync = trpc.workspace.payments.syncNow.useMutation({
    onSuccess: (r) => { void utils.workspace.payments.invalidate(); toast.success("loaded" in r ? `Up to date${r.loaded ? ` (${r.loaded} payment${r.loaded === 1 ? "" : "s"} updated)` : ""}.` : "Square isn't connected."); },
    onError: (e) => toast.error(e.message),
  });
  const cancel = trpc.workspace.payments.cancelRequest.useMutation({
    onSuccess: (r) => { void utils.workspace.payments.invalidate(); toast.success(r.status === "paid" ? "It was already paid." : "Canceled."); },
    onError: (e) => toast.error(e.message),
  });

  const s = list.data?.summary;
  const rows = list.data?.rows ?? [];
  const multiDay = from !== to;
  const exportCsv = () => {
    const header = ["Date/time (CT)", "Amount", "Refunded", "Status", "Method", "Paid by", "Patient", "For", "Office", "Items", "Taken by", "Note", "Square payment ID"];
    const lines = rows.map((r) => [
      new Date(r.createdAt).toLocaleString("en-US", { timeZone: "America/Chicago" }), (r.totalCents / 100).toFixed(2), (r.refundedCents / 100).toFixed(2), PAYMENT_STATUS_LABELS[r.status] ?? r.status,
      methodText(r), r.payer ?? "", r.patientName ?? "", r.category ? PAYMENT_CATEGORIES[r.category] : "", r.clinicName ?? "", r.items ?? "", r.takenBy ?? "", r.memo ?? "", r.id,
    ].map(csvEscape).join(","));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + [header.map(csvEscape).join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" }));
    a.download = `payments-${business === "dexafit" ? "dexafit-" : ""}${from}${multiDay ? `-to-${to}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const catOptions = useMemo(() => (Object.keys(PAYMENT_CATEGORIES) as PaymentCategory[]).filter((c) => c !== "dexafit"), []);
  const openReqs = requests.data ?? [];
  // On the DexaFit view, new payments default to DexaFit.
  const takePreset = useMemo(() => (business === "dexafit" ? { category: "dexafit" as const } : null), [business]);

  if (!user || ws.loading) return null;
  if (!ws.caps?.payments) {
    return <CCMDashboardLayout title="Payments" pageTitle={false}><EmptyState title="Payments aren't part of your role" body="Ask an admin if you need access." /></CCMDashboardLayout>;
  }

  return (
    <CCMDashboardLayout title="Payments" pageTitle={false}>
      <PageHeader
        title={business === "dexafit" ? "Payments · DexaFit" : "Payments"}
        subtitle={status.data?.configured
          ? <>From Square{status.data.locationName ? ` (${status.data.locationName})` : ""} · updated {ago(status.data.lastOkAt)}{status.data.env === "sandbox" ? " · SANDBOX (test money)" : ""}
              <button className="ml-2 inline-flex items-center gap-1 font-semibold text-brand hover:underline disabled:opacity-50" disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh</button></>
          : "Card and cash payments from Square."}
        actions={status.data?.configured ? (
          <>
            <Btn variant="secondary" onClick={() => setTake("link")}><Link2 size={15} /> Send a payment link</Btn>
            <Btn onClick={() => setTake("terminal")}><CreditCard size={15} /> Charge on Terminal</Btn>
          </>
        ) : undefined}
      />

      {status.isLoading && <Loading />}
      {status.error && <ErrorNote message={status.error.message} />}
      {status.data && !status.data.configured && (
        <Panel>
          <EmptyState icon={PlugZap} title="Square isn't connected yet"
            body={isAdmin ? "Connect the practice's Square account to see every payment here, link them to patients, and send payment links." : "An admin needs to connect the practice's Square account first."}
            action={isAdmin ? <Link href="/integrations"><Btn>Connect Square</Btn></Link> : undefined} />
        </Panel>
      )}
      {status.data?.lastError && status.data.configured && (
        <div className="mb-4"><ErrorNote message={`The last update from Square didn't work: ${status.data.lastError}`} /></div>
      )}

      {status.data?.configured && (
        <>
          {/* Filters: one row above everything they change */}
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-600" role="group" aria-label="Date range">
              {RANGES.map((r) => (
                <button key={r.k} onClick={() => setParams({ range: r.k === "today" ? null : r.k, ...(r.k === "custom" ? { from, to } : { from: null, to: null }) })}
                  className={cn("rounded-md px-2.5 py-1.5 text-xs font-semibold", range === r.k ? "bg-slate-900 text-white dark:bg-brand" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300")}>{r.label}</button>
              ))}
            </div>
            {range === "custom" && (
              <span className="flex items-center gap-1 text-xs text-slate-500">
                <input type="date" className={cn(inputCls, "w-auto py-1.5 text-xs")} value={from} max={to} onChange={(e) => e.target.value && setParams({ from: e.target.value })} />
                to
                <input type="date" className={cn(inputCls, "w-auto py-1.5 text-xs")} value={to} min={from} onChange={(e) => e.target.value && setParams({ to: e.target.value })} />
              </span>
            )}
            {(!ws.limitedToClinics || ws.clinics.length > 1) && (
              <select aria-label="Office" className={cn(inputCls, "w-auto py-1.5 text-xs")} value={clinicParam ?? ""} onChange={(e) => setParams({ clinic: e.target.value || null })}>
                <option value="">{ws.limitedToClinics ? "My offices" : "All offices"}</option>
                {ws.clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                {!ws.limitedToClinics && <option value="none">Office not known</option>}
              </select>
            )}
            {business === "clinic" && (
              <select aria-label="For" className={cn(inputCls, "w-auto py-1.5 text-xs")} value={category ?? ""} onChange={(e) => setParams({ cat: e.target.value || null })}>
                <option value="">Everything</option>
                {catOptions.map((c) => <option key={c} value={c}>{PAYMENT_CATEGORIES[c]}</option>)}
                <option value="none">Not sorted yet</option>
              </select>
            )}
            {isAdmin && (
              <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-600" role="group" aria-label="Business">
                {(["clinic", "dexafit"] as const).map((b) => (
                  <button key={b} onClick={() => setParams({ biz: b === "clinic" ? null : b, cat: null, tab: tab === "needs_patient" ? null : tab })}
                    className={cn("rounded-md px-2.5 py-1.5 text-xs font-semibold", business === b ? "bg-slate-900 text-white dark:bg-brand" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300")}>{b === "clinic" ? "MyPCP Dr" : "DexaFit"}</button>
                ))}
              </div>
            )}
          </div>

          {/* Totals for the range */}
          <div className={cn("mb-5 grid grid-cols-2 gap-3", isAdmin ? "lg:grid-cols-5" : "lg:grid-cols-4")}>
            <MetricCard label="Collected" icon={Wallet} iconTone="success" value={s ? money(s.netCents) : "…"}
              hint={s ? `${s.count} payment${s.count === 1 ? "" : "s"}${s.refundsCents ? ` · ${money(s.collectedCents)} taken − ${money(s.refundsCents)} refunded` : ""}` : undefined} />
            <MetricCard label="Card" icon={CreditCard} iconTone="info" value={s ? money(s.byMethod.card) : "…"} hint={s && s.byMethod.other ? `${money(s.byMethod.other)} other` : undefined} />
            <MetricCard label="Cash" icon={Banknote} iconTone="neutral" value={s ? money(s.byMethod.cash) : "…"} />
            {business === "clinic" ? (
              <button className="text-left" onClick={() => setParams({ tab: "needs_patient" })}>
                <MetricCard label="Needs a patient" icon={UserX} iconTone={s?.needsPatient ? "warning" : "neutral"} value={s ? s.needsPatient : "…"} hint={s?.needsPatient ? "Link them so they show on the patient's record" : "All linked"} tone={s?.needsPatient ? "warn" : "good"} />
              </button>
            ) : <MetricCard label="Tips" icon={Wallet} value={s ? money(s.tipsCents) : "…"} />}
            {isAdmin && <MetricCard label="Square fees" icon={Wallet} value={s?.feesCents != null ? money(s.feesCents) : "…"} hint={s && s.collectedCents ? `${((100 * (s.feesCents ?? 0)) / s.collectedCents).toFixed(1)}% of collected` : undefined} />}
          </div>

          {s && s.count > 0 && business === "clinic" && (
            <div className="mb-5 grid gap-5 lg:grid-cols-2">
              <Breakdown title="By what it was for" total={s.collectedCents}
                rows={[...catOptions.map((c) => ({ key: c, label: PAYMENT_CATEGORIES[c], cents: s.byCategory[c] ?? 0 })), { key: "none", label: "Not sorted yet", cents: s.byCategory.none ?? 0 }].filter((r) => r.cents)}
                onPick={(k) => setParams({ cat: category === k ? null : k })} active={category} />
              <Breakdown title="By office" total={s.collectedCents}
                rows={s.byClinic.map((c) => ({ key: c.clinicId == null ? "none" : String(c.clinicId), label: c.name ?? "Office not known", cents: c.cents }))}
                onPick={(k) => setParams({ clinic: clinicParam === k ? null : k })} active={clinicParam} />
            </div>
          )}

          {/* Tabs */}
          <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-700" role="tablist">
            {([
              { k: "payments", label: "Payments", n: s?.count },
              ...(business === "clinic" ? [{ k: "needs_patient", label: "Needs a patient", n: s?.needsPatient }] : []),
              { k: "requests", label: "Open links & Terminal", n: openReqs.length },
            ] as { k: Tab; label: string; n?: number }[]).map((t) => (
              <button key={t.k} role="tab" aria-selected={tab === t.k} onClick={() => setParams({ tab: t.k === "payments" ? null : t.k })}
                className={cn("-mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium", tab === t.k ? "border-brand text-slate-900 dark:text-slate-50" : "border-transparent text-slate-500 hover:text-slate-800")}>
                {t.label}{t.n ? <span className="text-xs tabular-nums text-slate-400">{t.n}</span> : null}
              </button>
            ))}
          </div>

          {tab !== "requests" && (
            <Panel bodyClassName="p-0" title={
              <div className="relative w-full max-w-xs">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input className={cn(inputCls, "py-1.5 pl-8 text-xs")} placeholder="Search name, amount, last 4…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            } action={<Btn size="sm" variant="secondary" disabled={!rows.length} onClick={exportCsv}><Download size={13} /> Export</Btn>}>
              {list.isLoading ? <Loading /> : list.error ? <div className="p-5"><ErrorNote message={list.error.message} /></div> : rows.length === 0 ? (
                <EmptyState icon={Wallet} title={tab === "needs_patient" ? "Every payment is linked to a patient" : "No payments"} body={tab === "needs_patient" ? "Nice work." : "Nothing came in through Square for these filters."} />
              ) : (
                <PaymentTable rows={rows} multiDay={multiDay} showPatient={business === "clinic"} onOpen={(id) => setParams({ pay: id })} />
              )}
              {list.data?.truncated && <p className="border-t border-slate-100 px-5 py-2 text-xs text-slate-500 dark:border-slate-700">Showing the first 1,000. Narrow the dates or filters to see the rest.</p>}
            </Panel>
          )}

          {tab === "requests" && (
            <Panel bodyClassName="p-0" title="Payment links and Terminal charges waiting to be paid">
              {requests.isLoading ? <Loading /> : openReqs.length === 0 ? (
                <EmptyState icon={Link2} title="Nothing waiting" body="Links you send show here until they're paid." />
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                  {openReqs.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-800 dark:text-slate-100"><span className="tabular-nums">{money(r.amountCents)}</span> · {r.patientName ?? "No patient"}</p>
                        <p className="text-xs text-slate-500">{REQUEST_KINDS[r.kind]} · {PAYMENT_CATEGORIES[r.category]}{r.purpose ? ` · ${r.purpose}` : ""} · {ago(r.createdAt)}{r.sentVia ? ` · sent by ${r.sentVia}${r.sentTo ? ` to ${r.sentTo}` : ""}` : " · not sent yet"}{r.clinicName ? ` · ${r.clinicName}` : ""}</p>
                      </div>
                      <div className="flex gap-2">
                        {r.url && <Btn size="sm" variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(r.url!); toast.success("Link copied"); } catch { toast.error("Couldn't copy"); } }}>Copy link</Btn>}
                        <Btn size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => { if (window.confirm(`Cancel this ${r.kind === "link" ? "payment link" : "Terminal charge"} for ${money(r.amountCents)}? The patient won't be able to pay with it.`)) cancel.mutate({ id: r.id }); }}><X size={13} /> Cancel</Btn>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </>
      )}

      <TakePaymentDialog open={!!take} mode={take ?? "link"} onClose={() => setTake(null)} preset={takePreset} />
      <PaymentDrawer id={params.get("pay")} onClose={() => setParams({ pay: null })} />
    </CCMDashboardLayout>
  );
}

function Breakdown({ title, rows, total, onPick, active }: { title: string; rows: { key: string; label: string; cents: number }[]; total: number; onPick: (key: string) => void; active: string | null }) {
  const max = Math.max(1, ...rows.map((r) => r.cents));
  return (
    <Panel title={title} bodyClassName="py-3">
      <ul className="space-y-1">
        {rows.sort((a, b) => b.cents - a.cents).map((r) => (
          <li key={r.key}>
            <button onClick={() => onPick(r.key)} className={cn("group grid w-full grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800", active === r.key && "bg-slate-50 dark:bg-slate-800")}>
              <span className="truncate text-slate-700 dark:text-slate-200">{r.label}</span>
              <span className="h-2 rounded-full bg-slate-100 dark:bg-slate-700" aria-hidden>
                <span className="block h-2 rounded-full bg-teal-600 dark:bg-teal-400" style={{ width: `${Math.max(2, (100 * r.cents) / max)}%` }} />
              </span>
              <span className="tabular-nums font-semibold text-slate-800 dark:text-slate-100">{money(r.cents)} <span className="font-normal text-slate-400">{total ? `${Math.round((100 * r.cents) / total)}%` : ""}</span></span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function PaymentTable({ rows, multiDay, showPatient, onOpen }: { rows: PaymentRow[]; multiDay: boolean; showPatient: boolean; onOpen: (id: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-xs font-semibold text-slate-500 dark:border-slate-700">
            <th className="px-5 py-2.5">{multiDay ? "When" : "Time"}</th>
            <th className="px-3 py-2.5 text-right">Amount</th>
            <th className="px-3 py-2.5">Method</th>
            <th className="px-3 py-2.5">Paid by</th>
            {showPatient && <th className="px-3 py-2.5">Patient</th>}
            <th className="px-3 py-2.5">For</th>
            <th className="px-3 py-2.5 hidden lg:table-cell">Office</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
          {rows.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60" onClick={() => onOpen(r.id)}>
              <td className="whitespace-nowrap px-5 py-2.5 tabular-nums text-slate-600 dark:text-slate-300">{time(r.createdAt, multiDay)}</td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right">
                <span className={cn("font-semibold tabular-nums text-slate-900 dark:text-slate-50", r.status !== "COMPLETED" && "text-slate-400 line-through dark:text-slate-500")}>{money(r.totalCents)}</span>
                {r.refundedCents > 0 && <span className="block text-[11px] text-rose-700 dark:text-rose-300">−{money(r.refundedCents)} refunded</span>}
                {r.status !== "COMPLETED" && <span className={cn(pill, "ml-1", STATUS_CLS[r.status])}>{PAYMENT_STATUS_LABELS[r.status] ?? r.status}</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-slate-600 dark:text-slate-300">{methodText(r)}</td>
              <td className="max-w-[12rem] truncate px-3 py-2.5 text-slate-700 dark:text-slate-200">{r.payer ?? <span className="text-slate-400">—</span>}</td>
              {showPatient && (
                <td className="max-w-[12rem] truncate px-3 py-2.5">
                  {r.patientName ? <span className="font-medium text-slate-800 dark:text-slate-100">{r.patientName}</span>
                    : r.suggest ? <span className="text-sky-700 dark:text-sky-300">{r.suggest.name}?</span>
                    : r.status === "COMPLETED" ? <span className={cn(pill, "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300")}>Link a patient</span> : null}
                </td>
              )}
              <td className="whitespace-nowrap px-3 py-2.5 text-slate-600 dark:text-slate-300">{r.category ? PAYMENT_CATEGORIES[r.category] : <span className="text-slate-400">Not sorted</span>}</td>
              <td className="hidden whitespace-nowrap px-3 py-2.5 text-slate-500 lg:table-cell">{r.clinicName ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
