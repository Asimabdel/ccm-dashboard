// IAM-only check: which kinds of Practice Fusion documents the chart import received. Counts only:
// document types (standard code names), formats, whether the file itself came with the record,
// and how many patients have any. No patient names, titles typed by staff, or document text.
import { gunzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { getDb } from "./db";

type Row = Record<string, unknown>;

export async function pfDocStats(opts: { deadline: number }) {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  const q = async (x: ReturnType<typeof sql>) => ((await d.execute(x)) as unknown as [Row[]])[0];
  const n = (v: unknown) => Number(v ?? 0);

  const [tot] = await q(sql`SELECT COUNT(*) n, COUNT(DISTINCT subjectKey) subjects, SUM(raw IS NULL) noRaw, MIN(date) first, MAX(date) last FROM fhirResources WHERE resourceType = 'DocumentReference'`);
  const byPrefix = await q(sql`SELECT LEFT(subjectKey, 2) k, COUNT(*) n FROM fhirResources WHERE resourceType = 'DocumentReference' GROUP BY LEFT(subjectKey, 2)`);
  // The type's standard name only when there's a standard code (a free-text description could hold a name).
  const byType = await q(sql`SELECT code, CASE WHEN code IS NULL THEN NULL ELSE title END title, COUNT(*) n FROM fhirResources WHERE resourceType = 'DocumentReference' GROUP BY code, CASE WHEN code IS NULL THEN NULL ELSE title END ORDER BY n DESC LIMIT 40`);
  const byFormat = await q(sql`SELECT value fmt, COUNT(*) n FROM fhirResources WHERE resourceType = 'DocumentReference' GROUP BY value ORDER BY n DESC LIMIT 15`);
  const byYear = await q(sql`SELECT LEFT(date, 4) y, COUNT(*) n FROM fhirResources WHERE resourceType = 'DocumentReference' GROUP BY LEFT(date, 4) ORDER BY y`);
  const [reports] = await q(sql`SELECT COUNT(*) n, COUNT(DISTINCT subjectKey) subjects FROM fhirResources WHERE resourceType = 'DiagnosticReport'`);
  const reportTypes = await q(sql`SELECT code, COUNT(*) n FROM fhirResources WHERE resourceType = 'DiagnosticReport' GROUP BY code ORDER BY n DESC LIMIT 15`);
  const [patients] = await q(sql`SELECT COUNT(*) n FROM fhirPatients`);
  const [ccm] = await q(sql`SELECT COUNT(*) active, SUM(EXISTS (SELECT 1 FROM fhirResources f WHERE f.resourceType = 'DocumentReference' AND f.subjectKey = CONCAT('p:', p.id))) withDocs FROM patients p WHERE p.ccmEnrollmentStatus = 'active' AND p.name NOT LIKE '%(merged into #%'`);

  // A spread-out sample of the records themselves: what the attachments look like.
  const sample = await q(sql`SELECT raw FROM fhirResources WHERE resourceType = 'DocumentReference' AND raw IS NOT NULL AND MOD(id, 25) = 0 LIMIT 400`);
  const tally: Record<string, Record<string, number>> = { attachmentType: {}, contentIn: {}, category: {}, typeSystem: {}, attachmentsPerDoc: {}, sizeKb: {} };
  const bump = (k: string, v: string) => { tally[k]![v] = (tally[k]![v] ?? 0) + 1; };
  let sampled = 0;
  for (const s of sample) {
    if (Date.now() > opts.deadline) break;
    let r: Record<string, any> | null = null;
    try { r = JSON.parse(gunzipSync(Buffer.from(String(s.raw), "base64")).toString("utf8")); } catch { continue; }
    if (!r) continue;
    sampled++;
    const atts = ((r.content as { attachment?: Record<string, unknown> }[] | undefined) ?? []).map((c) => c.attachment ?? {});
    bump("attachmentsPerDoc", String(atts.length));
    for (const a of atts) {
      bump("attachmentType", String(a.contentType ?? "(none)"));
      bump("contentIn", a.data ? "inline data" : a.url ? (String(a.url).includes("Binary") ? "url to Binary" : "url (other)") : "no data or url");
      if (a.size) bump("sizeKb", Number(a.size) < 50_000 ? "<50" : Number(a.size) < 500_000 ? "50-500" : Number(a.size) < 5_000_000 ? "500-5000" : ">5000");
    }
    for (const c of (r.category as { coding?: { code?: string }[] }[] | undefined) ?? []) for (const cd of c.coding ?? []) bump("category", String(cd.code ?? "?"));
    for (const cd of ((r.type as { coding?: { system?: string }[] } | undefined)?.coding ?? [])) bump("typeSystem", String(cd.system ?? "?").replace(/^https?:\/\//, "").slice(0, 60));
  }

  return {
    documents: { total: n(tot?.n), patients: n(tot?.subjects), withoutRecordStored: n(tot?.noRaw), firstDate: tot?.first ?? null, lastDate: tot?.last ?? null },
    byKeyPrefix: Object.fromEntries(byPrefix.map((r) => [String(r.k ?? "none"), n(r.n)])),
    byType: byType.map((r) => ({ code: r.code ?? null, type: r.title ?? null, n: n(r.n) })),
    byFormat: Object.fromEntries(byFormat.map((r) => [String(r.fmt ?? "(none)"), n(r.n)])),
    byYear: Object.fromEntries(byYear.map((r) => [String(r.y ?? "none"), n(r.n)])),
    reports: { total: n(reports?.n), patients: n(reports?.subjects), byCode: reportTypes.map((r) => ({ code: r.code ?? null, n: n(r.n) })) },
    pfPatients: n(patients?.n),
    ccmActive: { total: n(ccm?.active), withDocuments: n(ccm?.withDocs) },
    sample: { records: sampled, ...tally },
  };
}

/**
 * IAM-only probe: does Practice Fusion's per-patient API return more document kinds than the bulk
 * export? Reads the capability statement and searches DocumentReference for a few patients. Counts only.
 */
export async function pfDocProbe(opts: { deadline: number }) {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  const { pfFetch } = await import("./pfSync");
  const meta = await pfFetch("metadata");
  const cap = (await meta.json().catch(() => null)) as { rest?: { resource?: { type?: string; interaction?: { code?: string }[]; searchParam?: { name?: string }[]; operation?: { name?: string }[] }[] }[] } | null;
  const supports = Object.fromEntries((cap?.rest?.[0]?.resource ?? []).filter((r) => ["DocumentReference", "Binary", "DiagnosticReport"].includes(r.type ?? "")).map((r) => [r.type, {
    interactions: (r.interaction ?? []).map((i) => i.code), searchParams: (r.searchParam ?? []).map((s) => s.name), operations: (r.operation ?? []).map((o) => o.name),
  }]));
  const ids = ((await d.execute(sql`SELECT DISTINCT patientFhirId id FROM fhirResources WHERE resourceType = 'DocumentReference' AND patientFhirId IS NOT NULL AND MOD(id, 97) = 0 LIMIT 5`)) as unknown as [{ id: string }[]])[0].map((r) => r.id);
  const tally: Record<string, Record<string, number>> = { type: {}, category: {}, contentType: {}, status: {} };
  const bump = (k: string, v: string) => { tally[k]![v] = (tally[k]![v] ?? 0) + 1; };
  const perPatient: { bulkDocs: number; apiDocs: number | null; http: number }[] = [];
  for (const id of ids) {
    if (Date.now() > opts.deadline) break;
    const bulk = Number((((await d.execute(sql`SELECT COUNT(*) n FROM fhirResources WHERE resourceType = 'DocumentReference' AND patientFhirId = ${id}`)) as unknown as [{ n: number }[]])[0][0] ?? { n: 0 }).n);
    const res = await pfFetch(`DocumentReference?patient=${encodeURIComponent(id)}&_count=100`);
    const b = (await res.json().catch(() => null)) as { total?: number; entry?: { resource?: Record<string, any> }[] } | null;
    const entries = (b?.entry ?? []).map((e) => e.resource ?? {}).filter((r) => r.resourceType === "DocumentReference");
    perPatient.push({ bulkDocs: bulk, apiDocs: res.ok ? entries.length : null, http: res.status });
    for (const r of entries) {
      for (const c of (r.type?.coding ?? []) as { code?: string; display?: string }[]) bump("type", `${c.code ?? "?"} ${c.display ?? ""}`.trim());
      for (const cat of (r.category ?? []) as { coding?: { code?: string }[] }[]) for (const c of cat.coding ?? []) bump("category", String(c.code ?? "?"));
      for (const ct of (r.content ?? []) as { attachment?: { contentType?: string } }[]) bump("contentType", String(ct.attachment?.contentType ?? "(none)"));
      bump("status", String(r.docStatus ?? r.status ?? "?"));
    }
  }
  // DiagnosticReport: do lab reports carry the report itself (a PDF) as presentedForm?
  const sample = ((await d.execute(sql`SELECT raw FROM fhirResources WHERE resourceType = 'DiagnosticReport' AND raw IS NOT NULL AND MOD(id, 37) = 0 LIMIT 300`)) as unknown as [{ raw: string }[]])[0];
  const reports: Record<string, number> = {};
  for (const s of sample) {
    let r: Record<string, any> | null = null;
    try { r = JSON.parse(gunzipSync(Buffer.from(String(s.raw), "base64")).toString("utf8")); } catch { continue; }
    const forms = (r?.presentedForm ?? []) as { contentType?: string }[];
    const k = forms.length ? `presentedForm ${forms.map((f) => f.contentType ?? "?").join("+")}` : "results only (no report file)";
    reports[k] = (reports[k] ?? 0) + 1;
    for (const c of (r?.category ?? []) as { coding?: { code?: string }[] }[]) for (const cd of c.coding ?? []) reports[`category ${cd.code ?? "?"}`] = (reports[`category ${cd.code ?? "?"}`] ?? 0) + 1;
  }
  return { supports, patientsChecked: perPatient.length, perPatient, apiDocuments: tally, diagnosticReportSample: reports };
}
