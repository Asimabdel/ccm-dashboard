import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { CalendarPlus, CheckSquare, EyeOff, Info, ListPlus, Loader2, Radar, Square, CalendarClock, Clock, UserSearch } from "lucide-react";
import { FillSchedule } from "@/components/workspace/FillSchedule";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, Panel, SectionLabel, fmtDob, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { addDays, fmtDay, fmtTime, localDateStr } from "@shared/workforce";
import { OPPORTUNITY_CATEGORY_LIST, OPPORTUNITY_INFO, TASK_CATEGORIES, TASK_CATEGORY_LABELS, WORKSPACE_ROLE_LABELS, type OpportunityCategory } from "@shared/workspace";
import { cn } from "@/lib/utils";
import { PhoneLink } from "@/components/phone/PhoneLink";

const TASK_CATEGORY_FOR: Record<OpportunityCategory, string> = {
  missed_appointment: "patient_call",
  cancelled_not_rebooked: "patient_call",
  new_patient_no_return: "patient_call",
  lapsed_follow_up: "patient_call",
  overdue_follow_up: "patient_call",
  diabetes_follow_up: "patient_call",
  hypertension_follow_up: "patient_call",
  ccm_eligible: "care_management",
  bhi_candidate: "care_management",
  rpm_eligible: "care_management",
};

const SCHEDULE_CATEGORIES = new Set<OpportunityCategory>(["missed_appointment", "cancelled_not_rebooked", "new_patient_no_return", "lapsed_follow_up"]);
const MAX_SELECT = 500;

export default function OpportunitiesPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const [params, setParams] = useUrlParams();
  const tab = params.get("tab") === "openings" ? "openings" : params.get("tab") === "fill" ? "fill" : "patients";
  const fillProvider = Number(params.get("provider")) || null;
  const category = (params.get("category") as OpportunityCategory) || null;

  return (
    <CCMDashboardLayout title="Opportunity Finder" clinicPicker pageTitle={false}>
      <PageHeader
        title="Opportunity Finder"
        subtitle="Patients who may need outreach, based on simple, visible rules. Suggestions only — nothing contacts a patient automatically."
      />
      <div className="flex gap-1 mb-5 border-b border-slate-200 dark:border-slate-700 overflow-x-auto" role="tablist">
        {[
          { key: "patients", label: "Patient opportunities", icon: Radar },
          { key: "fill", label: "Fill a schedule", icon: UserSearch },
          { key: "openings", label: "Open slots", icon: CalendarPlus },
        ].map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setParams({ tab: t.key === "patients" ? null : t.key })}
            className={cn("flex shrink-0 items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap", tab === t.key ? "border-brand text-slate-900 dark:text-slate-50" : "border-transparent text-slate-500 hover:text-slate-800")}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      {user && ws.caps?.opportunitiesView === false && <ErrorNote message="You don't have access to Opportunity Finder." />}
      {user && ws.caps?.opportunitiesView && (
        tab === "openings" ? <Openings clinicId={ws.clinicId} />
          : tab === "fill" ? <FillSchedule providerParam={fillProvider} onProvider={(id) => setParams({ provider: id })} />
          : <PatientOpportunities clinicId={ws.clinicId} category={category} onCategory={(c) => setParams({ category: c })} />
      )}
    </CCMDashboardLayout>
  );
}

function PatientOpportunities({ clinicId, category, onCategory }: { clinicId: number | null; category: OpportunityCategory | null; onCategory: (c: string | null) => void }) {
  const { caps } = useWorkspace();
  const summary = trpc.workspace.opportunities.summary.useQuery({ clinicId });
  const [includeActioned, setIncludeActioned] = useState(false);
  const list = trpc.workspace.opportunities.list.useQuery({ category: category ?? "missed_appointment", clinicId, includeActioned }, { enabled: !!category });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [taskOpen, setTaskOpen] = useState(false);
  const utils = trpc.useUtils();

  const act = trpc.workspace.opportunities.act.useMutation({
    onSuccess: (r, v) => {
      toast.success(v.action === "task_created" ? `Created ${r.tasks} task${r.tasks === 1 ? "" : "s"}.` : `Marked ${r.count} as ${v.action === "dismissed" ? "dismissed" : "reviewed"}.`);
      setSelected(new Set());
      setTaskOpen(false);
      void utils.workspace.opportunities.invalidate();
      void utils.workspace.home.invalidate();
      void utils.workspace.tasks.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  // Bulk actions take up to 500 people at a time (the highest-priority ones first).
  const selectable = rows.slice(0, MAX_SELECT);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.key));
  const toggle = (key: string) => setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.size < MAX_SELECT && n.add(key); return n; });
  const canAct = !!caps?.opportunitiesAct;

  return (
    <div className="space-y-5">
      {summary.error && <ErrorNote message={summary.error.message} />}
      {summary.data && (!summary.data.scheduleThrough || summary.data.scheduleThrough < addDays(localDateStr(), 14)) && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <Info size={16} className="mt-0.5 shrink-0" />
          <span>
            {summary.data.scheduleThrough
              ? <>Upcoming appointments are only imported through <b>{fmtDay(summary.data.scheduleThrough, { month: "short", day: "numeric", year: "numeric" })}</b>. </>
              : <>No schedule has been imported yet. </>}
            Patients booked after that will still show as "nothing booked" — export the upcoming months from Practice Fusion and import them on Patient Flow.
          </span>
        </div>
      )}
      {[
        { label: "From the schedule (everyone)", list: OPPORTUNITY_CATEGORY_LIST.filter((c) => SCHEDULE_CATEGORIES.has(c)) },
        { label: "From the CCM roster", list: OPPORTUNITY_CATEGORY_LIST.filter((c) => !SCHEDULE_CATEGORIES.has(c)) },
      ].map((group) => (
      <section key={group.label}>
      <SectionLabel>{group.label}</SectionLabel>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {group.list.map((c) => {
          const n = summary.data?.counts[c] ?? 0;
          const active = category === c;
          return (
            <button
              key={c}
              onClick={() => { setSelected(new Set()); onCategory(active ? null : c); }}
              className={cn("text-left rounded-xl border bg-white p-4 shadow-[0_1px_2px_rgba(20,21,25,0.04)] transition-colors", active ? "border-brand ring-1 ring-brand/40" : "border-slate-200 dark:border-slate-700 hover:border-slate-300")}
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{OPPORTUNITY_INFO[c].label}</p>
                <span className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{summary.isLoading ? "…" : n}</span>
              </div>
              <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{OPPORTUNITY_INFO[c].description}</p>
            </button>
          );
        })}
      </div>
      </section>
      ))}

      {!category && (
        <Panel>
          <EmptyState icon={Radar} title="Pick a category to see the patients" body={summary.data ? `${summary.data.uniquePatients} patients have at least one open opportunity${clinicId ? " at this clinic" : ""}.` : undefined} />
        </Panel>
      )}

      {category && (
        <Panel
          title={
            <span className="flex items-center gap-2">
              {OPPORTUNITY_INFO[category].label}
              <span className="text-xs font-normal text-slate-500">Suggested next step: {OPPORTUNITY_INFO[category].action.toLowerCase()}</span>
            </span>
          }
          action={
            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={includeActioned} onChange={(e) => setIncludeActioned(e.target.checked)} /> Show already handled (30 days)
            </label>
          }
          bodyClassName="p-0"
        >
          {canAct && selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700 text-sm">
              <span className="font-semibold">{selected.size} selected</span>
              <Btn size="sm" onClick={() => setTaskOpen(true)}><ListPlus size={14} /> Create tasks</Btn>
              <Btn size="sm" variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ category, keys: Array.from(selected), action: "reviewed" })}><CheckSquare size={14} /> Mark reviewed</Btn>
              <Btn size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ category, keys: Array.from(selected), action: "dismissed" })}><EyeOff size={14} /> Dismiss</Btn>
            </div>
          )}
          {list.isLoading && <Loading />}
          {list.error && <div className="p-4"><ErrorNote message={list.error.message} /></div>}
          {list.data && rows.length === 0 && <EmptyState icon={CheckSquare} title="Nobody here right now" body="Handled patients are hidden for 30 days." />}
          {total > rows.length && <p className="px-4 py-2 text-xs text-slate-500 border-b border-slate-100 dark:border-slate-700">Showing the top {rows.length.toLocaleString()} of {total.toLocaleString()} by priority. Handle these first, or pick a clinic to narrow the list.</p>}
          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-500 bg-slate-50/70 dark:bg-slate-800">
                  <tr>
                    {canAct && (
                      <th className="w-10 px-4 py-2">
                        <button aria-label={allSelected ? "Clear selection" : "Select all"} title={rows.length > MAX_SELECT ? `Selects the top ${MAX_SELECT}` : undefined} onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.key)))}>
                          {allSelected ? <CheckSquare size={16} className="text-brand" /> : <Square size={16} className="text-slate-400" />}
                        </button>
                      </th>
                    )}
                    <th className="text-left font-medium px-3 py-2">Patient</th>
                    <th className="text-left font-medium px-3 py-2">Why</th>
                    <th className="text-left font-medium px-3 py-2 hidden md:table-cell">Clinic · Provider</th>
                    <th className="text-left font-medium px-3 py-2 hidden lg:table-cell">Last visit</th>
                    <th className="text-left font-medium px-3 py-2 hidden lg:table-cell">Phone</th>
                    <th className="text-left font-medium px-3 py-2">Handled</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {rows.map((r) => (
                    <tr key={r.key} className={cn(selected.has(r.key) && "bg-brand/5")}>
                      {canAct && (
                        <td className="px-4 py-2.5">
                          <button aria-label={`Select ${r.name}`} onClick={() => toggle(r.key)}>
                            {selected.has(r.key) ? <CheckSquare size={16} className="text-brand" /> : <Square size={16} className="text-slate-400" />}
                          </button>
                        </td>
                      )}
                      <td className="px-3 py-2.5">
                        {r.patientId ? (
                          <Link href={`/patients/${r.patientId}?tab=overview`} className="font-medium text-slate-900 dark:text-slate-50 hover:underline">{r.name}</Link>
                        ) : (
                          <span className="font-medium text-slate-900 dark:text-slate-50">{r.name}</span>
                        )}
                        <span className="block text-xs text-slate-500">
                          DOB {fmtDob(r.dateOfBirth)}{r.patientId ? "" : " · not on CCM roster"}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-slate-600 dark:text-slate-300">{r.reason}</td>
                      <td className="px-3 py-2.5 text-slate-500 hidden md:table-cell">{r.clinicName ?? "—"}{r.providerName ? ` · ${r.providerName}` : ""}</td>
                      <td className="px-3 py-2.5 text-slate-500 hidden lg:table-cell whitespace-nowrap">{fmtShortDate(r.lastOfficeVisit)}</td>
                      <td className="px-3 py-2.5 text-slate-500 hidden lg:table-cell whitespace-nowrap">{r.phoneNumber ? <PhoneLink phone={r.phoneNumber} context={{ patientId: r.patientId, subjectKey: r.key, name: r.name, source: category }} /> : "—"}</td>
                      <td className="px-3 py-2.5 text-xs text-slate-500 whitespace-nowrap">{r.lastAction ? `${r.lastAction.replace("_", " ")} ${fmtShortDate(r.lastActionAt)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="flex items-start gap-2 px-4 py-3 text-xs text-slate-500 border-t border-slate-100 dark:border-slate-700">
            <Info size={13} className="mt-0.5 shrink-0" /> Schedule rules use every appointment imported from Practice Fusion (last 13 months); roster rules use the CCM roster. Check the chart before calling.
          </p>
        </Panel>
      )}

      {category && (
        <CreateTasksDialog
          open={taskOpen}
          onOpenChange={setTaskOpen}
          count={selected.size}
          category={category}
          pending={act.isPending}
          onSubmit={(v) => act.mutate({ category, keys: Array.from(selected), action: "task_created", ...v })}
        />
      )}
    </div>
  );
}

function CreateTasksDialog({ open, onOpenChange, count, category, pending, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; count: number; category: OpportunityCategory; pending: boolean; onSubmit: (v: { taskTitle: string; taskCategory: string; assigneeId: number | null }) => void }) {
  const { caps } = useWorkspace();
  const assignees = trpc.workspace.tasks.assignees.useQuery(undefined, { enabled: open && !!caps?.assignTasks });
  const [title, setTitle] = useState<string>(OPPORTUNITY_INFO[category].action);
  const [taskCategory, setTaskCategory] = useState(TASK_CATEGORY_FOR[category]);
  const [assignee, setAssignee] = useState("");
  useEffect(() => {
    if (!open) return;
    setTitle(OPPORTUNITY_INFO[category].action);
    setTaskCategory(TASK_CATEGORY_FOR[category]);
    setAssignee("");
  }, [open, category]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create {count} task{count === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>One task per patient, due the next clinic day. The patient's name is added to each title.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Task title</label>
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Category</label>
            <select className={inputCls} value={taskCategory} onChange={(e) => setTaskCategory(e.target.value)}>
              {TASK_CATEGORIES.map((c) => <option key={c} value={c}>{TASK_CATEGORY_LABELS[c]}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Assign to</label>
            <select className={inputCls} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">{WORKSPACE_ROLE_LABELS.staff} queue</option>
              {(assignees.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Btn variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Btn>
            <Btn disabled={pending || !title.trim()} onClick={() => onSubmit({ taskTitle: title.trim(), taskCategory, assigneeId: assignee ? Number(assignee) : null })}>
              {pending && <Loader2 size={15} className="animate-spin" />} Create tasks
            </Btn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Openings({ clinicId }: { clinicId: number | null }) {
  const { clinics } = useWorkspace();
  const [days, setDays] = useState(3);
  const q = trpc.workspace.openings.useQuery({ clinicId, days });
  const clinicName = (id: number | null) => clinics.find((c) => c.id === id)?.name ?? "Clinic";
  const today = localDateStr();

  const grouped = useMemo(() => {
    const m = new Map<string, NonNullable<typeof q.data>>();
    for (const o of q.data ?? []) {
      const k = o.date;
      (m.get(k) ?? m.set(k, []).get(k)!).push(o);
    }
    return Array.from(m.entries());
  }, [q.data]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600 dark:text-slate-300 max-w-2xl">
          Gaps of 20+ minutes between 8:00 AM and 5:00 PM in each provider's imported schedule. Cancellations and no-shows count as open. Book in Practice Fusion, then re-import.
        </p>
        <select aria-label="Days ahead" className={cn(inputCls, "w-auto")} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={0}>Today only</option>
          <option value={3}>Next 3 days</option>
          <option value={7}>Next 7 days</option>
          <option value={14}>Next 14 days</option>
        </select>
      </div>
      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {q.data && q.data.length === 0 && (
        <Panel><EmptyState icon={CalendarClock} title="No open slots found" body="Either the schedule is full, or those days haven't been imported yet. Openings only show for providers with at least one appointment that day." /></Panel>
      )}
      {grouped.map(([date, list]) => (
        <Panel key={date} title={`${date === today ? "Today" : fmtDay(date, { weekday: "long", month: "short", day: "numeric" })} · ${list.length} opening${list.length === 1 ? "" : "s"}`} bodyClassName="p-0">
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {list.map((o) => (
              <li key={`${o.providerKey}-${o.start}-${o.clinicId}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <span className="w-20 font-semibold tabular-nums">{fmtTime(o.start)}</span>
                <span className="inline-flex items-center gap-1 text-xs text-slate-500 w-20"><Clock size={12} /> {o.minutes} min</span>
                <span className="flex-1 min-w-[140px] text-slate-800 dark:text-slate-100">{o.providerName}</span>
                <span className="text-slate-500">{clinicName(o.clinicId)}</span>
              </li>
            ))}
          </ul>
          <div className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-700 text-xs text-slate-500 flex flex-wrap gap-3">
            Who to offer these to:
            <Link href="/opportunities?category=missed_appointment" className="font-semibold text-brand hover:underline">Missed appointments</Link>
            <Link href="/opportunities?category=cancelled_not_rebooked" className="font-semibold text-brand hover:underline">Cancelled, not rebooked</Link>
            <Link href="/opportunities?category=lapsed_follow_up" className="font-semibold text-brand hover:underline">No visit in 3+ months</Link>
            <Link href="/opportunities?tab=fill" className="font-semibold text-brand hover:underline">Fill a provider's schedule</Link>
          </div>
        </Panel>
      ))}
    </div>
  );
}
