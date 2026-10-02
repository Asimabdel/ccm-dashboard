// Where patient emails go (the practice's choices, 2026-10-02):
// - a matched patient → their provider's team (the provider + the MAs on the team; Admin → Providers);
// - matched, but no provider team → the MAs at the patient's clinic;
// - not matched to anyone → the time-off approver (Asim) as a "Who is this?" task; picking the patient
//   on Patient emails moves that task to the patient's provider team.
// Plus the one-time jobs: fill each provider's team with the MAs at their clinic, and re-route
// the emails already waiting.
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { clinics, emailMessages, providerTeamMembers, providers, shifts, staffProfiles, users, workTaskActivities, workTasks } from "../drizzle/schema";
import { addDays, localDateStr } from "../shared/workforce";
import { subjectCare, providerTeamAssignee } from "./workspaceDb";

async function db() {
  const d = await getDb();
  if (!d) throw new Error("Database not available");
  return d;
}

export interface EmailAssignee { assignedUserId: number | null; assignedRole: string | null; clinicId: number | null; who: string }

/** Unmatched mail goes to the time-off approver (Asim); with none set, the admins' queue. */
export async function unmatchedAssignee(): Promise<EmailAssignee> {
  const { getTimeOffApprover } = await import("./workforceDb");
  const a = await getTimeOffApprover();
  return a ? { assignedUserId: a.userId, assignedRole: null, clinicId: null, who: a.name ?? "the approver" } : { assignedUserId: null, assignedRole: "admin", clinicId: null, who: "the admins" };
}

/** A matched patient's email: their provider's team → the MAs at their clinic → the unmatched-mail person. */
export async function emailAssignee(subjectKey: string): Promise<EmailAssignee> {
  const team = await providerTeamAssignee(subjectKey);
  if (team) return team;
  const { directoryEntry } = await import("./directoryDb");
  const clinicId = (await directoryEntry(subjectKey))?.clinicId ?? (await subjectCare(subjectKey))?.clinicId ?? null;
  if (clinicId) {
    const [c] = await (await db()).select({ name: clinics.name }).from(clinics).where(eq(clinics.id, clinicId)).limit(1);
    return { assignedUserId: null, assignedRole: "medical_assistant", clinicId, who: `the MAs at ${c?.name ?? "their clinic"}` };
  }
  return unmatchedAssignee();
}

// ---------------------------------------------------------------------------
// One-time: provider teams = the provider + the MAs at the provider's clinic
// ---------------------------------------------------------------------------

/** IAM-only. Dry run unless apply. Keeps anyone already on a team. Names only (staff, not patients). */
export async function autoProviderTeams(opts: { apply: boolean }) {
  const d = await db();
  const provs = await d.select({ id: providers.id, name: providers.name, clinicId: providers.clinicId, userId: providers.userId }).from(providers);
  const mas = await d.select({ id: users.id, name: users.name, clinicId: staffProfiles.homeClinicId, active: staffProfiles.active })
    .from(users).innerJoin(staffProfiles, eq(staffProfiles.userId, users.id)).where(eq(users.role, "medical_assistant"));
  const existing = await d.select({ providerId: providerTeamMembers.providerId, userId: providerTeamMembers.userId }).from(providerTeamMembers);
  const have = new Set(existing.map((x) => `${x.providerId}|${x.userId}`));
  const clinicName = new Map((await d.select({ id: clinics.id, name: clinics.name }).from(clinics)).map((c) => [c.id, c.name]));
  const from = addDays(localDateStr(), -30), to = addDays(localDateStr(), 30);
  const report: { provider: string; clinic: string | null; clinicFrom: string; team: string[]; adding: number }[] = [];
  const noClinic: string[] = [];
  let added = 0;
  for (const p of provs) {
    // Their clinic: the provider record's, else where their shifts are, else their Workforce home clinic.
    let clinicId = p.clinicId, clinicFrom = "provider record";
    if (!clinicId && p.userId) {
      const [top] = await d.select({ clinicId: shifts.clinicId, n: sql<number>`count(*)` }).from(shifts)
        .where(and(eq(shifts.userId, p.userId), gte(shifts.date, from), sql`${shifts.date} <= ${to}`)).groupBy(shifts.clinicId).orderBy(desc(sql`count(*)`)).limit(1);
      if (top?.clinicId) { clinicId = top.clinicId; clinicFrom = "their shifts"; }
      if (!clinicId) {
        const [home] = await d.select({ clinicId: staffProfiles.homeClinicId }).from(staffProfiles).where(eq(staffProfiles.userId, p.userId)).limit(1);
        if (home?.clinicId) { clinicId = home.clinicId; clinicFrom = "Workforce home clinic"; }
      }
    }
    if (!clinicId) { noClinic.push(p.name); continue; }
    const team = mas.filter((m) => m.active && m.clinicId === clinicId);
    const adding = team.filter((m) => !have.has(`${p.id}|${m.id}`));
    if (opts.apply && adding.length) {
      await d.insert(providerTeamMembers).values(adding.map((m) => ({ providerId: p.id, userId: m.id })));
      for (const m of adding) have.add(`${p.id}|${m.id}`);
    }
    added += adding.length;
    report.push({ provider: p.name, clinic: clinicName.get(clinicId) ?? null, clinicFrom, team: team.map((m) => m.name ?? `#${m.id}`), adding: adding.length });
  }
  return { applied: opts.apply, membersAdded: added, teams: report, providersWithoutClinic: noClinic };
}

// ---------------------------------------------------------------------------
// One-time: re-route emails already in the system
// ---------------------------------------------------------------------------

/**
 * IAM-only. Dry run unless apply. (1) Waiting emails from the last `days` are matched again (now also
 * against Practice Fusion's addresses, names and phones) and routed; (2) still-unmatched ones get a
 * "Who is this?" task; (3) open, untouched email tasks move to the patient's provider team / clinic MAs.
 * Counts only.
 */
export async function refreshEmailRouting(opts: { apply: boolean; days: number; deadline: number }) {
  const d = await db();
  const since = new Date(Date.now() - opts.days * 86_400_000);
  const g = await import("./gmailSync");
  const counts = { rematched: 0, whoIsThisTasks: 0, stillWaiting: 0, reroutedTasks: 0, toTeams: 0, toClinicMas: 0, toApprover: 0, done: true };
  // 1 + 2: waiting emails.
  const waiting = await d.select().from(emailMessages).where(and(eq(emailMessages.status, "needs_patient"), eq(emailMessages.historical, false), gte(emailMessages.receivedAt, since)));
  const idx = waiting.length ? await g.matchIndex() : null;
  for (const m of waiting) {
    if (Date.now() > opts.deadline) { counts.done = false; break; }
    const r = await g.routeWaitingEmail(m, idx!, opts.apply);
    if (r === "matched") counts.rematched++;
    else if (r === "task") counts.whoIsThisTasks++;
    else counts.stillWaiting++;
  }
  // 3: open email tasks nobody has touched.
  const open = await d.select({ t: workTasks, subjectKey: emailMessages.subjectKey }).from(workTasks)
    .innerJoin(emailMessages, eq(emailMessages.taskId, workTasks.id))
    .where(and(eq(workTasks.sourceType, "email"), eq(workTasks.status, "open"), gte(workTasks.createdAt, since), eq(emailMessages.status, "assigned")));
  for (const { t, subjectKey } of open) {
    if (Date.now() > opts.deadline) { counts.done = false; break; }
    if (!subjectKey) continue;
    const touched = await d.select({ id: workTaskActivities.id }).from(workTaskActivities)
      .where(and(eq(workTaskActivities.taskId, t.id), inArray(workTaskActivities.type, ["comment", "status_changed"]))).limit(1);
    if (touched.length) continue;
    const who = await emailAssignee(subjectKey);
    if (who.assignedUserId === t.assignedUserId && who.assignedRole === t.assignedRole) continue;
    if (opts.apply) {
      await d.update(workTasks).set({ assignedUserId: who.assignedUserId, assignedRole: who.assignedUserId ? null : who.assignedRole, clinicId: who.clinicId ?? t.clinicId }).where(eq(workTasks.id, t.id));
      await d.insert(workTaskActivities).values({ taskId: t.id, userId: t.createdByUserId, type: "assigned", meta: { to: who.assignedUserId ? String(who.assignedUserId) : who.assignedRole, reason: "email routing" } });
      await d.update(emailMessages).set({ assignedUserId: who.assignedUserId }).where(eq(emailMessages.taskId, t.id));
    }
    counts.reroutedTasks++;
    if (who.assignedRole?.startsWith("team:")) counts.toTeams++;
    else if (who.assignedRole === "medical_assistant") counts.toClinicMas++;
    else counts.toApprover++;
  }
  return { applied: opts.apply, days: opts.days, waitingChecked: waiting.length, openTasksChecked: open.length, ...counts };
}


// ---------------------------------------------------------------------------
// AI read of unmatched emails (Bedrock, covered by the AWS BAA): who is the email about?
// ---------------------------------------------------------------------------

/** Everyone an email could be about, with a date of birth: CCM roster, schedule, Practice Fusion. */
async function peopleWithDob() {
  const { buildNameDobIndex } = await import("./workspaceDb");
  const { fhirPatients } = await import("../drizzle/schema");
  const out = Array.from((await buildNameDobIndex()).entries()).map(([k, v]) => ({ ...v, dob: k.split("|")[1] ?? null }));
  const seen = new Set(out.map((p) => `${p.key}|${p.dob}`));
  for (const f of await (await db()).select({ key: fhirPatients.subjectKey, patientId: fhirPatients.patientId, name: fhirPatients.name, dob: fhirPatients.dob }).from(fhirPatients)) {
    if (!f.name || !f.dob || seen.has(`${f.key}|${f.dob}`)) continue;
    out.push({ key: f.key, patientId: f.patientId, name: f.name, dob: f.dob });
  }
  return out;
}

/**
 * Read waiting (unmatched) emails from the last 30 days, newest first, until the deadline. A name +
 * date of birth matching exactly one patient routes the email to them; a weaker match (a unique name,
 * same birthday + last name, or a phone number) is saved as a suggestion on its "Who is this?" task.
 * Counts only.
 */
export async function readPendingEmails(opts: { deadline: number }) {
  if (!process.env.BEDROCK_MODEL_ID) return { read: 0, routed: 0, suggested: 0 };
  const d = await db();
  const { invokeLLM } = await import("./_core/llm");
  const { EMAIL_AI_PROMPT, parseEmailReading } = await import("../shared/email");
  const { makePersonMatcher } = await import("../shared/fax");
  const { buildPhoneIndex } = await import("./workspaceDb");
  const g = await import("./gmailSync");
  const since = new Date(Date.now() - 30 * 86_400_000);
  let read = 0, routed = 0, suggested = 0;
  let match: ReturnType<typeof makePersonMatcher> | null = null;
  let phones: Awaited<ReturnType<typeof buildPhoneIndex>> | null = null;
  // Each read takes a few seconds: don't start one without time to finish it.
  while (Date.now() < opts.deadline - 5_000) {
    const [m] = await d.select().from(emailMessages)
      .where(and(eq(emailMessages.status, "needs_patient"), eq(emailMessages.historical, false), sql`${emailMessages.aiAt} IS NULL`, gte(emailMessages.receivedAt, since)))
      .orderBy(desc(emailMessages.receivedAt)).limit(1);
    if (!m) break;
    read++;
    try {
      const res = await invokeLLM({ messages: [
        { role: "system", content: EMAIL_AI_PROMPT },
        { role: "user", content: `From: ${m.fromName ?? ""} <${m.fromEmail ?? ""}>\nSubject: ${m.subject ?? ""}\n\n${(m.preview ?? "").slice(0, 1500)}` },
      ] });
      const raw = res.choices[0]?.message?.content;
      const r = parseEmailReading(typeof raw === "string" ? raw : JSON.stringify(raw ?? ""));
      if (!r) throw new Error("The AI couldn't read this email");
      match ??= makePersonMatcher(await peopleWithDob());
      phones ??= await buildPhoneIndex();
      // The patient's name: the one written in the email, else (when the writer is the patient) the sender's.
      const name = r.patientName ?? (r.writerIsPatient !== false ? m.fromName : null);
      const hit = name ? match(name, r.dob) : null;
      let suggestion: { key: string; patientId: number | null; name: string } | null = hit && !hit.sure ? hit.person : null;
      if (!hit && r.phone) suggestion = phones.get(r.phone) ?? null;
      await d.update(emailMessages).set({
        aiPatientName: r.patientName?.slice(0, 255) ?? null, aiDob: r.dob, aiAt: new Date(), aiError: null,
        suggestedKey: suggestion?.key ?? null, suggestedName: suggestion?.name.slice(0, 255) ?? null,
      }).where(eq(emailMessages.id, m.id));
      if (hit?.sure) {
        await g.assignToSubject(m, { key: hit.person.key, patientId: hit.person.patientId, name: hit.person.name }, "ai");
        routed++;
      } else if (suggestion && m.taskId) {
        const [t] = await d.select({ description: workTasks.description, createdBy: workTasks.createdByUserId }).from(workTasks).where(eq(workTasks.id, m.taskId)).limit(1);
        const note = `AI read this email: it looks like ${suggestion.name}. Confirm (or pick someone else) on Patient emails.`;
        if (t) {
          await d.update(workTasks).set({ description: `${note}\n\n${t.description ?? ""}`.slice(0, 60_000) }).where(eq(workTasks.id, m.taskId));
          await d.insert(workTaskActivities).values({ taskId: m.taskId, userId: t.createdBy, type: "comment", body: note });
        }
        suggested++;
      }
    } catch (e) {
      await d.update(emailMessages).set({ aiAt: new Date(), aiError: (e as Error).message.slice(0, 255) }).where(eq(emailMessages.id, m.id));
    }
  }
  if (read) console.log(`[email-read] ${JSON.stringify({ read, routed, suggested })}`); // counts only
  return { read, routed, suggested };
}
