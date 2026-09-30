// Saving a PDF the API handed back (a signed S3 link, or bytes in local development).

/** Save the finished PDF: a signed link downloads directly; bytes become a file download. */
export function downloadPdf(src: { url: string | null; base64: string | null }, fileName: string) {
  if (src.url) { window.location.href = src.url; return; }
  const bin = atob(src.base64 ?? "");
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
