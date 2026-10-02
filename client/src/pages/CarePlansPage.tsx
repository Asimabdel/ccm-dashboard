import { useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { BookOpen, CheckCircle2, ClipboardCheck, FilePlus2, Loader2, PenLine, Search } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, cardCls, fmtDob, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { nameKey } from "@shared/workspace";
import { localDateStr } from "@shared/workforce";
import { LIB_STATUS, PLAN_STATUS } from "@/components/careplan/status";

type Tab = "to_sign" | "none" | "signed" | "library";

/**
 * Care plans: every CCM-active patient's comprehensive care plan (drafts waiting for a provider's
 * signature, patients with no plan yet, signed plans), and the condition library the plans and
 * patient handouts come from (providers approve each condition once).
 */
export default function CarePlansPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const [params, setParams] = useUrlParams();
  const tab = ((["to_sign", "none", "signed", "library"] as const).find((t) => t === params.get("tab")) ?? "to_sign") as Tab;
  const [filter, setFilter] = useState("");
  const [mine, setMine] = useState(params.get("mine") === "1");
  const queue = trpc.workspace.carePlans.queue.useQuery({ filter: tab === "library" ? "to_sign" : tab, mine }, { enabled: !!ws.caps?.carePlans });
  const library = trpc.workspace.library.list.useQuery(undefined, { enabled: !!ws.caps?.carePlans && tab === "library" });
  const utils = trpc.useUtils();
  const buildMissing = trpc.workspace.carePlans.buildMissing.useMutation();
  const signAll = trpc.workspace.carePlans.signAllMine.useMutation();
  const doSignAll = async () => {
    if (!window.confirm("Sign every complete care plan for your CCM patients that isn't signed yet? Your signature confirms you've reviewed and established each plan; your name and the time are recorded on each one.")) return;
    let signed = 0, incomplete = 0;
    try {
      for (let i = 0; i < 30; i++) {
        const r = await signAll.mutateAsync();
        signed += r.signed; incomplete = r.incomplete;
        if (r.done) break;
      }
      toast.success(`${signed} plan${signed === 1 ? "" : "s"} signed.${incomplete ? ` ${incomplete} still have empty sections; open them to finish.` : ""}`);
    } catch (e) { toast.error((e as Error).message); }
    finally { void utils.workspace.carePlans.invalidate(); }
  };
  const [building, setBuilding] = useState(false);

  const words = nameKey(filter).split(" ").filter(Boolean);
  const rows = useMemo(() => (queue.data?.rows ?? []).filter((r) => words.every((w) => nameKey(r.name).includes(w))), [queue.data, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user || ws.loading) return null;
  if (!ws.caps?.carePlans) return <CCMDashboardLayout title="Care plans"><EmptyState icon={ClipboardCheck} title="No access" body="Your role doesn't include care plans." /></CCMDashboardLayout>;

  const startAll = async () => {
    if (!window.confirm("Start a care plan for every CCM-active patient who doesn't have one? Each plan is built from the specialized templates for the patient's diagnoses; their provider signs it.")) return;
    setBuilding(true);
    let built = 0;
    try {
      for (let i = 0; i < 20; i++) {
        const r = await buildMissing.mutateAsync();
        built += r.built;
        if (r.done) {
          toast.success(`${built} plan${built === 1 ? "" : "s"} started.${r.noConditions ? ` ${r.noConditions} patient${r.noConditions === 1 ? " has" : "s have"} no chronic conditions on record yet.` : ""}`);
          break;
        }
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBuilding(false);
      void utils.workspace.carePlans.invalidate();
    }
  };

  const c = queue.data?.counts;
  const tabs: { key: Tab; label: string; n?: number }[] = [
    { key: "to_sign", label: "To sign", n: c?.to_sign },
    { key: "none", label: "No plan yet", n: c?.none },
    { key: "signed", label: "Signed", n: c?.signed },
    { key: "library", label: "Condition library" },
  ];
  const thisMonth = localDateStr().slice(0, 7);

  return (
    <CCMDashboardLayout title="Care plans" pageTitle={false}>
      <PageHeader
        title="Care plans"
        subtitle="Each CCM patient's comprehensive care plan, built from the provider-approved templates for their conditions and signed by a provider."
        actions={tab === "none" && (c?.none ?? 0) > 0
          ? <Btn disabled={building} onClick={startAll}>{building ? <Loader2 size={15} className="animate-spin" /> : <FilePlus2 size={15} />} Start plans for all ({c?.none})</Btn>
          : tab === "to_sign" && queue.data?.canSign && (c?.to_sign ?? 0) > 0
            ? <Btn disabled={signAll.isPending} onClick={doSignAll}>{signAll.isPending ? <Loader2 size={15} className="animate-spin" /> : <PenLine size={15} />} Sign all my patients' plans</Btn>
            : undefined}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800" role="tablist">
          {tabs.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setParams({ tab: t.key === "to_sign" ? null : t.key })}
              className={cn("rounded-lg px-3 py-1.5 text-sm font-semibold", tab === t.key ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-50" : "text-slate-500 hover:text-slate-800")}>
              {t.label} {t.n != null && <span className="text-xs font-normal tabular-nums text-slate-400">{t.n}</span>}
            </button>
          ))}
        </div>
        {tab !== "library" && (
          <>
            {queue.data?.canSign && (
              <label className="ml-auto flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                <input type="checkbox" className="size-4 accent-brand" checked={mine} onChange={(e) => { setMine(e.target.checked); setParams({ mine: e.target.checked ? 1 : null }); }} /> My patients only
              </label>
            )}
            <div className={cn("relative", !queue.data?.canSign && "ml-auto")}>
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name" aria-label="Filter by name" className={cn(inputCls, "w-48 pl-9")} />
            </div>
          </>
        )}
      </div>

      {tab === "library" ? (
        <>
          {library.isLoading && <Loading />}
          {library.error && <ErrorNote message={library.error.message} />}
          {library.data && (
            <>
              <p className="mb-3 text-sm text-slate-500">
                Each exact diagnosis, and each add-on for a complication or a combination of conditions, has a patient handout (English and Spanish), talking points for the CCM call and a care-plan template. All of it is in use; a provider can edit any item or mark it reviewed.
              </p>
              {(() => {
                const approvedN = library.data.conditions.filter((x) => x.status === "approved").length;
                return <p className="mb-3 text-sm font-medium text-slate-700 dark:text-slate-200">{library.data.conditions.length} items in use · {approvedN} marked reviewed by a provider</p>;
              })()}
              {Array.from(new Set(library.data.conditions.map((x) => x.categoryLabel))).map((group) => (
              <div key={group} className="mb-3">
              <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wider text-slate-400">{group}</p>
              <div className={cn(cardCls, "divide-y divide-slate-100 dark:divide-slate-800")}>
                {library.data.conditions.filter((x) => x.categoryLabel === group).map((x) => (
                  <Link key={x.key} href={`/care-plans/library/${x.key}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <BookOpen size={16} className="text-slate-400" />
                    <span className="min-w-[12rem] flex-1 font-medium text-slate-900 dark:text-slate-50">
                      {x.label}
                      {x.kind === "addon" && <span className="ml-2 rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-semibold text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">Add-on</span>}
                      {x.kind === "condition" && x.isDefault && !x.general && <span className="ml-2 text-[11px] font-normal text-slate-400">used when the type isn't specified</span>}
                    </span>
                    {!x.hasContent ? <span className="text-xs text-slate-400">No content yet</span> : (
                      <>
                        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", LIB_STATUS[x.status]!.cls)}>{LIB_STATUS[x.status]!.label}</span>
                        {x.approvedByName && <span className="text-xs text-slate-500">v{x.approvedVersion} · {x.approvedByName} · {fmtShortDate(x.approvedAt)}</span>}
                      </>
                    )}
                  </Link>
                ))}
              </div>
              </div>
              ))}
            </>
          )}
        </>
      ) : (
        <>
          {queue.isLoading && <Loading />}
          {queue.error && <ErrorNote message={queue.error.message} />}
          {queue.data && rows.length === 0 && <div className={cardCls}><EmptyState icon={CheckCircle2} title={tab === "to_sign" ? "Nothing waiting for a signature" : tab === "none" ? "Every CCM patient has a plan" : "No signed plans yet"} /></div>}
          {rows.length > 0 && (
            <div className={cn(cardCls, "divide-y divide-slate-100 dark:divide-slate-800")}>
              {rows.map((r) => (
                <Link key={r.patientId} href={`/patients/${r.patientId}?tab=careplan`} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <div className="min-w-[14rem] flex-1">
                    <p className="font-semibold text-slate-900 dark:text-slate-50">{r.name}</p>
                    <p className="text-xs text-slate-500">
                      {r.dob ? `DOB ${fmtDob(r.dob)}` : "No birthday on file"}{r.clinic ? ` · ${r.clinic}` : ""}{r.provider ? ` · ${r.provider}` : ""}{r.coordinator ? ` · ${r.coordinator}` : ""}
                    </p>
                    {r.conditions.length > 0 && <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{r.conditions.join(" · ")}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", PLAN_STATUS[r.status]!.cls)}>{PLAN_STATUS[r.status]!.label}</span>
                    {r.signedByName && <span className="text-xs text-slate-500"><PenLine size={12} className="mr-1 inline" />{r.signedByName} · {fmtShortDate(r.signedAt)}</span>}
                    {r.status !== "none" && <span className={cn("text-xs", r.lastReviewedMonth === thisMonth ? "text-emerald-700" : "text-slate-400")}>{r.lastReviewedMonth === thisMonth ? "Reviewed this month" : "Not reviewed this month"}</span>}
                  </div>
                </Link>
              ))}
            </div>
          )}
          {queue.data && queue.data.total > rows.length && !filter && <p className="mt-2 text-xs text-slate-500">Showing the first {rows.length} of {queue.data.total}. Filter by name to find others.</p>}
        </>
      )}
    </CCMDashboardLayout>
  );
}
