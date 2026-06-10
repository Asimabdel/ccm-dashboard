import { getDb } from "./db";
import {
  users,
  clinics,
  providers,
  patients,
  ccmTasks,
  ccmNotes,
  providerEscalations,
  followUpItems,
  billingRecords,
  notifications,
  productivityMetrics,
} from "../drizzle/schema";
import { eq, sql } from "drizzle-orm";

/** Current month in YYYY-MM */
export function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const CONDITIONS = [
  "Type 2 Diabetes",
  "Hypertension",
  "COPD",
  "CHF",
  "Chronic Kidney Disease",
  "Hyperlipidemia",
  "Asthma",
  "Atrial Fibrillation",
  "Osteoarthritis",
  "Depression",
  "Hypothyroidism",
  "GERD",
];

const LANGUAGES = ["English", "Spanish", "Vietnamese", "Mandarin"];

const FIRST_NAMES = [
  "James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda",
  "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph", "Jessica",
  "Thomas", "Sarah", "Charles", "Karen", "Maria", "Jose", "Mei", "Nguyen",
  "Carlos", "Ana", "Luis", "Rosa", "Wei", "Ling", "Minh", "Hoa",
  "George", "Helen", "Frank", "Dorothy", "Raymond", "Betty", "Gloria", "Henry",
  "Walter", "Ruth", "Carl", "Joan", "Arthur", "Shirley", "Roy", "Norma",
];

const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
  "Nguyen", "Tran", "Le", "Pham", "Chen", "Wang", "Liu", "Yang", "Perez",
  "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson",
];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

function pickSome<T>(arr: T[], seed: number, count: number): T[] {
  const out: T[] = [];
  for (let k = 0; k < count; k++) {
    out.push(arr[(seed * 7 + k * 13) % arr.length]);
  }
  return Array.from(new Set(out));
}

/**
 * Idempotent seed. Wipes CCM domain data (not users) and rebuilds a realistic dataset.
 * Returns a summary of created records.
 */
export async function seedDatabase(ownerOpenId: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const month = currentMonth();

  // --- Clean existing domain data in FK-safe order ---
  await db.delete(notifications);
  await db.delete(productivityMetrics);
  await db.delete(billingRecords);
  await db.delete(followUpItems);
  await db.delete(providerEscalations);
  await db.delete(ccmNotes);
  await db.delete(ccmTasks);
  await db.delete(patients);
  await db.delete(providers);
  await db.delete(clinics);

  // --- Clinics ---
  const clinicData = [
    { name: "Katy Family Medicine", location: "Katy", address: "1234 Katy Fwy, Katy, TX 77494", phone: "281-555-0101" },
    { name: "Cypress Primary Care", location: "Cypress", address: "5678 Barker Cypress Rd, Cypress, TX 77433", phone: "281-555-0202" },
    { name: "Richmond Avenue Clinic", location: "Richmond Avenue", address: "9012 Richmond Ave, Houston, TX 77063", phone: "713-555-0303" },
  ];
  await db.insert(clinics).values(clinicData);
  const clinicRows = await db.select().from(clinics);

  // --- Demo users for each role ---
  // We keep any existing real users; we add/update demo users by openId.
  const demoUsers = [
    { openId: "demo-admin", name: "Alex Morgan (Admin)", email: "admin@ccmdemo.com", role: "admin" as const, clinicLocation: "Katy", languagesSpoken: ["English"] },
    { openId: "demo-staff-1", name: "Priya Nair (Care Coordinator)", email: "priya@ccmdemo.com", role: "staff" as const, clinicLocation: "Katy", languagesSpoken: ["English", "Spanish"] },
    { openId: "demo-staff-2", name: "Daniel Reyes (Care Coordinator)", email: "daniel@ccmdemo.com", role: "staff" as const, clinicLocation: "Cypress", languagesSpoken: ["English", "Spanish"] },
    { openId: "demo-staff-3", name: "Grace Tran (Care Coordinator)", email: "grace@ccmdemo.com", role: "staff" as const, clinicLocation: "Richmond Avenue", languagesSpoken: ["English", "Vietnamese"] },
    { openId: "demo-provider-1", name: "Dr. Sarah Chen", email: "schen@ccmdemo.com", role: "provider" as const, clinicLocation: "Katy", languagesSpoken: ["English", "Mandarin"] },
    { openId: "demo-provider-2", name: "Dr. Michael Okafor", email: "mokafor@ccmdemo.com", role: "provider" as const, clinicLocation: "Cypress", languagesSpoken: ["English"] },
    { openId: "demo-billing", name: "Teresa Vaughn (Billing)", email: "billing@ccmdemo.com", role: "billing" as const, clinicLocation: "Katy", languagesSpoken: ["English"] },
    { openId: "demo-frontdesk", name: "Jordan Lee (Front Desk)", email: "frontdesk@ccmdemo.com", role: "front_desk" as const, clinicLocation: "Cypress", languagesSpoken: ["English"] },
  ];

  for (const u of demoUsers) {
    await db
      .insert(users)
      .values({ ...u, lastSignedIn: new Date() })
      .onDuplicateKeyUpdate({
        set: { name: u.name, email: u.email, role: u.role, clinicLocation: u.clinicLocation, languagesSpoken: u.languagesSpoken },
      });
  }

  const allUsers = await db.select().from(users);
  const staffUsers = allUsers.filter((u) => u.role === "staff");
  const providerUsers = allUsers.filter((u) => u.role === "provider");
  const adminUser = allUsers.find((u) => u.role === "admin");

  // --- Providers (clinical) ---
  const providerData = [
    { name: "Dr. Sarah Chen", title: "MD", clinicId: clinicRows[0].id, userId: providerUsers.find((u) => u.name?.includes("Chen"))?.id ?? null },
    { name: "Dr. Michael Okafor", title: "MD", clinicId: clinicRows[1].id, userId: providerUsers.find((u) => u.name?.includes("Okafor"))?.id ?? null },
    { name: "Dr. Emily Watson", title: "DO", clinicId: clinicRows[2].id, userId: null },
    { name: "Lauren Brooks", title: "NP", clinicId: clinicRows[0].id, userId: null },
    { name: "Marcus Hill", title: "PA-C", clinicId: clinicRows[1].id, userId: null },
  ];
  await db.insert(providers).values(providerData as any);
  const providerRows = await db.select().from(providers);

  // --- Patients (45) ---
  const patientCount = 45;
  const riskLevels: ("high" | "medium" | "low")[] = ["high", "medium", "low"];
  const patientValues: any[] = [];
  for (let i = 0; i < patientCount; i++) {
    const clinic = pick(clinicRows, i);
    const clinicProviders = providerRows.filter((p) => p.clinicId === clinic.id);
    const provider = clinicProviders[i % Math.max(clinicProviders.length, 1)] ?? providerRows[0];
    const risk = riskLevels[i % 3];
    const conditionCount = risk === "high" ? 3 : risk === "medium" ? 2 : 1;
    const staff = staffUsers.filter((s) => s.clinicLocation === clinic.location);
    const assignedStaff = staff.length ? staff[i % staff.length] : staffUsers[i % Math.max(staffUsers.length, 1)];
    const year = 1940 + (i % 45);
    patientValues.push({
      name: `${pick(FIRST_NAMES, i)} ${pick(LAST_NAMES, i * 3)}`,
      dateOfBirth: new Date(year, i % 12, (i % 27) + 1),
      phoneNumber: `713-555-${String(1000 + i).padStart(4, "0")}`,
      clinicId: clinic.id,
      providerId: provider.id,
      preferredLanguage: pick(LANGUAGES, i % (i % 4 === 0 ? 4 : 1)),
      chronicConditions: pickSome(CONDITIONS, i, conditionCount),
      insurance: i % 3 === 0 ? "Medicare Part B" : i % 3 === 1 ? "Medicare Advantage" : "Medicare + Medicaid",
      ccmEnrollmentStatus: i % 13 === 0 ? "inactive" : i % 17 === 0 ? "declined" : "active",
      consentStatus: i % 11 === 0 ? "pending" : "consented",
      riskLevel: risk,
      priorityLevel: risk,
      assignedStaffId: assignedStaff?.id ?? null,
      lastOfficeVisit: new Date(Date.now() - (30 + i) * 86400000),
      nextAppointment: i % 4 === 0 ? new Date(Date.now() + (i + 5) * 86400000) : null,
      lastCCMDate: new Date(Date.now() - (i + 28) * 86400000),
      notes: null,
    });
  }
  await db.insert(patients).values(patientValues);
  const patientRows = await db.select().from(patients);
  const activePatients = patientRows.filter((p) => p.ccmEnrollmentStatus === "active");

  // --- CCM Tasks for current month (one per active patient) ---
  const statuses = [
    "not_started",
    "assigned",
    "called_no_answer",
    "voicemail_left",
    "in_progress",
    "completed",
    "needs_provider_review",
    "needs_appointment",
    "documentation_incomplete",
    "ready_for_billing",
    "billed",
  ] as const;

  const taskValues: any[] = [];
  activePatients.forEach((p, i) => {
    const status = statuses[i % statuses.length];
    const completedish = ["completed", "ready_for_billing", "billed", "needs_provider_review", "documentation_incomplete", "needs_appointment"].includes(status);
    taskValues.push({
      patientId: p.id,
      month,
      assignedStaffId: p.assignedStaffId,
      priorityLevel: p.priorityLevel,
      status,
      dateContacted: completedish || status === "in_progress" ? new Date(Date.now() - (i % 10) * 86400000) : null,
      ccmNoteCompleted: completedish,
      providerReviewNeeded: status === "needs_provider_review",
      followUpAppointmentNeeded: status === "needs_appointment",
      appointmentScheduled: false,
      labsReferralsPending: status === "needs_appointment" ? ["A1C lab", "Cardiology referral"] : [],
      billingReady: ["ready_for_billing", "billed"].includes(status),
      comments: null,
    });
  });
  await db.insert(ccmTasks).values(taskValues);
  const taskRows = await db.select().from(ccmTasks);

  // --- CCM Notes for completed-ish tasks ---
  const completedTasks = taskRows.filter((t) => t.ccmNoteCompleted);
  const noteValues: any[] = [];
  completedTasks.forEach((t, i) => {
    const patient = patientRows.find((p) => p.id === t.patientId)!;
    const escalate = i % 5 === 0;
    noteValues.push({
      ccmTaskId: t.id,
      patientId: t.patientId,
      staffId: t.assignedStaffId ?? staffUsers[0]?.id ?? adminUser!.id,
      howFeeling: i % 2 === 0 ? "Reports feeling stable overall." : "Reports increased fatigue this month.",
      newSymptoms: escalate ? "New chest tightness on exertion and shortness of breath." : "No new symptoms reported.",
      medicationAdherence: i % 3 === 0 ? "Taking all medications as prescribed." : "Occasionally misses evening dose.",
      refillsNeeded: i % 4 === 0 ? "Metformin refill needed." : "No refills needed at this time.",
      erHospitalizationSince: escalate ? "ER visit 2 weeks ago for dizziness." : "No ER visits or hospitalizations.",
      recentSpecialistVisits: i % 3 === 0 ? "Saw cardiology last month." : "None since last contact.",
      bloodPressureReading: `${120 + (i % 30)}/${70 + (i % 20)}`,
      bloodSugarReading: `${100 + (i % 80)}`,
      upcomingAppointments: i % 2 === 0 ? "Follow-up with PCP in 4 weeks." : "None scheduled.",
      followUpNeeded: t.followUpAppointmentNeeded ? "Schedule office visit and labs." : "Routine monthly follow-up.",
      patientConcerns: escalate ? "Worried about new chest symptoms." : "No major concerns.",
      generatedNote: `Chronic Care Management note for ${patient.name}. Conditions reviewed: ${(patient.chronicConditions || []).join(", ")}. Patient ${i % 2 === 0 ? "reports feeling stable" : "reports increased fatigue"}. Medication adherence assessed and reinforced.`,
      escalationReason: escalate ? "New cardiac symptoms requiring provider review." : null,
      escalationFlag: escalate,
      followUpActions: t.followUpAppointmentNeeded ? ["Schedule office visit", "Order A1C lab"] : [],
    });
  });
  if (noteValues.length) await db.insert(ccmNotes).values(noteValues);
  const noteRows = await db.select().from(ccmNotes);

  // --- Provider escalations from flagged notes ---
  const flaggedNotes = noteRows.filter((n) => n.escalationFlag);
  const escStatuses = ["pending", "reviewed", "action_needed", "completed"] as const;
  const escValues: any[] = [];
  flaggedNotes.forEach((n, i) => {
    const patient = patientRows.find((p) => p.id === n.patientId)!;
    escValues.push({
      ccmNoteId: n.id,
      patientId: n.patientId,
      providerId: patient.providerId,
      reason: n.escalationReason ?? "Provider review requested.",
      escalationStatus: escStatuses[i % escStatuses.length],
      recommendedAction: i % escStatuses.length >= 2 ? "Schedule urgent office visit and EKG." : null,
      providerNotes: i % escStatuses.length === 1 ? "Reviewed; will follow up at next visit." : null,
      reviewedAt: i % escStatuses.length >= 1 ? new Date() : null,
    });
  });
  if (escValues.length) await db.insert(providerEscalations).values(escValues);

  // --- Follow-up items ---
  const fuTypes = ["office_visit", "lab_work", "referral", "imaging", "testing", "medication_refill"] as const;
  const fuStatuses = ["pending", "scheduled", "completed"] as const;
  const needAppt = taskRows.filter((t) => t.followUpAppointmentNeeded || t.status === "needs_appointment");
  const fuValues: any[] = [];
  needAppt.forEach((t, i) => {
    fuValues.push({
      ccmTaskId: t.id,
      patientId: t.patientId,
      type: fuTypes[i % fuTypes.length],
      status: fuStatuses[i % fuStatuses.length],
      scheduledDate: i % fuStatuses.length >= 1 ? new Date(Date.now() + (i + 3) * 86400000) : null,
      completedDate: i % fuStatuses.length === 2 ? new Date() : null,
      notes: null,
    });
  });
  // add a few generic follow-ups too
  taskRows.slice(0, 8).forEach((t, i) => {
    fuValues.push({
      ccmTaskId: t.id,
      patientId: t.patientId,
      type: fuTypes[(i + 2) % fuTypes.length],
      status: "pending",
      scheduledDate: null,
      completedDate: null,
      notes: "Generated during monthly CCM call.",
    });
  });
  if (fuValues.length) await db.insert(followUpItems).values(fuValues);

  // --- Billing records ---
  const billingValues: any[] = [];
  taskRows.forEach((t) => {
    const docComplete = t.ccmNoteCompleted;
    const providerReviewDone = !t.providerReviewNeeded;
    const contacted = !!t.dateContacted || ["in_progress", "completed", "ready_for_billing", "billed"].includes(t.status as string);
    let billingStatus:
      | "not_started"
      | "in_progress"
      | "documentation_incomplete"
      | "provider_review_pending"
      | "ready_for_billing"
      | "billed"
      | "denied"
      | "needs_correction" = "not_started";
    if (t.status === "billed") billingStatus = "billed";
    else if (docComplete && providerReviewDone) billingStatus = "ready_for_billing";
    else if (t.status === "documentation_incomplete") billingStatus = "documentation_incomplete";
    else if (t.providerReviewNeeded) billingStatus = "provider_review_pending";
    else if (contacted) billingStatus = "in_progress";

    billingValues.push({
      ccmTaskId: t.id,
      patientId: t.patientId,
      month,
      timeThresholdMet: true,
      documentationComplete: docComplete,
      providerAssociated: true,
      carePlanReviewed: docComplete,
      noMissingFields: docComplete,
      providerReviewCompleted: providerReviewDone,
      billingStatus,
      claimSubmittedDate: billingStatus === "billed" ? new Date() : null,
      claimDenialReason: null,
    });
  });
  if (billingValues.length) await db.insert(billingRecords).values(billingValues);

  // --- Notifications for admin / providers / staff ---
  const notifValues: any[] = [];
  if (adminUser) {
    flaggedNotes.slice(0, 3).forEach((n) => {
      const patient = patientRows.find((p) => p.id === n.patientId)!;
      notifValues.push({
        userId: adminUser.id,
        type: "urgent_symptom",
        title: "Urgent symptom flagged",
        content: `${patient.name} reported new cardiac symptoms during CCM call.`,
        relatedPatientId: patient.id,
        relatedCCMTaskId: n.ccmTaskId,
        read: false,
      });
    });
  }
  providerUsers.forEach((pu, i) => {
    notifValues.push({
      userId: pu.id,
      type: "escalation",
      title: "Patient escalated for review",
      content: "A patient on your panel has been escalated and needs your review.",
      relatedPatientId: activePatients[i]?.id ?? null,
      relatedCCMTaskId: null,
      read: false,
    });
  });
  staffUsers.forEach((su) => {
    notifValues.push({
      userId: su.id,
      type: "not_reached",
      title: "Patients not reached",
      content: "You have patients with multiple call attempts and no answer. Please follow up.",
      relatedPatientId: null,
      relatedCCMTaskId: null,
      read: false,
    });
  });
  if (notifValues.length) await db.insert(notifications).values(notifValues);

  // --- Productivity metrics per staff ---
  const pmValues: any[] = [];
  staffUsers.forEach((su) => {
    const staffTasks = taskRows.filter((t) => t.assignedStaffId === su.id);
    const completed = staffTasks.filter((t) => t.ccmNoteCompleted).length;
    const notReached = staffTasks.filter((t) => ["called_no_answer", "voicemail_left"].includes(t.status as string)).length;
    const review = staffTasks.filter((t) => t.providerReviewNeeded).length;
    const ready = staffTasks.filter((t) => t.billingReady).length;
    pmValues.push({
      month,
      staffId: su.id,
      providerId: null,
      clinicId: clinicRows.find((c) => c.location === su.clinicLocation)?.id ?? null,
      totalCCMsCompleted: completed,
      totalCCMsAssigned: staffTasks.length,
      totalTimeSpentMinutes: 0,
      patientsNotReached: notReached,
      patientsNeedingReview: review,
      patientsReadyForBilling: ready,
    });
  });
  if (pmValues.length) await db.insert(productivityMetrics).values(pmValues);

  return {
    clinics: clinicRows.length,
    providers: providerRows.length,
    demoUsers: demoUsers.length,
    patients: patientRows.length,
    activePatients: activePatients.length,
    tasks: taskRows.length,
    notes: noteRows.length,
    escalations: escValues.length,
    followUps: fuValues.length,
    billingRecords: billingValues.length,
    notifications: notifValues.length,
    month,
  };
}

/** Whether the database already has seed data */
export async function isSeeded(): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const res = await db.select({ c: sql<number>`COUNT(*)` }).from(patients);
  return (res[0]?.c ?? 0) > 0;
}
