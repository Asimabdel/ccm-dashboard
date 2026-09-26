import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { ExternalLink, Inbox, Loader2, Mail, Search, UserCheck, UserX } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { Btn, EmptyState, ErrorNote, Loading, PageHeader, Panel, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDay } from "@shared/workforce";

const METHOD: Record<string, string> = { address: "known address", name: "sender's name", phone: "phone number in email", manual: "linked by staff" };
const fmtTime = (d: Date | string) => new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

/**
 * Emails from the practice mailbox. The ones MyPCP couldn't match to a patient wait here:
 * pick the patient once and that address is remembered for next time.
 */
export default function PatientEmailsPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const ws = useWorkspace();
  const [filter, setFilter] = useState<"needs_patient" | "all">("needs_patient");
  const list = trpc.workspace.email.list.useQuery({ filter }, { enabled: !!user && !!ws.caps?.emailTriage, refetchInterval: 60_000 });
  const utils = trpc.useUtils();
  const [linking, setLinking] = useState<{ id: number; from: string } | null>(null);
  const ignore = trpc.workspace.email.ignore.useMutation({
    onSuccess: () => { void utils.workspace.email.invalidate(); void utils.workspace.tasks.invalidate(); toast.success("Hidden — emails from that address will be ignored."); },
    onError: (e) => toast.error(e.message),
  });

  const rows = list.data ?? [];
  return (
    <CCMDashboardLayout title="Patient emails" pageTitle={false}>
      <PageHeader title="Patient emails" subtitle="Emails from the practice mailbox. Matched ones are already tasks in My Work; pick the patient for the rest." />
      {ws.caps && !ws.caps.emailTriage && <ErrorNote message="You don't have access to patient emails." />}
      <div className="flex gap-1 mb-5 border-b border-slate-200 dark:border-slate-700" role="tablist">
        {[{ k: "needs_patient", label: "Needs a patient", icon: Inbox }, { k: "all", label: "All emails (30 days)", icon: Mail }].map((t) => (
          <button key={t.k} role="tab" aria-selected={filter === t.k} onClick={() => setFilter(t.k as typeof filter)}
            className={cn("flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px", filter === t.k ? "border-brand text-slate-900 dark:text-slate-50" : "border-transparent text-slate-500 hover:text-slate-800")}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      {list.isLoading && <Loading />}
      {list.error && <ErrorNote message={list.error.message} />}
      {list.data && rows.length === 0 && (
        <Panel><EmptyState icon={Inbox} title={filter === "needs_patient" ? "Nothing waiting" : "No emails yet"} body={filter === "needs_patient" ? "Every recent email has been matched to a patient or set aside." : "Emails show up here once the practice mailbox is connected (Admin → Integrations)."} /></Panel>
      )}
      {rows.length > 0 && (
        <Panel bodyClassName="p-0">
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {rows.map((m) => (
              <li key={m.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-900 dark:text-slate-50 truncate">{m.subject || "(no subject)"}</p>
                    <p className="text-xs text-slate-500 truncate">{m.fromName ? `${m.fromName} · ` : ""}{m.fromEmail} · {fmtTime(m.receivedAt)}</p>
                    {m.preview && <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 line-clamp-2 whitespace-pre-line">{m.preview}</p>}
                    {m.status === "assigned" && (
                      <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
                        {m.patientId ? <Link href={`/patients/${m.patientId}?tab=overview`} className="font-semibold hover:underline">{m.patientName}</Link> : <b>{m.patientName}</b>}
                        {" "}({METHOD[m.matchMethod ?? ""] ?? m.matchMethod}) → {m.assigneeName ?? "front desk queue"}
                        {m.taskId && <> · <Link href={`/my-work?task=${m.taskId}`} className="underline">task</Link></>}
                      </p>
                    )}
                    {m.status === "ignored" && <p className="mt-1 text-xs text-slate-400">Not a patient email</p>}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {m.link && <a href={m.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-900"><ExternalLink size={13} /> Gmail</a>}
                    {m.status !== "ignored" && (
                      <Btn size="sm" variant={m.status === "needs_patient" ? "primary" : "secondary"} onClick={() => setLinking({ id: m.id, from: m.fromName ?? m.fromEmail ?? "this sender" })}>
                        <UserCheck size={14} /> {m.status === "needs_patient" ? "Pick patient" : "Wrong patient?"}
                      </Btn>
                    )}
                    {m.status === "needs_patient" && (
                      <Btn size="sm" variant="ghost" disabled={ignore.isPending} onClick={() => ignore.mutate(m.id)}><UserX size={14} /> Not a patient</Btn>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {linking && <LinkDialog email={linking} onClose={() => setLinking(null)} />}
    </CCMDashboardLayout>
  );
}

function LinkDialog({ email, onClose }: { email: { id: number; from: string }; onClose: () => void }) {
  const [q, setQ] = useState("");
  const search = trpc.workspace.email.search.useQuery({ q }, { enabled: q.trim().length >= 2 });
  const utils = trpc.useUtils();
  const link = trpc.workspace.email.link.useMutation({
    onSuccess: (r) => { void utils.workspace.email.invalidate(); void utils.workspace.tasks.invalidate(); toast.success(`Linked and sent to the ${r.assignedTo}. Emails from this address will match automatically.`); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Which patient is {email.from}?</DialogTitle>
          <DialogDescription>MyPCP remembers this address, so their next emails go straight to the right person.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input autoFocus className={`${inputCls} pl-9`} placeholder="Search by patient name" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="max-h-80 overflow-y-auto -mx-1">
          {search.isFetching && <Loader2 size={16} className="animate-spin text-slate-400 m-3" />}
          {search.data?.length === 0 && <p className="px-2 py-3 text-sm text-slate-500">No patient by that name.</p>}
          {(search.data ?? []).map((p) => (
            <button key={p.key} disabled={link.isPending} onClick={() => link.mutate({ emailId: email.id, subjectKey: p.key })}
              className="w-full text-left rounded-lg px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
              <span className="block text-sm font-medium text-slate-900 dark:text-slate-50">{p.name}</span>
              <span className="block text-xs text-slate-500">DOB {p.dob ? fmtDay(p.dob, { month: "short", day: "numeric", year: "numeric" }) : "unknown"}{p.clinicName ? ` · ${p.clinicName}` : ""}{p.phoneLast4 ? ` · phone …${p.phoneLast4}` : ""}{p.patientId ? "" : " · not on CCM roster"}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
