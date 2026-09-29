// The signed copy of a patient's forms, laid out for printing / "Save as PDF" (to upload to
// Practice Fusion, which has no document-upload API). Includes the exact wording signed, the
// answers, card photos, signatures and a certificate page (audit trail + document fingerprints).
import { useEffect } from "react";
import { useParams } from "wouter";
import { Printer } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { BrandMark } from "@/components/BrandMark";
import { trpc } from "@/lib/trpc";
import { CONSENT_LABELS, DECLINE_CONSENT, ESIGN_CONSENT, LANG_LABELS, MEDICAL_INTAKE, answerText, isVisible, langDir, textBlocks, tr, type Answers, type IntakeLang } from "@shared/intake";

const at = (d: Date | string | null | undefined) =>
  d ? `${new Date(d).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "America/Chicago" })} CT` : "—";

function FileImg({ packetId, fileId, className, alt }: { packetId: number; fileId: number; className?: string; alt: string }) {
  const f = trpc.workspace.intake.file.useQuery({ id: packetId, fileId }, { staleTime: Infinity });
  return f.data ? <img src={f.data.dataUrl} alt={alt} className={className} /> : <span className="text-xs text-slate-400">Loading image…</span>;
}

export default function IntakePrintPage() {
  const { user } = useAuth({ redirectOnUnauthenticated: true });
  const { id } = useParams<{ id: string }>();
  const q = trpc.workspace.intake.detail.useQuery({ id: Number(id) }, { enabled: !!user && Number(id) > 0 });
  const p = q.data;
  useEffect(() => {
    const prev = document.title;
    return () => { document.title = prev; };
  }, []);
  useEffect(() => { if (p) document.title = `Patient forms - ${p.name}`; }, [p]);
  if (q.isLoading || !p) return <div className="p-10 text-sm text-slate-500">{q.error ? q.error.message : "Loading…"}</div>;
  const answers = p.answers as Answers;
  const sigFor = (k: string) => p.signatures.find((s) => s.formKey === k);
  const photoFiles = p.files.filter((f) => f.kind !== "signature");

  return (
    <div className="min-h-screen bg-slate-100 py-6 text-slate-900 print:bg-white print:py-0" style={{ colorScheme: "light" }}>
      <style>{`@media print { @page { margin: 14mm; } .page-break { break-before: page; } .no-print { display: none !important; } }`}</style>
      <div className="no-print mx-auto mb-4 flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
        <p>Click <b>Print / Save as PDF</b>, choose <b>Save as PDF</b> as the printer, then upload the file to the patient's chart in Practice Fusion (Documents).</p>
        <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-2 rounded-lg bg-teal-700 px-4 py-2 font-semibold text-white">
          <Printer size={15} /> Print / Save as PDF
        </button>
      </div>

      <div className="mx-auto max-w-3xl bg-white p-10 shadow-sm print:max-w-none print:p-0 print:shadow-none">
        <header className="flex items-start justify-between gap-6 border-b-2 border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <BrandMark size={44} />
            <div>
              <p className="text-xl font-bold">MyPCP Dr</p>
              {p.clinic && <p className="text-xs text-slate-600">{[p.clinic.name, p.clinic.address, p.clinic.phone].filter(Boolean).join(" · ")}</p>}
            </div>
          </div>
          <div className="text-right text-xs text-slate-600">
            <p className="text-base font-bold text-slate-900">Signed patient forms</p>
            <p>Packet #{p.id}</p>
            <p>Finished {at(p.completedAt)}</p>
          </div>
        </header>
        <section className="mt-4 grid grid-cols-3 gap-4 text-sm">
          <div><p className="text-xs text-slate-500">Patient</p><p className="font-semibold">{p.name}</p></div>
          <div><p className="text-xs text-slate-500">Date of birth</p><p className="font-semibold">{p.dob}</p></div>
          <div><p className="text-xs text-slate-500">Language</p><p className="font-semibold">{LANG_LABELS[p.language as IntakeLang] ?? p.language}</p></div>
        </section>

        {p.forms.map((f, i) => {
          const sig = sigFor(f.key);
          return (
            <section key={f.key} className={i ? "page-break mt-10" : "mt-8"}>
              {f.kind === "questionnaire" ? (
                <>
                  <h2 className="border-b border-slate-300 pb-1 text-lg font-bold">{MEDICAL_INTAKE.title.en}</h2>
                  <div className="mt-3 space-y-4 text-sm">
                    {MEDICAL_INTAKE.sections.map((s) => (
                      <div key={s.id} className="break-inside-avoid">
                        <h3 className="mb-1 font-bold">{s.title.en}</h3>
                        <table className="w-full border-collapse text-sm">
                          <tbody>
                            {s.fields.filter((x) => isVisible(x, answers) && x.type !== "photo").map((x) => (
                              <tr key={x.id} className="border-b border-slate-100 align-top">
                                <td className="w-2/5 py-1 pe-3 text-slate-600">{x.label.en}</td>
                                <td className="whitespace-pre-line py-1 font-medium">{answerText(x, answers[x.id]) || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                    {photoFiles.length > 0 && (
                      <div className="break-inside-avoid">
                        <h3 className="mb-1 font-bold">Photos</h3>
                        <div className="grid grid-cols-2 gap-3">
                          {photoFiles.map((ph) => (
                            <figure key={ph.id} className="rounded border border-slate-200 p-2">
                              <FileImg packetId={p.id} fileId={ph.id} alt={ph.kind} className="max-h-56 w-full object-contain" />
                              <figcaption className="mt-1 text-xs text-slate-500">{ph.kind === "insurance_front" ? "Insurance card, front" : ph.kind === "insurance_back" ? "Insurance card, back" : "Photo ID"}</figcaption>
                            </figure>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="break-inside-avoid rounded border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">Statement signed{sig && sig.language !== "en" ? ` (in ${LANG_LABELS[sig.language as IntakeLang] ?? sig.language}; English below)` : ""}</p>
                      {sig && sig.language !== "en" && <p dir={langDir(sig.language)} className="mt-1">{tr(MEDICAL_INTAKE.attestation, sig.language)}</p>}
                      <p className="mt-1">{MEDICAL_INTAKE.attestation.en}</p>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <h2 className="border-b border-slate-300 pb-1 text-lg font-bold" dir={sig?.text ? langDir(sig.language) : undefined}>{sig?.text?.title ?? f.title}</h2>
                  {sig?.text ? (
                    <div dir={langDir(sig.language)} lang={sig.language} className="mt-3 space-y-2 text-sm leading-relaxed">
                      {textBlocks(sig.text.body).map((b, j) => b.kind === "heading" ? <h3 key={j} className="pt-1 font-bold">{b.text}</h3>
                        : b.kind === "bullets" ? <ul key={j} className="list-disc ps-6">{b.items!.map((x, k) => <li key={k}>{x}</li>)}</ul>
                        : <p key={j} className="whitespace-pre-line">{b.text}</p>)}
                    </div>
                  ) : <p className="mt-3 text-sm text-slate-500">Not signed.</p>}
                </>
              )}
              {sig && (
                <div className="mt-5 break-inside-avoid rounded border-2 border-slate-800 p-4 text-sm">
                  <div className="flex flex-wrap items-end justify-between gap-6">
                    <div className="min-w-[16rem] flex-1">
                      {sig.decision === "declined" ? (
                        <p className="text-base font-bold">DECLINED: the patient chose not to agree to this form.</p>
                      ) : (
                        <>
                          <div className="flex h-20 items-end border-b border-slate-800 pb-1">
                            {sig.method === "drawn" && sig.signatureFileId
                              ? <FileImg packetId={p.id} fileId={sig.signatureFileId} alt="Signature" className="max-h-20" />
                              : <span className="text-3xl" style={{ fontFamily: '"Segoe Script","Brush Script MT","Snell Roundhand",cursive' }} dir="auto">{sig.signerName}</span>}
                          </div>
                          <p className="mt-1 text-xs text-slate-600">Electronic signature ({sig.method === "drawn" ? "drawn" : "typed name"})</p>
                        </>
                      )}
                      {sig.consentKind && <p className="mt-1 text-xs text-slate-600">Records: {CONSENT_LABELS[sig.consentKind]} consent ({sig.decision === "declined" ? "declined" : "given"})</p>}
                    </div>
                    <div className="text-xs">
                      <p><span className="text-slate-500">{sig.decision === "declined" ? "Answered by:" : "Signed by:"}</span> <b>{sig.signerName}</b>{sig.signerRelation !== "self" ? ` (${sig.relationLabel}, for the patient)` : " (patient)"}</p>
                      {sig.authorityLabel && <p><span className="text-slate-500">Legal authority:</span> {sig.authorityLabel}{sig.authorityNote ? `: ${sig.authorityNote}` : ""}</p>}
                      <p><span className="text-slate-500">Date:</span> {at(sig.signedAt)}</p>
                      <p><span className="text-slate-500">IP address:</span> {sig.ip ?? "—"}</p>
                      <p><span className="text-slate-500">Form version:</span> {sig.formVersion}</p>
                    </div>
                  </div>
                  {sig.decision === "declined"
                    ? <p className="mt-3 text-xs text-slate-600">Signer confirmed: "{tr(DECLINE_CONSENT, sig.language)}"{sig.language !== "en" ? ` ("${DECLINE_CONSENT.en}")` : ""}</p>
                    : <p className="mt-3 text-xs text-slate-600">Signer agreed: "{tr(ESIGN_CONSENT, sig.language)}"{sig.language !== "en" ? ` ("${ESIGN_CONSENT.en}")` : ""}</p>}
                </div>
              )}
            </section>
          );
        })}

        <section className="page-break mt-10 text-xs">
          <h2 className="border-b border-slate-300 pb-1 text-lg font-bold">Certificate of completion</h2>
          <p className="mt-2 text-slate-600">
            {p.source === "website"
              ? "Filled in from the open link on the practice website: the person entered the patient's name, date of birth and phone number. "
              : "Sent by private link; the signer confirmed the patient's date of birth before opening the forms. "}
            Times are US Central.
            Each fingerprint is a SHA-256 hash of the signed content; if any word, answer, name or time were changed, the fingerprint would no longer match.
          </p>
          <table className="mt-3 w-full border-collapse">
            <thead><tr className="border-b border-slate-300 text-left"><th className="py-1 pe-2">When</th><th className="py-1 pe-2">What</th><th className="py-1 pe-2">IP address</th><th className="py-1">Device</th></tr></thead>
            <tbody>
              {p.events.filter((e) => e.type !== "viewed" && e.type !== "photo_viewed").map((e, i) => (
                <tr key={i} className="border-b border-slate-100 align-top">
                  <td className="whitespace-nowrap py-1 pe-2">{at(e.at)}</td>
                  <td className="py-1 pe-2">{e.type.replace(/_/g, " ")}{e.detail ? `: ${e.detail}` : ""}{e.userName ? ` (${e.userName})` : ""}</td>
                  <td className="py-1 pe-2">{e.ip ?? ""}</td>
                  <td className="max-w-[14rem] truncate py-1 text-slate-500">{e.userAgent ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="mt-4 font-bold">Document fingerprints</h3>
          <table className="mt-1 w-full border-collapse">
            <tbody>
              {p.signatures.map((s) => (
                <tr key={s.formKey} className="border-b border-slate-100 align-top">
                  <td className="py-1 pe-2">{s.formTitle}</td>
                  <td className="break-all py-1 font-mono text-[10px]">content {s.textHash}<br />signature record {s.docHash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
