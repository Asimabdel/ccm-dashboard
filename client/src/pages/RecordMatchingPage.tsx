import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeftRight, CheckCircle2, Link2, Loader2, X } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, cardCls, fmtDob } from "@/components/workspace/ui";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDay } from "@shared/workforce";

type Pair = RouterOutputs["workspace"]["recordMatching"]["list"][number];

/**
 * Record matching (admins): CCM-roster patients and Practice Fusion records that are probably the same
 * person but need a person to confirm (a nickname or initial, or first and last name swapped).
 * Linking puts the Practice Fusion chart, visits and birthday on the roster record.
 */
export default function RecordMatchingPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const utils = trpc.useUtils();
  const list = trpc.workspace.recordMatching.list.useQuery(undefined, { enabled: user?.role === "admin" });
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const confirm = trpc.workspace.recordMatching.confirm.useMutation();
  const reject = trpc.workspace.recordMatching.reject.useMutation();
  const id = (p: Pair) => `${p.rosterId}|${p.pfId}`;

  const run = async (pairs: Pair[], mode: "link" | "reject") => {
    if (!pairs.length) return;
    setBusy(mode);
    let ok = 0;
    try {
      for (const p of pairs) {
        try {
          if (mode === "link") await confirm.mutateAsync({ rosterId: p.rosterId, pfId: p.pfId });
          else await reject.mutateAsync({ rosterId: p.rosterId, pfId: p.pfId });
          ok++;
        } catch (e) {
          toast.error(`${p.rosterName}: ${(e as Error).message}`);
        }
      }
      toast.success(mode === "link" ? `${ok} linked.` : `${ok} marked as different people.`);
    } finally {
      setBusy(null);
      setPicked(new Set());
      void utils.workspace.recordMatching.invalidate();
      void utils.workspace.programs.invalidate();
      void utils.workspace.directory.invalidate();
    }
  };

  if (!user) return null;
  if (user.role !== "admin") return <CCMDashboardLayout title="Record matching"><EmptyState icon={Link2} title="Only admins can match records" /></CCMDashboardLayout>;
  const pairs = list.data ?? [];
  const pickedPairs = pairs.filter((p) => picked.has(id(p)));
  const allPicked = pairs.length > 0 && pairs.every((p) => picked.has(id(p)));

  return (
    <CCMDashboardLayout title="Record matching" pageTitle={false}>
      <PageHeader title="Record matching" subtitle="CCM-roster patients and Practice Fusion records that look like the same person but need you to confirm. Linking puts their Practice Fusion chart, visits and birthday on the roster record." />
      {list.isLoading && <Loading />}
      {list.error && <ErrorNote message={list.error.message} />}
      {list.data && pairs.length === 0 && <div className={cardCls}><EmptyState icon={CheckCircle2} title="Nothing to confirm" body="Every roster patient that could be matched has been." /></div>}
      {pairs.length > 0 && (
        <>
          <div className={cn(cardCls, "mb-3 flex flex-wrap items-center gap-3 px-4 py-2.5")}>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
              <input type="checkbox" className="size-4 accent-brand" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(pairs.map(id)))} />
              Select all ({pairs.length})
            </label>
            <div className="ml-auto flex gap-2">
              <Btn size="sm" variant="secondary" disabled={!picked.size || !!busy} onClick={() => run(pickedPairs, "reject")}><X size={14} /> Not the same</Btn>
              <Btn size="sm" disabled={!picked.size || !!busy} onClick={() => run(pickedPairs, "link")}>{busy === "link" ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} Link selected</Btn>
            </div>
          </div>
          <div className="space-y-2">
            {pairs.map((p) => (
              <section key={id(p)} className={cn(cardCls, "flex flex-wrap items-center gap-3 px-4 py-3", picked.has(id(p)) && "ring-2 ring-brand/40")}>
                <input type="checkbox" className="size-4 accent-brand" checked={picked.has(id(p))} aria-label={`Select ${p.rosterName}`}
                  onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(id(p))) n.delete(id(p)); else n.add(id(p)); return n; })} />
                <div className="min-w-[12rem] flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">CCM roster</p>
                  <p className="font-semibold text-slate-900 dark:text-slate-50">{p.rosterName}</p>
                  <p className="text-xs text-slate-500">{p.rosterDob ? `DOB ${fmtDob(p.rosterDob)}` : "No birthday on file"}{p.rosterClinic ? ` · ${p.rosterClinic}` : ""}{p.rosterCcm ? ` · CCM ${p.rosterCcm}` : ""}</p>
                </div>
                <ArrowLeftRight size={16} className="shrink-0 text-slate-400" />
                <div className="min-w-[12rem] flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Practice Fusion</p>
                  <p className="font-semibold text-slate-900 dark:text-slate-50">{p.pfName}</p>
                  <p className="text-xs text-slate-500">
                    {p.pfDob ? `DOB ${fmtDob(p.pfDob)}` : "No birthday"}{p.pfPhoneLast4 ? ` · phone …${p.pfPhoneLast4}` : ""}{p.pfClinic ? ` · ${p.pfClinic}` : ""}{p.pfProvider ? ` · ${p.pfProvider}` : ""}
                    {p.pfLastVisit ? ` · last visit ${fmtDay(p.pfLastVisit, { month: "short", day: "numeric", year: "numeric" })}` : ""}
                  </p>
                </div>
                <p className="w-full text-[11px] text-slate-500 sm:w-auto sm:max-w-[14rem]">{p.reason}</p>
                <div className="flex gap-2">
                  <Btn size="sm" variant="secondary" disabled={!!busy} onClick={() => run([p], "reject")}>Not the same</Btn>
                  <Btn size="sm" disabled={!!busy} onClick={() => run([p], "link")}><Link2 size={14} /> Link</Btn>
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </CCMDashboardLayout>
  );
}
