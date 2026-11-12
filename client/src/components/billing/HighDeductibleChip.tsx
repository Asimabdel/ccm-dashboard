import { Wallet } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "High deductible: collect at check-in" (2026-11-12): insurance applied this patient's deductible on
 * 2+ visits in the last 12 months (from the payment files the owner uploads to Master Billing).
 * Staff see this note and the visit count only, never amounts.
 */
export function HighDeductibleChip({ visits, className }: { visits: number; className?: string }) {
  return (
    <span
      title={`Insurance applied this patient's deductible on ${visits} visits in the last 12 months, so they likely have a high-deductible plan. Check their balance and collect at check-in, per the practice's policy.`}
      className={cn("inline-flex items-center gap-1 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold text-violet-800 ring-1 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-200 dark:ring-violet-900", className)}>
      <Wallet size={10} aria-hidden /> High deductible: collect at check-in
    </span>
  );
}
