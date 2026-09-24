import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { ArrowDown, ArrowLeft, ArrowUp, BookOpen, History, Loader2, Pencil, Plus, Search, Trash2, Archive } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, Panel, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type Step = { title: string; detail: string };

export default function PlaybooksPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const params = useParams<{ slug?: string }>();
  if (!user) return null;
  return (
    <CCMDashboardLayout title="Playbooks" pageTitle={false}>
      {params.slug ? <PlaybookDetail slug={params.slug} /> : <PlaybookList />}
    </CCMDashboardLayout>
  );
}

function PlaybookList() {
  const { caps } = useWorkspace();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = trpc.workspace.playbooks.list.useQuery({ q: debounced || undefined });
  const [, setLocation] = useLocation();

  const byCategory = new Map<string, NonNullable<typeof list.data>>();
  for (const p of list.data ?? []) (byCategory.get(p.category) ?? byCategory.set(p.category, []).get(p.category)!).push(p);

  return (
    <>
      <PageHeader
        title="Playbooks"
        subtitle="How we do things at MyPCP — step-by-step guides for the daily workflows."
        actions={caps?.playbooksEdit ? <Btn onClick={() => setLocation("/playbooks/new")}><Plus size={15} /> New playbook</Btn> : undefined}
      />
      <div className="relative max-w-md mb-5">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input className={cn(inputCls, "pl-9")} placeholder="Search playbooks" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search playbooks" />
      </div>
      {list.isLoading && <Loading />}
      {list.error && <ErrorNote message={list.error.message} />}
      {list.data && list.data.length === 0 && <Panel><EmptyState icon={BookOpen} title={debounced ? "No playbooks match" : "No playbooks yet"} /></Panel>}
      <div className="space-y-6">
        {Array.from(byCategory.entries()).map(([cat, items]) => (
          <section key={cat}>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">{cat}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {items.map((p) => (
                <Link key={p.slug} href={`/playbooks/${p.slug}`}>
                  <div className="h-full cursor-pointer rounded-xl border border-slate-200 dark:border-slate-700 bg-white p-4 shadow-[0_1px_2px_rgba(20,21,25,0.04)] hover:border-slate-300 transition-colors">
                    <p className="font-semibold text-slate-900 dark:text-slate-50">{p.title}</p>
                    {p.description && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 line-clamp-2">{p.description}</p>}
                    <p className="mt-3 text-[11px] text-slate-400">v{p.currentVersion} · updated {fmtShortDate(p.updatedAt)}{p.owner ? ` · ${p.owner}` : ""}</p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function PlaybookDetail({ slug }: { slug: string }) {
  const { caps } = useWorkspace();
  const isNew = slug === "new";
  const q = trpc.workspace.playbooks.get.useQuery(slug, { enabled: !isNew, retry: false });
  const [editing, setEditing] = useState(isNew);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const archive = trpc.workspace.playbooks.archive.useMutation({
    onSuccess: () => {
      toast.success("Playbook archived.");
      void utils.workspace.playbooks.invalidate();
      setLocation("/playbooks");
    },
    onError: (e) => toast.error(e.message),
  });

  useEffect(() => setDone(new Set()), [slug]);

  if (!isNew && q.isLoading) return <Loading />;
  if (!isNew && q.error) return <ErrorNote message={q.error.message} />;
  const pb = q.data;

  if (editing && caps?.playbooksEdit) {
    return (
      <PlaybookEditor
        initial={isNew ? null : pb ? { slug: pb.slug, title: pb.title, category: pb.category, description: pb.description ?? "", steps: pb.steps as Step[] } : null}
        onCancel={() => (isNew ? setLocation("/playbooks") : setEditing(false))}
        onSaved={(newSlug) => {
          setEditing(false);
          if (newSlug !== slug) setLocation(`/playbooks/${newSlug}`);
        }}
      />
    );
  }
  if (!pb) return null;
  const steps = pb.steps as Step[];

  return (
    <>
      <Link href="/playbooks" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4"><ArrowLeft size={15} /> All playbooks</Link>
      <PageHeader
        title={pb.title}
        subtitle={<>{pb.category} · version {pb.currentVersion}{pb.owner ? ` · owner ${pb.owner}` : ""}</>}
        actions={
          caps?.playbooksEdit ? (
            <>
              <Btn variant="secondary" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</Btn>
              <Btn variant="ghost" onClick={() => { if (confirm("Archive this playbook? It will be hidden from everyone.")) archive.mutate(pb.slug); }}><Archive size={14} /> Archive</Btn>
            </>
          ) : undefined
        }
      />
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
        <Panel title={`Steps · ${done.size}/${steps.length} checked`} action={done.size > 0 ? <button className="text-xs text-slate-500 hover:underline" onClick={() => setDone(new Set())}>Reset</button> : undefined}>
          {pb.description && <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">{pb.description}</p>}
          <ol className="space-y-3">
            {steps.map((s, i) => {
              const checked = done.has(i);
              return (
                <li key={i}>
                  <label className={cn("flex gap-3 rounded-xl border p-3 cursor-pointer transition-colors", checked ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/30" : "border-slate-200 dark:border-slate-700 hover:bg-slate-50")}>
                    <input type="checkbox" className="mt-1" checked={checked} onChange={() => setDone((d) => { const n = new Set(d); n.has(i) ? n.delete(i) : n.add(i); return n; })} />
                    <span>
                      <span className={cn("block text-sm font-semibold text-slate-900 dark:text-slate-50", checked && "line-through text-slate-500")}>{i + 1}. {s.title}</span>
                      {s.detail && <span className="block mt-0.5 text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{s.detail}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ol>
          <p className="mt-4 text-xs text-slate-500">Checkmarks are just for you and reset when you leave the page.</p>
        </Panel>
        <Panel title={<span className="flex items-center gap-1.5"><History size={14} /> Version history</span>}>
          <ol className="space-y-3">
            {pb.history.map((h) => (
              <li key={h.version} className="text-sm">
                <p className="font-semibold text-slate-800 dark:text-slate-100">v{h.version} <span className="font-normal text-slate-500">· {fmtShortDate(h.createdAt)}</span></p>
                <p className="text-xs text-slate-500">{h.changeNote || "No note"}{h.by ? ` — ${h.by}` : ""}</p>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </>
  );
}

function PlaybookEditor({ initial, onCancel, onSaved }: { initial: { slug: string; title: string; category: string; description: string; steps: Step[] } | null; onCancel: () => void; onSaved: (slug: string) => void }) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [category, setCategory] = useState(initial?.category ?? "Front desk");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [steps, setSteps] = useState<Step[]>(initial?.steps.length ? initial.steps : [{ title: "", detail: "" }]);
  const [changeNote, setChangeNote] = useState("");
  const utils = trpc.useUtils();
  const save = trpc.workspace.playbooks.save.useMutation({
    onSuccess: (r) => {
      toast.success("Playbook saved.");
      void utils.workspace.playbooks.invalidate();
      onSaved(r.slug);
    },
    onError: (e) => toast.error(e.message),
  });

  const setStep = (i: number, patch: Partial<Step>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const moveStep = (i: number, d: -1 | 1) => setSteps((s) => { const n = [...s]; const j = i + d; if (j < 0 || j >= n.length) return s; [n[i], n[j]] = [n[j]!, n[i]!]; return n; });
  const cleanSteps = steps.filter((s) => s.title.trim()).map((s) => ({ title: s.title.trim(), detail: s.detail.trim() }));

  return (
    <>
      <PageHeader title={initial ? `Edit: ${initial.title}` : "New playbook"} subtitle="Saving creates a new version; older versions stay in the history." />
      <Panel>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Title</label>
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Category</label>
            <input className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} list="pb-cats" />
            <datalist id="pb-cats">{["Front desk", "Clinical support", "Care management", "Operations"].map((c) => <option key={c} value={c} />)}</datalist>
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-semibold text-slate-600 mb-1">Summary</label>
            <textarea className={cn(inputCls, "min-h-[60px]")} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          </div>
        </div>

        <h4 className="mt-6 mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">Steps</h4>
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={i} className="rounded-xl border border-slate-200 dark:border-slate-700 p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-400 w-5">{i + 1}.</span>
                <input className={inputCls} placeholder="Step title" value={s.title} onChange={(e) => setStep(i, { title: e.target.value })} maxLength={255} />
                <button className="p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-30" disabled={i === 0} onClick={() => moveStep(i, -1)} aria-label="Move up"><ArrowUp size={15} /></button>
                <button className="p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-30" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)} aria-label="Move down"><ArrowDown size={15} /></button>
                <button className="p-1.5 text-slate-400 hover:text-rose-600 disabled:opacity-30" disabled={steps.length === 1} onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} aria-label="Remove step"><Trash2 size={15} /></button>
              </div>
              <textarea className={cn(inputCls, "mt-2 min-h-[56px]")} placeholder="Details (optional)" value={s.detail} onChange={(e) => setStep(i, { detail: e.target.value })} maxLength={4000} />
            </li>
          ))}
        </ol>
        <Btn variant="secondary" size="sm" className="mt-3" onClick={() => setSteps((s) => [...s, { title: "", detail: "" }])}><Plus size={14} /> Add step</Btn>

        <div className="mt-6 grid sm:grid-cols-[1fr_auto] gap-3 items-end">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">What changed? (optional)</label>
            <input className={inputCls} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} maxLength={500} placeholder="e.g. Added insurance card step" />
          </div>
          <div className="flex gap-2">
            <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
            <Btn
              disabled={save.isPending || !title.trim() || !category.trim() || cleanSteps.length === 0}
              onClick={() => save.mutate({ slug: initial?.slug ?? null, title: title.trim(), category: category.trim(), description: description.trim() || null, steps: cleanSteps, changeNote: changeNote.trim() || null })}
            >
              {save.isPending && <Loader2 size={15} className="animate-spin" />} Save
            </Btn>
          </div>
        </div>
      </Panel>
    </>
  );
}
