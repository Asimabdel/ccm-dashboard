import { useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2, Printer, RefreshCw } from "lucide-react";
import { Btn, Panel, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { KNOWN_FAX_SENDERS, type FaxRouting } from "@shared/fax";

/** Admin card: where faxes arrive, who files them, and the AI read. */
export function FaxCard() {
  const q = trpc.workspace.fax.status.useQuery(undefined, { refetchInterval: 60_000 });
  const utils = trpc.useUtils();
  const refresh = () => { void utils.workspace.fax.invalidate(); };
  const onError = (e: { message: string }) => toast.error(e.message);
  const s = q.data;
  const [form, setForm] = useState<{ senders: string; routing: FaxRouting; routeUserId: number | null; ai: boolean } | null>(null);
  useEffect(() => {
    if (s && !form) setForm({ senders: s.settings.senders.join("\n"), routing: s.settings.routing, routeUserId: s.settings.routeUserId, ai: s.settings.ai });
  }, [s, form]);

  const save = trpc.workspace.fax.saveSettings.useMutation({ onSuccess: () => { refresh(); toast.success("Fax settings saved"); }, onError });
  const connect = trpc.workspace.fax.connectUrl.useMutation({ onSuccess: (r) => { window.location.href = r.url; }, onError });
  const disconnect = trpc.workspace.fax.disconnect.useMutation({ onSuccess: () => { refresh(); toast.success("Fax mailbox disconnected"); }, onError });
  const check = trpc.workspace.fax.checkNow.useMutation({
    onSuccess: (r) => { refresh(); toast.success(`Checked. ${r.read.read ? `${r.read.read} fax${r.read.read === 1 ? "" : "es"} read. ` : ""}${r.counts.needsPatient} need a patient, ${r.counts.toFile} to file.`); },
    onError,
  });

  return (
    <Panel
      className="lg:col-span-5"
      title={<span className="flex items-center gap-2"><Printer size={16} className="text-orange-500" /> Fax inbox</span>}
      subtitle={s ? `${s.counts.needsPatient} need a patient · ${s.counts.toFile} to file in Practice Fusion · ${s.counts.filed} filed (30 days)` : ""}
      action={<Link href="/faxes" className="text-sm font-semibold text-brand hover:underline">Open Fax inbox</Link>}
    >
      {!s || !form ? <Loader2 size={16} className="animate-spin text-slate-400" /> : (
        <div className="grid lg:grid-cols-2 gap-6 text-sm">
          <div className="space-y-4">
            <p className="text-slate-600 dark:text-slate-300">
              Faxes that arrive by email are read, matched to the patient, and turned into a <b>File in Practice Fusion</b> task. Practice Fusion doesn't let other systems add documents to a chart, so staff do the upload (Documents → Upload) and mark it filed. The fax stays in the mailbox; MyPCP doesn't keep a copy.
            </p>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Where faxes arrive</p>
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  {s.practiceMailbox ? <CheckCircle2 size={15} className="mt-0.5 text-emerald-600 shrink-0" /> : <AlertTriangle size={15} className="mt-0.5 text-amber-500 shrink-0" />}
                  <span>{s.practiceMailbox ? <>Practice mailbox <b>{s.practiceMailbox}</b>: fax emails there are picked up automatically.</> : "The practice mailbox isn't connected (see the card above)."}</span>
                </li>
                <li className="flex items-start gap-2">
                  {s.faxMailbox.connected ? <CheckCircle2 size={15} className="mt-0.5 text-emerald-600 shrink-0" /> : <Printer size={15} className="mt-0.5 text-slate-400 shrink-0" />}
                  <span className="flex-1">
                    {s.faxMailbox.connected
                      ? <>Fax mailbox <b>{s.faxMailbox.mailbox}</b>: every PDF or TIFF that arrives there is a fax.{s.faxMailbox.lastError && <span className="block text-rose-700">Last check failed: {s.faxMailbox.lastError}</span>}</>
                      : <>If faxes go to a different mailbox (e.g. fax@mypcpdr.com), connect it here. It uses the same Google app, read-only.</>}
                    <span className="mt-1.5 flex gap-2">
                      {s.faxMailbox.connected
                        ? <Btn size="sm" variant="ghost" disabled={disconnect.isPending} onClick={() => { if (confirm("Disconnect the fax mailbox? Faxes that arrive there stop coming in.")) disconnect.mutate(); }}>Disconnect</Btn>
                        : <Btn size="sm" variant="secondary" disabled={connect.isPending} onClick={() => connect.mutate({ origin: window.location.origin })}>{connect.isPending && <Loader2 size={13} className="animate-spin" />} Connect fax mailbox with Google</Btn>}
                    </span>
                  </span>
                </li>
              </ul>
            </div>
            <Btn variant="secondary" disabled={check.isPending} onClick={() => check.mutate()}>
              {check.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Check for faxes now
            </Btn>
          </div>

          <div className="space-y-4">
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">Send filing tasks to
              <select className={cn(inputCls, "mt-1")} value={form.routing} onChange={(e) => setForm({ ...form, routing: e.target.value as FaxRouting })}>
                <option value="front_desk">Front desk at the patient's clinic</option>
                <option value="care_team">The patient's care coordinator (else front desk)</option>
                <option value="user">One person</option>
              </select>
            </label>
            {form.routing === "user" && (
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">Who files faxes
                <select className={cn(inputCls, "mt-1")} value={form.routeUserId ?? ""} onChange={(e) => setForm({ ...form, routeUserId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Pick a person</option>
                  {s.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={form.ai} onChange={(e) => setForm({ ...form, ai: e.target.checked })} />
              <span>Read faxes with AI to find the patient
                <span className="block text-xs text-slate-500">Uses the practice's AWS Bedrock AI (covered by the AWS BAA). A fax is assigned on its own only when the name <b>and</b> date of birth match exactly one patient; otherwise staff confirm.{!s.aiReady && " AI isn't set up on this server."}</span>
              </span>
            </label>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">Other fax sender addresses (optional)
              <textarea className={cn(inputCls, "mt-1 h-20 font-mono text-xs")} placeholder={"fax@ourfaxservice.com\nfaxservice.com"} value={form.senders} onChange={(e) => setForm({ ...form, senders: e.target.value })} />
              <span className="mt-1 block font-normal text-slate-500">One per line. Emails from these (with a PDF or TIFF) in the practice mailbox count as faxes, on top of common fax services ({KNOWN_FAX_SENDERS.slice(0, 4).join(", ")}…) and emails with "fax" in the subject.</span>
            </label>
            <Btn disabled={save.isPending} onClick={() => save.mutate({ senders: form.senders.split(/[\s,]+/).filter(Boolean), routing: form.routing, routeUserId: form.routeUserId, ai: form.ai })}>
              {save.isPending && <Loader2 size={14} className="animate-spin" />} Save fax settings
            </Btn>
          </div>
        </div>
      )}
    </Panel>
  );
}
