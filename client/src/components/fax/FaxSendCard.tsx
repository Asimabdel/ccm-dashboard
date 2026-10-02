import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ChevronDown, KeyRound, Loader2, Send } from "lucide-react";
import { Btn, Panel, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { formatPhone } from "@shared/phone";
import { cn } from "@/lib/utils";

/**
 * Admin card: which RingCentral user (and so which fax number) sends each clinic's faxes. Uses the
 * RingCentral server app connected for the call log; a clinic can have its own sign-in key instead.
 */
export function FaxSendCard() {
  const setup = trpc.workspace.faxOut.setup.useQuery();
  const [loadNumbers, setLoadNumbers] = useState(false);
  const numbers = trpc.workspace.faxOut.numbers.useQuery(undefined, { enabled: loadNumbers && !!setup.data?.connected, retry: false });
  const utils = trpc.useUtils();
  const [keyFor, setKeyFor] = useState<number | null>(null);
  const [jwt, setJwt] = useState("");
  const save = trpc.workspace.faxOut.saveClinic.useMutation({
    onSuccess: () => { toast.success("Saved."); setKeyFor(null); setJwt(""); void utils.workspace.faxOut.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const s = setup.data;

  return (
    <Panel className="lg:col-span-5" title={<span className="flex items-center gap-2"><Send size={16} className="text-orange-500" /> Sending faxes (RingCentral)</span>}
      subtitle="Each clinic's faxes go out from that clinic's RingCentral fax number, with a cover sheet and confidentiality notice.">
      {!s ? <Loader2 size={16} className="animate-spin text-slate-400" /> : (
        <div className="grid gap-6 text-sm lg:grid-cols-[1.2fr_1fr]">
          <div className="space-y-3">
            {!s.connected && (
              <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" /> Connect the RingCentral server app (the call-log card above) first: faxes use the same connection.
              </p>
            )}
            {s.clinics.map((c) => {
              const options = (numbers.data ?? []);
              return (
                <div key={c.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-slate-900 dark:text-slate-50">{c.name}</p>
                    {c.ready
                      ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={13} /> Ready{c.fromNumber ? ` · fax ${formatPhone(c.fromNumber)}` : ""}</span>
                      : <span className="text-xs text-slate-400">Not set up</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">{c.ownKey ? "Sends with this clinic's own sign-in key" : c.extensionName ? `Sends as ${c.extensionName}` : "Pick the RingCentral user whose fax number this clinic uses."}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {loadNumbers ? (
                      numbers.isLoading ? <span className="text-xs text-slate-400"><Loader2 size={12} className="mr-1 inline animate-spin" />Loading RingCentral fax numbers…</span>
                        : numbers.error ? <span className="text-xs text-rose-600">{numbers.error.message}</span>
                        : (
                          <select className={cn(inputCls, "max-w-sm py-1.5")} value={c.extensionId && c.fromNumber ? `${c.extensionId}|${c.fromNumber}` : ""} aria-label={`Fax number for ${c.name}`}
                            onChange={(e) => {
                              const [extensionId, number] = e.target.value.split("|");
                              const o = options.find((x) => x.extensionId === extensionId && x.number === number);
                              save.mutate({ clinicId: c.id, extensionId: extensionId || null, extensionName: o?.extensionName ?? null, fromNumber: number || null });
                            }}>
                            <option value="">Pick a fax number…</option>
                            {options.map((o) => <option key={`${o.extensionId}|${o.number}`} value={`${o.extensionId}|${o.number}`}>{formatPhone(o.number)} · {o.extensionName}</option>)}
                          </select>
                        )
                    ) : <Btn size="sm" variant="secondary" disabled={!s.connected} onClick={() => setLoadNumbers(true)}><ChevronDown size={13} /> Pick fax number</Btn>}
                    <Btn size="sm" variant="ghost" onClick={() => { setKeyFor(keyFor === c.id ? null : c.id); setJwt(""); }}><KeyRound size={13} /> {c.ownKey ? "Change own sign-in key" : "Use its own sign-in key"}</Btn>
                    {c.ownKey && <Btn size="sm" variant="ghost" onClick={() => save.mutate({ clinicId: c.id, extensionId: c.extensionId, extensionName: c.extensionName, fromNumber: c.fromNumber, clearKey: true })}>Remove key</Btn>}
                  </div>
                  {keyFor === c.id && (
                    <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-2.5 dark:bg-slate-800/60">
                      <p className="text-xs text-slate-600 dark:text-slate-300">Only if RingCentral won't let the main connection send for this clinic's fax user: that user signs in to the RingCentral developer console, creates a JWT for the same app, and an admin pastes it here. It's stored encrypted and never shown again.</p>
                      <textarea className={cn(inputCls, "min-h-[60px] font-mono text-xs")} value={jwt} onChange={(e) => setJwt(e.target.value)} placeholder="Paste the JWT" aria-label="Sign-in key (JWT)" autoComplete="off" spellCheck={false} />
                      <Btn size="sm" disabled={!jwt.trim() || save.isPending} onClick={() => save.mutate({ clinicId: c.id, extensionId: c.extensionId, extensionName: c.extensionName, fromNumber: c.fromNumber, jwt: jwt.trim() })}>Save key</Btn>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="space-y-2 text-slate-600 dark:text-slate-300">
            <p className="font-semibold text-slate-800 dark:text-slate-100">One-time setup in RingCentral</p>
            <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed">
              <li>In the RingCentral developer console, open the server app MyPCP uses for the call log → Settings → OAuth: add the <b>Faxes</b> and <b>Read Messages</b> permissions and save.</li>
              <li>Make sure each clinic's fax number belongs to a RingCentral user (a fax-only user is fine) and is set as that user's outbound fax number in the RingCentral admin portal.</li>
              <li>Here, click <b>Pick fax number</b> and choose each clinic's number.</li>
              <li>The RingCentral admin whose sign-in key MyPCP uses needs permission to send faxes for those users. If RingCentral refuses, give that clinic its own sign-in key instead.</li>
              <li>Send a short test fax to a fax number you control and check that it arrives.</li>
            </ol>
            <p className="text-xs">Up to 4 MB of files per fax. MyPCP doesn't copy the files: it records what was sent, to whom and when (in the audit log and the patient's folder).</p>
          </div>
        </div>
      )}
    </Panel>
  );
}
