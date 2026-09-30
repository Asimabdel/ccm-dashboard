import { useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { ExternalLink, Loader2, Search, Sparkles, Unlink, UserCheck } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Btn, ErrorNote, Loading, inputCls } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { chartHref } from "@/components/chart/ChartLookup";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { PAYMENT_CATEGORIES, PAYMENT_CATEGORY_LIST, PAYMENT_STATUS_LABELS, REQUEST_KINDS, methodText, money, type PaymentCategory } from "@shared/payments";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
const MATCH_LABEL: Record<string, string> = { customer: "matched from the Square customer", request: "from the MyPCP payment link / Terminal charge", manual: "linked by staff" };
const CLINIC_SOURCE: Record<string, string> = { request: "from the payment request", device: "from the Square device", patient: "the patient's office", manual: "set by staff" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="min-w-0 text-slate-800 dark:text-slate-100">{children}</dd>
    </div>
  );
}

/** One Square payment: who paid, the patient it belongs to, what it was for and which office took it. */
export function PaymentDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const ws = useWorkspace();
  const isAdmin = ws.user?.role === "admin";
  const utils = trpc.useUtils();
  const q = trpc.workspace.payments.detail.useQuery({ id: id ?? "" }, { enabled: !!id });
  const p = q.data;
  const [search, setSearch] = useState("");
  const [picking, setPicking] = useState(false);
  const [alsoCustomer, setAlsoCustomer] = useState(true);
  const [memo, setMemo] = useState("");
  const found = trpc.workspace.payments.searchPatients.useQuery({ q: search }, { enabled: picking && search.trim().length >= 2 });
  useEffect(() => { setPicking(false); setSearch(""); setAlsoCustomer(true); }, [id]);
  useEffect(() => { setMemo(p?.memo ?? ""); }, [p?.id, p?.memo]);

  const refresh = () => { void utils.workspace.payments.invalidate(); };
  const onError = (e: { message: string }) => toast.error(e.message);
  const link = trpc.workspace.payments.link.useMutation({
    onSuccess: (r, v) => { refresh(); setPicking(false); setSearch(""); toast.success(v.subjectKey ? `Linked${r.others ? `, plus ${r.others} more payment${r.others === 1 ? "" : "s"} from the same Square customer` : ""}.` : "Unlinked."); },
    onError,
  });
  const update = trpc.workspace.payments.update.useMutation({ onSuccess: () => { refresh(); toast.success("Saved"); }, onError });

  const doLink = (subjectKey: string | null) => { if (p) link.mutate({ id: p.id, subjectKey, alsoCustomer }); };
  const cats = PAYMENT_CATEGORY_LIST.filter((c) => c !== "dexafit" || isAdmin);
  const dexa = p?.category === "dexafit";

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-lg p-0 gap-0 overflow-y-auto bg-white">
        {!p && <SheetTitle className="sr-only">Payment</SheetTitle>}
        {q.isLoading && <Loading />}
        {q.error && <div className="p-6"><ErrorNote message={q.error.message} /></div>}
        {p && (
          <>
            <SheetHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-700">
              <SheetTitle className="text-2xl tabular-nums">{money(p.totalCents)}</SheetTitle>
              <SheetDescription>
                {PAYMENT_STATUS_LABELS[p.status] ?? p.status} · {methodText(p)} · {when(p.createdAt)}
              </SheetDescription>
            </SheetHeader>

            <div className="shrink-0 space-y-6 px-6 py-5">
              {/* Patient */}
              {!dexa && (
                <section>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Patient</h4>
                  {p.subjectKey && !picking ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-600">
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-800 dark:text-slate-100">
                          {p.patientId ? <Link href={`/patients/${p.patientId}?tab=payments`} className="hover:underline">{p.patientName}</Link> : <Link href={chartHref(p.subjectKey)} className="hover:underline">{p.patientName}</Link>}
                        </p>
                        <p className="text-xs text-slate-500">{MATCH_LABEL[p.matchSource ?? ""] ?? ""}</p>
                      </div>
                      <div className="flex gap-1">
                        <Btn size="sm" variant="secondary" onClick={() => setPicking(true)}>Change</Btn>
                        <Btn size="sm" variant="ghost" disabled={link.isPending} onClick={() => doLink(null)} title="Unlink"><Unlink size={13} /></Btn>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {!p.subjectKey && p.suggest && !picking && (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
                          <p className="flex items-center gap-2 text-sm"><Sparkles size={14} /> Same name as <b>{p.suggest.name}</b>. Is it them?</p>
                          <Btn size="sm" disabled={link.isPending} onClick={() => doLink(p.suggest!.key)}><UserCheck size={13} /> Yes, link</Btn>
                        </div>
                      )}
                      <div className="relative">
                        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input className={cn(inputCls, "pl-9")} placeholder={p.payer ? `Search patients (paid by ${p.payer})` : "Search patients by name…"} value={search} onFocus={() => setPicking(true)} onChange={(e) => { setPicking(true); setSearch(e.target.value); }} />
                      </div>
                      {found.isFetching && <p className="text-xs text-slate-500">Searching…</p>}
                      {(found.data ?? []).length > 0 && (
                        <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-600">
                          {found.data!.map((s) => (
                            <li key={s.key}>
                              <button disabled={link.isPending} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800" onClick={() => doLink(s.key)}>
                                <span className="font-medium text-slate-800 dark:text-slate-100">{s.name}</span>
                                <span className="text-xs text-slate-500">{[s.dob, s.clinicName, s.phoneLast4 ? `…${s.phoneLast4}` : null].filter(Boolean).join(" · ")}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {p.customer && (
                        <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
                          <input type="checkbox" className="mt-0.5 size-4 accent-teal-700" checked={alsoCustomer} onChange={(e) => setAlsoCustomer(e.target.checked)} />
                          Also link this Square customer, so their other and future payments match on their own.
                        </label>
                      )}
                      {picking && p.subjectKey && <button className="text-xs font-semibold text-slate-500 hover:underline" onClick={() => setPicking(false)}>Keep {p.patientName}</button>}
                    </div>
                  )}
                </section>
              )}
              {dexa && <p className="rounded-lg bg-violet-50 p-3 text-sm text-violet-900 dark:bg-violet-950/40 dark:text-violet-200">DexaFit payment: kept separate from MyPCP patients.</p>}

              {/* Sorting */}
              <section className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">For
                  <select className={cn(inputCls, "mt-1")} value={p.category ?? ""} disabled={update.isPending || (dexa && !isAdmin)}
                    onChange={(e) => update.mutate({ id: p.id, category: (e.target.value || null) as PaymentCategory | null })}>
                    <option value="">Not sorted yet</option>
                    {cats.map((c) => <option key={c} value={c}>{PAYMENT_CATEGORIES[c]}</option>)}
                  </select>
                </label>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">Office
                  <select className={cn(inputCls, "mt-1")} value={p.clinicId ?? ""} disabled={update.isPending}
                    onChange={(e) => e.target.value && update.mutate({ id: p.id, clinicId: Number(e.target.value) })}>
                    {!p.clinicId && <option value="">Not known</option>}
                    {ws.clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  {p.clinicSource && <span className="mt-1 block font-normal text-slate-500">{CLINIC_SOURCE[p.clinicSource]}</span>}
                </label>
              </section>

              {/* Square's details */}
              <section>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">From Square</h4>
                <dl className="divide-y divide-slate-100 dark:divide-slate-700">
                  <Row label="Paid by">{p.customer?.name ?? p.payer ?? <span className="text-slate-400">No customer on the payment</span>}{p.customer?.phone ? <span className="text-slate-500"> · {p.customer.phone}</span> : null}</Row>
                  {p.customer?.email && <Row label="Email">{p.customer.email}</Row>}
                  <Row label="Items">{p.items ?? <span className="text-slate-400">Not listed</span>}</Row>
                  {p.note && <Row label="Square note">{p.note}</Row>}
                  <Row label="Amount">{money(p.amountCents)}{p.tipCents ? ` + ${money(p.tipCents)} tip` : ""}</Row>
                  {p.feeCents != null && <Row label="Square fee">{money(p.feeCents)}</Row>}
                  {p.takenBy && <Row label="Taken by">{p.takenBy}</Row>}
                  {p.deviceName && <Row label="Device">{p.deviceName}</Row>}
                  {p.request && <Row label="Started in MyPCP">{REQUEST_KINDS[p.request.kind]} (R{p.request.id}){p.request.purpose ? `: ${p.request.purpose}` : ""}</Row>}
                  {p.receiptUrl && <Row label="Receipt"><a className="inline-flex items-center gap-1 font-semibold text-brand hover:underline" href={p.receiptUrl} target="_blank" rel="noreferrer">Square receipt <ExternalLink size={12} /></a></Row>}
                </dl>
              </section>

              {p.refunds.length > 0 && (
                <section>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Refunds</h4>
                  <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-700">
                    {p.refunds.map((r) => (
                      <li key={r.id} className="flex justify-between gap-3 py-1.5">
                        <span>{when(r.createdAt)}{r.reason ? ` · ${r.reason}` : ""}</span>
                        <span className="tabular-nums font-semibold">−{money(r.amountCents)} <span className="font-normal text-slate-500">{r.status === "COMPLETED" ? "" : r.status.toLowerCase()}</span></span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-slate-500">Refunds are made in Square.</p>
                </section>
              )}

              <section>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">Note (MyPCP only)
                  <textarea className={cn(inputCls, "mt-1 min-h-[70px]")} value={memo} maxLength={500} onChange={(e) => setMemo(e.target.value)} />
                </label>
                {memo !== (p.memo ?? "") && (
                  <div className="mt-2 flex justify-end"><Btn size="sm" disabled={update.isPending} onClick={() => update.mutate({ id: p.id, memo: memo.trim() || null })}>{update.isPending && <Loader2 size={13} className="animate-spin" />} Save note</Btn></div>
                )}
              </section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
