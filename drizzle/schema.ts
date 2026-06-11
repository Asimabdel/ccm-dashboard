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
  role: mysqlEnum("role", ["admin", "staff", "provider", "billing", "front_desk", "user"]).default("user").notNull(),
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
  role: mysqlEnum("role", ["admin", "staff", "provider", "billing", "front_desk", "user"]).default("staff").notNull(),
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
  clinicId: int("clinicId").references(() => clinics.id).notNull(),
  providerId: int("providerId").references(() => providers.id).notNull(),
  preferredLanguage: varchar("preferredLanguage", { length: 50 }).default("English"),
  chronicConditions: json("chronicConditions").$type<string[]>().default([]),
  insurance: text("insurance"),
  ccmEnrollmentStatus: mysqlEnum("ccmEnrollmentStatus", ["active", "inactive", "declined", "transferred"]).default("active"),
  consentStatus: mysqlEnum("consentStatus", ["consented", "pending", "declined"]).default("pending"),
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
});

export type Patient = typeof patients.$inferSelect;
export type InsertPatient = typeof patients.$inferInsert;

/**
 * Monthly CCM tasks/worklist items
 */
export const ccmTasks = mysqlTable("ccmTasks", {
  id: int("id").autoincrement().primaryKey(),
  patientId: int("patientId").references(() => patients.id).notNull(),
  month: varchar("month", { length: 7 }).notNull(), // YYYY-MM format
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
});

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
  timeThresholdMet: boolean("timeThresholdMet").default(false),
  documentationComplete: boolean("documentationComplete").default(false),
  providerAssociated: boolean("providerAssociated").default(false),
  carePlanReviewed: boolean("carePlanReviewed").default(false),
  noMissingFields: boolean("noMissingFields").default(false),
  providerReviewCompleted: boolean("providerReviewCompleted").default(false),
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
  type: mysqlEnum("type", ["urgent_symptom", "escalation", "missing_documentation", "not_reached", "billing_ready"]).notNull(),
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
    "logout",
  ]).notNull(),
  entityType: varchar("entityType", { length: 50 }),
  entityId: int("entityId"),
  description: text("description"),
  ipAddress: varchar("ipAddress", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;
