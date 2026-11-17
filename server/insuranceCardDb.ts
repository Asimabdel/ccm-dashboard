// Insurance card photos → what the AI reads off them (2026-11-17), for the Copays & deductibles answer.
// Photos come from the health history form (intakeFiles, "insurance_front") and from the patient's
// folder (patientFiles, "insurance_card"), including the front desk's "Snap card". Each photo is read
// once with the practice's AWS Bedrock model (covered by the AWS BAA, like the fax inbox) and saved in
// insuranceCardReads. The AI only copies what is printed; nothing here changes a claim or the chart.
import { randomUUID } from "node:crypto";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { insuranceCardReads, intakeFiles, intakePackets, patientFiles } from "../drizzle/schema";
import { CARD_IMAGE_FORMATS, CARD_PROMPT, EMPTY_CARD, parseCardReading, type CardFacts } from "../shared/insuranceCard";
import { getBytes } from "./docStore";
import { audit, WorkspaceError, type WorkspaceActor } from "./workspaceDb";
import { people } from "./masterBillingDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export type CardSource = "intake" | "folder";
export interface CardPhoto { source: CardSource; sourceId: number; subjectKey: string; at: Date | null; mime: string }
export type CardRead = typeof insuranceCardReads.$inferSelect;

const aiReady = () => !!process.env.BEDROCK_MODEL_ID;
/** Local testing only (never on Lambda): a made-up reading so the screens can be tried without AWS. */
const fakeReader = () => !process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.CARD_READ_FAKE === "1";
export const cardReadingAvailable = () => aiReady() || fakeReader();
/** A card photo the AI is sent is at most this big (Bedrock's image limit is 3.75 MB). */
const MAX_IMAGE_BYTES = 3_700_000;

let bedrock: BedrockRuntimeClient | null = null;
async function ask(bytes: Uint8Array, mime: string): Promise<string> {
  bedrock ??= new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1" });
  const image = CARD_IMAGE_FORMATS[mime.toLowerCase()];
  const content = image
    ? [{ image: { format: image, source: { bytes } } }, { text: CARD_PROMPT }]
    : [{ document: { format: "pdf" as const, name: "insurance card", source: { bytes } } }, { text: CARD_PROMPT }];
  const out = await bedrock.send(new ConverseCommand({
    modelId: process.env.BEDROCK_MODEL_ID!,
    messages: [{ role: "user", content }],
    inferenceConfig: { maxTokens: 800, temperature: 0 },
  }));
  return (out.output?.message?.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("");
}

const readable = (mime: string) => !!CARD_IMAGE_FORMATS[mime.toLowerCase()] || mime === "application/pdf";

/** Every insurance card photo for these patient keys, newest first. */
export async function cardPhotosFor(keys: string[]): Promise<CardPhoto[]> {
  if (!keys.length) return [];
  const d = await db();
  const pids = keys.map((k) => /^p:(\d+)$/.exec(k)?.[1]).filter((x): x is string => !!x).map(Number);
  const [fromForms, fromFolder] = await Promise.all([
    d.select({ id: intakeFiles.id, mime: intakeFiles.mime, at: intakeFiles.createdAt, subjectKey: intakePackets.subjectKey, patientId: intakePackets.patientId })
      .from(intakeFiles).innerJoin(intakePackets, eq(intakePackets.id, intakeFiles.packetId))
      .where(and(eq(intakeFiles.kind, "insurance_front"), pids.length ? sql`(${inArray(intakePackets.subjectKey, keys)} OR ${inArray(intakePackets.patientId, pids)})` : inArray(intakePackets.subjectKey, keys))),
    d.select({ id: patientFiles.id, mime: patientFiles.mimeType, at: patientFiles.createdAt, subjectKey: patientFiles.subjectKey })
      .from(patientFiles).where(and(eq(patientFiles.fileType, "insurance_card"), eq(patientFiles.status, "ready"), isNull(patientFiles.removedAt), inArray(patientFiles.subjectKey, keys))),
  ]);
  const out: CardPhoto[] = [
    ...fromForms.map((r) => ({ source: "intake" as const, sourceId: r.id, subjectKey: r.subjectKey ?? (r.patientId ? `p:${r.patientId}` : keys[0]!), at: r.at, mime: r.mime })),
    ...fromFolder.map((r) => ({ source: "folder" as const, sourceId: r.id, subjectKey: r.subjectKey, at: r.at, mime: r.mime })),
  ].filter((p) => readable(p.mime));
  return out.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
}

async function photoBytes(p: CardPhoto): Promise<Buffer> {
  const d = await db();
  if (p.source === "intake") {
    const [r] = await d.select({ data: intakeFiles.data }).from(intakeFiles).where(eq(intakeFiles.id, p.sourceId)).limit(1);
    if (!r) throw new WorkspaceError("That card photo is gone.");
    return Buffer.from(r.data, "base64");
  }
  const [f] = await d.select({ storageKey: patientFiles.storageKey }).from(patientFiles).where(eq(patientFiles.id, p.sourceId)).limit(1);
  if (!f) throw new WorkspaceError("That card photo is gone.");
  return getBytes(f.storageKey);
}

/** Read one photo with the AI and save what it read (once per photo). */
export async function readCardPhoto(p: CardPhoto, actor: WorkspaceActor | null): Promise<CardRead> {
  const d = await db();
  const [done] = await d.select().from(insuranceCardReads).where(and(eq(insuranceCardReads.source, p.source), eq(insuranceCardReads.sourceId, p.sourceId))).limit(1);
  if (done) return done;
  let facts: CardFacts = { ...EMPTY_CARD };
  let status: "read" | "not_card" | "failed" = "failed";
  if (fakeReader() && !aiReady()) {
    facts = parseCardReading(FAKE_READING);
    status = "read";
  } else {
    if (!aiReady()) throw new WorkspaceError("AI reading isn't set up here.");
    const bytes = await photoBytes(p);
    if (bytes.length > MAX_IMAGE_BYTES) throw new WorkspaceError("That card photo is too large to read. Take a new photo.");
    try {
      facts = parseCardReading(await ask(bytes, p.mime));
      status = facts.isCard ? "read" : "not_card";
    } catch (e) {
      console.warn("[insurance-card] read failed:", (e as Error).message);
      throw new WorkspaceError("The AI couldn't read that card just now. Try again in a minute.");
    }
  }
  await d.insert(insuranceCardReads).values({
    subjectKey: p.subjectKey, source: p.source, sourceId: p.sourceId, status,
    payer: facts.payer, planName: facts.planName, planType: facts.planType, memberId: facts.memberId, groupNumber: facts.groupNumber,
    pcpCopayCents: facts.pcpCopayCents, specialistCopayCents: facts.specialistCopayCents, urgentCareCopayCents: facts.urgentCareCopayCents, erCopayCents: facts.erCopayCents,
    deductibleCents: facts.deductibleCents, coinsurancePct: facts.coinsurancePct, highDeductible: facts.highDeductible, photoAt: p.at, readByUserId: actor?.id ?? null,
  }).onDuplicateKeyUpdate({ set: { status } });
  if (actor) await audit(actor, "view_document", { entityType: "insuranceCard", description: "Copays & deductibles: AI read an insurance card photo" });
  const [row] = await d.select().from(insuranceCardReads).where(and(eq(insuranceCardReads.source, p.source), eq(insuranceCardReads.sourceId, p.sourceId))).limit(1);
  return row!;
}

/** Everyone's keys for this patient (roster, schedule, Practice Fusion). */
async function keysOf(key: string): Promise<string[]> {
  const { index } = await people();
  return index.byKey.get(key)?.keys ?? [key];
}

/** The newest card photo for this patient and whether it has been read yet. */
export async function cardStatus(key: string): Promise<{ photo: CardPhoto | null; read: CardRead | null }> {
  const photos = await cardPhotosFor(await keysOf(key));
  const photo = photos[0] ?? null;
  if (!photo) return { photo: null, read: null };
  const [read] = await (await db()).select().from(insuranceCardReads).where(and(eq(insuranceCardReads.source, photo.source), eq(insuranceCardReads.sourceId, photo.sourceId))).limit(1);
  return { photo, read: read ?? null };
}

/** Read this patient's newest card photo if it hasn't been read yet (the search asks for it). */
export async function readPatientCard(actor: WorkspaceActor, key: string) {
  if (!cardReadingAvailable()) throw new WorkspaceError("AI reading isn't set up here.");
  const { photo, read } = await cardStatus(key);
  if (!photo) throw new WorkspaceError("There's no insurance card photo for this patient yet.");
  return read ?? (await readCardPhoto(photo, actor));
}

const IMAGE_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

/** The front desk's "Snap card": the photo goes in the patient's folder (Insurance card) and is read right away. */
export async function snapCard(actor: WorkspaceActor, key: string, dataUrl: string) {
  const m = IMAGE_RE.exec(dataUrl);
  if (!m) throw new WorkspaceError("That photo couldn't be used. Take it again.");
  const bytes = Buffer.from(m[2]!, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) throw new WorkspaceError("That photo is too large. Take it again a little farther away.");
  const { addGeneratedFile } = await import("./folderDb");
  const ext = m[1] === "image/png" ? "png" : m[1] === "image/webp" ? "webp" : "jpg";
  const id = await addGeneratedFile(actor, {
    subjectKey: key, fileType: "insurance_card", title: "Insurance card (front)", fileName: `insurance-card.${ext}`, bytes,
    key: `documents/patient-files/${randomUUID()}`, mimeType: m[1]!,
  });
  if (!cardReadingAvailable()) return { saved: true, read: null };
  return { saved: true, read: await readCardPhoto({ source: "folder", sourceId: id, subjectKey: key, at: new Date(), mime: m[1]! }, actor) };
}

/** The newest successful read per patient key (for the estimates). */
export async function latestCardReads(): Promise<CardRead[]> {
  const rows = await (await db()).select().from(insuranceCardReads).where(eq(insuranceCardReads.status, "read")).orderBy(desc(insuranceCardReads.photoAt), desc(insuranceCardReads.id));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.subjectKey) ? false : (seen.add(r.subjectKey), true)));
}

/** Newest card photo of each patient that has no reading yet (the owner's "Read card photos"). */
async function waitingPhotos(): Promise<CardPhoto[]> {
  const d = await db();
  const [fromForms, fromFolder, reads] = await Promise.all([
    d.select({ id: intakeFiles.id, mime: intakeFiles.mime, at: intakeFiles.createdAt, subjectKey: intakePackets.subjectKey, patientId: intakePackets.patientId })
      .from(intakeFiles).innerJoin(intakePackets, eq(intakePackets.id, intakeFiles.packetId)).where(eq(intakeFiles.kind, "insurance_front")),
    d.select({ id: patientFiles.id, mime: patientFiles.mimeType, at: patientFiles.createdAt, subjectKey: patientFiles.subjectKey })
      .from(patientFiles).where(and(eq(patientFiles.fileType, "insurance_card"), eq(patientFiles.status, "ready"), isNull(patientFiles.removedAt))),
    d.select({ source: insuranceCardReads.source, sourceId: insuranceCardReads.sourceId }).from(insuranceCardReads),
  ]);
  const done = new Set(reads.map((r) => `${r.source}:${r.sourceId}`));
  const all: CardPhoto[] = [
    ...fromForms.flatMap((r) => { const k = r.subjectKey ?? (r.patientId ? `p:${r.patientId}` : null); return k ? [{ source: "intake" as const, sourceId: r.id, subjectKey: k, at: r.at, mime: r.mime }] : []; }),
    ...fromFolder.map((r) => ({ source: "folder" as const, sourceId: r.id, subjectKey: r.subjectKey, at: r.at, mime: r.mime })),
  ].filter((p) => readable(p.mime)).sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  // Only each patient's newest photo matters.
  const { index } = await people();
  const newest = new Map<string, CardPhoto>();
  for (const p of all) {
    const who = index.byKey.get(p.subjectKey)?.key ?? p.subjectKey;
    if (!newest.has(who)) newest.set(who, p);
  }
  return Array.from(newest.values()).filter((p) => !done.has(`${p.source}:${p.sourceId}`));
}

/** Read a few waiting card photos (each request stays well under the 30-second limit); the page calls it until none are left. */
export async function readWaitingCards(actor: WorkspaceActor, limit = 3) {
  if (!cardReadingAvailable()) throw new WorkspaceError("AI reading isn't set up here.");
  const waiting = await waitingPhotos();
  let read = 0, failed = 0;
  const deadline = Date.now() + 20_000;
  for (const p of waiting.slice(0, limit)) {
    if (Date.now() > deadline) break;
    try { await readCardPhoto(p, null); read++; } catch { failed++; }
  }
  if (read) await audit(actor, "view_document", { entityType: "insuranceCard", description: `Copays & deductibles: AI read ${read} insurance card photos` });
  return { read, failed, left: Math.max(0, waiting.length - read) };
}

export async function waitingCardCount() {
  return (await waitingPhotos()).length;
}

/** IAM-only "card-read-counts" job: card photos and readings. Counts only, no patient details. */
export async function cardReadCounts() {
  const d = await db();
  const [forms] = await d.select({ n: sql<number>`COUNT(*)` }).from(intakeFiles).where(eq(intakeFiles.kind, "insurance_front"));
  const [folder] = await d.select({ n: sql<number>`COUNT(*)` }).from(patientFiles).where(and(eq(patientFiles.fileType, "insurance_card"), isNull(patientFiles.removedAt)));
  const reads = await d.select({ status: insuranceCardReads.status, n: sql<number>`COUNT(*)`, withCopay: sql<number>`SUM(${insuranceCardReads.pcpCopayCents} IS NOT NULL)`, withGroup: sql<number>`SUM(${insuranceCardReads.groupNumber} IS NOT NULL)`, withPlan: sql<number>`SUM(${insuranceCardReads.planName} IS NOT NULL)` })
    .from(insuranceCardReads).groupBy(insuranceCardReads.status);
  return {
    aiReady: cardReadingAvailable(),
    photos: { fromHealthHistoryForms: Number(forms?.n ?? 0), inPatientFolders: Number(folder?.n ?? 0) },
    patientsWithAPhotoNotReadYet: await waitingCardCount(),
    reads: reads.map((r) => ({ status: r.status, cards: Number(r.n), withPcpCopay: Number(r.withCopay ?? 0), withGroupNumber: Number(r.withGroup ?? 0), withPlanName: Number(r.withPlan ?? 0) })),
  };
}

// Made-up card for local testing (CARD_READ_FAKE=1, never on Lambda).
const FAKE_READING = JSON.stringify({
  isInsuranceCard: true, payer: "Blue Cross Blue Shield of Texas", planName: "Blue Choice PPO", planType: "commercial", memberId: "ZGP800100299", groupNumber: "174589",
  copays: { pcp: 25, specialist: 50, urgentCare: 75, er: 250 }, deductible: null, coinsurancePercent: null, highDeductible: false,
});
