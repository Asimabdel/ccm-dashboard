/** Care-plan and library status badges (shared by the Care plans page, Patient 360 and the call card). */
export const PLAN_STATUS: Record<string, { label: string; cls: string }> = {
  none: { label: "No plan yet", cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  draft: { label: "Draft: needs provider signature", cls: "bg-amber-50 text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200" },
  changed: { label: "Changed since signed", cls: "bg-amber-50 text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200" },
  signed: { label: "Signed", cls: "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200" },
};

export const LIB_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft: needs provider approval", cls: PLAN_STATUS.draft!.cls },
  changed: { label: "Edited: re-approval needed", cls: PLAN_STATUS.changed!.cls },
  approved: { label: "Approved", cls: PLAN_STATUS.signed!.cls },
};
