import { Link } from "wouter";
import {
  CalendarCheck, Users, Timer, ListTodo, UserX, AlertCircle, CalendarPlus, Radar, Upload, ArrowRight, ChevronRight, HeartPulse, Brain, Pill,
  AlertTriangle, Building2, Info, Flame, CalendarClock, CalendarX2, UserPlus,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import {
  Btn, EmptyState, ErrorNote, FLOW_DOT, Loading, MetricCard, Panel, SectionLabel, TONE_TEXT, ToneTile, cardCls, fmtMinutes, type Tone,
} from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { FLOW_COLUMNS, FLOW_LABELS, type FlowStatus } from "@shared/workspace";
import { CLINIC_TZ } from "@shared/workforce";
import { cn } from "@/lib/utils";

function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: CLINIC_TZ, hour: "numeric", hourCycle: "h23" }).format(new Date()));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

const EDGE: Record<Tone, string> = {
  info: "border-l-tone-info",
  brand: "border-l-brand",
  success: "border-l-tone-success",
  warning: "border-l-tone-warning",
  danger: "border-l-tone-danger",
  violet: "border-l-tone-violet",
  neutral: "border-l-slate-300",
};

interface PriorityItem {
  href: string;
  icon: React.ElementType;
  eyebrow: string;
  title: string;
  tone: Tone;
}

function Priority({ href, icon, eyebrow, title, tone }: PriorityItem) {
  return (
    <Link href={href}>
      <div className={cn(cardCls, "group flex items-center gap-3 border-l-[3px] px-4 py-3 hover:border-slate-300 transition-colors cursor-pointer", EDGE[tone])}>
        <ToneTile icon={icon} tone={tone} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{eyebrow}</p>
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{title}</p>
        </div>
        <ChevronRight size={16} className="text-slate-400 group-hover:text-slate-600 shrink-0" />
      </div>
    </Link>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function WorkspaceHome() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const home = trpc.workspace.home.useQuery({ clinicId: ws.clinicId }, { enabled: !!user && !!ws.caps?.tasks, refetchInterval: 60_000 });

  if (!user) return null;
  const firstName = (user.name ?? "").replace(/\(.*?\)/g, "").trim().split(" ")[0];
  const todayLabel = new Date().toLocaleDateString("en-US", { timeZone: CLINIC_TZ, weekday: "long", month: "long", day: "numeric" });
  const d = home.data;
  const caps = ws.caps;

  const priorities: PriorityItem[] = [];
  if (d) {
    if (d.tasks.overdue) priorities.push({ href: "/my-work?view=overdue", icon: AlertCircle, eyebrow: "Tasks", title: `${plural(d.tasks.overdue, "task")} overdue`, tone: "danger" });
    if (d.flow.longestWait >= 20) priorities.push({ href: "/patient-flow", icon: Timer, eyebrow: "Patient flow", title: `${plural(d.flow.waiting, "patient")} waiting · longest ${fmtMinutes(d.flow.longestWait)}`, tone: "warning" });
    if (d.tasks.dueToday) priorities.push({ href: "/my-work?view=due_today", icon: CalendarClock, eyebrow: "Tasks", title: `${plural(d.tasks.dueToday, "task")} due today`, tone: "info" });
    if (d.tasks.high) priorities.push({ href: "/my-work?view=high", icon: Flame, eyebrow: "Tasks", title: `${plural(d.tasks.high, "high-priority task")} open`, tone: "violet" });
    if (caps?.opportunitiesView && d.openingsTomorrow) priorities.push({ href: "/opportunities?tab=openings", icon: CalendarPlus, eyebrow: "Scheduling", title: `${plural(d.openingsTomorrow, "opening")} next clinic day`, tone: "brand" });
    if (d.opportunities?.missed) priorities.push({ href: "/opportunities?category=missed_appointment", icon: UserX, eyebrow: "Outreach", title: `${plural(d.opportunities.missed, "no-show")} not rebooked`, tone: "danger" });
    if (d.opportunities?.cancelled) priorities.push({ href: "/opportunities?category=cancelled_not_rebooked", icon: CalendarX2, eyebrow: "Outreach", title: `${plural(d.opportunities.cancelled, "cancellation")} not rebooked`, tone: "warning" });
    if (d.opportunities?.newNoReturn) priorities.push({ href: "/opportunities?category=new_patient_no_return", icon: UserPlus, eyebrow: "Outreach", title: `${plural(d.opportunities.newNoReturn, "new patient")} never came back`, tone: "violet" });
    if (d.opportunities?.lapsed) priorities.push({ href: "/opportunities?category=lapsed_follow_up", icon: Radar, eyebrow: "Outreach", title: `${plural(d.opportunities.lapsed, "patient")} not seen in 3+ months`, tone: "info" });
    if (d.care?.pendingRefills) priorities.push({ href: "/refill-requests", icon: Pill, eyebrow: "Provider items", title: `${plural(d.care.pendingRefills, "refill request")} pending`, tone: "violet" });
    if (d.care?.pendingEscalations) priorities.push({ href: "/escalations", icon: AlertTriangle, eyebrow: "Provider items", title: `${plural(d.care.pendingEscalations, "escalation")} awaiting review`, tone: "danger" });
  }

  const statuses = [...FLOW_COLUMNS, "no_show"] as FlowStatus[];
  const flowTotal = d ? statuses.reduce((s, c) => s + (d.byStatus[c] ?? 0), 0) : 0;
  const showOpenings = !!caps?.opportunitiesView;
  const hasRight = !!d && (showOpenings || !!d.care);

  return (
    <CCMDashboardLayout title="Home" clinicPicker pageTitle={false}>
      <div className="mb-6">
        <p className="text-sm text-slate-500 dark:text-slate-400">{todayLabel}</p>
        <h2 className="mt-0.5 text-2xl md:text-[28px] font-bold tracking-tight text-slate-900 dark:text-slate-50">
          {greeting()}{firstName ? `, ${firstName}` : ""}.
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Let's make today a good day for great care.</p>
      </div>

      {caps && !caps.tasks && (
        <Panel><EmptyState icon={Info} title="Your account doesn't have a Workspace role yet" body="Ask a practice manager to assign your role on the Team & Access page." /></Panel>
      )}

      {ws.noClinicAccess && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          You aren't linked to a clinic today, so there's no schedule to show. Ask your manager to set your home clinic (Workforce → People) or add today's shift.
        </div>
      )}

      {home.error && <ErrorNote message={home.error.message} />}
      {caps?.tasks && home.isLoading && <Loading />}

      {d && (
        <div className="space-y-7">
          {!d.scheduleLoadedToday && caps?.flowView && (
            <div className={cn(cardCls, "flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm")}>
              <span className="flex items-center gap-3 text-slate-700 dark:text-slate-200">
                <ToneTile icon={Upload} tone="info" size="sm" /> Today's schedule hasn't been imported from Practice Fusion yet.
              </span>
              {caps.scheduleImport ? (
                <Link href="/patient-flow?import=1"><Btn size="sm">Import schedule</Btn></Link>
              ) : (
                <span className="text-slate-500">The front desk imports it each morning.</span>
              )}
            </div>
          )}

          <section>
            <SectionLabel>Today</SectionLabel>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <MetricCard label="Appointments" value={d.flow.total} hint={`${d.byStatus.scheduled ?? 0} still to arrive`} icon={CalendarCheck} iconTone="info" href={caps?.flowView ? "/patient-flow" : undefined} />
              <MetricCard label="Patients in clinic" value={d.flow.inClinic} hint={`${d.flow.waiting} waiting to be seen`} icon={Users} iconTone="brand" href={caps?.flowView ? "/patient-flow" : undefined} />
              <MetricCard label="Average wait" value={fmtMinutes(d.flow.avgWait)} hint={`Longest now ${fmtMinutes(d.flow.longestWait)}`} tone={d.flow.longestWait >= 30 ? "bad" : d.flow.longestWait >= 20 ? "warn" : "neutral"} icon={Timer} iconTone="warning" />
              <MetricCard label="My open tasks" value={d.tasks.mine} hint={d.tasks.overdue ? `${d.tasks.overdue} overdue` : "Nothing overdue"} tone={d.tasks.overdue ? "bad" : "neutral"} icon={ListTodo} iconTone="neutral" href="/my-work" />
              <MetricCard label="No-shows" value={d.flow.noShows} hint={d.flow.total ? `${Math.round((d.flow.noShows / d.flow.total) * 100)}% of today's visits` : "No visits yet"} icon={UserX} iconTone="danger" />
            </div>
          </section>

          <div className={cn("grid grid-cols-1 gap-6", hasRight && "lg:grid-cols-3")}>
            <div className={cn("space-y-6 min-w-0", hasRight && "lg:col-span-2")}>
              <section>
                <SectionLabel>Today's priorities</SectionLabel>
                {priorities.length === 0 ? (
                  <Panel><EmptyState icon={CalendarCheck} title="You're all caught up" body="No overdue work, long waits or pending follow-ups right now." /></Panel>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {priorities.slice(0, 8).map((p) => <Priority key={p.title} {...p} />)}
                  </div>
                )}
              </section>

              <Panel
                title="Today's appointments"
                subtitle={`${plural(d.flow.total, "appointment")} ${ws.clinicId ? "at this clinic" : "across your clinics"}`}
                action={caps?.flowView ? <Link href="/patient-flow" className="inline-flex items-center gap-1 text-sm font-semibold text-slate-800 dark:text-slate-100 hover:underline">Patient Flow <ArrowRight size={14} /></Link> : undefined}
              >
                {flowTotal === 0 ? (
                  <p className="text-sm text-slate-500 py-4 text-center">No appointments on today's schedule.</p>
                ) : (
                  <>
                    {/* Share of today's visits in each status; the legend below carries the labels and counts. */}
                    <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label="Today's appointments by status">
                      {statuses.map((s) => {
                        const n = d.byStatus[s] ?? 0;
                        if (!n) return null;
                        return <div key={s} className={cn("h-full", FLOW_DOT[s])} style={{ width: `${(n / flowTotal) * 100}%` }} title={`${FLOW_LABELS[s]}: ${n}`} />;
                      })}
                    </div>
                    <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2.5">
                      {statuses.map((s) => (
                        <div key={s} className="flex items-center gap-2 text-sm">
                          <span className={cn("w-2 h-2 rounded-full shrink-0", FLOW_DOT[s])} />
                          <dt className="flex-1 text-slate-600 dark:text-slate-300 truncate">{FLOW_LABELS[s]}</dt>
                          <dd className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{d.byStatus[s] ?? 0}</dd>
                        </div>
                      ))}
                    </dl>
                  </>
                )}
                <div className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-700 grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[
                    { label: "Throughput", value: `${d.flow.completed}/${d.flow.total}` },
                    { label: "Waiting now", value: d.flow.waiting },
                    { label: "Tasks done today", value: d.tasks.completedToday },
                    { label: "Tasks due today", value: d.tasks.dueToday },
                  ].map((x) => (
                    <div key={x.label}>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{x.label}</p>
                      <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{x.value}</p>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>

            {hasRight && (
              <div className="space-y-6 min-w-0">
                {showOpenings && (
                  <div className="rounded-xl bg-[#1a1b1f] text-white p-6 shadow-lg relative overflow-hidden">
                    <div className="pointer-events-none absolute -right-16 -top-16 w-48 h-48 rounded-full bg-brand/25 blur-3xl" />
                    <p className="relative text-[11px] font-semibold uppercase tracking-wider text-orange-300">Fill the right openings</p>
                    <p className="relative mt-2 text-lg font-bold leading-snug">
                      {d.opportunities?.uniquePatients
                        ? `${plural(d.opportunities.uniquePatients, "patient")} may be appropriate for upcoming appointment openings.`
                        : "Keep the schedule full with the right patients."}
                    </p>
                    <p className="relative mt-2 text-sm text-slate-300">
                      {plural(d.openingsToday, "open slot")} left today, {d.openingsTomorrow} on the next clinic day. Overdue follow-ups and missed appointments are ready for staff review.
                    </p>
                    <Link href="/opportunities?tab=openings">
                      <Btn variant="brand" className="relative mt-4">Find patients to schedule <ArrowRight size={15} /></Btn>
                    </Link>
                  </div>
                )}

                {d.care && (
                  <Panel title="Care management snapshot" bodyClassName="p-0">
                    <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                      {[
                        { icon: HeartPulse, tone: "brand" as Tone, label: "CCM calls completed", value: `${d.care.ccmDone} / ${d.care.ccmTotal}`, href: "/worklist" },
                        { icon: Brain, tone: "violet" as Tone, label: "BHI check-ins completed", value: `${d.care.bhiDone} / ${d.care.bhiTotal}`, href: "/worklist" },
                        { icon: Pill, tone: "info" as Tone, label: "Refill requests pending", value: d.care.pendingRefills, href: "/refill-requests" },
                        { icon: AlertTriangle, tone: "danger" as Tone, label: "Provider escalations pending", value: d.care.pendingEscalations, href: "/escalations" },
                      ].map((r) => (
                        <li key={r.label}>
                          <Link href={r.href}>
                            <div className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 dark:hover:bg-slate-700/40 cursor-pointer">
                              <r.icon size={16} className={TONE_TEXT[r.tone]} />
                              <span className="flex-1 text-sm text-slate-700 dark:text-slate-200">{r.label}</span>
                              <span className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">{r.value}</span>
                            </div>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </Panel>
                )}
              </div>
            )}
          </div>

          {!ws.clinicId && d.perClinic.length > 1 && (
            <section>
              <SectionLabel>Clinics today</SectionLabel>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                {d.perClinic.map((c) => (
                  <button key={c.id} onClick={() => ws.setClinicId(c.id)} className={cn(cardCls, "text-left p-4 hover:border-slate-300 transition-colors")}>
                    <p className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100"><Building2 size={14} className="text-slate-400" /> {c.name}</p>
                    <dl className="mt-3 grid grid-cols-3 gap-2">
                      <div><dt className="text-[11px] text-slate-500">Booked</dt><dd className="text-lg font-semibold tabular-nums">{c.appointments}</dd></div>
                      <div><dt className="text-[11px] text-slate-500">In clinic</dt><dd className="text-lg font-semibold tabular-nums">{c.inClinic}</dd></div>
                      <div><dt className="text-[11px] text-slate-500">Done</dt><dd className="text-lg font-semibold tabular-nums">{c.completed}</dd></div>
                    </dl>
                    {c.noShows > 0 && <p className="mt-2 text-xs text-tone-danger">{plural(c.noShows, "no-show")}</p>}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </CCMDashboardLayout>
  );
}
