import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, PlugZap, ShieldCheck } from "lucide-react";
import { Btn, Panel, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const ago = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) : "never");

/** Admin card: connect Availity (insurance eligibility) and turn on the nightly check. */
export function AvailityCard() {
  const q = trpc.workspace.eligibility.status.useQuery();
  const utils = trpc.useUtils();
  const s = q.data && "clientIdHint" in q.data ? q.data : null;
  const [form, setForm] = useState<{ clientId: string; clientSecret: string; mode: "demo" | "production"; npi: string; orgName: string; nightly: boolean } | null>(null);
  useEffect(() => { if (s && !form) setForm({ clientId: "", clientSecret: "", mode: s.mode, npi: s.npi, orgName: s.orgName, nightly: s.nightly }); }, [s, form]);
  const onError = (e: { message: string }) => toast.error(e.message);
  const save = trpc.workspace.eligibility.saveConfig.useMutation({
    onSuccess: () => { void utils.workspace.eligibility.invalidate(); setForm((f) => (f ? { ...f, clientId: "", clientSecret: "" } : f)); toast.success("Saved"); },
    onError,
  });
  const test = trpc.workspace.eligibility.test.useMutation({
    onSuccess: (r) => { void utils.workspace.eligibility.invalidate(); toast.success(`Connected to Availity (${r.mode}).${r.payers != null ? ` ${r.payers} payers loaded.` : ""}`); if (r.payerListError) toast.info(r.payerListError); },
    onError,
  });
  const n = s?.lastNightly;
  return (
    <Panel
      className="lg:col-span-5"
      title={<span className="flex items-center gap-2"><ShieldCheck size={16} className="text-orange-500" /> Availity (insurance eligibility)</span>}
      subtitle={!s ? "" : s.configured ? `Connected (${s.mode === "demo" ? "demo: sample answers" : "live"})${s.nightly ? " · nightly checks on" : ""}` : "Not connected yet"}
    >
      {!s || !form ? <Loader2 size={16} className="animate-spin text-slate-400" /> : (
        <div className="grid gap-6 text-sm lg:grid-cols-5">
          <div className="space-y-3 lg:col-span-3">
            <p className="text-slate-600 dark:text-slate-300">
              Checks a patient's insurance in real time (active or not, plan, copay, deductible, and the PCP the payer has on file) from Patient 360, and every evening for everyone booked the next clinic day.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">Client ID (API key)
                <input className={cn(inputCls, "mt-1 font-mono text-xs")} value={form.clientId} placeholder={s.clientIdHint ? `Saved (${s.clientIdHint}): leave blank to keep` : ""} onChange={(e) => setForm({ ...form, clientId: e.target.value })} autoComplete="off" />
              </label>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">Client secret
                <input type="password" className={cn(inputCls, "mt-1 font-mono text-xs")} value={form.clientSecret} placeholder={s.configured ? "Saved: leave blank to keep" : ""} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} autoComplete="new-password" />
              </label>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">Group NPI
                <input className={cn(inputCls, "mt-1 font-mono text-xs")} value={form.npi} onChange={(e) => setForm({ ...form, npi: e.target.value })} maxLength={10} />
              </label>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">Organization name (as on the NPI)
                <input className={cn(inputCls, "mt-1 text-xs")} value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} maxLength={60} />
              </label>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">Plan
                <select className={cn(inputCls, "mt-1 text-xs")} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as "demo" | "production" })}>
                  <option value="demo">Demo: Availity's sample answers (no real data)</option>
                  <option value="production">Standard: real eligibility (after Availity's contract)</option>
                </select>
              </label>
              <label className="flex items-center gap-2 self-end pb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
                <input type="checkbox" className="size-4 accent-teal-700" checked={form.nightly} onChange={(e) => setForm({ ...form, nightly: e.target.checked })} />
                Check the next clinic day's patients every evening
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn variant="secondary" disabled={save.isPending} onClick={() => save.mutate({ ...form, clientId: form.clientId || null, clientSecret: form.clientSecret || null })}>{save.isPending && <Loader2 size={14} className="animate-spin" />} Save</Btn>
              <Btn disabled={!s.configured || test.isPending} onClick={() => test.mutate()}>{test.isPending ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />} Test connection</Btn>
            </div>
            <p className="text-xs text-slate-500">
              {s.payerCount ? <><CheckCircle2 size={12} className="mr-1 inline text-emerald-600" />{s.payerCount} payers in Availity's list (loaded {ago(s.payersAt)}). </> : "Payer list not loaded yet. "}
              {n ? `Last nightly run ${ago(n.lastRunAt)} for ${n.date}: ${n.booked} booked, ${n.done} checked, ${n.noInsurance} with no insurance on file${n.errors ? `, ${n.errors} couldn't be checked` : ""}.` : "No nightly run yet."}
            </p>
          </div>
          <ol className="list-decimal space-y-2 pl-5 text-xs text-slate-600 dark:text-slate-300 lg:col-span-2">
            <li>Sign up at <a className="font-semibold underline" href="https://developer.availity.com/" target="_blank" rel="noreferrer">developer.availity.com</a> (you'll set up an authenticator app).</li>
            <li>Create your organization, then <b>My Apps → Create a New App</b>.</li>
            <li>Subscribe the app to <b>Healthcare HIPAA Transactions Demo</b> and <b>Availity Payer List</b> (both approve right away).</li>
            <li>Paste the app's <b>Client ID</b> and <b>Client secret</b> here, Save, then Test connection.</li>
            <li>For real patients, request the <b>Standard</b> plan in the portal; Availity's team reviews the contract. When it's approved, switch Plan to Standard.</li>
          </ol>
        </div>
      )}
    </Panel>
  );
}
