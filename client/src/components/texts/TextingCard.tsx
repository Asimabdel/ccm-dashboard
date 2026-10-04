import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, MessageSquareText, RefreshCw } from "lucide-react";
import { Btn, Panel, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { formatPhone } from "@shared/phone";
import { DEFAULT_TEXTING } from "@shared/texts";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const labelCls = "block text-xs font-semibold text-slate-600 dark:text-slate-300";

/**
 * Admin card: the practice's texting number (patients text it; replies go from it), office hours and the
 * after-hours reply. Uses the RingCentral server app connected for the call log; the number's own user can
 * give MyPCP a sign-in key instead.
 */
export function TextingCard() {
  const setup = trpc.workspace.texts.setup.useQuery();
  const [loadNumbers, setLoadNumbers] = useState(false);
  const numbers = trpc.workspace.texts.numbers.useQuery(undefined, { enabled: loadNumbers && !!setup.data?.connected, retry: false });
  const utils = trpc.useUtils();
  const [enabled, setEnabled] = useState(false);
  const [pick, setPick] = useState<{ extensionId: string | null; extensionName: string | null; number: string | null }>({ extensionId: null, extensionName: null, number: null });
  const [days, setDays] = useState<number[]>(DEFAULT_TEXTING.hours.days);
  const [start, setStart] = useState(DEFAULT_TEXTING.hours.start);
  const [end, setEnd] = useState(DEFAULT_TEXTING.hours.end);
  const [auto, setAuto] = useState(DEFAULT_TEXTING.autoReply);
  const [jwt, setJwt] = useState("");
  const [showKey, setShowKey] = useState(false);
  const s = setup.data;
  useEffect(() => {
    if (!s) return;
    setEnabled(s.enabled);
    setPick({ extensionId: s.extensionId, extensionName: s.extensionName, number: s.number });
    setDays(s.hours.days); setStart(s.hours.start); setEnd(s.hours.end);
    setAuto(s.autoReply);
  }, [s]);
  const save = trpc.workspace.texts.save.useMutation({
    onSuccess: () => { toast.success("Saved."); setJwt(""); setShowKey(false); void utils.workspace.texts.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const sync = trpc.workspace.texts.syncNow.useMutation({
    onSuccess: (r) => { toast.success(r.note ? `Not checked: ${r.note}.` : `Checked RingCentral: ${r.received} new text${r.received === 1 ? "" : "s"}.`); void utils.workspace.texts.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const submit = (overrides: { clearKey?: boolean } = {}) => save.mutate({
    enabled, extensionId: pick.extensionId, extensionName: pick.extensionName, number: pick.number, jwt: jwt.trim() || null, ...overrides,
    hours: { days, start, end }, autoReply: auto,
  });

  return (
    <Panel className="lg:col-span-5" title={<span className="flex items-center gap-2"><MessageSquareText size={16} className="text-orange-500" /> Patient texting (RingCentral)</span>}
      subtitle="Patients text the practice's main number; staff answer in Messages → Patient texts. Each conversation goes to the patient's clinic.">
      {!s ? <Loader2 size={16} className="animate-spin text-slate-400" /> : (
        <div className="grid gap-6 text-sm lg:grid-cols-[1.2fr_1fr]">
          <div className="space-y-4">
            {!s.connected && (
              <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" /> Connect the RingCentral server app (the call-log card above) first: texting uses the same connection.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
                <input type="checkbox" className="size-4 accent-brand" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Patient texting on
              </label>
              {s.enabled && s.number
                ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={13} /> On · {formatPhone(s.number)}</span>
                : <span className="text-xs text-slate-400">Off</span>}
            </div>
            <div>
              <p className={labelCls}>The number patients text</p>
              <p className="mt-0.5 text-xs text-slate-500">{s.ownKey ? "Sends with that RingCentral user's own sign-in key." : pick.extensionName ? `Sends as ${pick.extensionName}${pick.number ? ` · ${formatPhone(pick.number)}` : ""}.` : "Pick a text-enabled number (registered for business texting in RingCentral)."}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {loadNumbers ? (
                  numbers.isLoading ? <span className="text-xs text-slate-400"><Loader2 size={12} className="mr-1 inline animate-spin" />Loading RingCentral numbers…</span>
                    : numbers.error ? <span className="text-xs text-rose-600">{numbers.error.message}</span>
                    : (
                      <select className={cn(inputCls, "max-w-sm py-1.5")} value={pick.extensionId && pick.number ? `${pick.extensionId}|${pick.number}` : ""} aria-label="Texting number"
                        onChange={(e) => {
                          const [extensionId, number] = e.target.value.split("|");
                          const o = (numbers.data ?? []).find((x) => x.extensionId === extensionId && x.number === number);
                          setPick({ extensionId: extensionId || null, extensionName: o?.extensionName ?? null, number: number || null });
                        }}>
                        <option value="">Pick a text-enabled number…</option>
                        {(numbers.data ?? []).map((o) => <option key={`${o.extensionId}|${o.number}`} value={`${o.extensionId}|${o.number}`}>{formatPhone(o.number)} · {o.extensionName}</option>)}
                      </select>
                    )
                ) : <Btn size="sm" variant="secondary" disabled={!s.connected} onClick={() => setLoadNumbers(true)}>Choose the number</Btn>}
                <button className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800" onClick={() => setShowKey((v) => !v)}><KeyRound size={12} /> {s.ownKey ? "Change or remove the sign-in key" : "Use that user's own sign-in key instead"}</button>
              </div>
              {showKey && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input type="password" autoComplete="off" className={cn(inputCls, "max-w-sm py-1.5")} value={jwt} onChange={(e) => setJwt(e.target.value)} placeholder="Paste the RingCentral JWT (never shown again)" aria-label="RingCentral sign-in key" />
                  {s.ownKey && <Btn size="sm" variant="ghost" onClick={() => submit({ clearKey: true })}>Remove key</Btn>}
                </div>
              )}
            </div>
            <div>
              <p className={labelCls}>Office hours (clinic time)</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {DAYS.map((d, i) => (
                  <button key={d} onClick={() => setDays((xs) => (xs.includes(i) ? xs.filter((x) => x !== i) : [...xs, i].sort()))} aria-pressed={days.includes(i)}
                    className={cn("rounded-lg px-2 py-1 text-xs font-semibold", days.includes(i) ? "bg-brand text-white" : "bg-slate-100 text-slate-500 dark:bg-slate-700")}>{d}</button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input type="time" className={cn(inputCls, "w-32 py-1.5")} value={start} onChange={(e) => setStart(e.target.value)} aria-label="Opens" />
                <span className="text-slate-400">to</span>
                <input type="time" className={cn(inputCls, "w-32 py-1.5")} value={end} onChange={(e) => setEnd(e.target.value)} aria-label="Closes" />
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <label className="inline-flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
              <input type="checkbox" className="size-4 accent-brand" checked={auto.enabled} onChange={(e) => setAuto({ ...auto, enabled: e.target.checked })} /> Reply automatically after hours
            </label>
            <p className="text-xs text-slate-500">Once per patient every 12 hours. Patients whose language is on file get theirs; everyone else gets both.</p>
            <label className={labelCls}>English
              <textarea className={cn(inputCls, "mt-1 min-h-[70px] resize-y py-2")} maxLength={1000} value={auto.en} onChange={(e) => setAuto({ ...auto, en: e.target.value })} />
            </label>
            <label className={labelCls}>Spanish
              <textarea className={cn(inputCls, "mt-1 min-h-[70px] resize-y py-2")} maxLength={1000} value={auto.es} onChange={(e) => setAuto({ ...auto, es: e.target.value })} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Btn onClick={() => submit()} disabled={save.isPending}>{save.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Save</Btn>
              {s.enabled && <Btn variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending}>{sync.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Check for texts now</Btn>}
            </div>
            {s.lastSync && <p className="text-xs text-slate-500">Last checked {new Date(s.lastSync).toLocaleString()}{s.lastError ? "" : " · OK"}</p>}
            {s.lastError && <p className="flex items-start gap-1.5 text-xs text-rose-600"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> {s.lastError}</p>}
          </div>
        </div>
      )}
    </Panel>
  );
}
