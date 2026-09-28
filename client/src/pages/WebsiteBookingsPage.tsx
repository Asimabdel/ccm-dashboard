import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Ban, CalendarCheck, CalendarPlus, ClipboardSignature, History, Loader2, PhoneMissed, ShieldAlert, XCircle } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, Panel, inputCls } from "@/components/workspace/ui";
import { PhoneLink } from "@/components/phone/PhoneLink";
import { chartHref } from "@/components/chart/ChartLookup";
import { SendFormsDialog, type SendPreset } from "@/components/intake/SendFormsDialog";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { BOOKING_STATUS_LABELS, type BookingStatus } from "@shared/booking";

type Filter = "open" | "scheduled" | "closed" | "earlier" | "all";
const TABS: { k: Filter; label: string; icon: React.ElementType }[] = [
  { k: "open", label: "To call", icon: CalendarPlus },
  { k: "scheduled", label: "Scheduled", icon: CalendarCheck },
  { k: "closed", label: "Didn't book / spam", icon: XCircle },
  { k: "earlier", label: "Earlier (from email)", icon: History },
  { k: "all", label: "All", icon: CalendarPlus },
];
const STATUS_CLS: Record<BookingStatus, string> = {
  new: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  no_answer: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  scheduled: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  not_booked: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  spam: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  earlier: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
};
const ago = (d: Date | string) => {
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
};
const mins = (n: number) => (n < 60 ? `${n} min` : `${Math.floor(n / 60)}h ${String(n % 60).padStart(2, "0")}m`);

/** Appointment requests from mypcpdr.com: call to confirm, book in Practice Fusion, mark how it went. */
export default function WebsiteBookingsPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const deepLink = typeof window !== "undefined" ? Number(new URLSearchParams(window.location.search).get("b")) || null : null;
  const [filter, setFilter] = useState<Filter>(deepLink ? "all" : "open");
  const enabled = !!user && !!ws.caps?.emailTriage;
  const list = trpc.workspace.bookings.list.useQuery({ filter }, { enabled, refetchInterval: 30_000 });
  const stats = trpc.workspace.bookings.stats.useQuery(undefined, { enabled, refetchInterval: 60_000 });
  const utils = trpc.useUtils();
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [formsFor, setFormsFor] = useState<SendPreset | null>(null);
  const refresh = () => { void utils.workspace.bookings.invalidate(); void utils.workspace.tasks.invalidate(); void utils.workspace.metrics.invalidate(); };
  const set = trpc.workspace.bookings.setStatus.useMutation({
    onSuccess: (_r, v) => { refresh(); setNotes((n) => ({ ...n, [v.id]: "" })); toast.success(BOOKING_STATUS_LABELS[v.status]); },
    onError: (e) => toast.error(e.message),
  });
  const importEarlier = trpc.workspace.bookings.importEarlier.useMutation();
  const [importing, setImporting] = useState(false);
  const loadEarlier = async () => {
    setImporting(true);
    try {
      let token: string | null = null, added = 0;
      for (let i = 0; i < 20; i++) {
        const r = await importEarlier.mutateAsync({ pageToken: token });
        added += r.added;
        token = r.pageToken;
        if (!r.remaining) break;
      }
      refresh();
      toast.success(`Loaded ${added} earlier website booking${added === 1 ? "" : "s"} from the practice mailbox.`);
      setFilter("earlier");
    } catch (e) { toast.error((e as Error).message); } finally { setImporting(false); }
  };

  const rows = list.data ?? [];
  const s = stats.data;
  return (
    <CCMDashboardLayout title="Website bookings" pageTitle={false}>
      <PageHeader
        title="Website bookings"
        subtitle="Appointment requests from mypcpdr.com. Call to confirm, book it in Practice Fusion, then mark how it went."
        actions={user?.role === "admin" ? <Btn variant="secondary" size="sm" disabled={importing} onClick={loadEarlier}>{importing ? <Loader2 size={14} className="animate-spin" /> : <History size={14} />} Load earlier bookings from email</Btn> : undefined}
      />
      {ws.caps && !ws.caps.emailTriage && <ErrorNote message="You don't have access to website bookings." />}
      {s && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <Stat label="Waiting for a call" value={s.waiting} tone={s.waiting ? "warn" : undefined} />
          <Stat label="Requests (30 days)" value={s.received30} />
          <Stat label="Scheduled (30 days)" value={s.scheduled30} sub={s.received30 ? `${Math.round((s.scheduled30 / s.received30) * 100)}% of requests` : undefined} />
          <Stat label="Typical time to first call" value={s.medianFirstCallMin != null ? mins(s.medianFirstCallMin) : "—"} sub="Median, last 30 days" />
        </div>
      )}
      <div className="flex gap-1 mb-5 border-b border-slate-200 dark:border-slate-700 overflow-x-auto" role="tablist">
        {TABS.map((t) => (
          <button key={t.k} role="tab" aria-selected={filter === t.k} onClick={() => setFilter(t.k)}
            className={cn("flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap", filter === t.k ? "border-brand text-slate-900 dark:text-slate-50" : "border-transparent text-slate-500 hover:text-slate-800")}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      {list.isLoading && <Loading />}
      {list.error && <ErrorNote message={list.error.message} />}
      {list.data && rows.length === 0 && (
        <Panel><EmptyState icon={CalendarPlus} title={filter === "open" ? "Nobody waiting" : "Nothing here"} body={filter === "open" ? "New requests from the website booking form show up here the moment they're sent, with a call task for the front desk at that clinic." : "Requests show up here as they come in from mypcpdr.com."} /></Panel>
      )}
      {rows.length > 0 && (
        <Panel bodyClassName="p-0">
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {rows.map((b) => {
              const open = b.status === "new" || b.status === "no_answer";
              const waitingMin = Math.round((Date.now() - new Date(b.receivedAt).getTime()) / 60000);
              return (
                <li key={b.id} className={cn("px-4 py-3 text-sm", deepLink === b.id && "bg-amber-50/70 dark:bg-amber-900/20")}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-900 dark:text-slate-50">{b.name}</span>
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS_CLS[b.status])}>{BOOKING_STATUS_LABELS[b.status]}{b.status === "no_answer" && b.attempts > 1 ? ` ×${b.attempts}` : ""}</span>
                        {b.spanish && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800 dark:bg-sky-900/40 dark:text-sky-200">Español</span>}
                        {b.subjectKey
                          ? <Link href={chartHref(b.subjectKey)} className="text-xs font-semibold text-emerald-700 hover:underline dark:text-emerald-300">Existing patient: {b.patientName}</Link>
                          : <span className="text-xs font-semibold text-violet-700 dark:text-violet-300">New patient</span>}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
                        {[b.visitType, b.clinicName ?? b.location, b.provider].filter(Boolean).join(" · ") || "No preferences given"}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Wants <b className="text-slate-700 dark:text-slate-200">{b.preferred ?? "any time"}</b> · sent {ago(b.receivedAt)}
                        {open && waitingMin >= 60 && <span className="ml-1 font-semibold text-amber-700 dark:text-amber-300">(waiting {mins(waitingMin)})</span>}
                        {b.assignee && open ? ` · ${b.assignee}` : ""}
                        {b.firstContactAt && !open && b.source === "website" ? ` · first call after ${mins(Math.max(0, Math.round((new Date(b.firstContactAt).getTime() - new Date(b.receivedAt).getTime()) / 60000)))}` : ""}
                      </p>
                      {b.note && <p className="mt-1 whitespace-pre-line text-xs text-slate-500">{b.note}</p>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <div className="flex items-center gap-2">
                        {ws.caps?.intakeForms && b.status !== "spam" && b.status !== "earlier" && (
                          <Btn size="sm" variant="ghost" title="Text or email this person their intake forms"
                            onClick={() => setFormsFor({ subjectKey: b.subjectKey, name: b.patientName ?? b.name, phone: b.phone, language: b.spanish ? "es" : "en", clinicId: b.clinicId, bookingRequestId: b.id })}>
                            <ClipboardSignature size={13} /> Send forms
                          </Btn>
                        )}
                        <PhoneLink phone={b.phone} context={{ patientId: b.patientId, subjectKey: b.subjectKey, name: b.name, source: "website_booking" }} className="text-sm font-semibold text-brand hover:underline" />
                      </div>
                      {open && (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <input className={cn(inputCls, "h-8 w-44 text-xs")} placeholder="Note (optional)" value={notes[b.id] ?? ""} onChange={(e) => setNotes({ ...notes, [b.id]: e.target.value })} maxLength={500} />
                          <Btn size="sm" disabled={set.isPending} onClick={() => set.mutate({ id: b.id, status: "scheduled", note: notes[b.id] || null })}><CalendarCheck size={13} /> Scheduled</Btn>
                          <Btn size="sm" variant="secondary" disabled={set.isPending} onClick={() => set.mutate({ id: b.id, status: "no_answer", note: notes[b.id] || null })}><PhoneMissed size={13} /> No answer</Btn>
                          <Btn size="sm" variant="ghost" disabled={set.isPending} onClick={() => set.mutate({ id: b.id, status: "not_booked", note: notes[b.id] || null })}><Ban size={13} /> Didn't book</Btn>
                          <Btn size="sm" variant="ghost" disabled={set.isPending} title="Spam or a test" onClick={() => set.mutate({ id: b.id, status: "spam", note: notes[b.id] || null })}><ShieldAlert size={13} /></Btn>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
      <SendFormsDialog open={!!formsFor} preset={formsFor} onClose={() => setFormsFor(null)} />
    </CCMDashboardLayout>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: number | string; sub?: string; tone?: "warn" }) {
  return (
    <div className={cn("rounded-xl border px-4 py-3", tone === "warn" ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800")}>
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{value}</p>
      {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}
