import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FileText, FolderInput, FolderCheck, Loader2, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, inputCls } from "@/components/workspace/ui";
import { FileViewer, type ViewerFile } from "@/components/folder/FileViewer";
import { PatientSearchBox, type PickedPatient } from "@/components/messages/PatientSearchBox";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { CHAT_FILE_MIME, MAX_CHAT_FILES, MAX_CHAT_FILE_BYTES } from "@shared/chat";
import { PATIENT_FILE_TYPES, PATIENT_FILE_TYPE_LIST, type PatientFileType } from "@shared/folder";

export interface SentFile { id: number; name: string; mimeType: string; size: number; savedToFolder: boolean }

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read the file."));
    r.readAsDataURL(file);
  });
}
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const isImage = (mime: string) => mime.startsWith("image/");

interface Pending { localId: string; name: string; size: number; mimeType: string; status: "uploading" | "ready" | "error"; id?: number; error?: string }

/** Files picked in the message box: each uploads right away (straight to storage), then goes with the message. */
export function useChatUploads(conversationId: number) {
  const [items, setItems] = useState<Pending[]>([]);
  const start = trpc.workspace.chat.attachStart.useMutation();
  const local = trpc.workspace.chat.attachLocal.useMutation();
  const finish = trpc.workspace.chat.attachFinish.useMutation();
  useEffect(() => setItems([]), [conversationId]);

  const patch = (localId: string, p: Partial<Pending>) => setItems((xs) => xs.map((x) => (x.localId === localId ? { ...x, ...p } : x)));
  const add = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (items.length + list.length > MAX_CHAT_FILES) { toast.error(`Send up to ${MAX_CHAT_FILES} files at a time.`); return; }
    for (const file of list) {
      if (!(CHAT_FILE_MIME as readonly string[]).includes(file.type)) { toast.error(`${file.name}: send a PDF, JPG or PNG.`); continue; }
      if (file.size > MAX_CHAT_FILE_BYTES) { toast.error(`${file.name}: files can be up to 25 MB.`); continue; }
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setItems((xs) => [...xs, { localId, name: file.name, size: file.size, mimeType: file.type, status: "uploading" }]);
      void (async () => {
        try {
          const s = await start.mutateAsync({ conversationId, fileName: file.name, mimeType: file.type, size: file.size });
          if (s.upload.url) {
            const r = await fetch(s.upload.url, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
            if (!r.ok) throw new Error(`Upload failed (${r.status}).`);
          } else await local.mutateAsync({ id: s.id, base64: await toBase64(file) });
          await finish.mutateAsync({ id: s.id });
          patch(localId, { status: "ready", id: s.id });
        } catch (e) {
          patch(localId, { status: "error", error: (e as Error).message });
          toast.error(`${file.name}: ${(e as Error).message}`);
        }
      })();
    }
  };
  return {
    items,
    add,
    remove: (localId: string) => setItems((xs) => xs.filter((x) => x.localId !== localId)),
    clear: () => setItems([]),
    busy: items.some((x) => x.status === "uploading"),
    readyIds: items.filter((x) => x.status === "ready").map((x) => x.id!),
  };
}

/** The files waiting to go with the message. */
export function PendingFiles({ items, onRemove }: { items: Pending[]; onRemove: (localId: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {items.map((f) => (
        <span key={f.localId} className={cn("inline-flex max-w-[16rem] items-center gap-1.5 rounded-lg border px-2 py-1 text-xs",
          f.status === "error" ? "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200" : "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-600 dark:bg-slate-700/50 dark:text-slate-200")}>
          {f.status === "uploading" ? <Loader2 size={12} className="shrink-0 animate-spin" /> : <FileText size={12} className="shrink-0" />}
          <span className="truncate">{f.name}</span>
          <span className="shrink-0 text-slate-400">{f.status === "error" ? "failed" : fmtSize(f.size)}</span>
          <button onClick={() => onRemove(f.localId)} aria-label={`Remove ${f.name}`} className="shrink-0 text-slate-400 hover:text-slate-700"><X size={12} /></button>
        </span>
      ))}
    </div>
  );
}

/** A photo in a message: a small preview (opening it is logged). */
function Thumb({ file, onOpen }: { file: SentFile; onOpen: () => void }) {
  const q = trpc.workspace.chat.attachment.useQuery({ id: file.id }, { staleTime: 8 * 60_000, refetchOnWindowFocus: false, retry: false });
  const src = q.data ? (q.data.url ?? (q.data.base64 ? `data:${q.data.mimeType};base64,${q.data.base64}` : null)) : null;
  return (
    <button onClick={onOpen} className="block overflow-hidden rounded-xl border border-black/5 bg-slate-100 dark:bg-slate-700" title={file.name}>
      {src ? <img src={src} alt={file.name} className="max-h-56 max-w-[16rem] object-cover" onLoad={() => window.dispatchEvent(new Event("chat:media-loaded"))} />
        : <span className="flex h-24 w-32 items-center justify-center text-slate-400">{q.isError ? <FileText size={18} /> : <Loader2 size={16} className="animate-spin" />}</span>}
    </button>
  );
}

/** Files on a sent message: photos as previews, PDFs as chips; each can be opened or filed in a patient's folder. */
export function MessageFiles({ files, mine, defaultPatient }: { files: SentFile[]; mine: boolean; defaultPatient: PickedPatient | null }) {
  const utils = trpc.useUtils();
  const [viewing, setViewing] = useState<ViewerFile | null>(null);
  const [saving, setSaving] = useState<SentFile | null>(null);
  if (!files.length) return null;
  const open = async (f: SentFile) => {
    try {
      const r = await utils.workspace.chat.attachment.fetch({ id: f.id });
      setViewing({ title: f.name, mimeType: r.mimeType, url: r.url, base64: r.base64 });
    } catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className={cn("mt-1.5 flex flex-wrap gap-1.5", mine && "justify-end")}>
      {files.map((f) => (
        <div key={f.id} className="flex flex-col items-start gap-0.5">
          {isImage(f.mimeType) ? <Thumb file={f} onOpen={() => void open(f)} /> : (
            <button onClick={() => void open(f)} className="inline-flex max-w-[16rem] items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">
              <FileText size={16} className="shrink-0 text-red-500" />
              <span className="min-w-0"><span className="block truncate font-medium">{f.name}</span><span className="text-slate-400">PDF · {fmtSize(f.size)}</span></span>
            </button>
          )}
          {f.savedToFolder ? (
            <span className="inline-flex items-center gap-1 px-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400"><FolderCheck size={11} /> In a patient's folder</span>
          ) : (
            <button onClick={() => setSaving(f)} className="inline-flex items-center gap-1 px-1 text-[10px] font-semibold text-slate-500 hover:text-brand"><FolderInput size={11} /> Save to patient folder</button>
          )}
        </div>
      ))}
      <FileViewer file={viewing} onClose={() => setViewing(null)} />
      <SaveToFolderDialog file={saving} defaultPatient={defaultPatient} onClose={() => setSaving(null)} />
    </div>
  );
}

const labelCls = "block text-xs font-semibold text-slate-600 dark:text-slate-300";

/** File a copy of a sent PDF / photo in a patient's folder. */
function SaveToFolderDialog({ file, defaultPatient, onClose }: { file: SentFile | null; defaultPatient: PickedPatient | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const [fileType, setFileType] = useState<PatientFileType>("other");
  const [title, setTitle] = useState("");
  const save = trpc.workspace.chat.saveToFolder.useMutation({
    onSuccess: () => { toast.success(`Saved to ${patient?.name}'s folder.`); void utils.workspace.chat.get.invalidate(); void utils.workspace.folder.invalidate(); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  useEffect(() => {
    if (!file) return;
    setPatient(defaultPatient);
    setFileType(isImage(file.mimeType) ? "other" : "outside_records");
    setTitle(file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim());
  }, [file, defaultPatient]);
  return (
    <Dialog open={!!file} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save to a patient's folder</DialogTitle>
          <DialogDescription>A copy of {file?.name} goes in the patient's folder (Files), stored encrypted.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div>
            <p className={labelCls}>Patient</p>
            {patient ? (
              <p className="mt-1 flex items-center justify-between rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-600">
                <span className="font-medium text-slate-800 dark:text-slate-100">{patient.name}</span>
                <button className="text-xs font-semibold text-brand hover:underline" onClick={() => setPatient(null)}>Change</button>
              </p>
            ) : <div className="mt-1"><PatientSearchBox autoFocus onPick={setPatient} /></div>}
          </div>
          <label className={labelCls}>What is it?
            <select className={cn(inputCls, "mt-1")} value={fileType} onChange={(e) => setFileType(e.target.value as PatientFileType)}>
              {PATIENT_FILE_TYPE_LIST.map((t) => <option key={t} value={t}>{PATIENT_FILE_TYPES[t]}</option>)}
            </select>
          </label>
          <label className={labelCls}>Title
            <input className={cn(inputCls, "mt-1")} value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} placeholder={PATIENT_FILE_TYPES[fileType]} />
          </label>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" disabled={save.isPending} onClick={onClose}>Cancel</Btn>
            <Btn disabled={!patient || !file || save.isPending} onClick={() => file && patient && save.mutate({ attachmentId: file.id, subjectKey: patient.key, fileType, title: title.trim() || PATIENT_FILE_TYPES[fileType] })}>
              {save.isPending ? <Loader2 size={14} className="animate-spin" /> : <FolderInput size={14} />} Save to folder
            </Btn>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
