import { useEffect, useState } from "react";
import { Link } from "wouter";
import { CalendarCheck, FlaskConical, Info, Search } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { patientHref } from "@shared/folder";
import { PhoneLink } from "@/components/phone/PhoneLink";
import { EmptyState, ErrorNote, Loading, Panel, fmtDob, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { LogCallDialog, OutreachCell, type RowOutreach } from "./Outreach";

const TEST_STATE_CLS: Record<string, string> = {
  eligible: "bg-violet-50 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200",
  scheduled: "bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200",
  missed: "bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200",
};
const TEST_STATE_WORD: Record<string, string> = { eligible: "due", scheduled: "scheduled", missed: "missed" };

/**
 * Opportunity Finder → Search: look up one patient (a call-back, someone at the desk) and see every list
 * they're on, their calls, visits and tests due, then log the call. The search text stays on this screen
 * (never in the page address).
 */
export function OpportunitySearch({ providerIds }: { providerIds: number[] | null }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const search = trpc.workspace.opportunities.search.useQuery({ q, providerIds }, { enabled: q.length >= 2, placeholderData: (prev) => prev });
  const [logFor, setLogFor] = useState<{ key: string; name: string; category: string } | null>(null);
  const rows = q.length >= 2 ? search.data?.rows ?? [] : [];

  return (
    <div className="space-y-4">
      <div className="relative max-w-xl">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          autoFocus
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Name, date of birth, phone or MRN"
          aria-label="Search for a patient"
          className={cn(inputCls, "h-11 pl-9 text-base")}
        />
      </div>

      {q.length < 2 && (
        <Panel>
          <EmptyState icon={Search} title="Find a patient" body="Type a name (any order), a date of birth, a phone number or an MRN. You'll see every list they're on, their calls and visits, and can log a call — handy when a patient calls back." />
        </Panel>
      )}
      {q.length >= 2 && search.isLoading && <Loading />}
      {search.error && <ErrorNote message={search.error.message} />}
      {q.length >= 2 && search.data && rows.length === 0 && (
        <Panel><EmptyState icon={Search} title="No one found" body="Check the spelling, or try the date of birth or phone number." /></Panel>
      )}
      {search.data && search.data.total > rows.length && rows.length > 0 && (
        <p className="text-xs text-slate-500">Showing the first {rows.length} of {search.data.total.toLocaleString()} matches. Add a last name or date of birth to narrow it.</p>
      )}

      {rows.length > 0 && (
        <ul className={cn("space-y-3", search.isFetching && "opacity-70")}>
          {rows.map((r) => (
            <li key={r.key} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={patientHref(r.key, "overview")} className="text-base font-semibold text-slate-900 hover:underline dark:text-slate-50">{r.name}</Link>
                  <p className="mt-0.5 text-xs text-slate-500">
                    DOB {fmtDob(r.dob)}
                    {r.clinicName && <> · {r.clinicName}</>}
                    {r.providerName && <> · {r.providerName}</>}
                    {r.phone && <> · <PhoneLink phone={r.phone} context={{ patientId: r.patientId, subjectKey: r.key, name: r.name, source: r.primaryCategory ?? undefined }} /></>}
                  </p>
                  <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                    {r.lastVisit ? <>Last seen <b className="font-semibold">{fmtShortDate(r.lastVisit)}</b></> : "No past visits"}
                    <span className="mx-1.5 text-slate-300 dark:text-slate-600">·</span>
                    {r.nextVisit
                      ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><CalendarCheck size={12} /> Booked <b className="font-semibold">{fmtShortDate(r.nextVisit)}</b></span>
                      : "Nothing booked"}
                  </p>
                </div>
                {r.outreach && (
                  <OutreachCell o={r.outreach as RowOutreach} onLog={() => setLogFor({ key: r.key, name: r.name, category: r.primaryCategory ?? "" })} />
                )}
              </div>

              {r.inScope ? (
                <div className="mt-3 space-y-2">
                  {r.lists.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {r.lists.map((l) => (
                        <span key={l.category} className="inline-flex max-w-full items-baseline gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1 text-xs dark:bg-slate-800">
                          <b className="font-semibold text-slate-800 dark:text-slate-100">{l.label}</b>
                          <span className="truncate text-slate-500 dark:text-slate-400">{l.reason}</span>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">Not on any opportunity list right now.</p>
                  )}
                  {r.tests.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <FlaskConical size={13} className="text-slate-400" />
                      {r.tests.map((t) => (
                        <span key={t.test} className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", TEST_STATE_CLS[t.state])}>{t.label} {TEST_STATE_WORD[t.state]}</span>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-3 flex items-start gap-1.5 text-xs text-slate-500">
                  <Info size={13} className="mt-0.5 shrink-0" /> Another clinic's or provider's patient, so they're not on your lists. Open their page for the details.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <LogCallDialog target={logFor} category={logFor?.category ?? ""} onClose={() => setLogFor(null)} />
    </div>
  );
}
