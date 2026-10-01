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
  uniqueIndex,
  mediumtext,
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
  role: mysqlEnum("role", ["admin", "staff", "provider", "billing", "front_desk", "user", "medical_assistant", "office_manager"]).default("user").notNull(),
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
  role: mysqlEnum("role", ["admin", "staff", "provider", "billing", "front_desk", "user", "medical_assistant", "office_manager"]).default("staff").notNull(),
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
  /** When CCM consent was given (e.g. on a signed consent form). */
  ccmConsentDate: datetime("ccmConsentDate"),
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
  rpmConsentStatus: mysqlEnum("rpmConsentStatus", ["consented", "pending", "declined"]).default("pending"),
  rpmConsentDate: datetime("rpmConsentDate"),
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
    // Documents (our own DocuSign), added 2026-09-30
    "view_document",
    "manage_document",
    // Square payments, added 2026-09-30
    "view_payments",
    "manage_payment",
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
  // Hourly staff who clock in and out. Only they can use the time clock.
  usesTimeClock: boolean("usesTimeClock").default(false).notNull(),
  // Attendance (late / no-show) is judged from this clinic-local date on — e.g. a new
  // hire's first day, or the day the clock rolls out. Null = from the start.
  clockStartDate: varchar("clockStartDate", { length: 10 }),
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
  // Null = a remote shift (e.g. a care coordinator working from home).
  clinicId: int("clinicId").references(() => clinics.id),
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
  "care_management", "rpm", "front_desk", "provider_request", "administrative", "other", "patient_email", "fax_filing",
] as const;

/** A general work item for any role (not the monthly CCM worklist). */
export const workTasks = mysqlTable("workTasks", {
  id: int("id").autoincrement().primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  patientId: int("patientId").references(() => patients.id),
  /** A patient who isn't on the CCM roster ("s:" schedule, "f:" Practice Fusion only), and their name. */
  subjectKey: varchar("subjectKey", { length: 120 }),
  subjectName: varchar("subjectName", { length: 255 }),
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
  subjectIdx: index("workTasks_subject_idx").on(t.subjectKey),
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

/**
 * Emails that arrived in the practice mailbox (Gmail) and what MyPCP did with them.
 * Keeps a short preview only; the email itself stays in Gmail.
 */
export const emailMessages = mysqlTable("emailMessages", {
  id: int("id").autoincrement().primaryKey(),
  gmailId: varchar("gmailId", { length: 64 }).notNull().unique(),
  threadId: varchar("threadId", { length: 64 }),
  messageIdHeader: varchar("messageIdHeader", { length: 255 }),
  fromEmail: varchar("fromEmail", { length: 320 }),
  fromName: varchar("fromName", { length: 255 }),
  subject: varchar("subject", { length: 255 }),
  preview: text("preview"),
  receivedAt: datetime("receivedAt").notNull(),
  patientId: int("patientId").references(() => patients.id),
  subjectKey: varchar("subjectKey", { length: 120 }),
  patientName: varchar("patientName", { length: 255 }),
  /** address | name | phone | manual */
  matchMethod: varchar("matchMethod", { length: 20 }),
  status: mysqlEnum("status", ["assigned", "needs_patient", "ignored"]).notNull(),
  taskId: int("taskId"),
  assignedUserId: int("assignedUserId").references(() => users.id),
  /** Loaded from before the mailbox was connected ("Load the last 30 days"): shown, but no task. */
  historical: boolean("historical").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  statusIdx: index("emailMessages_status_idx").on(t.status, t.receivedAt),
  fromIdx: index("emailMessages_from_idx").on(t.fromEmail),
}));

/** Email addresses MyPCP knows: a patient's (imported or linked by staff), or a non-patient to ignore. */
export const emailContacts = mysqlTable("emailContacts", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  kind: mysqlEnum("kind", ["patient", "ignore"]).notNull(),
  patientId: int("patientId").references(() => patients.id),
  subjectKey: varchar("subjectKey", { length: 120 }),
  name: varchar("name", { length: 255 }),
  /** import | linked */
  source: varchar("source", { length: 20 }).notNull(),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/**
 * Tests and screenings a patient has had (imported from Practice Fusion or recorded by staff),
 * plus "not needed" / "declined" decisions. Keyed like the Opportunity Finder ("p:<id>" /
 * "s:<name>|<dob>") so people who aren't on the CCM roster are covered too.
 */
export const patientTests = mysqlTable("patientTests", {
  id: int("id").autoincrement().primaryKey(),
  subjectKey: varchar("subjectKey", { length: 120 }).notNull(),
  patientId: int("patientId").references(() => patients.id),
  testKey: varchar("testKey", { length: 40 }).notNull(),
  method: varchar("method", { length: 40 }),
  performedOn: varchar("performedOn", { length: 10 }).notNull(),
  status: mysqlEnum("status", ["done", "not_applicable", "declined"]).default("done").notNull(),
  result: varchar("result", { length: 120 }),
  note: text("note"),
  /** import | manual */
  source: varchar("source", { length: 20 }).notNull(),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  subjectIdx: index("patientTests_subject_idx").on(t.subjectKey),
  oneRecord: uniqueIndex("patientTests_one_record").on(t.subjectKey, t.testKey, t.performedOn, t.status),
}));

/** Sex for screening rules (mammograms, cervical, bone density), from the Practice Fusion patient list or staff. */
export const personDemographics = mysqlTable("personDemographics", {
  subjectKey: varchar("subjectKey", { length: 120 }).primaryKey(),
  patientId: int("patientId").references(() => patients.id),
  sex: mysqlEnum("sex", ["F", "M", "X"]),
  source: varchar("source", { length: 20 }).notNull(),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Practice-wide settings (e.g. the RingCentral connection), one JSON value per key. */
export const appSettings = mysqlTable("appSettings", {
  key: varchar("key", { length: 80 }).primaryKey(),
  value: json("value").notNull(),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/**
 * Phone calls made or taken through the RingCentral phone built into the app,
 * matched to a patient when the number is known. The outcome is what staff record.
 */
export const phoneCalls = mysqlTable("phoneCalls", {
  id: int("id").autoincrement().primaryKey(),
  /** MyPCP user who made/took it; null when the call came from the RingCentral sync and the extension isn't a MyPCP user. */
  userId: int("userId").references(() => users.id),
  direction: mysqlEnum("direction", ["outbound", "inbound"]).notNull(),
  /** Last 10 digits of the other party's number. */
  phoneNumber: varchar("phoneNumber", { length: 20 }).notNull(),
  patientId: int("patientId").references(() => patients.id),
  /** Same key the Opportunity Finder uses: "p:<patientId>" or "s:<name>|<dob>". */
  subjectKey: varchar("subjectKey", { length: 120 }),
  contactName: varchar("contactName", { length: 255 }),
  startedAt: datetime("startedAt").notNull(),
  durationSec: int("durationSec").default(0).notNull(),
  /** RingCentral's result, e.g. "Call connected", "Voicemail", "Missed". */
  result: varchar("result", { length: 60 }),
  outcome: varchar("outcome", { length: 30 }),
  note: text("note"),
  /** Where the call was started from, e.g. "schedule_fill", "reach_out", "patient". */
  source: varchar("source", { length: 40 }),
  rcSessionId: varchar("rcSessionId", { length: 120 }).unique(),
  /** Name of the RingCentral extension, for calls pulled in by the call-log sync. */
  rcExtensionName: varchar("rcExtensionName", { length: 120 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  phoneIdx: index("phoneCalls_phone_idx").on(t.phoneNumber),
  patientIdx: index("phoneCalls_patient_idx").on(t.patientId),
  subjectIdx: index("phoneCalls_subject_idx").on(t.subjectKey),
}));

/**
 * Every RingCentral call (not just patient calls), reduced to what the productivity numbers need:
 * which extension handled it, direction, result and length. No outside phone numbers are kept.
 */
export const rcCallStats = mysqlTable("rcCallStats", {
  id: int("id").autoincrement().primaryKey(),
  rcId: varchar("rcId", { length: 120 }).notNull().unique(),
  startedAt: datetime("startedAt").notNull(),
  /** Clinic-local calendar date "YYYY-MM-DD". */
  workDate: varchar("workDate", { length: 10 }).notNull(),
  direction: mysqlEnum("direction", ["outbound", "inbound"]).notNull(),
  durationSec: int("durationSec").default(0).notNull(),
  result: varchar("result", { length: 60 }),
  answered: boolean("answered").default(false).notNull(),
  missed: boolean("missed").default(false).notNull(),
  extensionId: varchar("extensionId", { length: 40 }),
  extensionName: varchar("extensionName", { length: 120 }),
  extensionEmail: varchar("extensionEmail", { length: 320 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  dateIdx: index("rcCallStats_date_idx").on(t.workDate),
  extDateIdx: index("rcCallStats_ext_date_idx").on(t.extensionId, t.workDate),
}));

/**
 * Incoming faxes (arriving by email). The fax itself stays in the mailbox; this keeps where it
 * is, who it's for, and whether it's been filed in Practice Fusion.
 */
export const faxes = mysqlTable("faxes", {
  id: int("id").autoincrement().primaryKey(),
  /** Which connected mailbox it came from: "practice" or "fax". */
  mailbox: varchar("mailbox", { length: 10 }).notNull(),
  gmailId: varchar("gmailId", { length: 64 }).notNull().unique(),
  threadId: varchar("threadId", { length: 64 }),
  messageIdHeader: varchar("messageIdHeader", { length: 255 }),
  fromEmail: varchar("fromEmail", { length: 320 }),
  fromName: varchar("fromName", { length: 255 }),
  fromNumber: varchar("fromNumber", { length: 20 }),
  subject: varchar("subject", { length: 255 }),
  receivedAt: datetime("receivedAt").notNull(),
  attachmentId: text("attachmentId"),
  filename: varchar("filename", { length: 255 }),
  mimeType: varchar("mimeType", { length: 80 }),
  sizeBytes: int("sizeBytes"),
  pages: int("pages"),
  status: mysqlEnum("status", ["new", "needs_patient", "to_file", "filed", "not_patient"]).notNull(),
  docType: varchar("docType", { length: 30 }),
  aiPatientName: varchar("aiPatientName", { length: 255 }),
  aiDob: varchar("aiDob", { length: 10 }),
  aiSender: varchar("aiSender", { length: 255 }),
  aiSummary: varchar("aiSummary", { length: 255 }),
  aiError: varchar("aiError", { length: 255 }),
  aiAt: datetime("aiAt"),
  /** A name-only match the AI found; staff confirm it. */
  suggestedKey: varchar("suggestedKey", { length: 120 }),
  suggestedName: varchar("suggestedName", { length: 255 }),
  subjectKey: varchar("subjectKey", { length: 120 }),
  patientId: int("patientId").references(() => patients.id),
  patientName: varchar("patientName", { length: 255 }),
  /** ai (name + DOB) | manual */
  matchMethod: varchar("matchMethod", { length: 20 }),
  taskId: int("taskId"),
  filedByUserId: int("filedByUserId").references(() => users.id),
  filedAt: datetime("filedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  statusIdx: index("faxes_status_idx").on(t.status, t.receivedAt),
}));

/**
 * Practice Fusion patients (FHIR Patient) and how each maps to a MyPCP person
 * ("p:<id>" roster patient, "s:<name>|<dob>" schedule patient, or "f:<fhirId>" chart-only).
 */
export const fhirPatients = mysqlTable("fhirPatients", {
  fhirId: varchar("fhirId", { length: 128 }).primaryKey(),
  subjectKey: varchar("subjectKey", { length: 120 }).notNull(),
  patientId: int("patientId").references(() => patients.id),
  name: varchar("name", { length: 255 }),
  dob: varchar("dob", { length: 10 }),
  sex: mysqlEnum("sex", ["F", "M", "X"]),
  phone: varchar("phone", { length: 40 }),
  email: varchar("email", { length: 320 }),
  address: varchar("address", { length: 255 }),
  mrn: varchar("mrn", { length: 64 }),
  syncedAt: datetime("syncedAt").notNull(),
}, (t) => ({
  subjectIdx: index("fhirPatients_subject_idx").on(t.subjectKey),
  nameIdx: index("fhirPatients_name_idx").on(t.name),
}));

/**
 * A read-only copy of each chart item from Practice Fusion (one FHIR resource per row): the
 * readable line the Chart shows, plus the full resource (gzip, base64) for detail views.
 */
export const fhirResources = mysqlTable("fhirResources", {
  id: int("id").autoincrement().primaryKey(),
  resourceType: varchar("resourceType", { length: 40 }).notNull(),
  /** Chart grouping, e.g. "Condition", "Observation:laboratory". */
  section: varchar("section", { length: 60 }).notNull(),
  fhirId: varchar("fhirId", { length: 128 }).notNull(),
  patientFhirId: varchar("patientFhirId", { length: 128 }),
  subjectKey: varchar("subjectKey", { length: 120 }),
  title: varchar("title", { length: 255 }),
  value: varchar("value", { length: 255 }),
  status: varchar("status", { length: 40 }),
  date: varchar("date", { length: 10 }),
  code: varchar("code", { length: 80 }),
  raw: mediumtext("raw"),
  lastUpdated: datetime("lastUpdated"),
  syncedAt: datetime("syncedAt").notNull(),
}, (t) => ({
  oneResource: uniqueIndex("fhirResources_type_id_unique").on(t.resourceType, t.fhirId),
  subjectIdx: index("fhirResources_subject_idx").on(t.subjectKey, t.section, t.date),
  syncedIdx: index("fhirResources_synced_idx").on(t.syncedAt),
  sectionIdx: index("fhirResources_section_idx").on(t.section, t.subjectKey),
}));

/** Appointment requests from the mypcpdr.com booking wizard (the front desk calls to confirm). */
export const bookingRequests = mysqlTable("bookingRequests", {
  id: int("id").autoincrement().primaryKey(),
  receivedAt: datetime("receivedAt").notNull(),
  /** website | email (loaded from an earlier booking email) */
  source: varchar("source", { length: 20 }).notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  phone: varchar("phone", { length: 30 }).notNull(),
  phoneKey: varchar("phoneKey", { length: 10 }),
  location: varchar("location", { length: 60 }),
  clinicId: int("clinicId").references(() => clinics.id),
  provider: varchar("provider", { length: 80 }),
  visitType: varchar("visitType", { length: 80 }),
  preferred: varchar("preferred", { length: 100 }),
  preferredDate: varchar("preferredDate", { length: 10 }),
  spanish: boolean("spanish").default(false).notNull(),
  status: mysqlEnum("status", ["new", "no_answer", "scheduled", "not_booked", "spam", "earlier"]).notNull(),
  attempts: int("attempts").default(0).notNull(),
  subjectKey: varchar("subjectKey", { length: 120 }),
  patientId: int("patientId").references(() => patients.id),
  patientName: varchar("patientName", { length: 255 }),
  taskId: int("taskId"),
  assignedUserId: int("assignedUserId").references(() => users.id),
  firstContactAt: datetime("firstContactAt"),
  handledByUserId: int("handledByUserId").references(() => users.id),
  handledAt: datetime("handledAt"),
  note: text("note"),
  gmailId: varchar("gmailId", { length: 64 }).unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  statusIdx: index("bookingRequests_status_idx").on(t.status, t.receivedAt),
}));

/**
 * Patient forms library: agreements / consents the practice sends (wording pasted in by an admin,
 * per language). Editing bumps the version; every signature keeps the exact text that was signed.
 */
export const intakeDocuments = mysqlTable("intakeDocuments", {
  id: int("id").autoincrement().primaryKey(),
  title: json("title").$type<Record<string, string>>().notNull(),
  body: json("body").$type<Record<string, string>>().notNull(),
  version: int("version").default(1).notNull(),
  active: boolean("active").default(true).notNull(),
  sortOrder: int("sortOrder").default(0).notNull(),
  /** A consent MyPCP records (communications | ccm | bhi | apcm): the patient may agree or decline. */
  consentKind: varchar("consentKind", { length: 20 }),
  /** Open link for the website (mypcpcare.com/sign/<slug>): anyone can fill it in without a sent link. */
  publicSlug: varchar("publicSlug", { length: 40 }).unique(),
  /** Yes/No consent questions inside this form (ConsentChoice[]), e.g. texting, CCM, APCM, BHI, RPM. */
  choices: json("choices").$type<{ kind: string; title: Record<string, string>; body: Record<string, string> }[]>(),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/** Forms sent to one patient: a private link (DOB-checked) that they fill in and sign. */
export const intakePackets = mysqlTable("intakePackets", {
  id: int("id").autoincrement().primaryKey(),
  /** SHA-256 of the link token (the token itself is only kept sealed, for "copy link"). */
  tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
  tokenSealed: text("tokenSealed").notNull(),
  subjectKey: varchar("subjectKey", { length: 120 }),
  patientId: int("patientId").references(() => patients.id),
  name: varchar("name", { length: 255 }).notNull(),
  /** YYYY-MM-DD; the patient must enter it to open the forms. */
  dob: varchar("dob", { length: 10 }).notNull(),
  phone: varchar("phone", { length: 30 }),
  email: varchar("email", { length: 320 }),
  language: varchar("language", { length: 2 }).default("en").notNull(),
  /** "medical_intake" and/or "doc:<intakeDocuments.id>", in order. */
  forms: json("forms").$type<string[]>().notNull(),
  clinicId: int("clinicId").references(() => clinics.id),
  status: mysqlEnum("status", ["waiting", "opened", "in_progress", "completed", "filed", "cancelled"]).default("waiting").notNull(),
  /** email | text | link */
  sentVia: varchar("sentVia", { length: 10 }),
  sentAt: datetime("sentAt"),
  sendCount: int("sendCount").default(0).notNull(),
  openedAt: datetime("openedAt"),
  completedAt: datetime("completedAt"),
  expiresAt: datetime("expiresAt").notNull(),
  failedDobAttempts: int("failedDobAttempts").default(0).notNull(),
  lockedUntil: datetime("lockedUntil"),
  /** Questionnaire answers by form key (saved as the patient goes). */
  answers: json("answers").$type<Record<string, Record<string, unknown>>>(),
  taskId: int("taskId"),
  bookingRequestId: int("bookingRequestId"),
  /** staff (a link staff sent) | website (filled in from an open link on the website) */
  source: varchar("source", { length: 10 }).default("staff").notNull(),
  filedAt: datetime("filedAt"),
  filedByUserId: int("filedByUserId").references(() => users.id),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  statusIdx: index("intakePackets_status_idx").on(t.status, t.createdAt),
  subjectIdx: index("intakePackets_subject_idx").on(t.subjectKey),
}));

/** One signed form in a packet: who signed, how, when, from where, and the exact text (hashed). */
export const intakeSignatures = mysqlTable("intakeSignatures", {
  id: int("id").autoincrement().primaryKey(),
  packetId: int("packetId").notNull().references(() => intakePackets.id),
  formKey: varchar("formKey", { length: 40 }).notNull(),
  formTitle: varchar("formTitle", { length: 255 }).notNull(),
  language: varchar("language", { length: 2 }).notNull(),
  formVersion: int("formVersion").notNull(),
  /** What was signed: the agreement text, or the questionnaire answers + attestation (JSON). */
  snapshot: mediumtext("snapshot").notNull(),
  textHash: varchar("textHash", { length: 64 }).notNull(),
  signerName: varchar("signerName", { length: 160 }).notNull(),
  /** self | spouse | child | parent | caregiver | guardian | other */
  signerRelation: varchar("signerRelation", { length: 20 }).notNull(),
  /** Someone else answering for the patient on an agreement: their legal authority (poa | guardian | parent_minor | other). */
  signerAuthority: varchar("signerAuthority", { length: 20 }),
  authorityNote: varchar("authorityNote", { length: 160 }),
  /** signed | declined (only consents can be declined) */
  decision: varchar("decision", { length: 10 }).default("signed").notNull(),
  /** The consent this records, as the form was set up when signed (communications | ccm | apcm | bhi | rpm). */
  consentKind: varchar("consentKind", { length: 20 }),
  /** Answers to the form's Yes/No consent questions, by kind ({ ccm: "yes", rpm: "no", … }). */
  choices: json("choices").$type<Record<string, "yes" | "no">>(),
  /** typed | drawn */
  method: varchar("method", { length: 10 }).notNull(),
  signatureFileId: int("signatureFileId"),
  signedAt: datetime("signedAt").notNull(),
  ip: varchar("ip", { length: 64 }),
  userAgent: varchar("userAgent", { length: 255 }),
  /** SHA-256 over everything above: changes if any of it is altered. */
  docHash: varchar("docHash", { length: 64 }).notNull(),
}, (t) => ({
  packetFormUnique: uniqueIndex("intakeSignatures_packet_form_unique").on(t.packetId, t.formKey),
}));

/** Photos (insurance card, ID) and drawn signatures, base64. */
export const intakeFiles = mysqlTable("intakeFiles", {
  id: int("id").autoincrement().primaryKey(),
  packetId: int("packetId").notNull().references(() => intakePackets.id),
  /** insurance_front | insurance_back | photo_id | signature */
  kind: varchar("kind", { length: 30 }).notNull(),
  mime: varchar("mime", { length: 40 }).notNull(),
  data: mediumtext("data").notNull(),
  size: int("size").notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  packetIdx: index("intakeFiles_packet_idx").on(t.packetId),
}));

/**
 * A patient said Yes to a program (CCM / APCM / BHI / RPM) on a consent form. Enrolled automatically as
 * soon as they're on the roster and their diagnoses on file qualify; until then it waits (re-checked
 * on a schedule). A later No cancels it.
 */
export const consentEnrollments = mysqlTable("consentEnrollments", {
  id: int("id").autoincrement().primaryKey(),
  subjectKey: varchar("subjectKey", { length: 120 }),
  patientId: int("patientId").references(() => patients.id),
  /** From the form, to find them on the roster later. */
  name: varchar("name", { length: 255 }).notNull(),
  dob: varchar("dob", { length: 10 }),
  program: varchar("program", { length: 10 }).notNull(),
  /** waiting | enrolled | cancelled */
  status: varchar("status", { length: 12 }).default("waiting").notNull(),
  packetId: int("packetId").references(() => intakePackets.id),
  consentedAt: datetime("consentedAt").notNull(),
  enrolledAt: datetime("enrolledAt"),
  lastCheckedAt: datetime("lastCheckedAt"),
  /** Why it's still waiting ("Needs 2 or more chronic conditions on file"), or what happened. */
  note: varchar("note", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  statusIdx: index("consentEnrollments_status_idx").on(t.status),
  subjectIdx: index("consentEnrollments_subject_idx").on(t.subjectKey),
}));

/** Audit trail for a packet (sent, opened, date-of-birth checks, signed, filed…). */
export const intakeEvents = mysqlTable("intakeEvents", {
  id: int("id").autoincrement().primaryKey(),
  packetId: int("packetId").notNull().references(() => intakePackets.id),
  at: datetime("at").notNull(),
  type: varchar("type", { length: 30 }).notNull(),
  userId: int("userId").references(() => users.id),
  ip: varchar("ip", { length: 64 }),
  userAgent: varchar("userAgent", { length: 255 }),
  detail: varchar("detail", { length: 255 }),
}, (t) => ({
  packetIdx: index("intakeEvents_packet_idx").on(t.packetId, t.at),
}));

/**
 * Documents (our own DocuSign): a PDF with boxes placed on it, filled in by whoever prepares it and then
 * signed by teammates. The PDFs themselves live in the document store (private S3 bucket); this row holds
 * where they are, the boxes, and who has signed.
 */
export const documents = mysqlTable("documents", {
  id: int("id").autoincrement().primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  isTemplate: boolean("isTemplate").default(false).notNull(),
  templateId: int("templateId"),
  /** draft | signing | completed | cancelled */
  status: varchar("status", { length: 12 }).default("draft").notNull(),
  fileKey: varchar("fileKey", { length: 255 }),
  fileName: varchar("fileName", { length: 255 }),
  fileSize: int("fileSize"),
  fileSha256: varchar("fileSha256", { length: 64 }),
  pages: json("pages").$type<{ w: number; h: number; rotate: number }[]>(),
  fields: json("fields").$type<unknown[]>(),
  finalKey: varchar("finalKey", { length: 255 }),
  finalSha256: varchar("finalSha256", { length: 64 }),
  subjectKey: varchar("subjectKey", { length: 120 }),
  patientId: int("patientId").references(() => patients.id),
  clinicId: int("clinicId").references(() => clinics.id),
  message: varchar("message", { length: 1000 }),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  sentAt: datetime("sentAt"),
  completedAt: datetime("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  statusIdx: index("documents_status_idx").on(t.status, t.updatedAt),
  creatorIdx: index("documents_creator_idx").on(t.createdByUserId, t.status),
  subjectIdx: index("documents_subject_idx").on(t.subjectKey),
}));

/** Teammates asked to sign a document. */
export const documentSigners = mysqlTable("documentSigners", {
  id: int("id").autoincrement().primaryKey(),
  documentId: int("documentId").notNull().references(() => documents.id),
  userId: int("userId").notNull().references(() => users.id),
  sortOrder: int("sortOrder").default(0).notNull(),
  /** pending | signed */
  status: varchar("status", { length: 10 }).default("pending").notNull(),
  taskId: int("taskId"),
  signedAt: datetime("signedAt"),
  ip: varchar("ip", { length: 64 }),
  userAgent: varchar("userAgent", { length: 255 }),
}, (t) => ({
  userIdx: index("documentSigners_user_idx").on(t.userId, t.status),
  docIdx: index("documentSigners_doc_idx").on(t.documentId),
}));

/** A signature or initials stamped into a document box (PNG), with who / when / from where. */
export const documentSignatures = mysqlTable("documentSignatures", {
  id: int("id").autoincrement().primaryKey(),
  documentId: int("documentId").notNull().references(() => documents.id),
  fieldId: varchar("fieldId", { length: 40 }).notNull(),
  userId: int("userId").notNull().references(() => users.id),
  kind: varchar("kind", { length: 10 }).notNull(),
  png: mediumtext("png").notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  /** A provider's stored signature applied by staff (userId) with the provider's approval. */
  onBehalfOfUserId: int("onBehalfOfUserId").references(() => users.id),
  /** in_person | phone | text | other */
  approvalMethod: varchar("approvalMethod", { length: 20 }),
  approvalNote: varchar("approvalNote", { length: 255 }),
  signedAt: datetime("signedAt").notNull(),
  ip: varchar("ip", { length: 64 }),
  userAgent: varchar("userAgent", { length: 255 }),
}, (t) => ({
  docIdx: index("documentSignatures_doc_idx").on(t.documentId),
}));

/** Audit trail for a document (uploaded, sent, viewed, signed, completed, downloaded…). */
export const documentEvents = mysqlTable("documentEvents", {
  id: int("id").autoincrement().primaryKey(),
  documentId: int("documentId").notNull().references(() => documents.id),
  at: datetime("at").notNull(),
  type: varchar("type", { length: 30 }).notNull(),
  userId: int("userId").references(() => users.id),
  ip: varchar("ip", { length: 64 }),
  userAgent: varchar("userAgent", { length: 255 }),
  detail: varchar("detail", { length: 255 }),
}, (t) => ({
  docIdx: index("documentEvents_doc_idx").on(t.documentId, t.at),
}));

/**
 * Providers' signatures that chosen staff may apply to administrative documents after the provider
 * approves (never for Medicare orders, prescriptions or medical-record entries). Admins add them;
 * each provider can replace their own.
 */
export const providerSignatures = mysqlTable("providerSignatures", {
  providerUserId: int("providerUserId").primaryKey().references(() => users.id),
  signaturePng: mediumtext("signaturePng"),
  initialsPng: mediumtext("initialsPng"),
  /** Staff may use it (the provider or an admin can switch it off any time). */
  enabled: boolean("enabled").default(true).notNull(),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Who may apply a provider's signature (each provider, or an admin, picks). */
export const providerSignatureDelegates = mysqlTable("providerSignatureDelegates", {
  id: int("id").autoincrement().primaryKey(),
  providerUserId: int("providerUserId").notNull().references(() => users.id),
  delegateUserId: int("delegateUserId").notNull().references(() => users.id),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  pairUnique: uniqueIndex("providerSignatureDelegates_pair_unique").on(t.providerUserId, t.delegateUserId),
  delegateIdx: index("providerSignatureDelegates_delegate_idx").on(t.delegateUserId),
}));

/** Each person's saved signature and initials (drawn once, reused with one tap). */
export const userSignatures = mysqlTable("userSignatures", {
  userId: int("userId").primaryKey().references(() => users.id),
  signaturePng: mediumtext("signaturePng"),
  initialsPng: mediumtext("initialsPng"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** A patient's insurance as MyPCP knows it (for eligibility checks): Availity payer + member ID. */
export const coverageOnFile = mysqlTable("coverageOnFile", {
  subjectKey: varchar("subjectKey", { length: 120 }).primaryKey(),
  patientId: int("patientId").references(() => patients.id),
  /** Availity payer ID (from Availity's payer list). */
  payerId: varchar("payerId", { length: 40 }).notNull(),
  payerName: varchar("payerName", { length: 160 }),
  memberId: varchar("memberId", { length: 60 }).notNull(),
  groupNumber: varchar("groupNumber", { length: 60 }),
  /** manual | check */
  source: varchar("source", { length: 20 }).notNull(),
  updatedByUserId: int("updatedByUserId").references(() => users.id),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Eligibility checks sent to Availity (by staff, or the nightly check of the next day's schedule). */
export const eligibilityChecks = mysqlTable("eligibilityChecks", {
  id: int("id").autoincrement().primaryKey(),
  subjectKey: varchar("subjectKey", { length: 120 }).notNull(),
  patientId: int("patientId").references(() => patients.id),
  patientName: varchar("patientName", { length: 255 }),
  payerId: varchar("payerId", { length: 40 }).notNull(),
  payerName: varchar("payerName", { length: 160 }),
  memberId: varchar("memberId", { length: 60 }).notNull(),
  /** Date of service asked about (YYYY-MM-DD). */
  asOfDate: varchar("asOfDate", { length: 10 }).notNull(),
  /** manual | nightly */
  trigger: varchar("trigger", { length: 10 }).notNull(),
  /** demo | production */
  mode: varchar("mode", { length: 12 }).notNull(),
  clinicId: int("clinicId").references(() => clinics.id),
  availityId: varchar("availityId", { length: 64 }),
  status: mysqlEnum("status", ["pending", "complete", "error"]).default("pending").notNull(),
  statusCode: varchar("statusCode", { length: 4 }),
  /** CoverageSummary (shared/eligibility.ts). */
  summary: json("summary"),
  /** Availity's full answer, gzip + base64. */
  raw: mediumtext("raw"),
  error: varchar("error", { length: 500 }),
  requestedByUserId: int("requestedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  subjectIdx: index("eligibilityChecks_subject_idx").on(t.subjectKey, t.createdAt),
  dateIdx: index("eligibilityChecks_date_idx").on(t.asOfDate, t.trigger),
  pendingIdx: index("eligibilityChecks_status_idx").on(t.status, t.createdAt),
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

// ---------------------------------------------------------------------------
// Square payments (added 2026-09-30). Square is the source of truth for the money; MyPCP adds who
// the patient is, what the payment was for, and which office took it. Square doesn't sign a BAA,
// so nothing clinical is sent to Square: the reason for a payment stays here.
// ---------------------------------------------------------------------------

/** Square customers (the payer as Square knows them), and the patient MyPCP matched them to. */
export const squareCustomers = mysqlTable("squareCustomers", {
  id: varchar("id", { length: 64 }).primaryKey(),
  givenName: varchar("givenName", { length: 120 }),
  familyName: varchar("familyName", { length: 120 }),
  phone: varchar("phone", { length: 40 }),
  email: varchar("email", { length: 320 }),
  subjectKey: varchar("subjectKey", { length: 120 }),
  patientName: varchar("patientName", { length: 255 }),
  /** phone | email | manual */
  matchedBy: varchar("matchedBy", { length: 12 }),
  /** A likely patient by name only: shown for one-tap confirmation, never linked automatically. */
  suggestKey: varchar("suggestKey", { length: 120 }),
  suggestName: varchar("suggestName", { length: 255 }),
  syncedAt: datetime("syncedAt").notNull(),
}, (t) => ({
  subjectIdx: index("squareCustomers_subject_idx").on(t.subjectKey),
}));

export const squarePayments = mysqlTable("squarePayments", {
  id: varchar("id", { length: 64 }).primaryKey(),
  /** When Square took the payment. */
  createdAt: datetime("createdAt").notNull(),
  updatedAtSq: datetime("updatedAtSq"),
  /** COMPLETED | APPROVED | PENDING | CANCELED | FAILED */
  status: varchar("status", { length: 20 }).notNull(),
  /** CARD | CASH | WALLET | EXTERNAL | BANK_ACCOUNT | … */
  sourceType: varchar("sourceType", { length: 30 }),
  amountCents: int("amountCents").notNull().default(0),
  tipCents: int("tipCents").notNull().default(0),
  totalCents: int("totalCents").notNull().default(0),
  refundedCents: int("refundedCents").notNull().default(0),
  feeCents: int("feeCents").notNull().default(0),
  cardBrand: varchar("cardBrand", { length: 30 }),
  cardLast4: varchar("cardLast4", { length: 4 }),
  customerId: varchar("customerId", { length: 64 }),
  orderId: varchar("orderId", { length: 64 }),
  locationId: varchar("locationId", { length: 64 }),
  deviceId: varchar("deviceId", { length: 64 }),
  deviceName: varchar("deviceName", { length: 120 }),
  teamMemberId: varchar("teamMemberId", { length: 64 }),
  /** What was rung up in Square (item names), for sorting. */
  items: varchar("items", { length: 500 }),
  /** Square's note on the payment. */
  note: varchar("note", { length: 500 }),
  receiptUrl: varchar("receiptUrl", { length: 500 }),
  receiptNumber: varchar("receiptNumber", { length: 20 }),
  category: varchar("category", { length: 20 }),
  /** auto | request | manual */
  categorySource: varchar("categorySource", { length: 10 }),
  subjectKey: varchar("subjectKey", { length: 120 }),
  patientId: int("patientId").references(() => patients.id),
  patientName: varchar("patientName", { length: 255 }),
  /** customer | request | manual */
  matchSource: varchar("matchSource", { length: 10 }),
  clinicId: int("clinicId").references(() => clinics.id),
  /** request | device | patient | manual */
  clinicSource: varchar("clinicSource", { length: 10 }),
  requestId: int("requestId"),
  /** Staff's own note (MyPCP only). */
  memo: varchar("memo", { length: 500 }),
  linkedByUserId: int("linkedByUserId").references(() => users.id),
  linkedAt: datetime("linkedAt"),
  syncedAt: datetime("syncedAt").notNull(),
}, (t) => ({
  createdIdx: index("squarePayments_created_idx").on(t.createdAt),
  subjectIdx: index("squarePayments_subject_idx").on(t.subjectKey, t.createdAt),
  customerIdx: index("squarePayments_customer_idx").on(t.customerId),
  orderIdx: index("squarePayments_order_idx").on(t.orderId),
  clinicIdx: index("squarePayments_clinic_idx").on(t.clinicId, t.createdAt),
  deviceIdx: index("squarePayments_device_idx").on(t.deviceId),
}));

export const squareRefunds = mysqlTable("squareRefunds", {
  id: varchar("id", { length: 64 }).primaryKey(),
  paymentId: varchar("paymentId", { length: 64 }).notNull(),
  /** PENDING | COMPLETED | REJECTED | FAILED */
  status: varchar("status", { length: 20 }).notNull(),
  amountCents: int("amountCents").notNull().default(0),
  reason: varchar("reason", { length: 255 }),
  createdAt: datetime("createdAt").notNull(),
  syncedAt: datetime("syncedAt").notNull(),
}, (t) => ({
  paymentIdx: index("squareRefunds_payment_idx").on(t.paymentId),
  createdIdx: index("squareRefunds_created_idx").on(t.createdAt),
}));

/** Payment links and Square Terminal charges started from MyPCP. */
export const squareRequests = mysqlTable("squareRequests", {
  id: int("id").autoincrement().primaryKey(),
  kind: mysqlEnum("kind", ["link", "terminal"]).notNull(),
  /** Square's payment-link id or Terminal checkout id. */
  squareId: varchar("squareId", { length: 64 }),
  orderId: varchar("orderId", { length: 64 }),
  url: varchar("url", { length: 500 }),
  amountCents: int("amountCents").notNull(),
  category: varchar("category", { length: 20 }).notNull(),
  /** What it's for (MyPCP only, never sent to Square). */
  purpose: varchar("purpose", { length: 255 }),
  subjectKey: varchar("subjectKey", { length: 120 }),
  patientId: int("patientId").references(() => patients.id),
  patientName: varchar("patientName", { length: 255 }),
  clinicId: int("clinicId").references(() => clinics.id),
  deviceId: varchar("deviceId", { length: 64 }),
  /** open | paid | canceled | failed */
  status: varchar("status", { length: 12 }).notNull().default("open"),
  squareStatus: varchar("squareStatus", { length: 24 }),
  paymentId: varchar("paymentId", { length: 64 }),
  /** text | email | copy */
  sentVia: varchar("sentVia", { length: 8 }),
  sentTo: varchar("sentTo", { length: 64 }),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  paidAt: datetime("paidAt"),
}, (t) => ({
  subjectIdx: index("squareRequests_subject_idx").on(t.subjectKey, t.createdAt),
  statusIdx: index("squareRequests_status_idx").on(t.status, t.createdAt),
  orderIdx: index("squareRequests_order_idx").on(t.orderId),
  squareIdx: index("squareRequests_square_idx").on(t.squareId),
}));

/**
 * A provider's team (added 2026-09-30): the people who work with that provider (their MAs etc.).
 * Patient emails for the provider's patients go to the team's shared queue ("team:<providerId>"),
 * and the provider's own login is always on the team. A provider with no members set up keeps the
 * old routing (care coordinator → front desk).
 */
export const providerTeamMembers = mysqlTable("providerTeamMembers", {
  id: int("id").autoincrement().primaryKey(),
  providerId: int("providerId").notNull().references(() => providers.id),
  userId: int("userId").notNull().references(() => users.id),
  createdByUserId: int("createdByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  pairUnique: uniqueIndex("providerTeamMembers_pair_unique").on(t.providerId, t.userId),
  userIdx: index("providerTeamMembers_user_idx").on(t.userId),
}));

/**
 * Files staff put in a patient's folder (added 2026-09-30): scans, insurance card / ID photos, outside
 * records. The bytes live in the private documents bucket (documents/patient-files/…); removing a file
 * hides it (kept for the record).
 */
export const patientFiles = mysqlTable("patientFiles", {
  id: int("id").autoincrement().primaryKey(),
  subjectKey: varchar("subjectKey", { length: 120 }).notNull(),
  patientId: int("patientId").references(() => patients.id),
  clinicId: int("clinicId").references(() => clinics.id),
  fileType: varchar("fileType", { length: 24 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  note: varchar("note", { length: 500 }),
  storageKey: varchar("storageKey", { length: 200 }).notNull(),
  fileName: varchar("fileName", { length: 255 }),
  mimeType: varchar("mimeType", { length: 80 }).notNull(),
  sizeBytes: int("sizeBytes"),
  /** uploading | ready */
  status: varchar("status", { length: 12 }).notNull().default("uploading"),
  uploadedByUserId: int("uploadedByUserId").references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  removedAt: datetime("removedAt"),
  removedByUserId: int("removedByUserId").references(() => users.id),
}, (t) => ({
  subjectIdx: index("patientFiles_subject_idx").on(t.subjectKey, t.createdAt),
  patientIdx: index("patientFiles_patient_idx").on(t.patientId),
}));
