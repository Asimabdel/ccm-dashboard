import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Copy, Database, Loader2, PlugZap, RefreshCw } from "lucide-react";
import { Btn, Panel, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/** Scopes to request for the bulk export app (read-only). */
const SCOPES = "system/*.read";

function Copyable({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-lg bg-slate-100 dark:bg-slate-800 px-2 py-1 font-mono text-xs break-all">
      {text}
      <button aria-label="Copy" onClick={() => { void navigator.clipboard.writeText(text); toast.success("Copied"); }} className="text-slate-500 hover:text-slate-900 shrink-0"><Copy size={13} /></button>
    </span>
  );
}

/** Admin card: connect MyPCP to Practice Fusion's read-only FHIR bulk export. */
export function PracticeFusionCard() {
  const q = trpc.workspace.pf.status.useQuery({ origin: window.location.origin });
  const utils = trpc.useUtils();
  const [form, setForm] = useState<{ baseUrl: string; clientId: string } | null>(null);
  useEffect(() => { if (q.data && !form) setForm({ baseUrl: q.data.config.baseUrl, clientId: q.data.config.clientId }); }, [q.data, form]);
  const save = trpc.workspace.pf.save.useMutation({
    onSuccess: () => { void utils.workspace.pf.invalidate(); toast.success("Saved"); },
    onError: (e) => toast.error(e.message),
  });
  const s = q.data;
  const connected = !!(s?.config.baseUrl && s.config.clientId);
  const sync = trpc.workspace.pf.sync.useQuery(undefined, { enabled: connected, refetchInterval: (x) => (x.state.data && x.state.data.phase !== "idle" ? 10_000 : 60_000) });
  const onError = (e: { message: string }) => toast.error(e.message);
  const test = trpc.workspace.pf.test.useMutation({ onSuccess: (r) => toast.success(`Connected to Practice Fusion (FHIR ${r.fhirVersion ?? "R4"}).`), onError });
  const enable = trpc.workspace.pf.setEnabled.useMutation({ onSuccess: () => { void utils.workspace.pf.invalidate(); }, onError });
  const importNow = trpc.workspace.pf.importNow.useMutation({ onSuccess: () => { void utils.workspace.pf.invalidate(); toast.success("Import requested. It starts within 2 minutes and runs in the background."); }, onError });
  const st = sync.data;
  const loadedFiles = st?.files.filter((f) => f.status === "loaded").length ?? 0;

  return (
    <Panel
      className="lg:col-span-5"
      title={<span className="flex items-center gap-2"><Database size={16} className="text-orange-500" /> Practice Fusion chart sync</span>}
      subtitle={!s ? "" : s.config.baseUrl && s.config.clientId ? "Connection details saved; the nightly sync turns on once Practice Fusion authorizes the app" : "Not connected yet"}
    >
      {!s || !form ? <Loader2 size={16} className="animate-spin text-slate-400" /> : (
        <div className="grid lg:grid-cols-5 gap-6 text-sm">
          <div className="lg:col-span-3 space-y-4">
            <p className="text-slate-600 dark:text-slate-300">
              Brings a read-only copy of every patient's chart from Practice Fusion into MyPCP each night: problems, medications, allergies, labs, vitals, immunizations, procedures, visits, insurance and notes. It can't change anything in Practice Fusion, and Practice Fusion stays the official record.
            </p>
            <div className="space-y-3">
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">Your practice's FHIR base URL (from Practice Fusion)
                <input className={cn(inputCls, "mt-1 font-mono text-xs")} placeholder="https://…practicefusion.com/…" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
              </label>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">Client ID (from the Practice Fusion API portal)
                <input className={cn(inputCls, "mt-1 font-mono text-xs")} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} autoComplete="off" />
              </label>
              <Btn variant="secondary" disabled={save.isPending} onClick={() => save.mutate(form)}>{save.isPending && <Loader2 size={14} className="animate-spin" />} Save</Btn>
              <p className="text-xs text-slate-500">No password or secret to paste: MyPCP signs in with its own security key.</p>
            </div>
            {connected && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-3 space-y-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Btn size="sm" variant="secondary" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />} Test connection</Btn>
                  <Btn size="sm" disabled={importNow.isPending || (!!st && st.phase !== "idle" && st.phase !== "error")} onClick={() => { if (confirm("Copy every patient's chart from Practice Fusion now? The first import can take a few hours; it runs in the background.")) importNow.mutate("full"); }}>
                    <RefreshCw size={13} /> Import all charts now
                  </Btn>
                  <label className="ml-1 flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={!!st?.enabled} disabled={!st || enable.isPending} onChange={(e) => enable.mutate(e.target.checked)} /> Update every night (2 am)
                  </label>
                </div>
                {st && (
                  <div className="text-xs text-slate-600 dark:text-slate-300 space-y-1">
                    {st.phase === "exporting" && <p className="flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Practice Fusion is preparing the export{st.progress ? ` (${st.progress})` : ""}…</p>}
                    {st.phase === "downloading" && <p className="flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Downloading {st.files.length} files…</p>}
                    {st.phase === "loading" && <p className="flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Loading: {loadedFiles} of {st.files.length} files done, {Object.values(st.counts).reduce((a, b) => a + b, 0).toLocaleString()} records so far</p>}
                    {st.phase === "error" && <p className="flex items-start gap-1.5 text-rose-700"><AlertTriangle size={12} className="mt-0.5 shrink-0" /> {st.lastError}</p>}
                    {st.lastSuccessAt && <p className="flex items-center gap-1.5"><CheckCircle2 size={12} className="text-emerald-600" /> Last update {new Date(st.lastSuccessAt).toLocaleString()} ({st.mode === "delta" ? "changes only" : "full"}){st.phase === "idle" && Object.keys(st.counts).length ? `: ${Object.values(st.counts).reduce((a, b) => a + b, 0).toLocaleString()} records` : ""}</p>}
                    {!st.lastSuccessAt && st.phase === "idle" && <p>No import yet. Test the connection, then import all charts.</p>}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="lg:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">One-time setup</p>
            <ol className="list-decimal pl-5 space-y-2.5 text-slate-700 dark:text-slate-200">
              <li>Register as a developer at <a className="font-semibold underline" href="https://pfpds.practicefusion.com/s/Registration" target="_blank" rel="noreferrer">pfpds.practicefusion.com</a> and wait for the approval email.</li>
              <li>In the API portal, create an app of type <b>System or Bulk export</b>. JWKS URL:<br /><Copyable text={s.jwksUrl} /></li>
              <li>Scopes: <Copyable text={SCOPES} /> (read-only).</li>
              <li>Paste the <b>Client ID</b> and your practice's <b>FHIR base URL</b> here and save.</li>
              <li>In Practice Fusion, an admin turns on <b>FHIR</b> in settings, then clicks <b>Authorize App</b> on MyPCP.</li>
            </ol>
            <p className="mt-3 text-xs text-slate-500">Security key {s.kid.slice(0, 8)}… created {new Date(s.keyCreatedAt).toLocaleDateString()}. Only its public half is published.</p>
          </div>
        </div>
      )}
    </Panel>
  );
}
