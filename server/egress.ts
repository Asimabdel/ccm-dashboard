// Outbound HTTPS for integrations. On AWS, ccm-app runs inside the VPC with no internet access,
// so requests go through the allowlist-only relay Lambda (infra/ringcentral-relay) over the
// private Lambda VPC endpoint. Locally (dev/tests) it's a plain fetch.
//
// The relay only allows: RingCentral's API, Google's OAuth token endpoint and the Gmail API,
// Practice Fusion's FHIR API, and Availity's API (insurance eligibility).
const RELAY_FUNCTION = "ccm-ringcentral-relay";

let lambdaClient: import("@aws-sdk/client-lambda").LambdaClient | null = null;

export class EgressError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function relayFetch(url: string, init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return fetch(url, init);
  const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
  lambdaClient ??= new LambdaClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  const out = await lambdaClient.send(new InvokeCommand({
    FunctionName: RELAY_FUNCTION,
    Payload: new TextEncoder().encode(JSON.stringify({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? null })),
  }));
  if (out.FunctionError || !out.Payload) throw new EgressError("The outbound relay failed.", 502);
  const r = JSON.parse(new TextDecoder().decode(out.Payload)) as { status: number; headers?: Record<string, string>; body: string };
  return new Response([204, 205, 304].includes(r.status) ? null : r.body, { status: r.status, headers: r.headers });
}
