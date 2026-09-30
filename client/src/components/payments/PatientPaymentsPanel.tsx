import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CreditCard, Link2, Wallet, X } from "lucide-react";
import { Btn, EmptyState, ErrorNote, Loading, Panel } from "@/components/workspace/ui";
import { TakePaymentDialog, type TakeMode } from "./TakePaymentDialog";
import { PaymentDrawer } from "./PaymentDrawer";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { PAYMENT_CATEGORIES, PAYMENT_STATUS_LABELS, methodText, money } from "@shared/payments";

const day = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

/** Patient 360 → Payments: what this patient paid through Square, and links / Terminal charges still open. */
export function PatientPaymentsPanel({ subjectKey, name, clinicId }: { subjectKey: string; name: string; clinicId: number | null }) {
  const q = trpc.workspace.payments.forSubject.useQuery({ subjectKey });
  const status = trpc.workspace.payments.status.useQuery(undefined, { staleTime: 60_000 });
  const utils = trpc.useUtils();
  const [take, setTake] = useState<TakeMode | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const cancel = trpc.workspace.payments.cancelRequest.useMutation({
    onSuccess: (r) => { void utils.workspace.payments.invalidate(); toast.success(r.status === "paid" ? "It was already paid." : "Canceled."); },
    onError: (e) => toast.error(e.message),
  });
  const d = q.data;
  const waiting = (d?.requests ?? []).filter((r) => r.status === "open");
  const configured = !!status.data?.configured;
  // Stable, so the dialog doesn't reset while it's open.
  const preset = useMemo(() => ({ subjectKey, name, clinicId }), [subjectKey, name, clinicId]);

  return (
    <div className="space-y-5">
      <Panel
        title="Payments"
        subtitle={d ? `${money(d.paidLastYearCents)} paid in the last 12 months${d.lastPaidAt ? ` · last paid ${day(d.lastPaidAt)}` : ""}` : undefined}
        action={configured ? (
          <div className="flex gap-2">
            <Btn size="sm" variant="secondary" onClick={() => setTake("link")}><Link2 size={13} /> Payment link</Btn>
            <Btn size="sm" onClick={() => setTake("terminal")}><CreditCard size={13} /> Charge on Terminal</Btn>
          </div>
        ) : undefined}
        bodyClassName="p-0"
      >
        {status.data && !configured && <p className="px-5 py-4 text-sm text-slate-500">Square isn't connected yet.</p>}
        {q.isLoading && <Loading />}
        {q.error && <div className="p-5"><ErrorNote message={q.error.message} /></div>}
        {waiting.length > 0 && (
          <ul className="divide-y divide-amber-100 border-b border-amber-100 bg-amber-50/60 dark:divide-amber-900/40 dark:border-amber-900/40 dark:bg-amber-950/20">
            {waiting.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                <span className="text-amber-900 dark:text-amber-200"><b className="tabular-nums">{money(r.amountCents)}</b> {r.kind === "link" ? "payment link" : "Terminal charge"} waiting to be paid · {PAYMENT_CATEGORIES[r.category]}{r.purpose ? ` · ${r.purpose}` : ""}{r.sentVia ? ` · sent by ${r.sentVia}` : ""}</span>
                <Btn size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => { if (window.confirm("Cancel it? The patient won't be able to pay with it.")) cancel.mutate({ id: r.id }); }}><X size={13} /> Cancel</Btn>
              </li>
            ))}
          </ul>
        )}
        {d && d.payments.length === 0 && <EmptyState icon={Wallet} title="No payments on file" body="Square payments linked to this patient show here." />}
        {d && d.payments.length > 0 && (
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {d.payments.map((p) => (
              <li key={p.id}>
                <button className="flex w-full flex-wrap items-center justify-between gap-3 px-5 py-3 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60" onClick={() => setOpen(p.id)}>
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800 dark:text-slate-100">{p.category ? PAYMENT_CATEGORIES[p.category] : "Not sorted"}{p.clinicName ? <span className="font-normal text-slate-500"> · {p.clinicName}</span> : null}</p>
                    <p className="text-xs text-slate-500">{day(p.createdAt)} · {methodText(p)}{p.status !== "COMPLETED" ? ` · ${PAYMENT_STATUS_LABELS[p.status] ?? p.status}` : ""}</p>
                  </div>
                  <span className="text-right">
                    <span className={cn("font-semibold tabular-nums text-slate-900 dark:text-slate-50", p.status !== "COMPLETED" && "text-slate-400 line-through")}>{money(p.totalCents)}</span>
                    {p.refundedCents > 0 && <span className="block text-[11px] text-rose-700 dark:text-rose-300">−{money(p.refundedCents)} refunded</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <TakePaymentDialog open={!!take} mode={take ?? "link"} onClose={() => setTake(null)} preset={preset} />
      <PaymentDrawer id={open} onClose={() => setOpen(null)} />
    </div>
  );
}
