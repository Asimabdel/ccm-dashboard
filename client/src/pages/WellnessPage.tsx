import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, BadgeCheck, ExternalLink, HeartHandshake, Loader2, Pencil, Printer, Save, X } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useUrlParams, useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, Panel, cardCls, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { WellnessHandout } from "@/components/education/WellnessHandout";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { LIBRARY_LANG_LABELS, LIBRARY_LANGS, slugOf, type LibraryLang } from "@shared/conditionLibrary";
import { WELLNESS_GROUPS, type WellnessDoc, type WellnessEntry, type WellnessGroup } from "@shared/wellness";

const STATUS: Record<"approved" | "changed" | "draft", { label: string; cls: string }> = {
  approved: { label: "Approved", cls: "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200" },
  changed: { label: "Edited · waiting", cls: "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200" },
  draft: { label: "Draft", cls: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300" },
};

/**
 * Prevention & wellness handouts (vaccines, cancer screenings, check-ups, healthy living), English and
 * Spanish. The admin reviews, edits and approves each one; patients only get approved handouts. Anyone
 * can preview an approved handout and print it as a branded flyer.
 */
export default function WellnessPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const [params, setParams] = useUrlParams();
  const list = trpc.workspace.wellness.list.useQuery(undefined, { enabled: !!user && !!ws.caps?.education });
  const admin = user?.role === "admin";
  const selected = params.get("t") ?? list.data?.[0]?.key ?? null;
  const approved = (list.data ?? []).filter((t) => t.live).length;

  return (
    <CCMDashboardLayout title="Wellness handouts" pageTitle={false}>
      <PageHeader title="Wellness handouts"
        subtitle={admin
          ? `Prevention & wellness handouts in English and Spanish. Review each one and approve it: patients only get approved handouts. ${approved} of ${list.data?.length ?? "…"} approved.`
          : "Approved prevention & wellness handouts: give them from a patient's Education tab, or print a flyer."} />
      {ws.caps && !ws.caps.education && <ErrorNote message="You don't have access to patient education." />}
      {list.isLoading && <Loading />}
      {list.error && <ErrorNote message={list.error.message} />}
      {list.data && list.data.length === 0 && <Panel><EmptyState icon={HeartHandshake} title="No approved handouts yet" body="An admin reviews and approves each wellness handout before it can be given to patients." /></Panel>}
      {list.data && list.data.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
          <nav className={cn(cardCls, "max-h-[75vh] overflow-y-auto p-2 dark:bg-slate-800")} aria-label="Topics">
            {(Object.keys(WELLNESS_GROUPS) as WellnessGroup[]).map((g) => {
              const items = list.data!.filter((t) => t.group === g);
              if (!items.length) return null;
              return (
                <div key={g} className="mb-2">
                  <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{WELLNESS_GROUPS[g].en}</p>
                  {items.map((t) => (
                    <button key={t.key} onClick={() => setParams({ t: t.key })}
                      className={cn("flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm", selected === t.key ? "bg-slate-100 font-semibold dark:bg-slate-700" : "hover:bg-slate-50 dark:hover:bg-slate-700/50")}>
                      <span className="truncate">{t.label}</span>
                      {admin && <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold", STATUS[t.status].cls)}>{STATUS[t.status].label}</span>}
                    </button>
                  ))}
                </div>
              );
            })}
          </nav>
          {selected && <TopicDetail key={selected} topicKey={selected} admin={admin} />}
        </div>
      )}
    </CCMDashboardLayout>
  );
}

function TopicDetail({ topicKey, admin }: { topicKey: string; admin: boolean }) {
  const q = trpc.workspace.wellness.get.useQuery({ key: topicKey });
  const clinics = trpc.learn.clinics.useQuery(undefined, { staleTime: 10 * 60_000 });
  const { clinics: myClinics } = useWorkspace();
  const utils = trpc.useUtils();
  const [lang, setLang] = useState<LibraryLang>("en");
  const [editing, setEditing] = useState(false);
  const [clinicId, setClinicId] = useState<number | null>(null);
  useEffect(() => { if (clinicId === null) setClinicId(myClinics[0]?.id ?? clinics.data?.[0]?.id ?? null); }, [clinicId, myClinics, clinics.data]);
  const approve = trpc.workspace.wellness.approve.useMutation({
    onSuccess: () => { toast.success("Approved. Patients can now get this handout."); void utils.workspace.wellness.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote message={q.error.message} />;
  const t = q.data!;
  if (editing) return <Editor entry={t.entry} topicKey={topicKey} onDone={() => setEditing(false)} />;
  const slug = slugOf(topicKey);
  const live = !!t.approved;

  return (
    <div className="space-y-4">
      <section className={cn(cardCls, "p-5 dark:bg-slate-800")}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-50">{t.label}</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {t.status === "approved" ? `Approved${t.approvedByName ? ` by ${t.approvedByName}` : ""}${t.approvedAt ? ` on ${fmtShortDate(t.approvedAt)}` : ""}: patients get this version.`
                : t.status === "changed" ? "Edited since it was approved. Patients still get the last approved version until you approve this one."
                : "Draft: not given to patients until you approve it."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {admin && t.status !== "approved" && (
              <Btn disabled={approve.isPending} onClick={() => approve.mutate({ key: topicKey })}>{approve.isPending ? <Loader2 size={15} className="animate-spin" /> : <BadgeCheck size={15} />} Approve</Btn>
            )}
            {admin && <Btn variant="secondary" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</Btn>}
          </div>
        </div>
        {admin && t.reviewNotes.length > 0 && t.status !== "approved" && (
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle size={14} /> Worth checking before you approve</p>
            <ul className="mt-1 list-disc space-y-0.5 ps-5">{t.reviewNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-700">
          <div className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-900" role="group" aria-label="Language">
            {LIBRARY_LANGS.map((l) => <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)} className={cn("rounded-lg px-3 py-1 text-sm font-semibold", lang === l ? "bg-white shadow-sm dark:bg-slate-700" : "text-slate-500")}>{LIBRARY_LANG_LABELS[l]}</button>)}
          </div>
          {live && (
            <>
              <select className={cn(inputCls, "w-auto py-1.5")} value={clinicId ?? ""} onChange={(e) => setClinicId(Number(e.target.value) || null)} aria-label="Clinic on the flyer">
                {(clinics.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <Btn size="sm" onClick={() => window.open(`/learn/flyer/${slug}?clinic=${clinicId ?? ""}${lang === "es" ? "&lang=es" : ""}`, "_blank", "noopener")}><Printer size={14} /> Print flyer</Btn>
              <a href={`/learn/${slug}${lang === "es" ? "?lang=es" : ""}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800"><ExternalLink size={12} /> View online</a>
            </>
          )}
          {!live && <span className="text-xs text-slate-500">Flyers and the online page are available once it's approved.</span>}
        </div>
      </section>
      <section className={cn(cardCls, "bg-white p-6")}>
        <WellnessHandout doc={t.entry.education[lang]} lang={lang} />
        {admin && t.entry.basis.length > 0 && <p className="mt-6 border-t border-slate-100 pt-3 text-xs text-slate-500">Based on: {t.entry.basis.join("; ")}</p>}
      </section>
    </div>
  );
}

const LIST_FIELDS: { key: "whoFor" | "whatToDo" | "whatToExpect" | "talkToUs"; label: string }[] = [
  { key: "whoFor", label: "Who it's for" },
  { key: "whatToDo", label: "What you can do" },
  { key: "whatToExpect", label: "What to expect" },
  { key: "talkToUs", label: "Talk with us if" },
];

/** Edit both languages (one bullet per line). Saving puts it back to waiting for approval. */
function Editor({ entry, topicKey, onDone }: { entry: WellnessEntry; topicKey: string; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<WellnessEntry>(() => JSON.parse(JSON.stringify(entry)) as WellnessEntry);
  const [lang, setLang] = useState<LibraryLang>("en");
  const save = trpc.workspace.wellness.save.useMutation({
    onSuccess: () => { toast.success("Saved. Approve it when it's ready."); void utils.workspace.wellness.invalidate(); onDone(); },
    onError: (e) => toast.error(e.message),
  });
  const doc = draft.education[lang];
  const set = (patch: Partial<WellnessDoc>) => setDraft((d) => ({ ...d, education: { ...d.education, [lang]: { ...d.education[lang], ...patch } } }));
  const label = "mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300";
  return (
    <section className={cn(cardCls, "space-y-4 p-5 dark:bg-slate-800")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-slate-900 dark:text-slate-50">Edit handout</h2>
        <div className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-900" role="group" aria-label="Language">
          {LIBRARY_LANGS.map((l) => <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)} className={cn("rounded-lg px-3 py-1 text-sm font-semibold", lang === l ? "bg-white shadow-sm dark:bg-slate-700" : "text-slate-500")}>{LIBRARY_LANG_LABELS[l]}</button>)}
        </div>
      </div>
      <p className="text-xs text-slate-500">Edit both English and Spanish so they match. One bullet per line.</p>
      <div><label className={label}>Title</label><input className={inputCls} value={doc.title} onChange={(e) => set({ title: e.target.value })} maxLength={160} /></div>
      <div><label className={label}>Summary</label><textarea className={cn(inputCls, "min-h-[70px]")} value={doc.summary} onChange={(e) => set({ summary: e.target.value })} maxLength={2000} /></div>
      <div><label className={label}>How often</label><input className={inputCls} value={doc.howOften} onChange={(e) => set({ howOften: e.target.value })} maxLength={400} /></div>
      {LIST_FIELDS.map((f) => (
        <div key={f.key}>
          <label className={label}>{f.label}</label>
          <textarea className={cn(inputCls, "min-h-[90px]")} value={doc[f.key].join("\n")} onChange={(e) => set({ [f.key]: e.target.value.split("\n") } as Partial<WellnessDoc>)} />
        </div>
      ))}
      <div>
        <label className={label}>Sources (one per line, shown to admins only)</label>
        <textarea className={cn(inputCls, "min-h-[60px]")} value={draft.basis.join("\n")} onChange={(e) => setDraft((d) => ({ ...d, basis: e.target.value.split("\n") }))} />
      </div>
      <div className="flex justify-end gap-2">
        <Btn variant="secondary" onClick={onDone}><X size={14} /> Cancel</Btn>
        <Btn disabled={save.isPending} onClick={() => save.mutate({ key: topicKey, entry: { ...draft, key: topicKey } })}>{save.isPending ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save</Btn>
      </div>
    </section>
  );
}
