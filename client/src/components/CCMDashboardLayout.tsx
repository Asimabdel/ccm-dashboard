import React, { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import {
  LogOut, Menu, X, Bell, LayoutDashboard, Users, ClipboardList,
  UserCog, AlertTriangle, Receipt, BarChart3, PhoneCall, CalendarClock,
  ChevronDown, Check, ShieldCheck, Clock,
} from "lucide-react";
import { useIdleLogout } from "@/hooks/useIdleLogout";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/ccm";

interface NavItem { label: string; path: string; icon: React.ElementType; }

const NAV: Record<string, NavItem[]> = {
  admin: [
    { label: "Dashboard", path: "/admin", icon: LayoutDashboard },
    { label: "Patients", path: "/patients", icon: Users },
    { label: "Monthly Worklist", path: "/worklist", icon: ClipboardList },
    { label: "Staff Assignment", path: "/assignment", icon: UserCog },
    { label: "Escalations", path: "/escalations", icon: AlertTriangle },
    { label: "Billing", path: "/billing", icon: Receipt },
    { label: "Follow-ups", path: "/follow-ups", icon: CalendarClock },
    { label: "Reports", path: "/reports", icon: BarChart3 },
    { label: "Team / Access", path: "/team", icon: UserCog },
    { label: "Audit Log", path: "/audit", icon: ShieldCheck },
  ],
  staff: [
    { label: "My Worklist", path: "/worklist", icon: ClipboardList },
    { label: "Patients", path: "/patients", icon: Users },
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

const ROLES = [
  { value: "admin", label: "Admin / Practice Manager" },
  { value: "staff", label: "CCM Staff / Care Coordinator" },
  { value: "provider", label: "Provider" },
  { value: "billing", label: "Billing" },
  { value: "front_desk", label: "Front Desk" },
] as const;

export function CCMDashboardLayout({ children, title }: { children: React.ReactNode; title?: string }) {
  const { user, logout, refresh } = useAuth();
  const [location, setLocation] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const utils = trpc.useUtils();
  const { warning, secondsLeft, stayLoggedIn, logoutNow } = useIdleLogout({ enabled: !!user });

  const { data: notifications } = trpc.notifications.list.useQuery(undefined, { refetchInterval: 30000 });
  const markRead = trpc.notifications.markRead.useMutation({
    onSuccess: () => utils.notifications.list.invalidate(),
  });
  const setRole = trpc.auth.setRole.useMutation({
    onSuccess: async () => {
      await refresh();
      await utils.invalidate();
      setLocation(NAV[currentRole]?.[0]?.path ?? "/");
    },
  });

  if (!user) return null;

  const currentRole = (user.role in NAV ? user.role : "admin") as keyof typeof NAV;
  const items = NAV[currentRole] || [];
  const unread = (notifications || []).filter((n) => !n.read);

  const handleLogout = async () => {
    await logout();
    setLocation("/");
  };

  return (
    <div className="flex h-screen bg-[hsl(240_10%_97%)] dark:bg-slate-900">
      {/* Sidebar */}
      <aside
        className={cn(
          "transition-all duration-300 flex flex-col bg-white dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700",
          sidebarOpen ? "w-64" : "w-20"
        )}
      >
        <div className="p-4 flex items-center justify-between border-b border-slate-100 dark:border-slate-700">
          <div className={cn(!sidebarOpen && "hidden", "flex items-center gap-2")}>
            <div className="w-9 h-9 bg-[hsl(200_100%_50%)] rounded-xl flex items-center justify-center">
              <span className="text-white font-bold text-xs">CCM</span>
            </div>
            <span className="font-bold tracking-tight text-slate-900 dark:text-slate-50">Care Hub</span>
          </div>
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg">
            {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {items.map((item) => {
            const Icon = item.icon;
            const active = location === item.path;
            return (
              <button
                key={item.path}
                onClick={() => setLocation(item.path)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors",
                  active
                    ? "bg-[hsl(200_100%_50%)] text-white"
                    : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                )}
                title={item.label}
              >
                <Icon size={18} className="shrink-0" />
                {sidebarOpen && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-100 dark:border-slate-700">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            <LogOut size={18} />
            {sidebarOpen && <span>Logout</span>}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 px-6 py-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-widest font-light text-slate-400">Chronic Care Management</p>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
              {title || `${ROLES.find((r) => r.value === currentRole)?.label ?? "Dashboard"}`}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            {/* Role switcher (admin-only preview) */}
            {user.role === "admin" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600">
                  <span className="hidden sm:inline">View as:</span>
                  <span className="font-semibold capitalize">{currentRole.replace("_", " ")}</span>
                  <ChevronDown size={14} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>Switch dashboard role</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {ROLES.map((r) => (
                  <DropdownMenuItem
                    key={r.value}
                    onClick={() => setRole.mutate({ role: r.value })}
                    className="flex items-center justify-between"
                  >
                    <span>{r.label}</span>
                    {currentRole === r.value && <Check size={14} />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            )}

            {/* Notifications */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="relative p-2.5 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600">
                  <Bell size={18} />
                  {unread.length > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-rose-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                      {unread.length}
                    </span>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuLabel className="flex items-center justify-between">
                  Notifications
                  <span className="text-xs font-normal text-slate-400">{unread.length} unread</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <div className="max-h-80 overflow-y-auto">
                  {(notifications || []).length === 0 && (
                    <p className="px-3 py-6 text-center text-sm text-slate-400">No notifications</p>
                  )}
                  {(notifications || []).slice(0, 12).map((n) => (
                    <button
                      key={n.id}
                      onClick={() => !n.read && markRead.mutate(n.id)}
                      className={cn(
                        "w-full text-left px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-700 border-b border-slate-50 dark:border-slate-700/50",
                        !n.read && "bg-blue-50/60 dark:bg-blue-900/20"
                      )}
                    >
                      <div className="flex items-start gap-2">
                        {!n.read && <span className="mt-1.5 w-2 h-2 rounded-full bg-[hsl(200_100%_50%)] shrink-0" />}
                        <div className={cn(n.read && "pl-4")}>
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{n.title}</p>
                          {n.content && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{n.content}</p>}
                          <p className="text-[10px] text-slate-400 mt-1">{fmtDate(n.createdAt)}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>

      {/* HIPAA idle session timeout warning */}
      {warning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 p-6 max-w-sm w-full mx-4 shadow-xl">
            <div className="flex items-center gap-2 text-amber-600 mb-2">
              <Clock size={20} /> <span className="font-semibold">Session expiring</span>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">For the security of protected health information, you will be signed out in <span className="font-bold text-slate-900 dark:text-slate-50">{secondsLeft}s</span> due to inactivity.</p>
            <div className="flex gap-2 mt-5">
              <button onClick={stayLoggedIn} className="flex-1 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800">Stay signed in</button>
              <button onClick={logoutNow} className="px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-medium text-slate-600 hover:bg-slate-50">Sign out</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
