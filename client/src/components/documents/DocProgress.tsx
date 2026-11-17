// Where a document stands: a step line (Prepare → Out for signature → Done), each signer's status with the
// time they opened or signed it, and the document's history as a timeline.
import { Check, CheckCircle2, Circle, Clock, Eye, FileUp, Files, PenLine, Send, Sparkles, XCircle, Download, FileStack, Stethoscope, FilePlus2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Doc } from "./editorShared";

const when = (d: Date | string | null | undefined, withDay = true) =>
  d ? new Date(d).toLocaleString("en-US", { timeZone: "America/Chicago", ...(withDay ? { month: "short", day: "numeric" } : {}), hour: "numeric", minute: "2-digit" }) : "";

type SignerState = { userId: number; name: string; state: "signed" | "opened" | "waiting"; at: Date | string | null };

/** Each signer: signed (when), opened it (first time after it was sent), or still waiting. */
export function signerStates(doc: Doc): SignerState[] {
  const sent = doc.sentAt ? new Date(doc.sentAt).getTime() : 0;
  return doc.signers.map((s) => {
    if (s.status === "signed") return { userId: s.userId, name: s.name ?? "Signer", state: "signed", at: s.signedAt };
    const opened = doc.events.find((e) => e.type === "viewed" && e.userId === s.userId && new Date(e.at).getTime() >= sent);
    return { userId: s.userId, name: s.name ?? "Signer", state: opened ? "opened" : "waiting", at: opened?.at ?? null };
  });
}

/** The strip under the editor's top bar. */
export function DocProgress({ doc }: { doc: Doc }) {
  if (doc.isTemplate) return null;
  const cancelled = doc.status === "cancelled";
  const withSigners = doc.signers.length > 0;
  const steps = withSigners ? ["Prepare", "Out for signature", "Done"] : ["Prepare", "Done"];
  const at = doc.status === "completed" ? steps.length - 1 : doc.status === "signing" ? 1 : 0;
  const people = signerStates(doc);
  const signed = people.filter((p) => p.state === "signed").length;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-slate-200 bg-white px-4 py-2 text-xs dark:border-slate-700 dark:bg-slate-800">
      {cancelled ? (
        <span className="inline-flex items-center gap-1.5 font-semibold text-rose-700 dark:text-rose-300"><XCircle size={14} /> Cancelled</span>
      ) : (
        <ol className="flex items-center gap-1.5" aria-label="Progress">
          {steps.map((s, i) => {
            const done = i < at || doc.status === "completed";
            const now = i === at && doc.status !== "completed";
            return (
              <li key={s} className="flex items-center gap-1.5">
                {i > 0 && <span className={cn("h-px w-6 sm:w-10", i <= at ? "bg-brand" : "bg-slate-300 dark:bg-slate-600")} />}
                <span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold",
                  done ? "bg-brand text-white" : now ? "bg-brand-soft text-brand ring-2 ring-brand dark:text-teal-300" : "bg-slate-100 text-slate-400 dark:bg-slate-700")}>
                  {done ? <Check size={11} strokeWidth={3} /> : i + 1}
                </span>
                <span className={cn("font-semibold", now ? "text-slate-900 dark:text-slate-50" : done ? "text-slate-700 dark:text-slate-200" : "text-slate-400")}>{s}</span>
              </li>
            );
          })}
        </ol>
      )}
      {withSigners && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-slate-500">{signed} of {people.length} signed:</span>
          {people.map((p) => (
            <span key={p.userId} title={p.state === "signed" ? `Signed ${when(p.at)}` : p.state === "opened" ? `Opened ${when(p.at)}, not signed yet` : "Hasn't opened it yet"}
              className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold",
                p.state === "signed" ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
                  : p.state === "opened" ? "bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300" : "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300")}>
              {p.state === "signed" ? <CheckCircle2 size={12} /> : p.state === "opened" ? <Eye size={12} /> : <Clock size={12} />}
              {p.name}
              {p.at && doc.status !== "draft" && <span className="font-normal opacity-80">· {when(p.at)}</span>}
            </span>
          ))}
        </div>
      )}
      {doc.patientName && <span className="ms-auto text-slate-500">Patient: <b className="text-slate-700 dark:text-slate-200">{doc.patientName}</b></span>}
    </div>
  );
}

const EVENTS: Record<string, { label: string; icon: React.ElementType }> = {
  created: { label: "Created", icon: FilePlus2 },
  uploaded: { label: "PDF added", icon: FileUp },
  pages_changed: { label: "Pages changed", icon: Files },
  ai_read: { label: "Read with AI", icon: Sparkles },
  template_saved: { label: "Saved as a template", icon: FileStack },
  sent: { label: "Sent for signature", icon: Send },
  viewed: { label: "Opened", icon: Eye },
  provider_signature: { label: "Provider's signature applied", icon: Stethoscope },
  signer_finished: { label: "Signed", icon: PenLine },
  completed: { label: "Done: signed PDF made", icon: CheckCircle2 },
  downloaded: { label: "Downloaded", icon: Download },
  cancelled: { label: "Cancelled", icon: XCircle },
};

/** The history as a timeline: each person's first opening only (opening it again isn't news). */
export function DocHistory({ doc }: { doc: Doc }) {
  const seenOpen = new Set<string>();
  const items = doc.events.filter((e) => {
    if (e.type !== "viewed") return true;
    const k = `${e.userId ?? e.name}`;
    if (seenOpen.has(k)) return false;
    seenOpen.add(k);
    return true;
  });
  return (
    <ol className="relative space-y-3 ps-1">
      {items.map((e, i) => {
        const ev = EVENTS[e.type] ?? { label: e.type.replace(/_/g, " "), icon: Circle };
        const Icon = ev.icon;
        return (
          <li key={i} className="relative flex gap-2.5">
            {i < items.length - 1 && <span className="absolute left-[11px] top-6 h-[calc(100%-6px)] w-px bg-slate-200 dark:bg-slate-700" aria-hidden />}
            <span className={cn("relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
              e.type === "completed" || e.type === "signer_finished" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : e.type === "cancelled" ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300")}>
              <Icon size={12} />
            </span>
            <div className="min-w-0 text-xs">
              <p className="font-semibold text-slate-800 dark:text-slate-100">{ev.label}{e.name ? <span className="font-normal text-slate-500"> · {e.name}</span> : null}</p>
              {e.detail && <p className="break-words text-slate-500">{e.detail}</p>}
              <p className="text-[11px] text-slate-400">{when(e.at)}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
