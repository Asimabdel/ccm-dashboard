// Allowlist-only HTTPS relay (AWS Lambda "ccm-ringcentral-relay", deployed OUTSIDE the VPC).
//
// ccm-app runs inside the VPC so it can reach the private database, and that VPC has no
// internet access. For its integrations, ccm-app invokes this function through a private
// Lambda VPC endpoint; this function makes the HTTPS request and hands back the reply.
//
// It only talks to the hosts/paths below, forwards only the headers those APIs need, and logs
// nothing (requests carry credentials, patient phone numbers and email content). Only IAM
// principals allowed to invoke it (ccm-app's role) can use it.
const ALLOWED = [
  { host: "platform.ringcentral.com", path: "/restapi/" }, // RingCentral call-log sync
  { host: "oauth2.googleapis.com", path: "/token" }, // Gmail: OAuth token exchange/refresh
  { host: "gmail.googleapis.com", path: "/gmail/v1/users/me/" }, // Gmail API (read-only scope)
];
const FORWARD_HEADERS = ["authorization", "content-type", "accept"];
const MAX_BODY = 5_500_000; // Lambda responses are capped at 6 MB

export const handler = async (event) => {
  let url;
  try { url = new URL(event?.url); } catch { return { status: 400, body: "Bad URL." }; }
  if (url.protocol !== "https:" || !ALLOWED.some((a) => url.hostname === a.host && url.pathname.startsWith(a.path))) {
    return { status: 403, body: "That address isn't on the relay's allowlist." };
  }
  const method = event.method === "POST" ? "POST" : "GET";
  const headers = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) if (FORWARD_HEADERS.includes(k.toLowerCase())) headers[k] = String(v);
  try {
    const res = await fetch(url, { method, headers, body: method === "POST" ? String(event.body ?? "") : undefined, signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    if (body.length > MAX_BODY) return { status: 502, body: "The response was too large for the relay." };
    const out = { "content-type": res.headers.get("content-type") ?? "application/json" };
    const retry = res.headers.get("retry-after");
    if (retry) out["retry-after"] = retry;
    return { status: res.status, headers: out, body };
  } catch {
    return { status: 504, body: "The service didn't respond." };
  }
};
