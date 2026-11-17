import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Banknote, CalendarDays, Camera, Copy, CreditCard, Loader2, Search } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { EmptyState, ErrorNote, Loading, PageHeader, Panel, fmtClock, fmtDob, inputCls } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { chartHref } from "@/components/chart/ChartLookup";
import { ESTIMATE_NOTE } from "@/components/billing/CollectChip";
import { cn } from "@/lib/utils";
import { shrinkImage } from "@/lib/shrinkImage";
import { shortDay, usd } from "@shared/visitCost";
import { SURENESS_LABELS, type AnswerKind, type Sureness } from "@shared/visitCostAnswer";

type Result = RouterOutputs["workspace"]["visitCost"]["answer"];
interface Picked { key: string; name: string; dob: string | null }

/**
 * Copays & deductibles (2026-11-17): one search. Type a patient's name or date of birth, pick them, and
 * see what they will likely pay for today's visit (from what insurance said on their past visits), with
 * the line to read to them in English and Spanish.
 */
export default function CopaysPage() {
  useAuth({ redirectOnUnauthenticated: true });
  const { visitCost, loading } = useWorkspace();
  const [picked, setPicked] = useState<Picked | null>(null);
  return (
    <CCMDashboardLayout title="Copays & deductibles" pageTitle={false}>
      <PageHeader title="Copays & deductibles" subtitle="Search a patient to see what they'll likely pay today." />
      {loading ? <Loading /> : !visitCost ? (
        <Panel><EmptyState icon={Banknote} title="Not switched on for your role yet" body="An admin is checking these estimates first. They will show here once they are opened to the team." /></Panel>
      ) : (
        <div className="mx-auto max-w-2xl space-y-5">
          <PatientSearch onPick={setPicked} />
          {picked ? <AnswerCard picked={picked} /> : (
            <p className="text-center text-sm text-slate-500">Type a name (Maria Garcia) or a date of birth (3/15/1950), or both.</p>
          )}
        </div>
      )}
    </CCMDashboardLayout>
  );
}

// ---- The search box ----

function PatientSearch({ onPick }: { onPick: (p: Picked) => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const results = trpc.workspace.directory.list.useQuery({ q: debounced, status: "all", sort: "name", page: 1 }, { enabled: debounced.length >= 2, placeholderData: (prev) => prev });
  const rows = debounced.length >= 2 ? (results.data?.rows ?? []).slice(0, 8) : [];
  useEffect(() => setAt(0), [debounced]);
  const pick = (r: (typeof rows)[number]) => {
    onPick({ key: r.key, name: r.name, dob: r.dob });
    setQ("");
    setDebounced("");
    setOpen(false);
    input.current?.blur();
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(i + 1, Math.max(rows.length - 1, 0))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && rows[at]) { e.preventDefault(); pick(rows[at]!); }
    else if (e.key === "Escape") setOpen(false);
  };
  const showList = open && debounced.length >= 2;
  return (
    <div className="relative">
      <Search size={20} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
      <input ref={input} autoFocus value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKey}
        className={cn(inputCls, "rounded-2xl py-4 pl-12 text-lg shadow-sm")} placeholder="Patient name or date of birth" aria-label="Find a patient by name or date of birth" autoComplete="off" role="combobox" aria-expanded={showList} />
      {showList && (
        <div className="absolute z-20 mt-2 max-h-96 w-full overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-600 dark:bg-slate-800" role="listbox">
          {results.isFetching && !rows.length && <p className="px-4 py-3 text-sm text-slate-400">Searching…</p>}
          {!results.isFetching && !rows.length && <p className="px-4 py-3 text-sm text-slate-400">No patient matches. Try the last name, or the date of birth like 3/15/1950.</p>}
          {rows.map((r, i) => (
            <button type="button" key={r.key} role="option" aria-selected={i === at} onMouseDown={(e) => { e.preventDefault(); pick(r); }} onMouseEnter={() => setAt(i)}
              className={cn("flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left", i === at ? "bg-slate-100 dark:bg-slate-700" : "")}>
              <span className="min-w-0">
                <span className="block truncate font-semibold text-slate-900 dark:text-slate-50">{r.name}</span>
                <span className="block text-xs text-slate-500">{[r.dob ? `DOB ${fmtDob(r.dob)}` : null, r.clinicName].filter(Boolean).join(" · ")}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- The answer ----

const TONES: Record<AnswerKind, { box: string; text: string }> = {
  collect: { box: "border-teal-200 bg-teal-50 dark:border-teal-900 dark:bg-teal-950/40", text: "text-teal-800 dark:text-teal-200" },
  nothing: { box: "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40", text: "text-emerald-800 dark:text-emerald-200" },
  selfpay: { box: "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40", text: "text-amber-900 dark:text-amber-200" },
  unknown: { box: "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/60", text: "text-slate-700 dark:text-slate-200" },
};
const SURE_TONES: Record<Sureness, string> = {
  sure: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  likely: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
  guess: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200",
};

function visitLine(r: Result): string {
  const v = r.visit;
  if (!v) return "No visit booked: this is for an office visit.";
  const when = v.today ? `Today at ${fmtClock(v.startsAt)}` : `Next visit ${new Date(`${v.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} at ${fmtClock(v.startsAt)}`;
  return [when, v.type, v.provider, v.clinic].filter(Boolean).join(" · ");
}

function AnswerCard({ picked }: { picked: Picked }) {
  const q = trpc.workspace.visitCost.answer.useQuery({ key: picked.key }, { retry: false, staleTime: 5 * 60_000 });
  const read = trpc.workspace.visitCost.readCard.useMutation({ onSettled: () => { void q.refetch(); } });
  const tried = useRef<string | null>(null);
  // A card photo nobody has read yet: read it now, then show the answer again.
  useEffect(() => {
    const c = q.data?.card;
    if (c?.state === "unread" && c.canRead && tried.current !== picked.key) { tried.current = picked.key; read.mutate({ key: picked.key }); }
  }, [q.data?.card?.state, picked.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isLoading) return <Panel><p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Working out what {picked.name} pays…</p></Panel>;
  if (q.error) return <ErrorNote message={q.error.message} />;
  const r = q.data!;
  const a = r.answer;
  const tone = TONES[a.kind];
  const insuranceTab = r.patient.patientId ? `/patients/${r.patient.patientId}?tab=insurance` : chartHref(r.patient.key);
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="border-b border-slate-100 px-5 py-4 dark:border-slate-800">
        <p className="text-lg font-bold text-slate-900 dark:text-slate-50">{r.patient.name ?? picked.name}{(r.patient.dob ?? picked.dob) && <span className="ml-2 text-sm font-normal text-slate-500">DOB {fmtDob(r.patient.dob ?? picked.dob)}</span>}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300"><CalendarDays size={14} className="shrink-0" /> {visitLine(r)}</p>
        <CardLine r={r} reading={read.isPending} patientKey={r.patient.key} onSnapped={() => { void q.refetch(); }} />
      </div>

      <div className={cn("m-4 rounded-xl border px-5 py-5", tone.box)}>
        <div className="flex flex-wrap items-center gap-3">
          <p className={cn("text-3xl font-extrabold tracking-tight sm:text-4xl", tone.text)}>{a.headline}</p>
          {a.sure && <span className={cn("rounded-full px-2.5 py-1 text-xs font-bold", SURE_TONES[a.sure])} title="How sure: Sure = the same amount on every recent visit; Likely = most visits agree; Best guess = little to go on, or it may have changed.">{SURENESS_LABELS[a.sure]}</span>}
        </div>
        <ul className="mt-3 space-y-1 text-sm text-slate-700 dark:text-slate-200">
          {a.why.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      </div>

      <div className="px-5 pb-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">What to say</p>
        <div className="space-y-2">
          <SayLine lang="English" text={a.say.en} />
          <SayLine lang="Español" text={a.say.es} />
        </div>
      </div>

      <div className="border-t border-slate-100 bg-slate-50/60 px-5 py-3 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40">
        <p>
          {r.insurance ? `Insurance: ${r.insurance}. ` : ""}{ESTIMATE_NOTE}{r.through ? ` Payments uploaded through ${shortDay(r.through)}.` : ""}{" "}
          <Link href={insuranceTab} className="font-semibold text-brand hover:underline">See their past visits</Link>
        </p>
      </div>
    </section>
  );
}

/** Their insurance card: what the AI read off it, and a button to take a new photo of the front. */
function CardLine({ r, reading, patientKey, onSnapped }: { r: Result; reading: boolean; patientKey: string; onSnapped: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const snap = trpc.workspace.visitCost.snapCard.useMutation({
    onSuccess: (out) => { toast.success(out.status === "read" ? "Card saved and read" : out.status === "not_card" ? "Saved, but that photo doesn't look like an insurance card" : "Card saved to their folder"); onSnapped(); },
    onError: (e) => toast.error(e.message),
  });
  const c = r.card;
  const pick = async (file: File | undefined) => {
    if (!file) return;
    try { snap.mutate({ key: patientKey, dataUrl: await shrinkImage(file) }); } catch { toast.error("That photo couldn't be opened. Try again."); }
    if (input.current) input.current.value = "";
  };
  const busy = reading || snap.isPending;
  const read = c.read;
  const text = busy ? (snap.isPending ? "Saving and reading the card…" : "Reading their insurance card…")
    : read ? [`Card (${shortDay(c.photoDate)})`, read.payer, read.planName, read.groupNumber ? `group ${read.groupNumber}` : null, read.pcpCopayCents != null ? `PCP ${usd(read.pcpCopayCents)}` : "no copay printed", read.highDeductible ? "HSA / high deductible" : null].filter(Boolean).join(" · ")
    : c.state === "not_card" ? `The card photo (${shortDay(c.photoDate)}) doesn't look like an insurance card.`
    : c.state === "unread" ? `Card photo from ${shortDay(c.photoDate)}${c.canRead ? "" : " (AI reading isn't set up here)"}.`
    : "No insurance card photo on file.";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span className="flex min-w-0 items-center gap-1.5">{busy ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <CreditCard size={14} className="shrink-0" />} <span className="min-w-0">{text}</span></span>
      <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
      <button type="button" disabled={busy} onClick={() => input.current?.click()} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
        <Camera size={13} /> {c.state === "none" ? "Snap card" : "New card photo"}
      </button>
    </div>
  );
}

function SayLine({ lang, text }: { lang: string; text: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${lang} line copied`);
    } catch {
      toast.error("Couldn't copy. Select the text instead.");
    }
  };
  return (
    <div className="flex items-start gap-3 rounded-xl border border-slate-200 px-3 py-2.5 dark:border-slate-700">
      <span className="mt-0.5 w-14 shrink-0 text-[11px] font-semibold uppercase text-slate-400">{lang}</span>
      <p className="flex-1 text-sm text-slate-800 dark:text-slate-100">"{text}"</p>
      <button type="button" onClick={copy} className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800" aria-label={`Copy the ${lang} line`}><Copy size={14} /></button>
    </div>
  );
}
