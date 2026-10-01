import type React from "react";
import {
  LayoutDashboard, Users, ClipboardList, UserCog, AlertTriangle, Receipt,
  BarChart3, PhoneCall, CalendarClock, ShieldCheck, Building2, Stethoscope, Target,
  UserMinus, Ban, Pill, PhoneOutgoing, Activity, Sunrise, CalendarDays, BriefcaseBusiness,
  Home, ListTodo, Waypoints, Radar, BookOpen, UsersRound, PlugZap, Mail, BadgeCheck, Gauge, Printer, CalendarPlus, ClipboardSignature, FileSignature, Wallet,
} from "lucide-react";

export interface NavItem {
  label: string;
  path: string;
  icon: React.ElementType;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export type Role = "admin" | "office_manager" | "staff" | "provider" | "billing" | "front_desk" | "medical_assistant";

const HOME: NavItem = { label: "Home", path: "/home", icon: Home };
const MY_WORK: NavItem = { label: "My Work", path: "/my-work", icon: ListTodo };
const FLOW: NavItem = { label: "Patient Flow", path: "/patient-flow", icon: Waypoints };
const OPPORTUNITIES: NavItem = { label: "Opportunities", path: "/opportunities", icon: Radar };
const PATIENTS: NavItem = { label: "Patients", path: "/patients", icon: Users };
const PLAYBOOKS: NavItem = { label: "Playbooks", path: "/playbooks", icon: BookOpen };
const EMAILS: NavItem = { label: "Patient emails", path: "/patient-emails", icon: Mail };
const FAXES: NavItem = { label: "Fax inbox", path: "/faxes", icon: Printer };
const BOOKINGS: NavItem = { label: "Website bookings", path: "/bookings", icon: CalendarPlus };
const FORMS: NavItem = { label: "Patient forms", path: "/intake-forms", icon: ClipboardSignature };
const DOCUMENTS: NavItem = { label: "Documents", path: "/documents", icon: FileSignature };
const INSURANCE: NavItem = { label: "Insurance checker", path: "/insurance", icon: BadgeCheck };
const PAYMENTS: NavItem = { label: "Payments", path: "/payments", icon: Wallet };

// Every employee gets the self-service time clock + schedule pages and the team schedule.
const ME: NavGroup = {
  label: "Me",
  items: [
    { label: "My Day", path: "/my-day", icon: Sunrise },
    { label: "My Schedule", path: "/my-schedule", icon: CalendarDays },
    { label: "Team Schedule", path: "/team-schedule", icon: UsersRound },
  ],
};

/** Role-based, grouped navigation for the Workspace sidebar. */
export const NAV_GROUPS: Record<Role, NavGroup[]> = {
  admin: [
    { label: "Workspace", items: [HOME, MY_WORK, BOOKINGS, FORMS, DOCUMENTS, EMAILS, FAXES, FLOW, OPPORTUNITIES, PATIENTS, INSURANCE, PLAYBOOKS] },
    {
      label: "Care Management",
      items: [
        { label: "CCM Dashboard", path: "/admin", icon: LayoutDashboard },
        { label: "Monthly Worklist", path: "/worklist", icon: ClipboardList },
        { label: "Staff Assignment", path: "/assignment", icon: UserCog },
        { label: "APCM", path: "/apcm", icon: Activity },
        { label: "Reach Out", path: "/reach-out", icon: PhoneOutgoing },
        { label: "Escalations", path: "/escalations", icon: AlertTriangle },
        { label: "Refill Requests", path: "/refill-requests", icon: Pill },
        { label: "Follow-ups", path: "/follow-ups", icon: CalendarClock },
        { label: "Inactive Patients", path: "/inactive-patients", icon: UserMinus },
        { label: "Declined CCM", path: "/declined-patients", icon: Ban },
        { label: "Coordinators", path: "/coordinator", icon: Target },
      ],
    },
    {
      label: "Revenue",
      items: [
        PAYMENTS,
        { label: "Billing", path: "/billing", icon: Receipt },
        { label: "Reports", path: "/reports", icon: BarChart3 },
      ],
    },
    {
      label: "Admin",
      items: [
        { label: "Providers", path: "/providers", icon: Stethoscope },
        { label: "Clinics", path: "/clinics", icon: Building2 },
        { label: "Team progress", path: "/team-progress", icon: Gauge },
        { label: "Workforce", path: "/workforce", icon: BriefcaseBusiness },
        { label: "Team & Access", path: "/team", icon: UserCog },
        { label: "Integrations", path: "/integrations", icon: PlugZap },
        { label: "Audit Log", path: "/audit", icon: ShieldCheck },
      ],
    },
    ME,
  ],
  // Admin for one office (their home clinic): everything here is limited to that office. No CCM pages.
  office_manager: [
    { label: "Workspace", items: [HOME, MY_WORK, BOOKINGS, FORMS, DOCUMENTS, FLOW, OPPORTUNITIES, INSURANCE, PAYMENTS, PLAYBOOKS] },
    {
      label: "My office",
      items: [
        { label: "Workforce", path: "/workforce", icon: BriefcaseBusiness },
        { label: "Team progress", path: "/team-progress", icon: Gauge },
        { label: "Staff logins", path: "/team", icon: UserCog },
      ],
    },
    ME,
  ],
  staff: [
    { label: "Workspace", items: [HOME, MY_WORK, BOOKINGS, FORMS, DOCUMENTS, EMAILS, FAXES, FLOW, OPPORTUNITIES, PATIENTS, INSURANCE, PLAYBOOKS] },
    {
      label: "Care Management",
      items: [
        { label: "CCM Dashboard", path: "/coordinator", icon: LayoutDashboard },
        { label: "My Worklist", path: "/worklist", icon: ClipboardList },
        { label: "Call Workflow", path: "/workflow", icon: PhoneCall },
        { label: "APCM", path: "/apcm", icon: Activity },
        { label: "Reach Out", path: "/reach-out", icon: PhoneOutgoing },
        { label: "Inactive Patients", path: "/inactive-patients", icon: UserMinus },
        { label: "Declined CCM", path: "/declined-patients", icon: Ban },
      ],
    },
    ME,
  ],
  provider: [
    { label: "Workspace", items: [HOME, MY_WORK, FORMS, DOCUMENTS, FLOW, OPPORTUNITIES, PATIENTS, INSURANCE, PLAYBOOKS] },
    {
      label: "Care Management",
      items: [
        { label: "Refill Requests", path: "/refill-requests", icon: Pill },
        { label: "Escalations", path: "/escalations", icon: AlertTriangle },
      ],
    },
    ME,
  ],
  billing: [
    { label: "Workspace", items: [HOME, MY_WORK, INSURANCE, PLAYBOOKS] },
    {
      label: "Revenue",
      items: [
        { label: "Billing Records", path: "/billing", icon: Receipt },
        { label: "Reports", path: "/reports", icon: BarChart3 },
      ],
    },
    ME,
  ],
  front_desk: [
    { label: "Workspace", items: [HOME, MY_WORK, BOOKINGS, FORMS, DOCUMENTS, EMAILS, FAXES, FLOW, OPPORTUNITIES, PATIENTS, INSURANCE, PAYMENTS, PLAYBOOKS] },
    { label: "Care Management", items: [{ label: "Follow-ups", path: "/follow-ups", icon: CalendarClock }] },
    ME,
  ],
  // MAs get operational pages only; the server fences CCM/billing data away from them.
  // Since 2026-10-01: the front desk's pages (each limited to the clinic they work at).
  medical_assistant: [
    { label: "Workspace", items: [HOME, MY_WORK, BOOKINGS, FORMS, DOCUMENTS, EMAILS, FAXES, FLOW, OPPORTUNITIES, PATIENTS, INSURANCE, PAYMENTS, PLAYBOOKS] },
    { label: "Care Management", items: [{ label: "Follow-ups", path: "/follow-ups", icon: CalendarClock }] },
    ME,
  ],
};

/** Flat list per role — used by the ⌘K command palette. */
export const NAV: Record<Role, NavItem[]> = Object.fromEntries(
  Object.entries(NAV_GROUPS).map(([role, groups]) => [role, groups.flatMap((g) => g.items)]),
) as Record<Role, NavItem[]>;

export const ROLES = [
  { value: "admin", label: "Admin / Practice Manager" },
  { value: "staff", label: "CCM Staff / Care Coordinator" },
  { value: "provider", label: "Provider" },
  { value: "billing", label: "Billing" },
  { value: "front_desk", label: "Front Desk" },
] as const;

/**
 * Where each role lands after signing in. Existing roles keep the page they
 * already start their day on; Home is one click away in the sidebar.
 */
export const ROLE_HOME: Record<string, string> = {
  admin: "/home",
  staff: "/worklist",
  provider: "/refill-requests",
  billing: "/billing",
  front_desk: "/follow-ups",
  office_manager: "/home",
  medical_assistant: "/home",
  user: "/home",
};
