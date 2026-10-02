import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Syringe, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { INJECTION_KINDS, INJECTION_KIND_LIST, injectionTag, type InjectionKind } from "@shared/dailyReport";
import { fmtDay, localDateStr } from "@shared/workforce";
import { cn } from "@/lib/utils";

/**
 * Log an injection given in the office. The number fills in by itself (the patient's 12th weight-loss
 * injection = "WL #12"); it counts on the daily report of the provider they saw that day.
 */
export function InjectionDialog({ open, onOpenChange, subjectKey, patientName, date }: { open: boolean; onOpenChange: (o: boolean) => void; subjectKey: string; patientName: string; date?: string }) {
  const utils = trpc.useUtils();
  const [givenOn, setGivenOn] = useState(date ?? localDateStr());
  const ctx = trpc.workspace.injections.context.useQuery({ subjectKey, date: givenOn }, { enabled: open });
  const [kind, setKind] = useState<InjectionKind>("wl");
  const [label, setLabel] = useState("");
  const [num, setNum] = useState<string>("");
  const [providerId, setProviderId] = useState<number | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => { if (open) { setGivenOn(date ?? localDateStr()); setKind("wl"); setLabel(""); setNote(""); setNum(""); setProviderId(null); } }, [open, date]);
  // Fill in the next number and the provider once we know them.
  useEffect(() => { if (ctx.data) { setNum(kind === "other" ? "" : String(ctx.data.next[kind] ?? 1)); } }, [ctx.data, kind]);
  useEffect(() => { if (ctx.data && providerId === null) setProviderId(ctx.data.defaultProviderId); }, [ctx.data, providerId]);

  const log = trpc.workspace.injections.log.useMutation({
    onSuccess: (r) => { toast.success(`Logged: ${patientName} (${r.tag}).`); void utils.workspace.injections.invalidate(); void utils.workspace.dailyReports.invalidate(); onOpenChange(false); },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.workspace.injections.remove.useMutation({
    onSuccess: () => { toast.success("Removed."); void utils.workspace.injections.invalidate(); void utils.workspace.dailyReports.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const n = Number(num) || null;
  const label_ = "block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Syringe size={18} /> Injection given</DialogTitle>
          <DialogDescription>{patientName}. It shows on the provider's daily report.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className={label_}>What</label>
            <div className="flex flex-wrap gap-1.5">
              {INJECTION_KIND_LIST.map((k) => (
                <button key={k} type="button" onClick={() => setKind(k)}
                  className={cn("rounded-lg border px-2.5 py-1.5 text-xs font-medium", kind === k ? "border-brand bg-brand/10 text-slate-900 dark:text-slate-50" : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800")}>
                  {INJECTION_KINDS[k].label}
                </button>
              ))}
            </div>
            {kind === "other" && <input className={cn(inputCls, "mt-2")} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="What was given (e.g. Vitamin D)" aria-label="What was given" autoFocus />}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label_} htmlFor="inj-num">Number{kind !== "other" ? ` (${INJECTION_KINDS[kind].short} #)` : ""}</label>
              <input id="inj-num" type="number" min={1} max={999} className={inputCls} value={num} onChange={(e) => setNum(e.target.value)} placeholder={kind === "other" ? "Optional" : ""} />
            </div>
            <div>
              <label className={label_} htmlFor="inj-date">Date</label>
              <input id="inj-date" type="date" max={localDateStr()} className={inputCls} value={givenOn} onChange={(e) => setGivenOn(e.target.value)} />
            </div>
          </div>
          <div>
            <label className={label_} htmlFor="inj-prov">Provider (whose report it counts on)</label>
            <select id="inj-prov" className={inputCls} value={providerId ?? ""} onChange={(e) => setProviderId(Number(e.target.value) || null)}>
              <option value="">Not sure</option>
              {(ctx.data?.providers ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} placeholder="Note (optional)" aria-label="Note" />

          {(ctx.data?.recent.length ?? 0) > 0 && (
            <div className="rounded-xl bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
              <p className="mb-1 font-semibold text-slate-600 dark:text-slate-300">Logged before</p>
              <ul className="space-y-1">
                {ctx.data!.recent.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <span>{r.tag} · {fmtDay(r.givenOn, { month: "short", day: "numeric", year: "numeric" })}{r.by ? ` · ${r.by.replace(/\s*\(.*?\)/, "")}` : ""}</span>
                    {r.canRemove && <button onClick={() => { if (window.confirm(`Remove ${r.tag} from ${fmtDay(r.givenOn, { month: "short", day: "numeric" })}?`)) remove.mutate({ id: r.id }); }} aria-label={`Remove ${r.tag}`}><Trash2 size={13} className="text-slate-400 hover:text-rose-600" /></button>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-500">Shows as <b>{injectionTag(kind, label, n)}</b></span>
            <div className="flex gap-2">
              <Btn variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Btn>
              <Btn disabled={log.isPending || ctx.isLoading || (kind === "other" && !label.trim())}
                onClick={() => log.mutate({ subjectKey, kind, label: kind === "other" ? label.trim() : null, seriesNumber: n, givenOn, providerId, note: note.trim() || null })}>
                {log.isPending ? <Loader2 size={15} className="animate-spin" /> : <Syringe size={15} />} Log injection
              </Btn>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
