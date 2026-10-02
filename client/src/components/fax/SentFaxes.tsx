import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { BookUser, CheckCircle2, Clock, Loader2, Pencil, RotateCcw, Send, Trash2, XCircle } from "lucide-react";
import { Btn, EmptyState, ErrorNote, Loading, Panel, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { formatPhone } from "@shared/phone";
import { normalizeFaxNumber, type OutboundFaxStatus } from "@shared/faxSend";
import { cn } from "@/lib/utils";

const fmtTime = (d: Date | string) => new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
const STATUS_CLS: Record<OutboundFaxStatus, string> = {
  sending: "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  queued: "bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200",
  sent: "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200",
  failed: "bg-rose-50 text-rose-800 dark:bg-rose-500/15 dark:text-rose-200",
};
const STATUS_ICON: Record<OutboundFaxStatus, React.ElementType> = { sending: Loader2, queued: Clock, sent: CheckCircle2, failed: XCircle };

/** Faxes sent from MyPCP: to whom, what, and whether RingCentral got them through. */
export function SentFaxes({ subjectKey, onSend }: { subjectKey?: string | null; onSend?: () => void }) {
  const q = trpc.workspace.faxOut.sent.useQuery({ subjectKey: subjectKey ?? null }, { refetchInterval: (query) => (query.state.data?.some((f) => f.status === "queued" || f.status === "sending") ? 20_000 : 120_000) });
  const utils = trpc.useUtils();
  const resend = trpc.workspace.faxOut.resend.useMutation({
    onSuccess: () => { toast.success("Sent again."); void utils.workspace.faxOut.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote message={q.error.message} />;
  if (!q.data?.length) return <Panel><EmptyState icon={Send} title="No faxes sent yet" body="Faxes sent from MyPCP show here with whether they went through." action={onSend && <Btn onClick={onSend}><Send size={14} /> Send a fax</Btn>} /></Panel>;
  return (
    <Panel bodyClassName="p-0">
      <ul className="divide-y divide-slate-100 dark:divide-slate-700">
        {q.data.map((f) => {
          const Icon = STATUS_ICON[f.status];
          return (
            <li key={f.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS_CLS[f.status])}>
                    <Icon size={11} className={f.status === "sending" ? "animate-spin" : undefined} /> {f.statusLabel}
                  </span>
                  <span className="font-semibold text-slate-900 dark:text-slate-50">{f.toName}</span>
                  <span className="text-xs text-slate-500">fax {formatPhone(f.toNumber)}</span>
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {fmtTime(f.at)} · from {f.clinic ?? "clinic"} · by {f.by?.replace(/\s*\(.*?\)/, "") ?? "someone"}{f.pages ? ` · ${f.pages} pages` : ""}
                  {f.patient && <> · {f.patient.id ? <Link href={`/patients/${f.patient.id}?tab=folder`} className="font-medium text-slate-700 hover:underline dark:text-slate-200">{f.patient.name}</Link> : f.patient.name}</>}
                </p>
                <p className="mt-0.5 truncate text-xs text-slate-500">{f.files.join(", ")}</p>
                {f.status === "failed" && f.error && <p className="mt-0.5 text-xs text-rose-700 dark:text-rose-300">{f.error}</p>}
              </div>
              {(f.status === "failed" || f.status === "sent") && (
                <Btn size="sm" variant={f.status === "failed" ? "primary" : "ghost"} disabled={resend.isPending}
                  onClick={() => { if (window.confirm(`Send this fax to ${f.toName} (${formatPhone(f.toNumber)}) again?`)) resend.mutate({ id: f.id }); }}>
                  <RotateCcw size={13} /> {f.status === "failed" ? "Try again" : "Send again"}
                </Btn>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** Saved fax numbers: add, rename, remove. */
export function FaxContacts() {
  const [q, setQ] = useState("");
  const list = trpc.workspace.faxOut.contacts.useQuery({ q: q || null });
  const utils = trpc.useUtils();
  const [edit, setEdit] = useState<{ id: number | null; name: string; faxNumber: string; note: string } | null>(null);
  const save = trpc.workspace.faxOut.saveContact.useMutation({
    onSuccess: () => { toast.success("Saved."); setEdit(null); void utils.workspace.faxOut.contacts.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.workspace.faxOut.removeContact.useMutation({ onSuccess: () => void utils.workspace.faxOut.contacts.invalidate(), onError: (e) => toast.error(e.message) });
  return (
    <Panel title="Fax contacts" subtitle="Specialists, pharmacies and hospitals you fax often." action={<Btn size="sm" onClick={() => setEdit({ id: null, name: "", faxNumber: "", note: "" })}><BookUser size={14} /> Add</Btn>} bodyClassName="p-0">
      <div className="border-b border-slate-100 p-3 dark:border-slate-700">
        <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or number" aria-label="Search fax contacts" />
      </div>
      {edit && (
        <div className="grid gap-2 border-b border-slate-100 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60 md:grid-cols-[1.4fr_1fr_1.4fr_auto]">
          <input className={inputCls} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Name" aria-label="Contact name" autoFocus />
          <input className={cn(inputCls, edit.faxNumber && !normalizeFaxNumber(edit.faxNumber) && "border-rose-400")} value={edit.faxNumber} onChange={(e) => setEdit({ ...edit, faxNumber: e.target.value })} placeholder="Fax number" inputMode="tel" aria-label="Fax number" />
          <input className={inputCls} value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} placeholder="Note (optional)" aria-label="Note" />
          <div className="flex gap-2">
            <Btn size="sm" disabled={save.isPending || !edit.name.trim() || !normalizeFaxNumber(edit.faxNumber)} onClick={() => save.mutate({ id: edit.id, name: edit.name, faxNumber: edit.faxNumber, note: edit.note || null })}>Save</Btn>
            <Btn size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Btn>
          </div>
        </div>
      )}
      {list.data && list.data.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-400">No contacts{q ? " match" : " yet. They're also saved when you send to a new number"}.</p>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-700">
        {(list.data ?? []).map((c) => (
          <li key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-slate-900 dark:text-slate-50">{c.name}</span>
              <span className="block text-xs text-slate-500">{formatPhone(c.faxNumber)}{c.note ? ` · ${c.note}` : ""}{c.lastUsedAt ? ` · last used ${fmtTime(c.lastUsedAt)}` : ""}</span>
            </span>
            <button onClick={() => setEdit({ id: c.id, name: c.name, faxNumber: c.faxNumber, note: c.note ?? "" })} aria-label={`Edit ${c.name}`}><Pencil size={14} className="text-slate-400 hover:text-slate-700" /></button>
            <button onClick={() => { if (window.confirm(`Remove ${c.name}?`)) remove.mutate({ id: c.id }); }} aria-label={`Remove ${c.name}`}><Trash2 size={14} className="text-slate-400 hover:text-rose-600" /></button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
