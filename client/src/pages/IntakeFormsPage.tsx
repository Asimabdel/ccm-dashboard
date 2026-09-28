import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle, BookOpen, CalendarClock, Check, CheckCircle2, ClipboardSignature, Clock, Copy, FileCheck2, FilePlus2, Image as ImageIcon, Loader2, Mail,
  MessageSquareText, Plus, Printer, Send, XCircle,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, Panel, inputCls } from "@/components/workspace/ui";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SendFormsDialog } from "@/components/intake/SendFormsDialog";
import { rcText } from "@/components/phone/ringcentralStore";
import { chartHref } from "@/components/chart/ChartLookup";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  INTAKE_LANGS, LANG_LABELS, MEDICAL_INTAKE, PACKET_STATUS_LABELS, answerText, isVisible, textBlocks, type Answers, type IntakeLang, type PacketStatus,
} from "@shared/intake";

type Tab = "waiting" | "to_file" | "filed" | "all" | "library";
const TABS: { k: Tab; label: string; icon: React.ElementType }[] = [
  { k: "waiting", label: "Waiting on patient", icon: Clock },
  { k: "to_file", label: "Ready to file", icon: FileCheck2 },
  { k: "filed", label: "Filed", icon: CheckCircle2 },
  { k: "all", label: "All", icon: ClipboardSignature },
  { k: "library", label: "Form library", icon: BookOpen },
];
const STATUS_CLS: Record<PacketStatus, string> = {
  waiting: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  opened: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  in_progress: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  filed: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  cancelled: "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500",
};
const when = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) : "—";
const EVENT_LABELS: Record<string, string> = {
  created: "Forms created", sent_email: "Emailed", sent_text: "Text prepared in RingCentral", link_copied: "Link copied", opened: "Patient opened the link",
  dob_failed: "Wrong date of birth", locked: "Locked after too many wrong dates of birth", dob_ok: "Date of birth confirmed", started: "Started filling in",
  photo_added: "Photo added", signed: "Signed", completed: "All forms finished", viewed: "Viewed by staff", photo_viewed: "Photo viewed by staff",
  filed: "Marked filed in Practice Fusion", cancelled: "Cancelled", extended: "Link extended",
};

async function copyText(s: string) {
  try { await navigator.clipboard.writeText(s); return true; } catch { return false; }
}

/** Patient forms (replacing BoldSign): send, watch progress, open what came back, file it in Practice Fusion. */
export default function IntakeFormsPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const deepLink = typeof window !== "undefined" ? Number(new URLSearchParams(window.location.search).get("p")) || null : null;
  const [tab, setTab] = useState<Tab>(deepLink ? "all" : "waiting");
  const [openId, setOpenId] = useState<number | null>(deepLink);
  const [sending, setSending] = useState(false);
  const enabled = !!user && !!ws.caps?.intakeForms;
  const list = trpc.workspace.intake.list.useQuery({ filter: tab === "library" ? "all" : tab }, { enabled: enabled && tab !== "library", refetchInterval: 30_000 });
  const stats = trpc.workspace.intake.stats.useQuery(undefined, { enabled, refetchInterval: 60_000 });
  const mail = trpc.workspace.intake.status.useQuery(undefined, { enabled, staleTime: 60_000 });
  const rows = list.data ?? [];
  const s = stats.data;

  return (
    <CCMDashboardLayout title="Patient forms" pageTitle={false}>
      <PageHeader
        title="Patient forms"
        subtitle="Intake forms and consents patients fill in and sign on their phone. When they finish, save the signed copy and upload it to Practice Fusion."
        actions={enabled ? <Btn onClick={() => setSending(true)}><Send size={14} /> Send forms</Btn> : undefined}
      />
      {ws.caps && !ws.caps.intakeForms && <ErrorNote message="You don't have access to patient forms." />}
      {enabled && mail.data && !mail.data.canSend && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p>
            Texting and copying the link work now. <b>Email</b> needs an admin to reconnect the practice mailbox once so MyPCP may send from it
            {user?.role === "admin" ? <> (<Link href="/integrations" className="font-semibold underline">Integrations</Link> → Practice mailbox → Reconnect to allow sending).</> : "."}
          </p>
        </div>
      )}
      {s && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Waiting on patient" value={s.waiting} />
          <Stat label="Ready to file" value={s.toFile} tone={s.toFile ? "warn" : undefined} sub="Upload to Practice Fusion" />
          <Stat label="Sent (30 days)" value={s.sent30} />
          <Stat label="Finished (30 days)" value={s.done30} sub={s.medianHours != null ? `Typically ${s.medianHours < 1 ? "under an hour" : `${s.medianHours} h`} after sending` : undefined} />
        </div>
      )}
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-700" role="tablist">
        {TABS.map((t) => (
          <button key={t.k} role="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)}
            className={cn("-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium", tab === t.k ? "border-brand text-slate-900 dark:text-slate-50" : "border-transparent text-slate-500 hover:text-slate-800")}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {tab === "library" ? (
        enabled && <Library isAdmin={user?.role === "admin"} />
      ) : (
        <>
          {list.isLoading && <Loading />}
          {list.error && <ErrorNote message={list.error.message} />}
          {list.data && rows.length === 0 && (
            <Panel>
              <EmptyState icon={ClipboardSignature} title={tab === "to_file" ? "Nothing to file" : "Nothing here yet"}
                body={tab === "waiting" ? "Click Send forms to text or email a patient their intake forms." : "Finished forms show up here."}
                action={tab === "waiting" && enabled ? <Btn onClick={() => setSending(true)}><Send size={14} /> Send forms</Btn> : undefined} />
            </Panel>
          )}
          {rows.length > 0 && (
            <Panel bodyClassName="p-0">
              <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                {rows.map((p) => (
                  <li key={p.id} className={cn("px-4 py-3 text-sm", deepLink === p.id && "bg-amber-50/70 dark:bg-amber-900/20")}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <button type="button" onClick={() => setOpenId(p.id)} className="min-w-0 flex-1 text-left">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-slate-900 hover:underline dark:text-slate-50">{p.name}</span>
                          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS_CLS[p.status])}>{PACKET_STATUS_LABELS[p.status]}</span>
                          {p.expired && <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:bg-red-900/40 dark:text-red-200">Link expired</span>}
                          {p.locked && <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:bg-red-900/40 dark:text-red-200">Locked (wrong DOB)</span>}
                          {p.language !== "en" && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800 dark:bg-sky-900/40 dark:text-sky-200">{LANG_LABELS[p.language as IntakeLang] ?? p.language}</span>}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
                          {p.forms.map((f) => (
                            <span key={f.key} className="me-2 inline-flex items-center gap-1">
                              {f.signed ? <Check size={12} className="text-emerald-600" /> : <span className="inline-block size-2 rounded-full bg-slate-300" />}
                              {f.title}
                            </span>
                          ))}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {p.sentAt ? `Sent ${when(p.sentAt)}${p.sentVia ? ` by ${p.sentVia}` : ""}${p.sendCount > 1 ? ` (${p.sendCount}×)` : ""}` : `Created ${when(p.createdAt)}, not sent yet`}
                          {p.openedAt ? ` · opened ${when(p.openedAt)}` : ""}
                          {p.completedAt ? ` · finished ${when(p.completedAt)}` : ""}
                          {p.clinicName ? ` · ${p.clinicName}` : ""}
                          {p.createdBy ? ` · by ${p.createdBy}` : ""}
                        </p>
                      </button>
                      <RowActions p={p} onOpen={() => setOpenId(p.id)} />
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
      <SendFormsDialog open={sending} onClose={() => setSending(false)} />
      <PacketSheet id={openId} onClose={() => setOpenId(null)} />
    </CCMDashboardLayout>
  );
}

type Row = RouterOutputs["workspace"]["intake"]["list"][number];

function useResend() {
  const utils = trpc.useUtils();
  const refresh = () => void utils.workspace.intake.invalidate();
  const text = trpc.workspace.intake.textMessage.useMutation({ onSuccess: refresh });
  const email = trpc.workspace.intake.sendEmail.useMutation({ onSuccess: refresh });
  const link = trpc.workspace.intake.copyLink.useMutation({ onSuccess: refresh });
  return {
    busy: text.isPending || email.isPending || link.isPending,
    text: async (id: number) => {
      try {
        const r = await text.mutateAsync({ id });
        if (rcText(r.phone, r.message)) toast.success("Text ready in the RingCentral phone. Press Send there.");
        else { await copyText(r.message); toast.success("RingCentral phone isn't open: the text was copied to paste into a message."); }
      } catch (e) { toast.error((e as Error).message); }
    },
    email: async (id: number) => {
      try { const r = await email.mutateAsync({ id }); toast.success(`Emailed to ${r.to}`); } catch (e) { toast.error((e as Error).message); }
    },
    link: async (id: number) => {
      try { const r = await link.mutateAsync({ id }); toast[(await copyText(r.link)) ? "success" : "error"](`Link: ${r.link}`); } catch (e) { toast.error((e as Error).message); }
    },
  };
}

function RowActions({ p, onOpen }: { p: Row; onOpen: () => void }) {
  const resend = useResend();
  const open = (p.status === "waiting" || p.status === "opened" || p.status === "in_progress") && !p.expired;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {open && p.hasPhone && <Btn size="sm" variant="secondary" disabled={resend.busy} onClick={() => resend.text(p.id)} title="Text the link again"><MessageSquareText size={13} /> Text</Btn>}
      {open && p.hasEmail && <Btn size="sm" variant="secondary" disabled={resend.busy} onClick={() => resend.email(p.id)} title="Email the link again"><Mail size={13} /> Email</Btn>}
      {open && <Btn size="sm" variant="ghost" disabled={resend.busy} onClick={() => resend.link(p.id)} title="Copy the link"><Copy size={13} /></Btn>}
      {p.status === "completed" && <a href={`/intake-forms/${p.id}/print`} target="_blank" rel="noreferrer"><Btn size="sm"><Printer size={13} /> Signed copy</Btn></a>}
      <Btn size="sm" variant="ghost" onClick={onOpen}>Open</Btn>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: number | string; sub?: string; tone?: "warn" }) {
  return (
    <div className={cn("rounded-xl border px-4 py-3", tone === "warn" ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800")}>
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{value}</p>
      {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One packet: answers, photos, signatures, audit trail
// ---------------------------------------------------------------------------

function PacketSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const q = trpc.workspace.intake.detail.useQuery({ id: id ?? 0 }, { enabled: !!id });
  const utils = trpc.useUtils();
  const resend = useResend();
  const refresh = () => { void utils.workspace.intake.invalidate(); void utils.workspace.tasks.invalidate(); };
  const filed = trpc.workspace.intake.markFiled.useMutation({ onSuccess: () => { refresh(); toast.success("Marked filed"); }, onError: (e) => toast.error(e.message) });
  const cancel = trpc.workspace.intake.cancel.useMutation({ onSuccess: () => { refresh(); toast.success("Cancelled; the link no longer works"); }, onError: (e) => toast.error(e.message) });
  const extend = trpc.workspace.intake.extend.useMutation({ onSuccess: () => { refresh(); toast.success("The link works for 14 more days"); }, onError: (e) => toast.error(e.message) });
  const p = q.data;
  const isOpen = p && (p.status === "waiting" || p.status === "opened" || p.status === "in_progress");
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto bg-white p-0 sm:max-w-xl dark:bg-slate-900">
        {!p && <SheetTitle className="sr-only">Patient forms</SheetTitle>}
        {q.isLoading && <Loading />}
        {q.error && <div className="p-5"><ErrorNote message={q.error.message} /></div>}
        {p && (
          <div className="text-sm">
            <SheetHeader className="border-b border-slate-200 p-5 dark:border-slate-700">
              <SheetTitle className="flex flex-wrap items-center gap-2 text-lg">
                {p.name}
                <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS_CLS[p.status])}>{PACKET_STATUS_LABELS[p.status]}</span>
              </SheetTitle>
              <SheetDescription>
                DOB {p.dob} · {LANG_LABELS[p.language as IntakeLang] ?? p.language}{p.clinic ? ` · ${p.clinic.name}` : ""}
                {p.subjectKey ? <> · <Link href={chartHref(p.subjectKey)} className="font-semibold text-brand hover:underline">Chart</Link></> : " · new patient"}
              </SheetDescription>
              <div className="flex flex-wrap gap-2 pt-2">
                {(p.status === "completed" || p.status === "filed") && (
                  <a href={`/intake-forms/${p.id}/print`} target="_blank" rel="noreferrer"><Btn size="sm"><Printer size={13} /> Save signed copy (PDF)</Btn></a>
                )}
                {p.status === "completed" && <Btn size="sm" variant="secondary" disabled={filed.isPending} onClick={() => filed.mutate({ id: p.id })}><FileCheck2 size={13} /> Mark filed in Practice Fusion</Btn>}
                {isOpen && !p.expired && p.phone && <Btn size="sm" variant="secondary" disabled={resend.busy} onClick={() => resend.text(p.id)}><MessageSquareText size={13} /> Text again</Btn>}
                {isOpen && !p.expired && p.email && <Btn size="sm" variant="secondary" disabled={resend.busy} onClick={() => resend.email(p.id)}><Mail size={13} /> Email again</Btn>}
                {isOpen && !p.expired && <Btn size="sm" variant="ghost" disabled={resend.busy} onClick={() => resend.link(p.id)}><Copy size={13} /> Copy link</Btn>}
                {isOpen && <Btn size="sm" variant="ghost" disabled={extend.isPending} onClick={() => extend.mutate({ id: p.id })}><CalendarClock size={13} /> Give 14 more days</Btn>}
                {isOpen && <Btn size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => { if (window.confirm("Cancel these forms? The link will stop working.")) cancel.mutate({ id: p.id }); }}><XCircle size={13} /> Cancel</Btn>}
              </div>
            </SheetHeader>

            <div className="space-y-5 p-5">
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Forms</h3>
                <ul className="space-y-1.5">
                  {p.forms.map((f) => {
                    const sig = p.signatures.find((x) => x.formKey === f.key);
                    return (
                      <li key={f.key} className="flex items-start gap-2">
                        {sig ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" /> : <Clock size={16} className="mt-0.5 shrink-0 text-slate-400" />}
                        <div>
                          <p className="font-medium">{f.title}</p>
                          {sig && <p className="text-xs text-slate-500">Signed by {sig.signerName}{sig.signerRelation !== "self" ? ` (${sig.relationLabel})` : ""} · {sig.method} · {when(sig.signedAt)}</p>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {p.forms.some((f) => f.kind === "questionnaire") && Object.keys(p.answers).length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Health history answers</h3>
                  <AnswerList packetId={p.id} answers={p.answers as Answers} files={p.files} />
                </section>
              )}

              {p.signatures.some((x) => x.text) && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Signed agreements</h3>
                  <p className="text-xs text-slate-500">The exact wording each patient signed is kept with the signature (see the signed copy).</p>
                </section>
              )}

              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">History</h3>
                <ol className="space-y-1 text-xs">
                  {p.events.map((e, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="w-32 shrink-0 text-slate-500">{when(e.at)}</span>
                      <span>{EVENT_LABELS[e.type] ?? e.type}{e.detail ? `: ${e.detail}` : ""}{e.userName ? ` · ${e.userName}` : ""}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function AnswerList({ packetId, answers, files }: { packetId: number; answers: Answers; files: { id: number; kind: string }[] }) {
  const [shown, setShown] = useState<number | null>(null);
  return (
    <div className="space-y-3">
      {MEDICAL_INTAKE.sections.map((s) => {
        const fields = s.fields.filter((f) => isVisible(f, answers));
        return (
          <div key={s.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <p className="mb-1.5 font-semibold">{s.title.en}</p>
            <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {fields.map((f) => {
                if (f.type === "photo") {
                  const file = files.find((x) => x.kind === f.photo);
                  return (
                    <div key={f.id} className="sm:col-span-2">
                      <dt className="text-xs text-slate-500">{f.label.en}</dt>
                      <dd>{file ? <button type="button" onClick={() => setShown(file.id)} className="inline-flex items-center gap-1 font-medium text-brand hover:underline"><ImageIcon size={13} /> View photo</button> : <span className="text-slate-400">No photo</span>}</dd>
                    </div>
                  );
                }
                const v = answerText(f, answers[f.id]);
                return (
                  <div key={f.id} className={f.type === "textarea" || f.type === "list" || f.type === "multi" ? "sm:col-span-2" : undefined}>
                    <dt className="text-xs text-slate-500">{f.label.en}</dt>
                    <dd className="whitespace-pre-line font-medium">{v || <span className="font-normal text-slate-400">—</span>}</dd>
                  </div>
                );
              })}
            </dl>
          </div>
        );
      })}
      {shown && <PhotoViewer packetId={packetId} fileId={shown} onClose={() => setShown(null)} />}
    </div>
  );
}

function PhotoViewer({ packetId, fileId, onClose }: { packetId: number; fileId: number; onClose: () => void }) {
  const f = trpc.workspace.intake.file.useQuery({ id: packetId, fileId });
  return (
    <div className="rounded-lg border border-slate-200 p-2 dark:border-slate-700">
      {f.isLoading && <Loader2 className="m-4 animate-spin" />}
      {f.data && <img src={f.data.dataUrl} alt="Patient photo" className="max-h-80 w-full rounded object-contain" />}
      <div className="mt-2 flex justify-end gap-2">
        {f.data && <a href={f.data.dataUrl} download={`${f.data.kind}.jpg`}><Btn size="sm" variant="secondary">Download</Btn></a>}
        <Btn size="sm" variant="ghost" onClick={onClose}>Close</Btn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form library: the practice's consents / agreements (wording pasted in by an admin)
// ---------------------------------------------------------------------------

type Doc = RouterOutputs["workspace"]["intake"]["documents"][number];

function Library({ isAdmin }: { isAdmin: boolean }) {
  const docs = trpc.workspace.intake.documents.useQuery();
  const [editing, setEditing] = useState<Doc | "new" | null>(null);
  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3 text-sm">
          <div className="max-w-2xl space-y-1 text-slate-600 dark:text-slate-300">
            <p><b>Health history form</b> is built in (English, Spanish, Arabic): contact details, emergency contact, pharmacy, insurance + card photos, conditions, medicines, allergies, family history and habits.</p>
            <p>Add each consent or agreement you used in BoldSign below: paste its wording exactly as it is now (and the Spanish / Arabic versions if you have them). Patients read it, can have it read aloud, and sign.</p>
          </div>
          {isAdmin && <Btn onClick={() => setEditing("new")}><Plus size={14} /> Add a form</Btn>}
        </div>
      </Panel>
      {docs.isLoading && <Loading />}
      {docs.data && docs.data.length === 0 && (
        <Panel><EmptyState icon={FilePlus2} title="No consents or agreements yet" body={isAdmin ? "Click Add a form and paste the wording of each form you send today." : "Ask an admin to add the practice's consents and agreements."} /></Panel>
      )}
      {(docs.data ?? []).length > 0 && (
        <Panel bodyClassName="p-0">
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {docs.data!.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div>
                  <p className="font-semibold">{d.title.en} {!d.active && <span className="ms-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 dark:bg-slate-800">Off</span>}</p>
                  <p className="text-xs text-slate-500">Version {d.version} · {INTAKE_LANGS.filter((l) => d.body[l]).map((l) => LANG_LABELS[l]).join(", ")} · updated {when(d.updatedAt)}</p>
                </div>
                {isAdmin && <Btn size="sm" variant="secondary" onClick={() => setEditing(d)}>Edit</Btn>}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {editing && <DocEditor doc={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function DocEditor({ doc, onClose }: { doc: Doc | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [lang, setLang] = useState<IntakeLang>("en");
  const [title, setTitle] = useState<Record<string, string>>(() => ({ ...(doc?.title ?? {}) }));
  const [body, setBody] = useState<Record<string, string>>(() => ({ ...(doc?.body ?? {}) }));
  const [active, setActive] = useState(doc?.active ?? true);
  const [preview, setPreview] = useState(false);
  const save = trpc.workspace.intake.saveDocument.useMutation({
    onSuccess: () => { void utils.workspace.intake.invalidate(); toast.success("Saved"); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  const blocks = useMemo(() => textBlocks(body[lang] ?? ""), [body, lang]);
  useEffect(() => setPreview(false), [lang]);
  return (
    <Panel title={doc ? `Edit: ${doc.title.en}` : "Add a form"} subtitle="Paste the wording exactly as your current form has it. Blank line = new paragraph; start a line with # for a heading, - for a bullet.">
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-1">
          {INTAKE_LANGS.map((l) => (
            <button key={l} type="button" onClick={() => setLang(l)} className={cn("rounded-full border px-3 py-1 text-xs font-semibold", lang === l ? "border-brand bg-brand/5" : "border-slate-200 dark:border-slate-700")}>
              {LANG_LABELS[l]}{l === "en" ? " (required)" : ""}{body[l]?.trim() ? " ✓" : ""}
            </button>
          ))}
        </div>
        <label className="block">
          <span className="mb-1 block font-medium">Title ({LANG_LABELS[lang]})</span>
          <input className={inputCls} dir={lang === "ar" ? "rtl" : "ltr"} value={title[lang] ?? ""} onChange={(e) => setTitle({ ...title, [lang]: e.target.value })} maxLength={200} placeholder={lang === "en" ? "e.g. Patient Consent Form" : ""} />
        </label>
        <div className="flex items-center justify-between">
          <span className="font-medium">Wording ({LANG_LABELS[lang]})</span>
          <button type="button" className="text-xs font-semibold text-brand hover:underline" onClick={() => setPreview(!preview)}>{preview ? "Edit" : "Preview"}</button>
        </div>
        {preview ? (
          <div dir={lang === "ar" ? "rtl" : "ltr"} className="max-h-96 space-y-3 overflow-y-auto rounded-lg border border-slate-200 p-4 text-base dark:border-slate-700">
            {blocks.map((b, i) => b.kind === "heading" ? <h4 key={i} className="font-bold">{b.text}</h4>
              : b.kind === "bullets" ? <ul key={i} className="list-disc ps-6">{b.items!.map((x, j) => <li key={j}>{x}</li>)}</ul>
              : <p key={i} className="whitespace-pre-line">{b.text}</p>)}
          </div>
        ) : (
          <textarea className={cn(inputCls, "h-80 font-mono text-xs leading-relaxed")} dir={lang === "ar" ? "rtl" : "ltr"} value={body[lang] ?? ""} onChange={(e) => setBody({ ...body, [lang]: e.target.value })} maxLength={60_000} />
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" className="size-4 accent-teal-700" checked={active} onChange={(e) => setActive(e.target.checked)} />
          On (can be sent to patients)
        </label>
        {doc && <p className="text-xs text-slate-500">Changing the wording makes a new version. Forms patients already signed keep the exact wording they signed.</p>}
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose}>Close</Btn>
          <Btn disabled={save.isPending || !title.en?.trim() || !body.en?.trim()} onClick={() => save.mutate({ id: doc?.id ?? null, title, body, active })}>
            {save.isPending && <Loader2 size={14} className="animate-spin" />} Save
          </Btn>
        </div>
      </div>
    </Panel>
  );
}
