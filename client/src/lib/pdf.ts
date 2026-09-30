// pdf.js (draws PDF pages into canvases). Only the Documents editor imports this, so its size stays out of
// the rest of the app.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDoc = pdfjs.PDFDocumentProxy;
export type PageViewport = ReturnType<pdfjs.PDFPageProxy["getViewport"]>;

/** Open a PDF from a signed link (S3) or from bytes sent by the API (local development). */
export async function openPdf(src: { url: string | null; base64: string | null }): Promise<PdfDoc> {
  if (src.base64) {
    const bin = atob(src.base64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    return pdfjs.getDocument({ data }).promise;
  }
  return pdfjs.getDocument({ url: src.url! }).promise;
}
