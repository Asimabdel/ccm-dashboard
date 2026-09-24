import React from "react";
import { Link } from "wouter";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CLINIC_TZ } from "@shared/workforce";
import { FLOW_LABELS, TASK_PRIORITY_LABELS, TASK_STATUS_LABELS, type FlowStatus, type TaskPriority, type TaskStatus } from "@shared/workspace";

// ---------------------------------------------------------------------------
// Formatting (all clinic-local: the four clinics are in Houston)
// ---------------------------------------------------------------------------

export function fmtClock(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleTimeString("en-US", { timeZone: CLINIC_TZ, hour: "numeric", minute: "2-digit" });
}

export function fmtShortDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { timeZone: CLINIC_TZ, month: "short", day: "numeric", year: "numeric" });
}

/** DOBs are stored as calendar dates; format in UTC so they never shift a day. */
export function fmtDob(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { timeZone: "UTC", month: "2-digit", day: "2-digit", year: "numeric" });
}

export function ageFrom(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const b = new Date(d);
  const now = new Date();
  let a = now.getUTCFullYear() - b.getUTCFullYear();
  if (now.getUTCMonth() < b.getUTCMonth() || (now.getUTCMonth() === b.getUTCMonth() && now.getUTCDate() < b.getUTCDate())) a--;
  return a;
}

export function minutesSince(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 60000));
}

export function fmtMinutes(m: number | null): string {
  if (m == null) return "—";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "Today", "Tomorrow", "3 days overdue", "Sep 30". */
export function fmtDue(due: string | null, today: string): { text: string; overdue: boolean; today: boolean } {
  if (!due) return { text: "No due date", overdue: false, today: false };
  if (due === today) return { text: "Due today", overdue: false, today: true };
  const diff = Math.round((Date.parse(`${due}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (diff < 0) return { text: `${-diff} day${diff === -1 ? "" : "s"} overdue`, overdue: true, today: false };
  if (diff === 1) return { text: "Due tomorrow", overdue: false, today: false };
  return { text: `Due ${new Date(`${due}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })}`, overdue: false, today: false };
}

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
      <div className="min-w-0">
        <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Small uppercase heading above a group of cards ("TODAY", "TODAY'S PRIORITIES"). */
export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={cn("mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400", className)}>{children}</h3>;
}

export const cardCls = "bg-white rounded-xl border border-slate-200 dark:border-slate-700 shadow-[0_1px_2px_rgba(20,21,25,0.04)]";

export function Panel({ title, subtitle, action, children, className, bodyClassName }: { title?: React.ReactNode; subtitle?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn(cardCls, className)}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-slate-100 dark:border-slate-700">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
            {subtitle && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Soft colored icon tile: the tone carries meaning, the label next to it says what. */
export type Tone = "info" | "brand" | "success" | "warning" | "danger" | "violet" | "neutral";
export const TONE_TILE: Record<Tone, string> = {
  info: "bg-tone-info-soft text-tone-info dark:bg-sky-500/15 dark:text-sky-300",
  brand: "bg-brand-soft text-brand dark:bg-orange-500/15 dark:text-orange-300",
  success: "bg-tone-success-soft text-tone-success dark:bg-emerald-500/15 dark:text-emerald-300",
  warning: "bg-tone-warning-soft text-tone-warning dark:bg-amber-500/15 dark:text-amber-300",
  danger: "bg-tone-danger-soft text-tone-danger dark:bg-rose-500/15 dark:text-rose-300",
  violet: "bg-tone-violet-soft text-tone-violet dark:bg-violet-500/15 dark:text-violet-300",
  neutral: "bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300",
};
export const TONE_TEXT: Record<Tone, string> = {
  info: "text-tone-info dark:text-sky-300",
  brand: "text-brand dark:text-orange-300",
  success: "text-tone-success dark:text-emerald-300",
  warning: "text-tone-warning dark:text-amber-300",
  danger: "text-tone-danger dark:text-rose-300",
  violet: "text-tone-violet dark:text-violet-300",
  neutral: "text-slate-500 dark:text-slate-400",
};

export function ToneTile({ icon: Icon, tone = "neutral", size = "md" }: { icon: React.ElementType; tone?: Tone; size?: "sm" | "md" }) {
  return (
    <span className={cn("inline-flex items-center justify-center rounded-lg shrink-0", size === "sm" ? "w-7 h-7" : "w-9 h-9", TONE_TILE[tone])}>
      <Icon size={size === "sm" ? 14 : 17} />
    </span>
  );
}

// `tone` colors the hint line (e.g. "2 overdue" in red); the number stays neutral.
const HINT_TONES = {
  neutral: "text-slate-500 dark:text-slate-400",
  good: "text-tone-success dark:text-emerald-300",
  warn: "text-tone-warning dark:text-amber-300",
  bad: "text-tone-danger dark:text-rose-300",
  accent: "text-brand dark:text-orange-300",
} as const;

export function MetricCard({ label, value, hint, tone = "neutral", icon, iconTone = "neutral", href }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: keyof typeof HINT_TONES; icon?: React.ElementType; iconTone?: Tone; href?: string }) {
  const body = (
    <div className={cn(cardCls, "h-full p-4 transition-colors", href && "hover:border-slate-300 cursor-pointer")}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">{label}</p>
        {icon && <ToneTile icon={icon} tone={iconTone} size="sm" />}
      </div>
      <p className="mt-2 text-[28px] leading-none font-semibold tabular-nums tracking-tight text-slate-900 dark:text-slate-50">{value}</p>
      {hint && <p className={cn("mt-2 text-xs", HINT_TONES[tone])}>{hint}</p>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export function EmptyState({ icon: Icon, title, body, action }: { icon?: React.ElementType; title: string; body?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-4">
      {Icon && (
        <div className="w-11 h-11 rounded-2xl bg-slate-100 dark:bg-slate-700 flex items-center justify-center mb-3">
          <Icon size={20} className="text-slate-500 dark:text-slate-300" />
        </div>
      )}
      <p className="font-semibold text-slate-800 dark:text-slate-100">{title}</p>
      {body && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 max-w-md">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400">
      <Loader2 size={16} className="animate-spin" /> {label}
    </div>
  );
}

export function ErrorNote({ message }: { message?: string }) {
  return <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{message || "Something went wrong."}</div>;
}

// ---------------------------------------------------------------------------
// Badges — always text + color, never color alone
// ---------------------------------------------------------------------------

const pill = "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap";

const TASK_STATUS_CLASS: Record<TaskStatus, string> = {
  open: "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  in_progress: "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  waiting: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  completed: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  cancelled: "bg-slate-100 text-slate-500 line-through dark:bg-slate-800 dark:text-slate-400",
};

export function TaskStatusBadge({ status }: { status: string }) {
  return <span className={cn(pill, TASK_STATUS_CLASS[status as TaskStatus])}>{TASK_STATUS_LABELS[status as TaskStatus] ?? status}</span>;
}

const PRIORITY_CLASS: Record<TaskPriority, string> = {
  urgent: "bg-rose-600 text-white",
  high: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  normal: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
  low: "bg-transparent text-slate-500 border border-slate-200 dark:border-slate-600",
};

export function PriorityBadge({ priority }: { priority: string }) {
  return <span className={cn(pill, PRIORITY_CLASS[priority as TaskPriority])}>{TASK_PRIORITY_LABELS[priority as TaskPriority] ?? priority}</span>;
}

/** Dot color per flow status (always shown next to the status name). */
export const FLOW_DOT: Record<FlowStatus, string> = {
  scheduled: "bg-slate-400",
  arrived: "bg-sky-400",
  checked_in: "bg-blue-600",
  roomed: "bg-violet-500",
  with_provider: "bg-orange-500",
  checkout: "bg-amber-400",
  completed: "bg-emerald-500",
  no_show: "bg-rose-500",
  cancelled: "bg-slate-300",
};

export const FLOW_CLASS: Record<FlowStatus, string> = {
  scheduled: "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  arrived: "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  checked_in: "bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  roomed: "bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  with_provider: "bg-orange-50 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  checkout: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  completed: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  no_show: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  cancelled: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
};

export function FlowBadge({ status }: { status: string }) {
  return <span className={cn(pill, FLOW_CLASS[status as FlowStatus])}>{FLOW_LABELS[status as FlowStatus] ?? status}</span>;
}

// ---------------------------------------------------------------------------
// Form controls styled like the rest of the app
// ---------------------------------------------------------------------------

export const inputCls =
  "w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand/60";

export function SelectBox({ value, onChange, children, className, ariaLabel }: { value: string; onChange: (v: string) => void; children: React.ReactNode; className?: string; ariaLabel?: string }) {
  return (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} className={cn(inputCls, "w-auto pr-8", className)}>
      {children}
    </select>
  );
}

export function Btn({ variant = "primary", size = "md", className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "brand" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  const v = {
    primary: "bg-ink text-white hover:bg-ink/85 shadow-sm dark:bg-brand dark:hover:bg-brand/90",
    brand: "bg-brand text-white hover:bg-brand/90 shadow-sm",
    secondary: "border border-slate-200 dark:border-slate-600 bg-white text-slate-800 dark:text-slate-200 hover:bg-slate-50",
    ghost: "text-slate-600 dark:text-slate-300 hover:bg-slate-100",
    danger: "bg-rose-600 text-white hover:bg-rose-700",
  }[variant];
  const s = size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm";
  return <button {...props} className={cn("inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:pointer-events-none", v, s, className)} />;
}
