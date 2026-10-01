import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowLeftRight, CheckCircle2, Link2, Loader2, Search, X } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, cardCls, fmtDob, inputCls } from "@/components/workspace/ui";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDay } from "@shared/workforce";
import { nameKey } from "@shared/workspace";

type Overview = RouterOutputs["workspace"]["recordMatching"]["list"];
type Pair = Overview["confirm"][number];
type Roster = Overview["none"][number];
type PfInfo = Overview["several"][number]["candidates"][number];
type Tab = "confirm" | "several" | "none";

const day = (d: string | null) => (d ? fmtDay(d, { month: "short", day: "numeric", year: "numeric" }) : null);

/**
 * Record matching (admins): CCM-roster patients whose Practice Fusion record isn't linked yet.
 * Confirm likely pairs, pick between several equally good records, or search Practice Fusion by hand
 * for roster patients with no match. Linking puts their Practice Fusion chart, visits, birthday and
 * chronic conditions on the roster record.
 */
export default function RecordMatchingPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const utils = trpc.useUtils();
  const [params, setParams] = useUrlParams();
  const tab = (["confirm", "several", "none"].includes(params.get("tab") ?? "") ? params.get("tab") : "confirm") as Tab;
  const list = trpc.workspace.recordMatching.list.useQuery(undefined, { enabled: user?.role === "admin" });
  const confirm = trpc.workspace.recordMatching.confirm.useMutation();
  const reject = trpc.workspace.recordMatching.reject.useMutation();
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [ccmOnly, setCcmOnly] = useState(true);

  const refresh = () => {
    void utils.workspace.recordMatching.invalidate();
    void utils.workspace.programs.invalidate();
    void utils.workspace.directory.invalidate();
  };
  const runPairs = async (pairs: { rosterId: number; pfId: string; rosterName: string }[], mode: "link" | "reject") => {
    if (!pairs.length) return;
    setBusy(true);
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
      if (ok) toast.success(mode === "link" ? `${ok} linked. Their chart and conditions move over.` : `${ok} marked as different people.`);
    } finally {
      setBusy(false);
      setPicked(new Set());
      refresh();
    }
  };

  const d = list.data;
  const words = nameKey(filter).split(" ").filter(Boolean);
  const keep = (r: Roster) => (!ccmOnly || r.rosterCcm === "active") && words.every((w) => nameKey(r.rosterName).includes(w));
  const shown = useMemo(() => ({
    confirm: (d?.confirm ?? []).filter(keep),
    several: (d?.several ?? []).filter(keep),
    none: (d?.none ?? []).filter(keep),
  }), [d, ccmOnly, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return null;
  if (user.role !== "admin") return <CCMDashboardLayout title="Record matching"><EmptyState icon={Link2} title="Only admins can match records" /></CCMDashboardLayout>;
  const pid = (p: Pair) => `${p.rosterId}|${p.pfId}`;
  const tabs: { key: Tab; label: string; n: number }[] = [
    { key: "confirm", label: "Confirm a match", n: shown.confirm.length },
    { key: "several", label: "Several possible", n: shown.several.length },
    { key: "none", label: "No match found", n: shown.none.length },
  ];

  return (
    <CCMDashboardLayout title="Record matching" pageTitle={false}>
      <PageHeader title="Record matching" subtitle="CCM-roster patients whose Practice Fusion record isn't linked yet. Linking puts their Practice Fusion chart, visits, birthday and chronic conditions on the roster record." />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800" role="tablist">
          {tabs.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => { setParams({ tab: t.key === "confirm" ? null : t.key }); setPicked(new Set()); }}
              className={cn("rounded-lg px-3 py-1.5 text-sm font-semibold", tab === t.key ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-50" : "text-slate-500 hover:text-slate-800")}>
              {t.label} <span className="text-xs font-normal tabular-nums text-slate-400">{d ? t.n : ""}</span>
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" className="size-4 accent-brand" checked={ccmOnly} onChange={(e) => setCcmOnly(e.target.checked)} /> CCM-active only
        </label>
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name" aria-label="Filter by name" className={cn(inputCls, "w-48 pl-9")} />
        </div>
      </div>

      {list.isLoading && <Loading />}
      {list.error && <ErrorNote message={list.error.message} />}

      {d && tab === "confirm" && (
        shown.confirm.length === 0 ? <div className={cardCls}><EmptyState icon={CheckCircle2} title="Nothing to confirm" /></div> : (
          <>
            <div className={cn(cardCls, "mb-3 flex flex-wrap items-center gap-3 px-4 py-2.5")}>
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                <input type="checkbox" className="size-4 accent-brand" checked={shown.confirm.every((p) => picked.has(pid(p)))} onChange={(e) => setPicked(e.target.checked ? new Set(shown.confirm.map(pid)) : new Set())} />
                Select all ({shown.confirm.length})
              </label>
              <div className="ml-auto flex gap-2">
                <Btn size="sm" variant="secondary" disabled={!picked.size || busy} onClick={() => runPairs(shown.confirm.filter((p) => picked.has(pid(p))), "reject")}><X size={14} /> Not the same</Btn>
                <Btn size="sm" disabled={!picked.size || busy} onClick={() => runPairs(shown.confirm.filter((p) => picked.has(pid(p))), "link")}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} Link selected</Btn>
              </div>
            </div>
            <div className="space-y-2">
              {shown.confirm.map((p) => (
                <section key={pid(p)} className={cn(cardCls, "flex flex-wrap items-center gap-3 px-4 py-3", picked.has(pid(p)) && "ring-2 ring-brand/40")}>
                  <input type="checkbox" className="size-4 accent-brand" checked={picked.has(pid(p))} aria-label={`Select ${p.rosterName}`}
                    onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(pid(p))) n.delete(pid(p)); else n.add(pid(p)); return n; })} />
                  <RosterSide r={p} />
                  <ArrowLeftRight size={16} className="shrink-0 text-slate-400" />
                  <PfSide p={p} />
                  <p className="w-full text-[11px] text-slate-500 sm:w-auto sm:max-w-[14rem]">{p.reason}</p>
                  <div className="flex gap-2">
                    <Btn size="sm" variant="secondary" disabled={busy} onClick={() => runPairs([p], "reject")}>Not the same</Btn>
                    <Btn size="sm" disabled={busy} onClick={() => runPairs([p], "link")}><Link2 size={14} /> Link</Btn>
                  </div>
                </section>
              ))}
            </div>
          </>
        )
      )}

      {d && tab === "several" && (
        shown.several.length === 0 ? <div className={cardCls}><EmptyState icon={CheckCircle2} title="None" /></div> : (
          <div className="space-y-2">
            {shown.several.map((r) => (
              <section key={r.rosterId} className={cn(cardCls, "px-4 py-3")}>
                <RosterSide r={r} />
                <p className="mt-2 text-xs text-slate-500">These Practice Fusion records have the same name{r.rosterDob ? " and birthday" : ""}. Link the right one:</p>
                <ul className="mt-2 space-y-1.5">
                  {r.candidates.map((c) => (
                    <li key={c.pfId} className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
                      <PfSide p={c} />
                      <Btn size="sm" disabled={busy} onClick={() => runPairs([{ rosterId: r.rosterId, pfId: c.pfId, rosterName: r.rosterName }], "link")}><Link2 size={14} /> Link this one</Btn>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )
      )}

      {d && tab === "none" && (
        shown.none.length === 0 ? <div className={cardCls}><EmptyState icon={CheckCircle2} title="None" /></div> : (
          <>
            <p className="mb-3 text-sm text-slate-500">No Practice Fusion patient has a matching name. The name may be spelled differently, or they may not be in Practice Fusion's export (e.g. no longer a patient). Use <b>Find in Practice Fusion</b> to search and link by hand.</p>
            <div className="space-y-2">
              {shown.none.map((r) => <NoMatchRow key={r.rosterId} r={r} busy={busy} onLink={(pfId) => runPairs([{ rosterId: r.rosterId, pfId, rosterName: r.rosterName }], "link")} />)}
            </div>
          </>
        )
      )}
    </CCMDashboardLayout>
  );
}

function RosterSide({ r }: { r: Roster }) {
  return (
    <div className="min-w-[12rem] flex-1">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">CCM roster</p>
      <p className="font-semibold text-slate-900 dark:text-slate-50">{r.rosterName}</p>
      <p className="text-xs text-slate-500">
        {r.rosterDob ? `DOB ${fmtDob(r.rosterDob)}` : "No birthday on file"}{r.rosterClinic ? ` · ${r.rosterClinic}` : ""}{r.rosterCcm ? ` · CCM ${r.rosterCcm}` : ""}
        {r.rosterCoordinator ? ` · ${r.rosterCoordinator}` : ""}{r.rosterLastCcm ? ` · last CCM call ${day(r.rosterLastCcm)}` : ""}
      </p>
    </div>
  );
}

function PfSide({ p }: { p: Omit<PfInfo, never> }) {
  return (
    <div className="min-w-[12rem] flex-1">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Practice Fusion</p>
      <p className="font-semibold text-slate-900 dark:text-slate-50">{p.pfName}</p>
      <p className="text-xs text-slate-500">
        {p.pfDob ? `DOB ${fmtDob(p.pfDob)}` : "No birthday"}{p.pfPhoneLast4 ? ` · phone …${p.pfPhoneLast4}` : ""}{p.pfClinic ? ` · ${p.pfClinic}` : ""}{p.pfProvider ? ` · ${p.pfProvider}` : ""}
        {p.pfLastVisit ? ` · last visit ${day(p.pfLastVisit)}` : ""}
      </p>
    </div>
  );
}

/** A roster patient with no automatic match: search the unlinked Practice Fusion records and link by hand. */
function NoMatchRow({ r, busy, onLink }: { r: Roster; busy: boolean; onLink: (pfId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const results = trpc.workspace.recordMatching.searchPf.useQuery({ q: debounced }, { enabled: open && debounced.length >= 2 });
  return (
    <section className={cn(cardCls, "px-4 py-3")}>
      <div className="flex flex-wrap items-center gap-3">
        <RosterSide r={r} />
        {!open && <Btn size="sm" variant="secondary" onClick={() => { setOpen(true); setQ(r.rosterName.split(/[\s,]+/).filter(Boolean).pop() ?? ""); }}><Search size={14} /> Find in Practice Fusion</Btn>}
      </div>
      {open && (
        <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, birthday (MM/DD/YYYY) or phone" aria-label="Search Practice Fusion" className={cn(inputCls, "max-w-sm")} />
            <button className="text-xs text-slate-500 hover:text-slate-800" onClick={() => setOpen(false)}>Close</button>
          </div>
          {results.isFetching && <Loader2 size={14} className="mt-2 animate-spin text-slate-400" />}
          {results.data && results.data.length === 0 && <p className="mt-2 text-xs text-slate-500">No unlinked Practice Fusion patient matches that.</p>}
          <ul className="mt-2 space-y-1.5">
            {(results.data ?? []).map((c) => (
              <li key={c.pfId} className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
                <PfSide p={c} />
                <Btn size="sm" disabled={busy} onClick={() => onLink(c.pfId)}><Link2 size={14} /> Link</Btn>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
