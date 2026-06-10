import React from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LogOut, Menu, X, Bell } from "lucide-react";
import { useState } from "react";
import { trpc } from "@/lib/trpc";

interface CCMDashboardLayoutProps {
  children: React.ReactNode;
}

export function CCMDashboardLayout({ children }: CCMDashboardLayoutProps) {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { data: unreadNotifications } = trpc.notifications.listUnread.useQuery();

  if (!user) return null;

  const navigationItems = {
    admin: [
      { label: "Dashboard", path: "/admin" },
      { label: "Patients", path: "/admin/patients" },
      { label: "Monthly Worklist", path: "/admin/worklist" },
      { label: "Staff Assignment", path: "/admin/assignment" },
      { label: "Escalations", path: "/admin/escalations" },
      { label: "Billing", path: "/admin/billing" },
      { label: "Reports", path: "/admin/reports" },
    ],
    staff: [
      { label: "My Tasks", path: "/staff/tasks" },
      { label: "Call Workflow", path: "/staff/workflow" },
      { label: "My Patients", path: "/staff/patients" },
    ],
    provider: [
      { label: "Dashboard", path: "/provider" },
      { label: "Escalations", path: "/provider/escalations" },
      { label: "My Patients", path: "/provider/patients" },
    ],
    billing: [
      { label: "Dashboard", path: "/billing" },
      { label: "Billing Records", path: "/billing/records" },
      { label: "Reports", path: "/billing/reports" },
    ],
    front_desk: [
      { label: "Dashboard", path: "/front-desk" },
      { label: "Appointments", path: "/front-desk/appointments" },
      { label: "Follow-ups", path: "/front-desk/follow-ups" },
    ],
  };

  const items = navigationItems[user.role as keyof typeof navigationItems] || [];

  const handleLogout = async () => {
    await logout();
    setLocation("/");
  };

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside
        className={`${
          sidebarOpen ? "w-64" : "w-20"
        } bg-card border-r border-muted transition-all duration-300 flex flex-col`}
      >
        {/* Header */}
        <div className="p-4 border-b border-muted flex items-center justify-between">
          <div className={`${!sidebarOpen && "hidden"} flex items-center gap-2`}>
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">CCM</span>
            </div>
            <span className="font-bold text-foreground">CCM Dashboard</span>
          </div>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1 hover:bg-muted rounded-lg transition-colors"
          >
            {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto p-4 space-y-2">
          {items.map((item) => (
            <button
              key={item.path}
              onClick={() => setLocation(item.path)}
              className={`w-full text-left px-4 py-2 rounded-lg transition-colors ${
                sidebarOpen ? "text-sm" : "text-xs"
              } hover:bg-muted text-muted-foreground hover:text-foreground`}
              title={item.label}
            >
              {sidebarOpen ? item.label : item.label.charAt(0)}
            </button>
          ))}
        </nav>

        {/* User info */}
        <div className="p-4 border-t border-muted space-y-2">
          <div className={`${!sidebarOpen && "hidden"} text-xs`}>
            <p className="font-medium text-foreground truncate">{user.name}</p>
            <p className="text-muted-foreground capitalize">{user.role}</p>
          </div>
          <button
            onClick={handleLogout}
            className="w-full px-4 py-2 rounded-lg hover:bg-muted transition-colors flex items-center justify-center gap-2"
            title="Logout"
          >
            <LogOut size={18} />
            {sidebarOpen && <span className="text-sm">Logout</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="bg-card border-b border-muted px-6 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">
            {user.role.charAt(0).toUpperCase() + user.role.slice(1)} Dashboard
          </h1>
          <div className="flex items-center gap-4">
            <button className="relative p-2 hover:bg-muted rounded-lg transition-colors">
              <Bell size={20} />
              {unreadNotifications && unreadNotifications.length > 0 && (
                <span className="absolute top-1 right-1 w-2 h-2 bg-destructive rounded-full" />
              )}
            </button>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
