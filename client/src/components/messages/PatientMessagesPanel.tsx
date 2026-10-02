import { useState } from "react";
import { useLocation } from "wouter";
import { HeartPulse, MessageSquarePlus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Btn, EmptyState, ErrorNote, Loading, Panel, fmtClock, fmtShortDate } from "@/components/workspace/ui";
import { NewConversationDialog } from "./NewConversationDialog";

/** Patient 360 → Messages: the conversations about this patient that I'm in, and starting a new one. */
export function PatientMessagesPanel({ subjectKey, name }: { subjectKey: string; name: string }) {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const q = trpc.workspace.chat.forPatient.useQuery({ subjectKey });
  return (
    <Panel title="Conversations about this patient" subtitle="Only the people in a conversation can read it." action={<Btn size="sm" onClick={() => setOpen(true)}><MessageSquarePlus size={14} /> Message about this patient</Btn>} bodyClassName="p-0">
      {q.isLoading && <Loading />}
      {q.error && <div className="p-4"><ErrorNote message={q.error.message} /></div>}
      {q.data && q.data.length === 0 && <EmptyState icon={HeartPulse} title="No conversations yet" body="Start one to talk with the people working on this patient." />}
      {q.data?.map((c) => (
        <button key={c.id} onClick={() => setLocation(`/messages?c=${c.id}`)} className="flex w-full items-center justify-between gap-3 border-b border-slate-100 px-5 py-3 text-left last:border-0 hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-700/40">
          <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{c.title}</span>
          <span className="shrink-0 text-xs text-slate-400">{fmtShortDate(c.lastMessageAt)} · {fmtClock(c.lastMessageAt)}</span>
        </button>
      ))}
      <NewConversationDialog open={open} onOpenChange={setOpen} mode="patient" patient={{ key: subjectKey, name }} onOpened={(id) => setLocation(`/messages?c=${id}`)} />
    </Panel>
  );
}
