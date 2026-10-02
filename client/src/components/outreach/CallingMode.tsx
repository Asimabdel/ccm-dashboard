import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { ArrowLeft, Building2, CalendarDays, ChevronRight, Info, Phone, PhoneIncoming, PhoneOutgoing, ShieldCheck, Stethoscope, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Btn, fmtDob, fmtShortDate } from "@/components/workspace/ui";
import { PhoneLink } from "@/components/phone/PhoneLink";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { callScript, outcomeLabel } from "@shared/outreach";
import { formatPhone } from "@shared/phone";
import { fmtDay } from "@shared/workforce";
import { cn } from "@/lib/utils";
import { OutcomePicker, type RowOutreach } from "./Outreach";
import { setCallingMode } from "./callingState";

export interface CallRow {
  key: string;
  patientId: number | null;
  name: string;
  dateOfBirth: Date | string | null;
  phoneNumber: string | null;
  clinicId?: number | null;
  clinicName: string | null;
  providerName?: string | null;
  reason: string;
  lastVisit?: Date | string | null;
  outreach: RowOutreach;
}

const firstName = (n: string | null | undefined) => {
  const s = (n ?? "").replace(/\s*\(.*?\)/, "").trim();
  return s.includes(",") ? s.split(",")[1]!.trim().split(/\s+/)[0] ?? s : s.split(/\s+/)[0] ?? s;
};

/**
 * Calling mode: one patient at a time. Shows why they're on the list, their calls so far and what to
 * say; call through MyPCP's phone (or any phone), pick how it went, and the next patient comes up.
 * Each patient is held for this caller while they're on screen, so nobody else calls them.
 */
export function CallingMode({ open, rows, category, listLabel, onClose }: { open: boolean; rows: CallRow[]; category: string; listLabel: string; onClose: () => void }) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [i, setI] = useState(0);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [lang, setLang] = useState<"en" | "es">("en");
  const [done, setDone] = useState(0);
  const held = useRef<string | null>(null);
  // A snapshot taken when calling starts (the list refreshing in the background mustn't shift whose turn it is).
  const [queue, setQueue] = useState<CallRow[]>([]);
  const cur = queue[i] ?? null;

  const claim = trpc.workspace.outreach.claim.useMutation();
  const release = trpc.workspace.outreach.release.useMutation();
  const history = trpc.workspace.outreach.history.useQuery({ subjectKey: cur?.key ?? "p:0" }, { enabled: open && !!cur, refetchInterval: 5_000 });
  const phones = trpc.workspace.outreach.clinicPhones.useQuery(undefined, { enabled: open, staleTime: 10 * 60_000 });
  const record = trpc.workspace.outreach.record.useMutation({
    onSuccess: (r) => {
      setDone((n) => n + 1);
      toast.success(r.closed ? "Saved, and taken off the list." : "Saved.");
      held.current = null; // the server let go of the hold
      next();
    },
    onError: (e) => toast.error(e.message),
  });

  // Calling mode on/off (the phone's own after-call box steps aside while it's on).
  useEffect(() => {
    if (!open) return;
    setCallingMode(true);
    setQueue(rows.filter((r) => !r.outreach.lockedBy));
    setI(0); setSkipped(new Set()); setDone(0);
    return () => setCallingMode(false);
    // Snapshot only when calling starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Hold the patient on screen; someone else already calling them: skip ahead.
  useEffect(() => {
    if (!open || !cur) return;
    let alive = true;
    if (held.current && held.current !== cur.key) release.mutate({ subjectKey: held.current });
    held.current = null;
    claim.mutateAsync({ subjectKey: cur.key }).then((r) => {
      if (!alive) return;
      if (r.ok) held.current = cur.key;
      else { toast.message(`${r.by} is calling ${cur.name}. Skipped.`); next(); }
    }).catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cur?.key]);

  const close = () => {
    if (held.current) release.mutate({ subjectKey: held.current });
    held.current = null;
    void utils.workspace.opportunities.invalidate();
    onClose();
  };
  function next() {
    setI((x) => x + 1);
  }
  const skip = () => { if (cur) setSkipped((s) => new Set(s).add(cur.key)); next(); };

  const clinicPhone = phones.data?.find((c) => c.id === cur?.clinicId)?.phone ?? phones.data?.find((c) => c.phone)?.phone ?? "";
  const script = cur ? callScript(category, lang, {
    me: firstName(user?.name) || "your care team",
    clinic: cur.clinicName ?? "MyPCP Dr",
    clinicPhone: clinicPhone ? formatPhone(clinicPhone) : "our office",
    provider: cur.providerName ?? "your doctor",
    patient: firstName(cur.name),
  }) : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto p-0 [&>button]:hidden">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-700">
          <div className="min-w-0">
            <DialogTitle className="truncate text-base">Calling: {listLabel}</DialogTitle>
            <DialogDescription className="text-xs">
              {cur ? `Patient ${Math.min(i + 1, queue.length)} of ${queue.length}` : "All done"} · {done} saved{skipped.size ? ` · ${skipped.size} skipped` : ""}
            </DialogDescription>
          </div>
          <div className="flex items-center gap-2">
            <Btn size="sm" variant="ghost" disabled={i === 0} onClick={() => setI((x) => Math.max(0, x - 1))}><ArrowLeft size={14} /> Back</Btn>
            <Btn size="sm" variant="secondary" disabled={!cur} onClick={skip}>Skip <ChevronRight size={14} /></Btn>
            <Btn size="sm" variant="secondary" onClick={close}><X size={14} /> Stop calling</Btn>
          </div>
        </div>

        {!cur && (
          <div className="px-6 py-14 text-center">
            <p className="text-lg font-semibold text-slate-900 dark:text-slate-50">That's everyone on this list for now.</p>
            <p className="mt-1 text-sm text-slate-500">{done} call result{done === 1 ? "" : "s"} saved. Patients who need another try come back on their retry day.</p>
            <Btn className="mt-5" onClick={close}>Done</Btn>
          </div>
        )}

        {cur && (
          <div className="grid gap-5 p-5 md:grid-cols-[1.1fr_1fr]">
            <div className="space-y-4">
              <div>
                <p className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                  {cur.patientId ? <Link href={`/patients/${cur.patientId}?tab=overview`} className="hover:underline" target="_blank">{cur.name}</Link> : cur.name}
                </p>
                <p className="mt-0.5 text-sm text-slate-500">DOB {fmtDob(cur.dateOfBirth)}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
                  {cur.clinicName && <span className="inline-flex items-center gap-1"><Building2 size={13} /> {cur.clinicName}</span>}
                  {cur.providerName && <span className="inline-flex items-center gap-1"><Stethoscope size={13} /> {cur.providerName}</span>}
                  {cur.lastVisit && <span className="inline-flex items-center gap-1"><CalendarDays size={13} /> Last visit {fmtShortDate(cur.lastVisit)}</span>}
                </div>
              </div>

              {cur.phoneNumber ? (
                <PhoneLink phone={cur.phoneNumber} context={{ patientId: cur.patientId, subjectKey: cur.key, name: cur.name, source: category }}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-base font-semibold text-white hover:bg-emerald-700 hover:no-underline">
                  <Phone size={18} /> Call {formatPhone(cur.phoneNumber)}
                </PhoneLink>
              ) : <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">No phone number on file. Skip, or check the chart.</p>}

              <div className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Why they're on the list</p>
                <p className="mt-1 text-slate-700 dark:text-slate-200">{cur.reason}</p>
                <p className="mt-1 text-xs text-slate-500">{cur.outreach.label}</p>
              </div>

              {script && (
                <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-3 text-sm dark:border-sky-900 dark:bg-sky-950/30">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wide text-sky-800 dark:text-sky-200">What to say</p>
                    <div className="flex gap-1">
                      {(["en", "es"] as const).map((l) => (
                        <button key={l} onClick={() => setLang(l)} className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", lang === l ? "bg-sky-700 text-white" : "text-sky-800 hover:bg-sky-100 dark:text-sky-200 dark:hover:bg-sky-900")}>{l === "en" ? "English" : "Español"}</button>
                      ))}
                    </div>
                  </div>
                  <p className="mt-1.5 text-slate-800 dark:text-slate-100">{script.call}</p>
                  <p className="mt-2 text-xs font-semibold text-sky-800 dark:text-sky-200">Voicemail (no health details)</p>
                  <p className="mt-0.5 text-slate-700 dark:text-slate-200">{script.voicemail}</p>
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] text-slate-500"><ShieldCheck size={12} className="mt-0.5 shrink-0" /> Confirm it's the patient (name and date of birth) before saying why you're calling. Book in Practice Fusion.</p>
                </div>
              )}
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
                <p className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-50">How did it go?</p>
                <OutcomePicker key={cur.key} busy={record.isPending} submitLabel="Save and next"
                  onSubmit={(v) => record.mutate({ subjectKey: cur.key, category, ...v })} />
                <p className="mt-2 flex items-start gap-1.5 text-[11px] text-slate-500"><Info size={12} className="mt-0.5 shrink-0" /> Called through MyPCP's phone? This goes on that call. Any other phone: it's logged as a call.</p>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-700">
                <p className="border-b border-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:border-slate-700">Calls in the last 90 days</p>
                {history.data && history.data.length === 0 && <p className="px-4 py-3 text-sm text-slate-400">No calls yet.</p>}
                <ul className="max-h-60 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-700">
                  {(history.data ?? []).map((h) => (
                    <li key={h.id} className="flex items-start gap-2 px-4 py-2 text-xs">
                      {h.direction === "inbound" ? <PhoneIncoming size={13} className="mt-0.5 text-emerald-600" /> : <PhoneOutgoing size={13} className="mt-0.5 text-slate-400" />}
                      <div className="min-w-0">
                        <p className="text-slate-700 dark:text-slate-200">
                          {h.direction === "inbound" ? "They called us" : outcomeLabel(h.outcome)}{h.callBackOn ? ` (${fmtDay(h.callBackOn, { month: "short", day: "numeric" })})` : ""}
                          <span className="text-slate-400"> · {(h.by ?? h.ext ?? "").replace(/\s*\(.*?\)/, "")} · {fmtShortDate(h.at)}</span>
                        </p>
                        {h.note && <p className="text-slate-500">{h.note}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
