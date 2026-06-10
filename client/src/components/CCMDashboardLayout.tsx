import React, { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import {
  LogOut, Menu, X, Bell, LayoutDashboard, Users, ClipboardList,
  UserCog, AlertTriangle, Receipt, BarChart3, PhoneCall, CalendarClock,
  ChevronDown, Check, ShieldCheck, Search,
} from "lucide-react";
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
    <div className="flex h-screen bg-slate-100 text-slate-950 dark:bg-slate-950">
      {/* Sidebar */}
      <aside
        className={cn(
          "relative transition-all duration-300 flex flex-col bg-slate-950 text-slate-100 shadow-2xl shadow-slate-950/20",
          sidebarOpen ? "w-64" : "w-20"
        )}
      >
        <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-sky-500/20 to-transparent pointer-events-none" />
        <div className="relative p-4 flex items-center justify-between border-b border-white/10">
          <div className={cn(!sidebarOpen && "hidden", "flex items-center gap-2")}>
            <div className="w-9 h-9 bg-sky-500 rounded-xl flex items-center justify-center shadow-lg shadow-sky-500/30">
              <span className="text-white font-bold text-xs">CCM</span>
            </div>
            <div>
              <span className="block font-bold tracking-tight text-white">Care Hub</span>
              <span className="text-[10px] uppercase tracking-[0.25em] text-slate-400">Operations</span>
            </div>
          </div>
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-1.5 hover:bg-white/10 rounded-lg text-slate-300">
            {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>

        <nav className="relative flex-1 overflow-y-auto p-3 space-y-1">
          {items.map((item) => {
            const Icon = item.icon;
            const active = location === item.path;
            return (
              <button
                key={item.path}
                onClick={() => setLocation(item.path)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all",
                  active
                    ? "bg-white text-slate-950 shadow-lg shadow-black/20"
                    : "text-slate-400 hover:bg-white/10 hover:text-white"
                )}
                title={item.label}
              >
                <Icon size={18} className="shrink-0" />
                {sidebarOpen && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>

        <div className="relative p-3 border-t border-white/10">
          {sidebarOpen && (
            <div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
              <p className="text-xs font-semibold text-white">{user.name || "Team member"}</p>
              <p className="mt-0.5 truncate text-[11px] text-slate-400">{user.email || currentRole.replace("_", " ")}</p>
            </div>
          )}
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <LogOut size={18} />
            {sidebarOpen && <span>Logout</span>}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="border-b border-slate-200/70 bg-white/85 px-6 py-3 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/85">
          <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-widest font-light text-slate-400">Chronic Care Management</p>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
              {title || `${ROLES.find((r) => r.value === currentRole)?.label ?? "Dashboard"}`}
            </h1>
          </div>

          <div className="hidden min-w-64 max-w-sm flex-1 items-center rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-400 lg:flex">
            <Search size={16} className="mr-2" />
            Search patients, worklists, providers...
          </div>

          <div className="flex items-center gap-2">
            {/* Role switcher (admin-only preview) */}
            {user.role === "admin" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700">
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
                <button className="relative p-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700">
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
          </div>
        </header>

        <main className="flex-1 overflow-auto bg-[radial-gradient(circle_at_top_right,rgba(14,165,233,0.12),transparent_30%),linear-gradient(180deg,#f8fafc,#eef2f7)] p-5 sm:p-6 dark:from-slate-950 dark:to-slate-900">{children}</main>
      </div>
    </div>
  );
}
