import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Copy, CreditCard, Loader2, RefreshCw, Trash2, Wallet } from "lucide-react";
import { Btn, Panel, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { SQUARE_WEBHOOK_EVENTS } from "@shared/payments";

const at = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) : "never");
const labelCls = "block text-xs font-semibold text-slate-600 dark:text-slate-300";

/** Admin card: connect the practice's Square account, pair Terminals, and say which office each device is at. */
export function SquareCard() {
  const q = trpc.workspace.payments.status.useQuery();
  const utils = trpc.useUtils();
  const s = q.data;
  const a = s?.admin;
  const [form, setForm] = useState<{ env: "sandbox" | "production"; token: string; webhookKey: string; webhookUrl: string; historyFrom: string } | null>(null);
  useEffect(() => {
    if (s && a && !form) setForm({ env: s.env, token: "", webhookKey: "", webhookUrl: a.webhookUrl, historyFrom: a.historyFrom ?? "" });
  }, [s, a, form]);
  const [locations, setLocations] = useState<{ id: string; name: string }[] | null>(null);
  const [termName, setTermName] = useState("");
  const [termClinic, setTermClinic] = useState<number | null>(null);
  const refresh = () => void utils.workspace.payments.invalidate();
  const onError = (e: { message: string }) => toast.error(e.message);

  const save = trpc.workspace.payments.saveConfig.useMutation({
    onSuccess: (r) => {
      refresh();
      setForm((f) => (f ? { ...f, token: "", webhookKey: "" } : f));
      if (r.locations && !r.locationId) { setLocations(r.locations); toast.info("Pick which Square location is the practice."); } else toast.success("Saved");
    },
    onError,
  });
  const loadLocations = trpc.workspace.payments.locations.useQuery(undefined, { enabled: false });
  const setLocation = trpc.workspace.payments.setLocation.useMutation({ onSuccess: () => { refresh(); setLocations(null); toast.success("Location saved. Loading payments…"); sync.mutate(); }, onError });
  const sync = trpc.workspace.payments.syncNow.useMutation({
    onSuccess: (r) => { refresh(); toast.success("loaded" in r ? `${r.loaded} payment${r.loaded === 1 ? "" : "s"} loaded${r.more ? " (more on the next run)" : ""}.` : "Not connected."); },
    onError,
  });
  const pair = trpc.workspace.payments.pairTerminal.useMutation({ onSuccess: () => { refresh(); setTermName(""); }, onError });
  const check = trpc.workspace.payments.checkPairing.useMutation({
    onSuccess: (r) => { refresh(); if (r.status === "paired") toast.success(`${r.name} is paired.`); else if (r.status === "expired") toast.error("The code expired. Make a new one."); else toast.info("Not paired yet. Enter the code on the Terminal first."); },
    onError,
  });
  const cancelPair = trpc.workspace.payments.cancelPairing.useMutation({ onSuccess: refresh, onError });
  const setDevice = trpc.workspace.payments.setDevice.useMutation({ onSuccess: () => { refresh(); toast.success("Saved. Past payments from it were updated."); }, onError });
  const remove = trpc.workspace.payments.removeTerminal.useMutation({ onSuccess: refresh, onError });

  if (!s) return <Panel className="lg:col-span-5" title="Square (payments)"><Loader2 size={16} className="animate-spin text-slate-400" /></Panel>;
  if (!a) return null;
  const clinics = s.clinics;
  const copy = async (t: string) => { try { await navigator.clipboard.writeText(t); toast.success("Copied"); } catch { toast.error("Couldn't copy"); } };

  return (
    <Panel
      className="lg:col-span-5"
      title={<span className="flex items-center gap-2"><Wallet size={16} className="text-orange-500" /> Square (payments)</span>}
      subtitle={s.configured
        ? `Connected${a.merchantName ? ` to ${a.merchantName}` : ""} · ${s.locationName} · ${s.env === "sandbox" ? "Sandbox (test money)" : "Production"} · ${a.payments} payment${a.payments === 1 ? "" : "s"} in MyPCP`
        : a.tokenSaved ? "Token saved: pick the location" : "Not connected yet"}
    >
      {!form ? <Loader2 size={16} className="animate-spin text-slate-400" /> : (
        <div className="grid gap-6 text-sm lg:grid-cols-5">
          <div className="space-y-4 lg:col-span-3">
            <p className="text-slate-600 dark:text-slate-300">
              Every Square payment (card, cash, payment links, Terminal) shows on the <b>Payments</b> page and on the patient's record. The front desk can send payment links and charge on the Terminal from MyPCP.
              Square doesn't sign a BAA, so MyPCP never sends it anything medical: only a plain name ("MyPCP Dr payment") and a reference number.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={labelCls}>Square account
                <select className={cn(inputCls, "mt-1 text-xs")} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value as "sandbox" | "production" })}>
                  <option value="sandbox">Sandbox: test money (for trying it out)</option>
                  <option value="production">Production: real payments</option>
                </select>
                {s.env === "sandbox" && form.env === "production" && a.tokenSaved && (
                  <span className="mt-1 block font-normal text-amber-700 dark:text-amber-300">Saving the Production token clears the Sandbox test payments from MyPCP.</span>
                )}
              </label>
              <label className={labelCls}>Access token
                <input type="password" className={cn(inputCls, "mt-1 font-mono text-xs")} value={form.token} autoComplete="new-password"
                  placeholder={a.tokenSaved && form.env === s.env ? "Saved: leave blank to keep" : "Paste the access token"} onChange={(e) => setForm({ ...form, token: e.target.value })} />
              </label>
              <label className={labelCls}>Load payments from
                <input type="date" className={cn(inputCls, "mt-1 text-xs")} value={form.historyFrom} onChange={(e) => setForm({ ...form, historyFrom: e.target.value })} />
                <span className="mt-1 block font-normal text-slate-500">Blank = the last 90 days.</span>
              </label>
              <label className={labelCls}>Webhook signature key <span className="font-normal text-slate-400">(optional, for instant updates)</span>
                <input type="password" className={cn(inputCls, "mt-1 font-mono text-xs")} value={form.webhookKey} autoComplete="new-password"
                  placeholder={a.webhookKeySaved ? "Saved: leave blank to keep" : ""} onChange={(e) => setForm({ ...form, webhookKey: e.target.value })} />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn disabled={save.isPending} onClick={() => save.mutate({ env: form.env, token: form.token || null, webhookKey: form.webhookKey || null, webhookUrl: form.webhookUrl || null, historyFrom: form.historyFrom || null })}>
                {save.isPending && <Loader2 size={14} className="animate-spin" />} Save
              </Btn>
              {a.tokenSaved && (
                <Btn variant="secondary" disabled={loadLocations.isFetching} onClick={async () => { const r = await loadLocations.refetch(); if (r.data) setLocations(r.data); else if (r.error) toast.error(r.error.message); }}>
                  {loadLocations.isFetching && <Loader2 size={14} className="animate-spin" />} {s.locationName ? "Change location" : "Pick location"}
                </Btn>
              )}
              {s.configured && <Btn variant="secondary" disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Load payments now</Btn>}
            </div>
            {locations && (
              <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-600">
                <p className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Which Square location is the practice?</p>
                <div className="flex flex-wrap gap-2">
                  {locations.map((l) => <Btn key={l.id} size="sm" variant={l.id === a.locationId ? "primary" : "secondary"} disabled={setLocation.isPending} onClick={() => setLocation.mutate({ locationId: l.id })}>{l.name}</Btn>)}
                </div>
              </div>
            )}
            {s.configured && (
              <p className="text-xs text-slate-500">
                {s.lastError ? <span className="text-rose-700 dark:text-rose-300">Last update failed: {s.lastError}. </span> : s.lastOkAt ? <><CheckCircle2 size={12} className="mr-1 inline text-emerald-600" />Updated {at(s.lastOkAt)}. </> : "Not loaded yet. "}
                {a.webhookKeySaved ? `Webhook: ${a.lastWebhookAt ? `last message ${at(a.lastWebhookAt)}` : "no message yet"}.` : "No webhook: payments update every 5 minutes."}
              </p>
            )}

            {s.configured && (
              <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-700">
                <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100"><CreditCard size={15} /> Square Terminals</h4>
                {s.terminals.length === 0 && <p className="text-xs text-slate-500">None paired yet.</p>}
                <ul className="space-y-2">
                  {s.terminals.map((t) => (
                    <li key={t.deviceId} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-[10rem] font-medium text-slate-800 dark:text-slate-100">{t.name}</span>
                      {t.test ? <span className="text-xs text-slate-500">Square's test device: always approves (Sandbox only)</span> : (
                        <>
                          <select aria-label={`Office for ${t.name}`} className={cn(inputCls, "w-auto py-1 text-xs")} value={t.clinicId ?? ""} onChange={(e) => setDevice.mutate({ deviceId: t.deviceId, clinicId: e.target.value ? Number(e.target.value) : null })}>
                            <option value="">Office: not set</option>
                            {clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                          <Btn size="sm" variant="ghost" title="Remove from MyPCP" onClick={() => { if (window.confirm(`Remove ${t.name} from MyPCP? (It stays in Square.)`)) remove.mutate({ deviceId: t.deviceId }); }}><Trash2 size={13} /></Btn>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                {a.pairing ? (
                  <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
                    <p className="text-xs">On the Terminal: <b>Sign in → Use a device code</b>, then enter</p>
                    <p className="my-1 font-mono text-2xl font-bold tracking-[0.3em]">{a.pairing.code}</p>
                    <p className="text-xs">for "{a.pairing.name}"{a.pairing.pairBy ? `, before ${at(a.pairing.pairBy)}` : ""}.</p>
                    <div className="mt-2 flex gap-2">
                      <Btn size="sm" disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending && <Loader2 size={13} className="animate-spin" />} I entered it: check</Btn>
                      <Btn size="sm" variant="ghost" onClick={() => cancelPair.mutate()}>Cancel</Btn>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className={cn(labelCls, "flex flex-col")}>Name
                      <input className={cn(inputCls, "mt-1 w-44 text-xs")} value={termName} onChange={(e) => setTermName(e.target.value)} placeholder="Front desk, Westheimer" maxLength={60} />
                    </label>
                    <label className={cn(labelCls, "flex flex-col")}>Office
                      <select className={cn(inputCls, "mt-1 w-auto text-xs")} value={termClinic ?? ""} onChange={(e) => setTermClinic(e.target.value ? Number(e.target.value) : null)}>
                        <option value="">Not set</option>
                        {clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </label>
                    <Btn size="sm" disabled={!termName.trim() || pair.isPending} onClick={() => pair.mutate({ name: termName.trim(), clinicId: termClinic })}>{pair.isPending && <Loader2 size={13} className="animate-spin" />} Pair a Terminal</Btn>
                  </div>
                )}
                {a.devicesSeen.length > 0 && (
                  <div className="space-y-2 pt-2">
                    <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">Other Square devices seen on payments: which office is each at?</p>
                    {a.devicesSeen.map((d) => (
                      <div key={d.deviceId} className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="min-w-[10rem] text-slate-700 dark:text-slate-200">{d.name ?? d.deviceId.slice(0, 10)} <span className="text-slate-400">({d.payments} payments)</span></span>
                        <select aria-label="Office" className={cn(inputCls, "w-auto py-1 text-xs")} value={d.clinicId ?? ""} onChange={(e) => setDevice.mutate({ deviceId: d.deviceId, clinicId: e.target.value ? Number(e.target.value) : null })}>
                          <option value="">Office: not set</option>
                          {clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <ol className="list-decimal space-y-2 pl-5 text-xs text-slate-600 dark:text-slate-300 lg:col-span-2">
            <li>Sign in at <a className="font-semibold underline" href="https://developer.squareup.com/apps" target="_blank" rel="noreferrer">developer.squareup.com/apps</a> with the practice's Square login, and create an app (any name, e.g. "MyPCP").</li>
            <li>Open the app → <b>Credentials</b>. To try it first, keep <b>Sandbox</b> and copy the Sandbox access token; for real payments switch to <b>Production</b> and copy that access token.</li>
            <li>Paste it here, pick the matching account type, and Save. MyPCP loads the payments.</li>
            <li>
              Optional, for instant updates: app → <b>Webhooks → Subscriptions → Add subscription</b> with this URL
              <span className="mt-1 flex items-center gap-1"><code className="break-all rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">{form.webhookUrl}</code><button className="text-brand" title="Copy" onClick={() => copy(form.webhookUrl)}><Copy size={12} /></button></span>
              and these events: {SQUARE_WEBHOOK_EVENTS.join(", ")}. Then paste its <b>signature key</b> here.
            </li>
            <li>For each Square Terminal: <b>Pair a Terminal</b> here and type the code on it.</li>
          </ol>
        </div>
      )}
    </Panel>
  );
}
