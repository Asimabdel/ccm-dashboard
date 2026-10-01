import { useState } from "react";
import { toast } from "sonner";
import { CalendarRange, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { fmtDay, localDateStr } from "@shared/workforce";
import { Btn, inputCls } from "./ui";

/**
 * "Patients seen since …": the start date shared by Program approvals and the Testing tab. Visits
 * after it keep counting as they happen. Admins can move it (Program approvals re-checks right away).
 */
export function SeenSince({ date, isAdmin, className }: { date: string | null | undefined; isAdmin: boolean; className?: string }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(date ?? "");
  const save = trpc.workspace.seenSince.set.useMutation({
    onSuccess: (r) => {
      setEditing(false);
      void utils.workspace.programs.invalidate();
      void utils.workspace.officeTests.invalidate();
      void utils.workspace.seenSince.invalidate();
      toast.success(`Start date set to ${fmtDay(r.date, { month: "short", day: "numeric", year: "numeric" })}. ${r.scan.newPatients ? `${r.scan.newPatients} more patients qualify for programs.` : ""}`);
    },
    onError: (e) => toast.error(e.message),
  });
  if (!date) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-300", className)}>
      <CalendarRange size={14} className="text-slate-400" />
      Patients seen since <b className="text-slate-900 dark:text-slate-50">{fmtDay(date, { month: "short", day: "numeric", year: "numeric" })}</b> and onward
      {isAdmin && !editing && <button className="text-xs font-semibold text-brand hover:underline" onClick={() => { setValue(date); setEditing(true); }}>Change</button>}
      {isAdmin && editing && (
        <span className="inline-flex items-center gap-1.5">
          <input type="date" aria-label="Start date" className={cn(inputCls, "w-auto py-1 text-xs")} value={value} max={localDateStr()} onChange={(e) => setValue(e.target.value)} />
          <Btn size="sm" disabled={!value || save.isPending} onClick={() => save.mutate({ date: value })}>{save.isPending && <Loader2 size={12} className="animate-spin" />} Save</Btn>
          <button className="text-xs text-slate-500 hover:text-slate-800" onClick={() => setEditing(false)}>Cancel</button>
        </span>
      )}
    </span>
  );
}
