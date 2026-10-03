import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, Copy, ExternalLink, HeartHandshake, Loader2, Mail, MessageSquareText, Printer, Sparkles } from "lucide-react";
import { rcText } from "@/components/phone/ringcentralStore";
import { Btn, ErrorNote, Loading, cardCls, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { LIBRARY_LANG_LABELS, LIBRARY_LANGS, learnPath, type LibraryLang } from "@shared/conditionLibrary";
import { WELLNESS_GROUPS, type WellnessGroup } from "@shared/wellness";

const CHANNEL_LABELS: Record<string, string> = { text: "Texted", email: "Emailed", link: "Link copied", print: "Printed", call: "Covered on CCM call" };

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/**
 * Patient 360 → Education: handouts for this patient's conditions, and approved prevention & wellness
 * topics (the ones suggested for their age / sex first). Text them (RingCentral), email them (practice
 * mailbox), copy the link, or print them; everything is logged. The link the patient gets names no topic.
 */
export function EducationPanel({ subjectKey }: { subjectKey: string }) {
  const q = trpc.workspace.education.forPatient.useQuery({ subjectKey });
  const w = trpc.workspace.wellness.forPatient.useQuery({ subjectKey });
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
  const [showAll, setShowAll] = useState(false);

  // Default: every approved condition handout (wellness topics are picked by hand).
  useEffect(() => { if (q.data) setPicked(new Set(q.data.conditions.filter((c) => c.approved).map((c) => c.key))); }, [q.data]);
  useEffect(() => { if (contact.data) { setLang(contact.data.language === "es" ? "es" : "en"); setTo(contact.data.email ?? ""); } }, [contact.data]);

  const wellness = w.data?.topics ?? [];
  const suggested = wellness.filter((t) => t.suggested);
  const others = useMemo(() => {
    const groups = new Map<WellnessGroup, typeof wellness>();
    for (const t of wellness) if (!t.suggested) groups.set(t.group as WellnessGroup, [...(groups.get(t.group as WellnessGroup) ?? []), t]);
    return Array.from(groups);
  }, [wellness]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote message={q.error.message} />;
  const d = q.data!;
  const keys = Array.from(picked);
  const busy = prepare.isPending || email.isPending || printed.isPending;
  const done = () => void utils.workspace.education.forPatient.invalidate({ subjectKey });
  const toggle = (key: string) => setPicked((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

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

  const row = (key: string, title: string, sub: React.ReactNode, enabled = true) => (
    <li key={key} className="flex flex-wrap items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/50">
      <input type="checkbox" className="size-4 accent-brand" disabled={!enabled} checked={picked.has(key)} aria-label={title} onChange={() => toggle(key)} />
      <span className="min-w-[10rem] flex-1">
        <span className="font-medium text-slate-900 dark:text-slate-50">{title}</span>
        {sub && <span className="block text-xs text-slate-500">{sub}</span>}
      </span>
      {enabled
        ? <a href={learnPath(key, lang)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800"><ExternalLink size={12} /> View</a>
        : <span className="text-xs text-slate-400">No handout yet</span>}
    </li>
  );

  return (
    <div className="space-y-4">
      <section className={cn(cardCls, "p-5")}>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h3 className="flex-1 font-bold text-slate-900 dark:text-slate-50">Handouts</h3>
          <div className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800" role="group" aria-label="Language">
            {LIBRARY_LANGS.map((l) => <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)} className={cn("rounded-lg px-3 py-1 text-sm font-semibold", lang === l ? "bg-white shadow-sm dark:bg-slate-700" : "text-slate-500")}>{LIBRARY_LANG_LABELS[l]}</button>)}
          </div>
        </div>

        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">For this patient's conditions</p>
        {d.conditions.length ? (
          <ul className="space-y-1.5">
            {d.conditions.map((c) => row(c.key, c.titles ? c.titles[lang] : c.label, <>{c.kind === "addon" ? `Add-on: ${c.label}` : c.diagnosis}{c.assumed ? " · type assumed" : ""}</>, c.approved))}
          </ul>
        ) : <p className="px-2 py-1 text-sm text-slate-500">No chronic conditions on record.</p>}

        <p className="mb-1 mt-4 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400"><HeartHandshake size={13} /> Prevention & wellness</p>
        {w.isLoading ? <p className="px-2 text-sm text-slate-400">Loading…</p> : wellness.length === 0 ? (
          <p className="px-2 py-1 text-sm text-slate-500">No wellness handouts are approved yet{w.data?.waitingApproval ? ` (${w.data.waitingApproval} waiting for an admin's review in Wellness handouts)` : ""}.</p>
        ) : (
          <>
            {suggested.length > 0 && (
              <ul className="space-y-1.5">
                {suggested.map((t) => row(t.key, t.titles[lang], <span className="inline-flex items-center gap-1 text-teal-700 dark:text-teal-300"><Sparkles size={11} /> Suggested: {t.why}</span>))}
              </ul>
            )}
            {others.length > 0 && (
              <>
                <button onClick={() => setShowAll((v) => !v)} className="mt-1.5 inline-flex items-center gap-1 px-2 text-xs font-semibold text-slate-500 hover:text-slate-800">
                  <ChevronDown size={13} className={cn("transition-transform", showAll && "rotate-180")} /> {showAll ? "Hide" : "Show"} all wellness topics ({others.reduce((n, [, items]) => n + items.length, 0)})
                </button>
                {showAll && others.map(([g, items]) => (
                  <div key={g} className="mt-2">
                    <p className="px-2 text-[11px] font-semibold text-slate-500">{WELLNESS_GROUPS[g].en}</p>
                    <ul className="space-y-1">{items.map((t) => row(t.key, t.titles[lang], null))}</ul>
                  </div>
                ))}
              </>
            )}
            {w.data && (w.data.person.age === null || w.data.person.sex === null) && (
              <p className="mt-2 px-2 text-[11px] text-slate-400">Suggestions use age, sex, smoking and BMI from the chart{w.data.person.age === null ? "; this patient's date of birth isn't on file" : ""}{w.data.person.sex === null ? "; sex isn't on file" : ""}.</p>
            )}
          </>
        )}

        <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
          <Btn size="sm" disabled={!keys.length || busy} onClick={sendText}>{prepare.isPending ? <Loader2 size={14} className="animate-spin" /> : <MessageSquareText size={14} />} Text</Btn>
          <Btn size="sm" variant="secondary" disabled={!keys.length || busy} onClick={() => setEmailOpen((v) => !v)}><Mail size={14} /> Email</Btn>
          <Btn size="sm" variant="secondary" disabled={!keys.length || busy} onClick={copyLink}><Copy size={14} /> Copy link</Btn>
          <Btn size="sm" variant="secondary" disabled={!keys.length || busy} onClick={print}><Printer size={14} /> Print</Btn>
          <span className="self-center text-xs text-slate-500">{keys.length} picked</span>
        </div>
        {emailOpen && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="patient@email.com" aria-label="Email address" className={cn(inputCls, "max-w-xs")} />
            <Btn size="sm" disabled={!/^\S+@\S+\.\S+$/.test(to.trim()) || busy || !mail.data?.canSend} onClick={sendEmail}>{email.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Send email</Btn>
            {mail.data && !mail.data.canSend && <span className="text-xs text-amber-700">The practice mailbox can't send yet (an admin reconnects it in Integrations).</span>}
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">The patient gets one link with the handouts you picked. The text and link don't name any topic.</p>
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
