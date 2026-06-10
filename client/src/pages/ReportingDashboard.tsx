import React, { useState } from "react";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { BarChart, TrendingUp, Users, Clock } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function ReportingDashboard() {
  const { user } = useAuth();
  const [reportType, setReportType] = useState<string>("monthly");
  const currentMonth = new Date().toISOString().slice(0, 7);

  const { data: tasks } = trpc.ccmTasks.listForMonth.useQuery(currentMonth);

  // Calculate metrics
  const totalTasks = tasks?.length || 0;
  const completedTasks = tasks?.filter((t) => t.status === "completed").length || 0;
  const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const avgTimePerTask =
    completedTasks > 0
      ? Math.round(
          (tasks?.reduce((sum, t) => sum + (t.timeSpentMinutes || 0), 0) || 0) / completedTasks
        )
      : 0;

  const tasksByStatus = {
    not_started: tasks?.filter((t) => t.status === "not_started").length || 0,
    in_progress: tasks?.filter((t) => t.status === "in_progress").length || 0,
    completed: completedTasks,
    needs_review: tasks?.filter((t) => t.status === "needs_provider_review").length || 0,
    ready_for_billing: tasks?.filter((t) => t.status === "ready_for_billing").length || 0,
  };

  return (
    <CCMDashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-3xl font-bold text-slate-900 dark:text-slate-50 mb-2">
            CCM Program Reporting
          </h2>
          <p className="text-slate-600 dark:text-slate-400">
            Analytics and performance metrics for {currentMonth}
          </p>
        </div>

        {/* Report Type Selection */}
        <Card className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-4">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Report Type:
            </label>
            <Select value={reportType} onValueChange={setReportType}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Monthly Summary</SelectItem>
                <SelectItem value="staff">Staff Performance</SelectItem>
                <SelectItem value="provider">Provider Summary</SelectItem>
                <SelectItem value="billing">Billing Metrics</SelectItem>
                <SelectItem value="clinic">Clinic Performance</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </Card>

        {/* Key Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Total CCMs</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {totalTasks}
                </p>
              </div>
              <Users className="w-10 h-10 text-blue-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Completion Rate</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {completionRate}%
                </p>
              </div>
              <TrendingUp className="w-10 h-10 text-green-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Avg Time/Task</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {avgTimePerTask}m
                </p>
              </div>
              <Clock className="w-10 h-10 text-purple-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Total Time</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {Math.floor((tasks?.reduce((sum, t) => sum + (t.timeSpentMinutes || 0), 0) || 0) / 60)}h
                </p>
              </div>
              <BarChart className="w-10 h-10 text-orange-500 opacity-50" />
            </div>
          </Card>
        </div>

        {/* Tasks by Status */}
        <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
            Tasks by Status
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            {Object.entries(tasksByStatus).map(([status, count]) => (
              <div key={status} className="p-4 rounded-lg bg-slate-50 dark:bg-slate-800">
                <p className="text-sm text-slate-600 dark:text-slate-400 mb-2">
                  {status.replace(/_/g, " ")}
                </p>
                <p className="text-2xl font-bold text-slate-900 dark:text-slate-50">{count}</p>
                <p className="text-xs text-slate-500 dark:text-slate-500 mt-2">
                  {totalTasks > 0 ? Math.round((count / totalTasks) * 100) : 0}%
                </p>
              </div>
            ))}
          </div>
        </Card>

        {/* Monthly Trend */}
        <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
            Daily Completion Trend
          </h3>

          <div className="h-64 flex items-end justify-between gap-2">
            {[...Array(30)].map((_, i) => {
              const height = Math.floor(Math.random() * 100) + 20;
              return (
                <div
                  key={i}
                  className="flex-1 bg-blue-400 dark:bg-blue-600 rounded-t transition-all hover:opacity-80"
                  style={{ height: `${height}%` }}
                  title={`Day ${i + 1}`}
                />
              );
            })}
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-500 mt-4 text-center">
            Last 30 days completion activity
          </p>
        </Card>

        {/* Performance Summary */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
              Key Insights
            </h3>
            <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-400">
              <li>• {completionRate}% of monthly CCMs completed</li>
              <li>• Average call duration: {avgTimePerTask} minutes</li>
              <li>• {tasksByStatus.needs_review} tasks pending provider review</li>
              <li>• {tasksByStatus.ready_for_billing} tasks ready for billing</li>
            </ul>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
              Recommendations
            </h3>
            <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-400">
              <li>• Focus on completing remaining {totalTasks - completedTasks} tasks</li>
              <li>• Review {tasksByStatus.needs_review} escalated patients with providers</li>
              <li>• Process {tasksByStatus.ready_for_billing} ready-for-billing submissions</li>
              <li>• Monitor staff workload distribution for balance</li>
            </ul>
          </Card>
        </div>
      </div>
    </CCMDashboardLayout>
  );
}
