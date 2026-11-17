// A document from the office (Documents), on the patient's phone: their boxes as one big question at a time,
// then the whole document with their answers on it, then their signature. Loaded only when such a document
// is opened (it brings the PDF viewer with it).
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, FileSignature, Loader2, Square } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { openPdf, type PdfDoc } from "@/lib/pdf";
import { Pages } from "@/components/documents/PdfPages";
import { FieldBox } from "@/components/documents/FieldBox";
import { PALETTE, PATIENT_COLOR } from "@/components/documents/editorShared";
import { BigButton, Note, SignBlock } from "@/pages/PatientFormsPage";
import { usDate, type DocField } from "@shared/documents";
import type { IntakeLang } from "@shared/intake";
import { T, t } from "./patientStrings";

type View = RouterOutputs["patientForms"]["docLoad"];
type Box = View["fields"][number];
const isSig = (type: string) => type === "signature" || type === "initials";
const DEFAULT_LABEL: Record<string, Record<IntakeLang, string>> = {
  text: { en: "Your answer", es: "Su respuesta", ar: "إجابتك" },
  date: { en: "Date", es: "Fecha", ar: "التاريخ" },
  checkbox: { en: "Check if this applies to you", es: "Marque si esto le aplica", ar: "حدّد إذا كان هذا ينطبق عليك" },
};
const noop = () => {};
/** Boxes the office fills or signs (shown on the patient's look at the document). */
const CARE_TEAM: Record<IntakeLang, string> = { en: "Your care team", es: "Su equipo médico", ar: "فريق الرعاية" };

export default function PatientDocForm({ lang, session, formKey, onExit, onSigned, onServerError }: {
  lang: IntakeLang; session: string; formKey: string; onExit: () => void; onSigned: (completed: boolean) => void; onServerError: (e: unknown) => boolean;
}) {
  const load = trpc.patientForms.docLoad.useMutation();
  const save = trpc.patientForms.docSave.useMutation();
  const [view, setView] = useState<View | null>(null);
  const [gone, setGone] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  // -1 = start, 0…n-1 = one box each, n = check the whole document and sign.
  const [step, setStep] = useState(-1);
  const [err, setErr] = useState<string | null>(null);
  const [pdf, setPdf] = useState<PdfDoc | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const v = await load.mutateAsync({ session, formKey });
        if (!alive) return;
        if (!v.waiting) { setGone(true); return; }
        setView(v);
        setValues(v.answers ?? {});
      } catch (e) { if (alive && !onServerError(e)) setGone(true); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, formKey]);
  // The PDF itself (for the look at the whole document) opens in the background while they answer.
  useEffect(() => {
    if (!view || pdf) return;
    openPdf(view.file).then(setPdf).catch(() => setErr(t(T.docGone, lang)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Their boxes in reading order: page by page, top to bottom, left to right.
  const questions = useMemo(() => (view ? view.fields.filter((f) => f.mine && !isSig(f.type)).sort((a, b) => a.page - b.page || (b.y + b.h) - (a.y + a.h) || a.x - b.x) : []), [view]);
  const n = questions.length;

  const persist = async (next: Record<string, string>) => {
    try { await save.mutateAsync({ session, formKey, values: next }); } catch (e) { onServerError(e); }
  };
  const goTo = async (to: number) => { setErr(null); await persist(values); setStep(to); window.scrollTo({ top: 0 }); };
  const label = (f: Box) => f.label?.trim() || DEFAULT_LABEL[f.type]?.[lang] || DEFAULT_LABEL.text![lang];

  if (gone) return <div className="space-y-4"><Note tone="warn">{t(T.docGone, lang)}</Note><BigButton variant="secondary" onClick={onExit} className="w-full">{t(T.allForms, lang)}</BigButton></div>;
  if (!view) return <div className="flex flex-col items-center py-24 text-center"><Loader2 className="size-10 animate-spin text-teal-700" /><p className="mt-3 text-lg">{t(T.docLoading, lang)}</p></div>;

  const back = (
    <button type="button" onClick={() => (step <= -1 ? onExit() : void goTo(step - 1))} className="flex items-center gap-1 text-lg font-semibold text-teal-800">
      <ChevronLeft className="size-6 rtl:rotate-180" /> {step <= -1 ? t(T.allForms, lang) : t(T.back, lang)}
    </button>
  );

  // Start
  if (step === -1) {
    return (
      <div className="space-y-5">
        {back}
        <div className="rounded-3xl border-2 border-teal-600 bg-white p-6 shadow-sm">
          <div className="grid size-14 place-items-center rounded-2xl bg-fuchsia-50 text-fuchsia-700"><FileSignature className="size-8" /></div>
          <p className="mt-4 text-base font-semibold text-slate-500">{t(T.docFill, lang)}</p>
          <h1 className="text-3xl font-bold leading-tight">{view.title}</h1>
          <p className="mt-3 text-xl text-slate-700">{t(T.docIntro, lang)}</p>
          {n > 0 && <p className="mt-3 text-lg font-semibold text-slate-600">{t(T.docBoxes, lang, { n })}</p>}
        </div>
        <BigButton onClick={() => void goTo(0)} className="w-full">{t(T.begin, lang)} <ChevronRight className="size-6 rtl:rotate-180" /></BigButton>
      </div>
    );
  }

  // One box at a time
  if (step < n) {
    const f = questions[step]!;
    const v = values[f.id] ?? "";
    const set = (x: string) => { setErr(null); setValues((o) => ({ ...o, [f.id]: x })); };
    const next = () => {
      const filled = f.type === "checkbox" ? v === "x" : !!v.trim();
      if (f.required && !filled) { setErr(t(T.required, lang)); return; }
      void goTo(step + 1);
    };
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-3">{back}<span className="text-base font-semibold text-slate-500">{t(T.step, lang, { i: step + 1, n: n + 1 })}</span></div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-teal-600 transition-all" style={{ width: `${((step + 1) / (n + 1)) * 100}%` }} /></div>
        <p className="text-base font-semibold text-slate-500">{view.title} · {t(T.docOnPage, lang, { p: f.page + 1 })}</p>
        <div className="rounded-3xl border-2 border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-2xl font-bold leading-snug">{label(f)}{f.required && <span className="text-red-600"> *</span>}</p>
          {f.type === "checkbox" ? (
            <button type="button" onClick={() => set(v === "x" ? "" : "x")} aria-pressed={v === "x"}
              className={cn("mt-4 flex min-h-16 w-full items-center gap-4 rounded-2xl border-2 px-5 text-xl font-semibold", v === "x" ? "border-teal-700 bg-teal-50 text-teal-900" : "border-slate-300 bg-white text-slate-700")}>
              {v === "x" ? <Check className="size-8 text-teal-700" strokeWidth={3} /> : <Square className="size-8 text-slate-400" />}
              {v === "x" ? t(T.docTicked, lang) : t(T.docTickIt, lang)}
            </button>
          ) : f.type === "date" ? (
            <input type="date" value={v} onChange={(e) => set(e.target.value)} className="mt-4 h-16 w-full rounded-2xl border-2 border-slate-300 bg-white px-4 text-xl" />
          ) : f.h > 30 ? (
            <textarea value={v} onChange={(e) => set(e.target.value)} rows={4} maxLength={2000} className="mt-4 w-full rounded-2xl border-2 border-slate-300 bg-white p-4 text-xl" />
          ) : (
            <input type="text" value={v} onChange={(e) => set(e.target.value)} maxLength={300} enterKeyHint="next" onKeyDown={(e) => { if (e.key === "Enter") next(); }}
              className="mt-4 h-16 w-full rounded-2xl border-2 border-slate-300 bg-white px-4 text-xl" />
          )}
          {!f.required && <p className="mt-2 text-base text-slate-500">{t(T.docOptional, lang)}</p>}
        </div>
        {err && <Note tone="error">{err}</Note>}
        <BigButton onClick={next} className="w-full">{t(T.next, lang)} <ChevronRight className="size-6 rtl:rotate-180" /></BigButton>
      </div>
    );
  }

  // The whole document with their answers on it, then sign.
  const shown = (f: Box): DocField => (f.mine && !isSig(f.type) ? { ...f, value: values[f.id] ?? "" } : isSig(f.type) ? { ...f, value: null } : f) as DocField;
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">{back}<span className="text-base font-semibold text-slate-500">{t(T.step, lang, { i: n + 1, n: n + 1 })}</span></div>
      <div>
        <h1 className="text-3xl font-bold">{t(T.docReviewTitle, lang)}</h1>
        <p className="mt-2 text-xl text-slate-700">{t(T.docReviewBody, lang)}</p>
      </div>
      {n > 0 && (
        <ul className="divide-y divide-slate-100 rounded-3xl border-2 border-slate-200 bg-white">
          {questions.map((f, i) => {
            const v = values[f.id] ?? "";
            return (
              <li key={f.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-base text-slate-500">{label(f)}</p>
                  <p className="truncate text-xl font-semibold">{f.type === "checkbox" ? (v === "x" ? `✓ ${t(T.docTicked, lang)}` : "—") : f.type === "date" ? usDate(v) || "—" : v || "—"}</p>
                </div>
                <button type="button" onClick={() => void goTo(i)} className="shrink-0 rounded-xl border-2 border-slate-300 px-3 py-1.5 text-base font-semibold text-teal-800">{t(T.change, lang)}</button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="rounded-3xl border-2 border-slate-200 bg-slate-100 p-2">
        {pdf ? (
          <Pages pdf={pdf} count={view.pages.length} zoom={1} fit="width" className="overflow-x-auto" drawing={false} onPageClick={noop} onDraw={noop}
            overlay={(page, vp) => view.fields.filter((f) => f.page === page).map((f) => (
              <FieldBox key={f.id} f={shown(f)} vp={vp} color={f.mine ? PATIENT_COLOR : PALETTE[0]!} who={f.mine ? (isSig(f.type) ? t(T.docYourSignature, lang) : label(f)) : CARE_TEAM[lang]}
                editable={false} fillable={false} selected={false} resizable={false} inert flash={false} tapToFill={false} sig={null}
                onSelect={noop} onMoveStart={noop} onMove={noop} onMoveEnd={noop} onValue={noop} onSign={noop} onTapFill={noop} />
            ))} />
        ) : <div className="flex justify-center py-16"><Loader2 className="size-8 animate-spin text-teal-700" /></div>}
      </div>
      {err && <Note tone="error">{err}</Note>}
      <SignBlock lang={lang} session={session} formKey={formKey} version={1} language={lang} consentLabel={t(T.docAgree, lang)}
        beforeSign={async () => { await persist(values); return true; }}
        onSigned={onSigned}
        onError={(e) => onServerError(e)} />
    </div>
  );
}
