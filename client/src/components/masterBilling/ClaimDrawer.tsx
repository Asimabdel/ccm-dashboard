import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { ExternalLink, Unlink, UserCheck } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Btn, ErrorNote, Loading } from "@/components/workspace/ui";
import { PatientSearchBox } from "@/components/messages/PatientSearchBox";
import { trpc } from "@/lib/trpc";
import { niceName } from "@/lib/masterBillingFiles";
import { BILL_STATUS_HELP, BILL_STATUS_LABELS, CLAIM_STATUS_CODES, type BillStatus } from "@shared/billCodes";
import { SOURCE_LABELS, type BillSource } from "@shared/masterBilling";
import { money } from "@shared/payments";
import { StatusBadge } from "./StatusBadge";

const day = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const MATCH: Record<string, string> = { member: "matched by member ID", visit: "matched to that day's visit", name: "matched by name", close: "matched by a similar name", manual: "linked by you" };
const dob = (d: string | null | undefined) => (d ? `born ${new Date(`${d}T12:00:00`).toLocaleDateString("en-US")}` : "no birthday on file");

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-1 text-sm">
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="min-w-0 text-slate-800 dark:text-slate-100">{children}</dd>
    </div>
  );
}

/** One claim: its lines, what each insurance paid, the reasons in plain words, the files it came from. */
export function ClaimDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const q = trpc.masterBilling.claim.useQuery({ id: id ?? 0 }, { enabled: !!id });
  const [picking, setPicking] = useState(false);
  const link = trpc.masterBilling.linkPatient.useMutation({
    onSuccess: () => { setPicking(false); void utils.masterBilling.invalidate(); toast.success("Saved. Other claims with the same member ID follow it."); },
    onError: (e) => toast.error(e.message),
  });
  const c = q.data?.claim;
  return (
    <Sheet open={!!id} onOpenChange={(o) => { if (!o) { setPicking(false); onClose(); } }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl p-0 gap-0 overflow-y-auto bg-white dark:bg-slate-900">
        <SheetHeader className="border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <SheetTitle>{c ? niceName(c.patientName) || "Claim" : "Claim"}</SheetTitle>
          <SheetDescription>{c ? `Claim ${c.claimNo ?? "—"} · ${day(c.firstServiceDate)}` : " "}</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-5 py-4">
          {q.isLoading && <Loading />}
          {q.error && <ErrorNote message={q.error.message} />}
          {c && q.data && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={c.status as BillStatus} />
                <span className="text-xs text-slate-500">{BILL_STATUS_HELP[c.status as BillStatus]}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {[["Billed", c.billedCents], ["Allowed", c.allowedCents], ["Insurance paid", c.paidCents], ["Patient owes", c.patientOwesCents], ["Written off", c.writtenOffCents], ["Denied", c.deniedCents]].map(([label, v]) => (
                  <div key={label as string} className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
                    <p className="text-xs text-slate-500">{label}</p>
                    <p className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">{money(v as number)}</p>
                  </div>
                ))}
              </div>
              <dl>
                <Row label="Patient">
                  {c.subjectKey ? (
                    <>
                      <span className="flex flex-wrap items-center gap-2">
                        <Link href={`/patients/${encodeURIComponent(c.subjectKey)}`} className="inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-300">{niceName(q.data.patient.name ?? c.patientName) || "Open patient"} <ExternalLink size={12} /></Link>
                        <span className="text-xs text-slate-400">{MATCH[c.matchSource ?? ""] ?? ""}</span>
                        <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => setPicking(true)}>Change</button>
                        {c.matchSource === "close" && <button type="button" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:underline" disabled={link.isPending} onClick={() => link.mutate({ claimId: c.id, subjectKey: null, none: true })}><Unlink size={11} /> Not this patient</button>}
                        {c.matchSource === "manual" && <button type="button" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:underline" disabled={link.isPending} onClick={() => link.mutate({ claimId: c.id, subjectKey: null })}><Unlink size={11} /> Undo my link</button>}
                      </span>
                      {q.data.patient.name && niceName(q.data.patient.name).toLowerCase() !== niceName(c.patientName).toLowerCase() && (
                        <span className="mt-0.5 block text-xs text-slate-500">The bill says {niceName(c.patientName) || "no name"}{q.data.patient.why ? ` (${q.data.patient.why})` : ""}.</span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="flex flex-wrap items-center gap-2">{niceName(c.patientName) || "—"}
                        {c.matchSource === "manual"
                          ? <><span className="text-xs text-slate-500">you marked this patient as not in MyPCP</span>
                            <button type="button" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:underline" disabled={link.isPending} onClick={() => link.mutate({ claimId: c.id, subjectKey: null })}><Unlink size={11} /> Undo</button></>
                          : <span className="text-xs text-amber-700 dark:text-amber-300">not matched to a patient</span>}
                        <Btn size="sm" variant="secondary" onClick={() => setPicking(true)}><UserCheck size={13} /> Pick the patient</Btn></span>
                      {q.data.patient.suggestions.length > 0 && (
                        <div className="mt-2 rounded-lg border border-slate-200 dark:border-slate-700">
                          <p className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-500 dark:border-slate-800">Possible matches: check the name and birthday, then pick one</p>
                          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                            {q.data.patient.suggestions.map((s) => (
                              <li key={s.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                                <div className="min-w-0 flex-1">
                                  <Link href={`/patients/${encodeURIComponent(s.key)}`} className="text-sm text-blue-700 hover:underline dark:text-blue-300">{niceName(s.name)}</Link>
                                  <span className="ml-2 text-xs text-slate-500">{dob(s.dob)}</span>
                                  <span className="block text-xs text-slate-500">{[s.why, s.support].filter(Boolean).join(" · ")}</span>
                                </div>
                                <Btn size="sm" variant="secondary" disabled={link.isPending} onClick={() => link.mutate({ claimId: c.id, subjectKey: s.key })}>This one</Btn>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  )}
                  {picking && <div className="mt-2 max-w-sm"><PatientSearchBox autoFocus onPick={(p) => link.mutate({ claimId: c.id, subjectKey: p.key })} /></div>}
                </Row>
                <Row label="Member ID">{c.memberId ?? "—"}</Row>
                <Row label="Insurance">{c.payerName ?? "—"} <span className="text-xs text-slate-400">{c.payerType}</span>{c.otherPayers.length > 0 && <span className="block text-xs text-slate-500">Also paid by: {c.otherPayers.join(", ")}</span>}</Row>
                <Row label="Provider">{c.providerLabel ?? "—"}{c.providerNpi && <span className="ml-1 text-xs text-slate-400">NPI {c.providerNpi}</span>}</Row>
                <Row label="Clinic">{c.clinicName ?? "Unknown"}</Row>
                <Row label="Insurance claim #">{c.payerClaimNo ?? "—"}</Row>
                <Row label="Last paid">{day(c.lastPaidDate)}</Row>
              </dl>

              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Lines</p>
                <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                  <table className="w-full min-w-[560px] text-xs">
                    <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800/60"><tr>
                      <th className="px-2 py-1.5 text-left font-medium">CPT</th><th className="px-2 text-left font-medium">Date</th><th className="px-2 text-right font-medium">Units</th>
                      <th className="px-2 text-right font-medium">Billed</th><th className="px-2 text-right font-medium">Allowed</th><th className="px-2 text-right font-medium">Paid</th><th className="px-2 text-right font-medium">Patient</th><th className="px-2 text-right font-medium">Denied</th>
                    </tr></thead>
                    <tbody>
                      {q.data.lines.map((l) => (
                        <tr key={l.id} className="border-t border-slate-100 align-top dark:border-slate-700/60">
                          <td className="px-2 py-1.5 font-medium">{l.code}{l.modifiers ? <span className="text-slate-400"> -{l.modifiers}</span> : null}
                            {l.adjustments.length > 0 && <ul className="mt-1 space-y-0.5 font-normal text-slate-500">{l.adjustments.map((a, i) => <li key={i}>{money(a.cents)} · {a.text}</li>)}</ul>}
                            {l.remarks.length > 0 && <p className="mt-0.5 font-normal text-slate-400">Remarks: {l.remarks.join(", ")}</p>}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5">{day(l.serviceDate)}</td><td className="px-2 text-right">{l.units}</td>
                          <td className="px-2 text-right tabular-nums">{money(l.billedCents)}</td><td className="px-2 text-right tabular-nums">{money(l.allowedCents)}</td><td className="px-2 text-right tabular-nums">{money(l.paidCents)}</td>
                          <td className="px-2 text-right tabular-nums">{money(l.patientOwesCents)}</td><td className="px-2 text-right tabular-nums">{money(l.deniedCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Where it came from</p>
                <ul className="space-y-2">
                  {q.data.events.map((e) => (
                    <li key={e.id} className="rounded-lg border border-slate-200 px-3 py-2 text-xs dark:border-slate-700">
                      <p className="font-medium text-slate-700 dark:text-slate-200">{e.fileName} <span className="font-normal text-slate-400">· {SOURCE_LABELS[e.source as BillSource]} · uploaded {new Date(e.uploadedAt).toLocaleDateString("en-US")}</span></p>
                      <p className="text-slate-600 dark:text-slate-300">
                        {e.clpStatus ? CLAIM_STATUS_CODES[e.clpStatus] ?? `Status ${e.clpStatus}` : e.sheetStatus ? BILL_STATUS_LABELS[e.sheetStatus as BillStatus] : "—"}
                        {" · "}{e.payerName ?? "—"}{e.checkNumber ? ` · check ${e.checkNumber}` : ""}{e.paidDate ? ` · ${day(e.paidDate)}` : ""}
                      </p>
                      <p className="text-slate-500">Billed {money(e.billedCents)} · paid {money(e.paidCents)}{e.patientRespCents ? ` · patient ${money(e.patientRespCents)}` : ""}</p>
                      {e.claimAdjustments.map((a, i) => <p key={i} className="text-slate-500">{money(a.cents)} · {a.text}</p>)}
                      {e.note && <p className="text-slate-500">Note: {e.note}</p>}
                    </li>
                  ))}
                </ul>
                {q.data.replacedReports > 0 && <p className="mt-1 text-xs text-slate-400">This payment replaced {q.data.replacedReports} "waiting" row{q.data.replacedReports === 1 ? "" : "s"} from a claim report.</p>}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
