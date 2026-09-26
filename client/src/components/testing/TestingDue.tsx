import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { CheckSquare, EyeOff, FlaskConical, Info, ListPlus, Loader2, Square, Upload } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, Panel, SectionLabel, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PhoneLink } from "@/components/phone/PhoneLink";
import { trpc } from "@/lib/trpc";
import { TESTS, TEST_GROUP_LABELS, TEST_KEYS, TEST_STATE_LABELS, type TestGroup, type TestKey, type TestState } from "@shared/testing";
import { cn } from "@/lib/utils";
import { PatientTestingPanel, STATE_CLS } from "./PatientTestingPanel";

const MAX_SELECT = 500;
const STATE_FILTERS: { key: TestState; hint: string }[] = [
  { key: "due", hint: "Past due, based on the last test on file" },
  { key: "due_soon", hint: "Due in the next 30 days" },
  { key: "no_record", hint: "Applies, but nothing on file yet" },
  { key: "needs_info", hint: "Sex-specific screenings where sex isn't on file" },
];

/** Opportunity Finder tab: who's due for which tests, with scheduling tasks. */
export function TestingDue({ clinicId }: { clinicId: number | null }) {
  const { user } = useAuth();
  const { caps } = useWorkspace();
  const [states, setStates] = useState<TestState[]>(["due", "due_soon"]);
  const [test, setTest] = useState<TestKey | null>(null);
  const [upcoming, setUpcoming] = useState(false);
  const [includeActioned, setIncludeActioned] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<{ key: string; name: string } | null>(null);
  const q = trpc.workspace.testing.overview.useQuery({ clinicId, test, states, upcomingDays: upcoming ? 14 : null, includeActioned });
  const utils = trpc.useUtils();
  const canAct = !!caps?.opportunitiesAct;
  const isAdmin = user?.role === "admin";

  const act = trpc.workspace.testing.act.useMutation({
    onSuccess: (r, v) => {
      toast.success(v.action === "task_created" ? `Created ${r.tasks} scheduling task${r.tasks === 1 ? "" : "s"}.` : `Marked ${r.count} as ${v.action === "dismissed" ? "dismissed" : "reviewed"}.`);
      setSelected(new Set());
      void utils.workspace.testing.invalidate();
      void utils.workspace.tasks.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const d = q.data;
  const rows = d?.rows ?? [];
  const selectable = rows.slice(0, MAX_SELECT);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.key));
  const toggle = (k: string) => setSelected((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.size < MAX_SELECT && n.add(k); return n; });
  const groups = useMemo(() => (Object.keys(TEST_GROUP_LABELS) as TestGroup[]).map((g) => ({ g, keys: TEST_KEYS.filter((k) => TESTS[k].group === g) })), []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-slate-600 dark:text-slate-300 max-w-3xl">
          Tests and screenings due under published guidelines (ADA, USPSTF, Medicare), for active patients. It's a reminder list for the care team: <b>the provider decides what to order</b>. Record tests on the patient (or import them from Practice Fusion) and they drop off until they're due again.
        </p>
        {isAdmin && <ImportButtons />}
      </div>

      {d && !d.hasImportedResults && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <Info size={16} className="mt-0.5 shrink-0" />
          <span>No test history has been imported yet, so almost everyone shows <b>No record</b>. Import a lab/order report from Practice Fusion{isAdmin ? " (button above)" : " (ask an admin)"} to see who's actually due.</span>
        </div>
      )}
      {d && d.unknownSex > 0 && (
        <p className="text-xs text-slate-500">{d.unknownSex.toLocaleString()} of {d.people.toLocaleString()} active patients have no sex on file, so mammograms, cervical screening and bone density can't be checked for them yet{isAdmin ? " — import the Practice Fusion patient list" : ""}.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {STATE_FILTERS.map((s) => {
          const on = states.includes(s.key);
          return (
            <button key={s.key} title={s.hint} onClick={() => { setSelected(new Set()); setStates((cur) => on ? (cur.length > 1 ? cur.filter((x) => x !== s.key) : cur) : [...cur, s.key]); }}
              className={cn("px-3 py-1.5 rounded-full border text-xs font-semibold transition", on ? cn(STATE_CLS[s.key], "border-transparent") : "border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700")}>
              {TEST_STATE_LABELS[s.key]}
            </button>
          );
        })}
        <select aria-label="Test" className={cn(inputCls, "w-auto")} value={test ?? ""} onChange={(e) => { setSelected(new Set()); setTest((e.target.value || null) as TestKey | null); }}>
          <option value="">All tests</option>
          {groups.map(({ g, keys }) => <optgroup key={g} label={TEST_GROUP_LABELS[g]}>{keys.map((k) => <option key={k} value={k}>{TESTS[k].label}</option>)}</optgroup>)}
        </select>
        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={upcoming} onChange={(e) => setUpcoming(e.target.checked)} /> Coming in within 14 days (do it at the visit)</label>
        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={includeActioned} onChange={(e) => setIncludeActioned(e.target.checked)} /> Show already handled (30 days)</label>
      </div>

      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}

      {d && groups.map(({ g, keys }) => (
        <section key={g}>
          <SectionLabel>{TEST_GROUP_LABELS[g]}</SectionLabel>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
            {keys.map((k) => {
              const c = d.counts[k];
              const active = test === k;
              return (
                <button key={k} onClick={() => { setSelected(new Set()); setTest(active ? null : k); }}
                  className={cn("text-left rounded-xl border bg-white dark:bg-slate-900 px-3 py-2.5 transition-colors", active ? "border-brand ring-1 ring-brand/40" : "border-slate-200 dark:border-slate-700 hover:border-slate-300")}>
                  <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 leading-tight">{TESTS[k].label}</p>
                  <p className="mt-1 text-[11px] text-slate-500 tabular-nums">
                    <span className="text-rose-700 dark:text-rose-300 font-semibold">{c.due}</span> due · {c.no_record} no record{c.needs_info ? ` · ${c.needs_info} need sex` : ""}
                  </p>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {d && (
        <Panel title={<span className="flex items-center gap-2">{test ? TESTS[test].label : "Patients"} <span className="text-xs font-normal text-slate-500">{d.total.toLocaleString()} match</span></span>} bodyClassName="p-0">
          {canAct && selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-slate-50 dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700 text-sm">
              <span className="font-semibold">{selected.size} selected</span>
              <Btn size="sm" disabled={act.isPending} onClick={() => act.mutate({ keys: Array.from(selected), action: "task_created" })}><ListPlus size={14} /> Create scheduling tasks</Btn>
              <Btn size="sm" variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ keys: Array.from(selected), action: "reviewed" })}><CheckSquare size={14} /> Mark reviewed</Btn>
              <Btn size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ keys: Array.from(selected), action: "dismissed" })}><EyeOff size={14} /> Dismiss</Btn>
              <span className="text-xs text-slate-500">Tasks go to each patient's care coordinator, or the front desk at their clinic.</span>
            </div>
          )}
          {rows.length === 0 && <EmptyState icon={FlaskConical} title="Nobody here" body="No active patients match these filters." />}
          {d.total > rows.length && <p className="px-4 py-2 text-xs text-slate-500 border-b border-slate-100 dark:border-slate-700">Showing the first {rows.length.toLocaleString()} of {d.total.toLocaleString()}. Pick a test or clinic to narrow it.</p>}
          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-500 bg-slate-50/70 dark:bg-slate-800">
                  <tr>
                    {canAct && (
                      <th className="w-10 px-4 py-2">
                        <button aria-label={allSelected ? "Clear selection" : "Select all"} onClick={() => setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.key)))}>
                          {allSelected ? <CheckSquare size={16} className="text-brand" /> : <Square size={16} className="text-slate-400" />}
                        </button>
                      </th>
                    )}
                    <th className="text-left font-medium px-3 py-2">Patient</th>
                    <th className="text-left font-medium px-3 py-2">Tests</th>
                    <th className="text-left font-medium px-3 py-2 hidden md:table-cell">Next visit</th>
                    <th className="text-left font-medium px-3 py-2 hidden lg:table-cell">Last seen</th>
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
                        {caps?.patientFull
                          ? <button onClick={() => setOpen({ key: r.key, name: r.name })} className="font-medium text-slate-900 dark:text-slate-50 hover:underline text-left">{r.name}</button>
                          : <span className="font-medium text-slate-900 dark:text-slate-50">{r.name}</span>}
                        <span className="block text-xs text-slate-500">{r.age ?? "?"}{r.sex ? ` ${r.sex}` : ""}{r.clinicName ? ` · ${r.clinicName}` : ""}{r.patientId ? "" : " · not on CCM roster"}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {r.tests.map((t) => (
                            <span key={t.key} title={t.dueOn ? `Due ${t.dueOn}` : TEST_STATE_LABELS[t.state]} className={cn("px-1.5 py-0.5 rounded-md text-[11px] font-medium", STATE_CLS[t.state])}>{t.label.split(" (")[0]}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-slate-600 dark:text-slate-300 hidden md:table-cell whitespace-nowrap">{r.nextVisit ? fmtShortDate(r.nextVisit) : <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-2.5 text-slate-500 hidden lg:table-cell whitespace-nowrap">{fmtShortDate(r.lastSeen)}</td>
                      <td className="px-3 py-2.5 text-slate-500 hidden lg:table-cell whitespace-nowrap">{r.phone ? <PhoneLink phone={r.phone} context={{ patientId: r.patientId, subjectKey: r.key, name: r.name, source: "testing_due" }} /> : "—"}</td>
                      <td className="px-3 py-2.5 text-xs text-slate-500 whitespace-nowrap">{r.lastAction ? `${r.lastAction.replace("_", " ")} ${fmtShortDate(r.lastActionAt)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(null)}>
          <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
            <DialogHeader><DialogTitle>{open.name} — testing</DialogTitle></DialogHeader>
            {open.key.startsWith("p:") && <Link href={`/patients/${open.key.slice(2)}?tab=testing`} className="text-xs font-semibold text-brand hover:underline">Open patient record</Link>}
            <PatientTestingPanel subjectKey={open.key} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function ImportButtons() {
  const results = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const [report, setReport] = useState<{ title: string; lines: string[] } | null>(null);
  const importResults = trpc.workspace.testing.importResults.useMutation({
    onSuccess: (r) => {
      void utils.workspace.testing.invalidate();
      setReport({
        title: `Imported ${r.saved.toLocaleString()} test results`,
        lines: [
          `${r.rows.toLocaleString()} rows in the file; ${r.duplicates} were already on file.`,
          `${r.patientNotFound} rows didn't match an active patient by name and date of birth.`,
          `${r.testNotRecognized} rows had a test MyPCP doesn't track or didn't recognize${r.badDate ? `; ${r.badDate} had no usable date` : ""}.`,
          ...(r.unrecognized.length ? ["Most common unrecognized test names (tell us if any should count):", ...r.unrecognized.map((u) => `  • ${u.name} (${u.n})`)] : []),
        ],
      });
    },
    onError: (e) => toast.error(e.message),
  });
  const importList = trpc.workspace.testing.importPatients.useMutation({
    onSuccess: (r) => {
      void utils.workspace.testing.invalidate();
      void utils.workspace.email.invalidate();
      setReport({ title: `Patient list imported`, lines: [`${r.matched.toLocaleString()} of ${r.rows.toLocaleString()} patients matched by name and date of birth.`, `Sex saved for ${r.sexSaved.toLocaleString()}; email addresses saved for ${r.emailsSaved.toLocaleString()} (used to match patient emails).`] });
    },
    onError: (e) => toast.error(e.message),
  });
  const pick = (ref: React.RefObject<HTMLInputElement | null>) => ref.current?.click();
  const read = (fn: (csv: string) => void) => async (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) fn(await f.text()); };
  return (
    <div className="flex flex-wrap gap-2">
      <input ref={results} type="file" accept=".csv,text/csv" className="hidden" onChange={read((csv) => importResults.mutate({ csv }))} />
      <input ref={list} type="file" accept=".csv,text/csv" className="hidden" onChange={read((csv) => importList.mutate({ csv }))} />
      <Btn size="sm" variant="secondary" disabled={importResults.isPending} onClick={() => pick(results)} title="A Practice Fusion lab / order / procedure report: patient name, DOB, test name, date (result optional)">
        {importResults.isPending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Import test results (CSV)
      </Btn>
      <Btn size="sm" variant="secondary" disabled={importList.isPending} onClick={() => pick(list)} title="A Practice Fusion patient list: patient name, DOB, sex (and email)">
        {importList.isPending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Import patient list (sex, email)
      </Btn>
      {report && (
        <Dialog open onOpenChange={(o) => !o && setReport(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle>{report.title}</DialogTitle></DialogHeader>
            <div className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-line">{report.lines.join("\n")}</div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
