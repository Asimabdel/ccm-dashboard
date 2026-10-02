import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PhoneOff, X } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { CALL_OUTCOMES, CALL_OUTCOME_LIST, formatPhone, parseRingCentralCall, type CallOutcome } from "@shared/phone";
import { cn } from "@/lib/utils";
import { RC_ORIGIN, setRcState, takeDialContext } from "./ringcentralStore";
import { isCallingMode } from "@/components/outreach/callingState";
import { addBusinessDays } from "@shared/outreach";
import { localDateStr } from "@shared/workforce";

const ADAPTER = `${RC_ORIGIN}/integration/ringcentral-embeddable/latest/adapter.js`;

interface EndedCall { callId: number; name: string; durationSec: number; suggestion: CallOutcome | null }

const fmtDuration = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);

function suggestOutcome(result: string | null, durationSec: number): CallOutcome | null {
  const r = (result ?? "").toLowerCase();
  if (r.includes("voicemail")) return "voicemail";
  if (/missed|no answer|busy|rejected|declined/.test(r) || durationSec === 0) return "no_answer";
  return null;
}

/**
 * Loads RingCentral's phone (once, for the whole app, so calls survive page changes) when an
 * admin has turned it on, logs every finished call, and asks how outbound calls went.
 */
export function RingCentralPhone() {
  const { user } = useAuth();
  const allowed = !!user && user.role !== "user";
  const cfg = trpc.workspace.phone.config.useQuery(undefined, { enabled: allowed, staleTime: 5 * 60_000, retry: false });
  const utils = trpc.useUtils();
  const log = trpc.workspace.phone.log.useMutation();
  const logRef = useRef(log.mutateAsync);
  logRef.current = log.mutateAsync;
  const injected = useRef(false);
  const handled = useRef(new Set<string>());
  const minimizedOnce = useRef(false);
  const [ended, setEnded] = useState<EndedCall | null>(null);

  // Load the widget once it's switched on.
  useEffect(() => {
    const c = cfg.data;
    if (!allowed || !c?.enabled || injected.current) return;
    injected.current = true;
    const params = new URLSearchParams({ disableGlip: "true", disableMeeting: "true" });
    if (c.clientId) params.set("clientId", c.clientId);
    if (!c.allowTexting) params.set("disableMessages", "true");
    const s = document.createElement("script");
    s.src = `${ADAPTER}?${params.toString()}`;
    s.async = true;
    s.onload = () => setRcState({ loaded: true });
    s.onerror = () => { injected.current = false; toast.error("Couldn't load the RingCentral phone. Phone numbers will use your computer's calling app."); };
    document.body.appendChild(s);
  }, [allowed, cfg.data]);

  // Listen to the widget: sign-in state and finished calls.
  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== RC_ORIGIN || !e.data || typeof e.data !== "object") return;
      const data = e.data as { type?: string; loggedIn?: boolean; call?: Record<string, unknown> };
      if (data.type === "rc-login-status-notify") {
        setRcState({ loggedIn: !!data.loggedIn });
        // The first status message means the phone finished loading: tuck it into its badge so it
        // doesn't cover the page (clicking a number opens it again).
        if (!minimizedOnce.current) {
          minimizedOnce.current = true;
          (window as unknown as { RCAdapter?: { setMinimized?: (v: boolean) => void } }).RCAdapter?.setMinimized?.(true);
        }
      }
      if (data.type !== "rc-call-end-notify") return;
      const call = parseRingCentralCall(data.call);
      if (!call?.otherNumber) return;
      const dedupe = call.sessionId ?? `${call.otherNumber}-${call.startedAt.getTime()}`;
      if (handled.current.has(dedupe)) return;
      handled.current.add(dedupe);
      const context = call.direction === "outbound" ? takeDialContext(call.otherNumber) : null;
      try {
        const res = await logRef.current({ sessionId: call.sessionId, direction: call.direction, phoneNumber: call.otherNumber, startedAt: call.startedAt, durationSec: call.durationSec, result: call.result, context });
        // In calling mode the calling screen asks how it went, so skip the box here.
        if (call.direction === "outbound" && !res.duplicate && !isCallingMode()) {
          setEnded({ callId: res.id, name: res.contactName ?? formatPhone(call.otherNumber), durationSec: call.durationSec, suggestion: suggestOutcome(call.result, call.durationSec) });
        }
      } catch {
        toast.error("Couldn't save that call to the call log.");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!ended) return null;
  return <OutcomePrompt call={ended} onDone={(closed) => { setEnded(null); void utils.workspace.opportunities.invalidate(); void utils.workspace.phone.invalidate(); if (closed) toast.success("Taken off the call list."); }} />;
}

function OutcomePrompt({ call, onDone }: { call: EndedCall; onDone: (closed: boolean) => void }) {
  const [outcome, setOutcome] = useState<CallOutcome | null>(call.suggestion);
  const [note, setNote] = useState("");
  const [callBackOn, setCallBackOn] = useState(() => addBusinessDays(localDateStr(), 1));
  const save = trpc.workspace.phone.outcome.useMutation({
    onSuccess: (r) => onDone(r.closed),
    onError: (e) => toast.error(e.message),
  });
  return (
    <div role="dialog" aria-label="How did the call go?" className="fixed bottom-4 left-4 z-50 w-[min(360px,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-50"><PhoneOff size={14} className="text-slate-400" /> Call with {call.name} ended</p>
          <p className="text-xs text-slate-500">{fmtDuration(call.durationSec)} · How did it go?</p>
        </div>
        <button aria-label="Skip" onClick={() => onDone(false)} className="p-1 rounded-lg text-slate-400 hover:bg-slate-100"><X size={16} /></button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {CALL_OUTCOME_LIST.map((o) => (
          <button key={o} onClick={() => setOutcome(o)}
            className={cn("px-2.5 py-1.5 rounded-lg border text-xs font-medium transition", outcome === o ? "border-brand bg-brand/10 text-slate-900 dark:text-slate-50" : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300")}>
            {CALL_OUTCOMES[o]}
          </button>
        ))}
      </div>
      {outcome === "call_back" && (
        <label className="mt-3 flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
          Call back on
          <input type="date" value={callBackOn} min={localDateStr()} onChange={(e) => setCallBackOn(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800" />
        </label>
      )}
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Note (optional) — e.g. booked Tue 10:40 with Dr. Narang"
        className="mt-3 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" />
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={() => onDone(false)} className="px-3 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300">Skip</button>
        <button disabled={!outcome || save.isPending} onClick={() => outcome && save.mutate({ callId: call.callId, outcome, note: note || null, callBackOn: outcome === "call_back" ? callBackOn || null : null })}
          className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-sm font-semibold disabled:opacity-50 dark:bg-brand">Save</button>
      </div>
    </div>
  );
}
