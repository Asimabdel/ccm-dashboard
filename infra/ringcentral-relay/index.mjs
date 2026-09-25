// RingCentral-only HTTPS relay (AWS Lambda "ccm-ringcentral-relay", deployed OUTSIDE the VPC).
//
// ccm-app runs inside the VPC so it can reach the private database, and that VPC has no
// internet access. For the RingCentral call-log sync, ccm-app invokes this function through a
// private Lambda VPC endpoint; this function makes the HTTPS request and hands back the reply.
//
// It will only talk to https://platform.ringcentral.com/restapi/…, forwards only the headers
// RingCentral needs, and logs nothing (requests carry credentials and patient phone numbers).
// Only IAM principals allowed to invoke it (ccm-app's role) can use it.
const ALLOWED_HOST = "platform.ringcentral.com";
const FORWARD_HEADERS = ["authorization", "content-type", "accept"];
const MAX_BODY = 5_500_000; // Lambda responses are capped at 6 MB

export const handler = async (event) => {
  let url;
  try { url = new URL(event?.url); } catch { return { status: 400, body: "Bad URL." }; }
  if (url.protocol !== "https:" || url.hostname !== ALLOWED_HOST || !url.pathname.startsWith("/restapi/")) {
    return { status: 403, body: "Only RingCentral's API is allowed." };
  }
  const method = event.method === "POST" ? "POST" : "GET";
  const headers = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) if (FORWARD_HEADERS.includes(k.toLowerCase())) headers[k] = String(v);
  try {
    const res = await fetch(url, { method, headers, body: method === "POST" ? String(event.body ?? "") : undefined, signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    if (body.length > MAX_BODY) return { status: 502, body: "RingCentral's response was too large for the relay." };
    const out = { "content-type": res.headers.get("content-type") ?? "application/json" };
    const retry = res.headers.get("retry-after");
    if (retry) out["retry-after"] = retry;
    return { status: res.status, headers: out, body };
  } catch {
    return { status: 504, body: "RingCentral didn't respond." };
  }
};
