// The bell's notification types, which each person can switch on or off (2026-11-11: "I have too many
// notifications ... I want to change the type of notifications I get"). Notifications are stored with
// a coarse `type`, so the kind is worked out from the type and the title the sender used.

export const NOTIFICATION_KINDS = {
  my_tasks: { label: "Tasks assigned to me", hint: "Someone gives you a task or moves one to you." },
  team_tasks: { label: "Tasks for my provider team", hint: "Patient emails and tasks sent to a provider's whole team." },
  program_approvals: { label: "Program approvals", hint: "Patients whose diagnoses qualify for CCM, BHI, RPM or APCM." },
  documents: { label: "Documents and signatures", hint: "Documents to sign, finished documents, signatures used." },
  time_off: { label: "Time off", hint: "Time-off requests and answers." },
  shifts: { label: "Shifts and schedules", hint: "Call-outs, shift pickups and swaps, schedule changes." },
  time_clock: { label: "Time clock and attendance", hint: "Clock-in reminders, late / no-show / missed-punch alerts, punch fixes." },
  care_updates: { label: "Refills and care updates", hint: "Refill requests and decisions, care-management updates." },
  patient_safety: { label: "Urgent patient alerts", hint: "Urgent symptoms and escalations. Always on." },
} as const;
export type NotificationKind = keyof typeof NOTIFICATION_KINDS;
export const NOTIFICATION_KIND_LIST = Object.keys(NOTIFICATION_KINDS) as NotificationKind[];

/** Kinds nobody can switch off (patient safety). */
export const ALWAYS_ON: readonly NotificationKind[] = ["patient_safety"];

const TIME_CLOCK = /^(Time clock$|Punch fix |Clocked |Didn't clock |Late: |No lunch break: |No-show: )/;

export function notificationKind(type: string, title: string): NotificationKind {
  if (type === "urgent_symptom" || type === "escalation") return "patient_safety";
  if (type === "workforce") {
    if (TIME_CLOCK.test(title)) return "time_clock";
    if (/^Time[- ]off /.test(title)) return "time_off";
    return "shifts";
  }
  if (type === "task") {
    if (title === "New task for your team") return "team_tasks";
    if (/qualif(y|ies) for care programs$/.test(title)) return "program_approvals";
    if (/^Document |^Your .+ was used$|^Your stored signature /.test(title)) return "documents";
    return "my_tasks";
  }
  return "care_updates";
}

/** A saved "off" list, cleaned: known kinds only, never an always-on one. */
export function cleanOffKinds(value: unknown): NotificationKind[] {
  const list = Array.isArray(value) ? value : [];
  return NOTIFICATION_KIND_LIST.filter((k) => list.includes(k) && !ALWAYS_ON.includes(k));
}
