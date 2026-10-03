import { useEffect, useLayoutEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { CalendarClock, MapPin, MessageCircleQuestion, Phone } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { formatPhone } from "@shared/phone";
import { WELLNESS_HEADINGS, type WellnessDoc } from "@shared/wellness";
import type { LibraryLang } from "@shared/conditionLibrary";

const T = {
  en: { scan: "Scan to read this online", also: "También en español", footer: "This is general information. Talk with your care team about what's right for you." },
  es: { scan: "Escanee para leer esto en línea", also: "Also in English", footer: "Esta es información general. Hable con su equipo de cuidado sobre lo que es mejor para usted." },
} as const;

/** One US Letter page in CSS pixels (11in at 96 dpi). */
const PAGE_PX = 1056;
/** Text sizes tried, largest first; below the last one it prints front and back at full size instead. */
const SIZES = [14, 13.5, 13, 12.5, 12];

/**
 * A branded flyer (US Letter) for the front desk or to hand to patients: logo and clinic, the
 * handout in two columns, and a QR code to the online version. Shrinks its text a little to fit one
 * page; a long topic prints front and back instead of in tiny type.
 */
export function WellnessFlyer({ doc, lang, clinic, onlineUrl }: { doc: WellnessDoc; lang: LibraryLang; clinic: { name: string; address: string | null; phone: string | null } | null; onlineUrl: string }) {
  const h = WELLNESS_HEADINGS[lang];
  const ref = useRef<HTMLDivElement>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [fit, setFit] = useState({ step: 0, pages: 1 });
  useEffect(() => { void QRCode.toDataURL(onlineUrl, { margin: 1, width: 260, errorCorrectionLevel: "M" }).then(setQr).catch(() => setQr(null)); }, [onlineUrl]);
  // New topic or language: start again at the largest size.
  useLayoutEffect(() => setFit({ step: 0, pages: 1 }), [doc, lang]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || fit.pages === 2) return;
    if (el.offsetHeight <= PAGE_PX + 1) return;
    setFit(fit.step < SIZES.length - 1 ? { step: fit.step + 1, pages: 1 } : { step: 0, pages: 2 });
  }, [fit, doc, lang, qr]);

  const list = (items: string[]) => <ul className="list-disc space-y-[0.3em] ps-[1.4em]">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
  const block = (title: string, items: string[]) => items.length ? (
    <section className="mb-[1.3em] break-inside-avoid">
      <h3 className="mb-[0.3em] text-[1.07em] font-bold uppercase tracking-wide text-teal-800">{title}</h3>
      {list(items)}
    </section>
  ) : null;
  const exact = { printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" } as const;

  return (
    <div ref={ref} lang={lang} data-pages={fit.pages} className="flyer mx-auto flex w-[8.5in] flex-col bg-white leading-snug text-slate-900 shadow-lg print:shadow-none"
      style={{ colorScheme: "light", fontSize: SIZES[fit.step], minHeight: `${fit.pages * 11}in` }}>
      <header className="flex items-center justify-between gap-4 bg-teal-700 px-8 py-4 text-white" style={exact}>
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-white p-1.5"><BrandMark size={38} /></span>
          <div>
            <p className="text-2xl font-bold leading-tight">MyPCP Dr</p>
            {clinic && <p className="text-sm text-teal-50">{clinic.name}</p>}
          </div>
        </div>
        <p className="text-right text-sm font-semibold uppercase tracking-wider text-teal-100">{h.group}</p>
      </header>

      <main className="flex-1 px-8 pt-[1.6em]">
        <h1 className="text-[2.4em] font-extrabold leading-tight text-slate-900">{doc.title}</h1>
        <p className="mt-[0.7em] text-[1.14em] leading-relaxed text-slate-800">{doc.summary}</p>
        {doc.howOften && (
          <p className="mt-[0.9em] flex items-center gap-2 rounded-xl bg-teal-50 px-4 py-[0.6em] text-[1.14em] font-semibold text-teal-900" style={exact}>
            <CalendarClock className="size-5 shrink-0" /> {doc.howOften}
          </p>
        )}
        <div className="mt-[1.4em] columns-2 gap-x-8">
          {block(h.whoFor, doc.whoFor)}
          {block(h.whatToDo, doc.whatToDo)}
          {block(h.whatToExpect, doc.whatToExpect)}
        </div>
        {doc.talkToUs.length > 0 && (
          <section className="break-inside-avoid rounded-xl border-2 border-teal-200 px-4 py-[0.7em]">
            <h3 className="mb-[0.3em] flex items-center gap-2 text-[1.07em] font-bold text-teal-900"><MessageCircleQuestion className="size-4" /> {h.talkToUs}</h3>
            {list(doc.talkToUs)}
          </section>
        )}
      </main>

      <footer className="mt-6 flex break-inside-avoid items-end justify-between gap-6 border-t-4 border-teal-700 px-8 py-4">
        <div className="space-y-1 text-[13px] text-slate-700">
          {clinic?.phone && <p className="flex items-center gap-1.5 text-[16px] font-bold text-slate-900"><Phone className="size-4" /> {formatPhone(clinic.phone)}</p>}
          {clinic?.address && <p className="flex items-center gap-1.5"><MapPin className="size-4 shrink-0" /> {clinic.address}</p>}
          <p className="font-semibold text-teal-800">mypcpdr.com</p>
          <p className="max-w-[5in] pt-1 text-[11px] text-slate-500">{T[lang].footer}</p>
        </div>
        {qr && (
          <div className="flex shrink-0 flex-col items-center text-center">
            <img src={qr} alt="" className="size-24" />
            <p className="mt-1 text-[11px] font-semibold text-slate-700">{T[lang].scan}</p>
            <p className="text-[10px] text-slate-500">{T[lang].also}</p>
          </div>
        )}
      </footer>
    </div>
  );
}
