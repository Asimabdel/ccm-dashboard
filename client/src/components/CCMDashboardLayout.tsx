import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import {
  LogOut, Menu, ChevronDown, Check, Clock, Search, Sun, Moon, PanelLeftClose, PanelLeftOpen, X, Building2, KeyRound, MessagesSquare, Star,
} from "lucide-react";
import { APCM, COPAYS, MASTER_BILLING, MESSAGES, NAV_GROUPS, PROGRAM_APPROVALS, ROLES, ROLE_HOME, STAFF_ASSIGNMENT, type NavItem, type Role } from "@/lib/nav";
import { useNavCounts, useNavPrefs } from "@/components/workspace/useNavMenu";
import { NAV_SHORTCUTS_SECTION } from "@shared/navMenu";
import { useUnreadMessages } from "@/components/messages/useUnreadMessages";
import { useUnreadTexts } from "@/components/texts/useUnreadTexts";
import { ClockBanner } from "@/components/workforce/ClockBanner";
import { useTheme } from "@/contexts/ThemeContext";
import { CommandPalette } from "@/components/CommandPalette";
import { useIdleLogout } from "@/hooks/useIdleLogout";
import { useIsMobile } from "@/hooks/useMobile";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { MyProgress } from "@/components/workspace/MyProgress";
import { BrandMark } from "@/components/BrandMark";
import { NotificationBell } from "@/components/NotificationBell";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
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
export function CCMDashboardLayout({ children, title, clinicPicker = false, pageTitle = true, focus = false }: {
  children: React.ReactNode; title?: string; clinicPicker?: boolean; pageTitle?: boolean;
  /** Full screen (the document editor): no side menu or top bar; sign-out on idle and Find anything still work. */
  focus?: boolean;
}) {
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

  // Program approvals: only the named approvers get the tab (with how many patients are waiting).
  const { programApprover, ccmAssigner: ccmOnly, bhiAssigner, apcmAccess, masterBilling, visitCost } = useWorkspace();
  const ccmAssigner = ccmOnly || bhiAssigner;
  const approvals = trpc.workspace.programs.count.useQuery(undefined, { enabled: !!user && programApprover, refetchInterval: 5 * 60_000 });
  // Internal messages: unread count (top bar + sidebar) and the browser pop-up.
  // The Messages badge: team messages plus unread patient texts (for people who handle texts).
  const unreadMessages = useUnreadMessages(!!user && can(user.role, "messages")) + useUnreadTexts(!!user && can(user.role, "texts"));
  // The side menu, per person: starred pages, folded sections, and how much is waiting on each page.
  const navPrefs = useNavPrefs(user?.id);
  const navCounts = useNavCounts(!!user);
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
    // A starred page is in the menu twice (My shortcuts + its own section): either one in sight is enough.
    const actives = Array.from(el.querySelectorAll<HTMLElement>('[aria-current="page"]'));
    const n = el.getBoundingClientRect();
    const inSight = (x: HTMLElement) => {
      const a = x.getBoundingClientRect();
      return a.top >= n.top && a.bottom <= n.bottom;
    };
    if (actives.length && !actives.some(inSight)) {
      actives[0].scrollIntoView({ block: "center" });
      saveNavScroll(el.scrollTop);
    }
  }, [location, !!user, collapsed, isMobile, mobileOpen, programApprover, ccmAssigner, apcmAccess, masterBilling, visitCost]);

  if (!user) return null;

  const currentRole = (user.role in NAV_GROUPS ? user.role : "admin") as Role;
  const baseGroups = NAV_GROUPS[currentRole] || [];
  const withApprovals = programApprover
    ? baseGroups.map((g, i) => (i === 0 ? { ...g, items: [...g.items.slice(0, 2), PROGRAM_APPROVALS, ...g.items.slice(2)] } : g))
    : baseGroups;
  // Named CCM / BHI assigners get Staff Assignment in Care Management (or at the end of their first group).
  const careIdx = withApprovals.findIndex((g) => g.label === "Care Management");
  const withAssignment = ccmAssigner && !withApprovals.some((g) => g.items.some((x) => x.path === STAFF_ASSIGNMENT.path))
    ? withApprovals.map((g, i) => (i === (careIdx >= 0 ? careIdx : 0) ? { ...g, items: careIdx >= 0 ? [...g.items.slice(0, 2), STAFF_ASSIGNMENT, ...g.items.slice(2)] : [...g.items, STAFF_ASSIGNMENT] } : g))
    : withApprovals;
  // Named APCM people get APCM in Care Management (or at the end of their first group).
  const withApcm = apcmAccess && !withAssignment.some((g) => g.items.some((x) => x.path === APCM.path))
    ? withAssignment.map((g, i) => (i === (careIdx >= 0 ? careIdx : 0) ? { ...g, items: [...g.items, APCM] } : g))
    : withAssignment;
  // Master Billing: only the admins named for it, right after Billing in Revenue.
  const withBilling = masterBilling
    ? withApcm.map((g) => (g.label === "Revenue" ? { ...g, items: g.items.flatMap((x) => (x.path === "/billing" ? [x, MASTER_BILLING] : [x])) } : g))
    : withApcm;
  // Copays & deductibles: right after Insurance checker, for those who may see the estimates.
  const groups = visitCost
    ? withBilling.map((g) => ({ ...g, items: g.items.flatMap((x) => (x.path === "/insurance" ? [x, COPAYS] : [x])) }))
    : withBilling;
  const waitingApprovals = approvals.data?.patients ?? 0;
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

  // How many things are waiting on a page (the number bubble next to it).
  const waitingOn = (path: string): number =>
    path === MESSAGES.path ? unreadMessages : path === PROGRAM_APPROVALS.path ? waitingApprovals : navCounts[path] ?? 0;
  const bubbleText = (n: number, max = 99) => (n > max ? `${max}+` : String(n));
  const bubble = "rounded-full bg-brand px-1.5 text-[11px] font-bold tabular-nums tracking-normal text-white";

  // My shortcuts: the pages this person starred, as they are named in their own menu.
  const itemByPath = new Map<string, NavItem>();
  for (const g of groups) for (const item of g.items) if (!itemByPath.has(item.path)) itemByPath.set(item.path, item);
  const shortcutItems = navPrefs.shortcuts.flatMap((p) => itemByPath.get(p) ?? []);
  const shortcutsInSight = !navPrefs.folded.includes(NAV_SHORTCUTS_SECTION);

  const renderItem = (item: NavItem, inShortcuts: boolean) => {
    const Icon = item.icon;
    const active = isActive(item.path);
    const waiting = waitingOn(item.path);
    const starred = inShortcuts || navPrefs.shortcuts.includes(item.path);
    return (
      <div
        key={item.path}
        className={cn("group/nav relative flex items-center rounded-lg transition-colors", active ? "bg-brand-bright/[0.12]" : "hover:bg-white/[0.05]")}
      >
        {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-brand-bright" />}
        <button
          onClick={() => setLocation(item.path)}
          title={item.label}
          aria-current={active ? "page" : undefined}
          className={cn(
            "relative flex-1 min-w-0 flex items-center gap-3 rounded-lg text-sm text-left transition-colors",
            rail ? "justify-center h-10" : "px-3 py-2",
            active ? "text-white font-medium" : "text-slate-400 group-hover/nav:text-slate-100",
          )}
        >
          <Icon size={17} className={cn("shrink-0", active && "text-brand-bright")} />
          {!rail && <span className="truncate">{item.label}</span>}
          {waiting > 0 && (
            <span className={cn(bubble, rail ? "absolute right-1 top-1" : "ml-auto")} aria-label={`${waiting} waiting`}>
              {bubbleText(waiting, item.path === PROGRAM_APPROVALS.path ? 999 : 99)}
            </span>
          )}
        </button>
        {!rail && (
          <button
            onClick={() => navPrefs.toggleShortcut(item.path)}
            aria-pressed={starred}
            aria-label={starred ? `Remove ${item.label} from My shortcuts` : `Add ${item.label} to My shortcuts`}
            title={starred ? "Remove from My shortcuts" : "Add to My shortcuts"}
            className={cn(
              "shrink-0 h-8 flex items-center justify-center overflow-hidden rounded-md transition-all duration-150 hover:text-amber-300",
              starred ? "text-amber-400/80" : "text-slate-500",
              // Slides in when pointing at the row, so it takes no room from the page name otherwise.
              // Always there on phones, where there is no pointing.
              isMobile
                ? "w-6 -ml-2.5 mr-0.5 opacity-80"
                : "w-0 opacity-0 group-hover/nav:w-6 group-hover/nav:-ml-2.5 group-hover/nav:mr-0.5 group-hover/nav:opacity-100 focus-visible:w-6 focus-visible:-ml-2.5 focus-visible:mr-0.5 focus-visible:opacity-100",
            )}
          >
            <Star size={14} fill={starred ? "currentColor" : "none"} />
          </button>
        )}
      </div>
    );
  };

  // One menu section: a heading that folds it shut (the choice is remembered for this person) and its pages.
  // A folded section still shows the page you are on, and its heading adds up what is waiting inside.
  const renderSection = (label: string, items: NavItem[], isShortcuts: boolean) => {
    const folded = !rail && navPrefs.folded.includes(label);
    // The page you are on stays in sight, unless My shortcuts already shows it.
    const keepInSight = (i: NavItem) => isActive(i.path) && (isShortcuts || !shortcutsInSight || !navPrefs.shortcuts.includes(i.path));
    const shown = folded ? items.filter(keepInSight) : items;
    const hiddenWaiting = folded ? items.reduce((sum, i) => sum + (keepInSight(i) ? 0 : waitingOn(i.path)), 0) : 0;
    return (
      <div key={isShortcuts ? "#shortcuts" : label}>
        {!rail && (
          <button
            onClick={() => navPrefs.toggleFold(label)}
            aria-expanded={!folded}
            title={folded ? `Show ${label}` : `Hide ${label}`}
            className="w-full flex items-center gap-1.5 h-6 pl-3 pr-2 mb-1 rounded-md text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 hover:text-slate-300 transition-colors"
          >
            <span className="truncate">{label}</span>
            {hiddenWaiting > 0 && <span className={cn(bubble, "ml-auto")}>{bubbleText(hiddenWaiting, 999)}</span>}
            <ChevronDown size={13} className={cn("shrink-0 transition-transform", hiddenWaiting > 0 ? "" : "ml-auto", folded && "-rotate-90")} />
          </button>
        )}
        {rail && <div className="mx-3 mb-2 h-px bg-white/5" />}
        {shown.length > 0 && <div className="space-y-0.5">{shown.map((item) => renderItem(item, isShortcuts))}</div>}
        {isShortcuts && !folded && items.length === 0 && (
          <p className="px-3 text-xs leading-snug text-slate-500">
            {isMobile ? "Tap the" : "Point at a page and click its"} <Star size={11} className="inline -mt-0.5" /> {isMobile ? "next to a page to keep it here." : "to keep it here."}
          </p>
        )}
      </div>
    );
  };

  const sidebar = (
    <aside
      className={cn(
        "flex flex-col bg-sidebar text-slate-300 h-full transition-[width] duration-200",
        isMobile ? "w-72" : rail ? "w-[72px]" : "w-64",
      )}
    >
      <div className={cn("flex items-center h-14 px-4 border-b border-white/5", rail ? "justify-center" : "justify-between")}>
        <button onClick={() => setLocation(ROLE_HOME[user.role] ?? "/home")} className="flex items-center gap-2.5 min-w-0">
          <BrandMark size={32} className="shrink-0" />
          {!rail && (
            <div className="leading-tight text-left min-w-0">
              <span className="block text-[15px] font-bold tracking-tight text-white truncate">MyPCP Dr</span>
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
        {/* The person's starred pages. The narrow (icons only) menu shows them only once some are starred. */}
        {(!rail || shortcutItems.length > 0) && renderSection(NAV_SHORTCUTS_SECTION, shortcutItems, true)}
        {groups.map((g) => renderSection(g.label, g.items, false))}
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

  // HIPAA idle session timeout warning (every page, full screen ones too).
  const idleWarning = warning && (
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
  );

  // Full screen: the page draws everything itself.
  if (focus) {
    return (
      <div className="h-[100dvh] overflow-hidden bg-slate-100 dark:bg-slate-900">
        {children}
        <CommandPalette />
        {idleWarning}
      </div>
    );
  }

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
            className="flex-1 min-w-0 max-w-lg flex items-center gap-2.5 h-9 px-3 rounded-lg border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 text-sm text-left hover:border-brand/50 hover:bg-white hover:ring-[3px] hover:ring-brand/10 transition-all"
            title={`Search (${KBD_HINT})`}
          >
            <Search size={16} className="text-slate-400 shrink-0" />
            <span className="flex-1 truncate text-slate-500 dark:text-slate-400"><span className="hidden md:inline">Find anything · patients, pages, or what to do</span><span className="md:hidden">Find anything</span></span>
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

            <NotificationBell />

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

        {/* Time clock reminders (people on the clock only; providers and the billing company never are) */}
        {!["provider", "billing", "user"].includes(user.role) && <ClockBanner />}
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
      {idleWarning}
    </div>
  );
}
