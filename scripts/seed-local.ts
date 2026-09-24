/**
 * LOCAL-ONLY demo data for the Workspace (fictional people, never real PHI).
 *
 *   DATABASE_URL=mysql://dev:devpass@127.0.0.1:3307/ccm node_modules/.bin/tsx scripts/seed-local.ts
 *
 * Runs the stock CCM demo seed, then imports a generated Practice Fusion-style
 * schedule through the real import code, moves some patients along the flow
 * board, and creates tasks. Refuses to run against anything but localhost.
 * Every demo login uses the password printed at the end.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { seedDatabase } from "../server/seed";
import { hashPassword } from "../server/password";
import * as ws from "../server/workspaceDb";
import { appointments, clinics, patients, providers, staffProfiles, users } from "../drizzle/schema";
import { addDays, localDateStr } from "../shared/workforce";
import { FLOW_COLUMNS, nextClinicDay, parseScheduleCsv, type FlowStatus } from "../shared/workspace";

const PASSWORD = "Workspace2026";

const url = process.env.DATABASE_URL ?? "";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error("✗ Refusing to seed: DATABASE_URL must point at a local database (127.0.0.1 / localhost).");
  process.exit(1);
}

const EXTRA_NAMES = ["Nora Castillo", "Derek Pham", "Olivia Grant", "Samuel Ortiz", "Ivy Nguyen", "Caleb Brooks", "Maya Patel", "Luis Romero", "Hannah Kim", "Owen Carter", "Zoe Alvarez", "Elijah Moore"];
const VISIT_TYPES = ["Follow Up", "Chronic Care Visit", "Annual Wellness", "Sick Visit", "New Patient", "Lab Review"];
const REASONS = ["BP check", "Diabetes follow-up", "Medication review", "Cough x3 days", "Annual physical", "Lab results", "Back pain", ""];

async function main() {
  const db = (await getDb())!;
  console.log("• Clearing Workspace tables");
  await db.execute(sql`SET FOREIGN_KEY_CHECKS=0`);
  for (const t of ["workTaskActivities", "workTasks", "appointmentStatusEvents", "appointments", "scheduleImports", "opportunityActions"]) {
    await db.execute(sql.raw(`DELETE FROM \`${t}\``));
  }
  // The stock seed recreates clinics, so detach anything pointing at them first.
  await db.execute(sql`UPDATE staffProfiles SET homeClinicId = NULL`);
  await db.execute(sql`SET FOREIGN_KEY_CHECKS=1`);

  console.log("• Running the CCM demo seed (clinics, providers, 45 fictional patients)");
  await seedDatabase(null);

  // A fourth clinic so the selector reflects the real practice.
  const [{ n: clinicCount }] = await db.select({ n: sql<number>`count(*)` }).from(clinics);
  if (Number(clinicCount) < 4) await db.insert(clinics).values({ name: "Sugar Land Primary Care", location: "Sugar Land", address: "100 Demo Rd, Sugar Land, TX 77479", phone: "281-555-0404" });

  console.log("• Demo logins");
  const hash = await hashPassword(PASSWORD);
  await db.insert(users).values({ openId: "demo-ma", name: "Rosa Diaz (MA)", email: "ma@ccmdemo.com", role: "medical_assistant", clinicLocation: "Katy", loginMethod: "password" }).onDuplicateKeyUpdate({ set: { role: "medical_assistant" } });
  await db.update(users).set({ passwordHash: hash, passwordSetAt: new Date(), mustChangePassword: false, loginMethod: "password" }).where(sql`${users.email} LIKE '%@ccmdemo.com'`);
  const allUsers = await db.select().from(users);
  const byEmail = (e: string) => allUsers.find((u) => u.email === e)!;
  const admin = byEmail("admin@ccmdemo.com");
  const ma = byEmail("ma@ccmdemo.com");
  const frontDesk = byEmail("frontdesk@ccmdemo.com");
  const allClinics = await db.select().from(clinics);
  const katy = allClinics.find((c) => c.location === "Katy")!;
  await db.insert(staffProfiles).values({ userId: ma.id, homeClinicId: katy.id, canFloat: false }).onDuplicateKeyUpdate({ set: { homeClinicId: katy.id, canFloat: false } });

  const actor = (u: typeof admin): ws.WorkspaceActor => ({ id: u.id, name: u.name, role: u.role, clinicIds: null });

  // ---- Schedule: build a Practice Fusion-style CSV and import it for real ----
  const provs = await db.select().from(providers);
  const pats = await db.select().from(patients);
  const today = localDateStr();
  const nextDay = nextClinicDay(today);
  const dob = (d: Date | null) => (d ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}` : "");
  const time = (m: number) => {
    const h = Math.floor(m / 60), mm = m % 60;
    return `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };
  const mdy = (d: string) => { const [y, m, dd] = d.split("-"); return `${Number(m)}/${Number(dd)}/${y}`; };

  const rows: string[] = ['"Appointment Date","Start Time","Duration","Patient","DOB","Phone","Provider","Facility","Appointment Type","Chief Complaint","Status"'];
  let k = 0;
  const usedToday = new Set<number>();
  const addDay = (date: string, perProvider: number, skipEvery: number, statusFor?: (i: number) => string) => {
    for (const p of provs) {
      const clinic = allClinics.find((c) => c.id === p.clinicId)!;
      const clinicPats = pats.filter((x) => x.clinicId === p.clinicId);
      let slot = 8 * 60;
      for (let i = 0; i < perProvider; i++, k++) {
        if (skipEvery && i > 0 && i % skipEvery === 0) slot += 40; // leave an opening
        const useRoster = k % 4 !== 3 && clinicPats.length;
        const pt = useRoster ? clinicPats[(k * 7) % clinicPats.length]! : null;
        if (date === today && pt) usedToday.add(pt.id);
        const name = pt ? pt.name : EXTRA_NAMES[k % EXTRA_NAMES.length]!;
        const [first, ...rest] = name.split(" ");
        rows.push([
          mdy(date), time(slot), "20", `"${rest.join(" ")}, ${first}"`, pt ? dob(pt.dateOfBirth) : `${(k % 12) + 1}/${(k % 27) + 1}/19${50 + (k % 40)}`,
          pt?.phoneNumber ?? `281-555-${String(2000 + k).padStart(4, "0")}`, p.name, `${clinic.location} Office`, VISIT_TYPES[k % VISIT_TYPES.length], REASONS[k % REASONS.length], statusFor?.(i) ?? "Scheduled",
        ].join(","));
        slot += 20;
      }
    }
  };
  addDay(today, 13, 6);
  addDay(nextDay, 10, 3);
  // Two past days with a few no-shows (feeds "Missed appointment").
  addDay(addDays(today, -6), 6, 0, (i) => (i % 3 === 1 ? "No Show" : "Completed"));
  addDay(addDays(today, -20), 5, 0, (i) => (i === 2 ? "No Show" : "Completed"));

  const csv = rows.join("\n");
  const parsed = parseScheduleCsv(csv);
  if (parsed.errors.length) console.warn("  parse errors:", parsed.errors.slice(0, 3));
  const res = await ws.commitSchedule(actor(frontDesk), { fileName: "demo-schedule.csv", rows: parsed.rows, defaultClinicId: null, cancelMissing: false });
  console.log(`• Imported ${res.rows} appointments (${res.linked} linked to roster patients) for ${res.dates.join(", ")}`);

  // ---- Move today's patients along the board ----
  const todays = (await db.select().from(appointments).where(eq(appointments.date, today))).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const now = Date.now();
  // Patients in the first ~40% are done; the next few are in clinic at various stages.
  const doneCut = Math.floor(todays.length * 0.4);
  const inFlow: FlowStatus[] = ["checkout", "with_provider", "with_provider", "roomed", "roomed", "checked_in", "checked_in", "arrived", "arrived", "roomed", "with_provider", "arrived"];
  for (let i = 0; i < todays.length; i++) {
    const a = todays[i]!;
    let to: FlowStatus | null = null;
    if (i < doneCut) to = i % 11 === 5 ? "no_show" : "completed";
    else if (i < doneCut + inFlow.length) to = inFlow[i - doneCut]!;
    if (!to) continue;
    await ws.moveAppointment(actor(admin), { appointmentId: a.id, to, confirmed: true, room: to === "roomed" || to === "with_provider" ? `Exam ${(i % 5) + 1}` : undefined });
    // Spread the timestamps so waits look real (the move stamps "now").
    const arrivedMinAgo = to === "completed" ? 120 + i * 3 : 5 + ((i * 7) % 38);
    const arrivedAt = new Date(now - arrivedMinAgo * 60_000);
    const step = (n: number) => new Date(arrivedAt.getTime() + n * 60_000);
    const idx = FLOW_COLUMNS.indexOf(to as (typeof FLOW_COLUMNS)[number]);
    if (to !== "no_show") {
      await db.update(appointments).set({
        arrivedAt,
        checkedInAt: idx >= 2 ? step(3) : null,
        roomedAt: idx >= 3 ? step(Math.min(arrivedMinAgo - 2, 14)) : null,
        withProviderAt: idx >= 4 ? step(Math.min(arrivedMinAgo - 1, 22)) : null,
        checkoutAt: idx >= 5 ? step(Math.min(arrivedMinAgo, 45)) : null,
        completedAt: idx >= 6 ? step(50) : null,
      }).where(eq(appointments.id, a.id));
    }
  }
  console.log(`• Flow board: ${doneCut} done, ${inFlow.length} in clinic, the rest scheduled`);

  // ---- Tasks ----
  const somePatients = pats.filter((p) => p.clinicId === katy.id).slice(0, 6);
  const t = async (who: typeof admin, input: ws.CreateTaskInput) => ws.createTask(actor(who), input);
  await t(admin, { title: "Review no-show list and assign callbacks", priority: "high", category: "patient_call", dueDate: today, clinicId: null });
  await t(admin, { title: "Approve next week's MA schedule", priority: "normal", category: "administrative", dueDate: addDays(today, 3) });
  const late = await t(admin, { title: "Follow up on missing prior-auth fax", priority: "urgent", category: "prior_auth", dueDate: addDays(today, -2), patientId: somePatients[0]?.id ?? null });
  await ws.updateTask(actor(admin), late.id, { status: "in_progress" });
  await ws.commentTask(actor(admin), late.id, "Called the plan — they need the updated form. Resending today.");
  await t(admin, { title: "Call to reschedule missed visit", priority: "normal", category: "patient_call", dueDate: today, patientId: somePatients[1]?.id ?? null, assignedRole: "front_desk", assignedUserId: null });
  await t(admin, { title: "Confirm tomorrow's new-patient paperwork", priority: "normal", category: "front_desk", dueDate: nextDay, assignedRole: "front_desk", assignedUserId: null, clinicId: katy.id });
  await t(admin, { title: "Room turnover checklist — Exam 2 supplies low", priority: "high", category: "other", dueDate: today, assignedUserId: ma.id, clinicId: katy.id });
  await t(admin, { title: "Collect updated insurance card", priority: "normal", category: "front_desk", dueDate: addDays(today, -1), assignedUserId: ma.id, clinicId: katy.id, patientId: somePatients[2]?.id ?? null });
  await t(admin, { title: "Refill request: confirm pharmacy on file", priority: "normal", category: "medication_request", dueDate: today, assignedRole: "staff", assignedUserId: null, patientId: somePatients[3]?.id ?? null });
  await t(admin, { title: "Outreach: CCM consent renewal", priority: "low", category: "care_management", dueDate: addDays(today, 5), assignedRole: "staff", assignedUserId: null, patientId: somePatients[4]?.id ?? null });
  const done = await t(admin, { title: "Morning huddle notes posted", priority: "normal", category: "administrative", dueDate: today });
  await ws.updateTask(actor(admin), done.id, { status: "completed" });
  console.log("• Created 10 tasks");

  console.log(`\n✓ Local demo ready. Sign in with any of these (password: ${PASSWORD})`);
  for (const e of ["admin@ccmdemo.com", "frontdesk@ccmdemo.com", "priya@ccmdemo.com", "schen@ccmdemo.com", "billing@ccmdemo.com", "ma@ccmdemo.com"]) console.log(`  ${e}  (${byEmail(e)?.role})`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
