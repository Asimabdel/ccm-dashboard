import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FileUp, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, inputCls } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { MAX_PATIENT_FILE_BYTES, PATIENT_FILE_MIME, PATIENT_FILE_TYPES, PATIENT_FILE_TYPE_LIST, type PatientFileType } from "@shared/folder";

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read the file."));
    r.readAsDataURL(file);
  });
}

const labelCls = "block text-xs font-semibold text-slate-600 dark:text-slate-300";

/** Put a scan, photo or outside record into a patient's folder. */
export function UploadFileDialog({ open, subjectKey, name, onClose }: { open: boolean; subjectKey: string; name: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileType, setFileType] = useState<PatientFileType>("outside_records");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const start = trpc.workspace.folder.startUpload.useMutation();
  const local = trpc.workspace.folder.uploadLocal.useMutation();
  const finish = trpc.workspace.folder.finishUpload.useMutation();

  useEffect(() => { if (open) { setFile(null); setFileType("outside_records"); setTitle(""); setNote(""); } }, [open]);

  const pick = (f: File | null | undefined) => {
    if (!f) return;
    if (!(PATIENT_FILE_MIME as readonly string[]).includes(f.type)) { toast.error("Add a PDF, JPG or PNG. (On an iPhone, photos are sent as JPG.)"); return; }
    if (f.size > MAX_PATIENT_FILE_BYTES) { toast.error("Files can be up to 25 MB."); return; }
    setFile(f);
    setTitle((t) => t || f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim());
  };

  const save = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const s = await start.mutateAsync({ subjectKey, fileName: file.name, mimeType: file.type, size: file.size, fileType, title: title.trim() || PATIENT_FILE_TYPES[fileType], note: note.trim() || null });
      if (s.upload.url) {
        const r = await fetch(s.upload.url, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
        if (!r.ok) throw new Error(`Upload failed (${r.status}).`);
      } else {
        await local.mutateAsync({ id: s.id, base64: await toBase64(file) });
      }
      await finish.mutateAsync({ id: s.id });
      void utils.workspace.folder.invalidate();
      toast.success(`Added to ${name}'s folder.`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a file to {name}'s folder</DialogTitle>
          <DialogDescription>A PDF or photo (JPG / PNG), up to 25 MB. It's stored encrypted, and every time it's opened is logged.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}
            className={cn("flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center", file ? "border-teal-300 bg-teal-50 dark:border-teal-800 dark:bg-teal-950/30" : "border-slate-200 hover:border-slate-300 dark:border-slate-600")}
          >
            <FileUp size={22} className="text-slate-400" />
            {file ? <span className="font-medium text-slate-800 dark:text-slate-100">{file.name} <span className="text-slate-500">({(file.size / 1024 / 1024).toFixed(1)} MB)</span></span>
              : <span className="text-slate-600 dark:text-slate-300">Choose a file, or drop it here</span>}
          </button>
          <label className={labelCls}>What is it?
            <select className={cn(inputCls, "mt-1")} value={fileType} onChange={(e) => setFileType(e.target.value as PatientFileType)}>
              {PATIENT_FILE_TYPE_LIST.map((t) => <option key={t} value={t}>{PATIENT_FILE_TYPES[t]}</option>)}
            </select>
          </label>
          <label className={labelCls}>Title
            <input className={cn(inputCls, "mt-1")} value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} placeholder={PATIENT_FILE_TYPES[fileType]} />
          </label>
          <label className={labelCls}>Note <span className="font-normal text-slate-400">(optional)</span>
            <input className={cn(inputCls, "mt-1")} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Records from Dr. Example, 2019–2024" />
          </label>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" disabled={busy} onClick={onClose}>Cancel</Btn>
            <Btn disabled={!file || busy} onClick={save}>{busy ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />} Add to folder</Btn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
