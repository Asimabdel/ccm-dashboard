import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, History, Loader2, RefreshCw } from "lucide-react";
import { Btn, Panel, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleString();
};

/**
 * Admin card for the RingCentral call-log sync (a second, server-type RingCentral app).
 * The Client Secret and JWT are write-only: they're encrypted on save and never shown again.
 */
export function CallLogSyncCard() {
  const status = trpc.workspace.phone.syncStatus.useQuery(undefined, { refetchInterval: 60_000 });
  const utils = trpc.useUtils();
  const [form, setForm] = useState({ enabled: true, clientId: "", clientSecret: "", jwt: "" });
  const s = status.data;
  useEffect(() => { if (s) setForm((f) => ({ ...f, enabled: s.configured ? s.enabled : true })); }, [s?.configured, s?.enabled]);

  const save = trpc.workspace.phone.saveSync.useMutation({
    onSuccess: (r) => {
      void utils.workspace.phone.syncStatus.invalidate();
      setForm((f) => ({ ...f, clientSecret: "", jwt: "" }));
      r.ok ? toast.success(r.message) : toast.error(r.message);
    },
    onError: (e) => toast.error(e.message),
  });
  const syncNow = trpc.workspace.phone.syncNow.useMutation({
    onSuccess: (r) => {
      void utils.workspace.phone.syncStatus.invalidate();
      if ("skipped" in r) toast.info(r.skipped);
      else if (r.error) toast.error(r.error);
      else toast.success(`Checked ${r.stats.records} calls — ${r.stats.added} new patient calls added.`);
    },
    onError: (e) => toast.error(e.message),
  });

  const st = s?.state;
  const backfilling = st?.cursor && Date.now() - new Date(st.cursor).getTime() > 60 * 60_000;
  return (
    <Panel
      className="lg:col-span-5"
      title={<span className="flex items-center gap-2"><History size={16} className="text-orange-500" /> Calls made outside MyPCP</span>}
      subtitle={!s ? "" : !s.configured ? "Not connected" : s.enabled ? `Syncing every 10 minutes · app ${s.clientIdHint}` : `Connected but paused · app ${s.clientIdHint}`}
    >
      <div className="grid lg:grid-cols-5 gap-6 text-sm">
        <div className="lg:col-span-3 space-y-4">
          <p className="text-slate-600 dark:text-slate-300">
            Brings in calls made on desk phones and the RingCentral desktop and mobile apps, so every call to or from a patient shows on their record and on the call lists, not just calls made in MyPCP. Only calls to or from a number that matches a patient are kept; all other calls are ignored.
          </p>
          {s?.configured && st && (
            <div className={`rounded-xl border px-3 py-2.5 text-xs ${st.lastError ? "border-rose-200 bg-rose-50 text-rose-800" : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"}`}>
              {st.lastError
                ? <p className="flex items-start gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> Last run failed: {st.lastError}</p>
                : <p className="flex items-center gap-1.5"><CheckCircle2 size={13} className="text-emerald-600" /> Last synced {ago(st.lastSuccessAt)} · {st.totalAdded} patient calls brought in so far</p>}
              {backfilling && <p className="mt-1">Still catching up on the last 30 days (now at {new Date(st.cursor!).toLocaleDateString()}). This finishes on its own within a couple of hours.</p>}
            </div>
          )}
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">Client ID</label>
              <input className={inputCls} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} placeholder={s?.clientIdHint ? `Saved (${s.clientIdHint}) — leave blank to keep` : "From the new app's Credentials"} maxLength={120} autoComplete="off" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">Client Secret</label>
              <input className={inputCls} type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} placeholder={s?.configured ? "Saved — leave blank to keep" : "From the new app's Credentials"} maxLength={200} autoComplete="new-password" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">JWT credential</label>
            <textarea className={`${inputCls} font-mono text-xs min-h-[70px]`} value={form.jwt} onChange={(e) => setForm({ ...form, jwt: e.target.value })} placeholder={s?.configured ? "Saved — leave blank to keep" : "Paste the JWT you created for this app"} maxLength={4000} autoComplete="off" spellCheck={false} />
            <p className="mt-1 text-xs text-slate-500">Stored encrypted and never shown again, to anyone.</p>
          </div>
          <label className="flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Sync automatically every 10 minutes
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Btn disabled={save.isPending} onClick={() => save.mutate({ enabled: form.enabled, clientId: form.clientId || null, clientSecret: form.clientSecret || null, jwt: form.jwt || null })}>
              {save.isPending && <Loader2 size={14} className="animate-spin" />} Save and test connection
            </Btn>
            {s?.configured && (
              <Btn variant="secondary" disabled={syncNow.isPending} onClick={() => syncNow.mutate()}>
                {syncNow.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sync now
              </Btn>
            )}
          </div>
        </div>
        <div className="lg:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">One-time setup (RingCentral super admin)</p>
          <ol className="list-decimal pl-5 space-y-2.5 text-slate-700 dark:text-slate-200">
            <li>At <a className="font-semibold underline" href="https://developers.ringcentral.com/console" target="_blank" rel="noreferrer">developers.ringcentral.com</a> choose <b>Register App</b> and name it <b>MyPCP Call Sync</b>.</li>
            <li>App type <b>REST API App</b>; auth <b>JWT auth flow</b>; keep it <b>private</b>.</li>
            <li>Permissions: only <b>Read Accounts</b> and <b>Read Call Log</b>.</li>
            <li>Create it, then copy its <b>Client ID</b> and <b>Client Secret</b> from the app's Credentials.</li>
            <li>Top-right profile menu → <b>Credentials</b> → <b>Create JWT</b> → "Only specific apps of my choice" → paste the new app's Client ID → create, and copy the JWT (it's shown once).</li>
            <li>Paste all three here and click <b>Save and test connection</b>. The first runs bring in the last 30 days.</li>
          </ol>
        </div>
      </div>
    </Panel>
  );
}
