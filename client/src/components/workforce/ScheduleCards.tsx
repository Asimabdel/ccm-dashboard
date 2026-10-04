import { useState } from "react";
import { toast } from "sonner";
import { CalendarCheck2, CalendarPlus, CheckCircle2, Copy, Hand, Loader2, RefreshCw, Repeat, UserX, Wallet } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { fmtDay, fmtDuration, fmtTime } from "@shared/workforce";

const card = "bg-white rounded-3xl border border-slate-200 p-6 shadow-soft dark:bg-slate-800 dark:border-slate-700";
const inputCls = "w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400 dark:bg-slate-800 dark:border-slate-600";

type MyOffer = { offerId: number; shiftId: number; kind: string; status: string; mine: boolean; takenBy: string | null };

/** Under a shift on My Schedule: "Can't make it" / "Offer to a coworker", and where an offer stands. */
export function ShiftActions({ shift, offer }: { shift: { id: number; status: string; date: string; startTime: string; endTime: string }; offer: MyOffer | undefined }) {
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<"callout" | "offer" | null>(null);
  const [text, setText] = useState("");
  const refresh = () => { void utils.workforce.me.schedule.invalidate(); void utils.workforce.me.myOffers.invalidate(); setMode(null); setText(""); };
  const callOut = trpc.workforce.me.callOut.useMutation({ onSuccess: (r) => { refresh(); toast.success(`Your manager knows, and ${r.coworkersTold ? `${r.coworkersTold} coworker${r.coworkersTold === 1 ? "" : "s"} can pick it up` : "it's posted for coworkers"}.`); }, onError: (e) => toast.error(e.message) });
  const offerIt = trpc.workforce.me.offerShift.useMutation({ onSuccess: (r) => { refresh(); toast.success(r.coworkersTold ? `Posted. ${r.coworkersTold} coworker${r.coworkersTold === 1 ? "" : "s"} who could take it were told.` : "Posted. Nobody with your job is free then yet."); }, onError: (e) => toast.error(e.message) });
  const cancel = trpc.workforce.me.cancelOffer.useMutation({ onSuccess: () => { refresh(); toast.success("It's yours again."); }, onError: (e) => toast.error(e.message) });

  if (offer && offer.mine && ["open", "claimed"].includes(offer.status)) {
    return (
      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">{offer.status === "claimed" ? `${offer.takenBy} is taking it (waiting for your manager)` : offer.kind === "callout" ? "Called out · posted for coverage" : "Up for grabs"}</span>
        {offer.kind === "swap" && <button onClick={() => cancel.mutate(offer.offerId)} className="font-semibold text-slate-500 hover:text-slate-800">Keep my shift</button>}
      </p>
    );
  }
  if (shift.status !== "scheduled") return null;
  if (mode) {
    return (
      <div className="mt-2 space-y-2">
        <input className={inputCls} value={text} maxLength={mode === "callout" ? 200 : 300} onChange={(e) => setText(e.target.value)}
          placeholder={mode === "callout" ? "Reason (optional; no medical details)" : "Note for coworkers (optional)"} />
        <div className="flex gap-2">
          <button onClick={() => (mode === "callout" ? callOut.mutate({ shiftId: shift.id, reason: text || null }) : offerIt.mutate({ shiftId: shift.id, note: text || null }))}
            disabled={callOut.isPending || offerIt.isPending} className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold text-white ${mode === "callout" ? "bg-rose-600 hover:bg-rose-700" : "bg-slate-900 hover:bg-slate-800"}`}>
            {(callOut.isPending || offerIt.isPending) && <Loader2 size={12} className="animate-spin" />}{mode === "callout" ? "Tell my manager" : "Post it"}
          </button>
          <button onClick={() => setMode(null)} className="rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100">Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-wrap gap-3 text-xs font-semibold">
      <button onClick={() => setMode("callout")} className="inline-flex items-center gap-1 text-rose-600 hover:text-rose-700"><UserX size={12} /> Can't make it</button>
      <button onClick={() => setMode("offer")} className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-800"><Repeat size={12} /> Offer to a coworker</button>
    </div>
  );
}

/** My Schedule: shifts coworkers posted that I could take. */
export function OpenShiftsCard() {
  const utils = trpc.useUtils();
  const q = trpc.workforce.me.openShifts.useQuery(undefined, { refetchInterval: 60_000 });
  const mine = trpc.workforce.me.myOffers.useQuery();
  const claim = trpc.workforce.me.claimShift.useMutation({
    onSuccess: () => { toast.success("Sent to the manager to approve. You'll get a notification."); void utils.workforce.me.openShifts.invalidate(); void utils.workforce.me.myOffers.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const myClaims = (mine.data ?? []).filter((o) => !o.mine && o.status === "claimed");
  if (!q.data?.length && !myClaims.length) return null;
  return (
    <div className={card}>
      <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50"><Hand size={18} className="text-emerald-600" /> Shifts up for grabs</h2>
      <p className="mt-1 text-sm text-slate-500">Coworkers with your job who can't work these. Take one and your manager approves it.</p>
      <ul className="mt-4 space-y-2">
        {(q.data ?? []).map((s) => (
          <li key={s.offerId} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 px-4 py-3 dark:border-slate-600">
            <div>
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{fmtDay(s.date)} · {fmtTime(s.startTime)}–{fmtTime(s.endTime)}</p>
              <p className="text-xs text-slate-500">{s.place} · {s.kind === "callout" ? `${s.offeredBy} called out` : `from ${s.offeredBy}`}{s.note ? ` · "${s.note}"` : ""}</p>
            </div>
            <button onClick={() => claim.mutate(s.offerId)} disabled={claim.isPending} className="shrink-0 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">I'll take it</button>
          </li>
        ))}
        {myClaims.map((o) => (
          <li key={o.offerId} className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
            You asked to take {o.offeredBy}'s shift ({fmtDay(o.date)}). Waiting for the manager.
          </li>
        ))}
      </ul>
    </div>
  );
}

/** My Schedule: put my shifts in Google / Apple / Outlook calendar. */
export function CalendarCard() {
  const utils = trpc.useUtils();
  const q = trpc.workforce.me.calendar.useQuery();
  const on = trpc.workforce.me.calendarOn.useMutation({ onSuccess: () => { void utils.workforce.me.calendar.invalidate(); toast.success("Your calendar link is ready."); }, onError: (e) => toast.error(e.message) });
  const off = trpc.workforce.me.calendarOff.useMutation({ onSuccess: () => { void utils.workforce.me.calendar.invalidate(); toast.success("Calendar link turned off."); }, onError: (e) => toast.error(e.message) });
  if (!q.data?.hasProfile) return null;
  const url = q.data.url;
  const webcal = url?.replace(/^https?:/, "webcal:");
  const copy = async () => { try { await navigator.clipboard.writeText(url!); toast.success("Link copied."); } catch { toast.message(url!); } };
  return (
    <div className={card}>
      <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50"><CalendarPlus size={18} className="text-emerald-600" /> My shifts in my phone calendar</h2>
      <p className="mt-1 text-sm text-slate-500">Your shifts and approved time off show up in Google, Apple or Outlook calendar and stay up to date (every hour or so). Only your own schedule, nothing about patients.</p>
      {!url ? (
        <button onClick={() => on.mutate()} disabled={on.isPending} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
          {on.isPending ? <Loader2 size={14} className="animate-spin" /> : <CalendarCheck2 size={14} />} Make my calendar link
        </button>
      ) : (
        <div className="mt-4 space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <a href={webcal} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"><CalendarCheck2 size={14} /> Add to Apple / Outlook</a>
            <a href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal!)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200">Add to Google Calendar</a>
            <button onClick={() => void copy()} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200"><Copy size={14} /> Copy link</button>
          </div>
          <p className="text-xs text-slate-500">Keep the link private: anyone with it can see your shifts. Lost your phone or shared it by mistake?{" "}
            <button onClick={() => on.mutate()} className="inline-flex items-center gap-1 font-semibold underline"><RefreshCw size={11} /> Make a new link</button> (the old one stops working) or{" "}
            <button onClick={() => off.mutate()} className="font-semibold underline">turn it off</button>.</p>
        </div>
      )}
    </div>
  );
}

/** My Schedule: my hours this pay period and last, and "My hours are right". */
export function PayPeriodCard() {
  const utils = trpc.useUtils();
  const reminders = trpc.workforce.me.reminders.useQuery();
  const q = trpc.workforce.me.payPeriods.useQuery(undefined, { enabled: !!reminders.data?.usesTimeClock });
  const confirm = trpc.workforce.me.confirmHours.useMutation({ onSuccess: () => { toast.success("Thanks. Your manager will approve your hours."); void utils.workforce.me.payPeriods.invalidate(); }, onError: (e) => toast.error(e.message) });
  if (!reminders.data?.usesTimeClock || !q.data) return null;
  return (
    <div className={card}>
      <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50"><Wallet size={18} className="text-emerald-600" /> My hours</h2>
      <p className="mt-1 text-sm text-slate-500">Pay periods are every 2 weeks. When one ends, check your hours and confirm them.</p>
      <div className="mt-4 space-y-3">
        {q.data.slice().reverse().map((p) => (
          <div key={p.start} className="rounded-2xl border border-slate-200 px-4 py-3 dark:border-slate-600">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{fmtDay(p.start, { month: "short", day: "numeric" })} – {fmtDay(p.end, { month: "short", day: "numeric" })}{p.current && !p.ended ? " (now)" : ""}</p>
              <p className="text-sm font-bold tabular-nums text-slate-900 dark:text-slate-50">{fmtDuration(p.totalMinutes)}{p.overtimeMinutes ? <span className="ml-1 text-xs font-semibold text-amber-600">incl. {fmtDuration(p.overtimeMinutes)} overtime</span> : null}</p>
            </div>
            {p.days.length > 0 && <p className="mt-1 text-xs text-slate-500">{p.days.map((x) => `${fmtDay(x.date, { weekday: "short", day: "numeric" })} ${fmtDuration(x.minutes)}`).join(" · ")}</p>}
            {p.missedClockOuts > 0 && <p className="mt-1 text-xs font-semibold text-amber-700">A day is missing its clock-out: use Fix a punch.</p>}
            <div className="mt-2 text-xs">
              {p.approvedAt ? <span className="inline-flex items-center gap-1 font-semibold text-emerald-600"><CheckCircle2 size={12} /> Approved by your manager</span>
                : p.confirmedAt && !p.confirmedChanged ? <span className="inline-flex items-center gap-1 font-semibold text-emerald-600"><CheckCircle2 size={12} /> You confirmed these hours</span>
                : p.ended && p.totalMinutes === 0 ? <span className="text-slate-400">No hours on the clock this period.</span>
                : p.ended ? <button onClick={() => confirm.mutate({ start: p.start })} disabled={confirm.isPending || p.missedClockOuts > 0} className="rounded-xl bg-slate-900 px-3 py-1.5 font-semibold text-white hover:bg-slate-800 disabled:opacity-50">{p.confirmedChanged ? "Hours changed: confirm again" : "My hours are right"}</button>
                : <span className="text-slate-400">You can confirm once this period ends.</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
