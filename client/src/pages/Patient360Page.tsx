import { useState } from "react";
import { Link, useParams } from "wouter";
import { ArrowLeft, CalendarDays, ClipboardList, HeartPulse, LayoutGrid, ListPlus, Phone, Building2, Stethoscope, Globe, CalendarCheck, AlertCircle, UserX } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { NewTaskDialog } from "@/components/workspace/NewTaskDialog";
import { TaskDrawer } from "@/components/workspace/TaskDrawer";
import { Btn, EmptyState, ErrorNote, FlowBadge, Loading, Panel, PriorityBadge, TaskStatusBadge, ageFrom, fmtClock, fmtDob, fmtDue, fmtShortDate } from "@/components/workspace/ui";
import PatientDetailPage from "./PatientDetailPage";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { localDateStr } from "@shared/workforce";
import { TASK_CATEGORY_LABELS, type TaskCategory } from "@shared/workspace";
import { cn } from "@/lib/utils";
import { PhoneLink } from "@/components/phone/PhoneLink";
import { DoximityButtons } from "@/components/phone/DoximityButtons";
import { CALL_OUTCOMES, type CallOutcome } from "@shared/phone";
import { PatientTestingPanel } from "@/components/testing/PatientTestingPanel";
import { OfficeTestsPanel } from "@/components/testing/OfficeTests";
import { ClipboardSignature, Database, FlaskConical, ShieldCheck } from "lucide-react";
import { InsurancePanel } from "@/components/insurance/InsurancePanel";
import { PatientFormsPanel } from "@/components/intake/PatientFormsPanel";
import { PatientChartPanel } from "@/components/chart/PatientChartPanel";
import { PatientPaymentsPanel } from "@/components/payments/PatientPaymentsPanel";
import { BookOpen, ClipboardCheck, FolderOpen, MessagesSquare, Wallet } from "lucide-react";
import { PatientMessagesPanel } from "@/components/messages/PatientMessagesPanel";
import { SendFaxDialog } from "@/components/fax/SendFaxDialog";
import { InjectionDialog } from "@/components/injections/InjectionDialog";
import { Syringe } from "lucide-react";
import { Printer } from "lucide-react";
import { CarePlanPanel } from "@/components/careplan/CarePlanPanel";
import { EducationPanel } from "@/components/education/EducationPanel";
import { PatientFolder } from "@/components/folder/PatientFolder";
import { FOLDER_SECTION_LIST, isPatientKey, type FolderSection } from "@shared/folder";
import { fmtDay } from "@shared/workforce";
import { DIRECTORY_PROGRAM_LABELS, type DirectoryProgram } from "@shared/directory";

type Tab = "overview" | "folder" | "appointments" | "tasks" | "messages" | "care" | "careplan" | "education" | "testing" | "chart" | "insurance" | "forms" | "payments";

/**
 * Patient 360, for every patient: CCM-roster patients by their number (/patients/123), everyone
 * else (schedule-only, Practice Fusion-only) by their patient key. Operational view (visits, flow,
 * tasks, folder, chart) for everyone with patient access; the CCM/BHI/APCM record is an extra tab
 * for roster patients and the roles that manage it.
 */
export default function Patient360Page() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const params = useParams<{ id: string }>();
  const raw = decodeURIComponent(params.id ?? "");
  const key = /^\d+$/.test(raw) ? `p:${raw}` : raw;
  const id = /^p:\d+$/.test(key) ? Number(key.slice(2)) : null;
  const ws = useWorkspace();

  if (!user || ws.loading) return null;
  // Billing has no operational patient view; keep their existing CCM record page.
  if (!ws.caps?.flowView) return id ? <PatientDetailPage patientId={id} /> : <CCMDashboardLayout title="Patient"><EmptyState title="No access" body="Your role doesn't include this patient view." /></CCMDashboardLayout>;
  if (!isPatientKey(key)) return <CCMDashboardLayout title="Patient"><EmptyState title="Patient not found" /></CCMDashboardLayout>;
  return <Patient360 subjectKey={key} id={id} />;
}

function Patient360({ subjectKey, id }: { subjectKey: string; id: number | null }) {
  const { caps, user } = useWorkspace();
  const [params, setParams] = useUrlParams();
  // The CCM record (older screens) is for roster patients and stays with the roles that manage it; MAs see everything else.
  const ccmRecord = !!id && !!caps?.patientFull && user?.role !== "medical_assistant";
  // Full-record roles open on the CCM record (what every existing patient link
  // expects); Workspace links pass ?tab=overview explicitly.
  const defaultTab: Tab = ccmRecord ? "care" : "overview";
  const tab = (params.get("tab") as Tab) || defaultTab;
  const [taskOpen, setTaskOpen] = useState(false);
  const [faxOpen, setFaxOpen] = useState(false);
  const [injectionOpen, setInjectionOpen] = useState(false);
  const q = trpc.workspace.patients.byKey.useQuery({ key: subjectKey }, { retry: false });
  const today = localDateStr();

  const tabs: { key: Tab; label: string; icon: React.ElementType; count?: number }[] = [
    { key: "overview", label: "Overview", icon: LayoutGrid },
    // Everything about the patient in one place (each sub-folder follows its own access rule).
    ...(caps?.chartBasic || caps?.flowView ? [{ key: "folder" as Tab, label: "Folder", icon: FolderOpen }] : []),
    { key: "appointments", label: "Appointments", icon: CalendarDays, count: q.data?.appointments.length },
    { key: "tasks", label: "Tasks", icon: ClipboardList, count: q.data?.openTasks.length },
    ...(caps?.messages ? [{ key: "messages" as Tab, label: "Messages", icon: MessagesSquare }] : []),
  ];
  if (ccmRecord) tabs.unshift({ key: "care", label: "Care Management", icon: HeartPulse });
  if (id && caps?.carePlans) tabs.push({ key: "careplan", label: "Care plan", icon: ClipboardCheck });
  if (caps?.education) tabs.push({ key: "education", label: "Education", icon: BookOpen });
  if (caps?.patientFull) tabs.push({ key: "testing", label: "Testing", icon: FlaskConical });
  if (caps?.intakeForms) tabs.push({ key: "forms", label: "Forms", icon: ClipboardSignature });
  if (caps?.eligibility) tabs.push({ key: "insurance", label: "Insurance", icon: ShieldCheck });
  if (caps?.chartBasic) tabs.push({ key: "chart", label: "Chart", icon: Database });
  if (caps?.payments) tabs.push({ key: "payments", label: "Payments", icon: Wallet });

  const d = q.data;
  const p = d?.patient;
  const age = ageFrom(p?.dateOfBirth);
  const lastNoShow = d?.appointments.find((a) => a.status === "no_show");
  const overdueTasks = d?.openTasks.filter((t) => t.dueDate && t.dueDate < today) ?? [];

  return (
    <CCMDashboardLayout title="Patient 360" pageTitle={false}>
      <Link href="/patients" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4">
        <ArrowLeft size={15} /> Patients
      </Link>

      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {/* If the Workspace summary can't load, the CCM record must still be reachable. */}
      {q.error && ccmRecord && id && <div className="mt-5"><PatientDetailPage embedded patientId={id} /></div>}

      {d && p && (
        <>
          {/* Header */}
          <div className="bg-white rounded-xl border border-slate-200 dark:border-slate-700 shadow-[0_1px_2px_rgba(20,21,25,0.04)] p-5 mb-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-4 min-w-0">
                <div className="w-12 h-12 rounded-xl bg-brand-soft text-brand flex items-center justify-center font-bold shrink-0">
                  {p.name.split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase()}
                </div>
                <div className="min-w-0">
                  <h2 className="text-xl md:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">{p.name}</h2>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
                    <span>DOB {fmtDob(p.dateOfBirth)}{age != null ? ` (${age})` : ""}</span>
                    {p.phoneNumber && <PhoneLink phone={p.phoneNumber} context={{ patientId: p.id, subjectKey, name: p.name, source: "patient" }}><Phone size={13} /> {p.phoneNumber}</PhoneLink>}
                    {p.phoneNumber && <DoximityButtons phone={p.phoneNumber} />}
                    {p.clinicName && <span className="inline-flex items-center gap-1"><Building2 size={13} /> {p.clinicName}</span>}
                    {p.providerName && <span className="inline-flex items-center gap-1"><Stethoscope size={13} /> {p.providerName}</span>}
                    {p.preferredLanguage && <span className="inline-flex items-center gap-1"><Globe size={13} /> {p.preferredLanguage}</span>}
                    {p.mrn && <span>MRN {p.mrn}</span>}
                  </div>
                  {(p.programs.length > 0 || !p.sources.roster) && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {p.programs.map((g) => <span key={g} className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">{DIRECTORY_PROGRAM_LABELS[g as DirectoryProgram]}</span>)}
                      {!p.sources.roster && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-slate-800">{p.sources.practiceFusion ? "From Practice Fusion" : "From the schedule"} · not in a care program</span>}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Btn onClick={() => setTaskOpen(true)}><ListPlus size={15} /> Create task</Btn>
                {caps?.sendFax && <Btn variant="secondary" onClick={() => setFaxOpen(true)}><Printer size={15} /> Send fax</Btn>}
                {caps?.injections && <Btn variant="secondary" onClick={() => setInjectionOpen(true)}><Syringe size={15} /> Injection</Btn>}
              </div>
            </div>

            {/* What needs attention */}
            <div className="mt-5 grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <Attention icon={CalendarCheck} label="Today" value={d.today ? <span className="inline-flex items-center gap-2">{fmtClock(d.today.startsAt)} <FlowBadge status={d.today.status} /></span> : "Not on today's schedule"} />
              <Attention icon={CalendarDays} label="Next appointment" value={d.nextAppointment ? `${fmtShortDate(d.nextAppointment.startsAt)} · ${fmtClock(d.nextAppointment.startsAt)}` : "Nothing booked"} tone={d.nextAppointment ? undefined : "warn"} />
              <Attention icon={AlertCircle} label="Open tasks" value={d.openTasks.length ? `${d.openTasks.length} open${overdueTasks.length ? ` · ${overdueTasks.length} overdue` : ""}` : "None"} tone={overdueTasks.length ? "bad" : undefined} />
              <Attention icon={UserX} label="Last no-show" value={lastNoShow ? fmtShortDate(lastNoShow.startsAt) : "None on record"} tone={lastNoShow ? "warn" : undefined} />
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mb-5 border-b border-slate-200 dark:border-slate-700 overflow-x-auto" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setParams({ tab: t.key === defaultTab ? null : t.key })}
                className={cn("flex shrink-0 items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap", tab === t.key ? "border-brand text-slate-900 dark:text-slate-50" : "border-transparent text-slate-500 hover:text-slate-800")}
              >
                <t.icon size={15} /> {t.label}
                {t.count ? <span className="text-xs text-slate-400 tabular-nums">{t.count}</span> : null}
              </button>
            ))}
          </div>

          {tab === "overview" && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <Panel title="Upcoming and recent visits" action={<button className="text-xs font-semibold text-brand hover:underline" onClick={() => setParams({ tab: "appointments" })}>All visits</button>} bodyClassName="p-0">
                <AppointmentList rows={d.appointments.slice(0, 6)} />
              </Panel>
              <Panel title="Open tasks" action={<button className="text-xs font-semibold text-brand hover:underline" onClick={() => setParams({ tab: "tasks" })}>All tasks</button>} bodyClassName="p-0">
                <TaskList rows={d.openTasks.slice(0, 6)} onOpen={(tid) => setParams({ task: tid })} onNew={() => setTaskOpen(true)} />
              </Panel>
              {caps?.patientFull && id && <CallLog patientId={id} />}
              {p.lastVisit && (
                <p className="lg:col-span-2 text-xs text-slate-500">Last visit on record: {fmtDay(p.lastVisit, { month: "short", day: "numeric", year: "numeric" })}.{caps?.chartBasic ? " Problems, medications and notes are on the Chart tab (copied from Practice Fusion)." : ""}</p>
              )}
            </div>
          )}

          {tab === "appointments" && (
            <Panel bodyClassName="p-0"><AppointmentList rows={d.appointments} /></Panel>
          )}

          {tab === "tasks" && (
            <Panel title="Tasks for this patient" action={<Btn size="sm" onClick={() => setTaskOpen(true)}><ListPlus size={14} /> New</Btn>} bodyClassName="p-0">
              <TaskList rows={d.tasks} onOpen={(tid) => setParams({ task: tid })} onNew={() => setTaskOpen(true)} />
            </Panel>
          )}

          {tab === "messages" && caps?.messages && <PatientMessagesPanel subjectKey={subjectKey} name={p.name} />}
          {tab === "care" && ccmRecord && id && <PatientDetailPage embedded patientId={id} />}
          {tab === "careplan" && id && caps?.carePlans && <CarePlanPanel patientId={id} />}
          {tab === "education" && caps?.education && <EducationPanel subjectKey={subjectKey} />}
          {tab === "testing" && caps?.patientFull && <Panel><OfficeTestsPanel subjectKey={subjectKey} name={p.name} /><PatientTestingPanel subjectKey={subjectKey} /></Panel>}
          {tab === "chart" && caps?.chartBasic && <PatientChartPanel subjectKey={subjectKey} />}
          {tab === "insurance" && caps?.eligibility && <InsurancePanel subjectKey={subjectKey} />}
          {tab === "forms" && caps?.intakeForms && <PatientFormsPanel subjectKey={subjectKey} />}
          {tab === "folder" && (caps?.chartBasic || caps?.flowView) && (
            <PatientFolder subjectKey={subjectKey} initialSection={(FOLDER_SECTION_LIST as string[]).includes(params.get("s") ?? "") ? (params.get("s") as FolderSection) : null} />
          )}
          {tab === "payments" && caps?.payments && <PatientPaymentsPanel subjectKey={subjectKey} name={p.name} clinicId={p.clinicId ?? null} />}

          {caps?.injections && <InjectionDialog open={injectionOpen} onOpenChange={setInjectionOpen} subjectKey={subjectKey} patientName={p.name} />}
          {caps?.sendFax && <SendFaxDialog open={faxOpen} onOpenChange={setFaxOpen} preset={{ subjectKey, patientName: p.name, clinicId: p.clinicId }} />}
          <NewTaskDialog open={taskOpen} onOpenChange={setTaskOpen} defaults={{ patientId: p.id ?? undefined, subjectKey: p.id ? undefined : subjectKey, patientName: p.name, clinicId: p.clinicId }} />
          <TaskDrawer taskId={Number(params.get("task")) || null} onClose={() => setParams({ task: null })} />
        </>
      )}
    </CCMDashboardLayout>
  );
}

function Attention({ icon: Icon, label, value, tone }: { icon: React.ElementType; label: string; value: React.ReactNode; tone?: "warn" | "bad" }) {
  return (
    <div className={cn("rounded-xl px-3 py-2.5", tone === "bad" ? "bg-rose-50 dark:bg-rose-950/40" : tone === "warn" ? "bg-amber-50 dark:bg-amber-950/40" : "bg-slate-50 dark:bg-slate-800")}>
      <p className="text-[11px] font-medium text-slate-500 flex items-center gap-1.5"><Icon size={12} /> {label}</p>
      <div className={cn("mt-0.5 text-sm font-semibold", tone === "bad" ? "text-rose-700 dark:text-rose-300" : tone === "warn" ? "text-amber-800 dark:text-amber-300" : "text-slate-800 dark:text-slate-100")}>{value}</div>
    </div>
  );
}

type Summary = RouterOutputs["workspace"]["patients"]["byKey"];

function AppointmentList({ rows }: { rows: Summary["appointments"] }) {
  if (rows.length === 0) return <EmptyState icon={CalendarDays} title="No visits imported yet" body="Visits appear here once the Practice Fusion schedule that includes this patient is imported." />;
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-700">
      {rows.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
          <span className="w-32 text-slate-700 dark:text-slate-200 tabular-nums">{fmtShortDate(a.startsAt)}</span>
          <span className="w-16 text-slate-500 tabular-nums">{fmtClock(a.startsAt)}</span>
          <span className="flex-1 min-w-[120px] text-slate-600 dark:text-slate-300 truncate">{a.visitType ?? "Visit"}{a.provider ? ` · ${a.provider}` : ""}</span>
          <span className="text-xs text-slate-500 hidden sm:inline">{a.clinicName}</span>
          <FlowBadge status={a.status} />
        </li>
      ))}
    </ul>
  );
}

function TaskList({ rows, onOpen, onNew }: { rows: Summary["tasks"]; onOpen: (id: number) => void; onNew: () => void }) {
  const today = localDateStr();
  if (rows.length === 0) return <EmptyState icon={ClipboardList} title="No tasks" action={<Btn size="sm" variant="secondary" onClick={onNew}><ListPlus size={14} /> Create task</Btn>} />;
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-700">
      {rows.map((t) => {
        const due = fmtDue(t.dueDate, today);
        const closed = t.status === "completed" || t.status === "cancelled";
        return (
          <li key={t.id}>
            <button className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50/80 dark:hover:bg-slate-800/60" onClick={() => onOpen(t.id)}>
              <span className="flex-1 min-w-0">
                <span className={cn("block text-sm font-medium truncate", closed && "line-through text-slate-400")}>{t.title}</span>
                <span className="block text-xs text-slate-500">{TASK_CATEGORY_LABELS[t.category as TaskCategory] ?? t.category} · {t.assigneeName ?? "Team queue"}</span>
              </span>
              {t.priority !== "normal" && <PriorityBadge priority={t.priority} />}
              {closed ? <TaskStatusBadge status={t.status} /> : <span className={cn("text-xs whitespace-nowrap", due.overdue ? "text-rose-600 font-semibold" : "text-slate-500")}>{due.text}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Calls made or taken through the RingCentral phone in MyPCP. Hidden until there are any. */
function CallLog({ patientId }: { patientId: number }) {
  const calls = trpc.workspace.phone.forPatient.useQuery(patientId);
  if (!calls.data?.length) return null;
  const dur = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);
  return (
    <Panel title="Calls" subtitle="From RingCentral — calls made in MyPCP and on your other RingCentral phones" className="lg:col-span-2" bodyClassName="p-0">
      <ul className="divide-y divide-slate-100 dark:divide-slate-700">
        {calls.data.slice(0, 10).map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 px-4 py-2.5 text-sm">
            <span className="w-32 text-slate-700 dark:text-slate-200">{fmtShortDate(c.startedAt)}</span>
            <span className="text-slate-500">{c.direction === "outbound" ? "Called by" : "Called in to"} {c.userName ?? c.rcExtensionName ?? "staff"}{c.source === "ringcentral" ? " (RingCentral)" : ""} · {dur(c.durationSec)}</span>
            <span className="font-medium text-slate-800 dark:text-slate-100">{c.outcome ? CALL_OUTCOMES[c.outcome as CallOutcome] ?? c.outcome : c.result ?? ""}</span>
            {c.note && <span className="basis-full text-xs text-slate-500 pl-36">{c.note}</span>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
