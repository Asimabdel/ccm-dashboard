import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, CheckCircle2, Copy, CreditCard, Link2, Loader2, Mail, MessageSquareText, Search, X, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, inputCls } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { rcText } from "@/components/phone/ringcentralStore";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { PAYMENT_CATEGORIES, PAYMENT_CATEGORY_LIST, money, parseDollars, type PaymentCategory } from "@shared/payments";

export type TakeMode = "link" | "terminal";
export interface PaymentPreset {
  subjectKey?: string | null;
  name?: string | null;
  clinicId?: number | null;
  amountCents?: number | null;
  category?: PaymentCategory | null;
}

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

const labelCls = "block text-xs font-semibold text-slate-600 dark:text-slate-300";

/**
 * Take a payment through Square: a payment link to text / email / copy, or a charge on a Square Terminal.
 * Square only ever sees a plain name ("MyPCP Dr payment") and a MyPCP reference number.
 */
export function TakePaymentDialog({ open, mode, onClose, preset }: { open: boolean; mode: TakeMode; onClose: () => void; preset?: PaymentPreset | null }) {
  const ws = useWorkspace();
  const isAdmin = ws.user?.role === "admin";
  const utils = trpc.useUtils();
  const status = trpc.workspace.payments.status.useQuery(undefined, { enabled: open, staleTime: 30_000 });
  const [q, setQ] = useState("");
  const [patient, setPatient] = useState<{ key: string; name: string } | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const search = trpc.workspace.payments.searchPatients.useQuery({ q }, { enabled: open && !patient && q.trim().length >= 2 });
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<PaymentCategory>("copay");
  const [purpose, setPurpose] = useState("");
  const [clinicId, setClinicId] = useState<number | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [requestId, setRequestId] = useState<number | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);

  const dexa = category === "dexafit";
  const contact = trpc.workspace.payments.contact.useQuery({ subjectKey: patient?.key ?? "" }, { enabled: open && !!patient && mode === "link" });
  const createLink = trpc.workspace.payments.createLink.useMutation();
  const charge = trpc.workspace.payments.chargeTerminal.useMutation();
  const linkText = trpc.workspace.payments.linkText.useMutation();
  const emailLink = trpc.workspace.payments.emailLink.useMutation();
  const linkCopied = trpc.workspace.payments.linkCopied.useMutation();
  const cancel = trpc.workspace.payments.cancelRequest.useMutation();
  // A Terminal charge: ask Square every few seconds until the patient pays (or it's canceled).
  const req = trpc.workspace.payments.request.useQuery({ id: requestId ?? 0, refresh: true }, {
    enabled: open && mode === "terminal" && !!requestId,
    refetchInterval: (query) => (query.state.data && query.state.data.status !== "open" ? false : 2500),
  });

  useEffect(() => {
    if (!open) return;
    setQ(""); setWalkIn(false); setRequestId(null); setLink(null); setSent(null); setPurpose("");
    setPatient(preset?.subjectKey && preset.name ? { key: preset.subjectKey, name: preset.name } : null);
    setAmount(preset?.amountCents ? (preset.amountCents / 100).toFixed(2) : "");
    setCategory(preset?.category ?? "copay");
    setClinicId(preset?.clinicId ?? ws.clinicId ?? (ws.clinics.length === 1 ? ws.clinics[0]!.id : null));
    setPhone(""); setEmail("");
  }, [open, preset]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (contact.data) { setPhone((v) => v || contact.data.phone || ""); setEmail((v) => v || contact.data.email || ""); }
  }, [contact.data]);

  // Once a Terminal charge is paid or canceled, refresh the lists behind the dialog.
  const settled = req.data && req.data.status !== "open" ? req.data.status : null;
  useEffect(() => { if (settled) void utils.workspace.payments.invalidate(); }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps

  const terminals = status.data?.terminals ?? [];
  // Default Terminal: the one at the chosen office, else the only one.
  useEffect(() => {
    if (!open || mode !== "terminal" || !terminals.length) return;
    setDeviceId((cur) => (cur && terminals.some((t) => t.deviceId === cur) ? cur : (terminals.find((t) => t.clinicId && t.clinicId === clinicId) ?? terminals[0])!.deviceId));
  }, [open, mode, terminals, clinicId]);

  const chosen = terminals.find((t) => t.deviceId === deviceId) ?? null;
  const cents = parseDollars(amount);
  const who = dexa || walkIn || !!patient;
  const canGo = !!cents && who && (mode === "link" || !!deviceId) && !!status.data?.configured;
  const busy = createLink.isPending || charge.isPending;

  const start = async () => {
    if (!cents) return;
    // A slip of the keyboard ($2,020 for $20) shouldn't reach a patient's card.
    if (cents >= 100_000 && !window.confirm(`${mode === "link" ? "Create a payment link" : "Charge"} for ${money(cents)}? That's a large amount. Check it before going on.`)) return;
    // A Terminal charge belongs to the Terminal's office.
    const office = mode === "terminal" && chosen?.clinicId ? chosen.clinicId : clinicId;
    const base = { amountCents: cents, category, purpose: purpose.trim() || null, subjectKey: dexa ? null : patient?.key ?? null, clinicId: office };
    try {
      if (mode === "link") {
        const r = await createLink.mutateAsync(base);
        setRequestId(r.id); setLink(r.url);
      } else {
        const r = await charge.mutateAsync({ ...base, deviceId });
        setRequestId(r.id);
      }
      void utils.workspace.payments.invalidate();
    } catch (e) { toast.error((e as Error).message); }
  };

  const sendText = async () => {
    if (!requestId) return;
    try {
      const t = await linkText.mutateAsync({ id: requestId, phone: phone || null });
      if (t.phone && rcText(t.phone, t.message)) setSent("The text is ready in the RingCentral phone (bottom right). Press Send there.");
      else { await copy(t.message); setSent("The RingCentral phone isn't open, so the message was copied. Paste it into a text to the patient."); }
      void utils.workspace.payments.invalidate();
    } catch (e) { toast.error((e as Error).message); }
  };
  const sendEmail = async () => {
    if (!requestId) return;
    try {
      await emailLink.mutateAsync({ id: requestId, to: email.trim() });
      setSent(`Emailed from the practice mailbox.`);
      void utils.workspace.payments.invalidate();
    } catch (e) { toast.error((e as Error).message); }
  };
  const copyLink = async () => {
    if (!link || !requestId) return;
    if (await copy(link)) { toast.success("Link copied"); linkCopied.mutate({ id: requestId }); } else toast.error("Couldn't copy");
  };
  const stop = async () => {
    if (!requestId) return;
    try {
      const r = await cancel.mutateAsync({ id: requestId });
      void req.refetch();
      void utils.workspace.payments.invalidate();
      if (r.status === "paid") toast.success("It was already paid.");
    } catch (e) { toast.error((e as Error).message); }
  };

  const clinics = ws.clinics;
  const title = mode === "link" ? "Send a payment link" : "Charge on the Square Terminal";
  const r = req.data;
  const categories = useMemo(() => PAYMENT_CATEGORY_LIST.filter((c) => c !== "dexafit" || isAdmin), [isAdmin]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{mode === "link" ? <Link2 size={18} /> : <CreditCard size={18} />} {title}</DialogTitle>
          <DialogDescription>
            {mode === "link"
              ? "The patient gets a secure Square checkout page to pay by card, Apple Pay or Google Pay. It's marked paid here on its own."
              : "The amount appears on the Terminal for the patient to tap, insert or swipe their card."}
          </DialogDescription>
        </DialogHeader>

        {status.data && !status.data.configured && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">Square isn't connected yet. An admin can connect it in Integrations.</p>
        )}

        {/* Step 2: a link to send */}
        {mode === "link" && link && (
          <div className="space-y-4 text-sm">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
              <p className="flex items-center gap-2 font-semibold"><Check size={16} /> Payment link ready for {money(cents)}{patient && !dexa ? ` (${patient.name})` : ""}</p>
              <p className="mt-1 break-all font-mono text-xs">{link}</p>
            </div>
            {sent && <p className="rounded-lg bg-slate-50 p-3 text-slate-700 dark:bg-slate-800 dark:text-slate-200">{sent}</p>}
            <div className="space-y-2">
              <label className={labelCls}>Text it to</label>
              <div className="flex gap-2">
                <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Mobile number" inputMode="tel" />
                <Btn onClick={sendText} disabled={linkText.isPending || phone.replace(/\D/g, "").length < 10}>{linkText.isPending ? <Loader2 size={14} className="animate-spin" /> : <MessageSquareText size={14} />} Text</Btn>
              </div>
            </div>
            <div className="space-y-2">
              <label className={labelCls}>Email it to</label>
              <div className="flex gap-2">
                <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" type="email" />
                <Btn variant="secondary" onClick={sendEmail} disabled={emailLink.isPending || !/^\S+@\S+\.\S+$/.test(email.trim()) || contact.data?.canEmail === false}>{emailLink.isPending ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />} Email</Btn>
              </div>
              {contact.data?.canEmail === false && <p className="text-xs text-slate-500">Email needs the practice mailbox reconnected with sending allowed (Integrations).</p>}
            </div>
            <div className="flex flex-wrap justify-between gap-2 pt-1">
              <Btn variant="ghost" onClick={copyLink}><Copy size={14} /> Copy link</Btn>
              <Btn onClick={onClose}>Done</Btn>
            </div>
          </div>
        )}

        {/* Step 2: waiting on the Terminal */}
        {mode === "terminal" && requestId && (
          <div className="space-y-4 text-sm">
            {!r || r.status === "open" ? (
              <div className="flex flex-col items-center gap-3 rounded-xl bg-slate-50 p-6 text-center dark:bg-slate-800">
                <Loader2 size={28} className="animate-spin text-slate-400" />
                <p className="text-base font-semibold text-slate-800 dark:text-slate-100">Waiting for the patient to pay {money(cents)}…</p>
                <p className="text-slate-500">{r?.squareStatus === "IN_PROGRESS" ? "They're paying on the Terminal now." : "The amount is on the Terminal."}</p>
                <Btn variant="secondary" disabled={cancel.isPending} onClick={stop}>{cancel.isPending ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Cancel the charge</Btn>
              </div>
            ) : r.status === "paid" ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
                <CheckCircle2 size={30} />
                <p className="text-base font-semibold">Paid {money(r.amountCents)}</p>
                {r.patientName && <p>Linked to {r.patientName}.</p>}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-6 text-center dark:border-slate-700 dark:bg-slate-800">
                <XCircle size={28} className="text-slate-400" />
                <p className="text-base font-semibold text-slate-800 dark:text-slate-100">Not paid: the charge was canceled</p>
                <p className="text-slate-500">Nothing was charged. You can start it again.</p>
              </div>
            )}
            <div className="flex justify-end gap-2">
              {r && r.status === "canceled" && <Btn variant="secondary" onClick={() => setRequestId(null)}>Try again</Btn>}
              {(!r || r.status !== "open") && <Btn onClick={onClose}>Done</Btn>}
            </div>
          </div>
        )}

        {/* Step 1: who, how much, what for */}
        {!link && !requestId && (
          <div className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={labelCls}>Amount
                <div className="relative mt-1">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
                  <input className={cn(inputCls, "pl-7 text-base font-semibold tabular-nums")} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" autoFocus />
                </div>
              </label>
              <label className={labelCls}>For
                <select className={cn(inputCls, "mt-1")} value={category} onChange={(e) => setCategory(e.target.value as PaymentCategory)}>
                  {categories.map((c) => <option key={c} value={c}>{PAYMENT_CATEGORIES[c]}</option>)}
                </select>
              </label>
            </div>

            {!dexa && (
              <div className="space-y-2">
                <label className={labelCls}>Patient</label>
                {patient ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-600">
                    <span className="font-medium text-slate-800 dark:text-slate-100">{patient.name}</span>
                    {!preset?.subjectKey && <button className="text-xs font-semibold text-brand hover:underline" onClick={() => setPatient(null)}>Change</button>}
                  </div>
                ) : walkIn ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-slate-600 dark:border-slate-600 dark:text-slate-300">
                    <span>No patient (link it later on the Payments page)</span>
                    <button className="text-xs font-semibold text-brand hover:underline" onClick={() => setWalkIn(false)}>Pick a patient</button>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input className={cn(inputCls, "pl-9")} placeholder="Search by name…" value={q} onChange={(e) => setQ(e.target.value)} />
                    </div>
                    {search.isFetching && <p className="text-xs text-slate-500">Searching…</p>}
                    {(search.data ?? []).length > 0 && (
                      <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-600">
                        {search.data!.map((p) => (
                          <li key={p.key}>
                            <button className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800" onClick={() => { setPatient({ key: p.key, name: p.name }); if (!clinicId && p.clinicId) setClinicId(p.clinicId); }}>
                              <span className="font-medium text-slate-800 dark:text-slate-100">{p.name}</span>
                              <span className="text-xs text-slate-500">{[p.dob, p.clinicName, p.phoneLast4 ? `…${p.phoneLast4}` : null].filter(Boolean).join(" · ")}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button className="text-xs font-semibold text-slate-500 hover:text-slate-800 hover:underline" onClick={() => setWalkIn(true)}>No patient record? Take it without one</button>
                  </>
                )}
              </div>
            )}

            <label className={labelCls}>What it's for <span className="font-normal text-slate-400">(optional)</span>
              <input className={cn(inputCls, "mt-1")} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={255} placeholder={dexa ? "e.g. DEXA scan" : "e.g. Copay for today's visit"} />
              <span className="mt-1 block font-normal text-slate-500">Stays in MyPCP. Square only sees "{dexa ? "DexaFit Katy payment" : "MyPCP Dr payment"}" and a reference number, never anything medical.</span>
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              {mode === "terminal" && (
                <label className={labelCls}>Terminal
                  <select className={cn(inputCls, "mt-1")} value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={!terminals.length}>
                    {!terminals.length && <option value="">No Terminal paired yet</option>}
                    {terminals.map((t) => <option key={t.deviceId} value={t.deviceId}>{t.name}{t.clinicName ? ` (${t.clinicName})` : ""}</option>)}
                  </select>
                </label>
              )}
              {mode === "terminal" && chosen?.clinicId ? (
                <p className="self-end pb-2 text-xs text-slate-500">Office: {chosen.clinicName} (where the Terminal is)</p>
              ) : (
                <label className={labelCls}>Office
                  <select className={cn(inputCls, "mt-1")} value={clinicId ?? ""} onChange={(e) => setClinicId(e.target.value ? Number(e.target.value) : null)}>
                    {!ws.limitedToClinics && <option value="">Patient's office / mine</option>}
                    {clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
              )}
            </div>
            {mode === "terminal" && status.data?.configured && !terminals.length && (
              <p className="text-xs text-slate-500">An admin pairs Terminals in Integrations → Square.</p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
              <Btn onClick={start} disabled={!canGo || busy}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : mode === "link" ? <Link2 size={14} /> : <CreditCard size={14} />}
                {mode === "link" ? `Create link${cents ? ` for ${money(cents)}` : ""}` : `Charge${cents ? ` ${money(cents)}` : ""}`}
              </Btn>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
