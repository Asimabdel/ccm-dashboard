import { cn } from "@/lib/utils";
import { BILL_STATUS_LABELS, type BillStatus } from "@shared/billCodes";

export const STATUS_CLASS: Record<BillStatus, string> = {
  paid: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900",
  partly_paid: "bg-teal-50 text-teal-800 ring-teal-200 dark:bg-teal-950/40 dark:text-teal-200 dark:ring-teal-900",
  denied: "bg-red-50 text-red-800 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900",
  patient_owes: "bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-200 dark:ring-violet-900",
  waiting: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900",
  rejected: "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900",
  taken_back: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700",
};

export function StatusBadge({ status }: { status: BillStatus }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", STATUS_CLASS[status] ?? STATUS_CLASS.taken_back)}>{BILL_STATUS_LABELS[status] ?? status}</span>;
}
