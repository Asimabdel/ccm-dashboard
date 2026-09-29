import { useState } from "react";
import { Link } from "wouter";
import { Check, CheckCircle2, ClipboardSignature, Clock, Globe, Printer, Send, XCircle } from "lucide-react";
import { Btn, EmptyState, ErrorNote, Loading, Panel } from "@/components/workspace/ui";
import { SendFormsDialog } from "@/components/intake/SendFormsDialog";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { PACKET_STATUS_LABELS } from "@shared/intake";

const day = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" }) : "";

const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  consented: { label: "Consented", cls: "text-emerald-700 dark:text-emerald-300" },
  declined: { label: "Declined", cls: "text-red-700 dark:text-red-300" },
  pending: { label: "Pending", cls: "text-amber-700 dark:text-amber-300" },
};

/** Patient 360 → Forms: where each consent stands, and every form this person was sent or signed (all years). */
export function PatientFormsPanel({ subjectKey }: { subjectKey: string }) {
  const q = trpc.workspace.intake.forSubject.useQuery({ subjectKey });
  const [sending, setSending] = useState(false);
  const data = q.data;
  return (
    <div className="space-y-5">
      <Panel
        title="Consents"
        subtitle="From the patient record (CCM / BHI / APCM, used for billing) and the most recent signed form for each."
        action={<Btn size="sm" onClick={() => setSending(true)}><Send size={13} /> Send forms</Btn>}
      >
        {q.isLoading && <Loading />}
        {q.error && <ErrorNote message={q.error.message} />}
        {data && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {data.consents.map((c) => {
              const st = c.status ? STATUS_TEXT[c.status] : null;
              return (
                <div key={c.kind} className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
                  <p className="font-semibold">{c.label}</p>
                  {c.kind !== "communications" && (
                    <p className={cn("mt-1 font-semibold", st?.cls ?? "text-slate-500")}>
                      {st ? st.label : "Not on the CCM roster"}{c.since && c.status === "consented" ? ` · ${day(c.since)}` : ""}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-slate-500">
                    {c.lastForm ? (
                      <>
                        {c.lastForm.decision === "declined" ? "Said no" : "Signed"} on a form {day(c.lastForm.at)} ·{" "}
                        <Link href={`/intake-forms?p=${c.lastForm.packetId}`} className="font-semibold text-brand hover:underline">Open</Link>
                      </>
                    ) : "No signed form on file"}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="Forms" subtitle="Everything sent to or signed by this patient, newest first." bodyClassName="p-0">
        {data && data.packets.length === 0 && (
          <EmptyState icon={ClipboardSignature} title="No forms yet" body="Send intake forms or a consent from here." action={<Btn onClick={() => setSending(true)}><Send size={14} /> Send forms</Btn>} />
        )}
        {data && data.packets.length > 0 && (
          <ul className="divide-y divide-slate-100 dark:divide-slate-700">
            {data.packets.map((p) => (
              <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{day(p.completedAt ?? p.createdAt)}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">{PACKET_STATUS_LABELS[p.status]}</span>
                    {p.expired && <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">Link expired</span>}
                    {p.source === "website" && <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800 dark:bg-violet-900/40 dark:text-violet-200"><Globe size={11} /> Website</span>}
                  </p>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                    {p.forms.map((f) => (
                      <span key={f.key} className="inline-flex items-center gap-1">
                        {f.declined ? <XCircle size={12} className="text-slate-500" /> : f.signed ? <Check size={12} className="text-emerald-600" /> : <Clock size={12} className="text-slate-400" />}
                        {f.title}{f.declined ? " (said no)" : ""}
                      </span>
                    ))}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {(p.status === "completed" || p.status === "filed") && (
                    <a href={`/intake-forms/${p.id}/print`} target="_blank" rel="noreferrer"><Btn size="sm" variant="secondary"><Printer size={13} /> Signed copy</Btn></a>
                  )}
                  <Link href={`/intake-forms?p=${p.id}`}><Btn size="sm" variant="ghost">{p.status === "completed" ? <><CheckCircle2 size={13} /> File</> : "Open"}</Btn></Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <SendFormsDialog open={sending} onClose={() => { setSending(false); void q.refetch(); }} preset={{ subjectKey }} />
    </div>
  );
}
