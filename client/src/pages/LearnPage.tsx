import { useEffect } from "react";
import { Link, useLocation, useRoute, useSearch } from "wouter";
import { BookOpen, Loader2, Phone, Printer } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { Handout } from "@/components/education/Handout";
import { WellnessHandout } from "@/components/education/WellnessHandout";
import { WellnessFlyer } from "@/components/education/WellnessFlyer";
import { WELLNESS_GROUPS, WELLNESS_HEADINGS, type WellnessDoc, type WellnessGroup } from "@shared/wellness";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { EDUCATION_HEADINGS, LIBRARY_LANG_LABELS, LIBRARY_LANGS, keyOfSlug, slugOf, type EducationDoc, type LibraryLang } from "@shared/conditionLibrary";

const T = {
  en: { topics: "Health topics", topicsBody: "Easy-to-read information from your MyPCP Dr care team.", sentTitle: "Information from your care team", sentBody: "Your care team picked these topics for you.", notFound: "This page isn't available.", badLink: "This link isn't valid. Please call the clinic.", loading: "Loading…", none: "No topics yet.", call: "Questions? Call us at" },
  es: { topics: "Temas de salud", topicsBody: "Información fácil de leer de su equipo de MyPCP Dr.", sentTitle: "Información de su equipo de cuidado", sentBody: "Su equipo de cuidado eligió estos temas para usted.", notFound: "Esta página no está disponible.", badLink: "Este enlace no es válido. Por favor llame a la clínica.", loading: "Cargando…", none: "Todavía no hay temas.", call: "¿Preguntas? Llámenos al" },
} as const;

/** A condition handout or a prevention & wellness one, by kind. */
function AnyHandout({ kind, education, lang }: { kind: "condition" | "wellness"; education: unknown; lang: LibraryLang }) {
  const doc = (education as Record<LibraryLang, unknown>)[lang];
  return kind === "wellness" ? <WellnessHandout doc={doc as WellnessDoc} lang={lang} /> : <Handout doc={doc as EducationDoc} lang={lang} />;
}
const titleOf = (education: unknown, lang: LibraryLang) => ((education as Record<LibraryLang, { title: string }>)[lang]?.title ?? "");

/**
 * Public patient education (no login): the approved handouts, one topic at a time (/learn/diabetes),
 * a set the care team sent (/learn/s/<code>), the topic list (/learn), and printouts (/learn/print?c=…).
 * English and Spanish; large type for older readers; prints cleanly.
 */
export default function LearnPage() {
  const search = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const [, sentParams] = useRoute("/learn/s/:code");
  const [isPrint] = useRoute("/learn/print");
  const [, flyerParams] = useRoute("/learn/flyer/:slug");
  const [, topicParams] = useRoute("/learn/:slug");
  const qLang = search.get("lang");
  const lang: LibraryLang = qLang === "es" ? "es" : "en";
  const setLang = (l: LibraryLang) => {
    const s = new URLSearchParams(search);
    if (l === "en") s.delete("lang"); else s.set("lang", l);
    const qs = s.toString();
    navigate(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
  };

  if (isPrint) return <PrintHandouts keys={(search.get("c") ?? "").split(",").filter(Boolean)} lang={lang} />;
  if (flyerParams?.slug) return <Flyer slug={flyerParams.slug} lang={lang} setLang={setLang} clinicId={Number(search.get("clinic")) || null} />;
  if (sentParams?.code) return <SentSet code={sentParams.code} lang={qLang === "es" || qLang === "en" ? lang : null} setLang={setLang} />;
  if (topicParams?.slug && topicParams.slug !== "s") return <Topic slug={topicParams.slug} lang={lang} setLang={setLang} />;
  return <Topics lang={lang} setLang={setLang} />;
}

function Shell({ lang, setLang, phone, children }: { lang: LibraryLang; setLang: (l: LibraryLang) => void; phone?: string | null; children: React.ReactNode }) {
  const h = EDUCATION_HEADINGS[lang];
  return (
    <div lang={lang} className="min-h-screen bg-slate-50 text-slate-900 print:bg-white" style={{ colorScheme: "light" }}>
      <header className="border-b border-slate-200 bg-white print:hidden">
        <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <Link href={lang === "es" ? "/learn?lang=es" : "/learn"} className="flex items-center gap-2"><BrandMark size={34} /><span className="text-lg font-bold text-teal-800">MyPCP Dr</span></Link>
          <div className="flex items-center gap-2">
            <div className="flex rounded-xl bg-slate-100 p-1" role="group" aria-label="Language / Idioma">
              {LIBRARY_LANGS.map((l) => (
                <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l} className={cn("rounded-lg px-3 py-1.5 text-base font-semibold", lang === l ? "bg-white text-teal-800 shadow-sm" : "text-slate-600")}>{LIBRARY_LANG_LABELS[l]}</button>
              ))}
            </div>
            <button onClick={() => window.print()} className="flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-base font-semibold text-slate-700"><Printer className="size-5" /> {h.print}</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-6 print:max-w-none print:p-0">{children}</main>
      <footer className="mx-auto max-w-2xl px-4 pb-10 text-base text-slate-600 print:px-0">
        {phone && <p className="mb-2 flex items-center gap-2 text-lg font-semibold text-slate-800"><Phone className="size-5" /> {T[lang].call} <a className="text-teal-800 underline" href={`tel:${phone.replace(/\D/g, "")}`}>{phone}</a></p>}
        <p>{h.footer}</p>
        <p className="mt-1 text-sm text-slate-500">{h.reviewed} · MyPCP Dr</p>
      </footer>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-center py-16 text-center text-xl text-slate-700">{children}</div>;
}

function Topic({ slug, lang, setLang }: { slug: string; lang: LibraryLang; setLang: (l: LibraryLang) => void }) {
  const q = trpc.learn.topic.useQuery({ slug }, { retry: false });
  return (
    <Shell lang={lang} setLang={setLang}>
      {q.isLoading && <Centered><Loader2 className="size-10 animate-spin text-teal-700" /></Centered>}
      {q.error && <Centered>{T[lang].notFound}</Centered>}
      {q.data && <div className="rounded-3xl bg-white p-6 shadow-sm print:p-0 print:shadow-none"><AnyHandout kind={q.data.kind} education={q.data.education} lang={lang} /></div>}
      {q.data && <p className="mt-6 print:hidden"><Link href={lang === "es" ? "/learn?lang=es" : "/learn"} className="text-lg font-semibold text-teal-800 underline">{EDUCATION_HEADINGS[lang].moreTopics}</Link></p>}
    </Shell>
  );
}

function SentSet({ code, lang: chosen, setLang }: { code: string; lang: LibraryLang | null; setLang: (l: LibraryLang) => void }) {
  const q = trpc.learn.sent.useQuery({ code }, { retry: false });
  const lang = chosen ?? q.data?.language ?? "en";
  return (
    <Shell lang={lang} setLang={setLang} phone={q.data?.phone}>
      {q.isLoading && <Centered><Loader2 className="size-10 animate-spin text-teal-700" /></Centered>}
      {q.error && <Centered>{T[lang].badLink}</Centered>}
      {q.data && (
        <>
          <h1 className="text-3xl font-bold print:hidden">{T[lang].sentTitle}</h1>
          <p className="mt-2 text-lg text-slate-700 print:hidden">{T[lang].sentBody}</p>
          {q.data.topics.length > 1 && (
            <nav className="mt-4 flex flex-wrap gap-2 print:hidden">
              {q.data.topics.map((t) => <a key={t.key} href={`#${slugOf(t.key)}`} className="rounded-full bg-teal-50 px-4 py-2 text-base font-semibold text-teal-800 ring-1 ring-teal-200">{titleOf(t.education, lang)}</a>)}
            </nav>
          )}
          <div className="mt-6 space-y-6">
            {q.data.topics.map((t) => (
              <div key={t.key} id={slugOf(t.key)} className="rounded-3xl bg-white p-6 shadow-sm print:break-after-page print:p-0 print:shadow-none"><AnyHandout kind={t.kind} education={t.education} lang={lang} /></div>
            ))}
          </div>
        </>
      )}
    </Shell>
  );
}

function Topics({ lang, setLang }: { lang: LibraryLang; setLang: (l: LibraryLang) => void }) {
  const q = trpc.learn.topics.useQuery();
  return (
    <Shell lang={lang} setLang={setLang}>
      <h1 className="flex items-center gap-2 text-3xl font-bold"><BookOpen className="size-8 text-teal-700" /> {T[lang].topics}</h1>
      <p className="mt-2 text-lg text-slate-700">{T[lang].topicsBody}</p>
      {q.isLoading && <Centered><Loader2 className="size-10 animate-spin text-teal-700" /></Centered>}
      {q.data && q.data.length === 0 && <Centered>{T[lang].none}</Centered>}
      {[{ label: null as string | null, items: (q.data ?? []).filter((t) => t.kind === "condition") },
        ...(Object.keys(WELLNESS_GROUPS) as WellnessGroup[]).map((g) => ({ label: WELLNESS_GROUPS[g][lang], items: (q.data ?? []).filter((t) => t.group === g) }))]
        .filter((s) => s.items.length).map((s, i) => (
          <section key={i} className="mt-6">
            {s.label && <h2 className="mb-3 text-xl font-bold text-slate-800">{s.label}</h2>}
            <ul className="grid gap-3 sm:grid-cols-2">
              {s.items.map((t) => (
                <li key={t.key}><Link href={`/learn/${slugOf(t.key)}${lang === "es" ? "?lang=es" : ""}`} className="block rounded-2xl bg-white px-5 py-4 text-lg font-semibold text-teal-800 shadow-sm ring-1 ring-slate-200 hover:ring-teal-300">{t.titles[lang]}</Link></li>
              ))}
            </ul>
          </section>
        ))}
    </Shell>
  );
}

/** Printouts (staff print from the patient's Education tab): the chosen handouts, one per page, then the print dialog. */
function PrintHandouts({ keys, lang }: { keys: string[]; lang: LibraryLang }) {
  const qs = trpc.useQueries((t) => keys.slice(0, 30).map((k) => t.learn.topic({ slug: slugOf(keyOfSlug(k)) }, { retry: false })));
  const ready = qs.every((q) => !q.isLoading);
  const docs = qs.map((q) => q.data).filter((d): d is NonNullable<typeof d> => !!d);
  useEffect(() => { if (ready && docs.length) { const t = setTimeout(() => window.print(), 400); return () => clearTimeout(t); } }, [ready, docs.length]);
  return (
    <div lang={lang} className="bg-white text-slate-900" style={{ colorScheme: "light" }}>
      {!ready && <Centered><Loader2 className="size-10 animate-spin text-teal-700" /></Centered>}
      {ready && !docs.length && <Centered>{T[lang].notFound}</Centered>}
      {docs.map((d, i) => (
        <div key={i} className="mx-auto max-w-2xl px-6 py-8 print:max-w-none print:break-after-page print:px-0 print:py-0">
          <div className="mb-4 flex items-center gap-2 border-b border-slate-200 pb-3"><BrandMark size={30} /><span className="text-lg font-bold text-teal-800">MyPCP Dr</span></div>
          <AnyHandout kind={d.kind} education={d.education} lang={lang} />
          <p className="mt-6 text-sm text-slate-500">{EDUCATION_HEADINGS[lang].footer}</p>
        </div>
      ))}
    </div>
  );
}

/** A branded one-page flyer of a wellness topic (staff print it from Wellness handouts): pick the clinic and language, then print. */
function Flyer({ slug, lang, setLang, clinicId }: { slug: string; lang: LibraryLang; setLang: (l: LibraryLang) => void; clinicId: number | null }) {
  const q = trpc.learn.topic.useQuery({ slug }, { retry: false });
  const clinics = trpc.learn.clinics.useQuery();
  const [, navigate] = useLocation();
  const clinic = (clinics.data ?? []).find((c) => c.id === clinicId) ?? clinics.data?.[0] ?? null;
  const setClinic = (id: number) => {
    const s = new URLSearchParams(window.location.search);
    s.set("clinic", String(id));
    navigate(`${window.location.pathname}?${s.toString()}`, { replace: true });
  };
  const online = `${window.location.origin}/learn/${slug}${lang === "es" ? "?lang=es" : ""}`;
  return (
    <div className="min-h-screen bg-slate-100 py-6 print:bg-white print:py-0" style={{ colorScheme: "light" }}>
      <style>{"@page { size: letter; margin: 0 } @media print { .flyer { width: 8.5in } }"}</style>
      <div className="mx-auto mb-4 flex w-[8.5in] max-w-full flex-wrap items-center gap-2 print:hidden">
        <div className="flex rounded-xl bg-white p-1 shadow-sm" role="group" aria-label="Language / Idioma">
          {LIBRARY_LANGS.map((l) => <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l} className={cn("rounded-lg px-3 py-1.5 text-sm font-semibold", lang === l ? "bg-teal-700 text-white" : "text-slate-600")}>{LIBRARY_LANG_LABELS[l]}</button>)}
        </div>
        <select value={clinic?.id ?? ""} onChange={(e) => setClinic(Number(e.target.value))} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm" aria-label="Clinic">
          {(clinics.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={() => window.print()} className="ml-auto flex items-center gap-1.5 rounded-xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white"><Printer className="size-4" /> {EDUCATION_HEADINGS[lang].print}</button>
      </div>
      {q.isLoading && <Centered><Loader2 className="size-10 animate-spin text-teal-700" /></Centered>}
      {q.error && <Centered>{T[lang].notFound}</Centered>}
      {q.data && q.data.kind === "wellness" && <WellnessFlyer doc={(q.data.education as Record<LibraryLang, WellnessDoc>)[lang]} lang={lang} clinic={clinic} onlineUrl={online} />}
      {q.data && q.data.kind !== "wellness" && <div className="mx-auto max-w-2xl rounded-3xl bg-white p-6"><AnyHandout kind={q.data.kind} education={q.data.education} lang={lang} /></div>}
    </div>
  );
}
