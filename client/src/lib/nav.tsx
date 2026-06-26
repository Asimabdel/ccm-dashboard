import type React from "react";
import {
  LayoutDashboard, Users, ClipboardList, UserCog, AlertTriangle, Receipt,
  BarChart3, PhoneCall, CalendarClock, ShieldCheck, Building2, Stethoscope, Target,
  UserMinus, Ban,
} from "lucide-react";

export interface NavItem {
  label: string;
  path: string;
  icon: React.ElementType;
}

export type Role = "admin" | "staff" | "provider" | "billing" | "front_desk";

/** Role-based navigation. Shared by the sidebar (CCMDashboardLayout) and the ⌘K command palette. */
export const NAV: Record<Role, NavItem[]> = {
  admin: [
    { label: "Dashboard", path: "/admin", icon: LayoutDashboard },
    { label: "Patients", path: "/patients", icon: Users },
    { label: "Monthly Worklist", path: "/worklist", icon: ClipboardList },
    { label: "Inactive Patients", path: "/inactive-patients", icon: UserMinus },
    { label: "Declined CCM", path: "/declined-patients", icon: Ban },
    { label: "Staff Assignment", path: "/assignment", icon: UserCog },
    { label: "Escalations", path: "/escalations", icon: AlertTriangle },
    { label: "Billing", path: "/billing", icon: Receipt },
    { label: "Follow-ups", path: "/follow-ups", icon: CalendarClock },
    { label: "Reports", path: "/reports", icon: BarChart3 },
    { label: "Coordinators", path: "/coordinator", icon: Target },
    { label: "Providers", path: "/providers", icon: Stethoscope },
    { label: "Clinics", path: "/clinics", icon: Building2 },
    { label: "Team & Access", path: "/team", icon: UserCog },
    { label: "Audit Log", path: "/audit", icon: ShieldCheck },
  ],
  staff: [
    { label: "My Dashboard", path: "/coordinator", icon: LayoutDashboard },
    { label: "My Worklist", path: "/worklist", icon: ClipboardList },
    { label: "Patients", path: "/patients", icon: Users },
    { label: "Inactive Patients", path: "/inactive-patients", icon: UserMinus },
    { label: "Declined CCM", path: "/declined-patients", icon: Ban },
    { label: "Call Workflow", path: "/workflow", icon: PhoneCall },
  ],
  provider: [
    { label: "Escalations", path: "/escalations", icon: AlertTriangle },
    { label: "Patients", path: "/patients", icon: Users },
  ],
  billing: [
    { label: "Billing Records", path: "/billing", icon: Receipt },
    { label: "Reports", path: "/reports", icon: BarChart3 },
  ],
  front_desk: [
    { label: "Follow-ups", path: "/follow-ups", icon: CalendarClock },
    { label: "Patients", path: "/patients", icon: Users },
  ],
};

export const ROLES = [
  { value: "admin", label: "Admin / Practice Manager" },
  { value: "staff", label: "CCM Staff / Care Coordinator" },
  { value: "provider", label: "Provider" },
  { value: "billing", label: "Billing" },
  { value: "front_desk", label: "Front Desk" },
] as const;
