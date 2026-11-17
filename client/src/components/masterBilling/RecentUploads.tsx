// Recently uploaded (2026-11-17): the latest files of every kind (Office Ally 835s, claim sheets, PDF EOBs
// read by AI, ZocDoc reports) with who uploaded them, what they brought in and how much was matched;
// clicking one shows what that upload added.
import { useState } from "react";
import { AlertTriangle, ChevronRight, FileUp } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Btn, ErrorNote, Loading, Panel } from "@/components/workspace/ui";
import { niceName } from "@/lib/masterBillingFiles";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { type BillStatus } from "@shared/billCodes";
import { SOURCE_LABELS, type BillSource } from "@shared/masterBilling";
import { money } from "@shared/payments";
import { ZOCDOC_STATUS_LABELS, type ZocdocStatus } from "@shared/zocdoc";
import { StatusBadge } from "./StatusBadge";

export interface UploadRef { source: "bill" | "zocdoc"; id: number }

const KIND_LABEL = (k: string) => (k === "zocdoc" ? "ZocDoc report" : SOURCE_LABELS[k as BillSource] ?? k);
const when = (d: Date | string) => new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const day = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The latest uploads, newest first. Click one to see what it added. */
export function RecentUploads({ onOpen, onSeeAll, onUpload }: { onOpen: (u: UploadRef) => void; onSeeAll: () => void; onUpload: () => void }) {
  const [limit, setLimit] = useState(8);
  const q = trpc.masterBilling.recentUploads.useQuery({ limit }, { placeholderData: (prev) => prev });
  const rows = q.data ?? [];
  if (q.data && !rows.length) return null;
  return (
    <Panel title="Recently uploaded" subtitle="The latest files of every kind. Click one to see what it added." bodyClassName="p-0"
      action={<div className="flex gap-2"><Btn size="sm" variant="secondary" onClick={onSeeAll}>All bill uploads</Btn><Btn size="sm" onClick={onUpload}><FileUp size={14} /> Upload</Btn></div>}>
      {q.isLoading && <Loading />}
      {q.error && <div className="p-4"><ErrorNote message={q.error.message} /></div>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Uploaded</th><th className="px-3 py-2 text-left font-medium">File</th>
                <th className="px-3 py-2 text-left font-medium">Brought in</th><th className="px-3 py-2 text-left font-medium">Money</th>
                <th className="px-3 py-2 text-left font-medium">Matched to a patient</th><th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const gone = r.status !== "saved";
                return (
                  <tr key={r.key} onClick={() => onOpen({ source: r.source, id: r.id })} title="See what this upload added"
                    className={cn("cursor-pointer border-t border-slate-100 align-top hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-800/40", gone && "opacity-60")}>
                    <td className="whitespace-nowrap px-3 py-2">{when(r.uploadedAt)}<p className="text-xs text-slate-400">{r.uploadedBy ?? "—"}</p></td>
                    <td className="max-w-[280px] px-3 py-2">
                      <p className="truncate font-medium text-slate-800 dark:text-slate-100" title={r.fileName}>{r.fileName}</p>
                      <p className="text-xs text-slate-400">{KIND_LABEL(r.kind)}{gone ? ` · ${r.status === "removing" ? "being removed" : "removed"}` : ""}</p>
                    </td>
                    <td className="px-3 py-2">
                      {r.source === "bill" ? (
                        <>
                          <p>{plural(r.records, "claim")}</p>
                          <p className="text-xs text-slate-400">{r.lines != null ? plural(r.lines, "CPT line") : ""}{r.payments ? `${r.lines != null ? " · " : ""}${plural(r.payments, "payment")}` : ""}</p>
                        </>
                      ) : (
                        <>
                          <p>{plural(r.records, "booking")}</p>
                          <p className="text-xs text-slate-400">{r.firstDate ? `${day(r.firstDate)} – ${day(r.lastDate)}` : ""}</p>
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                      {r.source === "bill" ? (
                        <>
                          <p>Paid {money(r.paidCents ?? 0)}</p>
                          <p className="text-xs text-slate-400">of {money(r.billedCents ?? 0)} billed</p>
                        </>
                      ) : (
                        <>
                          <p>{money(r.costCents ?? 0)}</p>
                          <p className="text-xs text-slate-400">ZocDoc charges</p>
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                      <p>{r.matched.toLocaleString()} of {r.matchedOf.toLocaleString()} <span className="text-slate-400">({pct(r.matched, r.matchedOf)})</span></p>
                      {r.source === "zocdoc" && r.stillFromFile != null && r.stillFromFile < r.records && <p className="text-xs text-slate-400">{plural(r.stillFromFile, "booking")} still from this file</p>}
                    </td>
                    <td className="px-2 py-2 text-slate-400"><ChevronRight size={16} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length >= limit && limit < 30 && (
        <div className="border-t border-slate-100 px-4 py-2 dark:border-slate-700/60">
          <button type="button" className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-300" onClick={() => setLimit(30)}>Show more</button>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function Box({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">{value}</p>
      {hint && <p className="text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

function Pager({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between pt-2 text-sm">
      <span className="text-slate-500">Page {page} of {pages.toLocaleString()}</span>
      <div className="flex gap-2">
        <Btn size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Btn>
        <Btn size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Btn>
      </div>
    </div>
  );
}

/** One upload: when, who, what kind, and everything it brought in. Claims open in the claim drawer. */
export function UploadDrawer({ target, onClose, onOpenClaim }: { target: UploadRef | null; onClose: () => void; onOpenClaim: (id: number) => void }) {
  return (
    <Sheet open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-3xl p-0 gap-0 overflow-y-auto bg-white dark:bg-slate-900">
        {target?.source === "bill" && <BillUpload key={`b${target.id}`} id={target.id} onOpenClaim={onOpenClaim} />}
        {target?.source === "zocdoc" && <ZocdocUpload key={`z${target.id}`} id={target.id} />}
        {!target && <SheetHeader className="sr-only"><SheetTitle>Upload</SheetTitle><SheetDescription>What one upload added</SheetDescription></SheetHeader>}
      </SheetContent>
    </Sheet>
  );
}

function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <SheetHeader className="border-b border-slate-100 px-5 py-4 dark:border-slate-800">
      <SheetTitle className="break-all pr-6">{title}</SheetTitle>
      <SheetDescription>{sub}</SheetDescription>
    </SheetHeader>
  );
}

interface CheckInfo { payerName: string | null; checkNumber: string | null; paymentDate: string | null; amountCents: number; balanced: boolean | null; claims: number }

function BillUpload({ id, onOpenClaim }: { id: number; onOpenClaim: (id: number) => void }) {
  const [page, setPage] = useState(1);
  const q = trpc.masterBilling.billUploadDetail.useQuery({ importId: id, page }, { placeholderData: (prev) => prev });
  const d = q.data;
  const u = d?.upload;
  const th = "px-3 py-2 text-right font-medium";
  const td = "px-3 py-2 text-right tabular-nums";
  return (
    <>
      <Head title={u?.fileName ?? "Upload"} sub={u ? `${KIND_LABEL(u.kind)} · uploaded ${when(u.uploadedAt)}${u.uploadedBy ? ` by ${u.uploadedBy}` : ""}` : " "} />
      <div className="space-y-5 px-5 py-4">
        {q.isLoading && <Loading />}
        {q.error && <ErrorNote message={q.error.message} />}
        {d && u && (
          <>
            {u.status !== "saved" && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                {u.status === "removing" ? "This upload is being removed." : `This upload was removed${u.removedAt ? ` on ${when(u.removedAt)}` : ""}. Its claims were taken out of every total (claims also in another upload stayed).`}
                {" "}When it came in, it had {plural(u.claimCount, "claim")}: {money(u.billedCents)} billed, {money(u.paidCents)} paid.
              </p>
            )}
            {d.totals && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Box label="Claims" value={d.totals.claims.toLocaleString()} hint={`${d.totals.newClaims.toLocaleString()} new · ${d.totals.addedTo.toLocaleString()} added to`} />
                <Box label="CPT lines" value={d.totals.lines.toLocaleString()} />
                <Box label="Matched to a patient" value={`${d.totals.matched.toLocaleString()} of ${d.totals.claims.toLocaleString()}`} hint={pct(d.totals.matched, d.totals.claims)} />
                <Box label="Billed" value={money(d.totals.billedCents)} />
                <Box label="Insurance paid" value={money(d.totals.paidCents)} hint={`${pct(d.totals.paidCents, d.totals.billedCents)} of billed`} />
                <Box label="Patient owes" value={money(d.totals.patientOwesCents)} hint="deductible, copay, coinsurance" />
              </div>
            )}

            {u.checks.length > 0 && (
              <section>
                <h4 className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100">Payments in this file</h4>
                <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
                  {(u.checks as CheckInfo[]).slice(0, 50).map((c, i) => (
                    <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <span className="min-w-0 truncate">{c.payerName ?? "—"} · check # {c.checkNumber ?? "—"} · {day(c.paymentDate)}{c.claims ? ` · ${plural(c.claims, "claim")}` : ""}</span>
                      <span className="tabular-nums">
                        {money(c.amountCents)}
                        {c.balanced === false && <span className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle size={11} /> doesn&apos;t add up</span>}
                      </span>
                    </li>
                  ))}
                  {u.checks.length > 50 && <li className="py-1.5 text-xs text-slate-400">+{u.checks.length - 50} more</li>}
                </ul>
              </section>
            )}

            {d.rows.length > 0 && (
              <section>
                <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Claims it brought in</h4>
                <p className="mb-2 text-xs text-slate-500">Billed and paid are what this file says. <b>New</b> = first time this claim came in. <b>Added to</b> = the claim was already on file (an earlier upload or a claim report) and this file added to it. Status is the claim&apos;s status now. Click a claim to open it.</p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Service</th><th className="px-3 py-2 text-left font-medium">Patient</th><th className="px-3 py-2 text-left font-medium">Insurance</th>
                        <th className="px-3 py-2 text-left font-medium">CPT</th><th className={th}>Billed</th><th className={th}>Paid</th><th className="px-3 py-2 text-left font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.rows.map((r) => (
                        <tr key={r.claimRef} onClick={() => r.claimId && onOpenClaim(r.claimId)} title={r.claimId ? "Open this claim" : undefined}
                          className={cn("border-t border-slate-100 dark:border-slate-700/60", r.claimId && "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40")}>
                          <td className="whitespace-nowrap px-3 py-2">{day(r.serviceDate)}</td>
                          <td className="px-3 py-2">
                            <span className="font-medium text-slate-800 dark:text-slate-100">{niceName(r.patientName) || "—"}</span>
                            <span className={cn("ml-1.5 rounded px-1 text-[11px]", r.change === "new" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")}>{r.change === "new" ? "New" : "Added to"}</span>
                            {!r.matched && <span className="ml-1 rounded bg-amber-100 px-1 text-[11px] text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">no match</span>}
                          </td>
                          <td className="max-w-[180px] truncate px-3 py-2" title={r.payerName ?? ""}>{r.payerName ?? "—"}</td>
                          <td className="max-w-[120px] truncate px-3 py-2" title={r.codes.join(", ")}>{r.codes.join(", ") || "—"}</td>
                          <td className={td}>{money(r.billedCents)}</td>
                          <td className={td}>{money(r.paidCents)}</td>
                          <td className="px-3 py-2">{r.status ? <StatusBadge status={r.status as BillStatus} /> : "—"}{r.replaced && <span className="block text-[11px] text-slate-400">paid under another claim #</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={d.page} total={d.total} pageSize={d.pageSize} onPage={setPage} />
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ZocdocUpload({ id }: { id: number }) {
  const [page, setPage] = useState(1);
  const q = trpc.masterBilling.zocdocUploadDetail.useQuery({ importId: id, page }, { placeholderData: (prev) => prev });
  const d = q.data;
  const u = d?.upload;
  const t = d?.totals;
  return (
    <>
      <Head title={u?.fileName ?? "ZocDoc upload"} sub={u ? `ZocDoc report · uploaded ${when(u.uploadedAt)}${u.uploadedBy ? ` by ${u.uploadedBy}` : ""}` : " "} />
      <div className="space-y-5 px-5 py-4">
        {q.isLoading && <Loading />}
        {q.error && <ErrorNote message={q.error.message} />}
        {d && u && t && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Box label="Bookings in the file" value={u.rowCount.toLocaleString()} hint={u.firstDate ? `appointments ${day(u.firstDate)} – ${day(u.lastDate)}` : undefined} />
              <Box label="Still from this file" value={t.bookings.toLocaleString()} hint="the latest copy of these bookings" />
              <Box label="ZocDoc charges" value={money(t.costCents)} hint={plural(t.charged, "charged booking")} />
              <Box label="New patients" value={t.newPatients.toLocaleString()} />
              <Box label="Matched to a patient" value={`${t.matched.toLocaleString()} of ${t.bookings.toLocaleString()}`} hint={pct(t.matched, t.bookings)} />
            </div>
            {t.bookings < u.rowCount && (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                {u.laterUploads
                  ? `${(u.rowCount - t.bookings).toLocaleString()} of this file's bookings were also in a later ZocDoc upload, so they now count under that one (each booking is counted once). The numbers above are for the bookings still from this file.`
                  : "Some rows in this file were the same booking more than once; each booking is counted once."}
              </p>
            )}
            {d.rows.length > 0 && (
              <section>
                <h4 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">Bookings from this file</h4>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Appointment</th><th className="px-3 py-2 text-left font-medium">Patient</th><th className="px-3 py-2 text-left font-medium">Provider</th>
                        <th className="px-3 py-2 text-left font-medium">Insurance</th><th className="px-3 py-2 text-left font-medium">Status</th><th className="px-3 py-2 text-right font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.rows.map((r) => (
                        <tr key={r.id} className="border-t border-slate-100 dark:border-slate-700/60">
                          <td className="whitespace-nowrap px-3 py-2">{day(r.appointmentAt.slice(0, 10))}<span className="block text-xs text-slate-400">{r.appointmentAt.slice(11)}</span></td>
                          <td className="px-3 py-2">
                            <span className="font-medium text-slate-800 dark:text-slate-100">{niceName(r.patientName) || "—"}</span>
                            {r.patientType && <span className="ml-1.5 text-[11px] text-slate-500">{r.patientType}</span>}
                            {!r.subjectKey && <span className="ml-1.5 rounded bg-amber-100 px-1 text-[11px] text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">no match</span>}
                          </td>
                          <td className="max-w-[160px] truncate px-3 py-2" title={r.providerName ?? ""}>{r.providerName ?? "—"}</td>
                          <td className="max-w-[160px] truncate px-3 py-2" title={r.insuranceCarrier ?? ""}>{r.insuranceCarrier ?? "—"}</td>
                          <td className="px-3 py-2">{ZOCDOC_STATUS_LABELS[r.status as ZocdocStatus] ?? r.status}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.costCents ? money(r.costCents) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={d.page} total={d.total} pageSize={d.pageSize} onPage={setPage} />
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
