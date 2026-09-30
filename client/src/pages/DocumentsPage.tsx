import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import { CheckCircle2, Clock, FilePlus2, FileSignature, FileStack, Loader2, PenLine, Search, Stethoscope, Upload, UserRound, XCircle } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, Panel, inputCls } from "@/components/workspace/ui";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SignatureDialog, imageToSignaturePng } from "@/components/documents/SignatureDialog";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { APPROVAL_LABELS, DOC_STATUS_LABELS, PROVIDER_SIGNATURE_RULE, type DocStatus } from "@shared/documents";

type ListView = "to_sign" | "in_progress" | "completed" | "templates";
type View = ListView | "provider_sigs" | "signed_for_me";
const TABS: { k: View; label: string; icon: React.ElementType; roles?: string[] }[] = [
  { k: "to_sign", label: "To sign", icon: PenLine },
  { k: "in_progress", label: "In progress", icon: Clock },
  { k: "completed", label: "Completed", icon: CheckCircle2 },
  { k: "templates", label: "Templates", icon: FileStack },
  { k: "provider_sigs", label: "Provider signatures", icon: Stethoscope, roles: ["admin", "provider"] },
  { k: "signed_for_me", label: "Signed for me", icon: FileSignature, roles: ["provider"] },
];
const isList = (v: View): v is ListView => v === "to_sign" || v === "in_progress" || v === "completed" || v === "templates";
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
  const list = trpc.workspace.documents.list.useQuery({ view: isList(view) ? view : "in_progress", q: q.length >= 2 ? q : null }, { enabled: enabled && isList(view), refetchInterval: 30_000 });
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
        {TABS.filter((t) => !t.roles || t.roles.includes(user?.role ?? "")).map((t) => (
          <button key={t.k} role="tab" aria-selected={view === t.k} onClick={() => { setView(t.k); setTouched(true); }}
            className={cn("-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium", view === t.k ? "border-brand text-slate-900 dark:text-slate-50" : "border-transparent text-slate-500 hover:text-slate-800")}>
            <t.icon size={15} /> {t.label}
            {t.k === "to_sign" && !!counts.data?.toSign && <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-bold text-white">{counts.data.toSign}</span>}
          </button>
        ))}
      </div>
      {view === "provider_sigs" && enabled && <ProviderSignaturesPanel />}
      {view === "signed_for_me" && enabled && <SignedForMePanel />}
      {isList(view) && (
      <>
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
      </>
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

// ---------------------------------------------------------------------------
// Provider signatures: stored once, applied by the staff each provider picks, with their approval
// ---------------------------------------------------------------------------

type ProviderRow = RouterOutputs["workspace"]["documents"]["providerSignatures"]["providers"][number];

function ProviderSignaturesPanel() {
  const q = trpc.workspace.documents.providerSignatures.useQuery();
  const rows = q.data?.providers ?? [];
  return (
    <div className="space-y-4">
      <Panel>
        <div className="space-y-1 text-sm text-slate-600 dark:text-slate-300">
          <p>Store each provider's signature once. The staff a provider picks can then apply it to a document <b>after the provider approves</b>: they confirm the approval and how it was given. Every use is on the PDF's certificate page, in the audit log, and sent to the provider as a notification.</p>
          <p className="text-xs text-amber-800 dark:text-amber-300">{PROVIDER_SIGNATURE_RULE}</p>
        </div>
      </Panel>
      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {q.data && !rows.length && <Panel><EmptyState icon={Stethoscope} title="No providers" body="Providers with a MyPCP login show up here." /></Panel>}
      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map((p) => <ProviderCard key={p.providerUserId} p={p} />)}
      </div>
    </div>
  );
}

function ProviderCard({ p }: { p: ProviderRow }) {
  const utils = trpc.useUtils();
  const refresh = () => void utils.workspace.documents.providerSignatures.invalidate();
  const save = trpc.workspace.documents.saveProviderSignature.useMutation({ onSuccess: () => { refresh(); toast.success("Saved"); }, onError: (e) => toast.error(e.message) });
  const setDelegates = trpc.workspace.documents.setProviderDelegates.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const people = trpc.workspace.documents.signers.useQuery();
  const [drawing, setDrawing] = useState<"signature" | "initials" | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const [uploadKind, setUploadKind] = useState<"signature" | "initials">("signature");
  const delegateIds = p.delegates.map((d) => d.userId);
  const choices = (people.data ?? []).filter((u) => u.id !== p.providerUserId && !delegateIds.includes(u.id));
  const put = (k: "signature" | "initials", png: string | null) => save.mutate({ providerUserId: p.providerUserId, ...(k === "initials" ? { initialsPng: png } : { signaturePng: png }) });
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try { put(uploadKind, await imageToSignaturePng(file)); } catch (e) { toast.error((e as Error).message); } finally { if (upload.current) upload.current.value = ""; }
  };
  const box = (k: "signature" | "initials") => {
    const png = k === "initials" ? p.initialsPng : p.signaturePng;
    return (
      <div>
        <p className="mb-1 text-xs font-semibold text-slate-500">{k === "initials" ? "Initials" : "Signature"}</p>
        <div className={cn("grid place-items-center rounded-lg border border-slate-200 dark:border-slate-700", k === "initials" ? "h-16" : "h-20")} style={{ background: "#fff" }}>
          {png ? <img src={png} alt="" className="max-h-full max-w-full p-1" /> : <span className="text-xs text-slate-400">None yet</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-2 text-xs">
          <button type="button" className="font-semibold text-brand hover:underline" onClick={() => setDrawing(k)}>Draw</button>
          <button type="button" className="font-semibold text-brand hover:underline" onClick={() => { setUploadKind(k); upload.current?.click(); }}>Upload a photo</button>
          {png && <button type="button" className="text-slate-500 hover:text-red-600" onClick={() => { if (window.confirm("Remove it?")) put(k, null); }}>Remove</button>}
        </div>
      </div>
    );
  };
  return (
    <Panel title={<span className="flex items-center gap-2"><Stethoscope size={15} /> {p.name}{p.isMe ? " (you)" : ""}</span>}
      subtitle={`${p.uses} use${p.uses === 1 ? "" : "s"} so far`}
      action={(
        <label className="flex items-center gap-2 text-xs font-semibold">
          <input type="checkbox" className="size-4 accent-teal-700" checked={p.enabled} disabled={save.isPending} onChange={(e) => save.mutate({ providerUserId: p.providerUserId, enabled: e.target.checked })} />
          Staff may use it
        </label>
      )}>
      <input ref={upload} type="file" accept="image/*" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      <div className="grid grid-cols-[2fr_1fr] gap-3">{box("signature")}{box("initials")}</div>
      <div className="mt-4">
        <p className="mb-1 text-xs font-semibold text-slate-500">Who may apply it (after {p.name} approves)</p>
        <div className="flex flex-wrap gap-1.5">
          {p.delegates.map((d) => (
            <span key={d.userId} className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-800 dark:bg-teal-900/40 dark:text-teal-200">
              {d.name}
              <button type="button" title="Remove" onClick={() => setDelegates.mutate({ providerUserId: p.providerUserId, userIds: delegateIds.filter((x) => x !== d.userId) })}><XCircle size={12} /></button>
            </span>
          ))}
          {!p.delegates.length && <span className="text-xs text-slate-400">Nobody yet.</span>}
        </div>
        <select className={cn(inputCls, "mt-2 h-8 text-xs")} value="" disabled={setDelegates.isPending}
          onChange={(e) => e.target.value && setDelegates.mutate({ providerUserId: p.providerUserId, userIds: [...delegateIds, Number(e.target.value)] })}>
          <option value="">+ Allow someone…</option>
          {choices.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <SignatureDialog open={!!drawing} kind={drawing ?? "signature"} setupOnly saved={null} defaultName={p.name} onClose={() => setDrawing(null)}
        onDone={async (png) => { if (drawing) { await save.mutateAsync({ providerUserId: p.providerUserId, ...(drawing === "initials" ? { initialsPng: png } : { signaturePng: png }) }); setDrawing(null); } }} />
    </Panel>
  );
}

/** A provider's list of every document their stored signature was applied to. */
function SignedForMePanel() {
  const q = trpc.workspace.documents.signedForMe.useQuery();
  const rows = q.data ?? [];
  return (
    <>
      {q.isLoading && <Loading />}
      {q.error && <ErrorNote message={q.error.message} />}
      {q.data && !rows.length && <Panel><EmptyState icon={FileSignature} title="Nothing signed for you yet" body="When staff apply your stored signature (after you approve), it's listed here." /></Panel>}
      {rows.length > 0 && (
        <Panel bodyClassName="p-0">
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {rows.map((r, i) => (
              <li key={i} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{r.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Your {r.kind} applied by {r.appliedBy ?? "a teammate"} · {when(r.at)} · you approved {r.approval ? APPROVAL_LABELS[r.approval].toLowerCase() : ""}{r.note ? ` (${r.note})` : ""}
                  </p>
                </div>
                <Link href={`/documents/${r.documentId}`}><Btn size="sm" variant="ghost">Open</Btn></Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
