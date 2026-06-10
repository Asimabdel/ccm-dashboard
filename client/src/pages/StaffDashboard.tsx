import React from "react";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, Clock, AlertCircle, Users } from "lucide-react";

export default function StaffDashboard() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const currentMonth = new Date().toISOString().slice(0, 7);

  const { data: myTasks } = trpc.ccmTasks.listByStaff.useQuery(
    { staffId: user?.id || 0, month: currentMonth },
    { enabled: !!user?.id }
  );

  const completedCount = myTasks?.filter((t) => t.status === "completed").length || 0;
  const inProgressCount = myTasks?.filter((t) => t.status === "in_progress").length || 0;
  const pendingCount = myTasks?.filter((t) => t.status === "not_started" || t.status === "assigned").length || 0;
  const totalTime = myTasks?.reduce((sum, t) => sum + (t.timeSpentMinutes || 0), 0) || 0;

  return (
    <CCMDashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-3xl font-bold text-slate-900 dark:text-slate-50 mb-2">
            My CCM Tasks
          </h2>
          <p className="text-slate-600 dark:text-slate-400">
            {currentMonth} • {myTasks?.length || 0} total tasks
          </p>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Completed</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {completedCount}
                </p>
              </div>
              <CheckCircle2 className="w-10 h-10 text-green-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">In Progress</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {inProgressCount}
                </p>
              </div>
              <Clock className="w-10 h-10 text-blue-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Pending</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {pendingCount}
                </p>
              </div>
              <AlertCircle className="w-10 h-10 text-yellow-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Total Time</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {Math.floor(totalTime / 60)}h {totalTime % 60}m
                </p>
              </div>
              <Users className="w-10 h-10 text-purple-500 opacity-50" />
            </div>
          </Card>
        </div>

        {/* Recent Tasks */}
        <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
            Recent Tasks
          </h3>

          {myTasks && myTasks.length > 0 ? (
            <div className="space-y-3">
              {myTasks.slice(0, 5).map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-between p-4 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                >
                  <div>
                    <p className="font-medium text-slate-900 dark:text-slate-50">
                      Task #{task.id}
                    </p>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      Status: {task.status?.replace(/_/g, " ") || "Unknown"}
                    </p>
                  </div>
                  <Button
                    onClick={() => setLocation(`/staff/workflow/${task.id}`)}
                    size="sm"
                  >
                    {task.status === "completed" ? "View" : "Continue"}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-slate-600 dark:text-slate-400">No tasks assigned yet</p>
          )}
        </Card>

        {/* Actions */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
              Quick Actions
            </h3>
            <div className="space-y-2">
              <Button
                className="w-full justify-start"
                variant="outline"
                onClick={() => setLocation("/admin/worklist")}
              >
                View Full Worklist
              </Button>
              <Button
                className="w-full justify-start"
                variant="outline"
                onClick={() => setLocation("/staff/patients")}
              >
                My Patients
              </Button>
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
              Performance
            </h3>
            <div className="space-y-3">
              <div>
                <div className="flex justify-between mb-2">
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                    Completion Rate
                  </span>
                  <span className="text-sm font-bold text-slate-900 dark:text-slate-50">
                    {myTasks && myTasks.length > 0
                      ? Math.round((completedCount / myTasks.length) * 100)
                      : 0}
                    %
                  </span>
                </div>
                <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
                  <div
                    className="bg-green-500 h-2 rounded-full transition-all duration-300"
                    style={{
                      width: `${
                        myTasks && myTasks.length > 0
                          ? (completedCount / myTasks.length) * 100
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </CCMDashboardLayout>
  );
}
