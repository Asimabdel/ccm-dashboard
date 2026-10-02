import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { CheckCircle2, User, Building2, CalendarClock, Tag, MessageSquare, Loader2, Hand, Plane, ThumbsDown, ThumbsUp } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { trpc } from "@/lib/trpc";
import { localDateStr } from "@shared/workforce";
import { patientHref } from "@shared/folder";
import {
  TASK_CATEGORY_LABELS, TASK_PRIORITIES, TASK_PRIORITY_LABELS, TASK_STATUSES, TASK_STATUS_LABELS, WORKSPACE_ROLE_LABELS,
  type TaskCategory,
} from "@shared/workspace";
import { Btn, ErrorNote, Loading, PriorityBadge, TaskStatusBadge, fmtDob, fmtDue, fmtShortDate, inputCls } from "./ui";
import { useWorkspace } from "./useWorkspace";
import { cn } from "@/lib/utils";

const ACTIVITY_TEXT: Record<string, (meta: Record<string, unknown> | null) => string> = {
  created: () => "created the task",
  status_changed: (m) => `changed status to ${TASK_STATUS_LABELS[m?.to as keyof typeof TASK_STATUS_LABELS] ?? m?.to}`,
  priority_changed: (m) => `set priority to ${TASK_PRIORITY_LABELS[m?.to as keyof typeof TASK_PRIORITY_LABELS] ?? m?.to}`,
  assigned: (m) => (m?.to ? "reassigned the task" : "moved the task to the team queue"),
  due_date_changed: (m) => (m?.to ? `set the due date to ${m.to}` : "removed the due date"),
  comment: () => "commented",
};

const TIME_OFF_TYPE: Record<string, string> = { pto: "PTO", sick: "Sick", unpaid: "Unpaid", other: "Other" };

/** A time-off request's task: decide it right here (the task closes itself and the employee is told). */
function TimeOffDecision({ requestId, onDone }: { requestId: number; onDone: () => void }) {
  const utils = trpc.useUtils();
  const q = trpc.workforce.timeOff.get.useQuery(requestId, { retry: false });
  const [note, setNote] = useState("");
  const decide = trpc.workforce.timeOff.decide.useMutation({
    onSuccess: (res, v) => {
      void utils.workforce.invalidate();
      onDone();
      if (v.status === "approved" && res.conflicts.length) {
        toast.warning(`Approved. ${res.conflicts.length} scheduled shift${res.conflicts.length > 1 ? "s fall" : " falls"} in those dates: mark ${res.conflicts.length > 1 ? "them" : "it"} called out in Workforce → Schedule to find coverage.`, { duration: 9000 });
      } else toast.success(v.status === "approved" ? "Approved. They've been told." : "Denied. They've been told.");
    },
    onError: (e) => toast.error(e.message),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <p className="text-xs text-slate-500">{q.error.message}</p>;
  const r = q.data;
  if (!r) return null;
  if (r.status !== "pending") return <p className="rounded-xl bg-slate-50 dark:bg-slate-800 p-3 text-sm text-slate-600 dark:text-slate-300">This request was {r.status}.</p>;
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100"><Plane size={15} /> {r.userName} · {TIME_OFF_TYPE[r.type] ?? r.type}</p>
      <input className={inputCls} placeholder="Note back to them (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      <div className="grid grid-cols-2 gap-2">
        <Btn disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, status: "approved", managerNote: note.trim() || null })}><ThumbsUp size={14} /> Approve</Btn>
        <Btn variant="secondary" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, status: "denied", managerNote: note.trim() || null })}><ThumbsDown size={14} /> Deny</Btn>
      </div>
      <Link href="/workforce?tab=timeoff" className="block text-xs font-semibold text-brand hover:underline">See all requests in Workforce → Time off</Link>
    </div>
  );
}

/** Approve / Deny a staff member's change to their usual week (shown on its task). */
function ScheduleChangeDecision({ requestId, onDone }: { requestId: number; onDone: () => void }) {
  const utils = trpc.useUtils();
  const q = trpc.workforce.scheduleRequests.get.useQuery(requestId, { retry: false });
  const [note, setNote] = useState("");
  const decide = trpc.workforce.scheduleRequests.decide.useMutation({
    onSuccess: (res) => {
      void utils.workforce.invalidate();
      onDone();
      toast.success(res.approved ? `Approved. Their shifts are updated${"added" in res && res.added != null ? ` (${res.added} shifts)` : ""}, and they've been told.` : "Denied. They've been told.");
    },
    onError: (e) => toast.error(e.message),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <p className="text-xs text-slate-500">{q.error.message}</p>;
  const r = q.data;
  if (!r) return null;
  if (r.status !== "pending") return <p className="rounded-xl bg-slate-50 dark:bg-slate-800 p-3 text-sm text-slate-600 dark:text-slate-300">This request was {r.status}.</p>;
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.userName}: new usual week from {r.effectiveFrom}</p>
      <div className="grid gap-3 sm:grid-cols-2 text-xs">
        <div><p className="font-semibold text-slate-500">Requested</p><ul className="mt-1 space-y-0.5 text-slate-800 dark:text-slate-100">{r.requested.map((l, i) => <li key={i}>{l}</li>)}</ul></div>
        <div><p className="font-semibold text-slate-500">Current</p><ul className="mt-1 space-y-0.5 text-slate-600 dark:text-slate-300">{(r.current ?? ["No usual week on file"]).map((l, i) => <li key={i}>{l}</li>)}</ul></div>
      </div>
      {r.note && <p className="text-xs text-slate-600 dark:text-slate-300">Note: {r.note}</p>}
      <input className={inputCls} placeholder="Note back to them (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      <div className="grid grid-cols-2 gap-2">
        <Btn disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: true, managerNote: note.trim() || null })}><ThumbsUp size={14} /> Approve</Btn>
        <Btn variant="secondary" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: false, managerNote: note.trim() || null })}><ThumbsDown size={14} /> Deny</Btn>
      </div>
      <p className="text-[11px] text-slate-500">Approving replaces their scheduled shifts from that date (called-out and coverage shifts stay).</p>
    </div>
  );
}

export function TaskDrawer({ taskId, onClose }: { taskId: number | null; onClose: () => void }) {
  const { caps, user } = useWorkspace();
  const utils = trpc.useUtils();
  const q = trpc.workspace.tasks.detail.useQuery(taskId ?? 0, { enabled: !!taskId, retry: false });
  const assignees = trpc.workspace.tasks.assignees.useQuery(undefined, { enabled: !!taskId && !!caps?.assignTasks, staleTime: 5 * 60_000 });
  const teamQueues = trpc.workspace.teams.queues.useQuery(undefined, { enabled: !!taskId && !!caps?.assignTasks, staleTime: 5 * 60_000 });
  const [comment, setComment] = useState("");

  const refresh = () => {
    void utils.workspace.tasks.invalidate();
    void utils.workspace.home.invalidate();
    void utils.workspace.patients.summary.invalidate();
  };
  const update = trpc.workspace.tasks.update.useMutation({
    onSuccess: () => refresh(),
    onError: (e) => toast.error(e.message),
  });
  const addComment = trpc.workspace.tasks.comment.useMutation({
    onSuccess: () => {
      setComment("");
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const t = q.data;
  const today = localDateStr();
  const due = t ? fmtDue(t.dueDate, today) : null;
  const closed = t?.status === "completed" || t?.status === "cancelled";
  const timeOff = t?.sourceType === "time_off" && !!t.sourceRef;
  const scheduleChange = t?.sourceType === "schedule_change" && !!t.sourceRef;
  const inQueue = !!t && !t.assignedUserId && !!t.assignedRole;
  const queueName = t ? t.queueLabel ?? (t.assignedRole ? `${WORKSPACE_ROLE_LABELS[t.assignedRole] ?? t.assignedRole} queue` : null) : null;

  return (
    <Sheet open={!!taskId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-lg p-0 gap-0 overflow-y-auto bg-white">
        {!t && <SheetTitle className="sr-only">Task</SheetTitle>}
        {q.isLoading && <Loading />}
        {q.error && <div className="p-6"><ErrorNote message={q.error.message} /></div>}
        {t && (
          <>
            <SheetHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-700">
              <div className="flex flex-wrap items-center gap-2 pr-6">
                <TaskStatusBadge status={t.status} />
                <PriorityBadge priority={t.priority} />
                <span className="text-xs text-slate-500">{TASK_CATEGORY_LABELS[t.category as TaskCategory] ?? t.category}</span>
              </div>
              <SheetTitle className="text-lg leading-snug text-slate-900 dark:text-slate-50">{t.title}</SheetTitle>
              <SheetDescription className="text-xs">
                Created {fmtShortDate(t.createdAt)}{t.createdByName ? ` by ${t.createdByName}` : ""}
                {t.sourceType === "opportunity" ? " · from Opportunity Finder" : ""}
              </SheetDescription>
            </SheetHeader>

            <div className="shrink-0 px-6 py-5 space-y-5">
              {!closed && timeOff && <TimeOffDecision requestId={Number(t.sourceRef)} onDone={refresh} />}
              {!closed && scheduleChange && <ScheduleChangeDecision requestId={Number(t.sourceRef)} onDone={refresh} />}
              {!closed && inQueue && user && (
                <Btn variant="secondary" className="w-full" onClick={() => update.mutate({ id: t.id, assignedUserId: user.id })} disabled={update.isPending}>
                  <Hand size={15} /> Take it (sent to {queueName})
                </Btn>
              )}
              {!closed && !timeOff && (
                <Btn className="w-full" onClick={() => update.mutate({ id: t.id, status: "completed" })} disabled={update.isPending}>
                  {update.isPending ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={16} />} Mark complete
                </Btn>
              )}
              {t.status === "completed" && (
                <Btn variant="secondary" className="w-full" onClick={() => update.mutate({ id: t.id, status: "open" })} disabled={update.isPending}>Reopen task</Btn>
              )}

              {t.description && <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{t.description}</p>}

              {(t.patientId || t.subjectKey) && (
                <div className="rounded-xl bg-slate-50 dark:bg-slate-800 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Patient</p>
                  <Link href={patientHref(t.patientId ? `p:${t.patientId}` : t.subjectKey!, "tasks")} className="font-semibold text-slate-900 dark:text-slate-50 hover:underline">{t.patientName}</Link>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {t.patientDob ? `DOB ${fmtDob(t.patientDob)}` : ""}
                    {t.patientDob && t.patientPhone ? " · " : ""}
                    {t.patientPhone ?? ""}
                  </p>
                </div>
              )}

              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-xs text-slate-500 flex items-center gap-1.5 mb-1"><Tag size={12} /> Status</dt>
                  <select className={inputCls} value={t.status} disabled={t.status === "cancelled"} onChange={(e) => update.mutate({ id: t.id, status: e.target.value })}>
                    {TASK_STATUSES.map((s) => <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>)}
                  </select>
                </div>
                <div>
                  <dt className="text-xs text-slate-500 flex items-center gap-1.5 mb-1">Priority</dt>
                  <select className={inputCls} value={t.priority} disabled={closed} onChange={(e) => update.mutate({ id: t.id, priority: e.target.value })}>
                    {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{TASK_PRIORITY_LABELS[p]}</option>)}
                  </select>
                </div>
                <div>
                  <dt className="text-xs text-slate-500 flex items-center gap-1.5 mb-1"><CalendarClock size={12} /> Due date</dt>
                  <input type="date" className={inputCls} value={t.dueDate ?? ""} disabled={closed} onChange={(e) => update.mutate({ id: t.id, dueDate: e.target.value || null })} />
                  {due && <p className={cn("mt-1 text-xs", due.overdue ? "text-rose-600 font-medium" : "text-slate-500")}>{due.text}</p>}
                </div>
                <div>
                  <dt className="text-xs text-slate-500 flex items-center gap-1.5 mb-1"><User size={12} /> Assigned to</dt>
                  {caps?.assignTasks ? (
                    <select
                      className={inputCls}
                      disabled={closed}
                      value={t.assignedUserId ? `u${t.assignedUserId}` : t.assignedRole ? `r${t.assignedRole}` : ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v.startsWith("u")) update.mutate({ id: t.id, assignedUserId: Number(v.slice(1)) });
                        else update.mutate({ id: t.id, assignedUserId: null, assignedRole: v ? v.slice(1) : null });
                      }}
                    >
                      <option value="">Unassigned</option>
                      <optgroup label="Team queue">
                        {["staff", "front_desk", "medical_assistant", "provider", "billing"].map((r) => <option key={r} value={`r${r}`}>{WORKSPACE_ROLE_LABELS[r]} queue</option>)}
                      </optgroup>
                      {(teamQueues.data?.length || t.queueLabel) ? (
                        <optgroup label="Provider teams">
                          {(teamQueues.data ?? []).map((tq) => <option key={tq.key} value={`r${tq.key}`}>{tq.label}</option>)}
                          {t.queueLabel && t.assignedRole && !(teamQueues.data ?? []).some((tq) => tq.key === t.assignedRole) && <option value={`r${t.assignedRole}`}>{t.queueLabel}</option>}
                        </optgroup>
                      ) : null}
                      <optgroup label="People">
                        {(assignees.data ?? []).map((u) => <option key={u.id} value={`u${u.id}`}>{u.name}</option>)}
                      </optgroup>
                    </select>
                  ) : (
                    <p className="py-2 font-medium text-slate-800 dark:text-slate-100">{t.assigneeName ?? queueName ?? "Unassigned"}</p>
                  )}
                </div>
                {t.clinicName && (
                  <div className="col-span-2">
                    <dt className="text-xs text-slate-500 flex items-center gap-1.5"><Building2 size={12} /> Clinic</dt>
                    <dd className="mt-1 font-medium text-slate-800 dark:text-slate-100">{t.clinicName}</dd>
                  </div>
                )}
              </dl>

              <div>
                <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-3 flex items-center gap-1.5"><MessageSquare size={14} /> Activity</h4>
                <ol className="space-y-3 border-l border-slate-200 dark:border-slate-700 pl-4">
                  {t.activities.map((a) => (
                    <li key={a.id} className="relative">
                      <span className="absolute -left-[21px] top-1.5 w-2.5 h-2.5 rounded-full bg-slate-300 dark:bg-slate-600 ring-4 ring-white dark:ring-slate-800" />
                      <p className="text-xs text-slate-500">
                        <span className="font-semibold text-slate-700 dark:text-slate-200">{a.userName ?? "Someone"}</span> {(ACTIVITY_TEXT[a.type] ?? (() => a.type))(a.meta as Record<string, unknown> | null)}
                        {" · "}{new Date(a.createdAt).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </p>
                      {a.body && <p className="mt-1 text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap rounded-lg bg-slate-50 dark:bg-slate-800 px-3 py-2">{a.body}</p>}
                    </li>
                  ))}
                </ol>
                <form
                  className="mt-4 space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (comment.trim()) addComment.mutate({ id: t.id, body: comment.trim() });
                  }}
                >
                  <textarea className={cn(inputCls, "min-h-[72px]")} placeholder="Add a comment (no clinical notes — those belong in Practice Fusion)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={5000} />
                  <div className="flex justify-end">
                    <Btn size="sm" variant="secondary" type="submit" disabled={!comment.trim() || addComment.isPending}>Add comment</Btn>
                  </div>
                </form>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
