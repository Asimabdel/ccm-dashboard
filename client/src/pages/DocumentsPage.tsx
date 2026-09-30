import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import { CheckCircle2, Clock, FilePlus2, FileSignature, FileStack, Loader2, PenLine, Search, Upload, UserRound } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, Panel, inputCls } from "@/components/workspace/ui";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SignatureDialog } from "@/components/documents/SignatureDialog";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { DOC_STATUS_LABELS, type DocStatus } from "@shared/documents";

type View = "to_sign" | "in_progress" | "completed" | "templates";
const TABS: { k: View; label: string; icon: React.ElementType }[] = [
  { k: "to_sign", label: "To sign", icon: PenLine },
  { k: "in_progress", label: "In progress", icon: Clock },
  { k: "completed", label: "Completed", icon: CheckCircle2 },
  { k: "templates", label: "Templates", icon: FileStack },
];
const STATUS_CLS: Record<DocStatus, string> = {
  draft: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  signing: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  cancelled: "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500",
};
const when = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) : "—";

function toBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

/** Documents: our own DocuSign. Upload a PDF, fill and sign it, send it to teammates to co-sign, download the signed PDF. */
export default function DocumentsPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const [, navigate] = useLocation();
  const enabled = !!user && !!ws.caps?.documents;
  const counts = trpc.workspace.documents.counts.useQuery(undefined, { enabled, refetchInterval: 60_000 });
  const [view, setView] = useState<View>("in_progress");
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (!touched && counts.data?.toSign) setView("to_sign"); }, [counts.data, touched]);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { const h = window.setTimeout(() => setQ(search.trim()), 300); return () => window.clearTimeout(h); }, [search]);
  const list = trpc.workspace.documents.list.useQuery({ view, q: q.length >= 2 ? q : null }, { enabled, refetchInterval: 30_000 });
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const create = trpc.workspace.documents.create.useMutation();
  const uploadLocal = trpc.workspace.documents.uploadLocal.useMutation();
  const uploaded = trpc.workspace.documents.uploaded.useMutation();
  const [useTemplate, setUseTemplate] = useState<{ id: number; title: string } | null>(null);
  const [sigSetup, setSigSetup] = useState<"signature" | "initials" | null>(null);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { toast.error("Please choose a PDF file."); return; }
    setUploading(true);
    try {
      const c = await create.mutateAsync({ title: file.name.replace(/\.pdf$/i, ""), fileName: file.name, size: file.size });
      if (c.upload.url) {
        const r = await fetch(c.upload.url, { method: "PUT", headers: { "Content-Type": "application/pdf" }, body: file });
        if (!r.ok) throw new Error(`Upload failed (${r.status}).`);
      } else {
        await uploadLocal.mutateAsync({ id: c.id, base64: await toBase64(file) });
      }
      const info = await uploaded.mutateAsync({ id: c.id });
      toast.success(info.fieldsFound ? `Uploaded. Found ${info.fieldsFound} fillable box${info.fieldsFound === 1 ? "" : "es"} in the PDF.` : "Uploaded.");
      navigate(`/documents/${c.id}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const rows = list.data ?? [];
  return (
    <CCMDashboardLayout title="Documents" pageTitle={false}>
      <PageHeader
        title="Documents"
        subtitle="Upload a PDF, fill it in and sign it, send it to a teammate or provider to co-sign, and download the signed PDF."
        actions={enabled ? (
          <div className="flex flex-wrap gap-2">
            <MySignatureButton onEdit={setSigSetup} />
            <Btn onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Upload a PDF
            </Btn>
          </div>
        ) : undefined}
      />
      <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
      {ws.caps && !ws.caps.documents && <ErrorNote message="You don't have access to Documents." />}

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-700" role="tablist">
        {TABS.map((t) => (
          <button key={t.k} role="tab" aria-selected={view === t.k} onClick={() => { setView(t.k); setTouched(true); }}
            className={cn("-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium", view === t.k ? "border-brand text-slate-900 dark:text-slate-50" : "border-transparent text-slate-500 hover:text-slate-800")}>
            <t.icon size={15} /> {t.label}
            {t.k === "to_sign" && !!counts.data?.toSign && <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-bold text-white">{counts.data.toSign}</span>}
          </button>
        ))}
      </div>
      <div className="mb-3 flex max-w-md items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-800">
        <Search size={15} className="shrink-0 text-slate-400" />
        <input className="h-9 w-full bg-transparent text-sm outline-none" placeholder="Search by title" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {list.isLoading && <Loading />}
      {list.error && <ErrorNote message={list.error.message} />}
      {list.data && rows.length === 0 && (
        <Panel>
          <EmptyState icon={view === "templates" ? FileStack : FileSignature}
            title={view === "to_sign" ? "Nothing waiting for your signature" : view === "templates" ? "No templates yet" : "Nothing here yet"}
            body={view === "templates" ? "Open any document and click \"Save as template\" to reuse its boxes next time." : "Upload a PDF to get started."}
            action={view !== "to_sign" && enabled ? <Btn onClick={() => fileInput.current?.click()}><FilePlus2 size={14} /> Upload a PDF</Btn> : undefined} />
        </Panel>
      )}
      {rows.length > 0 && (
        <Panel bodyClassName="p-0">
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {rows.map((d) => (
              <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                <Link href={`/documents/${d.id}`} className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900 hover:underline dark:text-slate-50">{d.title}</span>
                    {!d.isTemplate && <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS_CLS[d.status])}>{DOC_STATUS_LABELS[d.status]}</span>}
                    {d.patientName && <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800 dark:bg-sky-900/40 dark:text-sky-200"><UserRound size={11} /> {d.patientName}</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {d.pages} page{d.pages === 1 ? "" : "s"} · {d.fieldCount} box{d.fieldCount === 1 ? "" : "es"}
                    {d.creator ? ` · by ${d.createdByMe ? "you" : d.creator}` : ""}
                    {d.completedAt ? ` · completed ${when(d.completedAt)}` : d.sentAt ? ` · sent ${when(d.sentAt)}` : ` · updated ${when(d.updatedAt)}`}
                  </p>
                  {d.signers.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                      {d.signers.map((s) => (
                        <span key={s.userId} className={cn("rounded-full px-2 py-0.5 font-semibold", s.status === "signed" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")}>
                          {s.status === "signed" ? "✓ " : ""}{s.name ?? "Signer"}
                        </span>
                      ))}
                    </p>
                  )}
                </Link>
                <div className="flex shrink-0 gap-1.5">
                  {d.isTemplate ? (
                    <>
                      <Btn size="sm" onClick={() => setUseTemplate({ id: d.id, title: d.title })}><FilePlus2 size={13} /> Use</Btn>
                      <Link href={`/documents/${d.id}`}><Btn size="sm" variant="ghost">Edit</Btn></Link>
                    </>
                  ) : (
                    <Link href={`/documents/${d.id}`}><Btn size="sm" variant={view === "to_sign" ? "primary" : "ghost"}>{view === "to_sign" ? "Sign" : "Open"}</Btn></Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <UseTemplateDialog template={useTemplate} onClose={() => setUseTemplate(null)} onCreated={(id) => navigate(`/documents/${id}`)} />
      <MySignatureDialog kind={sigSetup} onClose={() => setSigSetup(null)} />
    </CCMDashboardLayout>
  );
}

function MySignatureButton({ onEdit }: { onEdit: (k: "signature" | "initials") => void }) {
  const mine = trpc.workspace.documents.mySignature.useQuery();
  const s = mine.data;
  return (
    <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 dark:border-slate-700 dark:bg-slate-800">
      <button type="button" onClick={() => onEdit("signature")} className="flex h-9 items-center gap-2 px-1 text-xs font-semibold text-slate-600 hover:text-slate-900 dark:text-slate-300" title="Your saved signature">
        {s?.signaturePng ? <img src={s.signaturePng} alt="Your signature" className="h-6 max-w-28 object-contain dark:invert" /> : <><PenLine size={13} /> My signature</>}
      </button>
      <span className="text-slate-300">|</span>
      <button type="button" onClick={() => onEdit("initials")} className="flex h-9 items-center px-1 text-xs font-semibold text-slate-600 hover:text-slate-900 dark:text-slate-300" title="Your saved initials">
        {s?.initialsPng ? <img src={s.initialsPng} alt="Your initials" className="h-6 max-w-12 object-contain dark:invert" /> : "Initials"}
      </button>
    </div>
  );
}

function MySignatureDialog({ kind, onClose }: { kind: "signature" | "initials" | null; onClose: () => void }) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const mine = trpc.workspace.documents.mySignature.useQuery();
  const save = trpc.workspace.documents.saveMySignature.useMutation({ onSuccess: () => { void utils.workspace.documents.mySignature.invalidate(); toast.success("Saved"); onClose(); } });
  return (
    <SignatureDialog open={!!kind} kind={kind ?? "signature"} setupOnly saved={(kind === "initials" ? mine.data?.initialsPng : mine.data?.signaturePng) ?? null}
      defaultName={user?.name ?? ""} onClose={onClose}
      onDone={async (png) => { await save.mutateAsync(kind === "initials" ? { initialsPng: png } : { signaturePng: png }); }} />
  );
}

type Subject = RouterOutputs["workspace"]["documents"]["searchPatients"][number];

/** Start from a template, optionally for a patient (their name, DOB, phone… fill in where the template says). */
function UseTemplateDialog({ template, onClose, onCreated }: { template: { id: number; title: string } | null; onClose: () => void; onCreated: (id: number) => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Subject | null>(null);
  useEffect(() => { if (template) { setQ(""); setPicked(null); } }, [template]);
  const search = trpc.workspace.documents.searchPatients.useQuery({ q: q.trim() }, { enabled: !!template && q.trim().length >= 2 && !picked });
  const make = trpc.workspace.documents.fromTemplate.useMutation({ onSuccess: (r) => { onClose(); onCreated(r.id); }, onError: (e) => toast.error(e.message) });
  return (
    <Dialog open={!!template} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New from "{template?.title}"</DialogTitle>
          <DialogDescription>Pick the patient it's for (optional): their details fill in wherever the template asks for them.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {picked ? (
            <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
              <span><b>{picked.name}</b>{picked.dob ? <span className="text-xs text-slate-500"> · DOB {picked.dob}</span> : null}</span>
              <button type="button" className="text-xs font-semibold text-brand hover:underline" onClick={() => setPicked(null)}>Change</button>
            </div>
          ) : (
            <>
              <input className={inputCls} placeholder="Search patients by name (optional)" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
              <ul className="max-h-56 space-y-1 overflow-y-auto">
                {(search.data ?? []).map((s) => (
                  <li key={s.key}>
                    <button type="button" onClick={() => setPicked(s)} className="w-full rounded-md px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
                      <b>{s.name}</b> <span className="text-xs text-slate-500">{s.dob ? `DOB ${s.dob}` : ""}{s.clinicName ? ` · ${s.clinicName}` : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
            <Btn disabled={make.isPending} onClick={() => template && make.mutate({ templateId: template.id, subjectKey: picked?.key ?? null })}>
              {make.isPending && <Loader2 size={14} className="animate-spin" />} Start document
            </Btn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
