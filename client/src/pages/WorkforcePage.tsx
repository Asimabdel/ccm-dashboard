import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { useState } from "react";
import { Loader2, Sun, CalendarDays, Plane, TrendingUp, BookOpenCheck, Users, Timer } from "lucide-react";
import { TodayTab } from "./workforce/TodayTab";
import { ScheduleTab } from "./workforce/ScheduleTab";
import { TimeOffTab } from "./workforce/TimeOffTab";
import { PerformanceTab } from "./workforce/PerformanceTab";
import { RolesTab } from "./workforce/RolesTab";
import { PeopleTab } from "./workforce/PeopleTab";
import { TimesheetsTab } from "./workforce/TimesheetsTab";

const TABS = [
  { key: "today", label: "Today", icon: Sun },
  { key: "schedule", label: "Schedule", icon: CalendarDays },
  { key: "timesheets", label: "Timesheets", icon: Timer },
  { key: "timeoff", label: "Time off", icon: Plane },
  { key: "performance", label: "Performance", icon: TrendingUp },
  { key: "roles", label: "Job roles", icon: BookOpenCheck },
  { key: "people", label: "People", icon: Users },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function WorkforcePage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  // ?tab=timesheets etc. deep-links straight to a tab.
  const [tab, setTab] = useState<TabKey>(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return TABS.some((x) => x.key === t) ? (t as TabKey) : "today";
  });

  if (loading || !user) return <div className="min-h-screen flex items-center justify-center bg-white"><Loader2 className="animate-spin text-slate-400" /></div>;
  const office = user.role === "office_manager";
  if (user.role !== "admin" && !office) {
    return <CCMDashboardLayout title="Workforce"><p className="text-slate-400 font-light">This area is for practice and office managers.</p></CCMDashboardLayout>;
  }
  const tabs = office ? TABS.filter((t) => t.key !== "roles") : TABS;

  return (
    <CCMDashboardLayout title="Workforce">
      <div className="flex flex-wrap gap-1.5 mb-6 p-1.5 bg-white border border-slate-200 rounded-2xl w-fit">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition ${tab === t.key ? "bg-gradient-to-r from-[hsl(17_66%_52%)] to-[hsl(20_72%_46%)] text-white shadow-glow-primary" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"}`}>
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      {tab === "today" && <TodayTab onOpenTimeOff={() => setTab("timeoff")} />}
      {tab === "schedule" && <ScheduleTab />}
      {tab === "timesheets" && <TimesheetsTab />}
      {tab === "timeoff" && <TimeOffTab />}
      {tab === "performance" && <PerformanceTab />}
      {tab === "roles" && !office && <RolesTab />}
      {tab === "people" && <PeopleTab />}
    </CCMDashboardLayout>
  );
}
