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
    // Emails no patient matched: the AI reads who they're about (name + DOB → their care team).
    const { readPendingEmails } = await import("../emailRouting");
    const emailRead = await readPendingEmails({ deadline: started + 22_000 });
    // Then keep loading earlier emails ("Load the last 30 days") with the time left.
    const backfill = "skipped" in sync ? null : await runGmailBackfill({ deadline: started + 23_000 });
    return { ...sync, faxBox, faxRead, emailRead, backfill };
  }
  // Demo plan: one made-up Availity eligibility request (nothing stored), to check the reply format.
  if (event && event.__job === "availity-demo-probe" && !event.requestContext && !event.version) {
    const { demoCoverageProbe } = await import("../availityDb");
    return demoCoverageProbe();
  }
  // Evenings (EventBridge): check the next clinic day's patients' insurance with Availity.
  if (event && event.__job === "eligibility-nightly" && !event.requestContext && !event.version) {
    const { runNightly } = await import("../availityDb");
    return runNightly({ deadline: Date.now() + 25_000, date: typeof event.date === "string" ? event.date : undefined });
  }
  // Make someone an office manager for their Workforce home clinic (IAM-only; dry run unless apply).
  if (event && event.__job === "office-manager" && !event.requestContext && !event.version) {
    const { makeOfficeManager } = await import("../workspaceDb");
    return makeOfficeManager({ name: String(event.name ?? ""), apply: event.apply === true });
  }
  // Who every time-off request goes to (IAM-only; dry run unless apply).
  if (event && event.__job === "time-off-approver" && !event.requestContext && !event.version) {
    const { timeOffApproverJob } = await import("../workforceDb");
    return timeOffApproverJob({ name: String(event.name ?? ""), apply: event.apply === true });
  }
  // Who sees what in the Opportunity Finder (IAM-only check; staff names and clinics, no patients).
  if (event && event.__job === "opportunity-scopes" && !event.requestContext && !event.version) {
    const { opportunityScopeReport } = await import("../workspaceDb");
    return opportunityScopeReport();
  }
  // Load the practice's form wording into the Patient forms library (IAM-only; matched by English title).
  // Consent forms: re-check everyone who said Yes to a program and isn't enrolled yet (EventBridge, every 30 min).
  if (event && event.__job === "auto-enroll" && !event.requestContext && !event.version) {
    const { sweepEnrollments } = await import("../enrollDb");
    return sweepEnrollments();
  }
  if (event && event.__job === "intake-docs" && !event.requestContext && !event.version) {
    const { importDocuments } = await import("../intakeDb");
    return importDocuments(Array.isArray(event.docs) ? event.docs : []);
  }
  // A booking from the mypcpdr.com wizard, handed over by the clinic-booking-mailer Lambda (IAM-only).
  if (event && event.__job === "website-booking" && !event.requestContext && !event.version) {
    const { ingestBooking } = await import("../bookingsDb");
    return ingestBooking(event.booking ?? {});
  }
  // Every 2 minutes: the Practice Fusion chart sync (starts nightly or on request, then loads in chunks).
  if (event && event.__job === "pf-sync" && !event.requestContext && !event.version) {
    const { runPfSync } = await import("../pfSync");
    return runPfSync({ deadline: Date.now() + 18_000 });
  }
  // Every morning (EventBridge): who qualifies for care programs from their diagnoses (counts only in the log).
  if (event && event.__job === "program-suggest" && !event.requestContext && !event.version) {
    const { scanProgramSuggestions } = await import("../programsDb");
    return scanProgramSuggestions();
  }
  // One-time fill of the latest smoking status / BMI per chart from the chart copy (IAM-only; re-run until done).
  if (event && event.__job === "chart-facts-backfill" && !event.requestContext && !event.version) {
    const { backfillChartFacts } = await import("../chartFacts");
    return backfillChartFacts({ deadline: Date.now() + 24_000, restart: event.restart === true });
  }
  // Every night (EventBridge): add Practice Fusion chronic / behavioral diagnoses to CCM-roster records (counts only).
  if (event && event.__job === "condition-sync" && !event.requestContext && !event.version) {
    const { syncRosterConditions } = await import("../conditionSync");
    return syncRosterConditions({ apply: event.apply !== false, deadline: Date.now() + 24_000 });
  }
  // Merge duplicate roster records (IAM-only; dry run unless apply; counts only). Re-run until done.
  if (event && event.__job === "merge-duplicate-roster" && !event.requestContext && !event.version) {
    const { mergeDuplicates, mergeActor } = await import("../rosterMerge");
    return mergeDuplicates(await mergeActor(), { apply: event.apply === true, deadline: Date.now() + 22_000 });
  }
  // Does Practice Fusion's per-patient API return more document kinds than the export? (IAM-only; counts only)
  if (event && event.__job === "pf-doc-probe" && !event.requestContext && !event.version) {
    const { pfDocProbe } = await import("../pfDocStats");
    return pfDocProbe({ deadline: Date.now() + 22_000 });
  }
  // Provider teams = the provider + the MAs at their clinic (IAM-only; dry run unless apply; staff names only).
  if (event && event.__job === "provider-teams-auto" && !event.requestContext && !event.version) {
    const { autoProviderTeams } = await import("../emailRouting");
    return autoProviderTeams({ apply: event.apply === true });
  }
  // Re-route patient emails already in the system (IAM-only; dry run unless apply; counts only).
  if (event && event.__job === "email-routing-refresh" && !event.requestContext && !event.version) {
    const { refreshEmailRouting } = await import("../emailRouting");
    return refreshEmailRouting({ apply: event.apply === true, days: Math.min(Number(event.days) || 14, 60), deadline: Date.now() + 22_000 });
  }
  // Complete care plans started before the specialized templates (IAM-only; dry run unless apply; counts only).
  if (event && event.__job === "careplan-refresh" && !event.requestContext && !event.version) {
    const { refreshPlans } = await import("../carePlansDb");
    return refreshPlans({ apply: event.apply === true, deadline: Date.now() + 22_000 });
  }
  // Clean roster condition lists filled from Practice Fusion (IAM-only; dry run unless apply; counts only).
  if (event && event.__job === "condition-cleanup" && !event.requestContext && !event.version) {
    const { cleanupRosterConditions } = await import("../conditionCleanup");
    return cleanupRosterConditions({ apply: event.apply === true, deadline: Date.now() + 22_000 });
  }
  // Which exact diagnoses CCM patients have (IAM-only; counts only, no names).
  // One-time (2026-10-04): the first overtime alerts were about a finished week but worded "heading into".
  if (event && event.__job === "fix-first-ot-alerts" && !event.requestContext && !event.version) {
    const { getDb } = await import("../db");
    const { sql } = await import("drizzle-orm");
    const d = await getDb();
    const [r] = (await d!.execute(sql`UPDATE workTasks SET
        title = REPLACE(title, 'Heading into overtime: ', 'Overtime, week of Sep 28: '),
        description = CONCAT('Week of Sep 28 – Oct 4: over 40 hours on the clock, so overtime pay applies. Check the punches on Workforce → Timesheets (lunch breaks weren''t on the clock before Oct 5).', CHAR(10), CHAR(10), 'From the time clock.')
      WHERE sourceType = 'attendance' AND sourceRef LIKE '%:2026-09-28:ot' AND title LIKE 'Heading into overtime:%'`)) as unknown as [{ affectedRows: number }];
    return { fixed: r.affectedRows };
  }
  // Time clock reminders, manager alerts and the Monday shout-out (every 5 minutes, IAM-only).
  if (event && event.__job === "workforce-alerts" && !event.requestContext && !event.version) {
    const { runWorkforceAlerts } = await import("../workforceAlerts");
    const r = await runWorkforceAlerts();
    if (r.reminders || r.alerts || r.shoutout) console.log("[workforce-alerts]", JSON.stringify(r));
    return r;
  }
  // Patient texts: bring in new texts from RingCentral and send after-hours replies (every minute, IAM-only).
  if (event && event.__job === "sms-sync" && !event.requestContext && !event.version) {
    const { syncTexts } = await import("../textsDb");
    const r = await syncTexts({ force: true }).catch((e: Error) => ({ error: e.message }));
    if ("received" in r && (r.received || r.autoReplies)) console.log("[sms-sync]", JSON.stringify({ received: r.received, autoReplies: r.autoReplies }));
    if ("error" in r) console.error("[sms-sync] failed:", r.error);
    return r;
  }
  // Recent roster imports by provider (IAM-only; counts only, no names).
  if (event && event.__job === "recent-import-report" && !event.requestContext && !event.version) {
    const { recentImportReport } = await import("../importReset");
    return recentImportReport(typeof event.sinceHours === "number" ? event.sinceHours : 48);
  }
  // Make an imported batch "new" (IAM-only): {providerId?, staffId?, from, to?, clearLastCalled?, dryRun?}; dry run unless dryRun:false.
  if (event && event.__job === "reset-imported-as-new" && !event.requestContext && !event.version) {
    const { resetImportedAsNew } = await import("../importReset");
    return resetImportedAsNew({ providerId: event.providerId ? Number(event.providerId) : undefined, staffId: event.staffId ? Number(event.staffId) : undefined, from: String(event.from), to: event.to ? String(event.to) : undefined, clearLastCalled: !!event.clearLastCalled, dryRun: event.dryRun !== false });
  }
  // APCM panel counts for a month (IAM-only; counts only, no names).
  if (event && event.__job === "apcm-month-stats" && !event.requestContext && !event.version) {
    const { getApcmOverview } = await import("../db");
    const month = typeof event.month === "string" && /^\d{4}-\d{2}$/.test(event.month) ? event.month : new Date().toISOString().slice(0, 7);
    const r = await getApcmOverview(month, { limit: 1 });
    return { month, ...r.stats };
  }
  // Active CCM / BHI / APCM patients per provider (IAM-only; counts only).
  if (event && event.__job === "provider-program-counts" && !event.requestContext && !event.version) {
    const { providerProgramCounts } = await import("../providerProgramCounts");
    return providerProgramCounts();
  }
  // Each care coordinator's list: active CCM on the roster + this month's CCM / BHI worklist (IAM-only; counts only).
  if (event && event.__job === "coordinator-list-counts" && !event.requestContext && !event.version) {
    const { coordinatorListCounts } = await import("../providerProgramCounts");
    const { currentMonth } = await import("../seed");
    return coordinatorListCounts(typeof event.month === "string" && /^\d{4}-\d{2}$/.test(event.month) ? event.month : currentMonth(), typeof event.provider === "string" ? event.provider : undefined);
  }
  // Active CCM patients by coordinator: visit / talked by phone / call attempted since a date (IAM-only; counts only).
  if (event && event.__job === "contact-counts" && !event.requestContext && !event.version) {
    const { contactCounts } = await import("../providerProgramCounts");
    return contactCounts({ since: typeof event.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(event.since) ? event.since : "2026-07-01", provider: typeof event.provider === "string" ? event.provider : undefined });
  }
  // Move one provider's active CCM patients to one coordinator (IAM-only; dry run unless apply).
  if (event && event.__job === "coordinator-transfer" && !event.requestContext && !event.version) {
    const { transferCoordinator } = await import("../coordinatorTransfer");
    const { currentMonth } = await import("../seed");
    return transferCoordinator({ provider: String(event.provider ?? ""), to: String(event.to ?? ""), month: typeof event.month === "string" && /^\d{4}-\d{2}$/.test(event.month) ? event.month : currentMonth(), apply: event.apply === true });
  }
  if (event && event.__job === "ccm-dx-stats" && !event.requestContext && !event.version) {
    const { ccmDiagnosisStats } = await import("../diagnosisStats");
    return ccmDiagnosisStats();
  }
  // Which kinds of Practice Fusion documents the import received (IAM-only; counts only).
  if (event && event.__job === "pf-doc-stats" && !event.requestContext && !event.version) {
    const { pfDocStats } = await import("../pfDocStats");
    return pfDocStats({ deadline: Date.now() + 20_000 });
  }
  // Are Practice Fusion links consistent, and what is the import doing? (IAM-only; counts only)
  if (event && event.__job === "pf-link-consistency" && !event.requestContext && !event.version) {
    const { pfLinkConsistency } = await import("../rosterMatch");
    return pfLinkConsistency();
  }
  // Duplicate roster records (same name as an already-linked roster patient): counts only.
  if (event && event.__job === "duplicate-roster-report" && !event.requestContext && !event.version) {
    const { duplicateRosterReport } = await import("../rosterMatch");
    return duplicateRosterReport();
  }
  // Link CCM-roster patients to their Practice Fusion records (IAM-only; dry run unless apply; counts only).
  if (event && event.__job === "roster-pf-match" && !event.requestContext && !event.version) {
    const { matchRosterToPf } = await import("../rosterMatch");
    return matchRosterToPf({ apply: event.apply === true, name: typeof event.name === "string" ? event.name : null, deadline: Date.now() + 22_000 });
  }
  // Where recent "last visit" dates come from (IAM-only; counts and visit-type names only).
  if (event && event.__job === "seen-since-breakdown" && !event.requestContext && !event.version) {
    const { seenSinceBreakdown } = await import("../officeTestingDb");
    return seenSinceBreakdown();
  }
  // Testing tab check: how many qualify for ABI-Q / PFT / RMR and how long the list takes (IAM-only, counts only).
  if (event && event.__job === "office-testing-summary" && !event.requestContext && !event.version) {
    const { officeTestingSummary } = await import("../officeTestingDb");
    return officeTestingSummary();
  }
  // Who approves program suggestions, by name (IAM-only; dry run unless apply).
  if (event && event.__job === "program-approvers" && !event.requestContext && !event.version) {
    const { programApproversJob } = await import("../programsDb");
    return programApproversJob({ names: Array.isArray(event.names) ? event.names.map(String) : [], apply: event.apply === true });
  }
  // One-time clock history reset (IAM-only; dry run with the old punches unless apply). Snapshot RDS first.
  if (event && event.__job === "clock-reset" && !event.requestContext && !event.version) {
    const { resetClockHistory } = await import("../clockReset");
    return resetClockHistory({ before: String(event.before ?? ""), apply: event.apply === true });
  }
  // Who assigns CCM patients like an admin (Staff Assignment), by name (IAM-only; dry run unless apply).
  if (event && event.__job === "ccm-assigners" && !event.requestContext && !event.version) {
    const { ccmAssignersJob } = await import("../ccmAssigners");
    return ccmAssignersJob({ names: Array.isArray(event.names) ? event.names.map(String) : [], apply: event.apply === true });
  }
  // Every 5 minutes (EventBridge): copy new and changed Square payments (the webhook is the fast path).
  if (event && event.__job === "square-sync" && !event.requestContext && !event.version) {
    const { runSquareSync } = await import("../squareDb");
    return runSquareSync({ deadline: Date.now() + 20_000 });
  }
  if (event && event.__job === "ringcentral-sync" && !event.requestContext && !event.version) {
    const { runRingCentralSync } = await import("../ringcentralSync");
    const started = Date.now();
    const sync = await runRingCentralSync({ maxRequests: 8, maxMs: 20_000, manual: false });
    // Faxes sent from MyPCP: has RingCentral sent them yet?
    const { refreshFaxStatuses } = await import("../faxSendDb");
    const faxes = await refreshFaxStatuses({ deadline: started + 26_000 }).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }));
    return { ...sync, faxes };
  }
  return httpHandler(event, context);
};
