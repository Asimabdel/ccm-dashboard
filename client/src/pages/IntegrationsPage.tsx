import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Copy, Phone, PlugZap } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Btn, ErrorNote, Loading, PageHeader, Panel, inputCls } from "@/components/workspace/ui";
import { useRingCentral } from "@/components/phone/ringcentralStore";
import { CallLogSyncCard } from "@/components/phone/CallLogSyncCard";
import { GmailCard } from "@/components/email/GmailCard";
import { trpc } from "@/lib/trpc";

const REDIRECT_URI = "https://apps.ringcentral.com/integration/ringcentral-embeddable/latest/redirect.html";
const SCOPES = ["Call Control", "Edit Message", "Edit Presence", "Internal Messages", "Read Accounts", "Read Call Log", "Read Call Recording", "Read Contacts", "Read Messages", "Read Presence", "RingOut", "SMS", "VoIP Calling", "WebSocket Subscriptions"];

function CopyText({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-lg bg-slate-100 dark:bg-slate-800 px-2 py-1 font-mono text-xs break-all">
      {text}
      <button aria-label="Copy" onClick={() => { void navigator.clipboard.writeText(text); toast.success("Copied"); }} className="text-slate-500 hover:text-slate-900 shrink-0"><Copy size={13} /></button>
    </span>
  );
}

export default function IntegrationsPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const isAdmin = user?.role === "admin";
  const cfg = trpc.workspace.phone.config.useQuery(undefined, { enabled: isAdmin });
  const utils = trpc.useUtils();
  const rc = useRingCentral();
  const [form, setForm] = useState({ enabled: false, clientId: "", allowTexting: false });
  useEffect(() => { if (cfg.data) setForm(cfg.data); }, [cfg.data]);
  const save = trpc.workspace.phone.saveConfig.useMutation({
    onSuccess: () => {
      void utils.workspace.phone.config.invalidate();
      toast.success("Saved. Everyone gets the change the next time they load the app.");
    },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user) return null;
  if (!isAdmin) return <CCMDashboardLayout title="Integrations"><p className="text-slate-500">This area is for practice managers.</p></CCMDashboardLayout>;

  const saved = cfg.data;
  const status = !saved?.enabled ? "Off" : saved.clientId ? "On — your practice's RingCentral app" : "On — RingCentral's demo app (shows a \"for demo purposes only\" banner)";

  return (
    <CCMDashboardLayout title="Integrations" pageTitle={false}>
      <PageHeader title="Integrations" subtitle="Connect the systems your team already uses." />
      {cfg.error && <ErrorNote message={cfg.error.message} />}
      {cfg.isLoading && <Loading />}
      {saved && (
        <div className="grid lg:grid-cols-5 gap-5">
          <Panel className="lg:col-span-3" title={<span className="flex items-center gap-2"><Phone size={16} className="text-orange-500" /> RingCentral phone</span>} subtitle={status}>
            <div className="space-y-4 text-sm">
              <p className="text-slate-600 dark:text-slate-300">
                Puts a RingCentral phone inside MyPCP. Staff click any patient's number to call. When the call ends, they pick how it went. Booked, declined and wrong-number calls come off the call lists, and every call shows on the patient's record.
              </p>
              <label className="flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100">
                <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Turn on the RingCentral phone for everyone
              </label>
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">Your RingCentral app's Client ID</label>
                <input className={inputCls} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} placeholder="Leave empty to try it with RingCentral's demo app" maxLength={120} />
                <p className="mt-1 text-xs text-slate-500">Only the Client ID. Never paste the client secret here.</p>
              </div>
              <label className="flex items-start gap-2 text-slate-700 dark:text-slate-200">
                <input type="checkbox" className="mt-1" checked={form.allowTexting} onChange={(e) => setForm({ ...form, allowTexting: e.target.checked })} />
                <span>Allow texting from the phone<span className="block text-xs text-slate-500">Off by default. Texting patients needs your RingCentral number registered for business texting (10DLC) and the patient's consent.</span></span>
              </label>
              <div className="flex items-center gap-3">
                <Btn disabled={save.isPending} onClick={() => save.mutate(form)}>Save</Btn>
                {rc.loaded && <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 size={14} /> Phone loaded in this browser{rc.loggedIn ? " and signed in" : " — sign in with your RingCentral login (bottom-right)"}</span>}
              </div>
            </div>
          </Panel>

          <Panel className="lg:col-span-2" title={<span className="flex items-center gap-2"><PlugZap size={16} className="text-slate-500" /> Connect your RingCentral account</span>} subtitle="One-time setup by your RingCentral admin (about 5 minutes)">
            <ol className="list-decimal pl-5 space-y-3 text-sm text-slate-700 dark:text-slate-200">
              <li>Sign in at <a className="font-semibold underline" href="https://developers.ringcentral.com/console" target="_blank" rel="noreferrer">developers.ringcentral.com</a> with your RingCentral admin login, then choose <b>Register App</b>.</li>
              <li>App type <b>REST API App</b>, platform <b>Client-side web app (SPA, JavaScript)</b>, auth <b>3-legged OAuth flow authorization code</b>.</li>
              <li>OAuth redirect URI:<br /><CopyText text={REDIRECT_URI} /></li>
              <li>Permissions (scopes): <span className="text-slate-500">{SCOPES.join(", ")}.</span></li>
              <li>Create the app, copy its <b>Client ID</b>, paste it on the left and save. That removes the demo banner.</li>
              <li>Each person signs in to the phone once with their own RingCentral login. Their calls go through your RingCentral account, which your BAA covers.</li>
            </ol>
          </Panel>

          <CallLogSyncCard />

          <GmailCard />
        </div>
      )}
    </CCMDashboardLayout>
  );
}
