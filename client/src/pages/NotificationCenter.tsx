import React, { useState } from "react";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Bell, AlertTriangle, CheckCircle2, Clock, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function NotificationCenter() {
  const { user } = useAuth();
  const [filter, setFilter] = useState<string>("all");

  // Mock notifications for demonstration
  const mockNotifications = [
    {
      id: 1,
      type: "urgent_symptom",
      title: "Urgent Symptom Alert",
      message: "Patient John Smith reported severe chest pain during CCM call",
      patientName: "John Smith",
      timestamp: new Date(Date.now() - 15 * 60 * 1000),
      read: false,
      severity: "critical",
    },
    {
      id: 2,
      type: "escalation",
      title: "Patient Escalation",
      message: "Patient needs provider review for medication adjustment",
      patientName: "Jane Doe",
      timestamp: new Date(Date.now() - 45 * 60 * 1000),
      read: false,
      severity: "high",
    },
    {
      id: 3,
      type: "unreached",
      title: "Patient Not Reached",
      message: "Patient Robert Johnson not reached after 3 attempts",
      patientName: "Robert Johnson",
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000),
      read: true,
      severity: "medium",
    },
    {
      id: 4,
      type: "missing_docs",
      title: "Missing Documentation",
      message: "CCM call completed but documentation not submitted",
      patientName: "Maria Garcia",
      timestamp: new Date(Date.now() - 4 * 60 * 60 * 1000),
      read: true,
      severity: "medium",
    },
    {
      id: 5,
      type: "billing_ready",
      title: "Billing Ready",
      message: "5 CCM records are ready for billing submission",
      patientName: "Multiple Patients",
      timestamp: new Date(Date.now() - 6 * 60 * 60 * 1000),
      read: true,
      severity: "low",
    },
  ];

  const filteredNotifications =
    filter === "all"
      ? mockNotifications
      : filter === "unread"
        ? mockNotifications.filter((n) => !n.read)
        : mockNotifications.filter((n) => n.type === filter);

  const unreadCount = mockNotifications.filter((n) => !n.read).length;

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical":
        return "bg-red-100 text-red-800";
      case "high":
        return "bg-orange-100 text-orange-800";
      case "medium":
        return "bg-yellow-100 text-yellow-800";
      default:
        return "bg-blue-100 text-blue-800";
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "urgent_symptom":
        return <AlertTriangle className="w-4 h-4" />;
      case "escalation":
        return <AlertTriangle className="w-4 h-4" />;
      case "unreached":
        return <Clock className="w-4 h-4" />;
      case "missing_docs":
        return <AlertTriangle className="w-4 h-4" />;
      case "billing_ready":
        return <CheckCircle2 className="w-4 h-4" />;
      default:
        return <Bell className="w-4 h-4" />;
    }
  };

  const formatTime = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <CCMDashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-3xl font-bold text-slate-900 dark:text-slate-50 mb-2">
              Notification Center
            </h2>
            <p className="text-slate-600 dark:text-slate-400">
              {unreadCount} unread notification{unreadCount !== 1 ? "s" : ""}
            </p>
          </div>
          <Bell className="w-8 h-8 text-slate-400" />
        </div>

        {/* Filter Tabs */}
        <div className="flex gap-2 overflow-x-auto pb-2">
          {[
            { value: "all", label: "All" },
            { value: "unread", label: "Unread" },
            { value: "urgent_symptom", label: "Urgent Symptoms" },
            { value: "escalation", label: "Escalations" },
            { value: "unreached", label: "Unreached" },
            { value: "billing_ready", label: "Billing Ready" },
          ].map((tab) => (
            <Button
              key={tab.value}
              variant={filter === tab.value ? "default" : "outline"}
              onClick={() => setFilter(tab.value)}
              className="whitespace-nowrap"
            >
              {tab.label}
            </Button>
          ))}
        </div>

        {/* Notifications List */}
        <div className="space-y-3">
          {filteredNotifications.length > 0 ? (
            filteredNotifications.map((notification: any) => (
              <Card
                key={notification.id}
                className={`p-4 border-l-4 transition-all ${
                  notification.read
                    ? "bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700"
                    : "bg-white dark:bg-slate-900 border-blue-500 dark:border-blue-600 shadow-sm"
                } ${notification.severity === "critical" ? "border-l-red-500" : notification.severity === "high" ? "border-l-orange-500" : "border-l-yellow-500"}`}
              >
                <div className="flex items-start gap-4">
                  <div className="mt-1 text-slate-600 dark:text-slate-400">
                    {getTypeIcon(notification.type)}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-bold text-slate-900 dark:text-slate-50">
                        {notification.title}
                      </h3>
                      <Badge className={getSeverityColor(notification.severity)}>
                        {notification.severity}
                      </Badge>
                      {!notification.read && (
                        <div className="w-2 h-2 rounded-full bg-blue-500 ml-auto" />
                      )}
                    </div>

                    <p className="text-sm text-slate-600 dark:text-slate-400 mb-2">
                      {notification.message}
                    </p>

                    <div className="flex items-center justify-between">
                      <p className="text-xs text-slate-500 dark:text-slate-500">
                        <strong>Patient:</strong> {notification.patientName} •{" "}
                        {formatTime(notification.timestamp)}
                      </p>
                      <button className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </Card>
            ))
          ) : (
            <Card className="p-8 text-center bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
              <Bell className="w-12 h-12 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
              <p className="text-slate-600 dark:text-slate-400">No notifications in this category</p>
            </Card>
          )}
        </div>

        {/* Notification Settings */}
        <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
            Notification Preferences
          </h3>

          <div className="space-y-3 text-sm text-slate-600 dark:text-slate-400">
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50 dark:bg-slate-800">
              <span>Urgent Symptom Alerts</span>
              <input type="checkbox" defaultChecked className="w-4 h-4" />
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50 dark:bg-slate-800">
              <span>Escalation Notifications</span>
              <input type="checkbox" defaultChecked className="w-4 h-4" />
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50 dark:bg-slate-800">
              <span>Patient Not Reached Reminders</span>
              <input type="checkbox" defaultChecked className="w-4 h-4" />
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50 dark:bg-slate-800">
              <span>Missing Documentation Alerts</span>
              <input type="checkbox" defaultChecked className="w-4 h-4" />
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50 dark:bg-slate-800">
              <span>Billing Ready Notifications</span>
              <input type="checkbox" defaultChecked className="w-4 h-4" />
            </div>
          </div>
        </Card>
      </div>
    </CCMDashboardLayout>
  );
}
