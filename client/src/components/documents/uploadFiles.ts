// Sending files to Documents. A PDF goes as it is; a photo or scan is first shrunk to a sensible size
// and saved as a JPEG (the server then turns it into a page).
import type { trpc } from "@/lib/trpc";

export const DOC_FILE_ACCEPT = "application/pdf,.pdf,image/jpeg,image/png,image/*";
export const isPdfFile = (f: File) => /\.pdf$/i.test(f.name) || f.type === "application/pdf";
export const isImageFile = (f: File) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);
export const isDocFile = (f: File) => isPdfFile(f) || isImageFile(f);
/** "scan 3.JPG" → "scan 3" (for the document's title). */
export const baseName = (name: string) => name.replace(/\.[a-z0-9]{2,5}$/i, "") || name;

const PHOTO_MAX_SIDE = 2200;

/** A photo made ready to send: at most 2200 px on its long side, JPEG, on white. A PDF is returned unchanged. */
export async function prepareFile(file: File): Promise<Blob> {
  if (isPdfFile(file)) return file;
  if (!isImageFile(file)) throw new Error(`"${file.name}" isn't a PDF or a photo.`);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => rej(new Error(`This browser couldn't open "${file.name}". Try a JPG or PNG photo.`));
      el.src = url;
    });
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    if (!blob) throw new Error(`"${file.name}" couldn't be prepared. Try another photo.`);
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

type Client = ReturnType<typeof trpc.useUtils>["client"];

/** Send a file (an extra PDF, a photo, a page picture) up for a draft document; returns its upload id. */
export async function uploadPart(client: Client, id: number, body: Blob) {
  const s = await client.workspace.documents.addPagesStart.mutate({ id, size: body.size });
  if (s.upload.url) {
    const r = await fetch(s.upload.url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body });
    if (!r.ok) throw new Error(`Upload failed (${r.status}).`);
  } else {
    await client.workspace.documents.addPagesLocal.mutate({ id, part: s.part, base64: await blobToBase64(body) });
  }
  return s.part;
}

/** Add one more file (a PDF's pages, or a photo as one page) to the end of a draft document. */
export async function addPagesFromFile(client: Client, id: number, file: File) {
  const part = await uploadPart(client, id, await prepareFile(file));
  return client.workspace.documents.addPagesFinish.mutate({ id, part, fileName: file.name });
}
