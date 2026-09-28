import { useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { AlertCircle, CalendarClock, CheckCircle2, Circle, Flame, Inbox, ListTodo, Plus, Search, Users, CheckCheck, Layers } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { TaskDrawer } from "@/components/workspace/TaskDrawer";
import { NewTaskDialog } from "@/components/workspace/NewTaskDialog";
import { Btn, EmptyState, ErrorNote, Loading, MetricCard, PageHeader, PriorityBadge, TaskStatusBadge, fmtDue, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { localDateStr } from "@shared/workforce";
import { TASK_CATEGORIES, TASK_CATEGORY_LABELS, TASK_PRIORITIES, TASK_PRIORITY_LABELS, TASK_STATUSES, TASK_STATUS_LABELS, WORKSPACE_ROLE_LABELS, type TaskCategory } from "@shared/workspace";
import { cn } from "@/lib/utils";

type View = "mine" | "team" | "due_today" | "overdue" | "high" | "completed" | "all";

const VIEWS: { key: View; label: string; icon: React.ElementType; count?: "mine" | "team" | "dueToday" | "overdue" | "high" }[] = [
  { key: "mine", label: "My tasks", icon: ListTodo, count: "mine" },
  { key: "team", label: "Team queue", icon: Users, count: "team" },
  { key: "due_today", label: "Due today", icon: CalendarClock, count: "dueToday" },
  { key: "overdue", label: "Overdue", icon: AlertCircle, count: "overdue" },
  { key: "high", label: "High priority", icon: Flame, count: "high" },
  { key: "completed", label: "Completed", icon: CheckCheck },
];

export default function MyWorkPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const [params, setParams] = useUrlParams();
  const view = (params.get("view") as View) || "mine";
  const status = params.get("status") || "";
  const priority = params.get("priority") || "";
  const category = params.get("category") || "";
  const due = params.get("due") || "";
  const taskParam = Number(params.get("task")) || null;
  const [q, setQ] = useState(params.get("q") ?? "");
  const [newOpen, setNewOpen] = useState(false);
  const utils = trpc.useUtils();

  useEffect(() => {
    const t = setTimeout(() => setParams({ q: q.trim() || null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const enabled = !!user && !!ws.caps?.tasks;
  const counts = trpc.workspace.tasks.counts.useQuery({ clinicId: ws.clinicId }, { enabled });
  const list = trpc.workspace.tasks.list.useQuery(
    {
      view,
      clinicId: ws.clinicId,
      status: status || undefined,
      priority: priority || undefined,
      category: category || undefined,
      due: (due || undefined) as "overdue" | "today" | "week" | "none" | undefined,
      q: params.get("q") || undefined,
    },
    { enabled },
  );
  const update = trpc.workspace.tasks.update.useMutation({
    onSuccess: (_r, v) => {
      if (v.status === "completed") toast.success("Task completed.");
      void utils.workspace.tasks.invalidate();
      void utils.workspace.home.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  if (!user) return null;
  const today = localDateStr();
  const c = counts.data;
  const views: typeof VIEWS = user.role === "admin" || user.role === "office_manager" ? [...VIEWS, { key: "all", label: user.role === "admin" ? "All tasks" : "All office tasks", icon: Layers }] : VIEWS;
  const filtersActive = !!(status || priority || category || due || params.get("q"));

  return (
    <CCMDashboardLayout title="My Work" clinicPicker pageTitle={false}>
      <PageHeader
        title="My Work"
        subtitle="Your tasks and your team's queue across the clinics you work in."
        actions={<Btn onClick={() => setNewOpen(true)}><Plus size={16} /> New task</Btn>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <MetricCard label="My open tasks" value={c?.mine ?? "—"} icon={ListTodo} iconTone="neutral" />
        <MetricCard label="Due today" value={c?.dueToday ?? "—"} hint={c?.dueToday ? "Needs attention today" : "Nothing due today"} tone={c?.dueToday ? "warn" : "neutral"} icon={CalendarClock} iconTone="warning" />
        <MetricCard label="Overdue" value={c?.overdue ?? "—"} hint={c?.overdue ? "Past their due date" : "All caught up"} tone={c?.overdue ? "bad" : "good"} icon={AlertCircle} iconTone="danger" />
        <MetricCard label="Completed today" value={c?.completedToday ?? "—"} icon={CheckCircle2} iconTone="success" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
        {/* Views rail (horizontal scroll on small screens) */}
        <nav className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible -mx-1 px-1 pb-1" aria-label="Task views">
          {views.map((v) => {
            const n = v.count && c ? c[v.count] : null;
            const active = view === v.key;
            return (
              <button
                key={v.key}
                onClick={() => setParams({ view: v.key === "mine" ? null : v.key })}
                className={cn(
                  "flex shrink-0 items-center gap-2.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors",
                  active ? "bg-white shadow-[0_1px_2px_rgba(20,21,25,0.04)] border border-slate-200 dark:border-slate-700 font-semibold text-slate-900 dark:text-slate-50" : "text-slate-600 dark:text-slate-300 hover:bg-white/70",
                )}
              >
                <v.icon size={16} className={active ? "text-brand" : "text-slate-400"} />
                <span className="flex-1 text-left">{v.label}</span>
                {n != null && n > 0 && <span className={cn("text-xs tabular-nums", v.key === "overdue" ? "text-rose-600 font-semibold" : "text-slate-400")}>{n}</span>}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0">
          {/* Filters: one row above the list */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative flex-1 min-w-[180px] max-w-sm">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className={cn(inputCls, "pl-9")} placeholder="Search tasks or patients" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tasks" />
            </div>
            <select aria-label="Status" className={cn(inputCls, "w-auto")} value={status} onChange={(e) => setParams({ status: e.target.value || null })}>
              <option value="">Any status</option>
              {TASK_STATUSES.map((s) => <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>)}
            </select>
            <select aria-label="Priority" className={cn(inputCls, "w-auto")} value={priority} onChange={(e) => setParams({ priority: e.target.value || null })}>
              <option value="">Any priority</option>
              {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{TASK_PRIORITY_LABELS[p]}</option>)}
            </select>
            <select aria-label="Category" className={cn(inputCls, "w-auto")} value={category} onChange={(e) => setParams({ category: e.target.value || null })}>
              <option value="">Any category</option>
              {TASK_CATEGORIES.map((k) => <option key={k} value={k}>{TASK_CATEGORY_LABELS[k]}</option>)}
            </select>
            <select aria-label="Due" className={cn(inputCls, "w-auto")} value={due} onChange={(e) => setParams({ due: e.target.value || null })}>
              <option value="">Any due date</option>
              <option value="overdue">Overdue</option>
              <option value="today">Due today</option>
              <option value="week">Next 7 days</option>
              <option value="none">No due date</option>
            </select>
            {filtersActive && (
              <button className="text-xs font-semibold text-slate-500 hover:text-slate-800 px-2" onClick={() => { setQ(""); setParams({ status: null, priority: null, category: null, due: null, q: null }); }}>
                Clear
              </button>
            )}
          </div>

          <div className="bg-white rounded-xl border border-slate-200 dark:border-slate-700 shadow-[0_1px_2px_rgba(20,21,25,0.04)] overflow-hidden">
            {list.isLoading && <Loading />}
            {list.error && <div className="p-4"><ErrorNote message={list.error.message} /></div>}
            {list.data && list.data.length === 0 && (
              <EmptyState
                icon={Inbox}
                title={view === "completed" ? "Nothing completed yet" : filtersActive ? "No tasks match these filters" : "No open tasks here"}
                body={view === "mine" && !filtersActive ? "New tasks assigned to you will show up here." : undefined}
                action={!filtersActive && view !== "completed" ? <Btn variant="secondary" onClick={() => setNewOpen(true)}><Plus size={15} /> New task</Btn> : undefined}
              />
            )}
            {list.data && list.data.length > 0 && (
              <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                {list.data.map((t) => {
                  const d = fmtDue(t.dueDate, today);
                  const done = t.status === "completed";
                  return (
                    <li key={t.id} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50/80 dark:hover:bg-slate-800/60">
                      <button
                        className="mt-0.5 shrink-0 text-slate-300 hover:text-emerald-600 disabled:opacity-50"
                        aria-label={done ? "Completed" : `Complete ${t.title}`}
                        disabled={done || t.status === "cancelled" || update.isPending}
                        onClick={() => update.mutate({ id: t.id, status: "completed" })}
                      >
                        {done ? <CheckCircle2 size={20} className="text-emerald-600" /> : <Circle size={20} />}
                      </button>
                      <button className="flex-1 min-w-0 text-left" onClick={() => setParams({ task: t.id })}>
                        <p className={cn("text-sm font-medium text-slate-900 dark:text-slate-50 truncate", done && "line-through text-slate-400")}>{t.title}</p>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 flex flex-wrap gap-x-2">
                          <span>{TASK_CATEGORY_LABELS[t.category as TaskCategory] ?? t.category}</span>
                          {t.patientName && <span>· {t.patientName}</span>}
                          {t.clinicName && <span className="hidden sm:inline">· {t.clinicName}</span>}
                          <span>· {t.assigneeName ?? (t.assignedRole ? `${WORKSPACE_ROLE_LABELS[t.assignedRole] ?? t.assignedRole} queue` : "Unassigned")}</span>
                        </p>
                      </button>
                      <div className="hidden sm:flex items-center gap-2 shrink-0">
                        {t.status !== "open" && !done && <TaskStatusBadge status={t.status} />}
                        {t.priority !== "normal" && <PriorityBadge priority={t.priority} />}
                      </div>
                      <span className={cn("shrink-0 w-24 sm:w-28 text-right text-xs", done ? "text-slate-400" : d.overdue ? "text-rose-600 font-semibold" : d.today ? "text-amber-700 font-medium" : "text-slate-500")}>
                        {done ? "Done" : d.text}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {list.data && list.data.length >= 300 && <p className="mt-2 text-xs text-slate-500">Showing the first 300 tasks. Narrow the filters to see more.</p>}
          {ws.caps && !ws.caps.patientFull && (
            <p className="mt-3 text-xs text-slate-500">Need to add a patient to a task? Open them from <Link href="/patient-flow" className="underline">Patient Flow</Link>.</p>
          )}
        </div>
      </div>

      <TaskDrawer taskId={taskParam} onClose={() => setParams({ task: null })} />
      <NewTaskDialog open={newOpen} onOpenChange={setNewOpen} />
    </CCMDashboardLayout>
  );
}
