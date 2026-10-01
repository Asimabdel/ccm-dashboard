import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { ChevronLeft, ChevronRight, HeartPulse, Loader2, Search, Users, X } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { EmptyState, ErrorNote, Loading, PageHeader, SelectBox, ageFrom, cardCls, fmtClock, fmtDob, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { PhoneLink } from "@/components/phone/PhoneLink";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDay } from "@shared/workforce";
import { patientHref } from "@shared/folder";
import {
  DIRECTORY_PROGRAMS, DIRECTORY_PROGRAM_LABELS, DIRECTORY_SORTS, DIRECTORY_STATUSES, DIRECTORY_STATUS_HINTS, DIRECTORY_STATUS_LABELS,
  type DirectoryProgram, type DirectorySort, type DirectoryStatus,
} from "@shared/directory";

type Row = RouterOutputs["workspace"]["directory"]["list"]["rows"][number];

const SORT_LABELS: Record<DirectorySort, string> = { name: "Name (A–Z)", lastVisit: "Last visit (newest)", nextVisit: "Next appointment (soonest)" };
const PROGRAM_PILL: Record<DirectoryProgram, string> = {
  ccm: "bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:ring-orange-900",
  bhi: "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-900",
  apcm: "bg-teal-50 text-teal-700 ring-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:ring-teal-900",
  rpm: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-900",
};
const visitDay = (d: string | null) => (d ? fmtDay(d, { month: "short", day: "numeric", year: "numeric" }) : "—");

/**
 * Patients: everyone at our clinics (Practice Fusion, the schedule and the CCM list), for looking
 * people up. Clicking a patient opens their Patient 360. The CCM list lives under Care Management.
 */
export default function DirectoryPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const [, setLocation] = useLocation();
  const [params, setParams] = useUrlParams();
  const q = params.get("q") ?? "";
  const status = (DIRECTORY_STATUSES as readonly string[]).includes(params.get("status") ?? "") ? (params.get("status") as DirectoryStatus) : "active";
  const clinicParam = params.get("clinic");
  // Starts on the clinic picked in the header; "all" overrides it.
  const clinic = clinicParam === "all" ? null : clinicParam === "none" ? "none" : clinicParam ? Number(clinicParam) || null : ws.clinicId;
  const allClinics = ws.clinicId ? "all" : null;
  const providerId = Number(params.get("provider")) || null;
  const program = (DIRECTORY_PROGRAMS as readonly string[]).includes(params.get("program") ?? "") ? (params.get("program") as DirectoryProgram) : null;
  const sort = (DIRECTORY_SORTS as readonly string[]).includes(params.get("sort") ?? "") ? (params.get("sort") as DirectorySort) : "name";
  const page = Math.max(1, Number(params.get("page")) || 1);

  // The search box updates the URL a moment after typing stops.
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (text.trim() === q) return;
    const t = setTimeout(() => setParams({ q: text.trim() || null, page: null }), 300);
    return () => clearTimeout(t);
  }, [text, q, setParams]);

  const list = trpc.workspace.directory.list.useQuery(
    { q: q || null, status, clinicId: clinic, providerId, program, sort, page },
    { enabled: !!user && !!ws.caps?.flowView, placeholderData: (prev) => prev },
  );
  const d = list.data;

  if (!user || ws.loading) return null;
  if (!ws.caps?.flowView) {
    return <CCMDashboardLayout title="Patients"><EmptyState icon={Users} title="No access" body="Your role doesn't include the patient list." /></CCMDashboardLayout>;
  }
  const open = (r: Row) => setLocation(patientHref(r.key, "overview"));
  const from = d && d.total ? (d.page - 1) * d.pageSize + 1 : 0;
  const to = d ? Math.min(d.total, d.page * d.pageSize) : 0;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  const filtered = clinic != null || !!providerId || !!program;

  return (
    <CCMDashboardLayout title="Patients" pageTitle={false}>
      <PageHeader
        title="Patients"
        subtitle={ws.limitedToClinics ? "Everyone at your clinic, from Practice Fusion and the schedule." : "Everyone at our clinics, from Practice Fusion, the schedule and the CCM list."}
        actions={ws.caps?.patientFull && user.role !== "medical_assistant" && user.role !== "office_manager"
          ? <Link href="/ccm-roster" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200"><HeartPulse size={15} /> CCM roster</Link>
          : undefined}
      />

      {/* Search */}
      <div className="relative mb-4">
        <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search by name, date of birth (MM/DD/YYYY), phone or MRN"
          aria-label="Search patients"
          className={cn(inputCls, "py-3 pl-10 pr-10 text-base")}
          autoFocus
        />
        {text && (
          <button onClick={() => { setText(""); setParams({ q: null, page: null }); }} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-700">
            <X size={16} />
          </button>
        )}
      </div>

      {/* Who + filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Which patients">
          {DIRECTORY_STATUSES.map((s) => {
            const on = (d?.searching ? "all" : status) === s;
            return (
              <button
                key={s}
                role="tab"
                aria-selected={on}
                title={DIRECTORY_STATUS_HINTS[s]}
                disabled={d?.searching}
                onClick={() => setParams({ status: s === "active" ? null : s, page: null })}
                className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold transition-colors disabled:cursor-default",
                  on ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700", d?.searching && !on && "opacity-50")}
              >
                {DIRECTORY_STATUS_LABELS[s]}
                <span className={cn("tabular-nums text-xs", on ? "opacity-80" : "text-slate-400")}>{d ? d.counts[s].toLocaleString() : "…"}</span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {!ws.limitedToClinics || (d?.clinics.length ?? 0) > 1 ? (
            <SelectBox className="max-w-[15rem]" ariaLabel="Clinic" value={clinic == null ? "" : String(clinic)} onChange={(v) => setParams({ clinic: v || allClinics, page: null })}>
              <option value="">All clinics</option>
              {d?.clinics.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count.toLocaleString()})</option>)}
              {!ws.limitedToClinics && !!d?.noClinic && <option value="none">No clinic on file ({d.noClinic.toLocaleString()})</option>}
            </SelectBox>
          ) : null}
          <SelectBox className="max-w-[15rem]" ariaLabel="Provider" value={providerId ? String(providerId) : ""} onChange={(v) => setParams({ provider: v || null, page: null })}>
            <option value="">All providers</option>
            {d?.providers.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.count.toLocaleString()})</option>)}
          </SelectBox>
          <SelectBox ariaLabel="Care program" value={program ?? ""} onChange={(v) => setParams({ program: v || null, page: null })}>
            <option value="">Any program</option>
            {DIRECTORY_PROGRAMS.map((p) => <option key={p} value={p}>{DIRECTORY_PROGRAM_LABELS[p]} patients</option>)}
          </SelectBox>
          <SelectBox ariaLabel="Sort" value={sort} onChange={(v) => setParams({ sort: v === "name" ? null : v, page: null })}>
            {DIRECTORY_SORTS.map((s) => <option key={s} value={s}>{SORT_LABELS[s]}</option>)}
          </SelectBox>
          {filtered && (
            <button onClick={() => setParams({ clinic: allClinics, provider: null, program: null, page: null })} className="text-sm font-semibold text-slate-500 hover:text-slate-800">Clear filters</button>
          )}
        </div>
      </div>
      {d?.searching && <p className="mb-3 text-xs text-slate-500">Searching everyone, active or not.</p>}

      {list.isLoading && <Loading label="Gathering every patient…" />}
      {list.error && <ErrorNote message={list.error.message} />}
      {d && d.total === 0 && (
        <div className={cardCls}>
          <EmptyState icon={Users} title={d.searching ? "No one matches that search" : "No patients here"} body={d.searching ? "Try fewer letters of the name, or search by date of birth or phone." : "Try another filter."} />
        </div>
      )}

      {d && d.total > 0 && (
        <div className={cn(cardCls, "overflow-hidden", list.isFetching && "opacity-70 transition-opacity")}>
          {/* Wide screens: a table */}
          <table className="hidden w-full text-sm lg:table">
            <thead className="border-b border-slate-100 bg-slate-50/70 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:border-slate-700 dark:bg-slate-800/60">
              <tr>
                <th className="px-4 py-2.5">Patient</th>
                <th className="px-3 py-2.5">Date of birth</th>
                <th className="px-3 py-2.5">Phone</th>
                <th className="px-3 py-2.5">Clinic &amp; provider</th>
                <th className="px-3 py-2.5">Last visit</th>
                <th className="px-4 py-2.5">Next appointment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
              {d.rows.map((r) => (
                <tr key={r.key} onClick={() => open(r)} className="cursor-pointer hover:bg-slate-50/80 dark:hover:bg-slate-800/60">
                  <td className="px-4 py-2.5">
                    <Link href={patientHref(r.key, "overview")} onClick={(e) => e.stopPropagation()} className="font-semibold text-slate-900 hover:underline dark:text-slate-50">{r.name}</Link>
                    <Badges r={r} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-600 dark:text-slate-300">{r.dob ? `${fmtDob(r.dob)} (${ageFrom(r.dob)})` : "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-600 dark:text-slate-300">
                    {r.phone ? <PhoneLink phone={r.phone} context={{ patientId: r.patientId, subjectKey: r.key, name: r.name, source: "patient" }} /> : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="block text-slate-700 dark:text-slate-200">{r.clinicName ?? <span className="text-slate-400">No clinic on file</span>}</span>
                    {r.providerName && <span className="block text-xs text-slate-500">{r.providerName}</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-600 dark:text-slate-300">{visitDay(r.lastVisit)}</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {r.nextVisit ? <><span className="block whitespace-nowrap font-medium text-slate-800 dark:text-slate-100">{fmtShortDate(r.nextVisit)}</span><span className="block text-xs text-slate-500">{fmtClock(r.nextVisit)}</span></> : <span className="whitespace-nowrap text-slate-400">Nothing booked</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Phones: cards */}
          <ul className="divide-y divide-slate-100 lg:hidden dark:divide-slate-700">
            {d.rows.map((r) => (
              <li key={r.key}>
                <button onClick={() => open(r)} className="w-full px-4 py-3 text-left hover:bg-slate-50/80 dark:hover:bg-slate-800/60">
                  <span className="block font-semibold text-slate-900 dark:text-slate-50">{r.name}</span>
                  <span className="block text-xs text-slate-500">
                    {r.dob ? `DOB ${fmtDob(r.dob)} (${ageFrom(r.dob)})` : "DOB not on file"}{r.clinicName ? ` · ${r.clinicName}` : ""}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    Last visit {visitDay(r.lastVisit)} · {r.nextVisit ? `Next ${fmtShortDate(r.nextVisit)}` : "Nothing booked"}
                  </span>
                  <Badges r={r} />
                </button>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-2.5 text-sm text-slate-500 dark:border-slate-700">
            <span className="tabular-nums">
              {from.toLocaleString()}–{to.toLocaleString()} of {d.total.toLocaleString()}
              {list.isFetching && <Loader2 size={13} className="ml-2 inline animate-spin" />}
            </span>
            <span className="flex items-center gap-1">
              <button disabled={d.page <= 1} onClick={() => setParams({ page: d.page - 1 > 1 ? d.page - 1 : null })} aria-label="Previous page" className="rounded-lg p-1.5 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-700"><ChevronLeft size={16} /></button>
              <span className="tabular-nums">Page {d.page} of {pages.toLocaleString()}</span>
              <button disabled={d.page >= pages} onClick={() => setParams({ page: d.page + 1 })} aria-label="Next page" className="rounded-lg p-1.5 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-700"><ChevronRight size={16} /></button>
            </span>
          </div>
        </div>
      )}
    </CCMDashboardLayout>
  );
}

function Badges({ r }: { r: Row }) {
  if (!r.programs.length && !r.isNew && r.active) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {r.isNew && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900">New patient</span>}
      {!r.active && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">Inactive</span>}
      {r.programs.map((p) => <span key={p} className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1", PROGRAM_PILL[p as DirectoryProgram])}>{DIRECTORY_PROGRAM_LABELS[p as DirectoryProgram]}</span>)}
    </span>
  );
}
