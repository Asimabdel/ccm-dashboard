import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BookOpen, Check, Copy, ExternalLink, Loader2, Mail, MessageSquareText, Printer } from "lucide-react";
import { rcText } from "@/components/phone/ringcentralStore";
import { Btn, EmptyState, ErrorNote, Loading, cardCls, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { LIBRARY_LANG_LABELS, LIBRARY_LANGS, learnPath, type LibraryLang } from "@shared/conditionLibrary";

const CHANNEL_LABELS: Record<string, string> = { text: "Texted", email: "Emailed", link: "Link copied", print: "Printed", call: "Covered on CCM call" };

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/**
 * Patient 360 → Education: the provider-approved handouts for this patient's conditions. Text them
 * (RingCentral), email them (practice mailbox), copy the link, or print them; everything is logged.
 * The link the patient gets names no condition.
 */
export function EducationPanel({ subjectKey }: { subjectKey: string }) {
  const q = trpc.workspace.education.forPatient.useQuery({ subjectKey });
  const contact = trpc.workspace.intake.contact.useQuery({ subjectKey });
  const mail = trpc.workspace.intake.status.useQuery(undefined, { staleTime: 60_000 });
  const utils = trpc.useUtils();
  const prepare = trpc.workspace.education.prepare.useMutation();
  const email = trpc.workspace.education.email.useMutation();
  const printed = trpc.workspace.education.printed.useMutation();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [lang, setLang] = useState<LibraryLang>("en");
  const [to, setTo] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);

  // Default: every approved topic, in the patient's language.
  useEffect(() => { if (q.data) setPicked(new Set(q.data.conditions.filter((c) => c.approved).map((c) => c.key))); }, [q.data]);
  useEffect(() => { if (contact.data) { setLang(contact.data.language === "es" ? "es" : "en"); setTo(contact.data.email ?? ""); } }, [contact.data]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote message={q.error.message} />;
  const d = q.data!;
  const keys = Array.from(picked);
  const busy = prepare.isPending || email.isPending || printed.isPending;
  const done = () => void utils.workspace.education.forPatient.invalidate({ subjectKey });

  const sendText = async () => {
    const phone = contact.data?.phone;
    if (!phone) { toast.error("There's no phone number for this patient."); return; }
    try {
      const r = await prepare.mutateAsync({ subjectKey, keys, language: lang, channel: "text" });
      if (rcText(phone, r.message)) toast.success("The text is ready in the RingCentral phone (bottom right). Press Send there.");
      else { await copy(r.message); toast.success("The RingCentral phone isn't open, so the message was copied. Paste it into a text to the patient."); }
      done();
    } catch (e) { toast.error((e as Error).message); }
  };
  const copyLink = async () => {
    try {
      const r = await prepare.mutateAsync({ subjectKey, keys, language: lang, channel: "link" });
      toast.success((await copy(r.message)) ? "Message with the link copied." : r.url);
      done();
    } catch (e) { toast.error((e as Error).message); }
  };
  const sendEmail = async () => {
    try {
      await email.mutateAsync({ subjectKey, keys, language: lang, to });
      toast.success("Emailed from the practice mailbox.");
      setEmailOpen(false);
      done();
    } catch (e) { toast.error((e as Error).message); }
  };
  const print = async () => {
    window.open(`/learn/print?c=${keys.join(",")}${lang === "es" ? "&lang=es" : ""}`, "_blank", "noopener");
    try { await printed.mutateAsync({ subjectKey, keys, language: lang }); done(); } catch (e) { toast.error((e as Error).message); }
  };

  if (!d.conditions.length) {
    return <div className={cn(cardCls, "p-6")}><EmptyState icon={BookOpen} title="No chronic conditions on record" body="Handouts match the patient's conditions (from the CCM record or the Practice Fusion problem list)." /></div>;
  }
  const approvedCount = d.conditions.filter((c) => c.approved).length;

  return (
    <div className="space-y-4">
      <section className={cn(cardCls, "p-5")}>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h3 className="flex-1 font-bold text-slate-900 dark:text-slate-50">Handouts for this patient's conditions</h3>
          <div className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800" role="group" aria-label="Language">
            {LIBRARY_LANGS.map((l) => <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)} className={cn("rounded-lg px-3 py-1 text-sm font-semibold", lang === l ? "bg-white shadow-sm dark:bg-slate-700" : "text-slate-500")}>{LIBRARY_LANG_LABELS[l]}</button>)}
          </div>
        </div>
        <ul className="space-y-1.5">
          {d.conditions.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/50">
              <input type="checkbox" className="size-4 accent-brand" disabled={!c.approved} checked={picked.has(c.key)} aria-label={c.label}
                onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n; })} />
              <span className="min-w-[10rem] flex-1">
                <span className="font-medium text-slate-900 dark:text-slate-50">{c.titles ? c.titles[lang] : c.label}</span>
                <span className="block text-xs text-slate-500">{c.diagnosis}</span>
              </span>
              {c.approved
                ? <a href={learnPath(c.key, lang)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800"><ExternalLink size={12} /> View</a>
                : <span className="text-xs text-amber-700">Waiting for a provider to approve it</span>}
            </li>
          ))}
        </ul>
        {approvedCount === 0 ? (
          <p className="mt-3 text-sm text-amber-700">None of these handouts are approved yet. A provider approves them in Care plans → Condition library.</p>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-2">
              <Btn size="sm" disabled={!keys.length || busy} onClick={sendText}>{prepare.isPending ? <Loader2 size={14} className="animate-spin" /> : <MessageSquareText size={14} />} Text</Btn>
              <Btn size="sm" variant="secondary" disabled={!keys.length || busy} onClick={() => setEmailOpen((v) => !v)}><Mail size={14} /> Email</Btn>
              <Btn size="sm" variant="secondary" disabled={!keys.length || busy} onClick={copyLink}><Copy size={14} /> Copy link</Btn>
              <Btn size="sm" variant="secondary" disabled={!keys.length || busy} onClick={print}><Printer size={14} /> Print</Btn>
            </div>
            {emailOpen && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="patient@email.com" aria-label="Email address" className={cn(inputCls, "max-w-xs")} />
                <Btn size="sm" disabled={!/^\S+@\S+\.\S+$/.test(to.trim()) || busy || !mail.data?.canSend} onClick={sendEmail}>{email.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Send email</Btn>
                {mail.data && !mail.data.canSend && <span className="text-xs text-amber-700">The practice mailbox can't send yet (an admin reconnects it in Integrations).</span>}
              </div>
            )}
            <p className="mt-3 text-xs text-slate-500">The patient gets one link with the handouts you picked. The text and link don't name any condition.</p>
          </>
        )}
      </section>

      {d.history.length > 0 && (
        <section className={cn(cardCls, "p-5")}>
          <h3 className="mb-2 font-bold text-slate-900 dark:text-slate-50">Education given</h3>
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {d.history.map((h) => (
              <li key={h.id} className="flex flex-wrap gap-x-3 gap-y-0.5 py-2">
                <span className="w-24 shrink-0 text-slate-500">{fmtShortDate(h.createdAt)}</span>
                <span className="font-medium text-slate-800 dark:text-slate-100">{CHANNEL_LABELS[h.channel] ?? h.channel}</span>
                <span className="flex-1 text-slate-600 dark:text-slate-300">{h.labels.join(", ")}{h.channel !== "call" && h.language === "es" ? " (Español)" : ""}</span>
                <span className="text-xs text-slate-500">{h.by ?? ""}{h.openedAt ? " · opened" : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
