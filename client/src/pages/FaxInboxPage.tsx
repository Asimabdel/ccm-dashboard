import { useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Ban, BookUser, CheckCircle2, Eye, ExternalLink, FileCheck2, Forward, Inbox, Loader2, Printer, Search, Send, Sparkles, UserCheck } from "lucide-react";
import { SendFaxDialog, type SendFaxPreset } from "@/components/fax/SendFaxDialog";
import { FaxContacts, SentFaxes } from "@/components/fax/SentFaxes";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, Panel, inputCls } from "@/components/workspace/ui";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDay } from "@shared/workforce";
import { formatPhone } from "@shared/phone";
import { FAX_DOC_TYPES, FAX_DOC_TYPE_KEYS, type FaxDocType } from "@shared/fax";

type Filter = "needs_patient" | "to_file" | "filed" | "not_patient" | "all";
type Tab = Filter | "sent" | "contacts";
const TABS: { k: Tab; label: string; icon: React.ElementType; sending?: boolean }[] = [
  { k: "needs_patient", label: "Needs a patient", icon: Inbox },
  { k: "to_file", label: "To file", icon: Printer },
  { k: "filed", label: "Filed", icon: FileCheck2 },
  { k: "not_patient", label: "Set aside", icon: Ban },
  { k: "all", label: "All (60 days)", icon: Printer },
  { k: "sent", label: "Sent", icon: Send, sending: true },
  { k: "contacts", label: "Contacts", icon: BookUser, sending: true },
];
const fmtTime = (d: Date | string) => new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
const dobText = (s: string | null) => (s ? fmtDay(s, { month: "short", day: "numeric", year: "numeric" }) : null);

/**
 * Faxes that arrived by email. MyPCP suggests the patient; staff confirm it, upload the fax to
 * the chart in Practice Fusion (Documents → Upload), and mark it filed.
 */
export default function FaxInboxPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const deepLink = typeof window !== "undefined" ? Number(new URLSearchParams(window.location.search).get("fax")) || null : null;
  const inbox = !!ws.caps?.emailTriage;
  const sending = !!ws.caps?.sendFax;
  const [tab, setTab] = useState<Tab>(deepLink ? "all" : "needs_patient");
  // People who send faxes but don't work the inbox start on Sent.
  useEffect(() => { if (ws.caps && !inbox && sending && !TABS.find((t) => t.k === tab)?.sending) setTab("sent"); }, [ws.caps, inbox, sending, tab]);
  const filter: Filter = (TABS.find((t) => t.k === tab)?.sending ? "needs_patient" : tab) as Filter;
  const receivedTab = !TABS.find((t) => t.k === tab)?.sending;
  const list = trpc.workspace.fax.list.useQuery({ filter }, { enabled: !!user && inbox && receivedTab, refetchInterval: 60_000 });
  const [sendOpen, setSendOpen] = useState<SendFaxPreset | null>(null);
  const utils = trpc.useUtils();
  const refresh = () => { void utils.workspace.fax.invalidate(); void utils.workspace.tasks.invalidate(); };
  const onError = (e: { message: string }) => toast.error(e.message);
  const [picking, setPicking] = useState<{ id: number; docType: FaxDocType | null; hint: string | null } | null>(null);
  const [viewing, setViewing] = useState<{ url: string; name: string; mime: string } | null>(null);
  const [opening, setOpening] = useState<number | null>(null);

  const open = trpc.workspace.fax.open.useMutation({ onError });
  const view = async (id: number) => {
    setOpening(id);
    try {
      const r = await open.mutateAsync(id);
      const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
      setViewing({ url: URL.createObjectURL(new Blob([bytes], { type: r.mimeType })), name: r.filename, mime: r.mimeType });
    } finally { setOpening(null); }
  };
  useEffect(() => () => { if (viewing) URL.revokeObjectURL(viewing.url); }, [viewing]);
  useEffect(() => { if (deepLink && list.data?.some((f) => f.id === deepLink)) document.getElementById(`fax-${deepLink}`)?.scrollIntoView({ block: "center" }); }, [deepLink, list.data]);

  const assign = trpc.workspace.fax.assign.useMutation({ onSuccess: (r) => { refresh(); toast.success(`Matched. Filing task sent to the ${r.assignedTo}.`); setPicking(null); }, onError });
  const filed = trpc.workspace.fax.markFiled.useMutation({ onSuccess: () => { refresh(); toast.success("Marked as filed in Practice Fusion"); }, onError });
  const aside = trpc.workspace.fax.notPatient.useMutation({ onSuccess: () => { refresh(); toast.success("Set aside"); }, onError });
  const reread = trpc.workspace.fax.reread.useMutation({
    onSuccess: (r) => { refresh(); r?.status === "to_file" ? toast.success("Read and matched to the patient") : toast.info(r?.aiError ?? "Read — pick the patient to confirm"); },
    onError,
  });

  const rows = list.data ?? [];
  return (
    <CCMDashboardLayout title="Faxes" pageTitle={false}>
      <PageHeader title="Faxes"
        subtitle={inbox ? "Faxes that arrive by email: confirm the patient, upload the fax to their chart in Practice Fusion (Documents → Upload), then mark it filed. Send faxes through RingCentral from each clinic's fax number." : "Send faxes through RingCentral from your clinic's fax number."}
        actions={sending ? <Btn onClick={() => setSendOpen({})}><Send size={15} /> Send a fax</Btn> : undefined} />
      {ws.caps && !inbox && !sending && <ErrorNote message="You don't have access to faxes." />}
      <div className="flex gap-1 mb-5 border-b border-slate-200 dark:border-slate-700 overflow-x-auto" role="tablist">
        {TABS.filter((t) => (t.sending ? sending : inbox)).map((t) => (
          <button key={t.k} role="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)}
            className={cn("flex shrink-0 items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap", tab === t.k ? "border-brand text-slate-900 dark:text-slate-50" : "border-transparent text-slate-500 hover:text-slate-800")}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      {tab === "sent" && sending && <SentFaxes onSend={() => setSendOpen({})} />}
      {tab === "contacts" && sending && <FaxContacts />}
      {receivedTab && list.isLoading && <Loading />}
      {receivedTab && list.error && <ErrorNote message={list.error.message} />}
      {receivedTab && list.data && rows.length === 0 && (
        <Panel><EmptyState icon={Printer} title={filter === "needs_patient" ? "Nothing waiting" : "No faxes here"}
          body={filter === "needs_patient" ? "Every fax has been matched to a patient or set aside." : "Faxes show up once the practice mailbox (or a fax mailbox) is connected in Admin → Integrations."} /></Panel>
      )}
      {receivedTab && rows.length > 0 && (
        <Panel bodyClassName="p-0">
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {rows.map((f) => {
              const from = f.aiSender ?? f.fromName ?? (f.fromNumber ? formatPhone(f.fromNumber) : f.fromEmail) ?? "Unknown sender";
              const waiting = f.status === "new" || f.status === "needs_patient";
              return (
                <li key={f.id} id={`fax-${f.id}`} className={cn("px-4 py-3 text-sm", deepLink === f.id && "bg-amber-50/70 dark:bg-amber-900/20")}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        {f.docType && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">{FAX_DOC_TYPES[f.docType] ?? f.docType}</span>}
                        <span className="font-semibold text-slate-900 dark:text-slate-50 truncate">{f.aiSummary || f.subject || "Fax"}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {from} · {fmtTime(f.receivedAt)}{f.pages ? ` · ${f.pages} page${f.pages === 1 ? "" : "s"}` : ""}
                        {f.fromNumber && f.aiSender ? ` · fax ${formatPhone(f.fromNumber)}` : ""}
                      </p>
                      {(f.status === "to_file" || f.status === "filed") && f.patientName && (
                        <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
                          {f.patientId ? <Link href={`/patients/${f.patientId}?tab=overview`} className="font-semibold hover:underline">{f.patientName}</Link> : <b>{f.patientName}</b>}
                          {" "}({f.matchMethod === "ai" ? "matched by name + date of birth" : "picked by staff"})
                          {f.status === "to_file" ? <> → {f.assignee ?? "front desk queue"}{f.taskId && <> · <Link href={`/my-work?task=${f.taskId}`} className="underline">task</Link></>}</> : <> · <b>filed</b>{f.filedAt ? ` ${fmtTime(f.filedAt)}` : ""}</>}
                        </p>
                      )}
                      {waiting && (
                        <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                          {f.status === "new" ? <span className="inline-flex items-center gap-1 text-slate-500"><Loader2 size={11} className="animate-spin" /> Reading…</span>
                            : f.suggestedName ? <>Possible match: <b>{f.suggestedName}</b> (name only, please confirm){f.aiDob ? ` · the fax says DOB ${dobText(f.aiDob)}` : ""}</>
                            : f.aiPatientName ? <>The fax says <b>{f.aiPatientName}</b>{f.aiDob ? `, DOB ${dobText(f.aiDob)}` : ""}: not found in MyPCP. Pick the patient.</>
                            : f.aiError ? <span className="text-slate-500">{f.aiError}. Open it and pick the patient.</span>
                            : <span className="text-slate-500">Open it and pick the patient.</span>}
                        </p>
                      )}
                      {f.status === "not_patient" && <p className="mt-1 text-xs text-slate-400">Set aside: not for a patient</p>}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Btn size="sm" variant="secondary" disabled={opening === f.id} onClick={() => view(f.id)}>{opening === f.id ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />} View</Btn>
                      {f.link && <a href={f.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-900"><ExternalLink size={13} /> Gmail</a>}
                      {waiting && f.suggestedKey && (
                        <Btn size="sm" disabled={assign.isPending} onClick={() => assign.mutate({ faxId: f.id, subjectKey: f.suggestedKey!, docType: f.docType })}><CheckCircle2 size={13} /> Confirm</Btn>
                      )}
                      {f.status !== "not_patient" && f.status !== "filed" && (
                        <Btn size="sm" variant={waiting && !f.suggestedKey ? "primary" : "secondary"} onClick={() => setPicking({ id: f.id, docType: f.docType, hint: f.aiPatientName })}>
                          <UserCheck size={13} /> {waiting ? "Pick patient" : "Change"}
                        </Btn>
                      )}
                      {f.status === "to_file" && <Btn size="sm" disabled={filed.isPending} onClick={() => filed.mutate(f.id)}><FileCheck2 size={13} /> Mark filed</Btn>}
                      {f.status === "needs_patient" && /pdf/i.test(f.mimeType || f.filename || "") && (
                        <Btn size="sm" variant="ghost" disabled={reread.isPending} onClick={() => reread.mutate(f.id)} title="Read this fax with AI again"><Sparkles size={13} /></Btn>
                      )}
                      {waiting && <Btn size="sm" variant="ghost" disabled={aside.isPending} onClick={() => aside.mutate(f.id)}><Ban size={13} /> Not a patient</Btn>}
                      {sending && f.status !== "new" && (
                        <Btn size="sm" variant="ghost" title="Fax this on to someone else" onClick={() => setSendOpen({
                          subjectKey: f.subjectKey, patientName: f.patientName,
                          attachments: [{ ref: { kind: "fax", id: f.id }, name: f.aiSummary || f.filename || "Fax", size: f.sizeBytes, detail: "Fax we received" }],
                        })}><Forward size={13} /> Forward</Btn>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
      <SendFaxDialog open={!!sendOpen} onOpenChange={(o) => !o && setSendOpen(null)} preset={sendOpen ?? undefined} />
      {picking && <PickDialog fax={picking} busy={assign.isPending} onClose={() => setPicking(null)} onPick={(subjectKey, docType) => assign.mutate({ faxId: picking.id, subjectKey, docType })} />}
      {viewing && (
        <Dialog open onOpenChange={(o) => !o && setViewing(null)}>
          <DialogContent className="sm:max-w-4xl h-[88vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>{viewing.name}</DialogTitle>
              <DialogDescription>Straight from the mailbox; MyPCP doesn't keep a copy. <a className="underline" href={viewing.url} download={viewing.name}>Download</a> to upload it in Practice Fusion.</DialogDescription>
            </DialogHeader>
            {/pdf/i.test(viewing.mime)
              ? <iframe title="Fax" src={viewing.url} className="flex-1 w-full rounded-lg border border-slate-200 dark:border-slate-700" />
              : <p className="text-sm text-slate-600">This fax is a TIFF image, which browsers can't show. Download it to open it.</p>}
          </DialogContent>
        </Dialog>
      )}
    </CCMDashboardLayout>
  );
}

function PickDialog({ fax, busy, onClose, onPick }: { fax: { id: number; docType: FaxDocType | null; hint: string | null }; busy: boolean; onClose: () => void; onPick: (subjectKey: string, docType: FaxDocType) => void }) {
  const [q, setQ] = useState(fax.hint ?? "");
  const [docType, setDocType] = useState<FaxDocType>(fax.docType ?? "other");
  const search = trpc.workspace.email.search.useQuery({ q }, { enabled: q.trim().length >= 2 });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Who is this fax for?</DialogTitle>
          <DialogDescription>A filing task goes to the right person; they upload the fax to the chart in Practice Fusion.</DialogDescription>
        </DialogHeader>
        <label className="block text-xs font-semibold text-slate-600">What it is
          <select className={cn(inputCls, "mt-1")} value={docType} onChange={(e) => setDocType(e.target.value as FaxDocType)}>
            {FAX_DOC_TYPE_KEYS.map((k) => <option key={k} value={k}>{FAX_DOC_TYPES[k]}</option>)}
          </select>
        </label>
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input autoFocus className={`${inputCls} pl-9`} placeholder="Search by patient name" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="max-h-72 overflow-y-auto -mx-1">
          {search.isFetching && <Loader2 size={16} className="animate-spin text-slate-400 m-3" />}
          {search.data?.length === 0 && <p className="px-2 py-3 text-sm text-slate-500">No patient by that name.</p>}
          {(search.data ?? []).map((p) => (
            <button key={p.key} disabled={busy} onClick={() => onPick(p.key, docType)} className="w-full text-left rounded-lg px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
              <span className="block text-sm font-medium text-slate-900 dark:text-slate-50">{p.name}</span>
              <span className="block text-xs text-slate-500">DOB {p.dob ? dobText(p.dob) : "unknown"}{p.clinicName ? ` · ${p.clinicName}` : ""}{p.patientId ? "" : " · not on CCM roster"}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
