import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Loader2, Mail, MessageSquareText, Link2, Search, UserPlus } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, inputCls } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { rcText } from "@/components/phone/ringcentralStore";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { INTAKE_LANGS, LANG_LABELS, MEDICAL_INTAKE_KEY, type IntakeLang } from "@shared/intake";

export interface SendPreset {
  subjectKey?: string | null;
  name?: string | null;
  phone?: string | null;
  language?: IntakeLang;
  clinicId?: number | null;
  bookingRequestId?: number | null;
}

type Via = "text" | "email" | "link";

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/**
 * Send patient forms: pick the patient (or type a new one), choose forms / language, then text
 * (opens the RingCentral phone with the message ready), email from the practice mailbox, or copy the link.
 */
export function SendFormsDialog({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: SendPreset | null }) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const choices = trpc.workspace.intake.choices.useQuery(undefined, { enabled: open });
  const mail = trpc.workspace.intake.status.useQuery(undefined, { enabled: open, staleTime: 60_000 });
  const [q, setQ] = useState("");
  const search = trpc.workspace.intake.search.useQuery({ q }, { enabled: open && q.trim().length >= 2 && !preset?.subjectKey });
  const [subjectKey, setSubjectKey] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const contact = trpc.workspace.intake.contact.useQuery({ subjectKey: subjectKey ?? "" }, { enabled: open && !!subjectKey });
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [language, setLanguage] = useState<IntakeLang>("en");
  const [clinicId, setClinicId] = useState<number | null>(null);
  const [forms, setForms] = useState<string[]>([MEDICAL_INTAKE_KEY]);
  const [via, setVia] = useState<Via>("text");
  const [done, setDone] = useState<{ via: Via; link: string; message: string; detail: string } | null>(null);

  const create = trpc.workspace.intake.create.useMutation();
  const textMessage = trpc.workspace.intake.textMessage.useMutation();
  const sendEmail = trpc.workspace.intake.sendEmail.useMutation();
  const copyLink = trpc.workspace.intake.copyLink.useMutation();
  const busy = create.isPending || textMessage.isPending || sendEmail.isPending || copyLink.isPending;

  // Fresh form every time it opens.
  useEffect(() => {
    if (!open) return;
    setQ(""); setDone(null); setManual(!!preset && !preset.subjectKey);
    setSubjectKey(preset?.subjectKey ?? null);
    setName(preset?.name ?? ""); setDob(""); setPhone(preset?.phone ?? ""); setEmail("");
    setLanguage(preset?.language ?? "en"); setClinicId(preset?.clinicId ?? null);
    setForms([MEDICAL_INTAKE_KEY]); setVia("text");
  }, [open, preset]);

  // Prefill from what MyPCP knows about the person.
  useEffect(() => {
    const c = contact.data;
    if (!c) return;
    setName((v) => c.name ?? v);
    setDob((v) => c.dob ?? v);
    setPhone((v) => v || c.phone || "");
    setEmail((v) => v || c.email || "");
    if (!preset?.language) setLanguage(c.language);
    setClinicId((v) => v ?? c.clinicId);
  }, [contact.data, preset?.language]);

  const picked = !!subjectKey || manual;
  const phoneOk = phone.replace(/\D/g, "").length >= 10;
  const emailOk = /^\S+@\S+\.\S+$/.test(email.trim());
  const canSubmit = picked && name.trim().length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(dob) && forms.length > 0
    && (via === "text" ? phoneOk : via === "email" ? emailOk && !!mail.data?.canSend : true);

  const submit = async () => {
    try {
      const r = await create.mutateAsync({
        subjectKey, name: name.trim(), dob, phone: phone || null, email: email.trim() || null, language, forms, clinicId, bookingRequestId: preset?.bookingRequestId ?? null,
      });
      if (via === "text") {
        const t = await textMessage.mutateAsync({ id: r.id });
        const opened = rcText(t.phone, t.message);
        if (!opened) await copy(t.message);
        setDone({ via, link: r.link, message: t.message, detail: opened ? "The text is ready in the RingCentral phone (bottom right). Press Send there." : "The RingCentral phone isn't open, so the text was copied. Paste it into a text message to the patient." });
      } else if (via === "email") {
        const e = await sendEmail.mutateAsync({ id: r.id });
        setDone({ via, link: r.link, message: "", detail: `Emailed to ${e.to} from the practice mailbox.` });
      } else {
        const l = await copyLink.mutateAsync({ id: r.id });
        const ok = await copy(l.message);
        setDone({ via, link: l.link, message: l.message, detail: ok ? "The message with the link was copied. Paste it wherever you need it." : "Copy the message below." });
      }
      void utils.workspace.intake.invalidate();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const langGap = language !== "en" && (choices.data ?? []).some((c) => forms.includes(c.key) && !c.langs.includes(language));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Send patient forms</DialogTitle>
          <DialogDescription>The patient gets a private link, confirms their date of birth, fills everything in on their phone and signs.</DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
              <Check className="mt-0.5 size-5 shrink-0" />
              <p>{done.detail}</p>
            </div>
            {done.message && <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">{done.message}</pre>}
            <div className="flex flex-wrap justify-end gap-2">
              <Btn variant="secondary" onClick={async () => { if (await copy(done.link)) toast.success("Link copied"); else toast.error("Couldn't copy"); }}><Copy size={14} /> Copy link only</Btn>
              <Btn onClick={onClose}>Done</Btn>
            </div>
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            {!picked && (
              <div className="space-y-2">
                <label className="block font-medium">Patient</label>
                <div className="relative">
                  <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input className={cn(inputCls, "pl-9")} placeholder="Search by name…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
                </div>
                {search.isFetching && <p className="text-xs text-slate-500">Searching…</p>}
                {(search.data ?? []).length > 0 && (
                  <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
                    {search.data!.map((s) => (
                      <li key={s.key}>
                        <button type="button" onClick={() => setSubjectKey(s.key)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
                          <span className="font-medium">{s.name}</span>
                          <span className="text-xs text-slate-500">{[s.dob, s.clinicName, s.phoneLast4 ? `…${s.phoneLast4}` : null].filter(Boolean).join(" · ")}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <button type="button" onClick={() => { setManual(true); setName(q); }} className="flex items-center gap-1.5 text-xs font-semibold text-brand hover:underline">
                  <UserPlus size={13} /> New patient (not in MyPCP yet)
                </button>
              </div>
            )}

            {picked && (
              <>
                {contact.data?.openPacketId && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    This patient already has forms waiting. You can resend those from the Patient forms page instead.
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block sm:col-span-2">
                    <span className="mb-1 block font-medium">Name</span>
                    <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={255} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block font-medium">Date of birth</span>
                    <input type="date" className={inputCls} value={dob} onChange={(e) => setDob(e.target.value)} />
                    <span className="mt-1 block text-xs text-slate-500">They type it to open the forms. Ask for it if it's blank.</span>
                  </label>
                  <label className="block">
                    <span className="mb-1 block font-medium">Language</span>
                    <select className={inputCls} value={language} onChange={(e) => setLanguage(e.target.value as IntakeLang)}>
                      {INTAKE_LANGS.map((l) => <option key={l} value={l}>{LANG_LABELS[l]}</option>)}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block font-medium">Mobile phone</span>
                    <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" maxLength={30} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block font-medium">Email</span>
                    <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" maxLength={320} />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="mb-1 block font-medium">Clinic</span>
                    <select className={inputCls} value={clinicId ?? ""} onChange={(e) => setClinicId(e.target.value ? Number(e.target.value) : null)}>
                      <option value="">Not set</option>
                      {ws.clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <span className="mt-1 block text-xs text-slate-500">Its phone number goes in the message, and its front desk gets the filing task.</span>
                  </label>
                </div>

                <fieldset>
                  <legend className="mb-1 font-medium">Forms</legend>
                  <div className="space-y-1.5">
                    {(choices.data ?? []).map((c) => (
                      <label key={c.key} className="flex items-center gap-2">
                        <input type="checkbox" className="size-4 accent-teal-700" checked={forms.includes(c.key)}
                          onChange={(e) => setForms((f) => (e.target.checked ? [...f, c.key] : f.filter((x) => x !== c.key)))} />
                        <span>{c.title}</span>
                        {!c.builtIn && c.langs.length < 3 && <span className="text-xs text-slate-500">({c.langs.map((l) => LANG_LABELS[l as IntakeLang] ?? l).join(", ")})</span>}
                      </label>
                    ))}
                    {choices.data && choices.data.length === 1 && <p className="text-xs text-slate-500">Add your consents and agreements under Patient forms → Form library.</p>}
                  </div>
                  {langGap && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">A picked form isn't available in {LANG_LABELS[language]} yet; the patient will see it in English.</p>}
                </fieldset>

                <fieldset>
                  <legend className="mb-1 font-medium">Send by</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { k: "text", icon: MessageSquareText, label: "Text", sub: phoneOk ? "RingCentral" : "needs a phone" },
                      { k: "email", icon: Mail, label: "Email", sub: !mail.data?.canSend ? "not set up" : emailOk ? "from Care@" : "needs an email" },
                      { k: "link", icon: Link2, label: "Copy link", sub: "paste anywhere" },
                    ] as const).map((o) => (
                      <button key={o.k} type="button" onClick={() => setVia(o.k)} aria-pressed={via === o.k}
                        className={cn("flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5", via === o.k ? "border-brand bg-brand/5 font-semibold" : "border-slate-200 dark:border-slate-700")}>
                        <o.icon size={18} />
                        <span>{o.label}</span>
                        <span className="text-[11px] font-normal text-slate-500">{o.sub}</span>
                      </button>
                    ))}
                  </div>
                  {via === "email" && mail.data && !mail.data.canSend && (
                    <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Email needs an admin to reconnect the practice mailbox once so MyPCP may send from it (Integrations → Practice mailbox → Reconnect to allow sending).</p>
                  )}
                </fieldset>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  {!preset?.subjectKey && <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => { setSubjectKey(null); setManual(false); }}>← Pick a different patient</button>}
                  <Btn onClick={submit} disabled={!canSubmit || busy} className="ml-auto">
                    {busy ? <Loader2 size={14} className="animate-spin" /> : via === "text" ? <MessageSquareText size={14} /> : via === "email" ? <Mail size={14} /> : <Link2 size={14} />}
                    {via === "text" ? "Create & text" : via === "email" ? "Create & email" : "Create & copy link"}
                  </Btn>
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
