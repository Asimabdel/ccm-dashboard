import { useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, ClipboardCopy, FileText, Info, Printer } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, Panel } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { addDays, fmtDay, localDateStr } from "@shared/workforce";

async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast.success(`${what} copied.`); } catch { toast.error("Couldn't copy. Select the text and copy it."); }
}

/** Print just the reports (a plain page with the text), not the whole app. */
function printReports(title: string, texts: string[]) {
  const w = window.open("", "_blank", "width=720,height=900");
  if (!w) { toast.error("Allow pop-ups to print."); return; }
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:14px/1.5 -apple-system,Segoe UI,Arial,sans-serif;margin:32px}pre{font:inherit;white-space:pre-wrap;margin:0 0 28px;padding-bottom:20px;border-bottom:1px solid #ddd;break-inside:avoid}</style></head><body>${texts.map((t) => `<pre>${esc(t)}</pre>`).join("")}</body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

/**
 * Providers' daily reports, in the practice's format: seen, in-office testing, new CCMs / RPMs,
 * injections. Pick a day; copy one provider's report, or all of them.
 */
export default function DailyReportsPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const [date, setDate] = useState(localDateStr());
  const q = trpc.workspace.dailyReports.get.useQuery({ date, clinicId: ws.clinicId }, { enabled: !!user && !!ws.caps?.dailyReports });
  const reports = q.data?.reports ?? [];
  const today = localDateStr();
  const dayLabel = fmtDay(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return (
    <CCMDashboardLayout title="Daily reports" clinicPicker pageTitle={false}>
      <PageHeader title="Daily reports" subtitle="Each provider's day: seen, in-office testing, new CCMs and RPMs, injections."
        actions={reports.length > 0 ? (
          <div className="flex gap-2">
            <Btn variant="secondary" onClick={() => printReports(`Daily reports ${date}`, reports.map((r) => r.text))}><Printer size={15} /> Print</Btn>
            <Btn onClick={() => void copy(reports.map((r) => r.text).join("\n\n"), "All reports")}><ClipboardCopy size={15} /> Copy all</Btn>
          </div>
        ) : undefined} />
      {ws.caps && !ws.caps.dailyReports && <ErrorNote message="Daily reports are for admins and office managers." />}

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Btn variant="secondary" size="sm" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day"><ChevronLeft size={15} /></Btn>
        <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-600 dark:bg-slate-800" aria-label="Day" />
        <Btn variant="secondary" size="sm" disabled={date >= today} onClick={() => setDate(addDays(date, 1))} aria-label="Next day"><ChevronRight size={15} /></Btn>
        {date !== today && <Btn variant="ghost" size="sm" onClick={() => setDate(today)}>Today</Btn>}
        <span className="ml-1 text-sm text-slate-500">{dayLabel}</span>
      </div>

      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {q.data && q.data.visitsOnSchedule > 0 && q.data.visitsWithStatus === 0 && (
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <Info size={15} className="mt-0.5 shrink-0" /> The schedule for this day has no visits marked seen yet. "Seen" counts once the day's schedule is imported again from Practice Fusion (with statuses), or visits are moved on Patient Flow.
        </p>
      )}
      {q.data && reports.length === 0 && <Panel><EmptyState icon={FileText} title="Nothing for this day" body="No visits marked seen, tests done or injections logged." /></Panel>}

      <div className="grid gap-4 lg:grid-cols-2">
        {reports.map((r) => (
          <Panel key={r.key} title={r.provider} subtitle={r.clinics.join(", ") || undefined}
            action={<Btn size="sm" variant="secondary" onClick={() => void copy(r.text, `${r.provider}'s report`)}><ClipboardCopy size={13} /> Copy</Btn>}>
            <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-sans text-sm leading-relaxed text-slate-800 dark:bg-slate-800/60 dark:text-slate-100">{r.text}</pre>
            {(r.newCcmNames.length > 0 || r.newRpmNames.length > 0) && (
              <details className="mt-2 text-xs text-slate-500">
                <summary className="cursor-pointer select-none">Who the new CCMs / RPMs are</summary>
                {r.newCcmNames.length > 0 && <p className="mt-1"><b>CCM:</b> {r.newCcmNames.join(", ")}</p>}
                {r.newRpmNames.length > 0 && <p className="mt-0.5"><b>RPM:</b> {r.newRpmNames.join(", ")}</p>}
              </details>
            )}
          </Panel>
        ))}
      </div>

      {reports.length > 0 && (
        <p className="mt-5 flex items-start gap-2 text-xs text-slate-500">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span><b>Seen</b> = visits marked arrived through seen/checked out (Practice Fusion schedule import or Patient Flow). <b>Testing</b> = ABI-Q / PFT / RMR marked done in the Testing tab. <b>New CCMs / RPMs</b> = new patients only (that day was their first visit with the practice, by the imported schedules and the Practice Fusion chart) who qualify by their diagnoses (Program approvals) or signed that consent that day; a new patient's diagnoses are picked up the next morning, after the overnight Practice Fusion update. <b>Injections</b> = logged with "Injection given" on the patient or on Patient Flow.</span>
        </p>
      )}
    </CCMDashboardLayout>
  );
}
