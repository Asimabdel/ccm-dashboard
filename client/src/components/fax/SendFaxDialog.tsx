import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, BookUser, FileText, FolderOpen, Loader2, Paperclip, Printer, Search, Send, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, fmtShortDate, inputCls } from "@/components/workspace/ui";
import { PatientSearchBox } from "@/components/messages/PatientSearchBox";
import { trpc } from "@/lib/trpc";
import { FAX_UPLOAD_TYPES, MAX_FAX_BYTES, normalizeFaxNumber, type FaxAttachmentRef } from "@shared/faxSend";
import { formatPhone } from "@shared/phone";
import { cn } from "@/lib/utils";

export interface FaxAttachment { ref: FaxAttachmentRef; name: string; size: number | null; detail?: string }
export interface SendFaxPreset {
  subjectKey?: string | null;
  patientName?: string | null;
  clinicId?: number | null;
  attachments?: FaxAttachment[];
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read that file."));
    r.readAsDataURL(file);
  });
}
const mb = (n: number) => `${(n / 1_000_000).toFixed(n < 100_000 ? 2 : 1)} MB`;
const sameRef = (a: FaxAttachmentRef, b: FaxAttachmentRef) => a.kind === b.kind && (a.kind === "upload" ? a.key === (b as typeof a).key : a.id === (b as { id: number }).id);

/**
 * Send a fax through RingCentral from a clinic's fax number: pick (or type) the recipient, attach files
 * (computer, the patient's folder, signed documents, a fax we received), add a cover note, check, send.
 */
export function SendFaxDialog({ open, onOpenChange, preset }: { open: boolean; onOpenChange: (o: boolean) => void; preset?: SendFaxPreset }) {
  const utils = trpc.useUtils();
  const from = trpc.workspace.faxOut.from.useQuery(undefined, { enabled: open, staleTime: 60_000 });
  const [clinicId, setClinicId] = useState<number | null>(null);
  const [recipient, setRecipient] = useState<{ name: string; number: string; saved: boolean } | null>(null);
  const [newName, setNewName] = useState("");
  const [newNumber, setNewNumber] = useState("");
  const [confirmNumber, setConfirmNumber] = useState("");
  const [saveContact, setSaveContact] = useState(true);
  const [contactQ, setContactQ] = useState("");
  const [patient, setPatient] = useState<{ key: string; name: string } | null>(null);
  const [files, setFiles] = useState<FaxAttachment[]>([]);
  const [note, setNote] = useState("");
  const [picker, setPicker] = useState<"folder" | "docs" | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setRecipient(null); setNewName(""); setNewNumber(""); setConfirmNumber(""); setSaveContact(true); setContactQ("");
    setPatient(preset?.subjectKey ? { key: preset.subjectKey, name: preset.patientName ?? "Patient" } : null);
    setFiles(preset?.attachments ?? []); setNote(""); setPicker(null); setClinicId(preset?.clinicId ?? null);
    // Reset only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const usable = (from.data ?? []).filter((c) => c.allowed);
  // Default: the preset clinic if it can send, else the first clinic that's set up.
  useEffect(() => {
    if (!open || !from.data || (clinicId && usable.some((c) => c.id === clinicId && c.ready))) return;
    setClinicId(usable.find((c) => c.ready)?.id ?? usable[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, from.data]);
  const clinic = usable.find((c) => c.id === clinicId) ?? null;

  const contacts = trpc.workspace.faxOut.contacts.useQuery({ q: contactQ || null }, { enabled: open && !recipient });
  const startUpload = trpc.workspace.faxOut.startUpload.useMutation();
  const uploadLocal = trpc.workspace.faxOut.uploadLocal.useMutation();
  const send = trpc.workspace.faxOut.send.useMutation({
    onSuccess: (r) => {
      toast.success(r.status === "failed" ? "RingCentral couldn't send it." : "Fax sent to RingCentral. It shows as Sent once it goes through (Faxes → Sent).");
      void utils.workspace.faxOut.invalidate();
      void utils.workspace.folder.invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const total = files.reduce((n, f) => n + (f.size ?? 0), 0);
  const typedNumber = normalizeFaxNumber(newNumber);
  const numbersMatch = !!typedNumber && typedNumber === normalizeFaxNumber(confirmNumber);
  const to = recipient ?? (newName.trim() && numbersMatch ? { name: newName.trim(), number: typedNumber!, saved: false } : null);
  const problems = [
    !clinic?.ready && "Pick a clinic whose fax number is set up",
    !to && (recipient ? null : typedNumber && confirmNumber && !numbersMatch ? "The two fax numbers don't match" : "Pick or type who it's going to"),
    !files.length && "Attach at least one file",
    total > MAX_FAX_BYTES && `Too big: ${mb(total)} (up to 4 MB per fax)`,
  ].filter(Boolean) as string[];

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        if (!FAX_UPLOAD_TYPES[file.type]) { toast.error(`${file.name}: attach a PDF, Word file, JPG, PNG or TIFF.`); continue; }
        if (file.size > MAX_FAX_BYTES) { toast.error(`${file.name} is over 4 MB.`); continue; }
        const s = await startUpload.mutateAsync({ fileName: file.name, mimeType: file.type, size: file.size });
        if (s.upload.url) {
          const r = await fetch(s.upload.url, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
          if (!r.ok) throw new Error(`Upload failed (${r.status}).`);
        } else await uploadLocal.mutateAsync({ key: s.key, base64: await toBase64(file) });
        setFiles((x) => [...x, { ref: { kind: "upload", key: s.key, name: file.name, mimeType: file.type }, name: file.name, size: file.size, detail: "From this computer" }]);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const toggleFile = (f: FaxAttachment) => setFiles((x) => (x.some((y) => sameRef(y.ref, f.ref)) ? x.filter((y) => !sameRef(y.ref, f.ref)) : [...x, f]));

  const label = "block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1";
  return (
    <Dialog open={open} onOpenChange={(o) => !send.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Printer size={18} /> Send a fax</DialogTitle>
          <DialogDescription>Sent through RingCentral from the clinic's fax number, with a cover sheet and confidentiality notice.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* From */}
          <div>
            <label className={label}>From</label>
            {from.isLoading ? <p className="text-sm text-slate-400">Loading…</p> : usable.length === 0 ? <p className="text-sm text-slate-500">No clinic you work at can send faxes yet.</p> : (
              <select className={inputCls} value={clinicId ?? ""} onChange={(e) => setClinicId(Number(e.target.value) || null)}>
                {usable.map((c) => <option key={c.id} value={c.id} disabled={!c.ready}>{c.name}{c.fromNumber ? ` · fax ${formatPhone(c.fromNumber)}` : ""}{c.ready ? "" : " (not set up yet)"}</option>)}
              </select>
            )}
            {from.data && !usable.some((c) => c.ready) && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">An admin sets up each clinic's fax number in Admin → Integrations → Sending faxes.</p>}
          </div>

          {/* To */}
          <div>
            <label className={label}>To</label>
            {recipient ? (
              <div className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-600">
                <span><span className="font-semibold">{recipient.name}</span> <span className="text-sm text-slate-500">fax {formatPhone(recipient.number)}</span></span>
                <button onClick={() => setRecipient(null)} aria-label="Change recipient"><X size={15} className="text-slate-400" /></button>
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input className={cn(inputCls, "pl-8")} value={contactQ} onChange={(e) => setContactQ(e.target.value)} placeholder="Search saved contacts" aria-label="Search saved fax contacts" />
                  </div>
                  <div className="mt-1.5 max-h-40 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700">
                    {(contacts.data ?? []).length === 0 && <p className="px-3 py-2 text-xs text-slate-400">{contactQ ? "No saved contact matches." : "No saved contacts yet."}</p>}
                    {(contacts.data ?? []).map((c) => (
                      <button key={c.id} onClick={() => setRecipient({ name: c.name, number: c.faxNumber, saved: true })} className="flex w-full items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-left text-sm last:border-0 hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-700/50">
                        <BookUser size={13} className="shrink-0 text-slate-400" />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        <span className="shrink-0 text-xs text-slate-500">{formatPhone(c.faxNumber)}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2 rounded-xl border border-dashed border-slate-300 p-3 dark:border-slate-600">
                  <p className="text-xs font-semibold text-slate-500">Or a new number</p>
                  <input className={inputCls} value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={160} placeholder="Name (e.g. Houston Cardiology, Dr. Lee)" aria-label="Recipient name" />
                  <input className={inputCls} value={newNumber} onChange={(e) => setNewNumber(e.target.value)} inputMode="tel" placeholder="Fax number" aria-label="Fax number" />
                  <input className={cn(inputCls, typedNumber && confirmNumber && !numbersMatch && "border-rose-400")} value={confirmNumber} onChange={(e) => setConfirmNumber(e.target.value)} onPaste={(e) => e.preventDefault()} inputMode="tel" placeholder="Type the fax number again" aria-label="Confirm fax number" />
                  <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={saveContact} onChange={(e) => setSaveContact(e.target.checked)} /> Save to contacts</label>
                </div>
              </div>
            )}
          </div>

          {/* Patient (optional) */}
          <div>
            <label className={label}>Patient (optional: files it, and lets you attach from their folder)</label>
            {patient ? (
              <div className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-600">
                <span className="font-medium">{patient.name}</span>
                {!preset?.subjectKey && <button onClick={() => { setPatient(null); setFiles((x) => x.filter((f) => f.ref.kind === "upload")); }} aria-label="Remove patient"><X size={15} className="text-slate-400" /></button>}
              </div>
            ) : <PatientSearchBox onPick={setPatient} />}
          </div>

          {/* Files */}
          <div>
            <label className={label}>Files</label>
            {files.length > 0 && (
              <ul className="mb-2 divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
                {files.map((f, i) => (
                  <li key={i} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <FileText size={14} className="shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <span className="shrink-0 text-xs text-slate-400">{[f.detail, f.size ? mb(f.size) : null].filter(Boolean).join(" · ")}</span>
                    <button onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}><Trash2 size={14} className="text-slate-400 hover:text-rose-600" /></button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <input ref={fileInput} type="file" className="hidden" multiple accept={Object.keys(FAX_UPLOAD_TYPES).join(",")} onChange={(e) => void addFiles(e.target.files)} />
              <Btn size="sm" variant="secondary" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} From this computer</Btn>
              <Btn size="sm" variant="secondary" disabled={!patient} title={patient ? undefined : "Pick the patient first"} onClick={() => setPicker(picker === "folder" ? null : "folder")}><FolderOpen size={13} /> From the patient's folder</Btn>
              <Btn size="sm" variant="secondary" onClick={() => setPicker(picker === "docs" ? null : "docs")}><Paperclip size={13} /> Signed document</Btn>
            </div>
            {picker === "folder" && patient && <FolderPicker subjectKey={patient.key} chosen={files} onToggle={toggleFile} />}
            {picker === "docs" && <DocsPicker chosen={files} onToggle={toggleFile} />}
            <p className="mt-1.5 text-[11px] text-slate-500">PDF, Word, JPG, PNG or TIFF · up to 4 MB in one fax{total ? ` · ${mb(total)} attached` : ""}. Files from Practice Fusion: download them there first.</p>
          </div>

          {/* Cover note */}
          <div>
            <label className={label} htmlFor="fax-note">Cover sheet message (optional)</label>
            <textarea id="fax-note" className={cn(inputCls, "min-h-[70px]")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="e.g. Referral for cardiology consult, records attached. Please call with questions." />
            <p className="mt-1 text-[11px] text-slate-500">Keep patient details off the cover sheet; it's the page anyone near the fax machine sees.</p>
          </div>

          {/* Check and send */}
          <div className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
            {to && clinic?.ready ? (
              <p className="flex items-start gap-2"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-600" />
                <span>Fax to <b>{to.name}</b> at <b>{formatPhone(to.number)}</b> from {clinic.name}'s fax line: cover sheet + {files.length} file{files.length === 1 ? "" : "s"}{patient ? `, about ${patient.name}` : ""}.</span>
              </p>
            ) : null}
            {problems.length > 0 && <p className="mt-1 flex items-start gap-2 text-amber-700 dark:text-amber-300"><AlertTriangle size={15} className="mt-0.5 shrink-0" /> {problems.join(" · ")}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Btn variant="secondary" onClick={() => onOpenChange(false)} disabled={send.isPending}>Cancel</Btn>
            <Btn disabled={problems.length > 0 || send.isPending || uploading} onClick={() => to && clinic && send.mutate({
              clinicId: clinic.id, toNumber: to.number, toName: to.name, saveContact: !to.saved && saveContact,
              subjectKey: patient?.key ?? null, coverNote: note.trim() || null, attachments: files.map((f) => f.ref),
            })}>
              {send.isPending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Send fax
            </Btn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PickList({ items, chosen, onToggle, empty }: { items: FaxAttachment[]; chosen: FaxAttachment[]; onToggle: (f: FaxAttachment) => void; empty: string }) {
  return (
    <div className="mt-2 max-h-52 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700">
      {items.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">{empty}</p>}
      {items.map((f, i) => {
        const on = chosen.some((c) => sameRef(c.ref, f.ref));
        return (
          <label key={i} className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-sm last:border-0 hover:bg-slate-50 dark:border-slate-700/60 dark:hover:bg-slate-700/50">
            <input type="checkbox" checked={on} onChange={() => onToggle(f)} />
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="shrink-0 text-xs text-slate-400">{[f.detail, f.size ? mb(f.size) : null].filter(Boolean).join(" · ")}</span>
          </label>
        );
      })}
    </div>
  );
}

function FolderPicker({ subjectKey, chosen, onToggle }: { subjectKey: string; chosen: FaxAttachment[]; onToggle: (f: FaxAttachment) => void }) {
  const q = trpc.workspace.faxOut.attachables.useQuery({ subjectKey });
  const items = useMemo(() => (q.data ?? []).map((a) => ({ ref: a.ref, name: a.name, size: a.size, detail: `${a.detail}${a.at ? ` · ${fmtShortDate(a.at)}` : ""}` })), [q.data]);
  if (q.isLoading) return <p className="mt-2 text-xs text-slate-400">Loading the folder…</p>;
  return <PickList items={items} chosen={chosen} onToggle={onToggle} empty="Nothing in this patient's folder to fax yet." />;
}

function DocsPicker({ chosen, onToggle }: { chosen: FaxAttachment[]; onToggle: (f: FaxAttachment) => void }) {
  const [q, setQ] = useState("");
  const docs = trpc.workspace.faxOut.signedDocs.useQuery({ q: q || null });
  const items = (docs.data ?? []).map((d) => ({ ref: { kind: "document" as const, id: d.id }, name: d.title, size: null, detail: [d.patientName, d.completedAt ? `signed ${fmtShortDate(d.completedAt)}` : null].filter(Boolean).join(" · ") }));
  return (
    <div className="mt-2">
      <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search signed documents" aria-label="Search signed documents" />
      <PickList items={items} chosen={chosen} onToggle={onToggle} empty="No signed documents you can see." />
    </div>
  );
}
