import { AlertTriangle, Phone } from "lucide-react";
import { cn } from "@/lib/utils";
import { EDUCATION_HEADINGS, type EducationDoc, type LibraryLang } from "@shared/conditionLibrary";

/**
 * One patient handout: big type, short sections, the emergency box last. Used on the public pages,
 * in printouts, and as the preview in the condition library.
 */
export function Handout({ doc, lang, compact, className }: { doc: EducationDoc; lang: LibraryLang; compact?: boolean; className?: string }) {
  const h = EDUCATION_HEADINGS[lang];
  const body = compact ? "text-sm" : "text-lg leading-relaxed";
  const list = (items: string[]) => (
    <ul className={cn("list-disc space-y-1.5 ps-6", body)}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
  );
  const section = (title: string, children: React.ReactNode) => (
    <section className="mt-5 break-inside-avoid">
      <h3 className={cn("font-bold text-teal-800 dark:text-teal-300", compact ? "text-sm" : "text-xl")}>{title}</h3>
      <div className="mt-1.5">{children}</div>
    </section>
  );
  return (
    <article lang={lang} className={cn("text-slate-900", className)}>
      <h2 className={cn("font-bold text-slate-900", compact ? "text-lg" : "text-3xl")}>{doc.title}</h2>
      <p className={cn("mt-3", body)}>{doc.whatItIs}</p>
      {doc.whyItMatters && section(h.whyItMatters, <p className={body}>{doc.whyItMatters}</p>)}
      {doc.whatYouCanDo.length > 0 && section(h.whatYouCanDo, list(doc.whatYouCanDo))}
      {doc.numbers.length > 0 && section(h.numbers, list(doc.numbers))}
      {doc.medicines.length > 0 && section(h.medicines, list(doc.medicines))}
      {doc.callUs.length > 0 && (
        <section className="mt-5 break-inside-avoid rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10">
          <h3 className={cn("flex items-center gap-2 font-bold text-amber-900 dark:text-amber-200", compact ? "text-sm" : "text-xl")}><Phone className="size-5 shrink-0" /> {h.callUs}</h3>
          <div className="mt-1.5">{list(doc.callUs)}</div>
        </section>
      )}
      {doc.call911.length > 0 && (
        <section className="mt-4 break-inside-avoid rounded-2xl border-2 border-red-400 bg-red-50 p-4 dark:border-red-500/40 dark:bg-red-500/10">
          <h3 className={cn("flex items-center gap-2 font-bold text-red-800 dark:text-red-200", compact ? "text-sm" : "text-xl")}><AlertTriangle className="size-5 shrink-0" /> {h.call911}</h3>
          <div className="mt-1.5">{list(doc.call911)}</div>
        </section>
      )}
    </article>
  );
}
