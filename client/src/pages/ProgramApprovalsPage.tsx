import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, Loader2, RefreshCw, Search, UserPlus } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, SelectBox, ageFrom, cardCls, fmtDob, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDay } from "@shared/workforce";
import { patientHref } from "@shared/folder";
import { SUGGEST_PROGRAMS, SUGGEST_PROGRAM_LABELS, type SuggestProgram } from "@shared/programRules";

type Group = RouterOutputs["workspace"]["programs"]["list"]["groups"][number];
type Status = "pending" | "approved" | "rejected";
const STATUS_LABELS: Record<Status, string> = { pending: "Waiting", approved: "Approved", rejected: "Not now" };
const PILL: Record<SuggestProgram, string> = {
  ccm: "bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:ring-orange-900",
  bhi: "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-900",
  apcm: "bg-teal-50 text-teal-700 ring-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:ring-teal-900",
  rpm: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-900",
};

/**
 * Program approvals (only the named approvers): patients whose Practice Fusion diagnoses qualify
 * them for CCM / BHI / RPM / APCM. Approving enrolls them with consent pending; nothing bills
 * until they consent.
 */
export default function ProgramApprovalsPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const [params, setParams] = useUrlParams();
  const status = (["pending", "approved", "rejected"].includes(params.get("status") ?? "") ? params.get("status") : "pending") as Status;
  const program = (SUGGEST_PROGRAMS as readonly string[]).includes(params.get("program") ?? "") ? (params.get("program") as SuggestProgram) : null;
  const clinicId = Number(params.get("clinic")) || null;
  const page = Math.max(1, Number(params.get("page")) || 1);
  const q = params.get("q") ?? "";
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (text.trim() === q) return;
    const t = setTimeout(() => setParams({ q: text.trim() || null, page: null }), 300);
    return () => clearTimeout(t);
  }, [text, q, setParams]);

  const list = trpc.workspace.programs.list.useQuery({ status, program, clinicId, q: q || null, page }, { enabled: !!user && ws.programApprover, placeholderData: (prev) => prev });
  const d = list.data;
  // Programs unticked on a patient (approve the rest), and patients picked for a bulk approval.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => { setPicked(new Set()); }, [status, program, clinicId, page, q]);

  const refresh = () => { void utils.workspace.programs.list.invalidate(); void utils.workspace.programs.count.invalidate(); };
  const decide = trpc.workspace.programs.decide.useMutation();
  const scan = trpc.workspace.programs.scan.useMutation({
    onSuccess: (r) => { refresh(); toast.success(r.newPatients ? `${r.newPatients} more patient${r.newPatients === 1 ? "" : "s"} qualify.` : "Checked everyone: nothing new."); },
    onError: (e) => toast.error(e.message),
  });
  const [busy, setBusy] = useState<string | null>(null);

  const chosen = (g: Group) => g.items.filter((i) => !unticked.has(`${g.key}#${i.program}`)).map((i) => i.program);
  const run = async (groups: Group[], mode: "approve" | "reject") => {
    if (!groups.length) return;
    const decisions = groups.map((g) => mode === "approve"
      ? { subjectKey: g.key, approve: chosen(g), reject: [] as SuggestProgram[] }
      : { subjectKey: g.key, approve: [] as SuggestProgram[], reject: g.items.map((i) => i.program) })
      .filter((x) => x.approve.length || x.reject.length);
    if (!decisions.length) return toast.error("Tick at least one program.");
    if (mode === "approve" && decisions.length > 1 && !confirm(`Approve ${decisions.length} patients for their ticked programs?\n\nThey're enrolled now with consent pending. A "get consent" task goes to each one's coordinator, and nothing bills until they consent.`)) return;
    setBusy(mode === "approve" ? "Approving" : "Saving");
    let enrolled = 0;
    const failed: string[] = [];
    try {
      for (let i = 0; i < decisions.length; i += 10) {
        const r = await decide.mutateAsync({ decisions: decisions.slice(i, i + 10) });
        for (const x of r.results) {
          if (x.error) failed.push(`${groups.find((g) => g.key === x.subjectKey)?.name ?? "A patient"}: ${x.error}`);
          else if (x.enrolled.length) enrolled++;
        }
      }
      if (mode === "approve") toast.success(`${enrolled} patient${enrolled === 1 ? "" : "s"} enrolled. Consent tasks sent to their coordinators.`);
      else toast.success(`Marked "not now". They'll come back only if their diagnoses change.`);
      if (failed.length) toast.error(failed.slice(0, 3).join("\n"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      setPicked(new Set());
      refresh();
    }
  };

  const pickedGroups = useMemo(() => (d?.groups ?? []).filter((g) => picked.has(g.key)), [d, picked]);
  if (!user || ws.loading) return null;
  if (!ws.programApprover) {
    return <CCMDashboardLayout title="Program approvals"><EmptyState icon={ClipboardCheck} title="Only the program approvers can see this page" /></CCMDashboardLayout>;
  }
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  const allPicked = !!d?.groups.length && d.groups.every((g) => picked.has(g.key));

  return (
    <CCMDashboardLayout title="Program approvals" pageTitle={false}>
      <PageHeader
        title="Program approvals"
        subtitle={<>Patients seen in the last 12 months whose diagnoses in Practice Fusion qualify them for a care program{d?.scope === "office" ? " (your office)" : ""}. Approving enrolls them; nothing bills until they consent.</>}
        actions={<Btn variant="secondary" onClick={() => scan.mutate()} disabled={scan.isPending}>{scan.isPending ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Check now</Btn>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800" role="tablist">
          {(["pending", "approved", "rejected"] as Status[]).map((s) => (
            <button key={s} role="tab" aria-selected={status === s} onClick={() => setParams({ status: s === "pending" ? null : s, page: null })}
              className={cn("rounded-lg px-3 py-1.5 text-sm font-semibold", status === s ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-50" : "text-slate-500 hover:text-slate-800")}>
              {STATUS_LABELS[s]}{s === status && d ? <span className="ml-1.5 text-xs font-normal text-slate-400 tabular-nums">{d.total.toLocaleString()}</span> : null}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => setParams({ program: null, page: null })} className={cn("rounded-full px-3 py-1 text-xs font-semibold ring-1", !program ? "bg-slate-900 text-white ring-slate-900 dark:bg-slate-100 dark:text-slate-900" : "text-slate-600 ring-slate-200 dark:text-slate-300 dark:ring-slate-700")}>All programs</button>
          {SUGGEST_PROGRAMS.map((p) => (
            <button key={p} onClick={() => setParams({ program: p, page: null })} className={cn("rounded-full px-3 py-1 text-xs font-semibold ring-1", program === p ? "bg-slate-900 text-white ring-slate-900 dark:bg-slate-100 dark:text-slate-900" : "text-slate-600 ring-slate-200 dark:text-slate-300 dark:ring-slate-700")}>
              {SUGGEST_PROGRAM_LABELS[p]} <span className="tabular-nums opacity-70">{d ? d.counts[p].toLocaleString() : ""}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {d && d.clinics.length > 1 && (
            <SelectBox ariaLabel="Clinic" value={clinicId ? String(clinicId) : ""} onChange={(v) => setParams({ clinic: v || null, page: null })}>
              <option value="">All clinics</option>
              {d.clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectBox>
          )}
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Find a patient" aria-label="Find a patient" className={cn(inputCls, "w-52 pl-9")} />
          </div>
        </div>
      </div>

      {status === "pending" && !!d?.groups.length && (
        <div className={cn(cardCls, "mb-3 flex flex-wrap items-center gap-3 px-4 py-2.5")}>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            <input type="checkbox" className="size-4 accent-brand" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(d.groups.map((g) => g.key)))} />
            Select all on this page
          </label>
          <span className="text-sm text-slate-500">{picked.size ? `${picked.size} selected` : "Pick patients to approve several at once"}</span>
          <div className="ml-auto flex gap-2">
            <Btn size="sm" variant="secondary" disabled={!picked.size || !!busy} onClick={() => run(pickedGroups, "reject")}>Not now</Btn>
            <Btn size="sm" disabled={!picked.size || !!busy} onClick={() => run(pickedGroups, "approve")}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Approve selected
            </Btn>
          </div>
        </div>
      )}

      {list.isLoading && <Loading label="Gathering patients…" />}
      {list.error && <ErrorNote message={list.error.message} />}
      {d && d.total === 0 && (
        <div className={cardCls}>
          <EmptyState icon={ClipboardCheck}
            title={status === "pending" ? "No one is waiting" : status === "approved" ? "No approvals yet" : "Nothing marked \"not now\""}
            body={status === "pending" ? "Everyone is checked each morning. Use \"Check now\" after new diagnoses come in from Practice Fusion." : undefined} />
        </div>
      )}

      <div className="space-y-3">
        {d?.groups.map((g) => (
          <PatientCard key={g.key} g={g} status={status} picked={picked.has(g.key)} busy={!!busy}
            onPick={() => setPicked((s) => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })}
            isTicked={(p) => !unticked.has(`${g.key}#${p}`)}
            onTick={(p) => setUnticked((s) => { const n = new Set(s); const k = `${g.key}#${p}`; if (n.has(k)) n.delete(k); else n.add(k); return n; })}
            onApprove={() => run([g], "approve")}
            onReject={() => run([g], "reject")}
          />
        ))}
      </div>

      {d && d.total > d.pageSize && (
        <div className="mt-4 flex items-center justify-end gap-2 text-sm text-slate-500">
          <button disabled={page <= 1} onClick={() => setParams({ page: page - 1 > 1 ? page - 1 : null })} aria-label="Previous page" className="rounded-lg p-1.5 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-700"><ChevronLeft size={16} /></button>
          <span className="tabular-nums">Page {page} of {pages}</span>
          <button disabled={page >= pages} onClick={() => setParams({ page: page + 1 })} aria-label="Next page" className="rounded-lg p-1.5 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-700"><ChevronRight size={16} /></button>
        </div>
      )}
      {busy && <p className="mt-3 text-sm text-slate-500"><Loader2 size={14} className="mr-1 inline animate-spin" />{busy}… enrolling takes a moment per patient.</p>}
    </CCMDashboardLayout>
  );
}

function PatientCard({ g, status, picked, busy, onPick, isTicked, onTick, onApprove, onReject }: {
  g: Group; status: Status; picked: boolean; busy: boolean;
  onPick: () => void; isTicked: (p: SuggestProgram) => boolean; onTick: (p: SuggestProgram) => void; onApprove: () => void; onReject: () => void;
}) {
  const waiting = status === "pending";
  const onRoster = g.key.startsWith("p:");
  const first = g.items[0];
  return (
    <section className={cn(cardCls, "p-4", picked && "ring-2 ring-brand/40")}>
      <div className="flex flex-wrap items-start gap-3">
        {waiting && <input type="checkbox" className="mt-1 size-4 accent-brand" checked={picked} onChange={onPick} aria-label={`Select ${g.name}`} />}
        <div className="min-w-0 flex-1">
          <Link href={patientHref(g.key, "chart")} className="font-semibold text-slate-900 hover:underline dark:text-slate-50">{g.name}</Link>
          <p className="mt-0.5 text-xs text-slate-500">
            {g.dob ? `DOB ${fmtDob(g.dob)} (${ageFrom(g.dob)})` : "DOB not on file"}
            {g.clinicName ? ` · ${g.clinicName}` : ""}
            {g.lastVisit ? ` · last visit ${fmtDay(g.lastVisit, { month: "short", day: "numeric", year: "numeric" })}` : ""}
          </p>
          {waiting && !onRoster && (
            <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300"><UserPlus size={12} /> Not on the CCM roster yet: approving adds them.</p>
          )}
          {!waiting && first && (
            <p className="mt-1 text-xs text-slate-500">
              {status === "approved" ? "Approved" : "Not now"}{first.decidedBy ? ` by ${first.decidedBy}` : ""}{first.decidedAt ? ` · ${fmtShortDate(first.decidedAt)}` : ""}{first.note ? ` · “${first.note}”` : ""}
            </p>
          )}
        </div>
        {waiting && (
          <div className="flex gap-2">
            <Btn size="sm" variant="secondary" disabled={busy} onClick={onReject}>Not now</Btn>
            <Btn size="sm" disabled={busy || !g.items.some((i) => isTicked(i.program))} onClick={onApprove}><CheckCircle2 size={14} /> Approve</Btn>
          </div>
        )}
      </div>
      <ul className="mt-3 space-y-2">
        {g.items.map((i) => (
          <li key={i.id} className="flex items-start gap-2.5 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
            {waiting && <input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={isTicked(i.program)} onChange={() => onTick(i.program)} aria-label={`Approve ${SUGGEST_PROGRAM_LABELS[i.program]}`} />}
            <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ring-1", PILL[i.program])}>{SUGGEST_PROGRAM_LABELS[i.program]}</span>
            <span className="min-w-0 text-sm">
              <span className="block text-slate-800 dark:text-slate-100">{i.reason}</span>
              <span className="block text-xs text-slate-500">{i.diagnoses.map((x) => `${x.title}${x.icd ? ` (${x.icd})` : ""}`).join(" · ")}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
