/**
 * LOCAL-ONLY made-up insurance card photos for the copay estimates (fictional people, never real PHI).
 *
 *   DATABASE_URL=mysql://dev:devpass@127.0.0.1:3307/ccm node_modules/.bin/tsx scripts/seed-card-photos.ts
 *
 * Run scripts/seed-local.ts and scripts/seed-visit-cost.ts first. Gives roster patient 7 (no paid visits)
 * a health-history-form card photo (a tiny blank image: locally CARD_READ_FAKE=1 makes up what the AI
 * "reads"), and opens Master Billing to the local demo admin. Refuses anything but a local database.
 */
import { createHash, randomBytes } from "node:crypto";
import { asc, eq, like } from "drizzle-orm";
import { getDb } from "../server/db";
import { appSettings, insuranceCardReads, intakeFiles, intakePackets, patients, planCopays, users } from "../drizzle/schema";
import { addDays, localDateStr } from "../shared/workforce";

const url = process.env.DATABASE_URL ?? "";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error("✗ Refusing to seed: DATABASE_URL must point at a local database (127.0.0.1 / localhost).");
  process.exit(1);
}

// A 1×1 white PNG: the fake reader doesn't look at it.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

async function main() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const roster = await db.select().from(patients).orderBy(asc(patients.id)).limit(7);
  const pt = roster[6];
  if (!pt) throw new Error("Run scripts/seed-local.ts first.");

  // Replace this script's own rows.
  const old = await db.select({ id: intakePackets.id }).from(intakePackets).where(like(intakePackets.name, "%(card seed)%"));
  for (const o of old) await db.delete(intakeFiles).where(eq(intakeFiles.packetId, o.id));
  await db.delete(intakePackets).where(like(intakePackets.name, "%(card seed)%"));
  await db.delete(insuranceCardReads);
  await db.delete(planCopays);

  const token = randomBytes(24).toString("hex");
  const [res] = await db.insert(intakePackets).values({
    tokenHash: createHash("sha256").update(token).digest("hex"), tokenSealed: "local-seed", subjectKey: `p:${pt.id}`, patientId: pt.id,
    name: `${pt.name} (card seed)`, dob: pt.dateOfBirth ? pt.dateOfBirth.toISOString().slice(0, 10) : "1950-01-01", forms: ["medical_intake"], clinicId: pt.clinicId,
    status: "completed", expiresAt: new Date(`${addDays(localDateStr(), 30)}T12:00:00`),
  });
  const packetId = (res as unknown as { insertId: number }).insertId;
  const bytes = Buffer.from(PNG, "base64");
  await db.insert(intakeFiles).values({ packetId, kind: "insurance_front", mime: "image/png", data: PNG, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });

  // Master Billing for the local demo admin.
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.email, "admin@ccmdemo.com")).limit(1);
  if (admin) await db.insert(appSettings).values({ key: "master_billing_access", value: { userIds: [admin.id] } }).onDuplicateKeyUpdate({ set: { value: { userIds: [admin.id] } } });

  console.log(`✓ Card photo (made up) on ${pt.name}'s health history form; card readings and plan answers cleared${admin ? "; Master Billing open to the local admin" : ""}.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
