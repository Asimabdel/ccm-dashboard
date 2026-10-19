import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { BarChart3, CalendarClock, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, FlaskConical, ListChecks, ListPlus, Loader2, Pencil, Search, Undo2, X } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, FlowBadge, Loading, PageHeader, SelectBox, cardCls, fmtClock, fmtDob, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { MarkTestsDialog, ReportButton, STATE_TEXT, TEST_PILL, TestDetailsDialog, dayText } from "@/components/testing/OfficeTests";
import { SeenSince } from "@/components/workspace/SeenSince";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { patientHref } from "@shared/folder";
import { SEEN_STATUSES } from "@shared/workspace";
import { addDays, localDateStr } from "@shared/workforce";
import {
  OFFICE_TESTS, OFFICE_TEST_LABELS, OFFICE_TEST_NAMES, OFFICE_TEST_STATES, OFFICE_TEST_STATE_LABELS, QUALIFIER_LABELS, TEST_QUALIFIERS,
  type OfficeTest, type OfficeTestRecordStatus, type OfficeTestState,
} from "@shared/officeTests";

type Row = RouterOutputs["workspace"]["officeTests"]["list"]["rows"][number];
type TestRow = Row["tests"][number];
type DayRow = RouterOutputs["workspace"]["officeTests"]["day"]["rows"][number];
type View = "list" | "today" | "check" | "report";
const VIEWS: { key: View; label: string; icon: React.ElementType }[] = [
  { key: "list", label: "Work list", icon: ListChecks },
  { key: "today", label: "Today", icon: CalendarDays },
  { key: "check", label: "Was it done?", icon: ClipboardCheck },
  { key: "report", label: "Monthly report", icon: BarChart3 },
];
const COMING: { days: number | null; label: string }[] = [
  { days: null, label: "Any time" }, { days: 7, label: "Coming in 7 days" }, { days: 14, label: "Coming in 14 days" }, { days: 30, label: "Coming in 30 days" },
];
const pillCls = "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ring-1";

interface MarkTarget { key: string; name: string; tests: OfficeTest[]; initial?: OfficeTestRecordStatus; date?: string }
interface DetailsTarget { key: string; name: string; t: TestRow }

/**
 * Testing: in-office tests (ABI-Q, PFT, RMR) for patients seen since the start date or booked, by the
 * practice's criteria. Staff book them (call task, or mark Scheduled / Done / Declined / Not needed),
 * see who's in today with a test due, confirm what was done, and see the month's numbers.
 */
export default function TestingPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const [params, setParams] = useUrlParams();
  const view = (VIEWS.map((v) => v.key) as string[]).includes(params.get("view") ?? "") ? (params.get("view") as View) : "list";
  const [mark, setMark] = useState<MarkTarget | null>(null);
  const [details, setDetails] = useState<DetailsTarget | null>(null);
  const checks = trpc.workspace.officeTests.checks.useQuery(undefined, { enabled: !!user && !!ws.caps?.flowView, staleTime: 60_000 });

  if (!user || ws.loading) return null;
  if (!ws.caps?.flowView) return <CCMDashboardLayout title="Testing"><EmptyState icon={FlaskConical} title="No access" /></CCMDashboardLayout>;
  const openCount = checks.data?.rows.length ?? 0;

  return (
    <CCMDashboardLayout title="Testing" pageTitle={false}>
      <PageHeader title="Testing" subtitle="In-office tests by the practice's criteria, for patients seen since the start date or with a visit booked. Their provider orders each test; each can be repeated once a year." />

      <div className="mb-4 flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800" role="tablist">
        {VIEWS.map((v) => (
          <button key={v.key} role="tab" aria-selected={view === v.key} onClick={() => setParams({ view: v.key === "list" ? null : v.key, page: null })}
            className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold", view === v.key ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-50" : "text-slate-500 hover:text-slate-800")}>
            <v.icon size={14} /> {v.label}
            {v.key === "check" && openCount > 0 && <span className="rounded-full bg-orange-100 px-1.5 text-[11px] font-bold tabular-nums text-orange-800 dark:bg-orange-950 dark:text-orange-200">{openCount}</span>}
          </button>
        ))}
      </div>

      {view === "list" && <WorkList isAdmin={user.role === "admin"} onMark={setMark} onDetails={setDetails} />}
      {view === "today" && <DayView onMark={setMark} />}
      {view === "check" && <ChecksView data={checks.data} loading={checks.isLoading} error={checks.error?.message} onMark={setMark} />}
      {view === "report" && <ReportView />}

      {mark && <MarkTestsDialog open onClose={() => setMark(null)} subjectKey={mark.key} name={mark.name} tests={mark.tests} initial={mark.initial} initialDate={mark.date} />}
      {details && details.t.recordId && (
        <TestDetailsDialog open onClose={() => setDetails(null)} id={details.t.recordId} test={details.t.test} date={details.t.lastDone ?? localDateStr()} subjectKey={details.key} name={details.name}
          initial={{ results: details.t.resultValues, performedByUserId: details.t.performedByUserId, hasReport: !!details.t.fileId }} />
      )}
    </CCMDashboardLayout>
  );
}

/** One test on a row: its pill, where it stands, why, and its results when done. */
function TestLine({ t, onDetails, dim }: { t: TestRow; onDetails?: () => void; dim?: boolean }) {
  return (
    <li className={cn("flex flex-wrap items-start gap-2 text-sm", dim && "opacity-50")}>
      <span className={cn(pillCls, TEST_PILL[t.test])}>{OFFICE_TEST_LABELS[t.test]}</span>
      {t.state !== "eligible" && (
        <span className={cn("shrink-0 text-xs font-semibold", STATE_TEXT[t.state])}>
          {OFFICE_TEST_STATE_LABELS[t.state]}{t.state === "scheduled" ? ` ${dayText(t.scheduledFor)}` : t.state === "missed" ? ` (booked ${dayText(t.scheduledFor)})` : t.state === "done" ? ` ${dayText(t.lastDone)}` : ""}
        </span>
      )}
      <span className="min-w-0 flex-1 text-xs text-slate-500">
        {t.state === "done" && (t.results || t.performedBy) ? <b className="font-semibold text-slate-700 dark:text-slate-200">{[t.results, t.performedBy ? `by ${t.performedBy}` : null].filter(Boolean).join(" · ")} · </b> : null}
        {t.state === "done" && t.source === "import" ? "From Practice Fusion · " : ""}
        {t.reasons.map((x) => x.why).join(" · ")}
      </span>
      {t.state === "done" && t.fileId && <ReportButton fileId={t.fileId} />}
      {t.state === "done" && onDetails && t.recordId && (
        <button className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800" onClick={onDetails}><Pencil size={12} /> {t.results || t.fileId ? "Edit results" : "Add results"}</button>
      )}
    </li>
  );
}

function WorkList({ isAdmin, onMark, onDetails }: { isAdmin: boolean; onMark: (m: MarkTarget) => void; onDetails: (d: DetailsTarget) => void }) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const [params, setParams] = useUrlParams();
  const test = (OFFICE_TESTS as readonly string[]).includes(params.get("test") ?? "") ? (params.get("test") as OfficeTest) : null;
  const state = (OFFICE_TEST_STATES as string[]).includes(params.get("state") ?? "") ? (params.get("state") as OfficeTestState) : "eligible";
  const coming = Number(params.get("coming")) || null;
  const clinicParam = params.get("clinic");
  const clinicId = clinicParam === "all" ? null : Number(clinicParam) || ws.clinicId;
  const providerId = Number(params.get("provider")) || null;
  const page = Math.max(1, Number(params.get("page")) || 1);
  const q = params.get("q") ?? "";
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (text.trim() === q) return;
    const t = setTimeout(() => setParams({ q: text.trim() || null, page: null }), 300);
    return () => clearTimeout(t);
  }, [text, q, setParams]);

  const list = trpc.workspace.officeTests.list.useQuery({ test, state, clinicId, providerId, comingWithinDays: coming, q: q || null, page }, { placeholderData: (prev) => prev });
  const d = list.data;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set()), [test, state, coming, clinicId, providerId, page, q]);
  const tasks = trpc.workspace.officeTests.createTasks.useMutation({
    onSuccess: (r) => { toast.success(`${r.made} call task${r.made === 1 ? "" : "s"} made for the front desk.`); void utils.workspace.officeTests.invalidate(); setPicked(new Set()); },
    onError: (e) => toast.error(e.message),
  });
  const undo = trpc.workspace.officeTests.undo.useMutation({ onSuccess: () => void utils.workspace.officeTests.invalidate(), onError: (e) => toast.error(e.message) });
  const shownTests = (r: Row) => r.tests.filter((t) => t.shown).map((t) => t.test);
  const pickedRows = useMemo(() => (d?.rows ?? []).filter((r) => picked.has(r.key)), [d, picked]);
  const canTask = (state === "eligible" || state === "missed") && !!ws.caps?.tasks;
  const countFor = (s: OfficeTestState) => (d ? (test ? d.counts[test][s] : d.patientCounts[s]) : null);
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  const allPicked = !!d?.rows.length && d.rows.every((r) => picked.has(r.key));
  const today = localDateStr();

  return (
    <>
      <SeenSince date={d?.since} isAdmin={isAdmin} className="mb-4" />

      <details className={cn(cardCls, "mb-4 px-4 py-3 text-sm")}>
        <summary className="cursor-pointer font-semibold text-slate-800 dark:text-slate-100">Who qualifies</summary>
        <ul className="mt-2 space-y-1 text-slate-600 dark:text-slate-300">
          {OFFICE_TESTS.map((t) => <li key={t}><b>{OFFICE_TEST_NAMES[t]}:</b> {TEST_QUALIFIERS[t].map((x) => QUALIFIER_LABELS[x]).join(", ")}</li>)}
        </ul>
        <p className="mt-2 text-xs text-slate-500">From the Practice Fusion chart: problem list, latest BMI (30+ counts as obesity) and smoking status, plus age. "Respiratory" is any respiratory diagnosis on the problem list. A test already in the Practice Fusion chart counts as done.</p>
      </details>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setParams({ test: null, page: null })} className={cn("rounded-full px-3 py-1.5 text-sm font-semibold ring-1", !test ? "bg-slate-900 text-white ring-slate-900 dark:bg-slate-100 dark:text-slate-900" : "text-slate-600 ring-slate-200 dark:text-slate-300 dark:ring-slate-700")}>All tests</button>
        {OFFICE_TESTS.map((t) => (
          <button key={t} onClick={() => setParams({ test: t, page: null })} title={OFFICE_TEST_NAMES[t]}
            className={cn("rounded-full px-3 py-1.5 text-sm font-semibold ring-1", test === t ? "bg-slate-900 text-white ring-slate-900 dark:bg-slate-100 dark:text-slate-900" : "text-slate-600 ring-slate-200 dark:text-slate-300 dark:ring-slate-700")}>
            {OFFICE_TEST_LABELS[t]} <span className="tabular-nums opacity-70">{d ? d.counts[t].eligible.toLocaleString() : ""}</span>
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800" role="tablist">
          {OFFICE_TEST_STATES.map((s) => (
            <button key={s} role="tab" aria-selected={state === s} onClick={() => setParams({ state: s === "eligible" ? null : s, page: null })}
              className={cn("rounded-lg px-3 py-1.5 text-sm font-semibold", state === s ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-50" : "text-slate-500 hover:text-slate-800", s === "missed" && state !== s && (countFor(s) ?? 0) > 0 && "text-orange-700 dark:text-orange-300")}>
              {OFFICE_TEST_STATE_LABELS[s]} <span className="text-xs font-normal tabular-nums text-slate-400">{countFor(s)?.toLocaleString() ?? ""}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <SelectBox ariaLabel="Coming in" value={coming ? String(coming) : ""} onChange={(v) => setParams({ coming: v || null, page: null })}>
            {COMING.map((c) => <option key={c.label} value={c.days ?? ""}>{c.label}</option>)}
          </SelectBox>
          {d && d.clinics.length > 1 && (
            <SelectBox className="max-w-[14rem]" ariaLabel="Clinic" value={clinicId ? String(clinicId) : ""} onChange={(v) => setParams({ clinic: v || (ws.clinicId ? "all" : null), page: null })}>
              <option value="">All clinics</option>
              {d.clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectBox>
          )}
          {d && d.providers.length > 1 && (
            <SelectBox className="max-w-[14rem]" ariaLabel="Provider" value={providerId ? String(providerId) : ""} onChange={(v) => setParams({ provider: v || null, page: null })}>
              <option value="">All providers</option>
              {d.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </SelectBox>
          )}
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Find a patient" aria-label="Find a patient" className={cn(inputCls, "w-48 pl-9")} />
          </div>
        </div>
      </div>

      {state === "missed" && (
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">Booked for a day that has passed, with nothing marked done. Each morning a rebook call task goes to the front desk for tests missed the day before; older ones can be sent from here.</p>
      )}

      {canTask && !!d?.rows.length && (
        <div className={cn(cardCls, "mb-3 flex flex-wrap items-center gap-3 px-4 py-2.5")}>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            <input type="checkbox" className="size-4 accent-brand" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(d.rows.map((r) => r.key)))} />
            Select all on this page
          </label>
          <span className="text-sm text-slate-500">{picked.size ? `${picked.size} selected` : "Pick patients to make call tasks for several at once"}</span>
          <Btn size="sm" className="ml-auto" disabled={!picked.size || tasks.isPending}
            onClick={() => tasks.mutate({ items: pickedRows.map((r) => ({ subjectKey: r.key, tests: shownTests(r) })) })}>
            {tasks.isPending ? <Loader2 size={14} className="animate-spin" /> : <ListPlus size={14} />} Make call tasks
          </Btn>
        </div>
      )}

      {list.isLoading && <Loading label="Checking who qualifies…" />}
      {list.error && <ErrorNote message={list.error.message} />}
      {d && d.total === 0 && (
        <div className={cardCls}><EmptyState icon={FlaskConical} title={state === "eligible" ? "No one to book here" : `No one marked "${OFFICE_TEST_STATE_LABELS[state]}"`} body={state === "eligible" ? "Try another test, clinic or time range." : undefined} /></div>
      )}

      <div className="space-y-2">
        {d?.rows.map((r) => {
          const soon = r.nextVisit && r.nextVisit.slice(0, 10) <= localDateStr(new Date(Date.now() + 14 * 86_400_000));
          const rebookMade = state === "missed" && r.tests.some((t) => t.shown && t.rebookTaskId);
          return (
            <section key={r.key} className={cn(cardCls, "flex flex-wrap items-start gap-3 px-4 py-3", picked.has(r.key) && "ring-2 ring-brand/40")}>
              {canTask && (
                <input type="checkbox" className="mt-1 size-4 accent-brand" checked={picked.has(r.key)} aria-label={`Select ${r.name}`}
                  onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })} />
              )}
              <div className="min-w-[14rem] flex-1">
                <Link href={patientHref(r.key, "testing")} className="font-semibold text-slate-900 hover:underline dark:text-slate-50">{r.name}</Link>
                <p className="mt-0.5 text-xs text-slate-500">
                  {r.dob ? `${fmtDob(r.dob)} (${r.age})` : "DOB not on file"}{r.clinicName ? ` · ${r.clinicName}` : ""}{r.providerName ? ` · ${r.providerName}` : ""}
                </p>
                <p className={cn("mt-0.5 flex items-center gap-1 text-xs", soon ? "font-semibold text-emerald-700 dark:text-emerald-300" : "text-slate-500")}>
                  <CalendarClock size={12} /> {r.nextVisit ? `Next visit ${fmtShortDate(r.nextVisit)} · ${fmtClock(r.nextVisit)}` : "No visit booked"}
                  {rebookMade ? <span className="ml-2 font-normal text-slate-500">· rebook task made</span>
                    : r.taskMadeAt && <span className="ml-2 font-normal text-slate-500">· call task made {fmtShortDate(r.taskMadeAt)}</span>}
                </p>
              </div>
              <ul className="min-w-[16rem] flex-[2] space-y-1">
                {r.tests.filter((t) => t.shown || state === "eligible").map((t) => (
                  <div key={t.test} className="flex items-start gap-2">
                    <div className="min-w-0 flex-1"><TestLine t={t} dim={!t.shown} onDetails={state === "done" && t.shown ? () => onDetails({ key: r.key, name: r.name, t }) : undefined} /></div>
                    {t.shown && t.recordId && state !== "eligible" && t.source !== "import" && (
                      <button className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs text-slate-500 hover:text-slate-800" onClick={() => undo.mutate({ id: t.recordId! })} aria-label="Undo"><Undo2 size={12} /> Undo</button>
                    )}
                  </div>
                ))}
                {state === "eligible" && r.tests.some((t) => t.lastDone) && (
                  <li className="text-[11px] text-slate-400">Last done: {r.tests.filter((t) => t.lastDone).map((t) => `${OFFICE_TEST_LABELS[t.test]} ${dayText(t.lastDone)}`).join(" · ")}</li>
                )}
              </ul>
              <div className="flex shrink-0 gap-2">
                {(state === "eligible" || state === "scheduled" || state === "missed") && (
                  <Btn size="sm" variant={state === "eligible" ? "primary" : "secondary"}
                    onClick={() => onMark({ key: r.key, name: r.name, tests: shownTests(r), initial: state === "eligible" ? (r.nextVisit && r.nextVisit.slice(0, 10) >= today ? "scheduled" : undefined) : "done", date: state === "missed" ? r.tests.find((t) => t.shown)?.scheduledFor ?? undefined : undefined })}>
                    {state === "eligible" ? "Mark…" : "Mark done…"}
                  </Btn>
                )}
                {canTask && (
                  <Btn size="sm" variant="secondary" disabled={tasks.isPending} onClick={() => tasks.mutate({ items: [{ subjectKey: r.key, tests: shownTests(r) }] })}><ListPlus size={14} /> {state === "missed" ? "Rebook task" : "Call task"}</Btn>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {d && d.total > d.pageSize && (
        <div className="mt-4 flex items-center justify-end gap-2 text-sm text-slate-500">
          <span className="mr-auto tabular-nums">{d.total.toLocaleString()} patients</span>
          <button disabled={page <= 1} onClick={() => setParams({ page: page - 1 > 1 ? page - 1 : null })} aria-label="Previous page" className="rounded-lg p-1.5 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-700"><ChevronLeft size={16} /></button>
          <span className="tabular-nums">Page {page} of {pages}</span>
          <button disabled={page >= pages} onClick={() => setParams({ page: page + 1 })} aria-label="Next page" className="rounded-lg p-1.5 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-700"><ChevronRight size={16} /></button>
        </div>
      )}
    </>
  );
}

/** A patient on the schedule that day with a test to do: when, who with, what's due, and Done / Not done. */
function VisitRow({ r, showDay, onMark, picked, onPick }: { r: DayRow; showDay?: boolean; onMark: (m: MarkTarget) => void; picked?: boolean; onPick?: () => void }) {
  const utils = trpc.useUtils();
  const today = localDateStr();
  const answer = trpc.workspace.officeTests.answerChecks.useMutation({
    onSuccess: () => { toast.success("Noted: not done at that visit. The test stays on the list to book."); void utils.workspace.officeTests.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const past = r.day <= today;
  // "Not done" once the visit has happened (an earlier day, or they've arrived today).
  const visited = r.day < today || SEEN_STATUSES.includes(r.visitStatus);
  return (
    <section className={cn(cardCls, "flex flex-wrap items-start gap-3 px-4 py-3", picked && "ring-2 ring-brand/40")}>
      {onPick && <input type="checkbox" className="mt-1 size-4 accent-brand" checked={!!picked} onChange={onPick} aria-label={`Select ${r.name}`} />}
      <div className="w-20 shrink-0 text-sm font-semibold tabular-nums text-slate-700 dark:text-slate-200">
        {showDay && <span className="block text-[11px] font-semibold text-slate-500">{dayText(r.day)}</span>}
        {fmtClock(r.startsAt)}
      </div>
      <div className="min-w-[12rem] flex-1">
        <Link href={patientHref(r.key, "testing")} className="font-semibold text-slate-900 hover:underline dark:text-slate-50">{r.name}</Link>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <FlowBadge status={r.visitStatus} /> {[r.providerName, r.clinicName].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="min-w-[14rem] flex-[2] space-y-1">
        <div className="flex flex-wrap gap-1.5">
          {r.due.map((t) => {
            const s = r.tests.find((x) => x.test === t);
            return <span key={t} className={cn(pillCls, TEST_PILL[t])}>{OFFICE_TEST_LABELS[t]} {s?.state === "scheduled" ? "booked" : s?.state === "missed" ? `missed (booked ${dayText(s.scheduledFor)})` : "due"}</span>;
          })}
          {r.doneThatDay.map((t) => <span key={`d-${t}`} className={cn(pillCls, "inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900")}><CheckCircle2 size={11} /> {OFFICE_TEST_LABELS[t]} done</span>)}
        </div>
        {r.due.length > 0 && <p className="text-xs text-slate-500">{r.tests.filter((t) => r.due.includes(t.test)).map((t) => `${OFFICE_TEST_LABELS[t.test]}: ${t.reasons.map((x) => x.why).join(", ")}`).join(" · ")}</p>}
        {r.notDone && r.due.length > 0 && <p className="text-xs font-medium text-slate-500">Marked not done at this visit.</p>}
      </div>
      {r.due.length > 0 && (
        <div className="flex shrink-0 gap-2">
          {past ? (
            <>
              <Btn size="sm" onClick={() => onMark({ key: r.key, name: r.name, tests: r.due, initial: "done", date: r.day })}><CheckCircle2 size={14} /> Done…</Btn>
              {!r.notDone && visited && (
                <Btn size="sm" variant="secondary" disabled={answer.isPending} onClick={() => answer.mutate({ items: [{ subjectKey: r.key, date: r.day }] })}><X size={14} /> Not done</Btn>
              )}
            </>
          ) : (
            <Btn size="sm" variant="secondary" onClick={() => onMark({ key: r.key, name: r.name, tests: r.due, initial: "scheduled", date: r.day })}>Book for this visit…</Btn>
          )}
        </div>
      )}
    </section>
  );
}

function DayView({ onMark }: { onMark: (m: MarkTarget) => void }) {
  const [params, setParams] = useUrlParams();
  const today = localDateStr();
  const date = params.get("date") || today;
  const day = trpc.workspace.officeTests.day.useQuery({ date }, { placeholderData: (prev) => prev });
  const d = day.data;
  const due = d?.rows.filter((r) => r.due.length) ?? [];
  const done = d?.rows.filter((r) => !r.due.length) ?? [];
  const setDate = (x: string) => setParams({ date: x === today ? null : x });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button onClick={() => setDate(addDays(date, -1))} aria-label="Previous day" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700"><ChevronLeft size={16} /></button>
        <input type="date" className={cn(inputCls, "w-auto")} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Day" />
        <button onClick={() => setDate(addDays(date, 1))} aria-label="Next day" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700"><ChevronRight size={16} /></button>
        {date !== today && <Btn size="sm" variant="ghost" onClick={() => setDate(today)}>Today</Btn>}
        <p className="ml-auto text-sm text-slate-500">{d ? `${due.length} with a test to do${done.length ? ` · ${done.length} done` : ""}` : ""}</p>
      </div>
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">Patients on the schedule this day who qualify for an ABI-Q, PFT or RMR. If their provider orders it, do it while they're here and mark it done. The same flags show on their Patient Flow cards.</p>
      {day.isLoading && <Loading label="Checking the schedule…" />}
      {day.error && <ErrorNote message={day.error.message} />}
      {d && !d.rows.length && <div className={cardCls}><EmptyState icon={CalendarDays} title="No tests due for anyone on the schedule this day" /></div>}
      <div className="space-y-2">
        {[...due, ...done].map((r) => <VisitRow key={`${r.key}-${r.day}`} r={r} onMark={onMark} />)}
      </div>
    </>
  );
}

function ChecksView({ data, loading, error, onMark }: { data: RouterOutputs["workspace"]["officeTests"]["checks"] | undefined; loading: boolean; error?: string; onMark: (m: MarkTarget) => void }) {
  const utils = trpc.useUtils();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const rowKey = (r: DayRow) => `${r.key}|${r.day}`;
  const answer = trpc.workspace.officeTests.answerChecks.useMutation({
    onSuccess: (x) => { toast.success(`${x.count} marked not done.`); setPicked(new Set()); void utils.workspace.officeTests.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const rows = data?.rows ?? [];
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(rowKey(r)));
  return (
    <>
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">Patients seen in the last {data?.days ?? 7} days who qualified for a test that isn't marked done. Was it done at that visit? <b>Done…</b> records it (with the numbers and report); <b>Not done</b> stops asking, and the test stays on the work list to book.</p>
      {loading && <Loading label="Checking last week's visits…" />}
      {error && <ErrorNote message={error} />}
      {data && !rows.length && <div className={cardCls}><EmptyState icon={ClipboardCheck} title="All caught up" body="Every visit in the last week with a test due has an answer." /></div>}
      {rows.length > 0 && (
        <div className={cn(cardCls, "mb-3 flex flex-wrap items-center gap-3 px-4 py-2.5")}>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            <input type="checkbox" className="size-4 accent-brand" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map(rowKey)))} />
            Select all
          </label>
          <span className="text-sm text-slate-500">{picked.size ? `${picked.size} selected` : `${rows.length} visit${rows.length === 1 ? "" : "s"} to answer`}</span>
          <Btn size="sm" variant="secondary" className="ml-auto" disabled={!picked.size || answer.isPending}
            onClick={() => answer.mutate({ items: rows.filter((r) => picked.has(rowKey(r))).slice(0, 100).map((r) => ({ subjectKey: r.key, date: r.day })) })}>
            {answer.isPending ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Not done
          </Btn>
        </div>
      )}
      <div className="space-y-2">
        {rows.map((r) => (
          <VisitRow key={rowKey(r)} r={r} showDay onMark={onMark} picked={picked.has(rowKey(r))}
            onPick={() => setPicked((s) => { const n = new Set(s); if (n.has(rowKey(r))) n.delete(rowKey(r)); else n.add(rowKey(r)); return n; })} />
        ))}
      </div>
    </>
  );
}

const REPORT_COLS = [
  { key: "booked", label: "Booked", hint: "Appointments for the test this month" },
  { key: "done", label: "Done", hint: "Tests done this month" },
  { key: "missed", label: "Missed", hint: "Booked days this month that passed with the test not done since" },
  { key: "declined", label: "Declined", hint: "Patients who said no this month" },
  { key: "dueNow", label: "Due now", hint: "Still to do today: eligible or missed (not month-based)" },
] as const;

function ReportView() {
  const [params, setParams] = useUrlParams();
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? params.get("month")! : localDateStr().slice(0, 7);
  const clinicId = Number(params.get("rclinic")) || null;
  const report = trpc.workspace.officeTests.report.useQuery({ month, clinicId }, { placeholderData: (prev) => prev });
  const r = report.data;
  const monthName = new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  type Tally = NonNullable<typeof r>["totals"];
  const Table = ({ title, rows }: { title: string; rows: { name: string; tally: Tally }[] }) => (
    <section className={cn(cardCls, "mb-4 overflow-x-auto")}>
      <h3 className="px-4 pt-3 text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h3>
      <table className="mt-2 w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-xs text-slate-500 dark:border-slate-700">
            <th className="px-4 py-2 font-semibold" rowSpan={2}>{title === "Totals" ? "Test" : "Name"}</th>
            {OFFICE_TESTS.map((t) => <th key={t} colSpan={REPORT_COLS.length} className="border-l border-slate-100 px-2 py-1 text-center font-semibold dark:border-slate-700"><span className={cn(pillCls, TEST_PILL[t])}>{OFFICE_TEST_LABELS[t]}</span></th>)}
          </tr>
          <tr className="border-b border-slate-100 text-xs text-slate-500 dark:border-slate-700">
            {OFFICE_TESTS.flatMap((t) => REPORT_COLS.map((c, i) => <th key={`${t}-${c.key}`} title={c.hint} className={cn("px-2 py-1 text-right font-medium", i === 0 && "border-l border-slate-100 dark:border-slate-700")}>{c.label}</th>))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className="border-b border-slate-50 last:border-0 dark:border-slate-800">
              <td className="px-4 py-2 font-medium text-slate-800 dark:text-slate-100">{row.name}</td>
              {OFFICE_TESTS.flatMap((t) => REPORT_COLS.map((c, i) => (
                <td key={`${t}-${c.key}`} className={cn("px-2 py-2 text-right tabular-nums", i === 0 && "border-l border-slate-100 dark:border-slate-700", c.key === "done" && "font-semibold text-slate-900 dark:text-slate-50", c.key === "missed" && row.tally[t].missed > 0 && "text-orange-700 dark:text-orange-300", !row.tally[t][c.key] && "text-slate-300 dark:text-slate-600")}>
                  {row.tally[t][c.key].toLocaleString()}
                </td>
              )))}
            </tr>
          ))}
          {!rows.length && <tr><td className="px-4 py-3 text-slate-500" colSpan={1 + OFFICE_TESTS.length * REPORT_COLS.length}>Nothing this month.</td></tr>}
        </tbody>
      </table>
    </section>
  );
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input type="month" className={cn(inputCls, "w-auto")} value={month} max={localDateStr().slice(0, 7)} onChange={(e) => e.target.value && setParams({ month: e.target.value })} aria-label="Month" />
        {r && r.clinics.length > 1 && (
          <SelectBox className="max-w-[14rem]" ariaLabel="Clinic" value={clinicId ? String(clinicId) : ""} onChange={(v) => setParams({ rclinic: v || null })}>
            <option value="">All clinics</option>
            {r.clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </SelectBox>
        )}
        <p className="ml-auto text-sm text-slate-500">{monthName}</p>
      </div>
      {report.isLoading && <Loading label="Adding up the month…" />}
      {report.error && <ErrorNote message={report.error.message} />}
      {r && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            {OFFICE_TESTS.map((t) => (
              <div key={t} className={cn(cardCls, "px-4 py-3")}>
                <span className={cn(pillCls, TEST_PILL[t])}>{OFFICE_TEST_NAMES[t]}</span>
                <p className="mt-2 text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{r.totals[t].done.toLocaleString()} <span className="text-sm font-medium text-slate-500">done</span></p>
                <p className="text-xs text-slate-500">{r.totals[t].booked} booked · <span className={r.totals[t].missed ? "font-semibold text-orange-700 dark:text-orange-300" : ""}>{r.totals[t].missed} missed</span> · {r.totals[t].declined} declined · {r.totals[t].dueNow.toLocaleString()} due now</p>
              </div>
            ))}
          </div>
          <p className="mb-4 text-xs text-slate-500">
            Done tests count on the provider and clinic of that day's visit (else the patient's own). Booked, missed and declined count on the patient's own provider and clinic.
            {` ${r.withResults} done test${r.withResults === 1 ? " has" : "s have"} results entered, ${r.withReport} ${r.withReport === 1 ? "has a report" : "have reports"} attached${r.fromChart ? `, ${r.fromChart} came from the Practice Fusion chart` : ""}.`}
          </p>
          <Table title="By clinic" rows={r.byClinic} />
          <Table title="By provider" rows={r.byProvider} />
          <section className={cn(cardCls, "mb-4 overflow-x-auto")}>
            <h3 className="px-4 pt-3 text-sm font-semibold text-slate-800 dark:text-slate-100">Done by</h3>
            <table className="mt-2 w-full text-sm">
              <thead><tr className="border-b border-slate-100 text-left text-xs text-slate-500 dark:border-slate-700"><th className="px-4 py-2 font-semibold">Who performed it</th>{OFFICE_TESTS.map((t) => <th key={t} className="px-3 py-2 text-right font-semibold">{OFFICE_TEST_LABELS[t]}</th>)}</tr></thead>
              <tbody>
                {r.byStaff.map((s) => (
                  <tr key={s.name} className="border-b border-slate-50 last:border-0 dark:border-slate-800">
                    <td className="px-4 py-2 font-medium text-slate-800 dark:text-slate-100">{s.name}</td>
                    {OFFICE_TESTS.map((t) => <td key={t} className={cn("px-3 py-2 text-right tabular-nums", !s.done[t] && "text-slate-300 dark:text-slate-600")}>{s.done[t]}</td>)}
                  </tr>
                ))}
                {!r.byStaff.length && <tr><td className="px-4 py-3 text-slate-500" colSpan={1 + OFFICE_TESTS.length}>No tests done this month.</td></tr>}
              </tbody>
            </table>
          </section>
        </>
      )}
    </>
  );
}
