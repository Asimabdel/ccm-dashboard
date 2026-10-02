import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, DoorOpen, Loader2, MoreHorizontal, Upload, CalendarX2, ArrowRight, Timer, History, CalendarCheck, Users, Hourglass, CheckCircle2, UserX, Video, Syringe } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { DoximityButtons } from "@/components/phone/DoximityButtons";
import { InjectionDialog } from "@/components/injections/InjectionDialog";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { ScheduleImportDialog } from "@/components/workspace/ScheduleImportDialog";
import { Btn, EmptyState, ErrorNote, FLOW_DOT, FlowBadge, Loading, MetricCard, PageHeader, fmtClock, fmtMinutes, inputCls, minutesSince } from "@/components/workspace/ui";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { addDays, fmtDay, localDateStr } from "@shared/workforce";
import { FLOW_COLUMNS, FLOW_LABELS, WAITING_STATUSES, checkFlowTransition, type FlowStatus } from "@shared/workspace";
import { cn } from "@/lib/utils";

type Board = RouterOutputs["workspace"]["flow"]["board"];
type Card = Board["cards"][number];

interface PendingMove {
  card: Card;
  to: FlowStatus;
  reason: string;
}

function WaitChip({ card }: { card: Card }) {
  // Waiting time counts from arrival while the patient hasn't been seen yet.
  const waiting = WAITING_STATUSES.includes(card.status as FlowStatus) && card.arrivedAt;
  const m = waiting ? minutesSince(card.arrivedAt) : minutesSince(card.statusSince);
  if (m == null) return null;
  const tone = waiting ? (m >= 30 ? "text-rose-700 bg-rose-50 dark:bg-rose-950 dark:text-rose-300" : m >= 20 ? "text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300" : "text-slate-600 bg-slate-100 dark:bg-slate-700 dark:text-slate-300") : "text-slate-500 bg-slate-100 dark:bg-slate-700 dark:text-slate-300";
  return (
    <span className={cn("inline-flex items-center gap-1 shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums", tone)} title={waiting ? "Waiting since arrival" : "Time in this status"}>
      <Timer size={11} /> {fmtMinutes(m)}
    </span>
  );
}

export default function PatientFlowPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const [params, setParams] = useUrlParams();
  const today = localDateStr();
  const date = params.get("date") || today;
  const [importOpen, setImportOpen] = useState(params.get("import") === "1");
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [room, setRoom] = useState("");
  const [dragId, setDragId] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [injectionFor, setInjectionFor] = useState<Card | null>(null);
  const [, setTick] = useState(0);
  const utils = trpc.useUtils();

  // Re-render every 30s so wait timers stay current between refetches.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const input = { clinicId: ws.clinicId, date };
  const board = trpc.workspace.flow.board.useQuery(input, { enabled: !!user && !!ws.caps?.flowView, refetchInterval: date === today ? 30_000 : false });

  const move = trpc.workspace.flow.move.useMutation({
    onMutate: async (v) => {
      await utils.workspace.flow.board.cancel(input);
      const prev = utils.workspace.flow.board.getData(input);
      utils.workspace.flow.board.setData(input, (old) =>
        old ? { ...old, cards: old.cards.map((c) => (c.id === v.appointmentId ? { ...c, status: v.to as Card["status"], statusSince: new Date(), room: v.room !== undefined ? v.room : c.room, arrivedAt: v.to === "arrived" && !c.arrivedAt ? new Date() : c.arrivedAt } : c)) } : old,
      );
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) utils.workspace.flow.board.setData(input, ctx.prev);
      toast.error(e.message);
    },
    onSettled: () => {
      void utils.workspace.flow.board.invalidate();
      void utils.workspace.home.invalidate();
    },
  });

  const requestMove = (card: Card, to: FlowStatus) => {
    const check = checkFlowTransition(card.status as FlowStatus, to);
    if (!check.allowed) {
      toast.error(check.reason);
      return;
    }
    if (check.requiresConfirmation || to === "roomed") {
      setRoom(card.room ?? "");
      setPending({ card, to, reason: check.requiresConfirmation ? check.reason ?? "Confirm this change?" : "Move to Roomed" });
      return;
    }
    move.mutate({ appointmentId: card.id, to, confirmed: false });
  };

  const byStatus = useMemo(() => {
    const m: Record<string, Card[]> = {};
    for (const c of board.data?.cards ?? []) (m[c.status] ??= []).push(c);
    return m;
  }, [board.data]);

  if (!user) return null;
  const caps = ws.caps;
  const canMove = !!caps?.flowUpdate;
  const metrics = board.data?.metrics;
  const offBoard = [...(byStatus.no_show ?? []), ...(byStatus.cancelled ?? [])];
  const isToday = date === today;

  return (
    <CCMDashboardLayout title="Patient Flow" clinicPicker pageTitle={false}>
      <PageHeader
        title="Patient Flow"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <button className="p-1 rounded hover:bg-slate-200/60" aria-label="Previous day" onClick={() => setParams({ date: addDays(date, -1) === today ? null : addDays(date, -1) })}><ChevronLeft size={16} /></button>
            <span className="font-medium text-slate-700 dark:text-slate-200">{isToday ? "Today" : fmtDay(date, { weekday: "long", month: "short", day: "numeric" })}</span>
            <button className="p-1 rounded hover:bg-slate-200/60" aria-label="Next day" onClick={() => setParams({ date: addDays(date, 1) === today ? null : addDays(date, 1) })}><ChevronRight size={16} /></button>
            {!isToday && <button className="text-xs font-semibold underline" onClick={() => setParams({ date: null })}>Back to today</button>}
          </span>
        }
        actions={caps?.scheduleImport ? <Btn onClick={() => setImportOpen(true)}><Upload size={15} /> Import schedule</Btn> : undefined}
      />

      {ws.noClinicAccess && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          You aren't linked to a clinic today. Ask your manager to set your home clinic or add today's shift.
        </div>
      )}

      {metrics && (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
          <MetricCard label="Appointments" value={metrics.total} icon={CalendarCheck} iconTone="info" />
          <MetricCard label="In clinic" value={metrics.inClinic} icon={Users} iconTone="brand" />
          <MetricCard label="Waiting" value={metrics.waiting} hint="Arrived → roomed" tone={metrics.waiting > 3 ? "warn" : "neutral"} icon={Hourglass} iconTone="warning" />
          <MetricCard label="Average wait" value={fmtMinutes(metrics.avgWait)} hint={`Longest now ${fmtMinutes(metrics.longestWait)}`} tone={metrics.longestWait >= 30 ? "bad" : metrics.longestWait >= 20 ? "warn" : "neutral"} icon={Timer} iconTone="neutral" />
          <MetricCard label="Completed" value={metrics.completed} icon={CheckCircle2} iconTone="success" />
          <MetricCard label="No-shows" value={metrics.noShows} icon={UserX} iconTone="danger" />
        </div>
      )}

      {board.isLoading && <Loading />}
      {board.error && <ErrorNote message={board.error.message} />}

      {board.data && board.data.cards.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 dark:border-slate-700">
          <EmptyState
            icon={CalendarX2}
            title={`No appointments ${isToday ? "today" : "on this day"}`}
            body={caps?.scheduleImport ? "Import the day's schedule from Practice Fusion to fill the board." : "The front desk imports the schedule from Practice Fusion each morning."}
            action={caps?.scheduleImport ? <Btn onClick={() => setImportOpen(true)}><Upload size={15} /> Import schedule</Btn> : undefined}
          />
        </div>
      )}

      {board.data && board.data.cards.length > 0 && (
        <>
          <div className="flex gap-3 overflow-x-auto pb-3 snap-x" role="list" aria-label="Patient flow board">
            {FLOW_COLUMNS.map((col) => {
              const cards = byStatus[col] ?? [];
              return (
                <section
                  key={col}
                  role="listitem"
                  aria-label={`${FLOW_LABELS[col]}: ${cards.length}`}
                  className={cn("snap-start shrink-0 w-[260px] rounded-xl bg-slate-100 dark:bg-slate-800/60 border border-transparent flex flex-col max-h-[calc(100vh-330px)] min-h-[200px]", overCol === col && "border-brand/60 bg-brand/5")}
                  onDragOver={(e) => { if (canMove && dragId) { e.preventDefault(); setOverCol(col); } }}
                  onDragLeave={() => setOverCol((c) => (c === col ? null : c))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setOverCol(null);
                    const card = board.data!.cards.find((c) => c.id === dragId);
                    setDragId(null);
                    if (card && card.status !== col) requestMove(card, col);
                  }}
                >
                  <header className="flex items-center justify-between px-3 pt-3 pb-2">
                    <span className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                      <span className={cn("w-2 h-2 rounded-full", FLOW_DOT[col])} /> {FLOW_LABELS[col]}
                    </span>
                    <span className="min-w-[22px] text-center text-xs font-semibold tabular-nums text-slate-500 bg-white dark:bg-slate-700 rounded-full px-1.5 py-0.5">{cards.length}</span>
                  </header>
                  <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-2">
                    {cards.map((c) => (
                      <FlowCard key={c.id} card={c} canMove={canMove} onMove={requestMove} onDragStart={() => setDragId(c.id)} onDragEnd={() => { setDragId(null); setOverCol(null); }} busy={move.isPending && move.variables?.appointmentId === c.id} onInjection={caps?.injections ? setInjectionFor : undefined} />
                    ))}
                    {cards.length === 0 && <p className="text-center text-xs text-slate-400 py-6">No patients</p>}
                  </div>
                </section>
              );
            })}
          </div>

          {offBoard.length > 0 && (
            <div className="mt-4 bg-white rounded-xl border border-slate-200 dark:border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-3">No-shows and cancellations ({offBoard.length})</h3>
              <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                {offBoard.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <span className="w-16 text-slate-500 tabular-nums">{fmtClock(c.startsAt)}</span>
                    <span className="flex-1 min-w-[140px] font-medium">{c.patientId ? <Link href={`/patients/${c.patientId}?tab=overview`} className="hover:underline">{c.patientName}</Link> : c.patientName}</span>
                    <span className="text-slate-500">{c.provider}</span>
                    <FlowBadge status={c.status} />
                    {canMove && c.status === "no_show" && (
                      <Btn size="sm" variant="ghost" onClick={() => requestMove(c, "arrived")}>Arrived after all</Btn>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500 flex items-center gap-1.5">
            <History size={12} /> {canMove ? "Drag a card or use its menu to move a patient. Every change is logged." : "View only."} Statuses here don't change Practice Fusion.
          </p>
        </>
      )}

      <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.reason}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending && (
                <>
                  {pending.card.patientName}: {FLOW_LABELS[pending.card.status as FlowStatus]} → <strong>{FLOW_LABELS[pending.to]}</strong>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending?.to === "roomed" && (
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1" htmlFor="room">Room (optional)</label>
              <input id="room" className={inputCls} value={room} onChange={(e) => setRoom(e.target.value)} maxLength={40} placeholder="e.g. Exam 3" autoFocus />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!pending) return;
                const check = checkFlowTransition(pending.card.status as FlowStatus, pending.to);
                move.mutate({ appointmentId: pending.card.id, to: pending.to, confirmed: check.allowed && check.requiresConfirmation, room: pending.to === "roomed" ? room.trim() || null : undefined });
                setPending(null);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ScheduleImportDialog open={importOpen} onOpenChange={(o) => { setImportOpen(o); if (!o && params.get("import")) setParams({ import: null }); }} onImported={(first) => { if (first && first !== date) setParams({ date: first === today ? null : first, import: null }); }} />
      {injectionFor && <InjectionDialog open onOpenChange={(o) => !o && setInjectionFor(null)} subjectKey={injectionFor.subjectKey} patientName={injectionFor.patientName} date={date} />}
    </CCMDashboardLayout>
  );
}

function FlowCard({ card, canMove, onMove, onDragStart, onDragEnd, busy, onInjection }: { card: Card; canMove: boolean; onMove: (c: Card, to: FlowStatus) => void; onDragStart: () => void; onDragEnd: () => void; busy: boolean; onInjection?: (c: Card) => void }) {
  const idx = FLOW_COLUMNS.indexOf(card.status as (typeof FLOW_COLUMNS)[number]);
  const next = idx >= 0 && idx < FLOW_COLUMNS.length - 1 ? FLOW_COLUMNS[idx + 1] : null;
  return (
    <article
      draggable={canMove}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragEnd={onDragEnd}
      className={cn("rounded-xl bg-white border border-slate-200 dark:border-slate-700 p-3 shadow-sm", canMove && "cursor-grab active:cursor-grabbing", busy && "opacity-60")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 tabular-nums">
            {fmtClock(card.startsAt)} · {card.durationMin}m
            {card.room && <span className="inline-flex items-center gap-0.5 font-medium text-slate-600 dark:text-slate-300"> · <DoorOpen size={11} /> {card.room}</span>}
          </p>
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-50 truncate">
            {card.patientId ? <Link href={`/patients/${card.patientId}?tab=overview`} className="hover:underline">{card.patientName}</Link> : card.patientName}
          </p>
        </div>
        {canMove && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1 -mr-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400" aria-label={`Move ${card.patientName}`}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : <MoreHorizontal size={16} />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>Move to</DropdownMenuLabel>
              {FLOW_COLUMNS.filter((s) => s !== card.status).map((s) => (
                <DropdownMenuItem key={s} onClick={() => onMove(card, s)}>{FLOW_LABELS[s]}</DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {card.status === "scheduled" && <DropdownMenuItem className="text-rose-600" onClick={() => onMove(card, "no_show")}>No-show</DropdownMenuItem>}
              <DropdownMenuItem className="text-slate-500" onClick={() => onMove(card, "cancelled")}>Cancelled</DropdownMenuItem>
              {onInjection && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onInjection(card)}><Syringe size={14} className="mr-2" /> Injection given…</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 truncate">{card.provider}{card.visitType ? ` · ${card.visitType}` : ""}</p>
      {card.telehealth && (
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-sky-700 dark:text-sky-300">
          <Video size={11} /> Video visit
          <DoximityButtons phone={card.phoneNumber} kinds={["video"]} />
        </p>
      )}
      {card.reason && <p className="mt-0.5 text-xs text-slate-400 truncate" title={card.reason}>{card.reason}</p>}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <WaitChip card={card} />
        </div>
        {canMove && next && (
          <button
            onClick={() => onMove(card, next)}
            className="inline-flex items-center gap-1 shrink-0 whitespace-nowrap rounded-lg px-1.5 py-1 text-[11px] font-semibold text-brand hover:bg-brand/10"
            title={`Move to ${FLOW_LABELS[next]}`}
          >
            {FLOW_LABELS[next]} <ArrowRight size={12} />
          </button>
        )}
      </div>
    </article>
  );
}
