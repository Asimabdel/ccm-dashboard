// Allowlist-only HTTPS relay (AWS Lambda "ccm-ringcentral-relay", deployed OUTSIDE the VPC).
//
// ccm-app runs inside the VPC so it can reach the private database, and that VPC has no
// internet access. For its integrations, ccm-app invokes this function through a private
// Lambda VPC endpoint; this function makes the HTTPS request and hands back the reply.
//
// It only talks to the hosts/paths below, forwards only the headers those APIs need, and logs
// nothing (requests carry credentials and patient data). Only IAM principals allowed to invoke
// it (ccm-app's role) can use it.
//
// mode "download" (Practice Fusion export files, which can be far larger than a Lambda reply):
// stream the file straight into the private export bucket (PF_EXPORT_BUCKET) under the given
// key, or write "<key>.error" if it fails. Invoked asynchronously; ccm-app checks the bucket.
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const ALLOWED = [
  { host: "platform.ringcentral.com", path: "/restapi/" }, // RingCentral call-log sync
  { host: "oauth2.googleapis.com", path: "/token" }, // Gmail: OAuth token exchange/refresh
  { host: "gmail.googleapis.com", path: "/gmail/v1/users/me/" }, // Gmail API (read-only scope)
  { hostSuffix: ".practicefusion.com", path: "/" }, // Practice Fusion FHIR (read-only bulk export)
];
const FORWARD_HEADERS = ["authorization", "content-type", "accept", "prefer"];
const RETURN_HEADERS = ["content-type", "retry-after", "content-location", "x-progress", "expires"];
const MAX_BODY = 5_500_000; // Lambda responses are capped at 6 MB
const PART = 16 * 1024 * 1024;

// Export files may also be served from these hosts (set after seeing Practice Fusion's manifest).
const extraDownloadHosts = (process.env.EXTRA_DOWNLOAD_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

const allowed = (url, download = false) => url.protocol === "https:" && (
  ALLOWED.some((a) => (a.host ? url.hostname === a.host : url.hostname.endsWith(a.hostSuffix)) && url.pathname.startsWith(a.path)) ||
  (download && extraDownloadHosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`)))
);

const s3 = new S3Client({});

async function download(event) {
  const bucket = process.env.PF_EXPORT_BUCKET;
  const key = String(event.key ?? "");
  if (!bucket || !/^pf\/[0-9]+\/[0-9]{3}-[A-Za-z]+\.ndjson$/.test(key)) return { status: 400, body: "Bad download request." };
  const fail = (msg) => s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${key}.error`, Body: msg, ServerSideEncryption: "aws:kms" }));
  let url;
  try { url = new URL(event.url); } catch { await fail("Bad file address"); return { status: 400 }; }
  if (!allowed(url, true)) { await fail(`The export host ${url.hostname} isn't on the relay's allowlist`); return { status: 403 }; }
  const headers = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) if (FORWARD_HEADERS.includes(k.toLowerCase())) headers[k] = String(v);
  let uploadId;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(840_000) });
    if (!res.ok || !res.body) { await fail(`Download failed (${res.status})`); return { status: res.status }; }
    uploadId = (await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ServerSideEncryption: "aws:kms", ContentType: "application/fhir+ndjson" }))).UploadId;
    const parts = [];
    let pending = [];
    let size = 0;
    const upload = async () => {
      const n = parts.length + 1;
      const r = await s3.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: n, Body: Buffer.concat(pending, size) }));
      parts.push({ ETag: r.ETag, PartNumber: n });
      pending = []; size = 0;
    };
    for await (const chunk of res.body) {
      pending.push(Buffer.from(chunk)); size += chunk.length;
      if (size >= PART) await upload();
    }
    if (size || !parts.length) await upload();
    await s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
    return { status: 200 };
  } catch (e) {
    if (uploadId) await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(() => {});
    await fail("The download didn't finish").catch(() => {});
    return { status: 504 };
  }
}

export const handler = async (event) => {
  if (event?.mode === "download") return download(event);
  let url;
  try { url = new URL(event?.url); } catch { return { status: 400, body: "Bad URL." }; }
  if (!allowed(url)) return { status: 403, body: "That address isn't on the relay's allowlist." };
  const method = event.method === "POST" ? "POST" : "GET";
  const headers = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) if (FORWARD_HEADERS.includes(k.toLowerCase())) headers[k] = String(v);
  try {
    const res = await fetch(url, { method, headers, body: method === "POST" ? String(event.body ?? "") : undefined, signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    if (body.length > MAX_BODY) return { status: 502, body: "The response was too large for the relay." };
    const out = { "content-type": res.headers.get("content-type") ?? "application/json" };
    for (const h of RETURN_HEADERS) { const v = res.headers.get(h); if (v && h !== "content-type") out[h] = v; }
    return { status: res.status, headers: out, body };
  } catch {
    return { status: 504, body: "The service didn't respond." };
  }
};
