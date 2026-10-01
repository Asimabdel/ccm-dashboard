// Where Practice Fusion export files wait between download and loading.
//
// On AWS: ccm-app has no internet access, and export files can be far bigger than a relay reply,
// so the relay Lambda (outside the VPC) streams each file straight into a private, encrypted S3
// bucket (PF_EXPORT_BUCKET), and ccm-app reads it back in chunks through the VPC's S3 endpoint.
// Files are deleted as soon as they're loaded (and the bucket expires anything left after 3 days).
// Locally (dev/tests) files go to a temp folder.
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELAY_FUNCTION = "ccm-ringcentral-relay";
const onAws = () => !!process.env.AWS_LAMBDA_FUNCTION_NAME && !!process.env.PF_EXPORT_BUCKET;
const localDir = join(tmpdir(), "mypcp-pf-exports");
const localPath = (key: string) => join(localDir, key.replace(/[^a-zA-Z0-9._-]/g, "_"));

let s3: import("@aws-sdk/client-s3").S3Client | null = null;
async function s3Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  s3 ??= new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
  return s3;
}

/** Start downloading `url` into the store under `key`. On AWS this returns right away (the relay works in the background). */
export async function startDownload(url: string, headers: Record<string, string>, key: string) {
  if (onAws()) {
    const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
    await new LambdaClient({ region: process.env.AWS_REGION ?? "us-east-1" }).send(new InvokeCommand({
      FunctionName: RELAY_FUNCTION,
      InvocationType: "Event",
      Payload: new TextEncoder().encode(JSON.stringify({ mode: "download", url, headers, key })),
    }));
    return;
  }
  await mkdir(localDir, { recursive: true });
  const res = await fetch(url, { headers });
  if (!res.ok) { await writeFile(`${localPath(key)}.error`, `Download failed (${res.status})`); return; }
  await writeFile(localPath(key), Buffer.from(await res.arrayBuffer()));
}

/** Has the download finished (or failed)? */
export async function downloadStatus(key: string): Promise<{ ready: boolean; size: number; error: string | null }> {
  if (onAws()) {
    const { HeadObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await s3Client();
    try {
      const h = await c.send(new HeadObjectCommand({ Bucket: process.env.PF_EXPORT_BUCKET!, Key: key }));
      return { ready: true, size: Number(h.ContentLength ?? 0), error: null };
    } catch { /* not there yet */ }
    try {
      const e = await c.send(new GetObjectCommand({ Bucket: process.env.PF_EXPORT_BUCKET!, Key: `${key}.error` }));
      return { ready: false, size: 0, error: (await e.Body?.transformToString())?.slice(0, 300) ?? "Download failed" };
    } catch { return { ready: false, size: 0, error: null }; }
  }
  try { return { ready: true, size: (await stat(localPath(key))).size, error: null }; } catch { /* not there */ }
  try { return { ready: false, size: 0, error: await readFile(`${localPath(key)}.error`, "utf8") }; } catch { return { ready: false, size: 0, error: null }; }
}

/** Read `length` bytes starting at `offset`. */
export async function readChunk(key: string, offset: number, length: number): Promise<Buffer> {
  if (onAws()) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const r = await (await s3Client()).send(new GetObjectCommand({ Bucket: process.env.PF_EXPORT_BUCKET!, Key: key, Range: `bytes=${offset}-${offset + length - 1}` }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  const fh = await open(localPath(key), "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

/** Forget an earlier failed attempt at this file (before trying it again). */
export async function clearError(key: string) {
  if (onAws()) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await s3Client()).send(new DeleteObjectCommand({ Bucket: process.env.PF_EXPORT_BUCKET!, Key: `${key}.error` })).catch(() => {});
    return;
  }
  await rm(`${localPath(key)}.error`, { force: true });
}

export async function removeFile(key: string) {
  if (onAws()) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await s3Client();
    for (const k of [key, `${key}.error`]) await c.send(new DeleteObjectCommand({ Bucket: process.env.PF_EXPORT_BUCKET!, Key: k })).catch(() => {});
    return;
  }
  for (const p of [localPath(key), `${localPath(key)}.error`]) await rm(p, { force: true });
}
