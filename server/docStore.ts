// Where Documents keeps its PDFs.
//
// On AWS: a private, encrypted S3 bucket (DOCS_BUCKET). The browser uploads and downloads directly with
// short-lived signed links (so big scans don't hit the Lambda's request-size limit); ccm-app itself
// reads/writes through the VPC's S3 endpoint when it builds the signed PDF.
// Locally (dev/tests): a folder in the temp directory, moved through the API as base64.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
const LINK_SECONDS = 10 * 60;

export const onS3 = () => !!process.env.DOCS_BUCKET;
const bucket = () => process.env.DOCS_BUCKET!;
const localDir = join(tmpdir(), "mypcp-documents");
const localPath = (key: string) => join(localDir, key.replace(/[^a-zA-Z0-9._-]/g, "_"));

let s3: import("@aws-sdk/client-s3").S3Client | null = null;
async function s3Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  s3 ??= new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
  return s3;
}

/** How the browser should send a new PDF: straight to S3 with a signed link, or through the API (local). */
export async function uploadTarget(key: string): Promise<{ url: string | null }> {
  if (!onS3()) return { url: null };
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const url = await getSignedUrl(await s3Client(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: "application/pdf" }), { expiresIn: LINK_SECONDS });
  return { url };
}

/** A short-lived link for the browser to read a PDF (S3), or the bytes themselves (local). */
export async function readTarget(key: string, downloadName?: string | null): Promise<{ url: string | null; base64: string | null }> {
  if (!onS3()) return { url: null, base64: (await getBytes(key)).toString("base64") };
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const disposition = downloadName ? `attachment; filename="${downloadName.replace(/[^\w .()-]/g, "_").slice(0, 120)}"` : undefined;
  const url = await getSignedUrl(await s3Client(), new GetObjectCommand({ Bucket: bucket(), Key: key, ResponseContentDisposition: disposition, ResponseContentType: "application/pdf" }), { expiresIn: LINK_SECONDS });
  return { url, base64: null };
}

export async function getBytes(key: string): Promise<Buffer> {
  if (!onS3()) return readFile(localPath(key));
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const r = await (await s3Client()).send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return Buffer.from(await r.Body!.transformToByteArray());
}

export async function putBytes(key: string, bytes: Uint8Array) {
  if (!onS3()) {
    await mkdir(localDir, { recursive: true });
    await writeFile(localPath(key), bytes);
    return;
  }
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  await (await s3Client()).send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: bytes, ContentType: "application/pdf" }));
}
