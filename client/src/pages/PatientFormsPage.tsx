// The page patients open from their text / email link (no MyPCP login). Built for older patients
// who aren't comfortable online: very large text (and a bigger-text button), one small step at a
// time, big tap targets, English / Spanish / Arabic, "read it to me", answers saved as they go,
// a "Call us" button on every screen, and a family member or caregiver can sign for them.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "wouter";
import { TRPCClientError } from "@trpc/client";
import { Camera, Check, ChevronLeft, ChevronRight, ClipboardList, FileText, Loader2, Lock, Phone, Printer, Square, Volume2, XCircle } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { BrandMark } from "@/components/BrandMark";
import { cn } from "@/lib/utils";
import { T, t } from "@/components/intake/patientStrings";
import {
  AUTHORITY_LABELS, DECLINE_CONSENT, ESIGN_CONSENT, INTAKE_LANGS, LANG_LABELS, MEDICAL_INTAKE, MEDICAL_INTAKE_KEY, RELATION_LABELS, SIGNER_AUTHORITIES, SIGNER_RELATIONS,
  agreementIn, answerText, formatUsPhone, isVisible, langDir, missingInSection, needsAuthority, textBlocks, tr, type Answers, type IntakeField, type IntakeLang,
  type ListRow, type PhotoKind, type SignerAuthority, type SignerRelation,
} from "@shared/intake";

type Payload = RouterOutputs["patientForms"]["load"];
type FormItem = Payload["forms"][number];
type PublicInfo = Extract<RouterOutputs["patientForms"]["publicInfo"], { ok: true }>;
type Phase = "loading" | "blocked" | "start" | "welcome" | "home" | "form" | "done" | "copyDob" | "copy";

const SIZES = [18, 20, 23];
const errCode = (e: unknown) => (e instanceof TRPCClientError ? String(e.message) : "");
const store = {
  get(k: string) { try { return window.sessionStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { if (v === null) window.sessionStorage.removeItem(k); else window.sessionStorage.setItem(k, v); } catch { /* private mode */ } },
  getLocal(k: string) { try { return window.localStorage.getItem(k); } catch { return null; } },
  setLocal(k: string, v: string) { try { window.localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const niceName = (s: string) => (s && s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s);

export default function PatientFormsPage() {
  // /f/<token>: a private link staff sent. /sign/<slug>: an open link on the website (the person says who they are).
  const { token = "", slug = "" } = useParams<{ token?: string; slug?: string }>();
  const isPublic = !!slug && !token;
  const sessionKey = isPublic ? `mypcp-sign:${slug.slice(0, 40)}` : `mypcp-forms:${token.slice(0, 10)}`;
  const [lang, setLangState] = useState<IntakeLang>("en");
  const [size, setSize] = useState(() => Math.min(2, Math.max(0, Number(store.getLocal("mypcp-forms-size")) || 0)));
  const [phase, setPhase] = useState<Phase>("loading");
  const [blocked, setBlocked] = useState("not_found");
  const [clinic, setClinic] = useState<{ name: string | null; phone: string | null }>({ name: null, phone: null });
  const [formCount, setFormCount] = useState(1);
  const [session, setSession] = useState<string | null>(null);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<PublicInfo | null>(null);

  const open = trpc.patientForms.open.useMutation();
  const load = trpc.patientForms.load.useMutation();
  const setLanguage = trpc.patientForms.language.useMutation();
  const publicInfo = trpc.patientForms.publicInfo.useMutation();

  // Page chrome: larger base text, private (not indexed, no referrer), own title. (Always light: see App.)
  useEffect(() => {
    const root = document.documentElement;
    const prevTitle = document.title;
    document.title = "Your forms · MyPCP Dr";
    const metas = [["robots", "noindex, nofollow"], ["referrer", "no-referrer"]].map(([name, content]) => {
      const m = document.createElement("meta");
      m.name = name!; m.content = content!;
      document.head.appendChild(m);
      return m;
    });
    return () => {
      root.style.fontSize = "";
      document.title = prevTitle;
      metas.forEach((m) => m.remove());
    };
  }, []);
  useEffect(() => {
    document.documentElement.style.fontSize = `${SIZES[size]}px`;
    store.setLocal("mypcp-forms-size", String(size));
  }, [size]);

  const toBlocked = (state: string) => { setBlocked(state); setPhase("blocked"); };
  const endSession = (note: string | null) => {
    store.set(sessionKey, null);
    setSession(null);
    setPayload(null);
    setActive(null);
    setNotice(note);
    setPhase(isPublic ? "start" : "welcome");
  };
  /** Shared handling for "your session ended / these forms are done / link expired" answers. */
  const onServerError = useCallback((e: unknown): boolean => {
    const c = errCode(e);
    if (c === "session") { endSession(t(isPublic ? T.startOver : T.sessionEnded, lang)); return true; }
    if (c === "done") { setPhase("done"); return true; }
    if (isPublic && ["expired", "cancelled", "locked"].includes(c)) { endSession(t(T.startOver, lang)); return true; }
    if (["expired", "cancelled", "locked", "not_found"].includes(c)) { store.set(sessionKey, null); toBlocked(c); return true; }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, sessionKey, isPublic]);

  const startWith = (s: string, p: Payload) => {
    store.set(sessionKey, s);
    setSession(s);
    setPayload(p);
    setClinic(p.clinic);
    if (p.forms.every((f) => f.signed)) { setPhase("done"); return; }
    // One form from the website: go straight to it.
    if (isPublic && p.forms.length === 1) { setActive(p.forms[0]!.key); setPhase("form"); return; }
    setPhase("home");
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (isPublic) {
          const r = await publicInfo.mutateAsync({ slug });
          if (!alive) return;
          if (!r.ok) { toBlocked("not_found"); return; }
          setInfo(r);
          const saved = store.get(sessionKey);
          if (saved) {
            setSession(saved);
            try {
              const p = await load.mutateAsync({ session: saved });
              if (alive) startWith(saved, p);
              return;
            } catch (e) {
              // Finished already: the saved session still opens their copy.
              if (errCode(e) === "done") { if (alive) setPhase("done"); return; }
              store.set(sessionKey, null);
              setSession(null);
            }
          }
          setPhase("start");
          return;
        }
        const r = await open.mutateAsync({ token });
        if (!alive) return;
        setClinic(r.clinic);
        setFormCount(r.formCount || 1);
        setLangState((r.language as IntakeLang) || "en");
        const saved = store.get(sessionKey);
        if (r.state === "done") { if (saved) setSession(saved); setPhase("done"); return; }
        if (r.state !== "ok") { toBlocked(r.state); return; }
        if (saved) {
          try {
            const p = await load.mutateAsync({ session: saved });
            if (alive) startWith(saved, p);
            return;
          } catch { store.set(sessionKey, null); }
        }
        setPhase("welcome");
      } catch (e) {
        if (!alive) return;
        if (errCode(e) === "slow_down") setNotice(t(T.slowDown, lang));
        toBlocked("not_found");
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, slug]);

  const changeLang = (l: IntakeLang) => {
    setLangState(l);
    if (!isPublic) setLanguage.mutate({ token, language: l });
  };

  const refresh = async () => {
    if (!session) return;
    try { setPayload(await load.mutateAsync({ session })); } catch (e) { onServerError(e); }
  };

  const afterSign = (formKey: string, completed: boolean, declined = false) => {
    // The session is kept (it expires on its own) so the patient can open their copy.
    if (completed) { setPhase("done"); window.scrollTo({ top: 0 }); return; }
    setPayload((p) => (p ? { ...p, forms: p.forms.map((f) => (f.key === formKey ? { ...f, signed: true, declined } : f)) } : p));
    setActive(null);
    setNotice(null);
    setPhase("home");
    window.scrollTo({ top: 0 });
  };

  // A finished link opened later: the date of birth again, then the copy.
  const openCopy = () => { setNotice(null); setPhase(session ? "copy" : "copyDob"); window.scrollTo({ top: 0 }); };

  const dir = langDir(lang);
  const activeForm = payload?.forms.find((f) => f.key === active) ?? null;
  return (
    <div dir={dir} lang={lang} className="min-h-screen bg-slate-50 text-slate-900 print:bg-white" style={{ colorScheme: "light" }}>
      <Header lang={lang} onLang={changeLang} size={size} onSize={setSize} phone={clinic.phone} showLang={phase !== "form" && phase !== "copy"} />
      <main className="mx-auto max-w-2xl px-4 pb-32 pt-5 print:max-w-none print:p-0">
        {phase === "loading" && <Centered><Loader2 className="size-10 animate-spin text-teal-700" /><p className="mt-3 text-lg">{t(T.loading, lang)}</p></Centered>}
        {phase === "blocked" && <Blocked lang={lang} state={blocked} phone={clinic.phone} notice={notice} />}
        {phase === "done" && <Done lang={lang} phone={clinic.phone} isPublic={isPublic} notice={notice} onCopy={(session || !isPublic) && !notice ? openCopy : undefined} />}
        {phase === "copy" && session && <PatientCopy lang={lang} session={session} phone={clinic.phone} onBack={() => setPhase("done")} onServerError={onServerError} />}
        {phase === "start" && info && (
          <PublicStart lang={lang} onLang={changeLang} slug={slug} info={info} notice={notice}
            onStarted={(s, p) => { setNotice(null); startWith(s, p); }} />
        )}
        {(phase === "welcome" || phase === "copyDob") && (
          <Welcome lang={lang} onLang={changeLang} token={token} formCount={formCount} notice={notice} forCopy={phase === "copyDob"}
            onVerified={(s, p) => {
              setNotice(null);
              if (phase === "copyDob") { store.set(sessionKey, s); setSession(s); setPhase("copy"); return; }
              startWith(s, p);
            }}
            onBlocked={(st) => { if (st === "done") { setNotice(t(T.copyFailed, lang)); setPhase("done"); return; } toBlocked(st); }} />
        )}
        {phase === "home" && payload && (
          <Home lang={lang} payload={payload} notice={notice} onOpen={(k) => { setActive(k); setNotice(null); setPhase("form"); window.scrollTo({ top: 0 }); }} />
        )}
        {phase === "form" && payload && session && activeForm && (
          activeForm.kind === "questionnaire" ? (
            <Questionnaire key={activeForm.key} lang={lang} session={session} payload={payload} onExit={() => { setPhase("home"); void refresh(); }}
              onSigned={(c) => afterSign(activeForm.key, c)} onServerError={onServerError} />
          ) : (
            <Agreement key={`${activeForm.key}:${activeForm.version}`} lang={lang} session={session} form={activeForm} notice={notice}
              onExit={isPublic && payload.forms.length === 1 ? undefined : () => setPhase("home")} onSigned={(c, declined) => afterSign(activeForm.key, c, declined)} onServerError={onServerError}
              onChanged={async () => { setNotice(t(T.changedNote, lang)); await refresh(); window.scrollTo({ top: 0 }); }} />
          )
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function Header({ lang, onLang, size, onSize, phone, showLang }: { lang: IntakeLang; onLang: (l: IntakeLang) => void; size: number; onSize: (n: number) => void; phone: string | null; showLang: boolean }) {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur print:hidden">
      <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <BrandMark size={34} />
          <span className="text-lg font-bold text-teal-800">MyPCP Dr</span>
        </div>
        {phone && (
          <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="flex items-center gap-2 rounded-full bg-teal-700 px-4 py-2 text-base font-semibold text-white shadow-sm active:bg-teal-800">
            <Phone className="size-5" /> {t(T.callUs, lang)}
          </a>
        )}
      </div>
      <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-2 px-4 pb-2">
        {showLang ? (
          <div className="flex gap-1" role="group" aria-label="Language">
            {INTAKE_LANGS.map((l) => (
              <button key={l} type="button" onClick={() => onLang(l)} aria-pressed={lang === l}
                className={cn("rounded-full border px-3 py-1 text-sm font-semibold", lang === l ? "border-teal-700 bg-teal-50 text-teal-800" : "border-slate-300 bg-white text-slate-600")}>
                {LANG_LABELS[l]}
              </button>
            ))}
          </div>
        ) : <span />}
        <div className="flex items-center gap-1" role="group" aria-label={t(T.textSize, lang)}>
          <span className="me-1 text-sm text-slate-500">{t(T.textSize, lang)}</span>
          {[0, 1, 2].map((n) => (
            <button key={n} type="button" onClick={() => onSize(n)} aria-pressed={size === n} aria-label={`${t(T.textSize, lang)} ${n + 1}`}
              className={cn("grid size-9 place-items-center rounded-lg border font-bold", size === n ? "border-teal-700 bg-teal-50 text-teal-800" : "border-slate-300 bg-white text-slate-600")}
              style={{ fontSize: [13, 16, 19][n] }}>
              A
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-center py-24 text-center">{children}</div>;
}

function BigButton({ children, onClick, disabled, variant = "primary", type = "button", className }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; variant?: "primary" | "secondary" | "success"; type?: "button" | "submit"; className?: string }) {
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={cn(
        "flex min-h-14 items-center justify-center gap-2 rounded-2xl px-6 text-xl font-bold shadow-sm transition disabled:opacity-60",
        variant === "primary" && "bg-teal-700 text-white active:bg-teal-800",
        variant === "success" && "bg-emerald-600 text-white active:bg-emerald-700",
        variant === "secondary" && "border-2 border-slate-300 bg-white text-slate-800 active:bg-slate-100",
        className,
      )}>
      {children}
    </button>
  );
}

function Note({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" | "error" | "ok" }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("rounded-2xl border-2 px-4 py-3 text-lg",
      tone === "info" && "border-sky-200 bg-sky-50 text-sky-900",
      tone === "warn" && "border-amber-300 bg-amber-50 text-amber-900",
      tone === "error" && "border-red-300 bg-red-50 text-red-800",
      tone === "ok" && "border-emerald-300 bg-emerald-50 text-emerald-900")}>
      {children}
    </div>
  );
}

function CallLine({ lang, phone }: { lang: IntakeLang; phone: string | null }) {
  if (!phone) return null;
  return (
    <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="mt-6 inline-flex items-center gap-2 text-xl font-bold text-teal-800 underline">
      <Phone className="size-6" /> {t(T.callUs, lang)}: <span dir="ltr">{formatUsPhone(phone)}</span>
    </a>
  );
}

function Blocked({ lang, state, phone, notice }: { lang: IntakeLang; state: string; phone: string | null; notice: string | null }) {
  const [title, body] = T.blocked[state] ?? T.blocked.not_found!;
  return (
    <Centered>
      <div className="grid size-20 place-items-center rounded-full bg-slate-200"><Lock className="size-10 text-slate-600" /></div>
      <h1 className="mt-5 text-3xl font-bold">{t(title, lang)}</h1>
      <p className="mt-3 max-w-md text-xl text-slate-700">{notice ?? t(body, lang)}</p>
      <CallLine lang={lang} phone={phone} />
    </Centered>
  );
}

function Done({ lang, phone, isPublic, notice, onCopy }: { lang: IntakeLang; phone: string | null; isPublic: boolean; notice: string | null; onCopy?: () => void }) {
  return (
    <Centered>
      <div className="grid size-24 place-items-center rounded-full bg-emerald-100"><Check className="size-14 text-emerald-600" strokeWidth={3} /></div>
      <h1 className="mt-6 text-3xl font-bold">{t(T.doneTitle, lang)}</h1>
      <p className="mt-3 max-w-md text-xl text-slate-700">{t(isPublic ? T.publicDoneBody : T.doneBody, lang)}</p>
      {notice && <div className="mt-4 w-full max-w-md text-start"><Note tone="warn">{notice}</Note></div>}
      {onCopy && (
        <BigButton variant="secondary" onClick={onCopy} className="mt-6 w-full max-w-md">
          <FileText className="size-6" /> {t(T.seeCopy, lang)}
        </BigButton>
      )}
      <p className="mt-4 max-w-md text-lg text-slate-500">{t(T.doneClose, lang)}</p>
      <CallLine lang={lang} phone={phone} />
    </Centered>
  );
}

// ---------------------------------------------------------------------------
// Welcome + date of birth
// ---------------------------------------------------------------------------

function Welcome({ lang, onLang, token, formCount, notice, forCopy = false, onVerified, onBlocked }: {
  lang: IntakeLang; onLang: (l: IntakeLang) => void; token: string; formCount: number; notice: string | null; forCopy?: boolean;
  onVerified: (session: string, p: Payload) => void; onBlocked: (s: string) => void;
}) {
  const verify = trpc.patientForms.verify.useMutation();
  const [m, setM] = useState("");
  const [d, setD] = useState("");
  const [y, setY] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const dRef = useRef<HTMLInputElement>(null);
  const yRef = useRef<HTMLInputElement>(null);
  const minutes = Math.min(20, Math.max(5, formCount * 5));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const mm = Number(m), dd = Number(d), yy = Number(y);
    if (!mm || !dd || y.length !== 4 || mm > 12 || dd > 31 || yy < 1900) { setErr(t(T.dobInvalid, lang)); return; }
    setErr(null);
    try {
      const r = await verify.mutateAsync({ token, month: m, day: d, year: y });
      if (r.ok) { onVerified(r.session, r.packet); return; }
      if (r.state !== "ok") { onBlocked(r.state); return; }
      setErr(t(T.dobWrong, lang, { n: r.triesLeft }));
    } catch (e2) {
      setErr(errCode(e2) === "slow_down" ? t(T.slowDown, lang) : t(T.tryAgain, lang));
    }
  };
  const box = "h-16 w-full min-w-0 rounded-2xl border-2 border-slate-300 bg-white px-1 text-center text-2xl font-bold focus:border-teal-600 focus:outline-none focus:ring-4 focus:ring-teal-100";
  return (
    <div className="space-y-6">
      {!forCopy && (
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-3xl font-bold">{t(T.yourForms, lang)}</h1>
          <p className="mt-2 text-xl text-slate-700">{t(T.intro, lang, { m: minutes })}</p>
          <p className="mt-4 text-lg font-semibold text-slate-600">{t(T.chooseLanguage, lang)}</p>
          <LangButtons lang={lang} onLang={onLang} />
        </section>
      )}

      <form onSubmit={submit} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        {notice && <div className="mb-4"><Note tone="warn">{notice}</Note></div>}
        <h2 className="text-2xl font-bold">{t(forCopy ? T.copyDobTitle : T.dobTitle, lang)}</h2>
        <p className="mt-1 text-lg text-slate-600">{t(T.dobWhy, lang)}</p>
        <DobBoxes m={m} d={d} y={y} setM={setM} setD={setD} setY={setY} lang={lang} dRef={dRef} yRef={yRef} box={box} />
        <p className="mt-3 text-base text-slate-500">{t(T.dobHelper, lang)}</p>
        {err && <div className="mt-4"><Note tone="error">{err}</Note></div>}
        <BigButton type="submit" disabled={verify.isPending} className="mt-6 w-full">
          {verify.isPending ? <Loader2 className="size-6 animate-spin" /> : null} {t(T.continue, lang)}
        </BigButton>
      </form>

      {!forCopy && (
        <ul className="space-y-2 px-1 text-lg text-slate-600">
          <li className="flex gap-2"><Check className="mt-1 size-5 shrink-0 text-teal-700" /> {t(T.saveNote, lang)}</li>
          <li className="flex gap-2"><Check className="mt-1 size-5 shrink-0 text-teal-700" /> {t(T.helpNote, lang)}</li>
          <li className="flex gap-2"><Lock className="mt-1 size-5 shrink-0 text-teal-700" /> {t(T.privacy, lang)}</li>
        </ul>
      )}
    </div>
  );
}

function LangButtons({ lang, onLang }: { lang: IntakeLang; onLang: (l: IntakeLang) => void }) {
  return (
    <div className="mt-2 grid grid-cols-3 gap-2">
      {INTAKE_LANGS.map((l) => (
        <button key={l} type="button" onClick={() => onLang(l)} aria-pressed={lang === l}
          className={cn("min-h-14 rounded-2xl border-2 text-lg font-bold", lang === l ? "border-teal-700 bg-teal-700 text-white" : "border-slate-300 bg-white text-slate-800")}>
          {LANG_LABELS[l]}
        </button>
      ))}
    </div>
  );
}

/** Always month / day / year, left to right, like the date on their ID. */
function DobBoxes({ m, d, y, setM, setD, setY, lang, dRef, yRef, box }: {
  m: string; d: string; y: string; setM: (v: string) => void; setD: (v: string) => void; setY: (v: string) => void; lang: IntakeLang;
  dRef: React.RefObject<HTMLInputElement | null>; yRef: React.RefObject<HTMLInputElement | null>; box: string;
}) {
  return (
    <div dir="ltr" className="mt-5 grid grid-cols-[1fr_1fr_1.5fr] gap-3">
      <label className="block">
        <span className="mb-1 block text-center text-lg font-semibold text-slate-700">{t(T.month, lang)}</span>
        <input className={box} inputMode="numeric" autoComplete="bday-month" placeholder="MM" maxLength={2} value={m}
          onChange={(e) => { const v = e.target.value.replace(/\D/g, "").slice(0, 2); setM(v); if (v.length === 2) dRef.current?.focus(); }} />
      </label>
      <label className="block">
        <span className="mb-1 block text-center text-lg font-semibold text-slate-700">{t(T.day, lang)}</span>
        <input ref={dRef} className={box} inputMode="numeric" autoComplete="bday-day" placeholder="DD" maxLength={2} value={d}
          onChange={(e) => { const v = e.target.value.replace(/\D/g, "").slice(0, 2); setD(v); if (v.length === 2) yRef.current?.focus(); }} />
      </label>
      <label className="block">
        <span className="mb-1 block text-center text-lg font-semibold text-slate-700">{t(T.year, lang)}</span>
        <input ref={yRef} className={box} inputMode="numeric" autoComplete="bday-year" placeholder="YYYY" maxLength={4} value={y}
          onChange={(e) => setY(e.target.value.replace(/\D/g, "").slice(0, 4))} />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Open website link: who is the patient? (then straight to the form)
// ---------------------------------------------------------------------------

function PublicStart({ lang, onLang, slug, info, notice, onStarted }: {
  lang: IntakeLang; onLang: (l: IntakeLang) => void; slug: string; info: PublicInfo; notice: string | null; onStarted: (session: string, p: Payload) => void;
}) {
  const start = trpc.patientForms.publicStart.useMutation();
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [m, setM] = useState("");
  const [d, setD] = useState("");
  const [y, setY] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [office, setOffice] = useState<string>("");
  const [hp, setHp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const dRef = useRef<HTMLInputElement>(null);
  const yRef = useRef<HTMLInputElement>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const mm = Number(m), dd = Number(d), yy = Number(y);
    if (!first.trim() || !last.trim()) return setErr(t(T.needFirstLast, lang));
    if (!mm || !dd || y.length !== 4 || mm > 12 || dd > 31 || yy < 1900) return setErr(t(T.dobInvalid, lang));
    if (phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "").length !== 10) return setErr(t(T.invalidPhone, lang));
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) return setErr(t(T.invalidEmail, lang));
    setErr(null);
    try {
      const r = await start.mutateAsync({
        slug, firstName: first, lastName: last, month: m, day: d, year: y, phone, email: email.trim() || null, language: lang,
        clinicId: office ? Number(office) : null, website: hp || undefined,
      });
      onStarted(r.session, r.packet);
    } catch (e2) {
      const c = errCode(e2);
      setErr(c === "slow_down" ? t(T.slowDown, lang) : c === "dob" ? t(T.dobInvalid, lang) : c === "phone" ? t(T.invalidPhone, lang) : c === "email" ? t(T.invalidEmail, lang) : c === "name" ? t(T.needFirstLast, lang) : t(T.tryAgain, lang));
    }
  };
  const box = "h-16 w-full min-w-0 rounded-2xl border-2 border-slate-300 bg-white px-1 text-center text-2xl font-bold focus:border-teal-600 focus:outline-none focus:ring-4 focus:ring-teal-100";
  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-bold leading-tight">{tr(info.title, lang)}</h1>
        <p className="mt-2 text-xl text-slate-700">{t(T.publicIntro, lang)}</p>
        <p className="mt-4 text-lg font-semibold text-slate-600">{t(T.chooseLanguage, lang)}</p>
        <LangButtons lang={lang} onLang={onLang} />
      </section>
      <form onSubmit={submit} className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm" noValidate>
        {notice && <Note tone="warn">{notice}</Note>}
        <div>
          <h2 className="text-2xl font-bold">{t(T.aboutPatient, lang)}</h2>
          <p className="mt-1 text-lg text-slate-600">{t(T.aboutPatientHelp, lang)}</p>
        </div>
        <label className="block">
          <span className="mb-2 block text-xl font-semibold">{t(T.firstName, lang)}</span>
          <input className={inputCls} value={first} onChange={(e) => setFirst(e.target.value)} autoComplete="given-name" maxLength={100} />
        </label>
        <label className="block">
          <span className="mb-2 block text-xl font-semibold">{t(T.lastName, lang)}</span>
          <input className={inputCls} value={last} onChange={(e) => setLast(e.target.value)} autoComplete="family-name" maxLength={100} />
        </label>
        <div>
          <span className="block text-xl font-semibold">{t(T.dobLabel, lang)}</span>
          <DobBoxes m={m} d={d} y={y} setM={setM} setD={setD} setY={setY} lang={lang} dRef={dRef} yRef={yRef} box={box} />
        </div>
        <label className="block">
          <span className="mb-2 block text-xl font-semibold">{t(T.phoneLabel, lang)}</span>
          <input className={inputCls} dir="ltr" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} />
        </label>
        <label className="block">
          <span className="mb-2 block text-xl font-semibold">{t(T.emailLabel, lang)}</span>
          <input className={inputCls} dir="ltr" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} />
        </label>
        {info.offices.length > 1 && (
          <label className="block">
            <span className="mb-2 block text-xl font-semibold">{t(T.officeLabel, lang)}</span>
            <select className={inputCls} value={office} onChange={(e) => setOffice(e.target.value)}>
              <option value="">{t(T.officeNotSure, lang)}</option>
              {info.offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        )}
        {/* Left empty by people (hidden); automated spam fills it in. */}
        <input type="text" name="website" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)}
          className="absolute -left-[9999px] h-px w-px opacity-0" aria-hidden="true" />
        {err && <Note tone="error">{err}</Note>}
        <BigButton type="submit" disabled={start.isPending} className="w-full">
          {start.isPending ? <Loader2 className="size-6 animate-spin" /> : null} {t(T.continue, lang)}
        </BigButton>
      </form>
      <p className="flex gap-2 px-1 text-lg text-slate-600"><Lock className="mt-1 size-5 shrink-0 text-teal-700" /> {t(T.privacy, lang)}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list of forms
// ---------------------------------------------------------------------------

function formTitle(f: FormItem, lang: IntakeLang) {
  return f.kind === "questionnaire" ? tr(MEDICAL_INTAKE.title, lang) : agreementIn(f.doc!, lang).title;
}

function Home({ lang, payload, notice, onOpen }: { lang: IntakeLang; payload: Payload; notice: string | null; onOpen: (key: string) => void }) {
  const first = niceName(payload.firstName);
  const nextKey = payload.forms.find((f) => !f.signed)?.key;
  const started = Object.keys(payload.answers ?? {}).length > 0;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl font-bold">{first ? t(T.hello, lang, { name: first }) : t(T.helloNoName, lang)}</h1>
        <p className="mt-2 text-xl text-slate-700">{t(T.homeBody, lang)}</p>
      </div>
      {notice && <Note tone="warn">{notice}</Note>}
      <ol className="space-y-3">
        {payload.forms.map((f, i) => {
          const Icon = f.kind === "questionnaire" ? ClipboardList : FileText;
          const isNext = f.key === nextKey;
          return (
            <li key={f.key} className={cn("rounded-3xl border-2 bg-white p-5 shadow-sm", f.signed ? "border-emerald-200" : isNext ? "border-teal-600" : "border-slate-200")}>
              <div className="flex items-start gap-4">
                <div className={cn("grid size-14 shrink-0 place-items-center rounded-2xl", f.signed ? "bg-emerald-100 text-emerald-700" : "bg-teal-50 text-teal-700")}>
                  {f.signed ? <Check className="size-8" strokeWidth={3} /> : <Icon className="size-7" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-semibold text-slate-500">{i + 1} / {payload.forms.length}</p>
                  <h2 className="text-2xl font-bold leading-tight">{formTitle(f, lang)}</h2>
                  <p className="mt-1 text-lg text-slate-600">
                    {f.signed ? <span className="font-semibold text-emerald-700">{f.declined ? t(T.youSaidNo, lang) : `${t(T.formDone, lang)} ✓`}</span>
                      : f.kind === "questionnaire" ? t(T.aboutMinutes, lang, { m: MEDICAL_INTAKE.minutes }) : t(T.readSign, lang)}
                  </p>
                </div>
              </div>
              {!f.signed && (
                <BigButton onClick={() => onOpen(f.key)} variant={isNext ? "primary" : "secondary"} className="mt-4 w-full">
                  {f.kind === "questionnaire" && started ? t(T.keepGoing, lang) : t(T.begin, lang)}
                  <ChevronRight className="size-6 rtl:rotate-180" />
                </BigButton>
              )}
            </li>
          );
        })}
      </ol>
      <p className="flex gap-2 px-1 text-lg text-slate-600"><Check className="mt-1 size-5 shrink-0 text-teal-700" /> {t(T.saveNote, lang)}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health history (step by step), then review + sign
// ---------------------------------------------------------------------------

function withPrefill(a: Answers, prefill: Payload["prefill"]): Answers {
  const out = { ...a };
  if (!out.fullName && prefill.name) out.fullName = prefill.name.includes(",") ? prefill.name.split(",").reverse().map((x) => niceName(x.trim())).join(" ") : prefill.name;
  if (!out.phone && prefill.phone) out.phone = formatUsPhone(prefill.phone);
  if (!out.email && prefill.email) out.email = prefill.email;
  return out;
}

function Questionnaire({ lang, session, payload, onExit, onSigned, onServerError }: {
  lang: IntakeLang; session: string; payload: Payload; onExit: () => void; onSigned: (completed: boolean) => void; onServerError: (e: unknown) => boolean;
}) {
  const q = MEDICAL_INTAKE;
  const [answers, setAnswers] = useState<Answers>(() => withPrefill(payload.answers as Answers, payload.prefill));
  const [photos, setPhotos] = useState<Set<PhotoKind>>(() => new Set(payload.photos as PhotoKind[]));
  const [step, setStep] = useState(() => {
    if (!Object.keys(payload.answers ?? {}).length) return 0;
    const i = q.sections.findIndex((s) => missingInSection(s, payload.answers as Answers).length);
    return i === -1 ? q.sections.length : i;
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const save = trpc.patientForms.save.useMutation();
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (!dirty.current) return true;
    dirty.current = false;
    setSaveState("saving");
    try {
      await save.mutateAsync({ session, answers: answersRef.current });
      setSaveState("saved");
      return true;
    } catch (e) {
      dirty.current = true;
      setSaveState("idle");
      if (!onServerError(e)) setNotice(t(T.tryAgain, lang));
      return false;
    }
  }, [lang, onServerError, save, session]);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  const update = (id: string, v: Answers[string]) => {
    setAnswers((a) => {
      const next = { ...a, [id]: v };
      // "I'll list them" / "Yes, I have allergies" start with one empty row to fill in.
      for (const f of q.sections.flatMap((s) => s.fields)) {
        if (f.type === "list" && isVisible(f, next) && !(next[f.id] as ListRow[] | undefined)?.length) next[f.id] = [Object.fromEntries(f.columns!.map((c) => [c.id, ""]))];
      }
      return next;
    });
    setErrors((e) => e.filter((x) => x !== id));
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flush(); }, 1500);
  };

  const total = q.sections.length + 1;
  const goto = (n: number) => { setStep(n); setErrors([]); window.scrollTo({ top: 0 }); };
  const next = async () => {
    const section = q.sections[step]!;
    const missing = missingInSection(section, answers);
    if (missing.length) {
      setErrors(missing);
      setNotice(t(T.fixBelow, lang));
      window.setTimeout(() => document.getElementById(`q-${missing[0]}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
      return;
    }
    setNotice(null);
    void flush();
    goto(step + 1);
  };
  const back = () => { void flush(); setNotice(null); if (step === 0) onExit(); else goto(step - 1); };

  const section = step < q.sections.length ? q.sections[step]! : null;
  return (
    <div>
      <div className="mb-5">
        <button type="button" onClick={() => { void flush(); onExit(); }} className="mb-2 flex items-center gap-1 text-lg font-semibold text-teal-800">
          <ChevronLeft className="size-5 rtl:rotate-180" /> {t(T.allForms, lang)}
        </button>
        <p className="text-lg font-semibold text-slate-500">{tr(q.title, lang)}</p>
        <div className="mt-1 flex items-center justify-between gap-3">
          <h1 className="text-3xl font-bold">{section ? tr(section.title, lang) : t(T.reviewTitle, lang)}</h1>
          <span className="shrink-0 text-base text-slate-500" aria-live="polite">
            {saveState === "saving" ? t(T.saving, lang) : saveState === "saved" ? `✓ ${t(T.saved, lang)}` : ""}
          </span>
        </div>
        <p className="mt-1 text-lg text-slate-600">{t(T.step, lang, { i: step + 1, n: total })}</p>
        <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
          <div className="h-full rounded-full bg-teal-600 transition-all" style={{ width: `${((step + 1) / total) * 100}%` }} />
        </div>
      </div>

      {notice && <div className="mb-4"><Note tone={errors.length ? "error" : "warn"}>{notice}</Note></div>}

      {section ? (
        <div className="space-y-6">
          {section.intro && <Note>{tr(section.intro, lang)}</Note>}
          {section.fields.filter((f) => isVisible(f, answers)).map((f) => (
            <Field key={f.id} f={f} lang={lang} value={answers[f.id]} error={errors.includes(f.id) ? fieldError(f, answers[f.id], lang) : null}
              onChange={(v) => update(f.id, v)} session={session} hasPhoto={f.photo ? photos.has(f.photo) : false}
              onPhoto={(kind, ok) => setPhotos((s) => { const n = new Set(s); if (ok) n.add(kind); else n.delete(kind); return n; })} onServerError={onServerError} />
          ))}
          <div className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-200 bg-white/95 p-3 backdrop-blur">
            <div className="mx-auto flex max-w-2xl gap-3">
              <BigButton variant="secondary" onClick={back} className="flex-1"><ChevronLeft className="size-6 rtl:rotate-180" /> {t(T.back, lang)}</BigButton>
              <BigButton onClick={next} className="flex-[2]">{t(T.next, lang)} <ChevronRight className="size-6 rtl:rotate-180" /></BigButton>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <p className="text-xl text-slate-700">{t(T.reviewBody, lang)}</p>
          {q.sections.map((s, i) => {
            const shown = s.fields.filter((f) => isVisible(f, answers));
            return (
              <section key={s.id} className="rounded-3xl border border-slate-200 bg-white p-5">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-xl font-bold">{tr(s.title, lang)}</h2>
                  <button type="button" onClick={() => goto(i)} className="rounded-xl border-2 border-slate-300 px-4 py-2 text-lg font-semibold text-teal-800">{t(T.change, lang)}</button>
                </div>
                <dl className="mt-3 space-y-2">
                  {shown.map((f) => {
                    const v = f.type === "photo" ? (f.photo && photos.has(f.photo) ? t(T.photoOnFile, lang) : "") : answerText(f, answers[f.id], lang);
                    return (
                      <div key={f.id}>
                        <dt className="text-base text-slate-500">{tr(f.label, lang)}</dt>
                        <dd className="whitespace-pre-line text-lg font-semibold">{v || <span className="font-normal text-slate-400">{t(T.noAnswer, lang)}</span>}</dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            );
          })}
          <section className="rounded-3xl border-2 border-teal-600 bg-white p-5 shadow-sm">
            <h2 className="text-2xl font-bold">{t(T.signTitle, lang)}</h2>
            <p className="mt-3 rounded-2xl bg-slate-50 p-4 text-lg">{tr(q.attestation, lang)}</p>
            <SignBlock lang={lang} session={session} formKey={MEDICAL_INTAKE_KEY} version={q.version} language={lang} consentLabel={tr(ESIGN_CONSENT, lang)}
              beforeSign={flush} onSigned={onSigned}
              onError={(e) => {
                if (onServerError(e)) return true;
                if (errCode(e) === "incomplete") {
                  const i = q.sections.findIndex((s) => missingInSection(s, answers).length);
                  if (i >= 0) { goto(i); setErrors(missingInSection(q.sections[i]!, answers)); }
                  setNotice(t(T.incompleteNote, lang));
                  return true;
                }
                return false;
              }} />
          </section>
          <BigButton variant="secondary" onClick={back} className="w-full"><ChevronLeft className="size-6 rtl:rotate-180" /> {t(T.back, lang)}</BigButton>
        </div>
      )}
    </div>
  );
}

function fieldError(f: IntakeField, v: Answers[string] | undefined, lang: IntakeLang) {
  const blank = v == null || (Array.isArray(v) ? !v.length : !String(v).trim());
  if (f.type === "list") return t(T.needRow, lang);
  if (blank) return t(T.required, lang);
  if (f.type === "phone") return t(T.invalidPhone, lang);
  if (f.type === "email") return t(T.invalidEmail, lang);
  if (f.type === "zip") return t(T.invalidZip, lang);
  return t(T.required, lang);
}

const inputCls = "block h-14 w-full rounded-2xl border-2 border-slate-300 bg-white px-4 text-xl focus:border-teal-600 focus:outline-none focus:ring-4 focus:ring-teal-100";

function Field({ f, lang, value, error, onChange, session, hasPhoto, onPhoto, onServerError }: {
  f: IntakeField; lang: IntakeLang; value: Answers[string] | undefined; error: string | null; onChange: (v: Answers[string]) => void;
  session: string; hasPhoto: boolean; onPhoto: (kind: PhotoKind, ok: boolean) => void; onServerError: (e: unknown) => boolean;
}) {
  const label = tr(f.label, lang);
  const id = `q-${f.id}`;
  const errCls = error ? "border-red-400 bg-red-50/40" : "";
  const autoComplete: Record<string, string> = { fullName: "name", phone: "tel", email: "email", street: "address-line1", city: "address-level2", zip: "postal-code" };
  let control: React.ReactNode;
  if (f.type === "choice") {
    control = (
      <div role="radiogroup" aria-labelledby={`${id}-l`} className="space-y-2">
        {f.options!.map((o) => {
          const on = value === o.value;
          return (
            <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
              className={cn("flex min-h-14 w-full items-center gap-3 rounded-2xl border-2 px-4 py-3 text-start text-xl", on ? "border-teal-700 bg-teal-50 font-bold text-teal-900" : cn("border-slate-300 bg-white", errCls))}>
              <span className={cn("grid size-7 shrink-0 place-items-center rounded-full border-2", on ? "border-teal-700 bg-teal-700 text-white" : "border-slate-400")}>{on && <Check className="size-4" strokeWidth={4} />}</span>
              {tr(o.label, lang)}
            </button>
          );
        })}
      </div>
    );
  } else if (f.type === "multi") {
    const cur = (Array.isArray(value) ? value : []) as string[];
    const toggle = (v: string) => {
      if (cur.includes(v)) return onChange(cur.filter((x) => x !== v));
      if (f.exclusive?.includes(v)) return onChange([v]);
      onChange([...cur.filter((x) => !f.exclusive?.includes(x)), v]);
    };
    control = (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-labelledby={`${id}-l`}>
        {f.options!.map((o) => {
          const on = cur.includes(o.value);
          return (
            <button key={o.value} type="button" role="checkbox" aria-checked={on} onClick={() => toggle(o.value)}
              className={cn("flex min-h-14 items-center gap-3 rounded-2xl border-2 px-4 py-3 text-start text-xl", on ? "border-teal-700 bg-teal-50 font-bold text-teal-900" : "border-slate-300 bg-white")}>
              <span className={cn("grid size-7 shrink-0 place-items-center rounded-md border-2", on ? "border-teal-700 bg-teal-700 text-white" : "border-slate-400")}>{on && <Check className="size-4" strokeWidth={4} />}</span>
              {tr(o.label, lang)}
            </button>
          );
        })}
      </div>
    );
  } else if (f.type === "list") {
    const rows = (Array.isArray(value) ? value : []) as ListRow[];
    const setRow = (i: number, col: string, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [col]: v } : r)));
    control = (
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="space-y-2 rounded-2xl border-2 border-slate-200 bg-white p-3">
            {f.columns!.map((c) => (
              <label key={c.id} className="block">
                <span className="mb-1 block text-base font-semibold text-slate-600">{tr(c.label, lang)}</span>
                <input className={cn(inputCls, c.required && error && !(r[c.id] ?? "").trim() && errCls)} value={r[c.id] ?? ""} onChange={(e) => setRow(i, c.id, e.target.value)} maxLength={200} />
              </label>
            ))}
            {rows.length > 1 && (
              <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} className="text-lg font-semibold text-red-700 underline">{t(T.removeRow, lang)}</button>
            )}
          </div>
        ))}
        {rows.length < 40 && (
          <BigButton variant="secondary" className="w-full" onClick={() => onChange([...rows, Object.fromEntries(f.columns!.map((c) => [c.id, ""]))])}>{t(T.addRow, lang)}</BigButton>
        )}
      </div>
    );
  } else if (f.type === "photo") {
    control = <PhotoInput kind={f.photo!} lang={lang} session={session} has={hasPhoto} onDone={(ok) => onPhoto(f.photo!, ok)} onServerError={onServerError} />;
  } else if (f.type === "textarea") {
    control = <textarea id={id} className={cn(inputCls, "h-auto min-h-28 py-3", errCls)} rows={3} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} maxLength={2000} />;
  } else {
    control = (
      <input id={id} className={cn(inputCls, errCls)} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}
        dir={f.type === "phone" || f.type === "email" || f.type === "zip" ? "ltr" : undefined}
        inputMode={f.type === "phone" ? "tel" : f.type === "email" ? "email" : f.type === "zip" ? "numeric" : undefined}
        type={f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text"} autoComplete={autoComplete[f.id] ?? "off"} maxLength={f.type === "zip" ? 10 : 200} />
    );
  }
  return (
    <div id={f.type === "text" || f.type === "phone" || f.type === "email" || f.type === "zip" || f.type === "textarea" ? undefined : id} className="scroll-mt-40">
      <label htmlFor={["choice", "multi", "list", "photo"].includes(f.type) ? undefined : id} id={`${id}-l`} className="mb-2 block text-xl font-semibold">{label}</label>
      {f.hint && <p className="-mt-1 mb-2 text-lg text-slate-500">{tr(f.hint, lang)}</p>}
      {control}
      {error && <p className="mt-2 text-lg font-semibold text-red-700">{error}</p>}
    </div>
  );
}

/** Shrink a phone photo to ≤1600px JPEG before sending (a few hundred KB instead of several MB). */
async function shrinkImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function PhotoInput({ kind, lang, session, has, onDone, onServerError }: { kind: PhotoKind; lang: IntakeLang; session: string; has: boolean; onDone: (ok: boolean) => void; onServerError: (e: unknown) => boolean }) {
  const photo = trpc.patientForms.photo.useMutation();
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    try {
      const dataUrl = await shrinkImage(file);
      setPreview(dataUrl);
      await photo.mutateAsync({ session, kind, dataUrl });
      onDone(true);
    } catch (e) {
      setPreview(null);
      if (!onServerError(e)) setErr(t(T.photoFailed, lang));
    } finally {
      if (input.current) input.current.value = "";
    }
  };
  const remove = async () => {
    try { await photo.mutateAsync({ session, kind, dataUrl: null }); setPreview(null); onDone(false); } catch (e) { if (!onServerError(e)) setErr(t(T.photoFailed, lang)); }
  };
  return (
    <div className="space-y-2">
      <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
      {(preview || has) && (
        <div className="flex items-center gap-3 rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-3">
          {preview ? <img src={preview} alt="" className="h-20 w-32 rounded-lg object-cover" /> : <Camera className="size-8 text-emerald-700" />}
          <span className="flex-1 text-lg font-semibold text-emerald-800">{photo.isPending ? t(T.photoSaving, lang) : `✓ ${t(T.photoSaved, lang)}`}</span>
          {!photo.isPending && <button type="button" onClick={() => void remove()} className="text-lg font-semibold text-red-700 underline">{t(T.removePhoto, lang)}</button>}
        </div>
      )}
      <BigButton variant="secondary" className="w-full" disabled={photo.isPending} onClick={() => input.current?.click()}>
        {photo.isPending ? <Loader2 className="size-6 animate-spin" /> : <Camera className="size-6" />} {preview || has ? t(T.retakePhoto, lang) : t(T.takePhoto, lang)}
      </BigButton>
      {err && <p className="text-lg font-semibold text-red-700">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agreements (practice wording), with "read it to me"
// ---------------------------------------------------------------------------

function Agreement({ lang, session, form, notice, onExit, onSigned, onServerError, onChanged }: {
  lang: IntakeLang; session: string; form: FormItem; notice: string | null; onExit?: () => void; onSigned: (completed: boolean, declined: boolean) => void;
  onServerError: (e: unknown) => boolean; onChanged: () => void;
}) {
  const text = agreementIn(form.doc!, lang);
  const blocks = useMemo(() => textBlocks(text.body), [text.body]);
  const [declining, setDeclining] = useState(false);
  const onError = (e: unknown) => { if (onServerError(e)) return true; if (errCode(e) === "changed") { onChanged(); return true; } return false; };
  return (
    <div className="space-y-5">
      {onExit && (
        <button type="button" onClick={onExit} className="flex items-center gap-1 text-lg font-semibold text-teal-800">
          <ChevronLeft className="size-5 rtl:rotate-180" /> {t(T.allForms, lang)}
        </button>
      )}
      {notice && <Note tone="warn">{notice}</Note>}
      {text.lang !== lang && <Note tone="warn">{t(T.englishOnly, lang)}</Note>}
      <article dir={langDir(text.lang)} lang={text.lang} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <h1 className="text-3xl font-bold leading-tight">{text.title}</h1>
        <div className="mt-3"><ReadAloud lang={lang} speakLang={text.lang} text={`${text.title}. ${text.body.replace(/^#{1,3}\s+/gm, "")}`} /></div>
        <div className="mt-4 space-y-4 text-xl leading-relaxed">
          {blocks.map((b, i) => b.kind === "heading" ? <h2 key={i} className="pt-2 text-2xl font-bold">{b.text}</h2>
            : b.kind === "bullets" ? <ul key={i} className="list-disc space-y-1 ps-7">{b.items!.map((x, j) => <li key={j}>{x}</li>)}</ul>
            : <p key={i} className="whitespace-pre-line">{b.text}</p>)}
        </div>
      </article>
      {declining ? (
        <section className="rounded-3xl border-2 border-slate-400 bg-white p-5 shadow-sm">
          <h2 className="flex items-center gap-2 text-2xl font-bold"><XCircle className="size-7 text-slate-600" /> {t(T.declineTitle, lang)}</h2>
          <p className="mt-2 text-xl text-slate-700">{t(T.declineBody, lang)}</p>
          <SignBlock lang={lang} session={session} formKey={form.key} version={form.version} language={text.lang} decision="declined"
            consentLabel={tr(DECLINE_CONSENT, text.lang)} onSigned={(c) => onSigned(c, true)} onError={onError} />
          <BigButton variant="secondary" onClick={() => setDeclining(false)} className="mt-3 w-full">{t(T.changeMind, lang)}</BigButton>
        </section>
      ) : (
        <>
          <section className="rounded-3xl border-2 border-teal-600 bg-white p-5 shadow-sm">
            <h2 className="text-2xl font-bold">{t(T.signTitle, lang)}</h2>
            <SignBlock lang={lang} session={session} formKey={form.key} version={form.version} language={text.lang}
              consentLabel={`${t(T.agreeRead, text.lang)} ${tr(ESIGN_CONSENT, text.lang)}`} onSigned={(c) => onSigned(c, false)} onError={onError} />
          </section>
          {form.canDecline && (
            <section className="rounded-3xl border border-slate-200 bg-white p-5">
              <p className="text-lg text-slate-600">{t(T.declineAsk, lang)}</p>
              <BigButton variant="secondary" onClick={() => { setDeclining(true); window.setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }), 50); }} className="mt-3 w-full">
                {t(T.declineButton, lang)}
              </BigButton>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ReadAloud({ lang, speakLang, text }: { lang: IntakeLang; speakLang: IntakeLang; text: string }) {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [on, setOn] = useState(false);
  useEffect(() => () => { if (supported) window.speechSynthesis.cancel(); }, [supported]);
  if (!supported) return null;
  const toggle = () => {
    const synth = window.speechSynthesis;
    if (on) { synth.cancel(); setOn(false); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = { en: "en-US", es: "es-US", ar: "ar-SA" }[speakLang];
    const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith(speakLang));
    if (voice) u.voice = voice;
    u.rate = 0.9;
    u.onend = () => setOn(false);
    u.onerror = () => setOn(false);
    synth.speak(u);
    setOn(true);
  };
  return (
    <button type="button" onClick={toggle} className={cn("inline-flex min-h-12 items-center gap-2 rounded-2xl border-2 px-4 text-lg font-bold", on ? "border-amber-400 bg-amber-50 text-amber-900" : "border-teal-600 bg-teal-50 text-teal-800")}>
      {on ? <Square className="size-5" /> : <Volume2 className="size-6" />} {on ? t(T.stopReading, lang) : t(T.readAloud, lang)}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Signing: typed name (easiest) or drawn; the patient or someone signing for them
// ---------------------------------------------------------------------------

function SignBlock({ lang, session, formKey, version, language, consentLabel, decision = "signed", beforeSign, onSigned, onError }: {
  lang: IntakeLang; session: string; formKey: string; version: number; language: string; consentLabel: string; decision?: "signed" | "declined";
  beforeSign?: () => Promise<boolean>; onSigned: (completed: boolean) => void; onError: (e: unknown) => boolean;
}) {
  const sign = trpc.patientForms.sign.useMutation();
  const declining = decision === "declined";
  const [who, setWho] = useState<"self" | "helper">("self");
  const [relation, setRelation] = useState<SignerRelation | "">("");
  const [authority, setAuthority] = useState<SignerAuthority | "none" | "">("");
  const [authorityNote, setAuthorityNote] = useState("");
  const [name, setName] = useState("");
  const [method, setMethod] = useState<"typed" | "drawn">("typed");
  const [drawn, setDrawn] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Agreements (not the health history) need a helper's legal authority.
  const askAuthority = who === "helper" && needsAuthority(formKey, relation || "other");
  const noAuthority = askAuthority && authority === "none";
  // A fresh try clears the last "please…" message.
  useEffect(() => setErr(null), [who, relation, authority, authorityNote, name, method, drawn, consent]);

  const submit = async () => {
    setErr(null);
    if (who === "helper" && !relation) return setErr(t(T.needRelation, lang));
    if (askAuthority && !authority) return setErr(t(T.needAuthority, lang));
    if (noAuthority) return setErr(t(T.authorityNoneNote, lang));
    if (askAuthority && authority === "other" && authorityNote.trim().length < 3) return setErr(t(T.needAuthorityNote, lang));
    if (name.trim().length < 2) return setErr(t(T.needName, lang));
    if (method === "drawn" && !drawn) return setErr(t(T.needDrawing, lang));
    if (!consent) return setErr(t(T.needConsent, lang));
    if (beforeSign && !(await beforeSign())) return;
    try {
      const r = await sign.mutateAsync({
        session, formKey, version, language, signerName: name.trim(), relation: who === "self" ? "self" : (relation as SignerRelation), method: declining ? "typed" : method,
        drawn: !declining && method === "drawn" ? drawn : null, esignConsent: true, decision,
        authority: askAuthority && authority && authority !== "none" ? authority : null, authorityNote: askAuthority && authority === "other" ? authorityNote.trim() : null,
      });
      onSigned(!!r.completed);
    } catch (e) {
      const c = errCode(e);
      if (c === "authority") return setErr(t(T.needAuthority, lang));
      if (c === "authority_note") return setErr(t(T.needAuthorityNote, lang));
      if (!onError(e)) setErr(t(T.tryAgain, lang));
    }
  };

  const pill = (on: boolean) => cn("min-h-14 flex-1 rounded-2xl border-2 px-3 py-2 text-lg font-bold", on ? "border-teal-700 bg-teal-700 text-white" : "border-slate-300 bg-white text-slate-800");
  const radio = (on: boolean) => cn("flex min-h-14 w-full items-center gap-3 rounded-2xl border-2 px-4 py-3 text-start text-lg", on ? "border-teal-700 bg-teal-50 font-bold text-teal-900" : "border-slate-300 bg-white");
  return (
    <div className="mt-4 space-y-5">
      <div>
        <p className="mb-2 text-xl font-semibold">{t(T.whoSigning, lang)}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button type="button" className={pill(who === "self")} aria-pressed={who === "self"} onClick={() => setWho("self")}>{t(T.signMe, lang)}</button>
          <button type="button" className={pill(who === "helper")} aria-pressed={who === "helper"} onClick={() => setWho("helper")}>{t(T.signHelper, lang)}</button>
        </div>
      </div>
      {who === "helper" && (
        <label className="block">
          <span className="mb-2 block text-xl font-semibold">{t(T.helperRelation, lang)}</span>
          <select className={inputCls} value={relation} onChange={(e) => setRelation(e.target.value as SignerRelation)}>
            <option value="">—</option>
            {SIGNER_RELATIONS.filter((r) => r !== "self").map((r) => <option key={r} value={r}>{tr(RELATION_LABELS[r], lang)}</option>)}
          </select>
        </label>
      )}
      {askAuthority && relation && (
        <div role="radiogroup" aria-label={t(T.authorityQ, lang)} className="space-y-2">
          <p className="text-xl font-semibold">{t(T.authorityQ, lang)}</p>
          {SIGNER_AUTHORITIES.map((a) => (
            <button key={a} type="button" role="radio" aria-checked={authority === a} onClick={() => setAuthority(a)} className={radio(authority === a)}>
              <span className={cn("grid size-7 shrink-0 place-items-center rounded-full border-2", authority === a ? "border-teal-700 bg-teal-700 text-white" : "border-slate-400")}>{authority === a && <Check className="size-4" strokeWidth={4} />}</span>
              {tr(AUTHORITY_LABELS[a], lang)}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={authority === "none"} onClick={() => setAuthority("none")} className={radio(authority === "none")}>
            <span className={cn("grid size-7 shrink-0 place-items-center rounded-full border-2", authority === "none" ? "border-teal-700 bg-teal-700 text-white" : "border-slate-400")}>{authority === "none" && <Check className="size-4" strokeWidth={4} />}</span>
            {t(T.authorityNone, lang)}
          </button>
          {authority === "other" && (
            <label className="block pt-1">
              <span className="mb-2 block text-lg font-semibold">{t(T.authorityExplain, lang)}</span>
              <input className={inputCls} value={authorityNote} onChange={(e) => setAuthorityNote(e.target.value)} maxLength={160} />
            </label>
          )}
          {noAuthority && <Note tone="warn">{t(T.authorityNoneNote, lang)}</Note>}
        </div>
      )}
      {noAuthority ? null : <>
      <label className="block">
        <span className="mb-2 block text-xl font-semibold">{who === "helper" ? t(T.typeNameHelper, lang) : t(T.typeName, lang)}</span>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={160} />
      </label>
      {declining ? null : method === "typed" ? (
        <div>
          {name.trim() && (
            <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 px-5 pb-3 pt-5">
              <p className="border-b-2 border-slate-400 pb-1 text-4xl text-slate-900" style={{ fontFamily: '"Segoe Script","Brush Script MT","Snell Roundhand","Apple Chancery",cursive' }} dir="auto">{name}</p>
            </div>
          )}
          <button type="button" onClick={() => setMethod("drawn")} className="mt-2 text-lg font-semibold text-teal-800 underline">{t(T.drawInstead, lang)}</button>
        </div>
      ) : (
        <div>
          <p className="mb-2 text-lg text-slate-600">{t(T.drawHere, lang)}</p>
          <SignaturePad onChange={setDrawn} clearLabel={t(T.clear, lang)} />
          <button type="button" onClick={() => { setMethod("typed"); setDrawn(null); }} className="mt-2 text-lg font-semibold text-teal-800 underline">{t(T.typeInstead, lang)}</button>
        </div>
      )}
      <button type="button" role="checkbox" aria-checked={consent} onClick={() => setConsent(!consent)}
        className={cn("flex w-full items-start gap-3 rounded-2xl border-2 p-4 text-start text-lg", consent ? "border-teal-700 bg-teal-50" : "border-slate-300 bg-white")}>
        <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border-2", consent ? "border-teal-700 bg-teal-700 text-white" : "border-slate-400 bg-white")}>{consent && <Check className="size-5" strokeWidth={4} />}</span>
        <span>{consentLabel}</span>
      </button>
      </>}
      {err && <Note tone="error">{err}</Note>}
      {!noAuthority && (
        <BigButton variant={declining ? "primary" : "success"} onClick={submit} disabled={sign.isPending} className={cn("w-full", declining && "bg-slate-700 active:bg-slate-800")}>
          {sign.isPending ? <Loader2 className="size-6 animate-spin" /> : null} {sign.isPending ? t(T.signing, lang) : t(declining ? T.declineConfirm : T.sign, lang)}
        </BigButton>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The patient's copy: exactly what they signed (or said no to), to save or print
// ---------------------------------------------------------------------------

type CopyData = RouterOutputs["patientForms"]["copy"];
const LOCALES: Record<IntakeLang, string> = { en: "en-US", es: "es-US", ar: "ar-u-nu-latn" };
const scriptFont = '"Segoe Script","Brush Script MT","Snell Roundhand","Apple Chancery",cursive';

function PatientCopy({ lang, session, phone, onBack, onServerError }: { lang: IntakeLang; session: string; phone: string | null; onBack: () => void; onServerError: (e: unknown) => boolean }) {
  const copy = trpc.patientForms.copy.useMutation();
  const [data, setData] = useState<CopyData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    copy.mutateAsync({ session }).then(setData).catch((e) => { if (!onServerError(e)) setFailed(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  const when = (d: Date | string | null) => (d ? new Date(d).toLocaleString(LOCALES[lang], { dateStyle: "long", timeStyle: "short", timeZone: "America/Chicago" }) : "");
  if (failed) return <Centered><Note tone="warn">{t(T.copyFailed, lang)}</Note><CallLine lang={lang} phone={phone} /></Centered>;
  if (!data) return <Centered><Loader2 className="size-10 animate-spin text-teal-700" /></Centered>;
  const [y, m, d] = data.dob.split("-");
  const answers = data.answers as Answers;
  return (
    <div className="space-y-5 print:space-y-8">
      <style>{"@media print { @page { margin: 14mm; } html { font-size: 12px !important; } }"}</style>
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-lg font-semibold text-teal-800 print:hidden">
        <ChevronLeft className="size-5 rtl:rotate-180" /> {t(T.back, lang)}
      </button>
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <div className="flex items-center gap-3 border-b border-slate-200 pb-3">
          <BrandMark size={40} />
          <div>
            <p className="text-lg font-bold text-teal-800">MyPCP Dr</p>
            {(data.clinic.name || data.clinic.phone) && <p className="text-base text-slate-600" dir="ltr">{[data.clinic.name, data.clinic.phone ? formatUsPhone(data.clinic.phone) : null].filter(Boolean).join(" · ")}</p>}
          </div>
        </div>
        <h1 className="mt-4 text-3xl font-bold">{t(T.copyTitle, lang)}</h1>
        <p className="mt-1 text-xl">{niceName(data.name)} · {t(T.dobLabel, lang)}: <span dir="ltr">{m}/{d}/{y}</span></p>
        <p className="mt-2 text-lg text-slate-600 print:hidden">{t(T.copyIntro, lang)}</p>
        <BigButton onClick={() => window.print()} className="mt-4 w-full print:hidden"><Printer className="size-6" /> {t(T.savePrint, lang)}</BigButton>
        <p className="mt-2 text-base text-slate-500 print:hidden">{t(T.savePrintHow, lang)}</p>
      </section>
      {data.forms.map((f) => {
        const fl = (f.language as IntakeLang) || "en";
        return (
          <section key={f.key} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm print:break-before-page print:rounded-none print:border-0 print:p-0 print:shadow-none">
            <h2 dir={langDir(fl)} className="text-2xl font-bold leading-tight">{f.text?.title ?? f.title}</h2>
            {f.kind === "agreement" && f.text ? (
              <div dir={langDir(fl)} lang={fl} className="mt-3 space-y-3 text-lg leading-relaxed">
                {textBlocks(f.text.body).map((b, i) => b.kind === "heading" ? <h3 key={i} className="pt-1 text-xl font-bold">{b.text}</h3>
                  : b.kind === "bullets" ? <ul key={i} className="list-disc space-y-1 ps-7">{b.items!.map((x, j) => <li key={j}>{x}</li>)}</ul>
                  : <p key={i} className="whitespace-pre-line">{b.text}</p>)}
              </div>
            ) : (
              <div dir={langDir(fl)} className="mt-3 space-y-4">
                {MEDICAL_INTAKE.sections.map((s) => (
                  <div key={s.id} className="break-inside-avoid">
                    <h3 className="text-xl font-bold">{tr(s.title, fl)}</h3>
                    <dl className="mt-1 space-y-1">
                      {s.fields.filter((x) => isVisible(x, answers)).map((x) => {
                        const v = x.type === "photo" ? (answers[x.id] ? t(T.photoAdded, fl) : "") : answerText(x, answers[x.id], fl);
                        return (
                          <div key={x.id}>
                            <dt className="text-base text-slate-500">{tr(x.label, fl)}</dt>
                            <dd className="whitespace-pre-line text-lg font-semibold">{v || "—"}</dd>
                          </div>
                        );
                      })}
                    </dl>
                  </div>
                ))}
                <p className="rounded-2xl bg-slate-50 p-4 text-lg">{tr(MEDICAL_INTAKE.attestation, fl)}</p>
              </div>
            )}
            <div className="mt-5 break-inside-avoid rounded-2xl border-2 border-slate-700 p-4">
              {f.decision === "declined" ? (
                <p className="text-xl font-bold">{t(T.yourAnswerNo, lang)}</p>
              ) : (
                <div className="flex h-20 items-end border-b-2 border-slate-700 pb-1">
                  {f.signature ? <img src={f.signature} alt="" className="max-h-20" /> : <span className="text-4xl" style={{ fontFamily: scriptFont }} dir="auto">{f.signerName}</span>}
                </div>
              )}
              <p className="mt-2 text-lg">
                {t(f.decision === "declined" ? T.answeredBy : T.signedBy, lang, { name: f.signerName })}
                {f.relation !== "self" ? ` (${tr(RELATION_LABELS[f.relation], lang)}, ${t(T.forThePatient, lang)}${f.authority ? `: ${tr(AUTHORITY_LABELS[f.authority], lang)}${f.authorityNote ? `, ${f.authorityNote}` : ""}` : ""})` : ""}
              </p>
              <p className="text-lg">{t(T.signedOn, lang, { date: when(f.signedAt) })}</p>
              <p className="mt-1 text-sm text-slate-500">{t(T.docCode, lang)}: <span dir="ltr" className="font-mono">{f.docHash.slice(0, 16)}</span></p>
            </div>
          </section>
        );
      })}
      <div className="print:hidden"><CallLine lang={lang} phone={phone} /></div>
    </div>
  );
}

function SignaturePad({ onChange, clearLabel }: { onChange: (png: string | null) => void; clearLabel: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);
  useEffect(() => {
    const c = ref.current!;
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const rect = c.getBoundingClientRect();
    c.width = Math.round(rect.width * ratio);
    c.height = Math.round(rect.height * ratio);
    const ctx = c.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
  }, []);
  const pos = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    ref.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = ref.current!.getContext("2d")!;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y + 0.1);
    ctx.stroke();
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = ref.current!.getContext("2d")!;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    inked.current = true;
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (inked.current) onChange(ref.current!.toDataURL("image/png"));
  };
  const clear = () => {
    const c = ref.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    inked.current = false;
    onChange(null);
  };
  return (
    <div>
      <canvas ref={ref} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up}
        className="h-48 w-full touch-none rounded-2xl border-2 border-slate-400 bg-white" aria-label="Signature" />
      <button type="button" onClick={clear} className="mt-2 rounded-xl border-2 border-slate-300 px-4 py-2 text-lg font-semibold">{clearLabel}</button>
    </div>
  );
}
