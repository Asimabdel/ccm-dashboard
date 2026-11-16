import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A depression / anxiety screening's score next to the form's name in a list ("12/27"):
 * amber from the cutoff up, red with a warning sign when the self-harm question was answered above "Not at all".
 */
export function ScoreChip({ score }: { score: { score: number; max: number; positive: boolean; risk: boolean } }) {
  return (
    <span title={score.risk ? "Self-harm question answered above \"Not at all\"" : score.positive ? "At or above the cutoff: worth a closer look" : "Screening score"}
      className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[11px] font-bold",
        score.risk ? "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200"
          : score.positive ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
          : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200")}>
      {score.risk && <AlertTriangle size={11} />}{score.score}/{score.max}
    </span>
  );
}
