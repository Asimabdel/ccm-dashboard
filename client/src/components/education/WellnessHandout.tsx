import { CalendarClock, MessageCircleQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import { WELLNESS_HEADINGS, type WellnessDoc } from "@shared/wellness";
import type { LibraryLang } from "@shared/conditionLibrary";

/**
 * One prevention & wellness handout: big type, short sections. Used on the public pages, printouts,
 * flyers and the review screen.
 */
export function WellnessHandout({ doc, lang, compact, className }: { doc: WellnessDoc; lang: LibraryLang; compact?: boolean; className?: string }) {
  const h = WELLNESS_HEADINGS[lang];
  const body = compact ? "text-sm" : "text-lg leading-relaxed";
  const list = (items: string[]) => <ul className={cn("list-disc space-y-1.5 ps-6", body)}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
  const section = (title: string, children: React.ReactNode) => (
    <section className="mt-5 break-inside-avoid">
      <h3 className={cn("font-bold text-teal-800 dark:text-teal-300", compact ? "text-sm" : "text-xl")}>{title}</h3>
      <div className="mt-1.5">{children}</div>
    </section>
  );
  return (
    <article lang={lang} className={cn("text-slate-900", className)}>
      <h2 className={cn("font-bold text-slate-900", compact ? "text-lg" : "text-3xl")}>{doc.title}</h2>
      <p className={cn("mt-3", body)}>{doc.summary}</p>
      {doc.howOften && (
        <p className={cn("mt-4 flex items-start gap-2 rounded-2xl bg-teal-50 px-4 py-3 font-semibold text-teal-900 break-inside-avoid", compact ? "text-sm" : "text-lg")}>
          <CalendarClock className="mt-0.5 size-5 shrink-0" /> <span><span className="sr-only">{h.howOften}: </span>{doc.howOften}</span>
        </p>
      )}
      {doc.whoFor.length > 0 && section(h.whoFor, list(doc.whoFor))}
      {doc.whatToDo.length > 0 && section(h.whatToDo, list(doc.whatToDo))}
      {doc.whatToExpect.length > 0 && section(h.whatToExpect, list(doc.whatToExpect))}
      {doc.talkToUs.length > 0 && (
        <section className="mt-5 break-inside-avoid rounded-2xl border-2 border-teal-200 bg-white p-4">
          <h3 className={cn("flex items-center gap-2 font-bold text-teal-900", compact ? "text-sm" : "text-xl")}><MessageCircleQuestion className="size-5 shrink-0" /> {h.talkToUs}</h3>
          <div className="mt-1.5">{list(doc.talkToUs)}</div>
        </section>
      )}
    </article>
  );
}
