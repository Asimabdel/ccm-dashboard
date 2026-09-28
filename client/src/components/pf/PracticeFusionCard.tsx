import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Database, Loader2 } from "lucide-react";
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
