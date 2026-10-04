import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import {
  LogOut, Menu, Bell, ChevronDown, Check, Clock, Search, Sun, Moon, PanelLeftClose, PanelLeftOpen, X, Building2, KeyRound, MessagesSquare,
} from "lucide-react";
import { MESSAGES, NAV_GROUPS, PROGRAM_APPROVALS, ROLES, ROLE_HOME, type Role } from "@/lib/nav";
import { useUnreadMessages } from "@/components/messages/useUnreadMessages";
import { useUnreadTexts } from "@/components/texts/useUnreadTexts";
import { useTheme } from "@/contexts/ThemeContext";
import { CommandPalette } from "@/components/CommandPalette";
import { useIdleLogout } from "@/hooks/useIdleLogout";
import { useIsMobile } from "@/hooks/useMobile";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { MyProgress } from "@/components/workspace/MyProgress";
import { BrandMark } from "@/components/BrandMark";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/ccm";
import { WORKSPACE_ROLE_LABELS, can } from "@shared/workspace";

// Keyboard hint for the ⌘K command palette (Mac shows ⌘, others Ctrl).
const KBD_HINT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘K"
    : "Ctrl K";

const COLLAPSE_KEY = "ws.sidebarCollapsed";

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

// Every page draws its own layout, so the sidebar is rebuilt on each click. Remember how far
// it was scrolled (kept for the tab's session) and put it back, so it doesn't jump to the top.
const NAV_SCROLL_KEY = "ws.sidebarScroll";
let navScrollTop = (() => {
  try {
    return Number(sessionStorage.getItem(NAV_SCROLL_KEY)) || 0;
  } catch {
    return 0;
  }
})();
function saveNavScroll(top: number) {
  navScrollTop = top;
  try {
    sessionStorage.setItem(NAV_SCROLL_KEY, String(Math.round(top)));
  } catch {
    /* ignore */
  }
}

/** Header clinic picker. Shown on Workspace pages that filter by clinic. */
function ClinicPicker() {
  const { clinics, clinicId, setClinicId, limitedToClinics } = useWorkspace();
  if (clinics.length === 0) return null;
  const current = clinics.find((c) => c.id === clinicId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 h-9 px-3 rounded-lg text-sm font-medium border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 max-w-[150px] md:max-w-[220px]">
          <Building2 size={15} className="text-slate-500 shrink-0" />
          <span className="truncate">{current?.name ?? (limitedToClinics ? "My clinics" : "All clinics")}</span>
          <ChevronDown size={14} className="shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Clinic</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setClinicId(null)} className="flex items-center justify-between">
          {limitedToClinics ? "All my clinics" : "All clinics"} {!clinicId && <Check size={14} />}
        </DropdownMenuItem>
        {clinics.map((c) => (
          <DropdownMenuItem key={c.id} onClick={() => setClinicId(c.id)} className="flex items-center justify-between">
            <span className="truncate">{c.name}</span> {clinicId === c.id && <Check size={14} />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * App shell. `title` is shown as the page heading unless the page draws its own
 * header (`pageTitle={false}`); `clinicPicker` adds the clinic filter to the top bar.
 */
export function CCMDashboardLayout({ children, title, clinicPicker = false, pageTitle = true }: { children: React.ReactNode; title?: string; clinicPicker?: boolean; pageTitle?: boolean }) {
  // Browser tab: "Fax inbox · MyPCP".
  useEffect(() => { document.title = title ? `${title} · MyPCP` : "MyPCP"; }, [title]);
  const { user, logout, refresh } = useAuth();
  const { theme, toggleTheme, switchable } = useTheme();
  const [location, setLocation] = useLocation();
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const utils = trpc.useUtils();
  const { warning, secondsLeft, stayLoggedIn, logoutNow } = useIdleLogout({ enabled: !!user });

  const { data: notifications } = trpc.notifications.list.useQuery(undefined, { refetchInterval: 30000 });
  // Program approvals: only the named approvers get the tab (with how many patients are waiting).
  const { programApprover } = useWorkspace();
  const approvals = trpc.workspace.programs.count.useQuery(undefined, { enabled: !!user && programApprover, refetchInterval: 5 * 60_000 });
  // Internal messages: unread count (top bar + sidebar) and the browser pop-up.
  // The Messages badge: team messages plus unread patient texts (for people who handle texts).
  const unreadMessages = useUnreadMessages(!!user && can(user.role, "messages")) + useUnreadTexts(!!user && can(user.role, "texts"));
  const markRead = trpc.notifications.markRead.useMutation({
    onSuccess: () => utils.notifications.list.invalidate(),
  });
  const setRole = trpc.auth.setRole.useMutation({
    onSuccess: async () => {
      await refresh();
      await utils.invalidate();
      setLocation("/home");
    },
  });

  // Global enforcement: a worker flagged to change their password cannot use the
  // app until they do. Redirect them to the forced change-password screen.
  useEffect(() => {
    if (user && (user as { mustChangePassword?: boolean }).mustChangePassword && location !== "/change-password") {
      setLocation("/change-password?forced=1");
    }
  }, [user, location, setLocation]);

  useEffect(() => setMobileOpen(false), [location]);

  // Restore the sidebar's scroll before the page paints; if the current page's item would be
  // out of sight (e.g. opened from search), bring it to the middle.
  const navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return;
    el.scrollTop = navScrollTop;
    const active = el.querySelector<HTMLElement>('[aria-current="page"]');
    if (active) {
      const a = active.getBoundingClientRect();
      const n = el.getBoundingClientRect();
      if (a.top < n.top || a.bottom > n.bottom) {
        active.scrollIntoView({ block: "center" });
        saveNavScroll(el.scrollTop);
      }
    }
  }, [location, !!user, collapsed, isMobile, mobileOpen, programApprover]);

  if (!user) return null;

  const currentRole = (user.role in NAV_GROUPS ? user.role : "admin") as Role;
  const baseGroups = NAV_GROUPS[currentRole] || [];
  const groups = programApprover
    ? baseGroups.map((g, i) => (i === 0 ? { ...g, items: [...g.items.slice(0, 2), PROGRAM_APPROVALS, ...g.items.slice(2)] } : g))
    : baseGroups;
  const waitingApprovals = approvals.data?.patients ?? 0;
  const unread = (notifications || []).filter((n) => !n.read);
  const rail = !isMobile && collapsed;
  const initials = (user.name || user.email || "?").replace(/\(.*?\)/g, "").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const handleLogout = async () => {
    await logout();
    setLocation("/");
  };

  const isActive = (path: string) => location === path || (path !== "/" && location.startsWith(path + "/"));

  const sidebar = (
    <aside
      className={cn(
        "flex flex-col bg-[#17181b] text-slate-300 h-full transition-[width] duration-200",
        isMobile ? "w-72" : rail ? "w-[72px]" : "w-64",
      )}
    >
      <div className={cn("flex items-center h-14 px-4 border-b border-white/5", rail ? "justify-center" : "justify-between")}>
        <button onClick={() => setLocation(ROLE_HOME[user.role] ?? "/home")} className="flex items-center gap-2.5 min-w-0">
          <BrandMark size={32} className="shrink-0" />
          {!rail && (
            <div className="leading-tight text-left min-w-0">
              <span className="block text-sm font-bold tracking-wide text-white truncate">MYPCP</span>
              <span className="block text-[11px] text-slate-400 font-medium">Workspace</span>
            </div>
          )}
        </button>
        {isMobile && (
          <button onClick={() => setMobileOpen(false)} className="p-1.5 rounded-lg hover:bg-white/10" aria-label="Close menu">
            <X size={18} />
          </button>
        )}
      </div>

      <nav ref={navRef} onScroll={(e) => saveNavScroll(e.currentTarget.scrollTop)} className="flex-1 overflow-y-auto px-3 py-4 space-y-5 [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.14)_transparent]">
        {groups.map((g) => (
          <div key={g.label}>
            {!rail && <p className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{g.label}</p>}
            {rail && <div className="mx-3 mb-2 h-px bg-white/5" />}
            <div className="space-y-0.5">
              {g.items.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.path);
                return (
                  <button
                    key={item.path}
                    onClick={() => setLocation(item.path)}
                    title={item.label}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "w-full flex items-center gap-3 rounded-lg text-sm transition-colors relative",
                      rail ? "justify-center h-10" : "px-3 py-2",
                      active ? "bg-white/[0.08] text-white font-medium" : "text-slate-400 hover:bg-white/[0.05] hover:text-slate-100",
                    )}
                  >
                    {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-brand" />}
                    <Icon size={17} className={cn("shrink-0", active && "text-white")} />
                    {!rail && <span className="truncate">{item.label}</span>}
                    {item.path === MESSAGES.path && unreadMessages > 0 && (
                      <span className={cn("rounded-full bg-brand px-1.5 text-[11px] font-bold tabular-nums text-white", rail ? "absolute right-1 top-1" : "ml-auto")}>{unreadMessages > 99 ? "99+" : unreadMessages}</span>
                    )}
                    {item.path === PROGRAM_APPROVALS.path && waitingApprovals > 0 && (
                      <span className={cn("rounded-full bg-brand px-1.5 text-[11px] font-bold tabular-nums text-white", rail ? "absolute right-1 top-1" : "ml-auto")}>{waitingApprovals > 999 ? "999+" : waitingApprovals}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-white/5 space-y-1">
        {!rail && (
          <div className="px-3 py-2">
            <p className="text-sm font-medium text-slate-100 truncate">{user.name || user.email}</p>
            <p className="text-[11px] text-slate-500 truncate">{WORKSPACE_ROLE_LABELS[user.role] ?? user.role}</p>
          </div>
        )}
        <button
          onClick={handleLogout}
          title="Sign out"
          className={cn("w-full flex items-center gap-3 rounded-lg text-sm text-slate-400 hover:bg-white/[0.05] hover:text-slate-100", rail ? "justify-center h-10" : "px-3 py-2")}
        >
          <LogOut size={17} />
          {!rail && <span>Sign out</span>}
        </button>
        {!isMobile && (
          <button
            onClick={toggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn("w-full flex items-center gap-3 rounded-lg text-sm text-slate-500 hover:bg-white/[0.05] hover:text-slate-200", rail ? "justify-center h-10" : "px-3 py-2")}
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            {!rail && <span>Collapse</span>}
          </button>
        )}
      </div>
    </aside>
  );

  return (
    <div className="flex h-screen bg-slate-50/60 dark:bg-slate-900">
      {/* Sidebar: fixed rail/full on desktop, off-canvas drawer on phones */}
      {!isMobile && sidebar}
      {isMobile && mobileOpen && (
        <div className="fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="relative z-10 h-full">{sidebar}</div>
        </div>
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <header className="bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 px-3 md:px-6 h-14 flex items-center gap-2 md:gap-3 sticky top-0 z-20">
          {isMobile && (
            <button onClick={() => setMobileOpen(true)} className="p-2 -ml-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700" aria-label="Open menu">
              <Menu size={20} />
            </button>
          )}

          {/* ⌘K command palette — a wide search field, as in the Workspace design */}
          <button
            onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
            className="flex-1 min-w-0 max-w-md flex items-center gap-2 h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm text-left hover:border-slate-300 transition-colors"
            title={`Search (${KBD_HINT})`}
          >
            <Search size={16} className="text-slate-400 shrink-0" />
            <span className="flex-1 truncate text-slate-400">Find anything…</span>
            <kbd className="hidden sm:inline-flex items-center text-[10px] font-medium text-slate-400 border border-slate-200 dark:border-slate-600 rounded px-1.5 py-0.5">
              {KBD_HINT}
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-1 md:gap-1.5 shrink-0">
            {/* Today's numbers for this person (calls, tasks, care calls...) */}
            <MyProgress isAdmin={user.role === "admin"} />
            {clinicPicker && <ClinicPicker />}

            {/* Role switcher (admin-only preview) */}
            {((user as { realRole?: string }).realRole ?? user.role) === "admin" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="hidden md:flex items-center gap-2 h-9 px-3 rounded-lg text-sm font-medium border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700">
                  <span className="hidden xl:inline text-slate-500">View as:</span>
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

            {/* Light / dark theme toggle */}
            {switchable && (
              <button
                onClick={toggleTheme}
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                title={theme === "dark" ? "Light mode" : "Dark mode"}
                className="hidden sm:inline-flex p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700 transition-colors"
              >
                {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
              </button>
            )}

            {/* Internal messages */}
            {can(user.role, "messages") && (
              <button
                onClick={() => setLocation("/messages")}
                className="relative p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
                aria-label={unreadMessages ? `Messages, ${unreadMessages} unread` : "Messages"}
                title="Messages"
              >
                <MessagesSquare size={18} />
                {unreadMessages > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[17px] h-[17px] px-1 bg-brand text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                    {unreadMessages > 99 ? "99+" : unreadMessages}
                  </span>
                )}
              </button>
            )}

            {/* Notifications */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="relative p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700" aria-label="Notifications">
                  <Bell size={18} />
                  {unread.length > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[17px] h-[17px] px-1 bg-brand text-white text-[10px] font-bold rounded-full flex items-center justify-center">
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
                      onClick={() => {
                        if (!n.read) markRead.mutate(n.id);
                        if (n.type === "task") setLocation("/my-work");
                      }}
                      className={cn(
                        "w-full text-left px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-700 border-b border-slate-50 dark:border-slate-700/50",
                        !n.read && "bg-slate-50 dark:bg-blue-900/20"
                      )}
                    >
                      <div className="flex items-start gap-2">
                        {!n.read && <span className="mt-1.5 w-2 h-2 rounded-full bg-brand shrink-0" />}
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

            {/* Account */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="ml-0.5 w-8 h-8 rounded-full bg-brand text-white text-xs font-semibold flex items-center justify-center hover:opacity-90" aria-label="Account menu">
                  {initials}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel>
                  <p className="text-sm font-semibold truncate">{user.name || user.email}</p>
                  <p className="text-xs font-normal text-slate-500 truncate">{WORKSPACE_ROLE_LABELS[user.role] ?? user.role}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setLocation("/change-password")}>
                  <KeyRound size={14} className="mr-2" /> Change password
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleLogout}>
                  <LogOut size={14} className="mr-2" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 overflow-auto p-4 md:p-6">
          <div className="animate-fade-in-up max-w-[1500px] mx-auto">
            {pageTitle && (
              <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50 mb-5">
                {title || `${ROLES.find((r) => r.value === currentRole)?.label ?? "Dashboard"}`}
              </h1>
            )}
            {children}
          </div>
        </main>
      </div>

      <CommandPalette />

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
