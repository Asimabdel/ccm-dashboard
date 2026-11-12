import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, FileText, FileUp, Loader2, Sparkles, Trash2, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, SelectBox } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ACCEPT, niceName, prepareFiles, toBase64, type PreparedFile } from "@/lib/masterBillingFiles";
import { SHEET_FIELDS, SHEET_FIELD_KEYS, detectSheetMapping, parseBillSheet, type SheetField, type SheetMapping } from "@shared/billSheet";
import { BILL_STATUS_LABELS } from "@shared/billCodes";
import { money } from "@shared/payments";
import type { BillEventInput } from "@shared/masterBilling";
import type { PdfReadClaim } from "@shared/billPdf";

type FileState =
  | { s: "ready" }
  | { s: "duplicate"; when: string }
  | { s: "saving"; step: string }
  | { s: "saved"; claims: number; matched: number }
  | { s: "failed"; message: string };

/** A file that is uploaded (not a note or an error). */
type RealFile = Exclude<PreparedFile, { kind: "error" } | { kind: "note" }>;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const day = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

/** Upload Office Ally files: 835 / ERA zips, claim-report spreadsheets, PDF EOBs. Each is checked before it's saved. */
export function UploadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<PreparedFile[]>([]);
  const [state, setState] = useState<Record<string, FileState>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [bulk, setBulk] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const busy = !!bulk || Object.values(state).some((x) => x.s === "saving");

  const start = trpc.masterBilling.startImport.useMutation();
  const uploadLocal = trpc.masterBilling.uploadLocal.useMutation();
  const addEvents = trpc.masterBilling.addEvents.useMutation();
  const finish = trpc.masterBilling.finishImport.useMutation();
  const cancel = trpc.masterBilling.cancelImport.useMutation();
  const saveMap = trpc.masterBilling.saveSheetMapping.useMutation();

  useEffect(() => {
    if (!open) { setFiles([]); setState({}); setBulk(null); setShowAll(false); }
  }, [open]);

  const set = (id: string, s: FileState) => setState((m) => ({ ...m, [id]: s }));

  async function pick(list: File[]) {
    if (!list.length) return;
    setOpening(`Opening ${list.length.toLocaleString()} file${list.length === 1 ? "" : "s"}…`);
    try {
      const prepared = await prepareFiles(list, (done, total) => { if (total > 20 && done % 10 === 0) setOpening(`Opening files ${done.toLocaleString()} of ${total.toLocaleString()}…`); });
      // Files already in this window aren't added again.
      const have = new Set(files.flatMap((f) => (f.kind === "error" || f.kind === "note" ? [] : [f.sha256])));
      const fresh = prepared.filter((f) => f.kind === "error" || f.kind === "note" || !have.has(f.sha256));
      const hashes = fresh.flatMap((f) => (f.kind === "error" || f.kind === "note" ? [] : [f.sha256]));
      const known: Awaited<ReturnType<typeof utils.masterBilling.checkFiles.fetch>> = [];
      for (let i = 0; i < hashes.length; i += 200) {
        setOpening(`Checking which files are already uploaded…`);
        known.push(...(await utils.masterBilling.checkFiles.fetch({ hashes: hashes.slice(i, i + 200) })));
      }
      const next: Record<string, FileState> = {};
      for (const f of fresh) {
        if (f.kind === "error" || f.kind === "note") continue;
        const k = known.find((x) => x.sha256 === f.sha256);
        next[f.id] = k ? { s: "duplicate", when: `${k.fileName}, ${new Date(k.createdAt).toLocaleDateString("en-US")}` } : { s: "ready" };
      }
      setFiles((old) => [...old, ...fresh]);
      setState((m) => ({ ...m, ...next }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setOpening(null);
    }
  }

  /** Start the upload and send the original file to private storage. */
  async function begin(f: RealFile, checks: Parameters<typeof start.mutateAsync>[0]["checks"]) {
    const r = await start.mutateAsync({ kind: f.kind, fileName: f.name, sha256: f.sha256, size: f.size, contentType: f.contentType, checks });
    if (r.upload.url) {
      const ok = await fetch(r.upload.url, { method: "PUT", body: f.bytes as BodyInit, headers: { "Content-Type": f.contentType } }).then((x) => x.ok, () => false);
      // A PDF must be stored (the AI reads it from there); a payment file or spreadsheet is already read, so it can go on without its copy.
      if (!ok && f.kind === "pdf") {
        await cancel.mutateAsync({ importId: r.importId }).catch(() => undefined);
        throw new Error("The PDF couldn't be stored. Please try again.");
      }
    } else if (f.size <= 8 * 1024 * 1024) {
      await uploadLocal.mutateAsync({ importId: r.importId, base64: toBase64(f.bytes) });
    }
    return r.importId;
  }

  /** Send the claims a chunk at a time, then let the server join and match them. */
  async function store(id: string, importId: number, events: BillEventInput[]) {
    for (let i = 0; i < events.length; i += 200) {
      set(id, { s: "saving", step: `Saving claims ${Math.min(i + 200, events.length).toLocaleString()} of ${events.length.toLocaleString()}…` });
      await addEvents.mutateAsync({ importId, events: events.slice(i, i + 200) });
    }
    let cursor = 0;
    for (;;) {
      const r = await finish.mutateAsync({ importId, cursor });
      if (r.done) return r;
      cursor = r.next;
      set(id, { s: "saving", step: `Matching patients ${cursor.toLocaleString()} of ${r.total.toLocaleString()}…` });
    }
  }

  /** Save one file; true when it worked. `quiet` = part of Save all (the page refreshes once at the end). */
  async function saveFile(f: PreparedFile, events: BillEventInput[], extra?: () => Promise<void>, quiet = false): Promise<boolean> {
    if (f.kind === "error" || f.kind === "note") return false;
    if (!events.length) { set(f.id, { s: "failed", message: "No claims to save." }); return false; }
    set(f.id, { s: "saving", step: "Uploading the file…" });
    try {
      const importId = await begin(f, f.kind === "era835" ? f.checks : null);
      const r = await store(f.id, importId, events);
      await extra?.();
      set(f.id, { s: "saved", claims: r.claims, matched: r.matched });
      if (!quiet) void utils.masterBilling.invalidate();
      return true;
    } catch (e) {
      const message = (e as Error).message;
      // Saved by an earlier, interrupted Save all: nothing to do.
      if (/already uploaded/i.test(message)) { set(f.id, { s: "duplicate", when: "earlier" }); return true; }
      set(f.id, { s: "failed", message });
      return false;
    }
  }

  const era = files.filter((f): f is Extract<PreparedFile, { kind: "era835" }> => f.kind === "era835");
  const ready835 = era.filter((f) => state[f.id]?.s === "ready" || state[f.id]?.s === "failed");
  /** Save every ready payment file, one after another (the same claim in two files is never worked on at once). */
  async function saveAll835() {
    const list = ready835.slice();
    let failed = 0;
    setBulk({ done: 0, total: list.length, failed: 0 });
    for (let i = 0; i < list.length; i++) {
      if (!(await saveFile(list[i]!, list[i]!.events, undefined, true))) failed++;
      setBulk({ done: i + 1, total: list.length, failed });
    }
    setBulk(null);
    void utils.masterBilling.invalidate();
    if (failed) toast.error(`${failed} file${failed === 1 ? "" : "s"} didn't save. Press Save all again to retry them.`);
    else toast.success(`Saved ${list.length.toLocaleString()} payment file${list.length === 1 ? "" : "s"}.`);
  }
  // Many payment files: one summary instead of a box per file (problems are still listed).
  const many = era.length > 6;
  const needsLook = (f: PreparedFile) => f.kind !== "era835" || f.warnings.length > 0 || f.checks.some((c) => !c.balanced) || state[f.id]?.s === "failed";
  const shown = many && !showAll ? files.filter(needsLook) : files;
  const st = (s: FileState["s"]) => era.filter((f) => state[f.id]?.s === s).length;
  const readyEvents = ready835.flatMap((f) => f.events);

  const remove = (id: string) => { setFiles((x) => x.filter((f) => f.id !== id)); setState((m) => { const n = { ...m }; delete n[id]; return n; }); };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload bills</DialogTitle>
          <DialogDescription>
            Office Ally's ERA / 835 zip is best (exact numbers, no AI). Claim reports (CSV or Excel) and PDF EOBs work too. Nothing is saved until you press Save.
          </DialogDescription>
        </DialogHeader>

        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void pick(Array.from(e.dataTransfer.files)); }}
          className={cn("flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center", drag ? "border-blue-400 bg-blue-50 dark:bg-blue-950/30" : "border-slate-200 dark:border-slate-600")}
        >
          <FileUp className="text-slate-400" size={26} />
          <p className="text-sm text-slate-600 dark:text-slate-300">Drop files here, or</p>
          <Btn variant="secondary" size="sm" onClick={() => inputRef.current?.click()} disabled={!!opening || busy}>
            {opening ? <Loader2 size={14} className="animate-spin" /> : null} Choose files
          </Btn>
          <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { void pick(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <p className="text-xs text-slate-400">{opening ?? "Pick as many files as you like at once (Ctrl+A in the folder): .zip, .835 / ERA, .csv, .xlsx, .pdf · up to 25 MB each"}</p>
        </div>

        {(ready835.length > 1 || bulk || many) && (
          <div className="rounded-lg bg-slate-50 px-3 py-3 text-sm dark:bg-slate-800/60">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium text-slate-800 dark:text-slate-100">{era.length.toLocaleString()} payment file{era.length === 1 ? "" : "s"}</p>
                <p className="text-xs text-slate-500">
                  {[ready835.length ? `${ready835.length.toLocaleString()} to save (${readyEvents.length.toLocaleString()} claims, insurance paid ${money(sum(readyEvents.map((e) => e.paidCents)))})` : null,
                    st("saved") ? `${st("saved").toLocaleString()} saved` : null,
                    st("duplicate") ? `${st("duplicate").toLocaleString()} already uploaded` : null,
                    era.filter((f) => f.checks.some((c) => !c.balanced)).length ? `${era.filter((f) => f.checks.some((c) => !c.balanced)).length} don't add up to their check (listed below)` : null,
                  ].filter(Boolean).join(" · ")}
                </p>
              </div>
              {ready835.length > 0 && !bulk && <Btn size="sm" onClick={() => void saveAll835()} disabled={busy}>Save all {ready835.length.toLocaleString()}</Btn>}
            </div>
            {bulk && (
              <div className="mt-2">
                <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" role="progressbar" aria-valuemin={0} aria-valuemax={bulk.total} aria-valuenow={bulk.done}>
                  <div className="h-full bg-blue-600 transition-all dark:bg-blue-400" style={{ width: `${(bulk.done / Math.max(1, bulk.total)) * 100}%` }} />
                </div>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                  Saving file {Math.min(bulk.done + 1, bulk.total).toLocaleString()} of {bulk.total.toLocaleString()}{bulk.failed ? ` · ${bulk.failed} didn't save` : ""}. Keep this window open. If it stops, pick the same files again: the ones already saved are skipped.
                </p>
              </div>
            )}
            {many && <button type="button" className="mt-2 text-xs font-medium text-blue-700 hover:underline dark:text-blue-300" onClick={() => setShowAll((x) => !x)}>{showAll ? "Show only files that need a look" : `Show every file (${files.length.toLocaleString()})`}</button>}
          </div>
        )}

        <div className="space-y-3">
          {shown.map((f) => (
            <FileCard key={f.id} f={f} st={state[f.id]} busy={busy} onRemove={() => remove(f.id)}
              onSave={(events, after) => saveFile(f, events, after)}
              begin={begin} cancel={(importId) => cancel.mutateAsync({ importId })}
              store={store} setState={(s) => set(f.id, s)} saveMap={(signature, mapping) => saveMap.mutateAsync({ signature, mapping }).then(() => undefined)} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface CardProps {
  f: PreparedFile;
  st: FileState | undefined;
  busy: boolean;
  onRemove: () => void;
  onSave: (events: BillEventInput[], after?: () => Promise<void>) => Promise<unknown>;
  begin: (f: RealFile, checks: null) => Promise<number>;
  cancel: (importId: number) => Promise<unknown>;
  store: (id: string, importId: number, events: BillEventInput[]) => Promise<{ claims: number; matched: number }>;
  setState: (s: FileState) => void;
  saveMap: (signature: string, mapping: Record<string, number>) => Promise<void>;
}

function StatusLine({ st }: { st: FileState | undefined }) {
  if (!st) return null;
  if (st.s === "duplicate") return <p className="flex items-center gap-1.5 text-xs text-slate-500"><CheckCircle2 size={13} /> Already uploaded ({st.when}). It won't be saved twice.</p>;
  if (st.s === "saving") return <p className="flex items-center gap-1.5 text-xs text-blue-700 dark:text-blue-300"><Loader2 size={13} className="animate-spin" /> {st.step}</p>;
  if (st.s === "saved") return <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={13} /> Saved: {st.claims.toLocaleString()} claim{st.claims === 1 ? "" : "s"}, {st.matched.toLocaleString()} matched to a patient.</p>;
  if (st.s === "failed") return <p className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-300"><XCircle size={13} /> {st.message}</p>;
  return null;
}

function FileCard(p: CardProps) {
  const { f, st } = p;
  const done = st?.s === "saved" || st?.s === "duplicate";
  const head = (icon: React.ReactNode, kind: string) => (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 truncate font-medium text-slate-800 dark:text-slate-100">{icon}<span className="truncate">{f.name}</span></p>
        <p className="text-xs text-slate-400">{kind}</p>
      </div>
      {!done && st?.s !== "saving" && <button type="button" onClick={p.onRemove} className="text-slate-400 hover:text-slate-600" aria-label="Leave this file out"><Trash2 size={15} /></button>}
    </div>
  );
  const box = "rounded-xl border border-slate-200 p-3 dark:border-slate-700";

  if (f.kind === "note") {
    return <div className={box}><p className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200"><CheckCircle2 size={15} className="text-slate-400" /> {f.name}</p><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{f.message}</p></div>;
  }
  if (f.kind === "error") {
    return <div className={cn(box, "bg-amber-50/60 dark:bg-amber-950/20")}><p className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200"><AlertTriangle size={15} className="text-amber-600" /> {f.name}</p><p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{f.message}</p></div>;
  }
  if (f.kind === "era835") {
    // Take-backs (reversals) repeat an old claim's charge as a negative: billed counts new charges only.
    const billed = sum(f.events.filter((e) => e.clpStatus !== "22").map((e) => e.billedCents));
    const paid = sum(f.events.map((e) => e.paidCents));
    const takeBacks = f.events.filter((e) => e.clpStatus === "22").length;
    return (
      <div className={box}>
        {head(<FileText size={15} className="text-blue-600" />, "Payment file (835)")}
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-400"><tr><th className="py-1 text-left font-medium">Insurance</th><th className="text-left font-medium">Check / EFT</th><th className="text-left font-medium">Date</th><th className="text-right font-medium">Claims</th><th className="text-right font-medium">Check amount</th><th className="text-right font-medium">Adds up?</th></tr></thead>
            <tbody>
              {f.checks.map((c, i) => (
                <tr key={i} className="border-t border-slate-100 dark:border-slate-700/60">
                  <td className="py-1">{c.payerName ?? "—"}</td><td>{c.checkNumber ?? "—"}</td><td>{day(c.paymentDate)}</td>
                  <td className="text-right">{c.claims}</td><td className="text-right">{money(c.amountCents)}</td>
                  <td className="text-right">{c.balanced ? <span className="text-emerald-700 dark:text-emerald-300">Yes</span> : <span className="text-amber-700 dark:text-amber-300">Off by {money(c.balanceDiffCents)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{f.events.length.toLocaleString()} claims · billed {money(billed)} · insurance paid {money(paid)}{takeBacks ? ` (after ${takeBacks} take-back${takeBacks === 1 ? "" : "s"})` : ""}</p>
        {f.checks.some((c) => c.adjustments.length) && <p className="text-xs text-slate-500">Check-level adjustments (interest, take-backs from older claims): {f.checks.flatMap((c) => c.adjustments).map((a) => `${a.code} ${money(a.cents)}`).join(", ")}</p>}
        {f.warnings.map((w) => <p key={w} className="text-xs text-amber-700">{w}</p>)}
        <div className="mt-2 flex items-center justify-between gap-3">
          <StatusLine st={st} />
          {st?.s === "ready" || st?.s === "failed" ? <Btn size="sm" onClick={() => void p.onSave(f.events)} disabled={p.busy}>Save</Btn> : null}
        </div>
      </div>
    );
  }
  if (f.kind === "sheet") return <SheetCard {...p} f={f} />;
  return <PdfCard {...p} f={f} />;
}

// ---- Spreadsheets: pick the columns ----

function SheetCard(p: CardProps & { f: Extract<PreparedFile, { kind: "sheet" }> }) {
  const { f, st } = p;
  const saved = trpc.masterBilling.sheetMapping.useQuery({ signature: f.signature }, { staleTime: Infinity });
  const detected = useMemo(() => detectSheetMapping(f.rows), [f.rows]);
  const [override, setOverride] = useState<SheetMapping | null>(null);
  useEffect(() => { if (saved.data && !override) setOverride(saved.data as SheetMapping); }, [saved.data, override]);
  const mapping = override ?? detected.mapping;
  const parsed = useMemo(() => parseBillSheet(f.rows, override ?? undefined), [f.rows, override]);
  const [showCols, setShowCols] = useState(false);
  const headers = parsed.headers;
  const events = parsed.events;
  const billed = sum(events.map((e) => e.billedCents));
  const paid = sum(events.map((e) => e.paidCents));
  const choose = (field: SheetField, col: number) => setOverride({ ...mapping, [field]: col });
  const missing = !(mapping.patientName != null || mapping.lastName != null || mapping.claimNo != null) || !(mapping.billed != null || mapping.paid != null);
  const canSave = (st?.s === "ready" || st?.s === "failed") && events.length > 0 && !missing;

  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate font-medium text-slate-800 dark:text-slate-100"><FileSpreadsheet size={15} className="text-emerald-600" /><span className="truncate">{f.name}</span></p>
          <p className="text-xs text-slate-400">Spreadsheet · {parsed.rowsRead.toLocaleString()} rows → {events.length.toLocaleString()} claims · billed {money(billed)} · paid {money(paid)}{saved.data ? " · your saved columns" : ""}</p>
        </div>
        {st?.s !== "saved" && st?.s !== "saving" && <button type="button" onClick={p.onRemove} className="text-slate-400 hover:text-slate-600" aria-label="Leave this file out"><Trash2 size={15} /></button>}
      </div>
      {missing && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Pick at least a patient name (or claim number) column and a billed or paid column.</p>}
      <button type="button" className="mt-2 text-xs font-medium text-blue-700 hover:underline dark:text-blue-300" onClick={() => setShowCols((x) => !x)}>{showCols ? "Hide columns" : "Check the columns"}</button>
      {showCols && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {SHEET_FIELD_KEYS.map((k) => (
            <label key={k} className="text-xs text-slate-500">
              {SHEET_FIELDS[k]}
              <SelectBox value={String(mapping[k] ?? -1)} onChange={(v) => choose(k, Number(v))} className="mt-0.5 w-full" ariaLabel={SHEET_FIELDS[k]}>
                <option value="-1">— not in this file —</option>
                {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
              </SelectBox>
            </label>
          ))}
        </div>
      )}
      {events.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-400"><tr><th className="py-1 text-left font-medium">Patient</th><th className="text-left font-medium">Claim #</th><th className="text-left font-medium">Date of service</th><th className="text-left font-medium">CPT</th><th className="text-left font-medium">Insurance</th><th className="text-right font-medium">Billed</th><th className="text-right font-medium">Paid</th><th className="text-left font-medium pl-2">Status</th></tr></thead>
            <tbody>
              {events.slice(0, 5).map((e, i) => (
                <tr key={i} className="border-t border-slate-100 dark:border-slate-700/60">
                  <td className="py-1">{niceName(e.patientName) || "—"}</td><td>{e.claimNo ?? "—"}</td><td>{day(e.serviceFrom)}</td>
                  <td>{e.lines.map((l) => l.code).join(", ") || "—"}</td><td>{e.payerName ?? "—"}</td>
                  <td className="text-right">{money(e.billedCents)}</td><td className="text-right">{money(e.paidCents)}</td>
                  <td className="pl-2">{e.sheetStatus ? BILL_STATUS_LABELS[e.sheetStatus] : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.length > 5 && <p className="mt-1 text-xs text-slate-400">…and {(events.length - 5).toLocaleString()} more</p>}
        </div>
      )}
      {parsed.skipped.length > 0 && <p className="mt-1 text-xs text-slate-500">{parsed.skipped.length} row{parsed.skipped.length === 1 ? "" : "s"} skipped (no patient name or claim number).</p>}
      <div className="mt-2 flex items-center justify-between gap-3">
        <StatusLine st={st} />
        {canSave && <Btn size="sm" disabled={p.busy} onClick={() => void p.onSave(events, () => p.saveMap(f.signature, Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, v ?? -1]))))}>Save</Btn>}
      </div>
    </div>
  );
}

// ---- PDFs: the AI reads them, the owner checks ----

function PdfCard(p: CardProps & { f: Extract<PreparedFile, { kind: "pdf" }> }) {
  const { f, st } = p;
  const info = trpc.masterBilling.pdfInfo.useMutation();
  const read = trpc.masterBilling.pdfRead.useMutation();
  const [importId, setImportId] = useState<number | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [claims, setClaims] = useState<(PdfReadClaim & { keep: boolean })[] | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function readIt() {
    setError(null);
    setProgress("Uploading the PDF…");
    try {
      const id = importId ?? (await p.begin(f, null));
      setImportId(id);
      const meta = await info.mutateAsync({ importId: id });
      const all: PdfReadClaim[] = [];
      for (let from = 0; from < meta.pages; from += meta.perRead) {
        setProgress(`Reading pages ${from + 1}–${Math.min(meta.pages, from + meta.perRead)} of ${meta.pages}…`);
        const r = await read.mutateAsync({ importId: id, from });
        all.push(...r.claims);
      }
      // A claim printed across two page groups can be read twice: keep one copy of identical readings.
      const seen = new Set<string>();
      const unique = all.filter((c) => {
        const e = c.event;
        const k = JSON.stringify([e.claimNo, e.payerClaimNo, e.patientName, e.checkNumber, e.paidCents, e.billedCents, e.lines.map((l) => [l.code, l.serviceDate, l.billedCents, l.paidCents])]);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      setClaims(unique.map((c) => ({ ...c, keep: true })));
      setProgress(null);
    } catch (e) {
      setProgress(null);
      setError((e as Error).message);
    }
  }

  async function discard() {
    if (importId) await p.cancel(importId).catch(() => undefined);
    p.onRemove();
  }

  async function save() {
    if (!importId || !claims) return;
    const events = claims.filter((c) => c.keep).map((c) => c.event);
    if (!events.length) return;
    try {
      const r = await p.store(f.id, importId, events);
      p.setState({ s: "saved", claims: r.claims, matched: r.matched });
    } catch (e) {
      p.setState({ s: "failed", message: (e as Error).message });
    }
  }

  const edit = (i: number, patch: (e: BillEventInput) => BillEventInput) => setClaims((cs) => cs!.map((c, j) => (j === i ? { ...c, event: patch(c.event) } : c)));
  const dollars = (c: number) => (c / 100).toFixed(2);
  const toCents = (v: string) => Math.round((Number(v.replace(/[$,\s]/g, "")) || 0) * 100);
  const cell = "h-7 rounded border border-slate-200 bg-white px-1.5 text-xs dark:border-slate-600 dark:bg-slate-800";

  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate font-medium text-slate-800 dark:text-slate-100"><FileText size={15} className="text-violet-600" /><span className="truncate">{f.name}</span></p>
          <p className="text-xs text-slate-400">PDF EOB · read by AI, then you check every row</p>
        </div>
        {st?.s !== "saved" && st?.s !== "saving" && st?.s !== "duplicate" && <button type="button" onClick={() => void discard()} className="text-slate-400 hover:text-slate-600" aria-label="Leave this file out"><Trash2 size={15} /></button>}
      </div>
      {st?.s === "ready" && !claims && (
        <div className="mt-2 flex items-center gap-3">
          <Btn size="sm" variant="secondary" onClick={() => void readIt()} disabled={!!progress || p.busy}>{progress ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Read with AI</Btn>
          {progress && <span className="text-xs text-slate-500">{progress}</span>}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
      {claims && st?.s !== "saved" && (
        <>
          {claims.length === 0 && <p className="mt-2 text-sm text-slate-500">No payment details were found in this PDF.</p>}
          <div className="mt-2 space-y-2">
            {claims.map((c, i) => (
              <div key={i} className={cn("rounded-lg border p-2", c.keep ? "border-slate-200 dark:border-slate-700" : "border-dashed border-slate-200 opacity-50 dark:border-slate-700")}>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <input className={cn(cell, "w-44")} value={c.event.patientName ?? ""} onChange={(e) => edit(i, (x) => ({ ...x, patientName: e.target.value || null }))} aria-label="Patient name" placeholder="Patient name" />
                  <input className={cn(cell, "w-32")} value={c.event.claimNo ?? ""} onChange={(e) => edit(i, (x) => ({ ...x, claimNo: e.target.value || null }))} aria-label="Account number" placeholder="Account #" />
                  <span className="text-slate-500">{c.event.payerName ?? "—"} · check {c.event.checkNumber ?? "—"} · {day(c.event.paidDate)}</span>
                  <label className="ml-auto flex items-center gap-1 text-slate-500"><input type="checkbox" checked={c.keep} onChange={(e) => setClaims((cs) => cs!.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))} /> Save this claim</label>
                </div>
                <table className="mt-1 w-full text-xs">
                  <thead className="text-slate-400"><tr><th className="text-left font-medium">Date</th><th className="text-left font-medium">CPT</th><th className="text-right font-medium">Billed</th><th className="text-right font-medium">Paid</th><th className="text-left font-medium pl-2">Adjustments</th></tr></thead>
                  <tbody>
                    {c.event.lines.map((l, li) => (
                      <tr key={li}>
                        <td><input type="date" className={cn(cell, "w-36")} value={l.serviceDate ?? ""} onChange={(e) => edit(i, (x) => ({ ...x, lines: x.lines.map((y, k) => (k === li ? { ...y, serviceDate: e.target.value || null } : y)) }))} aria-label="Date of service" /></td>
                        <td><input className={cn(cell, "w-20")} value={l.code} onChange={(e) => edit(i, (x) => ({ ...x, lines: x.lines.map((y, k) => (k === li ? { ...y, code: e.target.value.toUpperCase().slice(0, 10) } : y)) }))} aria-label="CPT code" /></td>
                        <td className="text-right"><input className={cn(cell, "w-20 text-right")} defaultValue={dollars(l.billedCents)} onBlur={(e) => edit(i, (x) => { const lines = x.lines.map((y, k) => (k === li ? { ...y, billedCents: toCents(e.target.value) } : y)); return { ...x, lines, billedCents: sum(lines.map((y) => y.billedCents)) }; })} aria-label="Billed" /></td>
                        <td className="text-right"><input className={cn(cell, "w-20 text-right")} defaultValue={dollars(l.paidCents)} onBlur={(e) => edit(i, (x) => { const lines = x.lines.map((y, k) => (k === li ? { ...y, paidCents: toCents(e.target.value) } : y)); return { ...x, lines, paidCents: sum(lines.map((y) => y.paidCents)) }; })} aria-label="Paid" /></td>
                        <td className="pl-2 text-slate-500">{l.adjustments.map((a) => `${a.group}${a.code ? `-${a.code}` : ""} ${money(a.cents)}`).join(", ") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {c.warnings.map((w) => <p key={w} className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle size={12} /> {w}</p>)}
              </div>
            ))}
          </div>
          {claims.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I checked these against the PDF</label>
              <div className="flex gap-2">
                <Btn size="sm" variant="ghost" onClick={() => void discard()}>Don't save</Btn>
                <Btn size="sm" disabled={!checked || p.busy || !claims.some((c) => c.keep)} onClick={() => void save()}>Save {claims.filter((c) => c.keep).length} claim{claims.filter((c) => c.keep).length === 1 ? "" : "s"}</Btn>
              </div>
            </div>
          )}
        </>
      )}
      <div className="mt-2"><StatusLine st={st} /></div>
    </div>
  );
}
