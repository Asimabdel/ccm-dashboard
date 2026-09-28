import "dotenv/config";
import express from "express";
import path from "path";
import serverless from "serverless-http";
import { createApp } from "./app";

/**
 * AWS Lambda entry point (behind a Lambda Function URL — HTTPS built in).
 *
 * Serves BOTH the API and the built React SPA from one function:
 *   - createApp() registers the API routes (tRPC, OAuth, storage proxy).
 *   - The built client is bundled into the zip at ./public and served statically,
 *     with a catch-all that returns index.html for client-side routes.
 *
 * (On Vercel the SPA was served by the CDN; on Lambda there's no CDN, so the
 * function serves it itself.)
 */
const app = createApp();

const pub = path.resolve(import.meta.dirname, "public");
app.use(express.static(pub));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/manus-storage/")) return next();
  res.sendFile(path.join(pub, "index.html"));
});

const httpHandler = serverless(app);

/**
 * RDS only accepts connections from this function's security group, so schema
 * migrations run here rather than from a laptop. They're triggered by a DIRECT,
 * IAM-authorized invoke — `aws lambda invoke --payload '{"__migrate":"workforce"}'`.
 * API Gateway always wraps HTTP requests in its own event envelope (version,
 * requestContext, ...), so no web request can ever produce this payload.
 */
export const handler = async (event: any, context: any) => {
  if (event && event.__migrate === "workforce" && !event.requestContext && !event.version) {
    const { runWorkforceMigration } = await import("../workforceMigration");
    return { migrated: "workforce", applied: await runWorkforceMigration() };
  }
  if (event && event.__migrate === "workspace-check" && !event.requestContext && !event.version) {
    const { inspectWorkspace } = await import("../workspaceMigration");
    return { check: "workspace", ...(await inspectWorkspace()) };
  }
  if (event && event.__migrate === "workspace" && !event.requestContext && !event.version) {
    const { runWorkspaceMigration } = await import("../workspaceMigration");
    return { migrated: "workspace", applied: await runWorkspaceMigration() };
  }
  // Every 10 minutes from an EventBridge schedule (IAM-only, same reasoning as __migrate).
  // Every 2 minutes: new emails in the practice mailbox → patient-email tasks.
  if (event && event.__job === "gmail-sync" && !event.requestContext && !event.version) {
    const { runGmailSync, runGmailBackfill } = await import("../gmailSync");
    const { readPendingFaxes } = await import("../faxInbox");
    const started = Date.now();
    const sync = await runGmailSync({ maxMs: 9_000, manual: false });
    const faxBox = await runGmailSync({ slot: "fax", maxMs: 4_000, manual: false });
    // Faxes waiting for the AI read (each takes a few seconds; none starts after 17s so the run ends before 30s).
    const faxRead = await readPendingFaxes({ deadline: started + 17_000 });
    // Then keep loading earlier emails ("Load the last 30 days") with the time left.
    const backfill = "skipped" in sync ? null : await runGmailBackfill({ deadline: started + 23_000 });
    return { ...sync, faxBox, faxRead, backfill };
  }
  // Every 2 minutes: the Practice Fusion chart sync (starts nightly or on request, then loads in chunks).
  if (event && event.__job === "pf-sync" && !event.requestContext && !event.version) {
    const { runPfSync } = await import("../pfSync");
    return runPfSync({ deadline: Date.now() + 18_000 });
  }
  if (event && event.__job === "ringcentral-sync" && !event.requestContext && !event.version) {
    const { runRingCentralSync } = await import("../ringcentralSync");
    return runRingCentralSync({ maxRequests: 8, maxMs: 22_000, manual: false });
  }
  return httpHandler(event, context);
};
