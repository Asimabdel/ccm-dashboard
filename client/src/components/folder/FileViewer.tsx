import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Btn, ErrorNote } from "@/components/workspace/ui";

/** Something to show: a signed link or the bytes (PDF / image), or a note's text. */
export interface ViewerFile {
  title: string;
  mimeType: string;
  url?: string | null;
  base64?: string | null;
  /** HTML from Practice Fusion (shown in a sandbox). */
  text?: string | null;
  /** Plain text (shown as is). */
  plain?: string | null;
}

const fromBase64 = (b64: string, type: string) => new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type });

/** A PDF, photo or note from a patient's folder, with a Download button. */
export function FileViewer({ file, onClose }: { file: ViewerFile | null; onClose: () => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBlobUrl(null);
    setError(null);
    if (!file || file.text != null || file.plain != null) return;
    let url: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const blob = file.base64 ? fromBase64(file.base64, file.mimeType) : file.url ? await (await fetch(file.url)).blob() : null;
        if (!blob) throw new Error("Nothing to show.");
        url = URL.createObjectURL(new Blob([blob], { type: file.mimeType }));
        if (!cancelled) setBlobUrl(url);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || "Couldn't open it.");
      }
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [file]);

  const ext = file?.mimeType === "image/png" ? "png" : file?.mimeType === "image/jpeg" ? "jpg" : "pdf";
  const isImage = !!file?.mimeType.startsWith("image/");
  return (
    <Dialog open={!!file} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] w-[95vw] max-w-5xl flex-col gap-3 sm:max-w-5xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="pr-8">{file?.title}</DialogTitle>
          <DialogDescription className="sr-only">A file from the patient's folder</DialogDescription>
        </DialogHeader>
        {error && <ErrorNote message={error} />}
        {file?.plain != null ? (
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 p-4 dark:border-slate-700" style={{ background: "#fff", color: "#111827" }}>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{file.plain}</p>
          </div>
        ) : file?.text != null ? (
          // Notes can be HTML from Practice Fusion: shown in a sandbox, nothing in them runs.
          <iframe title={file.title} sandbox="" srcDoc={`<!doctype html><html><body style="background:#fff;color:#111827;font:14px/1.5 system-ui,sans-serif;margin:16px">${file.text}</body></html>`}
            style={{ background: "#fff" }} className="min-h-0 w-full flex-1 rounded-lg border border-slate-200 dark:border-slate-700" />
        ) : !blobUrl && !error ? (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-400"><Loader2 size={18} className="mr-2 animate-spin" /> Opening…</div>
        ) : blobUrl && isImage ? (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
            <img src={blobUrl} alt={file?.title ?? ""} className="max-h-full max-w-full object-contain" />
          </div>
        ) : blobUrl ? (
          <iframe title={file?.title ?? "File"} src={blobUrl} className="min-h-0 w-full flex-1 rounded-lg border border-slate-200 dark:border-slate-700" />
        ) : null}
        {blobUrl && (
          <div className="flex shrink-0 justify-end">
            <a href={blobUrl} download={`${(file?.title ?? "file").replace(/[^\w .()-]/g, "_").slice(0, 100)}.${ext}`}>
              <Btn variant="secondary" size="sm"><Download size={14} /> Download</Btn>
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
