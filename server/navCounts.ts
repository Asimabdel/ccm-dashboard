// The number bubbles in the side menu: how many things are waiting on each page for this person.
// Numbers only (no patient details). Each number follows the same access rules and clinic limits
// as the page it points to, so a bubble never shows more than the person would find on that page.
import { and, eq, inArray, sql } from "drizzle-orm";
import { followUpItems, patients, providerEscalations } from "../drizzle/schema";
import { navCountPaths } from "../shared/navMenu";
import { getDb, getPendingRefillCountForProvider, getProviderByUserId } from "./db";
import { waitingBookingCount } from "./bookingsDb";
import { toSignCount } from "./documentsDb";
import { faxesWaitingCount } from "./faxInbox";
import { emailsWaitingCount } from "./gmailSync";
import { packetsToFileCount } from "./intakeDb";
import { myOpenTaskCount, type WorkspaceActor } from "./workspaceDb";

/** Follow-ups not scheduled yet (the page lists them as "pending"); medical assistants: their clinic's patients only. */
async function pendingFollowUps(clinicIds: number[] | null) {
  const d = await getDb();
  if (!d || (clinicIds && !clinicIds.length)) return 0;
  const [row] = await d.select({ n: sql<number>`count(*)` }).from(followUpItems)
    .innerJoin(patients, eq(followUpItems.patientId, patients.id))
    .where(and(eq(followUpItems.status, "pending"), clinicIds ? inArray(patients.clinicId, clinicIds) : undefined));
  return Number(row?.n ?? 0);
}

/** Escalations no provider has looked at yet. The page shows every provider's, so this does too. */
async function pendingEscalations() {
  const d = await getDb();
  if (!d) return 0;
  const [row] = await d.select({ n: sql<number>`count(*)` }).from(providerEscalations)
    .innerJoin(patients, eq(providerEscalations.patientId, patients.id))
    .where(eq(providerEscalations.escalationStatus, "pending"));
  return Number(row?.n ?? 0);
}

/** Refill requests waiting for this provider's answer (the page is each provider's own list). */
async function myPendingRefills(userId: number) {
  const provider = await getProviderByUserId(userId);
  return provider ? getPendingRefillCountForProvider(provider.id) : 0;
}

/**
 * Menu path → how many things are waiting there for this person. Pages with nothing waiting
 * (or that the person cannot open) are left out. One slow or failing count never hides the others.
 */
const COUNTERS: Record<string, (actor: WorkspaceActor) => Promise<number>> = {
  "/my-work": (a) => myOpenTaskCount(a),
  "/bookings": (a) => waitingBookingCount(a),
  "/faxes": (a) => faxesWaitingCount(a.clinicIds),
  "/patient-emails": (a) => emailsWaitingCount(a.clinicIds),
  "/documents": (a) => toSignCount(a.id),
  "/intake-forms": (a) => packetsToFileCount(a),
  "/refill-requests": (a) => myPendingRefills(a.id),
  "/escalations": () => pendingEscalations(),
  "/follow-ups": (a) => pendingFollowUps(a.clinicIds),
};

export async function navCounts(actor: WorkspaceActor): Promise<Record<string, number>> {
  const results = await Promise.all(
    navCountPaths(actor.role).map(async (path) => {
      try {
        return [path, (await COUNTERS[path]?.(actor)) ?? 0] as const;
      } catch (e) {
        console.warn(`[nav-counts] ${path} failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`);
        return [path, 0] as const;
      }
    }),
  );
  return Object.fromEntries(results.filter(([, n]) => n > 0));
}
