import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { CalendarClock, ChevronLeft, ChevronRight, FlaskConical, ListPlus, Loader2, Search, Undo2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, SelectBox, cardCls, fmtClock, fmtDob, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { MarkTestsDialog, STATE_TEXT, TEST_PILL, dayText } from "@/components/testing/OfficeTests";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { patientHref } from "@shared/folder";
import { localDateStr } from "@shared/workforce";
import {
  OFFICE_TESTS, OFFICE_TEST_LABELS, OFFICE_TEST_NAMES, OFFICE_TEST_STATE_LABELS, QUALIFIER_LABELS, TEST_QUALIFIERS,
  type OfficeTest, type OfficeTestState,
} from "@shared/officeTests";

type Row = RouterOutputs["workspace"]["officeTests"]["list"]["rows"][number];
const STATES: OfficeTestState[] = ["eligible", "scheduled", "done", "declined", "not_needed"];
const COMING: { days: number | null; label: string }[] = [
  { days: null, label: "Any time" }, { days: 7, label: "Coming in 7 days" }, { days: 14, label: "Coming in 14 days" }, { days: 30, label: "Coming in 30 days" },
];

/**
 * Testing: in-office tests (ABI-Q, PFT, RMR) for patients seen in the last 12 months or booked, by the
 * practice's criteria. Staff book them (call task, or mark Scheduled / Done / Declined / Not needed).
 */
export default function TestingPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const [params, setParams] = useUrlParams();
  const test = (OFFICE_TESTS as readonly string[]).includes(params.get("test") ?? "") ? (params.get("test") as OfficeTest) : null;
  const state = (STATES as string[]).includes(params.get("state") ?? "") ? (params.get("state") as OfficeTestState) : "eligible";
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

  const list = trpc.workspace.officeTests.list.useQuery({ test, state, clinicId, providerId, comingWithinDays: coming, q: q || null, page }, { enabled: !!user && !!ws.caps?.flowView, placeholderData: (prev) => prev });
  const d = list.data;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set()), [test, state, coming, clinicId, providerId, page, q]);
  const [mark, setMark] = useState<{ row: Row; tests: OfficeTest[] } | null>(null);
  const tasks = trpc.workspace.officeTests.createTasks.useMutation({
    onSuccess: (r) => { toast.success(`${r.made} call task${r.made === 1 ? "" : "s"} made for the front desk.`); void utils.workspace.officeTests.invalidate(); setPicked(new Set()); },
    onError: (e) => toast.error(e.message),
  });
  const undo = trpc.workspace.officeTests.undo.useMutation({ onSuccess: () => void utils.workspace.officeTests.invalidate(), onError: (e) => toast.error(e.message) });
  const shownTests = (r: Row) => r.tests.filter((t) => t.shown).map((t) => t.test);
  const pickedRows = useMemo(() => (d?.rows ?? []).filter((r) => picked.has(r.key)), [d, picked]);

  if (!user || ws.loading) return null;
  if (!ws.caps?.flowView) return <CCMDashboardLayout title="Testing"><EmptyState icon={FlaskConical} title="No access" /></CCMDashboardLayout>;
  const countFor = (s: OfficeTestState) => (d ? (test ? d.counts[test][s] : d.patientCounts[s]) : null);
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  const allPicked = !!d?.rows.length && d.rows.every((r) => picked.has(r.key));
  const today = localDateStr();

  return (
    <CCMDashboardLayout title="Testing" pageTitle={false}>
      <PageHeader title="Testing" subtitle="In-office tests for patients seen in the last 12 months or booked, by the practice's criteria. Their provider orders each test; each can be repeated once a year." />

      <details className={cn(cardCls, "mb-4 px-4 py-3 text-sm")}>
        <summary className="cursor-pointer font-semibold text-slate-800 dark:text-slate-100">Who qualifies</summary>
        <ul className="mt-2 space-y-1 text-slate-600 dark:text-slate-300">
          {OFFICE_TESTS.map((t) => <li key={t}><b>{OFFICE_TEST_NAMES[t]}:</b> {TEST_QUALIFIERS[t].map((x) => QUALIFIER_LABELS[x]).join(", ")}</li>)}
        </ul>
        <p className="mt-2 text-xs text-slate-500">From the Practice Fusion chart: problem list, latest BMI (30+ counts as obesity) and smoking status, plus age. "Respiratory" is any respiratory diagnosis on the problem list.</p>
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
        <div className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800" role="tablist">
          {STATES.map((s) => (
            <button key={s} role="tab" aria-selected={state === s} onClick={() => setParams({ state: s === "eligible" ? null : s, page: null })}
              className={cn("rounded-lg px-3 py-1.5 text-sm font-semibold", state === s ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-50" : "text-slate-500 hover:text-slate-800")}>
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

      {state === "eligible" && !!d?.rows.length && ws.caps?.tasks && (
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
          return (
            <section key={r.key} className={cn(cardCls, "flex flex-wrap items-start gap-3 px-4 py-3", picked.has(r.key) && "ring-2 ring-brand/40")}>
              {state === "eligible" && ws.caps?.tasks && (
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
                  {r.taskMadeAt && <span className="ml-2 font-normal text-slate-500">· call task made {fmtShortDate(r.taskMadeAt)}</span>}
                </p>
              </div>
              <ul className="min-w-[16rem] flex-[2] space-y-1">
                {r.tests.filter((t) => t.shown || state === "eligible").map((t) => (
                  <li key={t.test} className={cn("flex flex-wrap items-start gap-2 text-sm", !t.shown && "opacity-50")}>
                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ring-1", TEST_PILL[t.test])}>{OFFICE_TEST_LABELS[t.test]}</span>
                    {t.state !== "eligible" && (
                      <span className={cn("shrink-0 text-xs font-semibold", STATE_TEXT[t.state])}>
                        {OFFICE_TEST_STATE_LABELS[t.state]}{t.state === "scheduled" ? ` ${dayText(t.scheduledFor)}` : t.state === "done" ? ` ${dayText(t.lastDone)}` : ""}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 text-xs text-slate-500">{t.reasons.map((x) => x.why).join(" · ")}</span>
                    {t.shown && t.recordId && state !== "eligible" && (
                      <button className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800" onClick={() => undo.mutate({ id: t.recordId! })} aria-label="Undo"><Undo2 size={12} /> Undo</button>
                    )}
                  </li>
                ))}
                {state === "eligible" && r.tests.some((t) => t.lastDone) && (
                  <li className="text-[11px] text-slate-400">Last done: {r.tests.filter((t) => t.lastDone).map((t) => `${OFFICE_TEST_LABELS[t.test]} ${dayText(t.lastDone)}`).join(" · ")}</li>
                )}
              </ul>
              <div className="flex shrink-0 gap-2">
                {(state === "eligible" || state === "scheduled") && (
                  <Btn size="sm" variant={state === "eligible" ? "primary" : "secondary"} onClick={() => setMark({ row: r, tests: shownTests(r) })}>
                    {state === "eligible" ? "Mark…" : "Mark done…"}
                  </Btn>
                )}
                {state === "eligible" && ws.caps?.tasks && (
                  <Btn size="sm" variant="secondary" disabled={tasks.isPending} onClick={() => tasks.mutate({ items: [{ subjectKey: r.key, tests: shownTests(r) }] })}><ListPlus size={14} /> Call task</Btn>
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

      {mark && (
        <MarkTestsDialog open onClose={() => setMark(null)} subjectKey={mark.row.key} name={mark.row.name} tests={mark.tests}
          initial={state === "scheduled" ? "done" : mark.row.nextVisit && mark.row.nextVisit.slice(0, 10) >= today ? "scheduled" : undefined} />
      )}
    </CCMDashboardLayout>
  );
}
