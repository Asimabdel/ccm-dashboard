import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Copy, Loader2, Mail, RefreshCw, Upload } from "lucide-react";
import { Link } from "wouter";
import { Btn, Panel, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleString();
};

function CopyText({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-lg bg-slate-100 dark:bg-slate-800 px-2 py-1 font-mono text-xs break-all">
      {text}
      <button aria-label="Copy" onClick={() => { void navigator.clipboard.writeText(text); toast.success("Copied"); }} className="text-slate-500 hover:text-slate-900 shrink-0"><Copy size={13} /></button>
    </span>
  );
}

/** Admin card: connect the practice Gmail mailbox (read-only) and import patient email addresses. */
export function GmailCard() {
  const status = trpc.workspace.email.status.useQuery(undefined, { refetchInterval: 60_000 });
  const utils = trpc.useUtils();
  const refresh = () => void utils.workspace.email.invalidate();
  const [app, setApp] = useState({ clientId: "", clientSecret: "" });
  const fileRef = useRef<HTMLInputElement>(null);
  const s = status.data;
  const redirectUri = `${window.location.origin}/api/integrations/google/callback`;

  // Coming back from Google's sign-in page.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const msg = p.get("gmail");
    if (!msg) return;
    msg === "connected" ? toast.success("Practice mailbox connected. New emails are checked every 2 minutes.") : toast.error(msg);
    p.delete("gmail");
    window.history.replaceState(null, "", `${window.location.pathname}${p.toString() ? `?${p}` : ""}`);
    refresh();
  }, []);

  const onError = (e: { message: string }) => toast.error(e.message);
  const saveApp = trpc.workspace.email.saveApp.useMutation({ onSuccess: () => { setApp({ clientId: "", clientSecret: "" }); refresh(); toast.success("Saved. Now click Connect mailbox."); }, onError });
  const connect = trpc.workspace.email.connectUrl.useMutation({ onSuccess: (r) => { window.location.href = r.url; }, onError });
  const setEnabled = trpc.workspace.email.setEnabled.useMutation({ onSuccess: refresh, onError });
  const disconnect = trpc.workspace.email.disconnect.useMutation({ onSuccess: () => { refresh(); toast.success("Mailbox disconnected."); }, onError });
  const syncNow = trpc.workspace.email.syncNow.useMutation({
    onSuccess: (r) => { refresh(); if ("skipped" in r) toast.info(r.skipped); else if (r.error) toast.error(r.error); else toast.success(`${r.stats.processed} new emails: ${r.stats.assigned} assigned, ${r.stats.needsPatient} need a patient.`); },
    onError,
  });
  const importCsv = trpc.workspace.email.importContacts.useMutation({
    onSuccess: (r) => { refresh(); toast.success(`${r.added} patient email addresses saved (${r.withEmail} in the file; ${r.notFound} didn't match a patient by name and date of birth).`); },
    onError,
  });

  const st = s?.state;
  return (
    <Panel
      className="lg:col-span-5"
      title={<span className="flex items-center gap-2"><Mail size={16} className="text-orange-500" /> Practice mailbox (Gmail)</span>}
      subtitle={!s ? "" : s.connected ? `${s.mailbox} · ${s.enabled ? "checked every 2 minutes" : "paused"}` : s.appSaved ? "Google app saved — connect the mailbox" : "Not connected"}
    >
      <div className="grid lg:grid-cols-5 gap-6 text-sm">
        <div className="lg:col-span-3 space-y-4">
          <p className="text-slate-600 dark:text-slate-300">
            Reads new emails in the practice inbox (read-only: MyPCP can't send, delete or change anything). Each email from a patient becomes a <b>Patient email</b> task for their care coordinator, or the front desk at their clinic, with a preview and an Open in Gmail link. Emails MyPCP can't match wait on the <Link href="/patient-emails" className="font-semibold underline">Patient emails</Link> page until someone picks the patient.
          </p>

          {s?.connected && st && (
            <div className={`rounded-xl border px-3 py-2.5 text-xs ${st.lastError ? "border-rose-200 bg-rose-50 text-rose-800" : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"}`}>
              {st.lastError
                ? <p className="flex items-start gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> Last check failed: {st.lastError}</p>
                : <p className="flex items-center gap-1.5"><CheckCircle2 size={13} className="text-emerald-600" /> Last checked {ago(st.lastSuccessAt)} · {st.assigned} emails assigned, {st.needsPatient} needed a patient</p>}
              <p className="mt-1">{s.contacts.patients} patient email addresses known ({s.contacts.imported} imported) · {s.contacts.ignored} non-patient senders ignored</p>
            </div>
          )}

          {!s?.connected && (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">1 · Your Google app</p>
              <div className="grid sm:grid-cols-2 gap-3">
                <input className={inputCls} value={app.clientId} onChange={(e) => setApp({ ...app, clientId: e.target.value })} placeholder={s?.clientIdHint ? `Saved (${s.clientIdHint})` : "Client ID (…apps.googleusercontent.com)"} autoComplete="off" />
                <input className={inputCls} type="password" value={app.clientSecret} onChange={(e) => setApp({ ...app, clientSecret: e.target.value })} placeholder={s?.appSaved ? "Client Secret saved — leave blank to keep" : "Client Secret"} autoComplete="new-password" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Btn variant="secondary" disabled={saveApp.isPending || !app.clientId.trim()} onClick={() => saveApp.mutate({ clientId: app.clientId, clientSecret: app.clientSecret || null })}>Save Google app</Btn>
              </div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 pt-2">2 · Connect the mailbox</p>
              <Btn disabled={!s?.appSaved || connect.isPending} onClick={() => connect.mutate({ origin: window.location.origin })}>
                {connect.isPending && <Loader2 size={14} className="animate-spin" />} Connect mailbox with Google
              </Btn>
              <p className="text-xs text-slate-500">Sign in as the practice mailbox (e.g. care@mypcpdr.com) and allow read access.</p>
            </div>
          )}

          {s?.connected && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100 mr-2">
                <input type="checkbox" checked={s.enabled} onChange={(e) => setEnabled.mutate(e.target.checked)} /> Check for new emails every 2 minutes
              </label>
              <Btn variant="secondary" disabled={syncNow.isPending} onClick={() => syncNow.mutate()}>
                {syncNow.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Check now
              </Btn>
              <Btn variant="ghost" disabled={disconnect.isPending} onClick={() => { if (confirm("Disconnect the practice mailbox? New emails stop coming in until you connect it again.")) disconnect.mutate(); }}>Disconnect</Btn>
            </div>
          )}

          <div className="pt-3 border-t border-slate-100 dark:border-slate-700">
            <p className="font-medium text-slate-800 dark:text-slate-100">Patient email addresses from Practice Fusion</p>
            <p className="mt-1 text-xs text-slate-500">Upload a CSV with the patient's name, date of birth and email (a Practice Fusion patient list export). Patients are matched by name and date of birth; addresses staff already linked by hand are kept.</p>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) importCsv.mutate({ csv: await f.text() });
            }} />
            <Btn variant="secondary" className="mt-2" disabled={importCsv.isPending} onClick={() => fileRef.current?.click()}>
              {importCsv.isPending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Import patient emails (CSV)
            </Btn>
          </div>
        </div>

        <div className="lg:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">One-time setup (Google Workspace admin)</p>
          <ol className="list-decimal pl-5 space-y-2.5 text-slate-700 dark:text-slate-200">
            <li>Sign in to <a className="font-semibold underline" href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">console.cloud.google.com</a> with your mypcpdr.com admin account and create a project called <b>MyPCP Mailbox</b>.</li>
            <li><b>APIs &amp; Services → Library</b>: enable the <b>Gmail API</b>.</li>
            <li><b>OAuth consent screen</b>: user type <b>Internal</b>, app name <b>MyPCP</b>; add the scope <code className="text-xs">…/auth/gmail.readonly</code>.</li>
            <li><b>Credentials → Create credentials → OAuth client ID</b>, type <b>Web application</b>, with this authorized redirect URI:<br /><CopyText text={redirectUri} /></li>
            <li>Copy the <b>Client ID</b> and <b>Client Secret</b> into step 1 on the left and save.</li>
            <li>Click <b>Connect mailbox with Google</b> and sign in as the practice mailbox.</li>
          </ol>
          <p className="mt-3 text-xs text-slate-500">Patient emails are PHI: this needs Google Workspace with your signed Google BAA (not a personal Gmail account).</p>
        </div>
      </div>
    </Panel>
  );
}
