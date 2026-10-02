import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { AlertTriangle, BadgeCheck, ClipboardCheck, FilePlus2, Loader2, PenLine, Pencil, Plus, Printer, Save, Trash2, X } from "lucide-react";
import { Btn, EmptyState, ErrorNote, Loading, cardCls, fmtShortDate } from "@/components/workspace/ui";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { GENERAL_LABELS, PLAN_FIELD_LABELS, PLAN_LIST_FIELDS, emptyProblem, type PlanGeneral, type PlanProblem } from "@shared/carePlanDoc";
import { Bullets, LinesField, TextField } from "./Fields";
import { PLAN_STATUS } from "./status";

type Data = RouterOutputs["workspace"]["carePlans"]["get"];
type Plan = { problems: PlanProblem[]; general: PlanGeneral };

/**
 * A roster patient's comprehensive CCM care plan (Patient 360 → Care plan): start it from the
 * approved condition templates, individualize it, have a provider sign it, print the patient's copy.
 */
export function CarePlanPanel({ patientId }: { patientId: number }) {
  const q = trpc.workspace.carePlans.get.useQuery({ patientId });
  const utils = trpc.useUtils();
  const build = trpc.workspace.carePlans.build.useMutation();
  const save = trpc.workspace.carePlans.save.useMutation();
  const sign = trpc.workspace.carePlans.sign.useMutation();
  const [editing, setEditing] = useState<Plan | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const set = (d: Data) => utils.workspace.carePlans.get.setData({ patientId }, d);
  const refreshLists = () => { void utils.workspace.carePlans.queue.invalidate(); void utils.workspace.carePlans.forCall.invalidate(); };

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote message={q.error.message} />;
  const d = q.data!;
  const plan = d.plan;

  const doBuild = async () => {
    try { set(await build.mutateAsync({ patientId })); refreshLists(); toast.success("Draft started from the approved templates. Review it, then a provider signs it."); }
    catch (e) { toast.error((e as Error).message); }
  };
  const doSave = async (next: Plan) => {
    if (!plan) return false;
    try { set(await save.mutateAsync({ patientId, version: plan.version, plan: next })); refreshLists(); return true; }
    catch (e) { toast.error((e as Error).message); return false; }
  };
  const doSign = async () => {
    if (!plan) return;
    if (!window.confirm("Sign this care plan? You're confirming you reviewed and established it for this patient. Your name and the time are recorded.")) return;
    try { set(await sign.mutateAsync({ patientId, version: plan.version })); refreshLists(); toast.success("Care plan signed."); }
    catch (e) { toast.error((e as Error).message); }
  };
  /** A condition on the patient's record that isn't on the plan yet: add its approved section. */
  const addCondition = async (c: Data["conditions"][number]) => {
    if (!plan) return;
    setAdding(c.key);
    try {
      const section = await utils.workspace.carePlans.template.fetch({ key: c.key, diagnosis: c.diagnosis });
      const base = editing ?? { problems: plan.problems, general: plan.general };
      const next = { ...base, problems: [...base.problems, section] };
      if (editing) setEditing(next);
      else if (await doSave(next)) toast.success(`${c.label} added to the plan.`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setAdding(null); }
  };

  if (!plan) {
    return (
      <div className={cn(cardCls, "p-6")}>
        <EmptyState icon={ClipboardCheck} title="No care plan yet"
          body={d.conditions.length
            ? <>The draft starts from the approved templates for: {d.conditions.map((c) => c.label).join(", ")}.{d.conditions.some((c) => !c.templateApproved) && <> Conditions whose template isn't approved yet start empty.</>}</>
            : "There are no chronic conditions on this patient's record yet. Add them on the CCM record first."}
          action={d.conditions.length ? <Btn disabled={build.isPending} onClick={doBuild}>{build.isPending ? <Loader2 size={15} className="animate-spin" /> : <FilePlus2 size={15} />} Start the care plan</Btn> : undefined} />
      </div>
    );
  }

  const missing = d.conditions.filter((c) => !c.onPlan);
  const st = PLAN_STATUS[plan.status]!;
  return (
    <div className="space-y-4">
      <div className={cn(cardCls, "flex flex-wrap items-center gap-3 p-4")}>
        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", st.cls)}>{st.label}</span>
        <span className="text-sm text-slate-500">
          {plan.signedByName ? <><PenLine size={13} className="mr-1 inline" />Signed v{plan.signedVersion} by {plan.signedByName} on {fmtShortDate(plan.signedAt)}</> : "Not signed yet"}
          {" · "}{plan.lastReviewedAt ? `Last reviewed with the patient ${fmtShortDate(plan.lastReviewedAt)}` : "Not reviewed with the patient yet"}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {!editing && <a href={`/care-plans/${patientId}/print`} target="_blank" rel="noreferrer"><Btn variant="secondary" size="sm"><Printer size={14} /> Patient copy</Btn></a>}
          {!editing && <Btn variant="secondary" size="sm" onClick={() => setEditing({ problems: structuredClone(plan.problems), general: { ...plan.general } })}><Pencil size={14} /> Edit</Btn>}
          {!editing && d.canSign && plan.status !== "signed" && <Btn size="sm" disabled={sign.isPending || d.gaps.length > 0} title={d.gaps.length ? "Finish the plan first" : undefined} onClick={doSign}>{sign.isPending ? <Loader2 size={14} className="animate-spin" /> : <BadgeCheck size={14} />} Sign plan</Btn>}
          {editing && <Btn variant="secondary" size="sm" onClick={() => setEditing(null)}><X size={14} /> Cancel</Btn>}
          {editing && <Btn size="sm" disabled={save.isPending} onClick={async () => { if (await doSave(editing)) { setEditing(null); toast.success(plan.status === "none" ? "Saved." : "Saved. A provider signs the new version."); } }}>{save.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save</Btn>}
        </div>
      </div>

      {!d.canSign && plan.status !== "signed" && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">A provider reviews and signs the plan{d.patient.providerName ? ` (their provider: ${d.patient.providerName})` : ""}. It shows on their Care plans → To sign list.</p>}
      {d.gaps.length > 0 && !editing && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle size={14} /> Before it can be signed:</p>
          <ul className="mt-1 list-disc ps-5">{d.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
        </div>
      )}
      {missing.length > 0 && (
        <div className={cn(cardCls, "flex flex-wrap items-center gap-2 p-3 text-sm")}>
          <span className="text-slate-600 dark:text-slate-300">On the patient's record but not on the plan:</span>
          {missing.map((c) => (
            <Btn key={c.key} size="sm" variant="secondary" disabled={!!adding || save.isPending} onClick={() => addCondition(c)}>
              {adding === c.key ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {c.label}
            </Btn>
          ))}
        </div>
      )}

      {editing ? <PlanEditor plan={editing} onChange={setEditing} /> : <PlanView plan={plan} />}

      {d.signatures.length > 1 && (
        <p className="text-xs text-slate-500">Earlier signatures: {d.signatures.slice(1).map((s) => `v${s.version} by ${s.signedByName} (${fmtShortDate(s.signedAt)})`).join(" · ")}</p>
      )}
      <p className="text-xs text-slate-500">Templates come from the <Link href="/care-plans?tab=library" className="underline">condition library</Link>. Edits here change only this patient's plan.</p>
    </div>
  );
}

function PlanView({ plan }: { plan: Plan }) {
  return (
    <>
      {plan.problems.map((p, i) => (
        <section key={i} className={cn(cardCls, "p-5")}>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Problem {i + 1}</p>
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-50">{p.problem || p.diagnosis}</h3>
          {p.diagnosis && p.diagnosis !== p.problem && <p className="text-sm text-slate-500">{p.diagnosis}</p>}
          {p.expectedOutcome && <p className="mt-2 text-sm text-slate-700 dark:text-slate-200"><b>{PLAN_FIELD_LABELS.expectedOutcome}:</b> {p.expectedOutcome}</p>}
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {PLAN_LIST_FIELDS.map((f) => p[f].length > 0 && <div key={f}><p className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{PLAN_FIELD_LABELS[f]}</p><Bullets items={p[f]} /></div>)}
          </div>
          {p.templateVersion == null && <p className="mt-3 text-xs text-amber-700">Written by hand (no approved template was used).</p>}
        </section>
      ))}
      <section className={cn(cardCls, "p-5")}>
        <div className="grid gap-4 sm:grid-cols-2">
          {(Object.keys(GENERAL_LABELS) as (keyof PlanGeneral)[]).map((k) => (
            <div key={k}><p className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{GENERAL_LABELS[k]}</p><p className="whitespace-pre-line text-sm text-slate-700 dark:text-slate-200">{plan.general[k] || <span className="text-slate-400">Not filled in</span>}</p></div>
          ))}
        </div>
      </section>
    </>
  );
}

function PlanEditor({ plan, onChange }: { plan: Plan; onChange: (p: Plan) => void }) {
  const setProblem = (i: number, patch: Partial<PlanProblem>) => onChange({ ...plan, problems: plan.problems.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  return (
    <>
      {plan.problems.map((p, i) => (
        <section key={`${i}|${p.key ?? ""}|${p.diagnosis}`} className={cn(cardCls, "space-y-3 p-5")}>
          <div className="flex items-center gap-2">
            <p className="flex-1 text-xs font-semibold uppercase tracking-wider text-slate-400">Problem {i + 1}{p.diagnosis ? ` · ${p.diagnosis}` : ""}</p>
            <Btn size="sm" variant="ghost" onClick={() => { if (window.confirm(`Remove "${p.problem || p.diagnosis}" from the plan?`)) onChange({ ...plan, problems: plan.problems.filter((_, j) => j !== i) }); }}><Trash2 size={14} /> Remove</Btn>
          </div>
          <TextField label="Problem" value={p.problem} rows={1} onChange={(v) => setProblem(i, { problem: v })} />
          <TextField label={PLAN_FIELD_LABELS.expectedOutcome} value={p.expectedOutcome} onChange={(v) => setProblem(i, { expectedOutcome: v })} />
          <div className="grid gap-3 sm:grid-cols-2">
            {PLAN_LIST_FIELDS.map((f) => <LinesField key={f} label={PLAN_FIELD_LABELS[f]} value={p[f]} onChange={(v) => setProblem(i, { [f]: v } as Partial<PlanProblem>)} />)}
          </div>
        </section>
      ))}
      <Btn variant="secondary" size="sm" onClick={() => onChange({ ...plan, problems: [...plan.problems, emptyProblem(null, "", "")] })}><Plus size={14} /> Add a problem by hand</Btn>
      <section className={cn(cardCls, "space-y-3 p-5")}>
        {(Object.keys(GENERAL_LABELS) as (keyof PlanGeneral)[]).map((k) => (
          <TextField key={k} label={GENERAL_LABELS[k]} value={plan.general[k]} rows={k === "patientGoals" ? 2 : 3}
            placeholder={k === "patientGoals" ? "In the patient's words: e.g. \"I want to keep walking with my grandkids\"" : undefined}
            onChange={(v) => onChange({ ...plan, general: { ...plan.general, [k]: v } })} />
        ))}
      </section>
    </>
  );
}
