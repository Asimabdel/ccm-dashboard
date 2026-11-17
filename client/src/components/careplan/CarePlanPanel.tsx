import { useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowDown, ArrowUp, BadgeCheck, CalendarClock, ClipboardCheck, Copy, FilePlus2, HeartHandshake, Loader2, PenLine, Pencil,
  Plus, Save, Search, Trash2, X,
} from "lucide-react";
import { Btn, EmptyState, ErrorNote, Loading, cardCls, fmtShortDate } from "@/components/workspace/ui";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { GENERAL_LABELS, PLAN_FIELD_LABELS, PLAN_LIST_FIELDS, emptyProblem, renderPlanText, renderProblemText, type PlanGeneral, type PlanProblem } from "@shared/carePlanDoc";
import { GOAL_STATUS_LABELS, goalIdOf, planChanges, problemIdOf, type GoalProgress } from "@shared/carePlanProgress";
import { LIBRARY_ITEMS, itemLabel } from "@shared/conditionLibrary";
import { localDateStr } from "@shared/workforce";
import { Bullets, TextField } from "./Fields";
import { ChangesPanel, GoalLine, ListEditor, PlanActions, copyText } from "./planBits";
import { PLAN_STATUS } from "./status";

type Data = RouterOutputs["workspace"]["carePlans"]["get"];
type Plan = { problems: PlanProblem[]; general: PlanGeneral };
const usDob = (ymd: string | null) => (ymd ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}` : "");

/**
 * A roster patient's comprehensive CCM care plan (Patient 360 → Care plan): start it from the condition
 * templates, individualize it, have a provider sign it; see how each goal is going on the monthly calls;
 * copy it, download or file it as a PDF, print the patient's copy.
 */
export function CarePlanPanel({ patientId }: { patientId: number }) {
  const q = trpc.workspace.carePlans.get.useQuery({ patientId });
  const utils = trpc.useUtils();
  const build = trpc.workspace.carePlans.build.useMutation();
  const save = trpc.workspace.carePlans.save.useMutation();
  const sign = trpc.workspace.carePlans.sign.useMutation();
  const [editing, setEditing] = useState<Plan | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [signAsk, setSignAsk] = useState(false);

  const set = (d: Data) => utils.workspace.carePlans.get.setData({ patientId }, d);
  const refreshLists = () => { void utils.workspace.carePlans.queue.invalidate(); void utils.workspace.carePlans.forCall.invalidate(); };
  const d = q.data;
  const plan = d?.plan ?? null;
  const progress = (d?.progress ?? {}) as Record<string, GoalProgress>;
  const changes = useMemo(() => (d?.lastSigned && plan ? planChanges(d.lastSigned.plan, { problems: plan.problems, general: plan.general }) : null), [d, plan]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote message={q.error.message} />;
  if (!d) return null;

  const doBuild = async () => {
    try { set(await build.mutateAsync({ patientId })); refreshLists(); toast.success("Care plan started from the condition templates. Their provider signs it."); }
    catch (e) { toast.error((e as Error).message); }
  };
  const doSave = async (next: Plan) => {
    if (!plan) return false;
    try { set(await save.mutateAsync({ patientId, version: plan.version, plan: next })); refreshLists(); return true; }
    catch (e) { toast.error((e as Error).message); return false; }
  };
  const doSign = async () => {
    if (!plan) return;
    try { set(await sign.mutateAsync({ patientId, version: plan.version })); refreshLists(); setSignAsk(false); toast.success("Care plan signed."); }
    catch (e) { toast.error((e as Error).message); }
  };
  /** A condition on the patient's record (or any condition from the library) added as a new section. */
  const addSection = async (key: string, diagnosis: string, label: string) => {
    if (!plan) return;
    setAdding(key);
    try {
      const section = await utils.workspace.carePlans.template.fetch({ key, diagnosis });
      const base = editing ?? { problems: plan.problems, general: plan.general };
      const next = { ...base, problems: [...base.problems, section] };
      if (editing) setEditing(next);
      else if (await doSave(next)) toast.success(`${label} added to the plan. A provider signs the new version.`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setAdding(null); }
  };

  if (!plan) {
    return (
      <div className={cn(cardCls, "p-6")}>
        <EmptyState icon={ClipboardCheck} title="No care plan yet"
          body={d.conditions.length
            ? <>The plan is built from the condition templates for: {d.conditions.map((c) => c.label).join(", ")}. You can change anything before the provider signs it.</>
            : "There are no chronic conditions on this patient's record yet. Add them on the CCM record first."}
          action={d.conditions.length ? <Btn disabled={build.isPending} onClick={doBuild}>{build.isPending ? <Loader2 size={15} className="animate-spin" /> : <FilePlus2 size={15} />} Start the care plan</Btn> : undefined} />
      </div>
    );
  }

  const who = { patientName: d.patient.name, dob: usDob(d.patient.dob) || null, signedBy: plan.status === "signed" ? plan.signedByName : null, signedAt: plan.status === "signed" ? plan.signedAt : null };
  const copyPlan = () => void copyText(renderPlanText({ problems: plan.problems, general: plan.general }, who), "The care plan");
  const copyGoals = () => {
    const out = [`CARE PLAN GOALS: ${d.patient.name}${who.dob ? ` (DOB ${who.dob})` : ""}`];
    plan.problems.forEach((p, i) => {
      out.push("", `${i + 1}. ${p.problem || p.diagnosis}`);
      for (const g of p.goals.filter((x) => x.trim())) {
        const l = progress[goalIdOf(problemIdOf(p), g)]?.latest;
        out.push(`   • ${g}${l ? ` | ${GOAL_STATUS_LABELS[l.status]}${l.value ? ` (${l.value})` : ""}, ${fmtShortDate(l.at)}` : " | not checked yet"}`);
      }
    });
    void copyText(out.join("\n"), "The goals");
  };

  const missing = d.conditions.filter((c) => !c.onPlan);
  const st = PLAN_STATUS[plan.status]!;
  const today = localDateStr();
  const due = d.reviewDue;
  const dueSoon = due && due <= addMonths(today, 1);
  const s = d.summary;
  const thisMonth = today.slice(0, 7);

  return (
    <div className="space-y-4">
      {/* Where the plan stands */}
      <div className={cn(cardCls, "p-4")}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-[16rem] flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", st.cls)}>{st.label}</span>
              <span className="text-xs text-slate-500">Version {plan.version}</span>
              {due && (
                <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", due < today ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-200" : dueSoon ? "bg-amber-50 text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")}>
                  <CalendarClock size={12} /> {due < today ? `Yearly review overdue (${fmtShortDate(due)})` : `Yearly review due ${fmtShortDate(due)}`}
                </span>
              )}
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {plan.signedByName ? <><PenLine size={13} className="mr-1 inline" />Signed v{plan.signedVersion} by <b className="font-semibold">{plan.signedByName}</b> on {fmtShortDate(plan.signedAt)}</> : "Not signed yet"}
              <span className="text-slate-400"> · </span>
              {plan.lastReviewedAt ? <>Reviewed with the patient {fmtShortDate(plan.lastReviewedAt)}{plan.lastReviewedMonth === thisMonth ? <span className="ml-1 font-medium text-emerald-700 dark:text-emerald-300">(this month)</span> : null}</> : "Not reviewed with the patient on a call yet"}
            </p>
            <p className="text-xs text-slate-500">
              {d.patient.providerName ? <>Provider: {d.patient.providerName}</> : "No provider on file"}{d.patient.coordinatorName ? <> · Care coordinator: {d.patient.coordinatorName}</> : null}
            </p>
          </div>
          {!editing && (
            <div className="flex flex-wrap gap-2">
              <PlanActions patientId={patientId} language={d.patient.language} onCopyPlan={copyPlan} onCopyGoals={copyGoals} />
              <Btn variant="secondary" size="sm" onClick={() => setEditing({ problems: structuredClone(plan.problems), general: { ...plan.general } })}><Pencil size={14} /> Edit</Btn>
              {d.canSign && plan.status !== "signed" && (
                <Btn size="sm" disabled={sign.isPending || d.gaps.length > 0} title={d.gaps.length ? "Finish the plan first" : undefined} onClick={() => setSignAsk(true)}>
                  <BadgeCheck size={14} /> Sign plan
                </Btn>
              )}
            </div>
          )}
        </div>
        {s && s.total > 0 && <GoalSummary s={s} />}
      </div>

      {!d.canSign && plan.status !== "signed" && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">A provider reviews and signs the plan{d.patient.providerName ? ` (their provider: ${d.patient.providerName})` : ""}. It shows on their Care plans → To sign list.</p>}
      {d.gaps.length > 0 && !editing && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle size={14} /> Before it can be signed:</p>
          <ul className="mt-1 list-disc ps-5">{d.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
        </div>
      )}
      {!editing && changes && d.lastSigned && <ChangesPanel changes={changes} signedByName={d.lastSigned.signedByName} signedAt={d.lastSigned.signedAt} version={d.lastSigned.version} />}
      {missing.length > 0 && (
        <div className={cn(cardCls, "flex flex-wrap items-center gap-2 p-3 text-sm")}>
          <span className="text-slate-600 dark:text-slate-300">On the patient's record but not on the plan:</span>
          {missing.map((c) => (
            <Btn key={c.key} size="sm" variant="secondary" disabled={!!adding || save.isPending} onClick={() => addSection(c.key, c.diagnosis, c.label)}>
              {adding === c.key ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {c.label}
            </Btn>
          ))}
        </div>
      )}

      {editing
        ? <PlanEditor plan={editing} onChange={setEditing} onAdd={addSection} adding={adding} />
        : <PlanView plan={plan} progress={progress} patientName={d.patient.name} />}

      {editing && (
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
          <p className="flex-1 text-sm text-slate-600 dark:text-slate-300">Editing the plan.{plan.status === "signed" ? " Saving makes a new version for the provider to sign." : ""}</p>
          <Btn variant="secondary" size="sm" onClick={() => setEditing(null)}><X size={14} /> Cancel</Btn>
          <Btn size="sm" disabled={save.isPending} onClick={async () => { if (await doSave(editing)) { setEditing(null); toast.success(plan.status === "none" ? "Saved." : "Saved. A provider signs the new version."); } }}>
            {save.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save changes
          </Btn>
        </div>
      )}

      {d.signatures.length > 1 && (
        <p className="text-xs text-slate-500">Earlier signatures: {d.signatures.slice(1).map((x) => `v${x.version} by ${x.signedByName} (${fmtShortDate(x.signedAt)})`).join(" · ")}</p>
      )}
      <p className="text-xs text-slate-500">Templates come from the <Link href="/care-plans?tab=library" className="underline">condition library</Link>. Edits here change only this patient's plan.</p>

      <Dialog open={signAsk} onOpenChange={setSignAsk}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign this care plan?</DialogTitle>
            <DialogDescription>
              You're confirming you reviewed and established this plan for {d.patient.name}: {plan.problems.length} problem{plan.problems.length === 1 ? "" : "s"}, version {plan.version}
              {changes && (changes.sections.length + changes.general.length) > 0 ? `, with ${changes.sections.length + changes.general.length} change${changes.sections.length + changes.general.length === 1 ? "" : "s"} since the last signature (listed on the plan)` : ""}. Your name and the time are recorded.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Btn variant="secondary" onClick={() => setSignAsk(false)}>Not yet</Btn>
            <Btn disabled={sign.isPending} onClick={doSign}>{sign.isPending ? <Loader2 size={15} className="animate-spin" /> : <BadgeCheck size={15} />} Sign plan</Btn>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function addMonths(ymd: string, n: number) {
  const d = new Date(`${ymd}T12:00:00`);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** "5 on track · 1 met · 2 not yet · 3 not checked", with a bar. */
function GoalSummary({ s }: { s: NonNullable<Data["summary"]> }) {
  const unchecked = s.total - s.checked;
  const seg = (n: number, cls: string, label: string) => n > 0 && <span className={cls} style={{ width: `${(n / s.total) * 100}%` }} title={`${n} ${label}`} />;
  return (
    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold text-slate-700 dark:text-slate-200">Goals ({s.total})</span>
        {s.onTrack > 0 && <span className="text-emerald-700 dark:text-emerald-300">{s.onTrack} on track</span>}
        {s.met > 0 && <span className="text-teal-700 dark:text-teal-300">{s.met} met</span>}
        {s.notYet > 0 && <span className="text-amber-700 dark:text-amber-300">{s.notYet} not yet</span>}
        {unchecked > 0 && <span className="text-slate-500">{unchecked} not checked on a call yet</span>}
        {s.flagged > 0 && <span className="inline-flex items-center gap-1 font-semibold text-amber-800 dark:text-amber-200"><AlertTriangle size={12} /> {s.flagged} to bring to the provider</span>}
      </div>
      <div className="mt-1.5 flex h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        {seg(s.onTrack, "bg-emerald-500", "on track")}{seg(s.met, "bg-teal-600", "met")}{seg(s.notYet, "bg-amber-500", "not yet")}
      </div>
    </div>
  );
}

/** "Type assumed" / "confirm the type" notes for the reviewing provider. */
function SectionFlags({ p }: { p: PlanProblem }) {
  if (p.assumed) return <p className="mt-1 inline-flex rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">Type assumed: the record doesn't say which type, so this uses {p.key ? itemLabel(p.key) : "the most common type"}. Confirm or edit.</p>;
  if (p.confirmType) return <p className="mt-1 inline-flex rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">General plan: the type isn't documented. Confirm the type (and update the diagnosis) for a specialized plan.</p>;
  return null;
}

const OTHER_FIELDS = PLAN_LIST_FIELDS.filter((f) => f !== "goals");

function PlanView({ plan, progress, patientName }: { plan: Plan; progress: Record<string, GoalProgress>; patientName: string }) {
  const jump = (i: number) => document.getElementById(`plan-sec-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <>
      {plan.problems.length > 2 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-semibold text-slate-500">Jump to:</span>
          {plan.problems.map((p, i) => (
            <button key={i} type="button" onClick={() => jump(i)} className="rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-700 hover:border-teal-300 hover:text-teal-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
              {i + 1}. {p.problem || p.diagnosis}
            </button>
          ))}
        </div>
      )}
      {plan.general.patientGoals?.trim() && (
        <section className="rounded-xl border border-teal-200 bg-teal-50/60 p-4 dark:border-teal-500/30 dark:bg-teal-500/5">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-teal-800 dark:text-teal-200"><HeartHandshake size={14} /> {GENERAL_LABELS.patientGoals}</p>
          <p className="mt-1 whitespace-pre-line text-[15px] text-slate-800 dark:text-slate-100">{plan.general.patientGoals}</p>
        </section>
      )}
      {plan.problems.map((p, i) => {
        const pid = problemIdOf(p);
        const goals = p.goals.filter((g) => g.trim());
        return (
          <section key={i} id={`plan-sec-${i}`} className={cn(cardCls, "scroll-mt-24 overflow-hidden")}>
            <div className="flex items-start gap-3 border-b border-slate-100 px-5 pb-3 pt-4 dark:border-slate-800">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-teal-50 text-sm font-bold text-teal-800 dark:bg-teal-500/10 dark:text-teal-200">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{p.kind === "addon" ? "Add-on: complication or combination" : "Condition"}{p.key ? ` · ${itemLabel(p.key)}` : ""}</p>
                <h3 className="text-lg font-bold leading-snug text-slate-900 dark:text-slate-50">{p.problem || p.diagnosis}</h3>
                {p.diagnosis && p.diagnosis !== p.problem && <p className="text-sm text-slate-500">{p.diagnosis}</p>}
                <SectionFlags p={p} />
              </div>
              <button type="button" title="Copy this section" aria-label="Copy this section" onClick={() => void copyText([`Patient: ${patientName}`, ...renderProblemText(p, i + 1)].join("\n"), "This section")}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"><Copy size={15} /></button>
            </div>
            <div className="space-y-4 px-5 py-4">
              {p.expectedOutcome && <p className="text-sm text-slate-700 dark:text-slate-200"><b className="font-semibold">{PLAN_FIELD_LABELS.expectedOutcome}:</b> {p.expectedOutcome}</p>}
              {goals.length > 0 && (
                <div>
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{PLAN_FIELD_LABELS.goals}</p>
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">{goals.map((g, j) => <GoalLine key={j} goal={g} progress={progress[goalIdOf(pid, g)]} />)}</ul>
                </div>
              )}
              <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                {OTHER_FIELDS.map((f) => p[f].length > 0 && <div key={f}><p className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{PLAN_FIELD_LABELS[f]}</p><Bullets items={p[f]} /></div>)}
              </div>
              {p.templateVersion == null && <p className="text-xs text-amber-700">Written by hand (no condition template was used).</p>}
            </div>
          </section>
        );
      })}
      <section className={cn(cardCls, "p-5")}>
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">The whole plan</p>
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {(Object.keys(GENERAL_LABELS) as (keyof PlanGeneral)[]).filter((k) => k !== "patientGoals").map((k) => (
            <div key={k}><p className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{GENERAL_LABELS[k]}</p><p className="whitespace-pre-line text-sm text-slate-700 dark:text-slate-200">{plan.general[k] || <span className="text-slate-400">Not filled in</span>}</p></div>
          ))}
          {!plan.general.patientGoals?.trim() && <div><p className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{GENERAL_LABELS.patientGoals}</p><p className="text-sm text-slate-400">Not filled in yet. Ask the patient what matters most to them, in their words.</p></div>}
        </div>
      </section>
    </>
  );
}

function PlanEditor({ plan, onChange, onAdd, adding }: { plan: Plan; onChange: (p: Plan) => void; onAdd: (key: string, diagnosis: string, label: string) => void; adding: string | null }) {
  const [removing, setRemoving] = useState<number | null>(null);
  const setProblem = (i: number, patch: Partial<PlanProblem>) => onChange({ ...plan, problems: plan.problems.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const move = (i: number, by: -1 | 1) => { const j = i + by; if (j < 0 || j >= plan.problems.length) return; const next = [...plan.problems]; [next[i], next[j]] = [next[j]!, next[i]!]; onChange({ ...plan, problems: next }); };
  return (
    <>
      <section className={cn(cardCls, "space-y-3 p-5")}>
        <TextField label={GENERAL_LABELS.patientGoals} value={plan.general.patientGoals} rows={2}
          placeholder={"In the patient's words: e.g. \"I want to keep walking with my grandkids\""}
          onChange={(v) => onChange({ ...plan, general: { ...plan.general, patientGoals: v } })} />
      </section>
      {plan.problems.map((p, i) => (
        <section key={`${i}|${p.key ?? ""}|${p.diagnosis}`} className={cn(cardCls, "space-y-4 p-5")}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-teal-50 text-sm font-bold text-teal-800 dark:bg-teal-500/10 dark:text-teal-200">{i + 1}</span>
            <p className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider text-slate-400">{p.kind === "addon" ? "Add-on" : "Condition"}{p.key ? ` · ${itemLabel(p.key)}` : ""}{p.diagnosis ? ` · ${p.diagnosis}` : ""}</p>
            <Btn size="sm" variant="ghost" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></Btn>
            <Btn size="sm" variant="ghost" title="Move down" disabled={i === plan.problems.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></Btn>
            {removing === i ? (
              <span className="flex items-center gap-1.5 text-xs">
                Remove this section?
                <Btn size="sm" variant="danger" onClick={() => { onChange({ ...plan, problems: plan.problems.filter((_, j) => j !== i) }); setRemoving(null); }}>Remove</Btn>
                <Btn size="sm" variant="secondary" onClick={() => setRemoving(null)}>Keep</Btn>
              </span>
            ) : <Btn size="sm" variant="ghost" onClick={() => setRemoving(i)}><Trash2 size={14} /> Remove</Btn>}
          </div>
          <TextField label="Problem" value={p.problem} rows={1} onChange={(v) => setProblem(i, { problem: v })} />
          <TextField label={PLAN_FIELD_LABELS.expectedOutcome} value={p.expectedOutcome} onChange={(v) => setProblem(i, { expectedOutcome: v })} />
          <ListEditor label={PLAN_FIELD_LABELS.goals} value={p.goals} placeholder="A goal you can measure, e.g. Blood pressure below 130/80" onChange={(v) => setProblem(i, { goals: v })} />
          <p className="-mt-2 text-xs text-slate-500">Changing a goal's wording starts a new progress history for it on the calls.</p>
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            {OTHER_FIELDS.map((f) => <ListEditor key={f} label={PLAN_FIELD_LABELS[f]} value={p[f]} onChange={(v) => setProblem(i, { [f]: v } as Partial<PlanProblem>)} />)}
          </div>
        </section>
      ))}
      <div className="flex flex-wrap gap-2">
        <AddSection plan={plan} onAdd={onAdd} adding={adding} />
        <Btn variant="secondary" size="sm" onClick={() => onChange({ ...plan, problems: [...plan.problems, emptyProblem(null, "", "")] })}><Pencil size={14} /> Write a section by hand</Btn>
      </div>
      <section className={cn(cardCls, "space-y-3 p-5")}>
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">The whole plan</p>
        {(Object.keys(GENERAL_LABELS) as (keyof PlanGeneral)[]).filter((k) => k !== "patientGoals").map((k) => (
          <TextField key={k} label={GENERAL_LABELS[k]} value={plan.general[k]} rows={3} onChange={(v) => onChange({ ...plan, general: { ...plan.general, [k]: v } })} />
        ))}
      </section>
    </>
  );
}

/** Add a section for any condition in the library (its template), searched by name. */
function AddSection({ plan, onAdd, adding }: { plan: Plan; onAdd: (key: string, diagnosis: string, label: string) => void; adding: string | null }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const on = new Set(plan.problems.map((p) => p.key).filter(Boolean));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const items = LIBRARY_ITEMS.filter((x) => !on.has(x.key) && words.every((w) => x.label.toLowerCase().includes(w))).slice(0, 40);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Btn variant="secondary" size="sm">{adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add a condition from the library</Btn></PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2">
        <div className="relative mb-2">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conditions" aria-label="Search conditions"
            className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-8 pr-2 text-sm focus:border-teal-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900" />
        </div>
        <div className="max-h-72 overflow-y-auto">
          {items.length === 0 && <p className="px-2 py-3 text-sm text-slate-500">Nothing matches.</p>}
          {items.map((x) => (
            <button key={x.key} type="button" onClick={() => { setOpen(false); setQ(""); onAdd(x.key, x.label, x.label); }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-slate-800 hover:bg-teal-50 dark:text-slate-100 dark:hover:bg-teal-500/10">
              <span className="flex-1">{x.label}</span>
              {x.kind === "addon" && <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">Add-on</span>}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
