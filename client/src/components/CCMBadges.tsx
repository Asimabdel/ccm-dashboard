import { cn } from "@/lib/utils";
import {
  STATUS_LABELS,
  ESCALATION_STATUS_LABELS,
  BILLING_STATUS_LABELS,
  FOLLOWUP_STATUS_LABELS,
  statusBadgeClass,
  escalationBadgeClass,
} from "@/lib/ccm";

const base = "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap";

export function StatusBadge({ status }: { status: string }) {
  return <span className={cn(base, statusBadgeClass(status))}>{STATUS_LABELS[status] || status}</span>;
}

export function EscalationBadge({ status }: { status: string }) {
  return <span className={cn(base, escalationBadgeClass(status))}>{ESCALATION_STATUS_LABELS[status] || status}</span>;
}

export function BillingBadge({ status }: { status: string }) {
  const cls =
    status === "ready_for_billing" || status === "billed"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
      : status === "denied" || status === "needs_correction" || status === "documentation_incomplete"
      ? "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200"
      : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
  return <span className={cn(base, cls)}>{BILLING_STATUS_LABELS[status] || status}</span>;
}

export function FollowUpBadge({ status }: { status: string }) {
  const cls =
    status === "completed"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
      : status === "scheduled"
      ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200"
      : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
  return <span className={cn(base, cls)}>{FOLLOWUP_STATUS_LABELS[status] || status}</span>;
}
