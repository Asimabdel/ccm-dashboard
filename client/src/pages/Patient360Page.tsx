import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { toast } from "sonner";
import {
  AlertCircle, ArrowLeft, BookOpen, Building2, CalendarCheck, CalendarDays, Check, ClipboardCheck, ClipboardList, ClipboardSignature, Clock, Database,
  FileText, FlaskConical, FolderOpen, Globe, HeartPulse, Info, LayoutGrid, ListPlus, Loader2, MessagesSquare, MoreHorizontal, Phone, Printer, Send,
  ShieldCheck, Stethoscope, Syringe, Wallet,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { NewTaskDialog } from "@/components/workspace/NewTaskDialog";
import { TaskDrawer } from "@/components/workspace/TaskDrawer";
import { Btn, EmptyState, ErrorNote, FlowBadge, Loading, Panel, PriorityBadge, TaskStatusBadge, ageFrom, cardCls, fmtClock, fmtDob, fmtDue, fmtShortDate } from "@/components/workspace/ui";
import PatientDetailPage from "./PatientDetailPage";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { localDateStr } from "@shared/workforce";
import { TASK_CATEGORY_LABELS, type TaskCategory } from "@shared/workspace";
import { cn } from "@/lib/utils";
import { PhoneLink } from "@/components/phone/PhoneLink";
import { DoximityButtons } from "@/components/phone/DoximityButtons";
import { rcDial } from "@/components/phone/ringcentralStore";
import { CALL_OUTCOMES, type CallOutcome } from "@shared/phone";
import { PatientTestingPanel } from "@/components/testing/PatientTestingPanel";
import { OfficeTestsPanel } from "@/components/testing/OfficeTests";
import { InsurancePanel } from "@/components/insurance/InsurancePanel";
import { PatientFormsPanel } from "@/components/intake/PatientFormsPanel";
import { SendFormsDialog, type SendPreset } from "@/components/intake/SendFormsDialog";
import { PatientChartPanel } from "@/components/chart/PatientChartPanel";
import { PatientPaymentsPanel } from "@/components/payments/PatientPaymentsPanel";
import { PatientMessagesPanel } from "@/components/messages/PatientMessagesPanel";
import { SendFaxDialog } from "@/components/fax/SendFaxDialog";
import { TextPatientButton } from "@/components/texts/TextPatientButton";
import { InjectionDialog } from "@/components/injections/InjectionDialog";
import { ExcuseNoteDialog } from "@/components/documents/ExcuseNoteDialog";
import { CarePlanPanel } from "@/components/careplan/CarePlanPanel";
import { EducationPanel } from "@/components/education/EducationPanel";
import { PatientFolder } from "@/components/folder/PatientFolder";
import { FOLDER_SECTION_LIST, isPatientKey, type FolderSection } from "@shared/folder";
import { fmtDay } from "@shared/workforce";
import { DIRECTORY_PROGRAM_LABELS, type DirectoryProgram } from "@shared/directory";
import { isFindAction } from "@shared/findAnything";
import type { ReadyFix, ReadyItem, ReadyState } from "@shared/readiness";
import { HighDeductibleChip } from "@/components/billing/HighDeductibleChip";
import { CollectChip } from "@/components/billing/CollectChip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Tab = "overview" | "folder" | "appointments" | "tasks" | "messages" | "care" | "careplan" | "education" | "testing" | "chart" | "insurance" | "forms" | "payments";

/** The six sections on top; each holds one or more of the pages a patient has (the old 13 tabs). */
type Section = "overview" | "visits" | "work" | "care" | "records" | "money";
const SECTION_OF: Record<Tab, Section> = {
  overview: "overview", appointments: "visits", tasks: "work", messages: "work", care: "care", careplan: "care", education: "care", testing: "care",
  chart: "records", folder: "records", forms: "records", insurance: "money", payments: "money",
};
const SECTIONS: { key: Section; label: string; icon: React.ElementType }[] = [
  { key: "overview", label: "Overview", icon: LayoutGrid },
  { key: "visits", label: "Visits", icon: CalendarDays },
  { key: "work", label: "Tasks & messages", icon: ClipboardList },
  { key: "care", label: "Care", icon: HeartPulse },
  { key: "records", label: "Chart & folder", icon: FolderOpen },
  { key: "money", label: "Insurance & payments", icon: ShieldCheck },
];

/**
 * Patient 360, for every patient: CCM-roster patients by their number (/patients/123), everyone
 * else (schedule-only, Practice Fusion-only) by their patient key. On top: who they are and the
 * things to do for them (call, text, forms, excuse note, task…), then "Ready for the next visit?"
 * and six sections. The CCM/BHI/APCM record is in Care for roster patients and the roles that manage it.
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

/** Start a call from the built-in RingCentral phone (or the computer's phone app when it isn't open). */
function dial(phone: string, ctx: { patientId?: number; subjectKey: string; name: string }) {
  if (!rcDial(phone, { ...ctx, patientId: ctx.patientId, source: "patient" })) {
    const digits = phone.replace(/\D/g, "").slice(-10);
    if (digits.length === 10) window.location.href = `tel:+1${digits}`;
    else toast.error("This phone number doesn't look complete.");
  }
}

function Patient360({ subjectKey, id }: { subjectKey: string; id: number | null }) {
  const { caps, user } = useWorkspace();
  const [params, setParams] = useUrlParams();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  // The CCM record (older screens) is for roster patients and stays with the roles that manage it; MAs see everything else.
  const ccmRecord = !!id && !!caps?.patientFull && user?.role !== "medical_assistant";
  // Full-record roles open on the CCM record (what every existing patient link
  // expects); Workspace links pass ?tab=overview explicitly.
  const defaultTab: Tab = ccmRecord ? "care" : "overview";
  const [taskOpen, setTaskOpen] = useState(false);
  const [faxOpen, setFaxOpen] = useState(false);
  const [injectionOpen, setInjectionOpen] = useState(false);
  const [excuseOpen, setExcuseOpen] = useState(false);
  const [formsFor, setFormsFor] = useState<string[] | null>(null);
  const q = trpc.workspace.patients.byKey.useQuery({ key: subjectKey }, { retry: false });
  // High deductible (from the payment files): collect at check-in. A yes only, no amounts.
  const deductible = trpc.workspace.highDeductible.patient.useQuery({ key: subjectKey }, { enabled: !!caps?.flowView && isPatientKey(subjectKey), retry: false, staleTime: 5 * 60_000 });
  // Copay / deductible from their past visits (the Insurance tab shows the visits behind it).
  const visitCost = trpc.workspace.visitCost.patient.useQuery({ key: subjectKey }, { enabled: !!caps?.eligibility && isPatientKey(subjectKey), retry: false, staleTime: 5 * 60_000 });
  const collect = visitCost.data?.note ?? null;
  const texting = trpc.workspace.texts.status.useQuery(undefined, { enabled: !!caps?.texts, staleTime: 60_000 });
  const openText = trpc.workspace.texts.openForPatient.useMutation({ onSuccess: (r) => navigate(`/messages?tab=texts&t=${r.id}`), onError: (e) => toast.error(e.message) });
  const today = localDateStr();

  // Every page this patient has, then grouped into the six sections.
  const pages: { key: Tab; label: string; icon: React.ElementType; count?: number }[] = [
    { key: "overview", label: "Overview", icon: LayoutGrid },
    { key: "appointments", label: "Visits", icon: CalendarDays, count: q.data?.appointments.length },
    { key: "tasks", label: "Tasks", icon: ClipboardList, count: q.data?.openTasks.length },
    ...(caps?.messages ? [{ key: "messages" as Tab, label: "Messages", icon: MessagesSquare }] : []),
    ...(ccmRecord ? [{ key: "care" as Tab, label: "Care Management", icon: HeartPulse }] : []),
    ...(id && caps?.carePlans ? [{ key: "careplan" as Tab, label: "Care plan", icon: ClipboardCheck }] : []),
    ...(caps?.patientFull ? [{ key: "testing" as Tab, label: "Testing", icon: FlaskConical }] : []),
    ...(caps?.education ? [{ key: "education" as Tab, label: "Education", icon: BookOpen }] : []),
    ...(caps?.chartBasic ? [{ key: "chart" as Tab, label: "Chart", icon: Database }] : []),
    ...(caps?.chartBasic || caps?.flowView ? [{ key: "folder" as Tab, label: "Folder", icon: FolderOpen }] : []),
    ...(caps?.intakeForms ? [{ key: "forms" as Tab, label: "Forms", icon: ClipboardSignature }] : []),
    ...(caps?.eligibility ? [{ key: "insurance" as Tab, label: "Insurance", icon: ShieldCheck }] : []),
    ...(caps?.payments ? [{ key: "payments" as Tab, label: "Payments", icon: Wallet }] : []),
  ];
  const asked = params.get("tab") as Tab | null;
  const tab: Tab = asked && pages.some((x) => x.key === asked) ? asked : defaultTab;
  const section = SECTION_OF[tab];
  const sections = SECTIONS.map((s) => ({ ...s, pages: pages.filter((x) => SECTION_OF[x.key] === s.key) })).filter((s) => s.pages.length);
  const go = (t: Tab) => setParams({ tab: t === defaultTab ? null : t, do: null });

  const d = q.data;
  const p = d?.patient;
  const age = ageFrom(p?.dateOfBirth);
  const lastNoShow = d?.appointments.find((a) => a.status === "no_show");
  const canText = !!caps?.texts && !!texting.data?.canUse && !!texting.data.enabled;
  const dialCtx = p ? { patientId: p.id ?? undefined, subjectKey, name: p.name } : null;

  // Sending forms: the patient is filled in (and, from the checklist, the forms that are missing are ticked).
  const formsPreset = useMemo<SendPreset | null>(
    () => (p && formsFor ? { subjectKey, name: p.name, phone: p.phoneNumber, clinicId: p.clinicId, forms: formsFor.length ? formsFor : null } : null),
    [p, formsFor, subjectKey],
  );
  const excuseSubject = useMemo(() => (p ? { key: subjectKey, name: p.name, dob: p.dateOfBirth } : null), [p, subjectKey]);

  // "Check now" from the checklist: Availity with the insurance on file, then wait for the answer.
  const [checking, setChecking] = useState(false);
  const quickCheck = trpc.workspace.patients.checkInsurance.useMutation();
  const refreshCheck = trpc.workspace.eligibility.refresh.useMutation();
  const checkInsurance = async () => {
    setChecking(true);
    try {
      let c = await quickCheck.mutateAsync({ key: subjectKey });
      for (let i = 0; i < 6 && c.status === "pending"; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        c = await refreshCheck.mutateAsync({ id: c.id });
      }
      const s = c.summary;
      if (c.status === "error") toast.error(`The check didn't go through: ${c.error ?? "try again on the Insurance tab"}`);
      else if (c.status === "pending") toast.message("Still waiting for the insurance company. The answer will show on the Insurance tab.");
      else toast.success(s?.active === false ? "Insurance is NOT active." : s?.active ? "Insurance is active." : "Checked. See the Insurance tab for details.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setChecking(false);
      void utils.workspace.patients.readiness.invalidate({ key: subjectKey });
      void utils.workspace.eligibility.history.invalidate();
    }
  };
  const fix = (f: ReadyFix, item: ReadyItem) => {
    if (f === "send_forms") setFormsFor(item.formKeys ?? []);
    else if (f === "insurance_check") void checkInsurance();
    else if (f === "insurance_tab") go("insurance");
    else if (f === "testing_tab") go("testing");
    else if (f === "careplan_tab") go("careplan");
    else if (f === "forms_tab") go("forms");
  };

  // Opened from Find anything with something to do ("?do=excuse"): do it once the patient has loaded.
  const doing = params.get("do");
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!p || !isFindAction(doing) || done.current === `${subjectKey}:${doing}`) return;
    done.current = `${subjectKey}:${doing}`;
    setParams({ do: null });
    if (doing === "excuse" && caps?.documents) setExcuseOpen(true);
    else if (doing === "forms" && caps?.intakeForms) setFormsFor([]);
    else if (doing === "task") setTaskOpen(true);
    else if (doing === "fax" && caps?.sendFax) setFaxOpen(true);
    else if (doing === "insurance" && caps?.eligibility) go("insurance");
    else if (doing === "call" && p.phoneNumber && dialCtx) dial(p.phoneNumber, dialCtx);
    else if (doing === "text" && canText) openText.mutate({ subjectKey });
    else if (doing === "text" && caps?.texts) toast.message("Texting isn't turned on yet.");
  }, [p, doing, subjectKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The name bar that stays on top once the header scrolls away.
  const heroEnd = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = heroEnd.current;
    const root = el?.closest("main") ?? null;
    if (!el || !root) return;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0) + 1), { root, threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [!!p]);

  const actions = p ? (
    <>
      {p.phoneNumber && dialCtx && <Btn onClick={() => dial(p.phoneNumber!, dialCtx)}><Phone size={15} /> Call</Btn>}
      {canText && <TextPatientButton subjectKey={subjectKey} />}
      {caps?.intakeForms && <Btn variant="secondary" onClick={() => setFormsFor([])}><Send size={15} /> Send forms</Btn>}
      {caps?.documents && <Btn variant="secondary" onClick={() => setExcuseOpen(true)}><FileText size={15} /> Excuse note</Btn>}
      <Btn variant="secondary" onClick={() => setTaskOpen(true)}><ListPlus size={15} /> New task</Btn>
      {caps?.eligibility && <Btn variant="secondary" onClick={() => go("insurance")}><ShieldCheck size={15} /> Insurance</Btn>}
      {(caps?.sendFax || caps?.injections || caps?.chartBasic) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Btn variant="secondary" aria-label="More"><MoreHorizontal size={15} /> More</Btn></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {caps?.sendFax && <DropdownMenuItem onClick={() => setFaxOpen(true)}><Printer size={14} className="mr-2" /> Send a fax</DropdownMenuItem>}
            {caps?.injections && <DropdownMenuItem onClick={() => setInjectionOpen(true)}><Syringe size={14} className="mr-2" /> Log an injection</DropdownMenuItem>}
            {(caps?.sendFax || caps?.injections) && caps?.chartBasic && <DropdownMenuSeparator />}
            {caps?.chartBasic && <DropdownMenuItem onClick={() => go("chart")}><Database size={14} className="mr-2" /> Open the chart</DropdownMenuItem>}
            {caps?.chartBasic && <DropdownMenuItem onClick={() => go("folder")}><FolderOpen size={14} className="mr-2" /> Open the folder</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  ) : null;

  return (
    <CCMDashboardLayout title={p?.name ?? "Patient"} pageTitle={false}>
      {/* The name bar: an empty sticky line at the top of the page, with the bar drawn over the page once the header is gone. */}
      {p && (
        <div className="sticky top-0 z-20 h-0" aria-hidden={!stuck}>
          <div className={cn(
            "absolute -left-4 -right-4 md:-left-6 md:-right-6 top-0 border-b border-slate-200 dark:border-slate-700 bg-white/90 backdrop-blur-md shadow-sm transition-all duration-200",
            stuck ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1 pointer-events-none",
          )} inert={!stuck}>
            <div className="mx-auto flex max-w-[1500px] items-center gap-3 px-4 md:px-6 py-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-xs font-bold text-brand dark:text-teal-300">{initialsOf(p.name)}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-slate-900 dark:text-slate-50">{p.name}</p>
                <p className="truncate text-xs text-slate-500">DOB {fmtDob(p.dateOfBirth)}{age != null ? ` (${age})` : ""}{p.clinicName ? ` · ${p.clinicName}` : ""}{p.providerName ? ` · ${p.providerName}` : ""}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {p.phoneNumber && dialCtx && <IconBtn label="Call" onClick={() => dial(p.phoneNumber!, dialCtx)}><Phone size={16} /></IconBtn>}
                {canText && <IconBtn label="Text" onClick={() => openText.mutate({ subjectKey })}><MessagesSquare size={16} /></IconBtn>}
                {caps?.intakeForms && <IconBtn label="Send forms" onClick={() => setFormsFor([])}><Send size={16} /></IconBtn>}
                {caps?.documents && <IconBtn label="Excuse note" className="hidden sm:inline-flex" onClick={() => setExcuseOpen(true)}><FileText size={16} /></IconBtn>}
                <IconBtn label="New task" className="hidden sm:inline-flex" onClick={() => setTaskOpen(true)}><ListPlus size={16} /></IconBtn>
              </div>
            </div>
          </div>
        </div>
      )}

      <Link href="/patients" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4">
        <ArrowLeft size={15} /> Patients
      </Link>

      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {/* If the Workspace summary can't load, the CCM record must still be reachable. */}
      {q.error && ccmRecord && id && <div className="mt-5"><PatientDetailPage embedded patientId={id} /></div>}

      {d && p && (
        <>
          {/* Who they are, and what to do for them */}
          <section className={cn(cardCls, "p-5 md:p-6")}>
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 md:h-14 md:w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-base md:text-lg font-bold text-brand dark:text-teal-300">
                {initialsOf(p.name)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <h2 className="text-xl md:text-[26px] font-bold tracking-tight text-slate-900 dark:text-slate-50">{p.name}</h2>
                  {(p.programs.length > 0 || !p.sources.roster || !!deductible.data || !!collect) && (
                    <div className="flex flex-wrap gap-1.5">
                      {p.programs.map((g) => <span key={g} className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand dark:text-teal-300">{DIRECTORY_PROGRAM_LABELS[g as DirectoryProgram]}</span>)}
                      {!p.sources.roster && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-slate-800">{p.sources.practiceFusion ? "From Practice Fusion" : "From the schedule"} · not in a care program</span>}
                      {collect && <CollectChip note={collect} className="px-2 text-[11px]" />}
                      {deductible.data && !collect && <HighDeductibleChip visits={deductible.data.visits} className="px-2 text-[11px]" />}
                    </div>
                  )}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
                  <span>DOB {fmtDob(p.dateOfBirth)}{age != null ? ` (${age})` : ""}</span>
                  {p.phoneNumber && <PhoneLink phone={p.phoneNumber} context={{ patientId: p.id ?? undefined, subjectKey, name: p.name, source: "patient" }}><Phone size={13} /> {p.phoneNumber}</PhoneLink>}
                  {p.phoneNumber && <DoximityButtons phone={p.phoneNumber} />}
                  {p.clinicName && <span className="inline-flex items-center gap-1"><Building2 size={13} className="text-slate-400" /> {p.clinicName}</span>}
                  {p.providerName && <span className="inline-flex items-center gap-1"><Stethoscope size={13} className="text-slate-400" /> {p.providerName}</span>}
                  {p.preferredLanguage && <span className="inline-flex items-center gap-1"><Globe size={13} className="text-slate-400" /> {p.preferredLanguage}</span>}
                  {p.mrn && <span className="text-slate-500">MRN {p.mrn}</span>}
                </div>
              </div>
            </div>
            <div className="mt-4 flex gap-2 overflow-x-auto border-t border-slate-100 pt-4 dark:border-slate-700 md:flex-wrap -mx-5 px-5 md:mx-0 md:px-0 [scrollbar-width:none] [&>*]:shrink-0 [&>*]:whitespace-nowrap">
              {actions}
            </div>
          </section>
          <div ref={heroEnd} aria-hidden="true" />

          {/* Six sections; a section with more than one page shows them as small tabs underneath */}
          <div className="mt-5 flex gap-1 border-b border-slate-200 dark:border-slate-700 overflow-x-auto [scrollbar-width:none]" role="tablist">
            {sections.map((s) => {
              const on = s.key === section;
              const n = s.key === "visits" ? d.appointments.length : s.key === "work" ? d.openTasks.length : 0;
              return (
                <button
                  key={s.key}
                  role="tab"
                  aria-selected={on}
                  onClick={() => go(s.pages.some((x) => x.key === defaultTab) ? defaultTab : s.pages[0].key)}
                  className={cn("flex shrink-0 items-center gap-2 px-3.5 py-2.5 text-sm font-semibold border-b-2 -mb-px whitespace-nowrap transition-colors", on ? "border-brand text-slate-900 dark:text-slate-50" : "border-transparent text-slate-500 hover:text-slate-800")}
                >
                  <s.icon size={15} className={on ? "text-brand dark:text-teal-300" : undefined} /> {s.label}
                  {n ? <span className="rounded-full bg-slate-100 px-1.5 text-[11px] font-bold tabular-nums text-slate-600 dark:bg-slate-700 dark:text-slate-200">{n}</span> : null}
                </button>
              );
            })}
          </div>
          {(sections.find((s) => s.key === section)?.pages.length ?? 0) > 1 && (
            <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Pages in this section">
              {sections.find((s) => s.key === section)!.pages.map((x) => (
                <button key={x.key} role="tab" aria-selected={tab === x.key} onClick={() => go(x.key)}
                  className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 transition-colors", tab === x.key ? "bg-brand text-white ring-brand" : "bg-white text-slate-600 ring-slate-200 hover:ring-slate-300 dark:ring-slate-600 dark:text-slate-300")}>
                  <x.icon size={13} /> {x.label}{x.count ? <span className="tabular-nums opacity-80">{x.count}</span> : null}
                </button>
              ))}
            </div>
          )}
          <div className="mt-5" />

          {tab === "overview" && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-start">
              <div className="min-w-0 space-y-5">
                <ReadinessCard subjectKey={subjectKey} next={d.nextAppointment} today={d.today} checking={checking} onFix={fix} />
                <Panel title="Upcoming and recent visits" subtitle={lastNoShow ? `Last no-show ${fmtShortDate(lastNoShow.startsAt)}` : undefined} action={<button className="text-xs font-semibold text-brand hover:underline" onClick={() => go("appointments")}>All visits</button>} bodyClassName="p-0">
                  <AppointmentList rows={d.appointments.slice(0, 6)} />
                </Panel>
                {caps?.patientFull && id && <CallLog patientId={id} />}
              </div>
              <div className="min-w-0 space-y-5">
                <NextVisitCard next={d.nextAppointment} today={d.today} />
                <Panel title="Open tasks" action={<Btn size="sm" variant="secondary" onClick={() => setTaskOpen(true)}><ListPlus size={14} /> New</Btn>} bodyClassName="p-0">
                  <TaskList rows={d.openTasks.slice(0, 6)} onOpen={(tid) => setParams({ task: tid })} onNew={() => setTaskOpen(true)} compact />
                  {d.openTasks.length > 6 && <button className="block w-full border-t border-slate-100 px-4 py-2.5 text-left text-xs font-semibold text-slate-600 hover:underline dark:border-slate-700 dark:text-slate-300" onClick={() => go("tasks")}>See all {d.openTasks.length}</button>}
                </Panel>
                {p.lastVisit && (
                  <p className="text-xs text-slate-500">Last visit on record: {fmtDay(p.lastVisit, { month: "short", day: "numeric", year: "numeric" })}.{caps?.chartBasic ? " Problems, medications and notes are in Chart & folder (copied from Practice Fusion)." : ""}</p>
                )}
              </div>
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
          {caps?.intakeForms && <SendFormsDialog open={!!formsFor} onClose={() => { setFormsFor(null); void utils.workspace.patients.readiness.invalidate({ key: subjectKey }); }} preset={formsPreset} />}
          {caps?.documents && <ExcuseNoteDialog open={excuseOpen} onClose={() => setExcuseOpen(false)} onCreated={(docId) => navigate(`/documents/${docId}`)} subject={excuseSubject} providerId={p.providerId ?? null} />}
          <NewTaskDialog open={taskOpen} onOpenChange={setTaskOpen} defaults={{ patientId: p.id ?? undefined, subjectKey: p.id ? undefined : subjectKey, patientName: p.name, clinicId: p.clinicId }} />
          <TaskDrawer taskId={Number(params.get("task")) || null} onClose={() => setParams({ task: null })} />
        </>
      )}
    </CCMDashboardLayout>
  );
}

const initialsOf = (name: string) => name.split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase();

function IconBtn({ label, onClick, children, className }: { label: string; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className={cn("inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 hover:text-brand dark:text-slate-300 dark:hover:bg-slate-700", className)}>
      {children}
    </button>
  );
}

type Summary = RouterOutputs["workspace"]["patients"]["byKey"];

const STATE_ICON: Record<ReadyState | "working", React.ElementType> = { done: Check, todo: AlertCircle, waiting: Clock, info: Info, working: Loader2 };
const STATE_CLS: Record<ReadyState | "working", string> = {
  done: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  todo: "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
  waiting: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  info: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  working: "bg-brand-soft text-brand dark:text-teal-300",
};
const BAR_CLS: Record<ReadyState, string> = { done: "bg-emerald-500", todo: "bg-slate-200 dark:bg-slate-600", waiting: "bg-sky-500", info: "bg-amber-400" };

/** "Ready for the next visit?": what's done and what's missing, each with its fix one click away. */
function ReadinessCard({ subjectKey, next, today, checking, onFix }: { subjectKey: string; next: Summary["nextAppointment"]; today: Summary["today"]; checking: boolean; onFix: (f: ReadyFix, item: ReadyItem) => void }) {
  const q = trpc.workspace.patients.readiness.useQuery({ key: subjectKey }, { staleTime: 30_000, retry: false });
  const items = q.data?.items ?? [];
  const todo = items.filter((x) => x.state === "todo").length;
  const visit = today ?? next;
  const when = visit
    ? `${today ? "Today" : fmtShortDate(visit.startsAt)} at ${fmtClock(visit.startsAt)}${visit.visitType ? ` · ${visit.visitType}` : ""}`
    : "No visit booked yet";
  return (
    <section className={cardCls}>
      <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-3.5 dark:border-slate-700">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand dark:text-teal-300"><CalendarCheck size={17} /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Ready for the next visit?</h3>
          <p className="truncate text-xs text-slate-500">{when}</p>
        </div>
        {q.data && (todo
          ? <span className="shrink-0 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-semibold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">{todo} to do</span>
          : items.length ? <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"><Check size={12} /> All set</span> : null)}
      </div>
      {q.isLoading ? <Loading label="Checking forms, insurance and tests…" /> : q.error ? (
        <p className="px-5 py-4 text-sm text-slate-500">Couldn't load the checklist: {q.error.message}</p>
      ) : items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-500">Nothing to check for this patient right now.</p>
      ) : (
        <>
          <div className="flex gap-1 px-5 pt-3.5" aria-hidden="true">
            {items.map((x) => <span key={x.id} className={cn("h-1.5 flex-1 rounded-full transition-colors", x.id === "insurance" && checking ? "bg-brand-bright" : BAR_CLS[x.state])} />)}
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {items.map((x) => {
              const working = x.id === "insurance" && checking;
              const st = working ? "working" : x.state;
              const Icon = STATE_ICON[st];
              return (
                <li key={x.id} className="flex items-center gap-3.5 px-5 py-3">
                  <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full", STATE_CLS[st])}><Icon size={14} className={working ? "animate-spin" : undefined} /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{x.title}</p>
                    <p className="text-xs text-slate-500">{working ? "Asking the insurance company…" : x.detail}</p>
                  </div>
                  {x.fix && x.fixLabel && !working && (
                    <Btn size="sm" variant="secondary" className="shrink-0" onClick={() => onFix(x.fix!, x)}>{x.fixLabel}</Btn>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function NextVisitCard({ next, today }: { next: Summary["nextAppointment"]; today: Summary["today"] }) {
  const v = today ?? next;
  if (!v) {
    return (
      <Panel title="Next visit">
        <p className="text-sm text-slate-500">Nothing booked. Visits show here once they're on the Practice Fusion schedule import.</p>
      </Panel>
    );
  }
  const dt = new Date(v.startsAt);
  const mon = dt.toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short" }).toUpperCase();
  const day = dt.toLocaleDateString("en-US", { timeZone: "America/Chicago", day: "numeric" });
  const dow = dt.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "short" });
  return (
    <Panel title={today ? "Today's visit" : "Next visit"} action={<FlowBadge status={v.status} />}>
      <div className="flex items-center gap-4">
        <div className="w-16 shrink-0 overflow-hidden rounded-xl border border-slate-200 text-center dark:border-slate-700">
          <div className="bg-brand py-0.5 text-[10px] font-bold tracking-[0.12em] text-white">{mon}</div>
          <div className="pt-1.5 text-2xl font-bold leading-none tracking-tight text-slate-900 dark:text-slate-50">{day}</div>
          <div className="pb-1.5 pt-0.5 text-[11px] font-semibold text-slate-500">{dow}</div>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{fmtClock(v.startsAt)}{v.visitType ? ` · ${v.visitType}` : ""}</p>
          <p className="text-xs text-slate-500">{[v.providerDisplay ?? v.providerName, v.clinicName].filter(Boolean).join(" · ")}</p>
          {v.reason && <p className="mt-1 text-xs text-slate-500 line-clamp-2">{v.reason}</p>}
        </div>
      </div>
    </Panel>
  );
}

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

function TaskList({ rows, onOpen, onNew, compact = false }: { rows: Summary["tasks"]; onOpen: (id: number) => void; onNew: () => void; compact?: boolean }) {
  const today = localDateStr();
  if (rows.length === 0) return compact ? <p className="px-5 py-4 text-sm text-slate-500">No open tasks.</p> : <EmptyState icon={ClipboardList} title="No tasks" action={<Btn size="sm" variant="secondary" onClick={onNew}><ListPlus size={14} /> Create task</Btn>} />;
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
                <span className="block text-xs text-slate-500 truncate">{compact ? t.assigneeName ?? "Team queue" : `${TASK_CATEGORY_LABELS[t.category as TaskCategory] ?? t.category} · ${t.assigneeName ?? "Team queue"}`}</span>
              </span>
              {t.priority !== "normal" && <PriorityBadge priority={t.priority} />}
              {closed ? <TaskStatusBadge status={t.status} /> : <span className={cn("text-xs whitespace-nowrap", due.overdue ? "text-rose-600 font-semibold" : due.today ? "text-amber-700 font-semibold dark:text-amber-300" : "text-slate-500")}>{due.text}</span>}
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
    <Panel title="Calls" subtitle="From RingCentral — calls made in MyPCP and on your other RingCentral phones" bodyClassName="p-0">
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
