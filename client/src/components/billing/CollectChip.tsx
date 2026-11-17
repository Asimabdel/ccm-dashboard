import { Banknote, Wallet } from "lucide-react";
import type { CollectNote } from "@shared/visitCost";
import { cn } from "@/lib/utils";

const TONES: Record<CollectNote["kind"], string> = {
  copay: "bg-teal-50 text-teal-800 ring-teal-200 dark:bg-teal-950/40 dark:text-teal-200 dark:ring-teal-900",
  deductible: "bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-200 dark:ring-violet-900",
  coinsurance: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900",
  nothing: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  info: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
};

/** Said with every estimate, so nobody takes it for the insurance's own answer. */
export const ESTIMATE_NOTE = "An estimate from past insurance payments, not a quote: plans change, so confirm with the patient's card.";

/**
 * What to expect at check-in (2026-11-17): the patient's copay or deductible as insurance applied it
 * on their past visits, or for a patient with no visits yet, what others on the same plan paid.
 * Hover for where it comes from.
 */
export function CollectChip({ note, className }: { note: CollectNote; className?: string }) {
  const Icon = note.kind === "deductible" ? Wallet : Banknote;
  return (
    <span title={`${note.detail} ${ESTIMATE_NOTE}`} className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ring-1", TONES[note.kind], className)}>
      <Icon size={10} aria-hidden /> {note.label}
    </span>
  );
}
