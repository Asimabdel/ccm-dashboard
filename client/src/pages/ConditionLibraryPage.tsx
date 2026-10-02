import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { toast } from "sonner";
import { ArrowLeft, BadgeCheck, ExternalLink, Loader2, Pencil, Save, X } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Handout } from "@/components/education/Handout";
import { Btn, EmptyState, ErrorNote, Loading, cardCls, fmtShortDate } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { LIBRARY_LANG_LABELS, LIBRARY_LANGS, learnPath, type ConditionLibraryEntry, type EducationDoc, type LibraryLang } from "@shared/conditionLibrary";
import { PLAN_FIELD_LABELS, PLAN_LIST_FIELDS } from "@shared/carePlanDoc";
import { Bullets, LinesField, TextField } from "@/components/careplan/Fields";

const EDU_LIST_FIELDS: { key: keyof EducationDoc; label: string }[] = [
  { key: "whatYouCanDo", label: "What you can do" },
  { key: "numbers", label: "Know your numbers" },
  { key: "medicines", label: "Your medicines" },
  { key: "callUs", label: "Call us if" },
  { key: "call911", label: "Call 911 if" },
];

/** One condition in the library: read it, edit it (providers/admins), approve it (providers). */
export default function ConditionLibraryPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const { key = "" } = useParams<{ key: string }>();
  const q = trpc.workspace.library.get.useQuery({ key }, { enabled: !!user, retry: false });
  const utils = trpc.useUtils();
  const save = trpc.workspace.library.save.useMutation();
  const approve = trpc.workspace.library.approve.useMutation();
  const [editing, setEditing] = useState<ConditionLibraryEntry | null>(null);
  const [eduLang, setEduLang] = useState<LibraryLang>("en");

  useEffect(() => { setEditing(null); }, [key]);
  if (!user) return null;
  const d = q.data;

  const doSave = async () => {
    if (!editing) return;
    try {
      await save.mutateAsync({ key, entry: editing });
      toast.success("Saved. Patients, calls and new care plans use the new version.");
      setEditing(null);
      void utils.workspace.library.invalidate();
    } catch (e) { toast.error((e as Error).message); }
  };
  const doApprove = async () => {
    if (!window.confirm(`Mark "${d?.label}" as reviewed by you? Your name and the date are recorded.`)) return;
    try {
      await approve.mutateAsync({ key });
      toast.success("Marked as reviewed.");
      void utils.workspace.library.invalidate();
    } catch (e) { toast.error((e as Error).message); }
  };

  return (
    <CCMDashboardLayout title="Condition library" pageTitle={false}>
      <Link href="/care-plans?tab=library" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft size={15} /> Condition library</Link>
      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {d && (
        <>
          <div className="mb-4 flex flex-wrap items-start gap-3">
            <div className="flex-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{d.categoryLabel}{d.kind === "addon" ? " · Add-on (complication or combination)" : ""}</p>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">{d.label}</h1>
              <p className="mt-1 text-sm text-slate-500">
                {d.status === "approved"
                  ? <span className="font-semibold text-emerald-700">In use · v{d.version} reviewed by {d.approvedByName} on {fmtShortDate(d.approvedAt)}</span>
                  : <span className="font-semibold text-slate-600">In use · v{d.version}{d.history.length ? ` (edited since ${d.history[0]!.approvedByName} reviewed v${d.history[0]!.version})` : ""}</span>}
                {d.entry.basis.length > 0 && <> · Based on: {d.entry.basis.join("; ")}</>}
              </p>
            </div>
            {!editing && (
              <div className="flex flex-wrap gap-2">
                {d.status === "approved" && <a href={learnPath(key)} target="_blank" rel="noreferrer"><Btn variant="secondary" size="sm"><ExternalLink size={14} /> Patient page</Btn></a>}
                {d.canEdit && <Btn variant="secondary" size="sm" onClick={() => setEditing(structuredClone(d.entry))}><Pencil size={14} /> Edit</Btn>}
                {d.canApprove && d.status !== "approved" && <Btn size="sm" disabled={approve.isPending} onClick={doApprove}>{approve.isPending ? <Loader2 size={14} className="animate-spin" /> : <BadgeCheck size={14} />} Mark reviewed</Btn>}
              </div>
            )}
            {editing && (
              <div className="flex gap-2">
                <Btn variant="secondary" size="sm" onClick={() => setEditing(null)}><X size={14} /> Cancel</Btn>
                <Btn size="sm" disabled={save.isPending} onClick={doSave}>{save.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save</Btn>
              </div>
            )}
          </div>

          {d.status !== "approved" && d.reviewNotes.length > 0 && !editing && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
              <p className="font-semibold">Points a provider may want to check</p>
              <ul className="mt-1 list-disc space-y-0.5 ps-5">{d.reviewNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          )}
          {editing ? <Editor entry={editing} onChange={setEditing} lang={eduLang} setLang={setEduLang} /> : <View entry={d.entry} />}
        </>
      )}
      {!q.isLoading && !d && !q.error && <EmptyState title="Not found" />}
    </CCMDashboardLayout>
  );
}

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn(cardCls, "mb-4 p-5", className)}>
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-500">{title}</h2>
      {children}
    </section>
  );
}


function View({ entry }: { entry: ConditionLibraryEntry }) {
  const t = entry.carePlan;
  return (
    <>
      <Section title="Patient handout">
        <div className="grid gap-6 lg:grid-cols-2">
          {LIBRARY_LANGS.map((l) => (
            <div key={l} className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{LIBRARY_LANG_LABELS[l]}</p>
              <Handout doc={entry.education[l]} lang={l} compact />
            </div>
          ))}
        </div>
      </Section>
      <Section title="CCM call talking points (for the coordinator)">
        <div className="grid gap-4 sm:grid-cols-2">
          <div><p className="mb-1 text-sm font-semibold">Teach</p><Bullets items={entry.talkingPoints.teach} /></div>
          <div><p className="mb-1 text-sm font-semibold">Ask</p><Bullets items={entry.talkingPoints.ask} /></div>
        </div>
      </Section>
      <Section title="Care-plan template">
        <p className="font-semibold text-slate-900 dark:text-slate-50">{t.problem}</p>
        {t.expectedOutcome && <p className="mt-1 text-sm text-slate-700 dark:text-slate-200"><b>{PLAN_FIELD_LABELS.expectedOutcome}:</b> {t.expectedOutcome}</p>}
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {PLAN_LIST_FIELDS.map((f) => t[f].length > 0 && <div key={f}><p className="mb-1 text-sm font-semibold">{PLAN_FIELD_LABELS[f]}</p><Bullets items={t[f]} /></div>)}
        </div>
      </Section>
    </>
  );
}

function Editor({ entry, onChange, lang, setLang }: { entry: ConditionLibraryEntry; onChange: (e: ConditionLibraryEntry) => void; lang: LibraryLang; setLang: (l: LibraryLang) => void }) {
  const edu = entry.education[lang];
  const setEdu = (patch: Partial<EducationDoc>) => onChange({ ...entry, education: { ...entry.education, [lang]: { ...edu, ...patch } } });
  const t = entry.carePlan;
  const setT = (patch: Partial<typeof t>) => onChange({ ...entry, carePlan: { ...t, ...patch } });
  return (
    <>
      <Section title="Patient handout">
        <div className="mb-3 flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800" role="tablist">
          {LIBRARY_LANGS.map((l) => (
            <button key={l} role="tab" aria-selected={lang === l} onClick={() => setLang(l)} className={cn("rounded-lg px-3 py-1.5 text-sm font-semibold", lang === l ? "bg-white shadow-sm dark:bg-slate-700" : "text-slate-500")}>{LIBRARY_LANG_LABELS[l]}</button>
          ))}
        </div>
        <div key={lang} className="space-y-3">
          <TextField label="Title" value={edu.title} rows={1} onChange={(v) => setEdu({ title: v })} />
          <TextField label="What it is" value={edu.whatItIs} rows={3} onChange={(v) => setEdu({ whatItIs: v })} />
          <TextField label="Why it matters" value={edu.whyItMatters} rows={2} onChange={(v) => setEdu({ whyItMatters: v })} />
          {EDU_LIST_FIELDS.map((f) => <LinesField key={f.key} label={f.label} value={edu[f.key] as string[]} onChange={(v) => setEdu({ [f.key]: v } as Partial<EducationDoc>)} />)}
        </div>
      </Section>
      <Section title="CCM call talking points">
        <div className="grid gap-3 sm:grid-cols-2">
          <LinesField label="Teach" value={entry.talkingPoints.teach} onChange={(v) => onChange({ ...entry, talkingPoints: { ...entry.talkingPoints, teach: v } })} />
          <LinesField label="Ask" value={entry.talkingPoints.ask} onChange={(v) => onChange({ ...entry, talkingPoints: { ...entry.talkingPoints, ask: v } })} />
        </div>
      </Section>
      <Section title="Care-plan template">
        <div className="space-y-3">
          <TextField label="Problem" value={t.problem} rows={1} onChange={(v) => setT({ problem: v })} />
          <TextField label={PLAN_FIELD_LABELS.expectedOutcome} value={t.expectedOutcome} onChange={(v) => setT({ expectedOutcome: v })} />
          <div className="grid gap-3 sm:grid-cols-2">
            {PLAN_LIST_FIELDS.map((f) => <LinesField key={f} label={PLAN_FIELD_LABELS[f]} value={t[f]} onChange={(v) => setT({ [f]: v } as Partial<typeof t>)} />)}
          </div>
        </div>
      </Section>
      <Section title="Based on (for reviewers)">
        <LinesField label="Guidance" value={entry.basis} rows={2} onChange={(v) => onChange({ ...entry, basis: v })} />
      </Section>
    </>
  );
}
