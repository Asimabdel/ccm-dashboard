import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Pencil, Plus, ScanLine, Search, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, EmptyState, ErrorNote, Loading, MetricCard, Panel, inputCls } from "@/components/workspace/ui";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { usd } from "@shared/visitCost";

type Table = RouterOutputs["masterBilling"]["planCopays"];
type Row = Table["rows"][number];
type Answer = "copay" | "deductible" | "nothing" | "coinsurance";
type Show = "open" | "answered" | "all";

const ANSWER_LABELS: Record<Answer, string> = { copay: "Copay", deductible: "Deductible first", nothing: "Nothing to pay", coinsurance: "Coinsurance" };
const TIER_LABELS = { group: "Group number", plan: "Plan name", payer: "Whole insurance" } as const;

const answerText = (a: NonNullable<Row["answer"]>) =>
  a.answer === "copay" && a.copayCents != null ? `${usd(a.copayCents)} copay` : a.answer === "coinsurance" && a.coinsurancePct ? `${a.coinsurancePct}% coinsurance` : ANSWER_LABELS[a.answer];
const amounts = (xs: { cents: number; patients: number }[]) => xs.map((x) => `${x.cents ? usd(x.cents) : "$0"} ×${x.patients}`).join(", ");

/**
 * Plan copays (owner only): what each plan charges for an office visit, so new patients get an answer on
 * the Copays & deductibles search. Shown with what the payment files and insurance cards say; the
 * owner's answer is what staff are told.
 */
export function PlanCopaysTab() {
  const utils = trpc.useUtils();
  const q = trpc.masterBilling.planCopays.useQuery(undefined, { staleTime: 60_000 });
  const [show, setShow] = useState<Show>("open");
  const [text, setText] = useState("");
  const [edit, setEdit] = useState<Row | "new" | null>(null);
  const [reading, setReading] = useState<{ read: number; left: number } | null>(null);
  const readCards = trpc.masterBilling.readWaitingCards.useMutation();
  const d = q.data;

  const rows = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return (d?.rows ?? []).filter((r) =>
      (show === "all" || (show === "answered" ? !!r.answer : !r.answer)) &&
      words.every((w) => [r.payer, r.plan, r.group].filter(Boolean).join(" ").toLowerCase().includes(w)));
  }, [d, show, text]);

  // Read the waiting card photos a few at a time until none are left.
  const readAll = async () => {
    let total = 0;
    setReading({ read: 0, left: d?.cardsWaiting ?? 0 });
    try {
      for (let i = 0; i < 200; i++) {
        const r = await readCards.mutateAsync();
        total += r.read;
        setReading({ read: total, left: r.left });
        if (!r.left || (!r.read && r.failed)) break;
      }
      toast.success(`Read ${total} card photo${total === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReading(null);
      void utils.masterBilling.planCopays.invalidate();
    }
  };

  return (
    <div className="space-y-5">
      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {d && (
        <>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            What each plan charges for an office visit. Your answer is what the Copays &amp; deductibles search tells staff for <b>new patients</b> on that plan
            (patients with visits go by their own payments, and a copay printed on their card comes first). Each row shows what the payment files and insurance cards already say.
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="Plans" value={String(d.total)} hint="seen on payments or cards" />
            <MetricCard label="Answered by you" value={String(d.answered)} />
            <MetricCard label="Need your answer" value={String(d.total - d.answered)} tone={d.total - d.answered ? "warn" : "good"} />
            <MetricCard label="Card photos not read" value={String(d.cardsWaiting)} hint="from patient forms and folders" />
          </div>
          {d.cardsWaiting > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm dark:border-teal-900 dark:bg-teal-950/30">
              <span>{reading ? `Reading card photos… ${reading.read} read, ${reading.left} left.` : `${d.cardsWaiting} patient${d.cardsWaiting === 1 ? " has" : "s have"} an insurance card photo the AI hasn't read yet. Reading them fills in plan names, group numbers and printed copays below.`}</span>
              <Btn size="sm" disabled={!!reading || !d.canRead} onClick={readAll}><ScanLine size={14} /> {d.canRead ? (reading ? "Reading…" : "Read them") : "AI reading isn't set up here"}</Btn>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {(["open", "answered", "all"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setShow(s)} className={cn("rounded-full border px-3 py-1 text-xs font-semibold", show === s ? "border-brand bg-brand/5" : "border-slate-200 dark:border-slate-700")}>
                {s === "open" ? "Need your answer" : s === "answered" ? "Answered" : "All"}
              </button>
            ))}
            <div className="relative ml-auto min-w-[14rem]">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className={cn(inputCls, "pl-8")} placeholder="Search insurance, plan or group" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search plans" />
            </div>
            <Btn size="sm" variant="secondary" onClick={() => setEdit("new")}><Plus size={14} /> Add a plan</Btn>
          </div>

          {rows.length === 0 ? (
            <Panel><EmptyState title={show === "open" ? "Every plan has your answer" : "No plans here"} body="Plans show up as payment files and insurance cards come in. You can also add one yourself." /></Panel>
          ) : (
            <Panel bodyClassName="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-2 font-medium">Insurance / plan</th><th className="px-3 py-2 font-medium">Matched by</th>
                      <th className="px-3 py-2 font-medium">Payments show</th><th className="px-3 py-2 font-medium">Cards show</th>
                      <th className="px-3 py-2 font-medium">Your answer</th><th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {rows.map((r) => (
                      <tr key={r.key} className="align-top">
                        <td className="px-3 py-2.5">
                          <span className="font-semibold text-slate-900 dark:text-slate-50">{r.payer ?? "Insurance"}</span>
                          {(r.plan || r.group) && <span className="block text-xs text-slate-500">{[r.plan, r.group ? `group ${r.group}` : null].filter(Boolean).join(" · ")}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-500">{TIER_LABELS[r.tier]}</td>
                        <td className="px-3 py-2.5 text-xs">
                          {r.patients ? (
                            <>
                              <span className="block">{r.patients} patient{r.patients === 1 ? "" : "s"}{r.claimCopays.length ? `: ${amounts(r.claimCopays)}` : ""}</span>
                              {r.deductiblePatients > 0 && <span className="block text-violet-700 dark:text-violet-300">deductible on {r.deductiblePatients}</span>}
                              {r.suggestion && <span className="block font-semibold text-teal-700 dark:text-teal-300">suggests {r.suggestion.kind === "deductible" ? "deductible first" : r.suggestion.cents ? `${usd(r.suggestion.cents)} copay` : "nothing to pay"}</span>}
                            </>
                          ) : <span className="text-slate-400">–</span>}
                        </td>
                        <td className="px-3 py-2.5 text-xs">
                          {r.cards ? (
                            <>
                              <span className="block">{r.cards} card{r.cards === 1 ? "" : "s"}{r.cardCopays.length ? `: PCP ${amounts(r.cardCopays)}` : ""}</span>
                              {r.cardHighDeductible > 0 && <span className="block text-violet-700 dark:text-violet-300">HSA / high deductible on {r.cardHighDeductible}</span>}
                            </>
                          ) : <span className="text-slate-400">–</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          {r.answer ? <span className="font-semibold text-slate-900 dark:text-slate-50">{answerText(r.answer)}</span> : <span className="text-xs text-amber-700 dark:text-amber-300">not answered</span>}
                          {r.answer?.note && <span className="block text-xs text-slate-500">{r.answer.note}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right"><Btn size="sm" variant={r.answer ? "ghost" : "secondary"} onClick={() => setEdit(r)}><Pencil size={13} /> {r.answer ? "Change" : "Answer"}</Btn></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
          {d.rows.length < d.total && <p className="text-xs text-slate-500">Showing the {d.rows.length} plans seen most; search to find others.</p>}
        </>
      )}
      {edit && <PlanDialog row={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function PlanDialog({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const first: Answer = row?.answer?.answer ?? (row?.suggestion?.kind as Answer | undefined) ?? "copay";
  const [answer, setAnswer] = useState<Answer>(first);
  const [copay, setCopay] = useState(row?.answer?.copayCents != null ? String(row.answer.copayCents / 100) : row?.suggestion?.cents ? String(row.suggestion.cents / 100) : "");
  const [pct, setPct] = useState(row?.answer?.coinsurancePct ? String(row.answer.coinsurancePct) : "20");
  const [note, setNote] = useState(row?.answer?.note ?? "");
  const [payer, setPayer] = useState(row?.payer ?? "");
  const [plan, setPlan] = useState(row?.plan ?? "");
  const [group, setGroup] = useState(row?.group ?? "");
  const done = () => { void utils.masterBilling.planCopays.invalidate(); onClose(); };
  const save = trpc.masterBilling.savePlanCopay.useMutation({ onSuccess: () => { toast.success("Saved"); done(); }, onError: (e) => toast.error(e.message) });
  const remove = trpc.masterBilling.removePlanCopay.useMutation({ onSuccess: () => { toast.success("Answer removed"); done(); }, onError: (e) => toast.error(e.message) });
  const cents = Math.round(Number(copay) * 100);
  const ok = answer === "copay" ? copay.trim() !== "" && Number.isFinite(cents) && cents >= 0 && cents <= 50_000 : answer === "coinsurance" ? Number(pct) >= 1 && Number(pct) <= 99 : true;
  const submit = () => save.mutate({
    key: row?.key ?? null, payerName: row ? null : payer, planName: row ? null : plan || null, groupNumber: row ? null : group || null,
    answer, copayCents: answer === "copay" ? cents : null, coinsurancePct: answer === "coinsurance" ? Math.round(Number(pct)) : null, note: note || null,
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{row ? [row.payer, row.plan].filter(Boolean).join(" · ") || "Plan" : "Add a plan"}</DialogTitle>
          <DialogDescription>{row ? (row.group ? `Group ${row.group}. ` : "") + "What does an office visit cost a patient on this plan?" : "Type the insurance and, if you know them, the plan name and group number as printed on the card."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {!row && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block sm:col-span-2"><span className="mb-1 block font-medium">Insurance</span><input className={inputCls} value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="e.g. Blue Cross Blue Shield of Texas" maxLength={160} /></label>
              <label className="block"><span className="mb-1 block font-medium">Plan name <span className="font-normal text-slate-400">(optional)</span></span><input className={inputCls} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="e.g. Blue Choice PPO" maxLength={160} /></label>
              <label className="block"><span className="mb-1 block font-medium">Group number <span className="font-normal text-slate-400">(optional)</span></span><input className={inputCls} value={group} onChange={(e) => setGroup(e.target.value)} maxLength={60} /></label>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(ANSWER_LABELS) as Answer[]).map((a) => (
              <button key={a} type="button" onClick={() => setAnswer(a)} className={cn("rounded-lg border px-3 py-2 text-left text-sm font-medium", answer === a ? "border-brand bg-brand/5" : "border-slate-200 dark:border-slate-700")}>{ANSWER_LABELS[a]}</button>
            ))}
          </div>
          {answer === "copay" && <label className="block"><span className="mb-1 block font-medium">Office visit copay ($)</span><input className={inputCls} inputMode="decimal" value={copay} onChange={(e) => setCopay(e.target.value.replace(/[^\d.]/g, ""))} placeholder="25" /></label>}
          {answer === "coinsurance" && <label className="block"><span className="mb-1 block font-medium">Patient pays (%)</span><input className={inputCls} inputMode="numeric" value={pct} onChange={(e) => setPct(e.target.value.replace(/\D/g, ""))} /></label>}
          {answer === "deductible" && <p className="text-xs text-slate-500">Staff will be told the patient pays the full visit (about what this insurance usually allows) until their deductible is met.</p>}
          <label className="block"><span className="mb-1 block font-medium">Note <span className="font-normal text-slate-400">(optional, only you see it)</span></span><input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} placeholder="e.g. confirmed with the insurance on 11/17" /></label>
          <div className="flex items-center justify-between gap-2 pt-1">
            {row?.answer ? <Btn variant="ghost" size="sm" disabled={remove.isPending} onClick={() => remove.mutate({ key: row.key })}><Trash2 size={13} /> Remove answer</Btn> : <span />}
            <div className="flex gap-2">
              <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
              <Btn disabled={!ok || save.isPending || (!row && !payer.trim())} onClick={submit}>{save.isPending ? "Saving…" : "Save"}</Btn>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
