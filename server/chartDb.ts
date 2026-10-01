// The Chart: the read-only copy of a patient's Practice Fusion chart, by section.
// Clinical roles (chartFull) see everything; the front desk (chartBasic) sees contact info,
// insurance, visits and allergies only (minimum necessary). Every view is written to the audit log.
import { gunzipSync } from "node:zlib";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { fhirPatients, fhirResources } from "../drizzle/schema";
import { can } from "../shared/workspace";
import { CHART_SECTIONS, type ChartSection, type FhirResource } from "../shared/fhir";
import { WorkspaceError, audit, searchSubjects, subjectCare, type WorkspaceActor } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

const unpack = (raw: string | null): FhirResource | null => {
  if (!raw) return null;
  try { return JSON.parse(gunzipSync(Buffer.from(raw, "base64")).toString("utf8")) as FhirResource; } catch { return null; }
};

function access(actor: WorkspaceActor): "full" | "basic" {
  if (can(actor.role, "chartFull")) return "full";
  if (can(actor.role, "chartBasic")) return "basic";
  throw new WorkspaceError("You don't have access to patient charts.", "FORBIDDEN");
}

/** Any staff member with chart access can open any patient's chart, whichever clinic they belong to (2026-10-01). */
async function assertInScope(_actor: WorkspaceActor, _subjectKey: string) {
  return;
}

/** How many of each section to send (labs/vitals can run to thousands). */
const LIMITS: Partial<Record<ChartSection, number>> = { labs: 400, vitals: 200, otherObs: 150, notes: 200, visits: 200 };

export async function chartFor(actor: WorkspaceActor, subjectKey: string) {
  const level = access(actor);
  await assertInScope(actor, subjectKey);
  const d = await db();
  const sections = (Object.entries(CHART_SECTIONS) as [ChartSection, (typeof CHART_SECTIONS)[ChartSection]][]).filter(([, v]) => level === "full" || !v.full);
  const wanted = sections.flatMap(([, v]) => v.types as readonly string[]);
  const rows = await d.select({
    id: fhirResources.id, section: fhirResources.section, title: fhirResources.title, value: fhirResources.value,
    status: fhirResources.status, date: fhirResources.date, syncedAt: fhirResources.syncedAt,
  }).from(fhirResources).where(and(eq(fhirResources.subjectKey, subjectKey), inArray(fhirResources.section, wanted))).orderBy(desc(fhirResources.date)).limit(5000);
  const pts = await d.select().from(fhirPatients).where(eq(fhirPatients.subjectKey, subjectKey));
  const lastSynced = [...rows.map((r) => r.syncedAt), ...pts.map((p) => p.syncedAt)].sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  await audit(actor, "view_patient", { entityType: "chart", description: `Viewed Practice Fusion chart (${level})` });
  return {
    level,
    lastSynced,
    contact: pts.length ? { name: pts[0]!.name, dob: pts[0]!.dob, sex: pts[0]!.sex, phone: pts[0]!.phone, email: pts[0]!.email, address: pts[0]!.address, mrn: pts[0]!.mrn, records: pts.length } : null,
    sections: sections.map(([key, v]) => {
      const items = rows.filter((r) => (v.types as readonly string[]).includes(r.section));
      const limit = LIMITS[key] ?? 300;
      return { key, label: v.label, total: items.length, items: items.slice(0, limit).map(({ syncedAt, ...r }) => r) };
    }).filter((s) => s.total > 0),
  };
}

/** One chart item in full (the original Practice Fusion record), for "details". */
export async function chartItem(actor: WorkspaceActor, id: number) {
  const level = access(actor);
  const d = await db();
  const [r] = await d.select().from(fhirResources).where(eq(fhirResources.id, id)).limit(1);
  if (!r) throw new WorkspaceError("Not found.", "NOT_FOUND");
  await assertInScope(actor, r.subjectKey ?? "");
  const allowed = Object.values(CHART_SECTIONS).filter((v) => level === "full" || !v.full).flatMap((v) => v.types as readonly string[]);
  if (!allowed.includes(r.section)) throw new WorkspaceError("You don't have access to that part of the chart.", "FORBIDDEN");
  await audit(actor, "view_patient", { entityType: "chart", entityId: id, description: `Viewed ${r.resourceType}` });
  return { resourceType: r.resourceType, title: r.title, resource: unpack(r.raw) };
}

/** A note or document's content: inline in the record, or fetched from Practice Fusion when opened. */
export async function chartNote(actor: WorkspaceActor, id: number) {
  if (access(actor) !== "full") throw new WorkspaceError("Notes are for clinical roles only.", "FORBIDDEN");
  const d = await db();
  const [r] = await d.select().from(fhirResources).where(and(eq(fhirResources.id, id), eq(fhirResources.resourceType, "DocumentReference"))).limit(1);
  if (!r) throw new WorkspaceError("Not found.", "NOT_FOUND");
  await assertInScope(actor, r.subjectKey ?? "");
  const doc = unpack(r.raw);
  const atts = ((doc?.content as { attachment?: { contentType?: string; data?: string; url?: string; title?: string } }[] | undefined) ?? []).map((c) => c.attachment).filter(Boolean);
  // Prefer something readable in the browser: plain text / HTML, then PDF, then anything.
  const pick = atts.find((a) => /text|html/i.test(a!.contentType ?? "")) ?? atts.find((a) => /pdf/i.test(a!.contentType ?? "")) ?? atts[0];
  if (!pick) throw new WorkspaceError("This document has no content in the export.");
  let contentType = pick.contentType ?? "application/octet-stream";
  let bytes: Buffer | null = pick.data ? Buffer.from(pick.data, "base64") : null;
  if (!bytes && pick.url) {
    const { pfFetch } = await import("./pfSync");
    const res = await pfFetch(pick.url, "application/fhir+json");
    if (!res.ok) throw new WorkspaceError(`Practice Fusion didn't return the document (${res.status}).`);
    const body = (await res.json().catch(() => null)) as { contentType?: string; data?: string } | null;
    if (!body?.data) throw new WorkspaceError("Practice Fusion returned an empty document.");
    contentType = body.contentType ?? contentType;
    bytes = Buffer.from(body.data, "base64");
  }
  if (!bytes) throw new WorkspaceError("This document has no content in the export.");
  if (bytes.length > 4_000_000) throw new WorkspaceError("This document is too large to open here. Open it in Practice Fusion.");
  await audit(actor, "view_patient", { entityType: "chart", entityId: id, description: "Viewed a note/document" });
  const isText = /text|html|xml|json/i.test(contentType);
  return { title: r.title, date: r.date, contentType, text: isText ? bytes.toString("utf8") : null, base64: isText ? null : bytes.toString("base64") };
}

/** Find any patient — roster, schedule, or only in Practice Fusion. */
export async function chartSearch(actor: WorkspaceActor, q: string) {
  access(actor);
  return searchSubjects(q, 25, null);
}

/** Name and DOB for a chart page header (any subject key). */
export async function chartHeader(actor: WorkspaceActor, subjectKey: string) {
  access(actor);
  await assertInScope(actor, subjectKey);
  const d = await db();
  const [p] = await d.select({ name: fhirPatients.name, dob: fhirPatients.dob, patientId: fhirPatients.patientId }).from(fhirPatients).where(eq(fhirPatients.subjectKey, subjectKey)).limit(1);
  if (p) return p;
  const hit = (await searchSubjects(subjectKey.startsWith("s:") ? subjectKey.slice(2).split("|")[0]! : "", 50)).find((x) => x.key === subjectKey);
  return hit ? { name: hit.name, dob: hit.dob, patientId: hit.patientId } : null;
}
