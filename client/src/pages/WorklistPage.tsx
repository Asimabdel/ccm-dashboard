import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Loader2, Phone, PhoneOff, X, CheckCircle2, ListChecks, ChevronUp, ChevronDown, ChevronsUpDown, Minus, Search } from "lucide-react";
import {
  WORKLIST_STATUS_OPTIONS, WORKLIST_STATUS_LABELS, worklistStatusValue,
  statusBadgeClass, currentMonthStr, fmtDate,
  PROGRAM_LABELS, programBadgeClass, type Program,
} from "@/lib/ccm";
import { PhoneLink } from "@/components/phone/PhoneLink";

export default function WorklistPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [, setLocation] = useLocation();
  const [month] = useState(currentMonthStr());
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [clinicFilter, setClinicFilter] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [bulkStatus, setBulkStatus] = useState("");
  // Which care-management program's worklist to show. CCM (99490) and BHI (99484)
  // are tracked independently; "all" merges both (each row shows its program).
  const [program, setProgram] = useState<Program | "all">("ccm");
  // Staff default to viewing only their own assigned tasks; admins see all.
  const [mineOnly, setMineOnly] = useState(() => user?.role === "staff");

  const clinics = trpc.clinics.list.useQuery(undefined, { enabled: !!user });
  // Status is filtered client-side by bucket (worklistStatusValue) so the five
  // worklist statuses also match the older granular statuses they collapse.
  const filters = useMemo(() => ({
    month,
    clinicId: clinicFilter || undefined,
    assignedStaffId: mineOnly && user ? user.id : undefined,
  }), [month, clinicFilter, mineOnly, user]);
  // CCM, BHI and APCM are separate task sets; fetch each and merge for "all".
  const ccmQ = trpc.worklist.forMonth.useQuery({ ...filters, program: "ccm" }, { enabled: !!user && (program === "ccm" || program === "all") });
  const bhiQ = trpc.worklist.forMonth.useQuery({ ...filters, program: "bhi" }, { enabled: !!user && (program === "bhi" || program === "all") });
  const apcmQ = trpc.worklist.forMonth.useQuery({ ...filters, program: "apcm" }, { enabled: !!user && (program === "apcm" || program === "all") });
  const worklistData = useMemo(() => {
    if (program === "ccm") return ccmQ.data || [];
    if (program === "bhi") return bhiQ.data || [];
    if (program === "apcm") return apcmQ.data || [];
    return [...(ccmQ.data || []), ...(bhiQ.data || []), ...(apcmQ.data || [])];
  }, [program, ccmQ.data, bhiQ.data, apcmQ.data]);
  const worklistLoading = program === "ccm" ? ccmQ.isLoading : program === "bhi" ? bhiQ.isLoading : program === "apcm" ? apcmQ.isLoading : (ccmQ.isLoading || bhiQ.isLoading || apcmQ.isLoading);
  const utils = trpc.useUtils();

  // Optional sort by "Last Called": none -> oldest first (asc) -> newest first (desc).
  // Never-called patients count as oldest, so ascending surfaces the most overdue first.
  const [lastCalledSort, setLastCalledSort] = useState<"none" | "asc" | "desc">("none");
  const sortedRows = useMemo(() => {
    const data = worklistData;
    if (lastCalledSort === "none") return data;
    const t = (d: unknown) => (d ? new Date(d as string).getTime() : 0);
    return [...data].sort((a, b) => {
      const av = t(a.patient.lastCalledAt), bv = t(b.patient.lastCalledAt);
      return lastCalledSort === "asc" ? av - bv : bv - av;
    });
  }, [worklistData, lastCalledSort]);

  const isStaff = user && ["admin", "staff"].includes(user.role);

  const updateStatus = trpc.worklist.updateStatus.useMutation({
    onSuccess: () => { utils.worklist.forMonth.invalidate(); toast.success("Status updated."); },
    onError: (e) => toast.error(e.message),
  });
  const logNoAnswer = trpc.worklist.logNoAnswer.useMutation({
    onSuccess: () => { utils.worklist.forMonth.invalidate(); toast.success("No-answer attempt logged."); },
    onError: (e) => toast.error(e.message),
  });
  const unlogNoAnswer = trpc.worklist.unlogNoAnswer.useMutation({
    onSuccess: () => { utils.worklist.forMonth.invalidate(); toast.success("No-answer attempt removed."); },
    onError: (e) => toast.error(e.message),
  });
  const bulkUpdate = trpc.worklist.bulkUpdateStatus.useMutation({
    onSuccess: (r) => { utils.worklist.forMonth.invalidate(); setSelected([]); setBulkStatus(""); toast.success(`Updated ${r.count} tasks.`); },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  }

  const q = search.trim().toLowerCase();
  const rows = sortedRows.filter((r) => {
    if (statusFilter && worklistStatusValue(r.task.status) !== statusFilter) return false;
    if (q) {
      const hay = `${r.patient.name} ${r.patient.phoneNumber ?? ""} ${r.providerName ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const filtersActive = !!(statusFilter || clinicFilter || q);
  const field = "px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(17_72%_62%)]";
  const toggle = (id: number) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);

  return (
    <CCMDashboardLayout title={`Monthly Worklist - ${month}`}>
      {/* Program tabs — CCM and BHI are tracked independently. */}
      <div className="flex items-center gap-1 mb-4 bg-slate-100 rounded-2xl p-1 w-fit">
        {(["ccm", "bhi", "apcm", "all"] as const).map((p) => {
          const active = program === p;
          const label = p === "all" ? "All" : PROGRAM_LABELS[p];
          return (
            <button key={p} onClick={() => { setProgram(p); setSelected([]); }}
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-sm font-semibold transition ${active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, phone, provider…"
              className="w-64 pl-9 pr-8 py-2 rounded-xl border border-slate-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[hsl(17_72%_62%)]"
            />
            {search && (
              <button onClick={() => setSearch("")} title="Clear search" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={14} /></button>
            )}
          </div>
          <select className={field} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All Statuses</option>
            {WORKLIST_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{WORKLIST_STATUS_LABELS[s]}</option>)}
          </select>
          <select className={field} value={clinicFilter} onChange={(e) => setClinicFilter(Number(e.target.value))}>
            <option value={0}>All Clinics</option>
            {(clinics.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {filtersActive && (
            <button onClick={() => { setStatusFilter(""); setClinicFilter(0); setSearch(""); }} className="inline-flex items-center gap-1 px-3 py-2 rounded-xl text-sm text-slate-500 hover:bg-slate-100"><X size={14} /> Clear</button>
          )}
          {user?.role === "staff" && (
            <button onClick={() => setMineOnly((m) => !m)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium transition ${mineOnly ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"}`}>
              {mineOnly ? "My Tasks" : "All Tasks"}
            </button>
          )}
        </div>
        {isStaff && selected.length > 0 && (
          <div className="flex items-center gap-2 bg-slate-900 text-white rounded-2xl px-3 py-2">
            <ListChecks size={16} />
            <span className="text-sm font-medium">{selected.length} selected</span>
            <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} className="px-2 py-1 rounded-lg text-slate-800 text-xs">
              <option value="">Set status...</option>
              {WORKLIST_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{WORKLIST_STATUS_LABELS[s]}</option>)}
            </select>
            <button disabled={!bulkStatus || bulkUpdate.isPending} onClick={() => bulkUpdate.mutate({ ids: selected, status: bulkStatus as any })} className="px-3 py-1 rounded-lg bg-white text-slate-900 text-xs font-semibold disabled:opacity-50">Apply</button>
          </div>
        )}
      </div>

      <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400 border-b border-slate-100 bg-slate-50/50">
                {isStaff && <th className="px-3 py-2.5 w-10"></th>}
                <th className="px-4 py-2.5 font-medium">Patient</th>
                <th className="px-4 py-2.5 font-medium">Phone</th>
                <th className="px-4 py-2.5 font-medium">Provider</th>
                <th
                  onClick={() => setLastCalledSort((d) => (d === "none" ? "asc" : d === "asc" ? "desc" : "none"))}
                  className="px-4 py-2.5 font-medium cursor-pointer select-none hover:text-slate-600 transition-colors"
                  title="Sort by date last called"
                >
                  <span className="inline-flex items-center gap-1">
                    Last Called
                    {lastCalledSort === "asc" ? <ChevronUp size={12} /> : lastCalledSort === "desc" ? <ChevronDown size={12} /> : <ChevronsUpDown size={12} className="text-slate-300" />}
                  </span>
                </th>
                <th className="px-4 py-2.5 font-medium" title="Times called this month with no answer">Attempts</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {worklistLoading && <tr><td colSpan={9} className="px-5 py-12 text-center"><Loader2 className="animate-spin text-slate-300 mx-auto" /></td></tr>}
              {!worklistLoading && rows.length === 0 && <tr><td colSpan={9} className="px-5 py-12 text-center text-slate-400 font-light">{filtersActive ? "No patients match your search or filters." : program === "bhi" ? "No BHI patients enrolled for this month. Enroll patients in BHI from their patient page." : "No tasks for this month. An admin can generate the worklist from the Admin Dashboard."}</td></tr>}
              {rows.map((r) => (
                <tr key={r.task.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                  {isStaff && (
                    <td className="px-3 py-2"><input type="checkbox" checked={selected.includes(r.task.id)} onChange={() => toggle(r.task.id)} className="accent-slate-900" /></td>
                  )}
                  <td className="px-4 py-2">
                    <p className="font-semibold text-slate-800 flex items-center gap-2">
                      {r.patient.name}
                      {program === "all" && (
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${programBadgeClass(r.task.program)}`}>{PROGRAM_LABELS[r.task.program as Program]}</span>
                      )}
                    </p>
                    <p className="text-xs text-slate-400">{r.clinicName} - {r.staffName || "Unassigned"}</p>
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {r.patient.phoneNumber
                      ? <PhoneLink phone={r.patient.phoneNumber} context={{ patientId: r.patient.id, name: r.patient.name, source: "ccm_call" }} className="font-medium text-slate-700" />
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{r.providerName || "-"}</td>
                  <td className="px-4 py-2 text-slate-600 whitespace-nowrap font-mono text-xs tabular-nums">{fmtDate(r.patient.lastCalledAt)}</td>
                  <td className="px-4 py-2">
                    {(r.task.noAnswerCount ?? 0) > 0 ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 text-amber-700 font-semibold font-mono tabular-nums" title="No-answer attempts this month"><PhoneOff size={13} /> {r.task.noAnswerCount}×</span>
                        {isStaff && (
                          <button onClick={() => unlogNoAnswer.mutate({ id: r.task.id })} disabled={unlogNoAnswer.isPending}
                            title="Remove a no-answer attempt (logged by mistake)"
                            className="inline-flex items-center justify-center w-5 h-5 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50 transition">
                            <Minus size={13} />
                          </button>
                        )}
                      </span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2">
                    {(() => {
                      const bucket = worklistStatusValue(r.task.status);
                      return isStaff ? (
                        <select value={bucket} onChange={(e) => updateStatus.mutate({ id: r.task.id, status: e.target.value as any })}
                          className={`px-2 py-1 rounded-full text-[11px] font-semibold border-0 max-w-[180px] ${statusBadgeClass(bucket)}`}>
                          {WORKLIST_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{WORKLIST_STATUS_LABELS[s]}</option>)}
                        </select>
                      ) : (
                        <span className={`px-2.5 py-1 rounded-full text-[11px] font-semibold ${statusBadgeClass(bucket)}`}>{WORKLIST_STATUS_LABELS[bucket]}</span>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-2">
                    {isStaff && (
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => logNoAnswer.mutate({ id: r.task.id })} disabled={logNoAnswer.isPending}
                          title="Log a no-answer attempt (+1)"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-amber-200 text-amber-700 text-xs font-semibold whitespace-nowrap hover:bg-amber-50 active:scale-[0.97] disabled:opacity-50 transition">
                          <PhoneOff size={13} /> No answer
                        </button>
                        <button onClick={() => setLocation(`/workflow/${r.task.id}`)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 text-white text-xs font-semibold whitespace-nowrap hover:bg-slate-800">
                          {worklistStatusValue(r.task.status) === "completed" ? <CheckCircle2 size={13} /> : <Phone size={13} />}
                          {worklistStatusValue(r.task.status) === "completed" ? "Review" : "Start Call"}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-3 text-sm font-light text-slate-400">{rows.length} tasks</p>
    </CCMDashboardLayout>
  );
}
