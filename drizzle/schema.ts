import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  boolean,
  decimal,
  json,
  datetime,
  index,
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extended with role-based access control for CCM program.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  passwordHash: varchar("passwordHash", { length: 255 }),
  passwordSetAt: timestamp("passwordSetAt"),
  mustChangePassword: boolean("mustChangePassword").default(false).notNull(),
  // medical_assistant is a workforce-only role: it can use the schedule / time
  // clock / My Day pages but is blocked from every patient (PHI) endpoint.
  role: mysqlEnum("role", ["admin", "staff", "provider", "billing", "front_desk", "user", "medical_assistant"]).default("user").notNull(),
  // How many days per week this coordinator works — used to compute per-work-day
  // CCM averages and goal pacing on their dashboard.
  workDaysPerWeek: int("workDaysPerWeek").default(5),
  clinicLocation: varchar("clinicLocation", { length: 255 }),
  languagesSpoken: json("languagesSpoken").$type<string[]>().default([]),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Clinic locations for multi-location support
 */
export const clinics = mysqlTable("clinics", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  location: varchar("location", { length: 255 }).notNull(),
  address: text("address"),
  phone: varchar("phone", { length: 20 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Clinic = typeof clinics.$inferSelect;
export type InsertClinic = typeof clinics.$inferInsert;

/**
 * Providers (physicians, NPs, PAs)
 */
export const providers = mysqlTable("providers", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").references(() => users.id),
  name: varchar("name", { length: 255 }).notNull(),
  title: varchar("title", { length: 100 }),
  clinicId: int("clinicId").references(() => clinics.id),
  // Alternate names this provider is known by (e.g. on imported sheets), so a
  // patient import can resolve "Dr. Sudad" -> "Al Hadad" or "Magdalene" -> "Maggie".
  aliases: json("aliases").$type<string[]>().default([]),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Provider = typeof providers.$inferSelect;
export type InsertProvider = typeof providers.$inferInsert;

/**
 * Pending team invitations for onboarding workers before first sign-in.
 */
export const teamInvites = mysqlTable("teamInvites", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  role: mysqlEnum("role", ["admin", "staff", "provider", "billing", "front_desk", "user", "medical_assistant"]).default("staff").notNull(),
  clinicLocation: varchar("clinicLocation", { length: 255 }),
  invitedByUserId: int("invitedByUserId").references(() => users.id),
  status: mysqlEnum("status", ["pending", "accepted", "revoked"]).default("pending").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type TeamInvite = typeof teamInvites.$inferSelect;
export type InsertTeamInvite = typeof teamInvites.$inferInsert;

/**
 * Patients enrolled in CCM program
 */
export const patients = mysqlTable("patients", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  dateOfBirth: datetime("dateOfBirth"),
  phoneNumber: varchar("phoneNumber", { length: 20 }).notNull(),
  clinicId: int("clinicId").references(() => clinics.id),
  providerId: int("providerId").references(() => providers.id),
  preferredLanguage: varchar("preferredLanguage", { length: 50 }).default("English"),
  chronicConditions: json("chronicConditions").$type<string[]>().default([]),
  insurance: text("insurance"),
  ccmEnrollmentStatus: mysqlEnum("ccmEnrollmentStatus", ["active", "inactive", "declined", "transferred"]).default("active"),
  consentStatus: mysqlEnum("consentStatus", ["consented", "pending", "declined"]).default("pending"),
  // Behavioral Health Integration (BHI, CPT 99484) — enrollment is independent of
  // CCM: a patient can be in CCM, BHI, or both. Defaults to not_enrolled since BHI
  // is opt-in and requires a behavioral-health condition + its own consent.
  bhiEnrollmentStatus: mysqlEnum("bhiEnrollmentStatus", ["not_enrolled", "active", "inactive", "declined", "transferred"]).default("not_enrolled"),
  // The behavioral-health conditions that qualify the patient for BHI (depression,
  // anxiety, substance use disorder, etc.), kept separate from chronicConditions.
  bhiConditions: json("bhiConditions").$type<string[]>().default([]),
  // BHI requires its own documented consent (cost-sharing/copay applies; only one
  // practitioner bills per month) — tracked separately from CCM consent.
  bhiConsentStatus: mysqlEnum("bhiConsentStatus", ["consented", "pending", "declined"]).default("pending"),
  bhiConsentDate: datetime("bhiConsentDate"),
  // The qualifying initiating visit (E/M, AWV, or IPPE) required before BHI can be
  // billed for new patients or anyone not seen in the prior 12 months.
  bhiInitiatingVisitDate: datetime("bhiInitiatingVisitDate"),
  // The behavioral-health care plan (condition, goals, interventions, follow-up) —
  // the documentation foundation CMS requires for 99484.
  bhiCarePlan: text("bhiCarePlan"),
  // Advanced Primary Care Management (APCM, HCPCS G0556/G0557/G0558) — a bundled,
  // NON-time-based monthly service billed by patient complexity. Enrollment is
  // independent of CCM/BHI but MUTUALLY EXCLUSIVE with CCM (can't bill both for the
  // same patient in the same month), enforced in updatePatientAPCM/recomputeBilling.
  apcmEnrollmentStatus: mysqlEnum("apcmEnrollmentStatus", ["not_enrolled", "active", "inactive", "declined", "transferred"]).default("not_enrolled"),
  // Complexity level → G-code: level_1=G0556 (1 chronic condition), level_2=G0557
  // (2+ conditions), level_3=G0558 (2+ conditions AND a Qualified Medicare Beneficiary).
  apcmLevel: mysqlEnum("apcmLevel", ["level_1", "level_2", "level_3"]).default("level_1"),
  // Qualified Medicare Beneficiary status — drives APCM Level 3 (G0558).
  isQMB: boolean("isQMB").default(false),
  apcmConsentStatus: mysqlEnum("apcmConsentStatus", ["consented", "pending", "declined"]).default("pending"),
  apcmConsentDate: datetime("apcmConsentDate"),
  // Initiating visit required for new patients or anyone not seen within 3 years.
  apcmInitiatingVisitDate: datetime("apcmInitiatingVisitDate"),
  // The comprehensive electronic care plan CMS requires for APCM.
  apcmCarePlan: text("apcmCarePlan"),
  riskLevel: mysqlEnum("riskLevel", ["high", "medium", "low"]).default("medium"),
  priorityLevel: mysqlEnum("priorityLevel", ["high", "medium", "low"]).default("medium"),
  assignedStaffId: int("assignedStaffId").references(() => users.id),
  lastOfficeVisit: datetime("lastOfficeVisit"),
  nextAppointment: datetime("nextAppointment"),
  lastCCMDate: datetime("lastCCMDate"),
  lastCalledAt: datetime("lastCalledAt"),
  notes: text("notes"),
  // Remote Patient Monitoring (RPM) enrollment
  rpmEnrolled: boolean("rpmEnrolled").default(false),
  rpmStatus: mysqlEnum("rpmStatus", ["not_enrolled", "eligible", "enrolled", "active", "declined", "inactive"]).default("not_enrolled"),
  rpmDeviceType: varchar("rpmDeviceType", { length: 100 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  // Speeds up the patient list's "active/inactive" filter and worklist generation.
  enrollmentStatusIdx: index("patients_enrollmentStatus_idx").on(t.ccmEnrollmentStatus),
}));

export type Patient = typeof patients.$inferSelect;
export type InsertPatient = typeof patients.$inferInsert;

/**
 * Monthly CCM tasks/worklist items
 */
export const ccmTasks = mysqlTable("ccmTasks", {
  id: int("id").autoincrement().primaryKey(),
  patientId: int("patientId").references(() => patients.id).notNull(),
  month: varchar("month", { length: 7 }).notNull(), // YYYY-MM format
  // Which care-management program this monthly task belongs to. A patient enrolled
  // in both CCM and BHI has TWO tasks per month (one per program), each tracked and
  // billed independently (99490 vs 99484) so their time never double-counts.
  program: mysqlEnum("program", ["ccm", "bhi", "apcm"]).default("ccm").notNull(),
  assignedStaffId: int("assignedStaffId").references(() => users.id),
  priorityLevel: mysqlEnum("priorityLevel", ["high", "medium", "low"]).default("medium"),
  status: mysqlEnum("status", [
    "not_started",
    "assigned",
    "called_no_answer",
    "voicemail_left",
    "wrong_number",
    "needs_callback",
    "in_progress",
    "completed",
    "needs_provider_review",
    "needs_appointment",
    "documentation_incomplete",
    "ready_for_billing",
    "billed",
    "cancelled",
    "unable_to_reach",
    "declined_ccm",
    "inactive",
  ]).default("not_started"),
  dateContacted: datetime("dateContacted"),
  timeSpentMinutes: int("timeSpentMinutes").default(0),
  // How many times the patient was called this month and didn't answer.
  noAnswerCount: int("noAnswerCount").default(0),
  ccmNoteCompleted: boolean("ccmNoteCompleted").default(false),
  completedAt: datetime("completedAt"),
  completedByStaffId: int("completedByStaffId").references(() => users.id),
  providerReviewNeeded: boolean("providerReviewNeeded").default(false),
  followUpAppointmentNeeded: boolean("followUpAppointmentNeeded").default(false),
  appointmentScheduled: boolean("appointmentScheduled").default(false),
  labsReferralsPending: json("labsReferralsPending").$type<string[]>().default([]),
  billingReady: boolean("billingReady").default(false),
  comments: text("comments"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  // The worklist is queried by month every load; without this it's a full scan.
  monthIdx: index("ccmTasks_month_idx").on(t.month),
  monthStatusIdx: index("ccmTasks_month_status_idx").on(t.month, t.status),
  // Worklists and reports are scoped by program, so index (month, program).
  monthProgramIdx: index("ccmTasks_month_program_idx").on(t.month, t.program),
}));

export type CCMTask = typeof ccmTasks.$inferSelect;
export type InsertCCMTask = typeof ccmTasks.$inferInsert;

/**
 * CCM call workflow responses and documentation
 */
export const ccmNotes = mysqlTable("ccmNotes", {
  id: int("id").autoincrement().primaryKey(),
  ccmTaskId: int("ccmTaskId").references(() => ccmTasks.id).notNull(),
  patientId: int("patientId").references(() => patients.id).notNull(),
  staffId: int("staffId").references(() => users.id).notNull(),
  
  // Workflow responses
  howFeeling: text("howFeeling"),
  newSymptoms: text("newSymptoms"),
  medicationAdherence: text("medicationAdherence"),
  refillsNeeded: text("refillsNeeded"),
  erHospitalizationSince: text("erHospitalizationSince"),
  recentSpecialistVisits: text("recentSpecialistVisits"),
  bloodPressureReading: varchar("bloodPressureReading", { length: 20 }),
  bloodSugarReading: varchar("bloodSugarReading", { length: 20 }),
  upcomingAppointments: text("upcomingAppointments"),
  followUpNeeded: text("followUpNeeded"),
  patientConcerns: text("patientConcerns"),
  
  // Generated note
  generatedNote: text("generatedNote"),
  aiGeneratedAt: datetime("aiGeneratedAt"),
  
  // Escalation
  escalationReason: text("escalationReason"),
  escalationFlag: boolean("escalationFlag").default(false),
  
  // Follow-up actions
  followUpActions: json("followUpActions").$type<string[]>().default([]),

  // ---- Behavioral Health Integration (BHI, CPT 99484) assessment ----
  // Populated on BHI calls only. Validated rating scales are the documentation
  // foundation for 99484: PHQ-9 (depression, 0-27) and GAD-7 (anxiety, 0-21).
  phq9Score: int("phq9Score"),
  gad7Score: int("gad7Score"),
  // Any additional validated tool used (AUDIT-C alcohol, DAST-10 drugs, etc.).
  assessmentToolOther: varchar("assessmentToolOther", { length: 50 }),
  assessmentScoreOther: int("assessmentScoreOther"),
  // Behavioral trajectory since last contact, and whether the behavioral care plan
  // was revised this month (CMS requires revision when the patient isn't progressing).
  behavioralStatus: mysqlEnum("behavioralStatus", ["improved", "unchanged", "worsening", "new"]),
  carePlanUpdated: boolean("carePlanUpdated").default(false),
  // Safety flag (e.g. PHQ-9 item 9 / suicidal ideation) — routes to provider review.
  bhiRiskFlag: boolean("bhiRiskFlag").default(false),

  timeSpentMinutes: int("timeSpentMinutes").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type CCMNote = typeof ccmNotes.$inferSelect;
export type InsertCCMNote = typeof ccmNotes.$inferInsert;

/**
 * Provider escalations and reviews
 */
export const providerEscalations = mysqlTable("providerEscalations", {
  id: int("id").autoincrement().primaryKey(),
  ccmNoteId: int("ccmNoteId").references(() => ccmNotes.id).notNull(),
  patientId: int("patientId").references(() => patients.id).notNull(),
  providerId: int("providerId").references(() => providers.id).notNull(),
  reason: text("reason").notNull(),
  escalationStatus: mysqlEnum("escalationStatus", ["pending", "reviewed", "action_needed", "completed"]).default("pending"),
  recommendedAction: text("recommendedAction"),
  providerNotes: text("providerNotes"),
  reviewedAt: datetime("reviewedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ProviderEscalation = typeof providerEscalations.$inferSelect;
export type InsertProviderEscalation = typeof providerEscalations.$inferInsert;

/**
 * Follow-up appointments and services
 */
export const followUpItems = mysqlTable("followUpItems", {
  id: int("id").autoincrement().primaryKey(),
  ccmTaskId: int("ccmTaskId").references(() => ccmTasks.id).notNull(),
  patientId: int("patientId").references(() => patients.id).notNull(),
  type: mysqlEnum("type", [
    "office_visit",
    "telemedicine_visit",
    "lab_work",
    "medication_refill",
    "referral",
    "imaging",
    "testing",
    "rpm_enrollment",
    "dexa",
    "abi",
    "pft",
    "balance_test",
    "vaccination",
    "annual_wellness",
  ]).notNull(),
  status: mysqlEnum("status", ["pending", "scheduled", "completed"]).default("pending"),
  scheduledDate: datetime("scheduledDate"),
  completedDate: datetime("completedDate"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type FollowUpItem = typeof followUpItems.$inferSelect;
export type InsertFollowUpItem = typeof followUpItems.$inferInsert;

/**
 * Billing records and readiness tracking
 */
export const billingRecords = mysqlTable("billingRecords", {
  id: int("id").autoincrement().primaryKey(),
  ccmTaskId: int("ccmTaskId").references(() => ccmTasks.id).notNull(),
  patientId: int("patientId").references(() => patients.id).notNull(),
  month: varchar("month", { length: 7 }).notNull(),
  // Which program this claim is for, and the CPT it bills under (CCM 99490 vs BHI
  // 99484) — so the ready-to-bill export separates the two cleanly.
  program: mysqlEnum("program", ["ccm", "bhi", "apcm"]).default("ccm").notNull(),
  cptCode: varchar("cptCode", { length: 10 }).default("99490"),
  timeThresholdMet: boolean("timeThresholdMet").default(false),
  documentationComplete: boolean("documentationComplete").default(false),
  providerAssociated: boolean("providerAssociated").default(false),
  carePlanReviewed: boolean("carePlanReviewed").default(false),
  noMissingFields: boolean("noMissingFields").default(false),
  providerReviewCompleted: boolean("providerReviewCompleted").default(false),
  // BHI (99484) compliance gates — documented consent + a qualifying initiating
  // visit are prerequisites to billing (mirror CCM's requirements for BHI).
  consentObtained: boolean("consentObtained").default(false),
  initiatingVisitOnFile: boolean("initiatingVisitOnFile").default(false),
  billingStatus: mysqlEnum("billingStatus", [
    "not_started",
    "in_progress",
    "documentation_incomplete",
    "provider_review_pending",
    "ready_for_billing",
    "billed",
    "denied",
    "needs_correction",
  ]).default("not_started"),
  claimSubmittedDate: datetime("claimSubmittedDate"),
  claimDenialReason: text("claimDenialReason"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type BillingRecord = typeof billingRecords.$inferSelect;
export type InsertBillingRecord = typeof billingRecords.$inferInsert;

/**
 * Notifications sent to users
 */
export const notifications = mysqlTable("notifications", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").references(() => users.id).notNull(),
  type: mysqlEnum("type", ["urgent_symptom", "escalation", "missing_documentation", "not_reached", "billing_ready", "refill_request", "refill_decision", "workforce", "task"]).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content"),
  relatedPatientId: int("relatedPatientId").references(() => patients.id),
  relatedCCMTaskId: int("relatedCCMTaskId").references(() => ccmTasks.id),
  read: boolean("read").default(false),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = typeof notifications.$inferInsert;

/**
 * Monthly productivity metrics
 */
export const productivityMetrics = mysqlTable("productivityMetrics", {
  id: int("id").autoincrement().primaryKey(),
  month: varchar("month", { length: 7 }).notNull(),
  staffId: int("staffId").references(() => users.id),
  providerId: int("providerId").references(() => providers.id),
  clinicId: int("clinicId").references(() => clinics.id),
  totalCCMsCompleted: int("totalCCMsCompleted").default(0),
  totalCCMsAssigned: int("totalCCMsAssigned").default(0),
  totalTimeSpentMinutes: int("totalTimeSpentMinutes").default(0),
  patientsNotReached: int("patientsNotReached").default(0),
  patientsNeedingReview: int("patientsNeedingReview").default(0),
  patientsReadyForBilling: int("patientsReadyForBilling").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ProductivityMetrics = typeof productivityMetrics.$inferSelect;
export type InsertProductivityMetrics = typeof productivityMetrics.$inferInsert;

/**
 * HIPAA audit log â€” records access and modifications to Protected Health Information (PHI).
 * Append-only; never updated or deleted.
 */
export const auditLogs = mysqlTable("auditLogs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").references(() => users.id),
  userName: varchar("userName", { length: 255 }),
  userRole: varchar("userRole", { length: 50 }),
  action: mysqlEnum("action", [
    "view_patient",
    "list_patients",
    "create_patient",
    "update_patient",
    "bulk_import_patients",
    "update_rpm",
    "view_worklist",
    "complete_ccm_note",
    "view_billing",
    "export_data",
    "login",
    "login_failed",
    "logout",
    "change_password",
    "reset_password",
    "manage_access",
    // Workspace (clinic operations) — appended; see server/workspaceMigration.ts
    "create_task",
    "update_task",
    "view_schedule",
    "import_schedule",
    "update_appointment",
    "opportunity_action",
    "manage_playbook",
  ]).notNull(),
  entityType: varchar("entityType", { length: 50 }),
  entityId: int("entityId"),
  description: text("description"),
  ipAddress: varchar("ipAddress", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  // The audit log lists newest-first; index the sort column.
  createdAtIdx: index("auditLogs_createdAt_idx").on(t.createdAt),
}));

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

/**
 * Per-coordinator monthly CCM completion goal, set by an admin at the start of
 * each month. One row per (user, month).
 */
export const monthlyGoals = mysqlTable("monthlyGoals", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").references(() => users.id).notNull(),
  month: varchar("month", { length: 7 }).notNull(), // YYYY-MM
  goal: int("goal").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  userMonthIdx: index("monthlyGoals_user_month_idx").on(t.userId, t.month),
}));

export type MonthlyGoal = typeof monthlyGoals.$inferSelect;

/**
 * Medication refill requests: a care coordinator collects the medications a patient
 * asked to refill during a call and sends them to the patient's provider, who then
 * approves, asks to schedule a visit, or declines to refill. Closes the loop between
 * coordinators and providers on-platform.
 */
export const refillRequests = mysqlTable("refillRequests", {
  id: int("id").autoincrement().primaryKey(),
  patientId: int("patientId").references(() => patients.id).notNull(),
  // The provider this request is routed to (the patient's provider at send time).
  providerId: int("providerId").references(() => providers.id),
  // The coordinator who sent it, and the call it came from (if any).
  requestedByUserId: int("requestedByUserId").references(() => users.id),
  ccmTaskId: int("ccmTaskId").references(() => ccmTasks.id),
  // Medications picked from the search dropdown (name + optional note per med).
  medications: json("medications").$type<{ name: string; note?: string }[]>().default([]),
  note: text("note"), // coordinator's overall note to the provider
  status: mysqlEnum("status", ["pending", "approved", "schedule_visit", "denied"]).default("pending").notNull(),
  providerNote: text("providerNote"), // provider's note back to the coordinator
  decidedByUserId: int("decidedByUserId").references(() => users.id),
  decidedAt: datetime("decidedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  // The provider portal queries pending requests by provider; the patient page by patient.
  providerStatusIdx: index("refillRequests_provider_status_idx").on(t.providerId, t.status),
  patientIdx: index("refillRequests_patient_idx").on(t.patientId),
}));

export type RefillRequest = typeof refillRequests.$inferSelect;
export type InsertRefillRequest = typeof refillRequests.$inferInsert;

/**
 * "Reach Out" — outbound appointment-scheduling call campaign. A standalone list
 * (kept separate from CCM `patients`) of insurance patients we cold-call to ask if
 * they'd like to schedule a visit. Two independent tracking dimensions per contact:
 *   • callStatus — the connection result of the attempt (did we reach them?)
 *   • outcome     — what they said once reached (do they want an appointment?)
 * Worked as a shared pool: any coordinator calls the next un-called contact, and
 * each logged call stamps who called + when and increments the attempt count.
 */
export const reachOutContacts = mysqlTable("reachOutContacts", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  phoneNumber: varchar("phoneNumber", { length: 20 }).notNull(),
  dateOfBirth: datetime("dateOfBirth"),
  insurance: varchar("insurance", { length: 255 }),
  language: varchar("language", { length: 50 }),
  callStatus: mysqlEnum("callStatus", [
    "not_called", "no_answer", "voicemail", "wrong_number", "callback", "reached", "do_not_call",
  ]).default("not_called").notNull(),
  outcome: mysqlEnum("outcome", [
    "pending", "wants_appointment", "appointment_scheduled", "already_scheduled", "not_interested", "declined",
  ]).default("pending").notNull(),
  attempts: int("attempts").default(0).notNull(),
  lastCalledAt: datetime("lastCalledAt"),
  lastCalledByStaffId: int("lastCalledByStaffId").references(() => users.id),
  notes: text("notes"),
  campaign: varchar("campaign", { length: 100 }).default("insurance-outreach"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  // The pool view sorts un-called first and filters by status/outcome constantly.
  callStatusIdx: index("reachOut_callStatus_idx").on(t.callStatus),
  outcomeIdx: index("reachOut_outcome_idx").on(t.outcome),
}));

export type ReachOutContact = typeof reachOutContacts.$inferSelect;
export type InsertReachOutContact = typeof reachOutContacts.$inferInsert;

// ============================================================================
// Workforce — employee roles, scheduling, time clock, and performance.
// Contains NO patient data. Calendar dates are stored as "YYYY-MM-DD" strings and
// shift times as "HH:MM" in clinic-local time (America/Chicago) so a shift never
// drifts across a day boundary; only clock punches are real UTC timestamps.
// ============================================================================

/** A job definition (e.g. "Medical Assistant") — what the role is responsible for. */
export const jobRoles = mysqlTable("jobRoles", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  summary: text("summary"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type JobRole = typeof jobRoles.$inferSelect;

/**
 * One responsibility within a job role. Recurring duties (daily/weekly/monthly)
 * show up on the employee's "My Day" as a check-off; "as_needed" duties are
 * reference-only (part of the job description, not tracked).
 */
export const jobDuties = mysqlTable("jobDuties", {
  id: int("id").autoincrement().primaryKey(),
  jobRoleId: int("jobRoleId").references(() => jobRoles.id).notNull(),
  category: varchar("category", { length: 80 }).notNull().default("General"),
  title: varchar("title", { length: 255 }).notNull(),
  detail: text("detail"),
  frequency: mysqlEnum("frequency", ["daily", "weekly", "monthly", "as_needed"]).default("daily").notNull(),
  sortOrder: int("sortOrder").default(0).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  roleIdx: index("jobDuties_role_idx").on(t.jobRoleId),
}));

export type JobDuty = typeof jobDuties.$inferSelect;

/** Employment details for a user: which job they hold and where they're based. */
export const staffProfiles = mysqlTable("staffProfiles", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").references(() => users.id).notNull().unique(),
  jobRoleId: int("jobRoleId").references(() => jobRoles.id),
  homeClinicId: int("homeClinicId").references(() => clinics.id),
  // Willing/able to cover shifts at other clinics — drives the coverage finder.
  canFloat: boolean("canFloat").default(false).notNull(),
  hoursPerWeek: int("hoursPerWeek").default(40),
  hireDate: varchar("hireDate", { length: 10 }),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type StaffProfile = typeof staffProfiles.$inferSelect;

/** A scheduled shift: one person, one clinic, one day. */
export const shifts = mysqlTable("shifts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").references(() => users.id).notNull(),
  clinicId: int("clinicId").references(() => clinics.id).notNull(),
  date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD (clinic-local)
  startTime: varchar("startTime", { length: 5 }).notNull(), // HH:MM
  endTime: varchar("endTime", { length: 5 }).notNull(),
  // called_out = the employee can't work it; the shift stays on the board as a
  // coverage need until another shift points at it via coversShiftId.
  status: mysqlEnum("status", ["scheduled", "called_out"]).default("scheduled").notNull(),
  coversShiftId: int("coversShiftId"),
  note: text("note"),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  dateIdx: index("shifts_date_idx").on(t.date),
  userDateIdx: index("shifts_user_date_idx").on(t.userId, t.date),
}));

export type Shift = typeof shifts.$inferSelect;

export const timeOffRequests = mysqlTable("timeOffRequests", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").references(() => users.id).notNull(),
  startDate: varchar("startDate", { length: 10 }).notNull(),
  endDate: varchar("endDate", { length: 10 }).notNull(),
  type: mysqlEnum("type", ["pto", "sick", "unpaid", "other"]).default("pto").notNull(),
  reason: text("reason"),
  status: mysqlEnum("status", ["pending", "approved", "denied", "cancelled"]).default("pending").notNull(),
  managerNote: text("managerNote"),
  decidedByUserId: int("decidedByUserId").references(() => users.id),
  decidedAt: datetime("decidedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  userIdx: index("timeOff_user_idx").on(t.userId),
  statusIdx: index("timeOff_status_idx").on(t.status),
}));

export type TimeOffRequest = typeof timeOffRequests.$inferSelect;

/** Clock in / clock out. An open punch has clockOutAt = null. */
export const timePunches = mysqlTable("timePunches", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").references(() => users.id).notNull(),
  clinicId: int("clinicId").references(() => clinics.id),
  shiftId: int("shiftId").references(() => shifts.id),
  workDate: varchar("workDate", { length: 10 }).notNull(), // clinic-local date of clock-in
  clockInAt: datetime("clockInAt").notNull(),
  clockOutAt: datetime("clockOutAt"),
  // Minutes past the scheduled start at clock-in (0 if on time / unscheduled).
  minutesLate: int("minutesLate").default(0).notNull(),
  note: text("note"),
  // Set when a manager corrected this punch (missed clock-out, etc.).
  editedByUserId: int("editedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  userDateIdx: index("timePunches_user_date_idx").on(t.userId, t.workDate),
  dateIdx: index("timePunches_date_idx").on(t.workDate),
}));

export type TimePunch = typeof timePunches.$inferSelect;

/**
 * A duty checked off for a period. periodKey is the date for daily duties, the
 * Monday of the week for weekly duties, and YYYY-MM for monthly duties.
 */
export const dutyCompletions = mysqlTable("dutyCompletions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").references(() => users.id).notNull(),
  dutyId: int("dutyId").references(() => jobDuties.id).notNull(),
  periodKey: varchar("periodKey", { length: 10 }).notNull(),
  completedAt: timestamp("completedAt").defaultNow().notNull(),
}, (t) => ({
  userPeriodIdx: index("dutyCompletions_user_period_idx").on(t.userId, t.periodKey),
}));

export type DutyCompletion = typeof dutyCompletions.$inferSelect;

/** Manager feedback on an employee: kudos, coaching, or a formal review (1-5). */
export const performanceNotes = mysqlTable("performanceNotes", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").references(() => users.id).notNull(),
  authorUserId: int("authorUserId").references(() => users.id),
  kind: mysqlEnum("kind", ["kudos", "coaching", "review"]).default("review").notNull(),
  rating: int("rating"),
  note: text("note").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("performanceNotes_user_idx").on(t.userId),
}));

export type PerformanceNote = typeof performanceNotes.$inferSelect;

// =============================================================================
// WORKSPACE — clinic operations (tasks, appointments / patient flow,
// opportunity actions, playbooks). Purely additive: created by
// server/workspaceMigration.ts. Appointments deliberately do NOT create patient
// rows (the patients table is the CCM roster — a new row would join the CCM
// worklist); they carry the schedule's own name/DOB/phone and link to an
// existing patient when name + DOB match.
// =============================================================================

export const WORK_TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const WORK_TASK_STATUSES = ["open", "in_progress", "waiting", "completed", "cancelled"] as const;
export const WORK_TASK_CATEGORIES = [
  "patient_call", "referral", "prior_auth", "lab_followup", "form", "medication_request",
  "care_management", "rpm", "front_desk", "provider_request", "administrative", "other",
] as const;

/** A general work item for any role (not the monthly CCM worklist). */
export const workTasks = mysqlTable("workTasks", {
  id: int("id").autoincrement().primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  patientId: int("patientId").references(() => patients.id),
  clinicId: int("clinicId").references(() => clinics.id),
  assignedUserId: int("assignedUserId").references(() => users.id),
  /** Role queue (e.g. "front_desk") when not assigned to a person. */
  assignedRole: varchar("assignedRole", { length: 40 }),
  priority: mysqlEnum("priority", WORK_TASK_PRIORITIES).default("normal").notNull(),
  status: mysqlEnum("status", WORK_TASK_STATUSES).default("open").notNull(),
  category: mysqlEnum("category", WORK_TASK_CATEGORIES).default("other").notNull(),
  /** Clinic-local calendar date "YYYY-MM-DD". */
  dueDate: varchar("dueDate", { length: 10 }),
  createdByUserId: int("createdByUserId").references(() => users.id).notNull(),
  completedAt: datetime("completedAt"),
  /** Where the task came from: "opportunity", "appointment", "manual"... */
  sourceType: varchar("sourceType", { length: 40 }),
  sourceRef: varchar("sourceRef", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  assigneeStatusIdx: index("workTasks_assignee_status_idx").on(t.assignedUserId, t.status),
  statusDueIdx: index("workTasks_status_due_idx").on(t.status, t.dueDate),
  patientIdx: index("workTasks_patient_idx").on(t.patientId),
}));

export type WorkTask = typeof workTasks.$inferSelect;

export const workTaskActivities = mysqlTable("workTaskActivities", {
  id: int("id").autoincrement().primaryKey(),
  taskId: int("taskId").references(() => workTasks.id).notNull(),
  userId: int("userId").references(() => users.id).notNull(),
  type: mysqlEnum("type", ["created", "status_changed", "assigned", "due_date_changed", "priority_changed", "comment"]).notNull(),
  body: text("body"),
  meta: json("meta").$type<Record<string, string | null>>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  taskIdx: index("workTaskActivities_task_idx").on(t.taskId),
}));

export type WorkTaskActivity = typeof workTaskActivities.$inferSelect;

export const APPOINTMENT_STATUSES = [
  "scheduled", "arrived", "checked_in", "roomed", "with_provider", "checkout", "completed", "no_show", "cancelled",
] as const;

/** One scheduled visit, imported from the Practice Fusion schedule export. */
export const appointments = mysqlTable("appointments", {
  id: int("id").autoincrement().primaryKey(),
  clinicId: int("clinicId").references(() => clinics.id),
  /** Linked when the schedule's name + DOB match an existing patient. */
  patientId: int("patientId").references(() => patients.id),
  patientName: varchar("patientName", { length: 255 }).notNull(),
  dateOfBirth: datetime("dateOfBirth"),
  phoneNumber: varchar("phoneNumber", { length: 30 }),
  providerId: int("providerId").references(() => providers.id),
  providerName: varchar("providerName", { length: 255 }),
  /** Clinic-local calendar date "YYYY-MM-DD" (fast per-day lookups). */
  date: varchar("date", { length: 10 }).notNull(),
  startsAt: datetime("startsAt").notNull(),
  durationMin: int("durationMin").default(20).notNull(),
  visitType: varchar("visitType", { length: 120 }),
  reason: varchar("reason", { length: 255 }),
  status: mysqlEnum("status", APPOINTMENT_STATUSES).default("scheduled").notNull(),
  room: varchar("room", { length: 40 }),
  arrivedAt: datetime("arrivedAt"),
  checkedInAt: datetime("checkedInAt"),
  roomedAt: datetime("roomedAt"),
  withProviderAt: datetime("withProviderAt"),
  checkoutAt: datetime("checkoutAt"),
  completedAt: datetime("completedAt"),
  /** Stable key from clinic + start + patient + provider: re-imports update, never duplicate. */
  externalKey: varchar("externalKey", { length: 64 }).notNull().unique(),
  importId: int("importId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  clinicDateIdx: index("appointments_clinic_date_idx").on(t.clinicId, t.date),
  patientIdx: index("appointments_patient_idx").on(t.patientId),
  dateStatusIdx: index("appointments_date_status_idx").on(t.date, t.status),
}));

export type Appointment = typeof appointments.$inferSelect;

export const appointmentStatusEvents = mysqlTable("appointmentStatusEvents", {
  id: int("id").autoincrement().primaryKey(),
  appointmentId: int("appointmentId").references(() => appointments.id).notNull(),
  fromStatus: varchar("fromStatus", { length: 20 }).notNull(),
  toStatus: varchar("toStatus", { length: 20 }).notNull(),
  changedByUserId: int("changedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  apptIdx: index("appointmentStatusEvents_appt_idx").on(t.appointmentId),
}));

/** One schedule upload (who, when, what it contained). */
export const scheduleImports = mysqlTable("scheduleImports", {
  id: int("id").autoincrement().primaryKey(),
  fileName: varchar("fileName", { length: 255 }),
  importedByUserId: int("importedByUserId").references(() => users.id).notNull(),
  firstDate: varchar("firstDate", { length: 10 }),
  lastDate: varchar("lastDate", { length: 10 }),
  rowCount: int("rowCount").default(0).notNull(),
  createdCount: int("createdCount").default(0).notNull(),
  updatedCount: int("updatedCount").default(0).notNull(),
  linkedCount: int("linkedCount").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** A human action on an Opportunity Finder suggestion (the rules run live). */
export const opportunityActions = mysqlTable("opportunityActions", {
  id: int("id").autoincrement().primaryKey(),
  // CCM-roster patient, when there is one; schedule-only patients are identified by subjectKey.
  patientId: int("patientId").references(() => patients.id),
  // "p:<patientId>" or "s:<normalized name>|<YYYY-MM-DD DOB>"
  subjectKey: varchar("subjectKey", { length: 120 }),
  category: varchar("category", { length: 40 }).notNull(),
  action: mysqlEnum("action", ["reviewed", "task_created", "dismissed"]).notNull(),
  userId: int("userId").references(() => users.id).notNull(),
  taskId: int("taskId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  patientCategoryIdx: index("opportunityActions_patient_cat_idx").on(t.patientId, t.category),
  subjectCategoryIdx: index("opportunityActions_subject_cat_idx").on(t.subjectKey, t.category),
}));

/** Practice knowledge base (SOPs / workflows). */
export const playbooks = mysqlTable("playbooks", {
  id: int("id").autoincrement().primaryKey(),
  slug: varchar("slug", { length: 120 }).notNull().unique(),
  title: varchar("title", { length: 255 }).notNull(),
  category: varchar("category", { length: 80 }).notNull(),
  description: text("description"),
  ownerUserId: int("ownerUserId").references(() => users.id),
  currentVersion: int("currentVersion").default(1).notNull(),
  archived: boolean("archived").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Playbook = typeof playbooks.$inferSelect;

export const playbookVersions = mysqlTable("playbookVersions", {
  id: int("id").autoincrement().primaryKey(),
  playbookId: int("playbookId").references(() => playbooks.id).notNull(),
  version: int("version").notNull(),
  steps: json("steps").$type<{ title: string; detail: string }[]>().notNull(),
  changeNote: varchar("changeNote", { length: 255 }),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  playbookIdx: index("playbookVersions_playbook_idx").on(t.playbookId),
}));
