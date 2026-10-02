import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { CalendarPlus, CheckSquare, Download, EyeOff, Info, ListPlus, Loader2, PhoneCall, Square, UserSearch } from "lucide-react";
import { LogCallDialog, OutreachCell, SUGGESTED_SORT, SortHeader, SortNote, StatusTabs, type ListSortState } from "@/components/outreach/Outreach";
import { CallingMode } from "@/components/outreach/CallingMode";
import { OUTREACH_TABS, type OutreachStatus } from "@shared/outreach";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, Panel, SectionLabel, fmtDob, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { addDays, fmtDay, localDateStr } from "@shared/workforce";
import { FILL_GROUPS, FILL_GROUP_LIST, FILL_LIKELIHOOD_LABELS, WORKSPACE_ROLE_LABELS, type FillGroup, type FillLikelihood } from "@shared/workspace";
import { cn } from "@/lib/utils";
import { PhoneLink } from "@/components/phone/PhoneLink";

const MAX_SELECT = 500;

const LIKELIHOOD_CLS: Record<FillLikelihood, string> = {
  very_likely: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  likely: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200",
  possible: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

const csvEscape = (v: unknown) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/**
 * Fill a provider's schedule: patients most likely to book with them, ranked by a
 * visible points score. Suggestions only — staff call, and book in Practice Fusion.
 */
export function FillSchedule({ providerParam, onProvider }: { providerParam: number | null; onProvider: (id: number | null) => void }) {
  const { caps } = useWorkspace();
  const providers = trpc.workspace.opportunities.fillProviders.useQuery();
  const [includeOtherClinics, setIncludeOtherClinics] = useState(false);
  const [status, setStatus] = useState<OutreachStatus>("to_call");
  const [sort, setSort] = useState<ListSortState>(SUGGESTED_SORT);
  const [logFor, setLogFor] = useState<{ key: string; name: string } | null>(null);
  const [calling, setCalling] = useState(false);
  const [group, setGroup] = useState<FillGroup | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [taskOpen, setTaskOpen] = useState(false);
  const providerId = providerParam;
  const fill = trpc.workspace.opportunities.fill.useQuery({ providerId: providerId ?? 0, includeOtherClinics, status, sort: sort.by, dir: sort.dir }, { enabled: !!providerId, placeholderData: (prev) => prev });
  const utils = trpc.useUtils();
  const canAct = !!caps?.opportunitiesAct;

  useEffect(() => { setSelected(new Set()); setGroup(null); setStatus("to_call"); setSort(SUGGESTED_SORT); }, [providerId, includeOtherClinics]);

  const act = trpc.workspace.opportunities.fillAct.useMutation({
    onSuccess: (r, v) => {
      toast.success(v.action === "task_created" ? `Created ${r.tasks} call task${r.tasks === 1 ? "" : "s"}.` : `Marked ${r.count} as ${v.action === "dismissed" ? "dismissed" : "reviewed"}.`);
      setSelected(new Set());
      setTaskOpen(false);
      void utils.workspace.opportunities.invalidate();
      void utils.workspace.tasks.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const data = fill.data;
  const provName = data?.provider.name ?? providers.data?.find((p) => p.id === providerId)?.name ?? "";
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => !group || r.group === group), [data, group]);
  const selectable = rows.slice(0, MAX_SELECT);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.key));
  const toggle = (key: string) => setSelected((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.size < MAX_SELECT && n.add(key); return n; });

  const exportCsv = () => {
    const list = selected.size ? rows.filter((r) => selected.has(r.key)) : rows;
    const header = ["#", "Likelihood", "Score", "Group", "Patient", "DOB", "Phone", "Why", "Last seen", "Last seen by", "Visits seen", "No-shows", "Cancellations", "Clinic", "Active in CCM", "Called on", "Outcome (booked / voicemail / no answer / declined / wrong number)", "Appointment booked for", "Notes"];
    const lines = list.map((r, i) => [
      i + 1, FILL_LIKELIHOOD_LABELS[r.likelihood], r.score, FILL_GROUPS[r.group].label, r.name, fmtDob(r.dateOfBirth), r.phoneNumber ?? "", r.reason,
      r.lastSeen ? fmtShortDate(r.lastSeen) : "never", r.lastSeenBy ?? "", r.seenCount, r.noShows, r.cancellations, r.clinicName ?? "", r.ccmActive ? "Yes" : "", "", "", "", "",
    ].map(csvEscape).join(","));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + [header.map(csvEscape).join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" }));
    a.download = `Fill_${provName.replace(/[^a-z0-9]+/gi, "_")}_schedule_${localDateStr()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success(`Exported ${list.length} patient${list.length === 1 ? "" : "s"}.`);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px]">
          <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">Whose schedule are you filling?</label>
          <select className={inputCls} value={providerId ?? ""} onChange={(e) => onProvider(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Pick a provider…</option>
            {(providers.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.clinicName ? ` — ${p.clinicName}` : ""}{p.active ? "" : " (not seeing patients)"}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 pb-2.5"><input type="checkbox" checked={includeOtherClinics} onChange={(e) => setIncludeOtherClinics(e.target.checked)} /> Include patients from other clinics</label>
      </div>

      {!providerId && (
        <Panel>
          <EmptyState icon={UserSearch} title="Pick a provider to fill their schedule" body="You'll get a ranked call list: their own patients who are due back, patients left behind by providers who stopped seeing patients, and people who booked with those providers but never came in." />
        </Panel>
      )}

      {providerId && fill.isLoading && <Loading />}
      {fill.error && <ErrorNote message={fill.error.message} />}

      {data && (
        <>
          {(!data.scheduleThrough || data.scheduleThrough < addDays(localDateStr(), 14)) && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <Info size={16} className="mt-0.5 shrink-0" />
              <span>
                {data.scheduleThrough ? <>Upcoming appointments are only imported through <b>{fmtDay(data.scheduleThrough, { month: "short", day: "numeric", year: "numeric" })}</b>. </> : <>No schedule has been imported yet. </>}
                Someone booked after that still looks unbooked here, so check Practice Fusion before calling — or import the upcoming months on Patient Flow.
              </span>
            </div>
          )}

          <section>
            <SectionLabel>{provName}'s best leads{data.provider.clinicName && !includeOtherClinics ? ` · ${data.provider.clinicName}` : ""}</SectionLabel>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {FILL_GROUP_LIST.map((g) => {
                const active = group === g;
                return (
                  <button key={g} onClick={() => { setSelected(new Set()); setGroup(active ? null : g); }}
                    className={cn("text-left rounded-xl border bg-white dark:bg-slate-900 p-4 shadow-[0_1px_2px_rgba(20,21,25,0.04)] transition-colors", active ? "border-brand ring-1 ring-brand/40" : "border-slate-200 dark:border-slate-700 hover:border-slate-300")}>
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{FILL_GROUPS[g].label}</p>
                      <span className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{data.counts[g]}</span>
                    </div>
                    <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{FILL_GROUPS[g].description}</p>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {data.stoppedProviders.length
                ? <>Counting as no longer seeing patients (fewer than 10 visits in the last 60 days): {data.stoppedProviders.map((s) => `${s.name}${s.lastSeen ? ` (last visit ${fmtShortDate(s.lastSeen)})` : ""}`).join(", ")}.</>
                : <>Every provider on the schedule is still seeing patients, so this list is {provName}'s own patients who are due back.</>}
            </p>
          </section>

          <Panel
            title={<span className="flex items-center gap-2">{group ? FILL_GROUPS[group].label : "Everyone"} <span className="text-xs font-normal text-slate-500">Most likely to book first</span></span>}
            action={
              <Btn size="sm" variant="secondary" disabled={!rows.length} onClick={exportCsv}>
                <Download size={14} /> {selected.size ? `Export ${selected.size}` : "Export call list"}
              </Btn>
            }
            bodyClassName="p-0"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-700">
              <div className="space-y-1.5">
                <StatusTabs value={status} counts={data.statusCounts} onChange={(s) => { setStatus(s); setSelected(new Set()); }} />
                <SortNote sort={sort} status={status} onReset={() => setSort(SUGGESTED_SORT)} />
              </div>
              {status === "to_call" && rows.length > 0 && <Btn size="sm" onClick={() => setCalling(true)}><PhoneCall size={14} /> Start calling</Btn>}
            </div>
            {canAct && selected.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700 text-sm">
                <span className="font-semibold">{selected.size} selected</span>
                <Btn size="sm" onClick={() => setTaskOpen(true)}><ListPlus size={14} /> Create call tasks</Btn>
                <Btn size="sm" variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ providerId: providerId!, keys: Array.from(selected), action: "reviewed" })}><CheckSquare size={14} /> Mark reviewed</Btn>
                <Btn size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ providerId: providerId!, keys: Array.from(selected), action: "dismissed" })}><EyeOff size={14} /> Dismiss</Btn>
              </div>
            )}
            {rows.length === 0 && <EmptyState icon={CalendarPlus} title={status === "to_call" ? "Nobody to call right now" : "Nobody here right now"} body={status === "to_call" ? "Everyone who fits is already booked, being worked (see the other tabs), or belongs to a provider who's still seeing patients." : OUTREACH_TABS.find((x) => x.key === status)?.hint} />}
            {data.total > data.rows.length && <p className="px-4 py-2 text-xs text-slate-500 border-b border-slate-100 dark:border-slate-700">Showing the top {data.rows.length.toLocaleString()} of {data.total.toLocaleString()}.</p>}
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
                      <SortHeader label="Patient" by="name" sort={sort} onSort={setSort} />
                      <SortHeader label="Likelihood" by="priority" sort={sort} onSort={setSort} />
                      <th className="text-left font-medium px-3 py-2">Why</th>
                      <SortHeader label="Last seen" by="lastVisit" sort={sort} onSort={setSort} className="hidden md:table-cell" />
                      <th className="text-left font-medium px-3 py-2 hidden lg:table-cell">History</th>
                      <th className="text-left font-medium px-3 py-2 hidden lg:table-cell">Phone</th>
                      <SortHeader label="Calls" by="lastCall" sort={sort} onSort={setSort} />
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
                          {r.patientId
                            ? <Link href={`/patients/${r.patientId}?tab=overview`} className="font-medium text-slate-900 dark:text-slate-50 hover:underline">{r.name}</Link>
                            : <span className="font-medium text-slate-900 dark:text-slate-50">{r.name}</span>}
                          <span className="block text-xs text-slate-500">DOB {fmtDob(r.dateOfBirth)}{r.ccmActive ? " · active in CCM" : ""}{r.clinicName !== data.provider.clinicName ? ` · ${r.clinicName ?? "clinic not recorded"}` : ""}</span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold", LIKELIHOOD_CLS[r.likelihood])}>{FILL_LIKELIHOOD_LABELS[r.likelihood]}</span>
                          <span className="ml-1.5 text-xs tabular-nums text-slate-400">{r.score}</span>
                        </td>
                        <td className="px-3 py-2.5 text-slate-600 dark:text-slate-300">{r.reason}</td>
                        <td className="px-3 py-2.5 text-slate-500 hidden md:table-cell whitespace-nowrap">{r.lastSeen ? <>{fmtShortDate(r.lastSeen)}<span className="block text-xs">{r.lastSeenBy}</span></> : "Never seen"}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-500 hidden lg:table-cell whitespace-nowrap">{r.seenCount} visit{r.seenCount === 1 ? "" : "s"}{r.noShows ? ` · ${r.noShows} no-show${r.noShows === 1 ? "" : "s"}` : ""}{r.cancellations ? ` · ${r.cancellations} cancelled` : ""}</td>
                        <td className="px-3 py-2.5 text-slate-500 hidden lg:table-cell whitespace-nowrap">{r.phoneNumber ? <PhoneLink phone={r.phoneNumber} context={{ patientId: r.patientId, subjectKey: r.key, name: r.name, source: "schedule_fill" }} className="font-medium text-slate-700 dark:text-slate-200" icon /> : <span className="text-amber-600">No phone</span>}</td>
                        <td className="px-3 py-2.5"><OutreachCell o={r.outreach} onLog={() => setLogFor({ key: r.key, name: r.name })} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="flex items-start gap-2 px-4 py-3 text-xs text-slate-500 border-t border-slate-100 dark:border-slate-700">
              <Info size={13} className="mt-0.5 shrink-0" />
              <span>
                <b>How the score works:</b> points for being their own patient or at the same clinic, for being seen recently and more often, and for being active in CCM; points off for no-shows, cancellations and no phone number. Anyone with an appointment already booked is left out. It's a ranking to decide who to call first, not a prediction — check the chart before calling.
              </span>
            </p>
          </Panel>

          <LogCallDialog target={logFor} category="schedule_fill" onClose={() => setLogFor(null)} />
          <CallingMode open={calling} category="schedule_fill" listLabel={`Fill ${provName}'s schedule`} onClose={() => setCalling(false)}
            rows={rows.map((r) => ({ ...r, providerName: provName, lastVisit: r.lastSeen }))} />
          <FillTasksDialog
            open={taskOpen}
            onOpenChange={setTaskOpen}
            count={selected.size}
            providerName={provName}
            pending={act.isPending}
            onSubmit={(v) => act.mutate({ providerId: providerId!, keys: Array.from(selected), action: "task_created", ...v })}
          />
        </>
      )}
    </div>
  );
}

function FillTasksDialog({ open, onOpenChange, count, providerName, pending, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; count: number; providerName: string; pending: boolean; onSubmit: (v: { taskTitle: string; assigneeId: number | null }) => void }) {
  const { caps } = useWorkspace();
  const assignees = trpc.workspace.tasks.assignees.useQuery(undefined, { enabled: open && !!caps?.assignTasks });
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  useEffect(() => {
    if (!open) return;
    setTitle(`Call to schedule with ${providerName}`);
    setAssignee("");
  }, [open, providerName]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create {count} call task{count === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>One task per patient, due the next clinic day, with the reason and phone number included. "Very likely" patients are marked high priority.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Task title</label>
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Assign to</label>
            <select className={inputCls} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">{WORKSPACE_ROLE_LABELS.front_desk} queue</option>
              {(assignees.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Btn variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Btn>
            <Btn disabled={pending || !title.trim()} onClick={() => onSubmit({ taskTitle: title.trim(), assigneeId: assignee ? Number(assignee) : null })}>
              {pending && <Loader2 size={15} className="animate-spin" />} Create tasks
            </Btn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
