import React from "react";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { Users, ClipboardList, AlertCircle, CheckCircle2, TrendingUp } from "lucide-react";
import { trpc } from "@/lib/trpc";

export default function AdminDashboard() {
  const [, setLocation] = useLocation();
  const currentMonth = new Date().toISOString().slice(0, 7);

  const { data: patients } = trpc.patients.list.useQuery({ activeOnly: true });
  const { data: tasks } = trpc.ccmTasks.listForMonth.useQuery(currentMonth);
  const { data: escalations } = trpc.escalations.listPending.useQuery();
  const { data: billingReady } = trpc.billing.readyCount.useQuery(currentMonth);

  const completedTasks = tasks?.filter((t) => t.status === "completed").length || 0;
  const completionPercentage = tasks ? Math.round((completedTasks / tasks.length) * 100) : 0;

  return (
    <CCMDashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-3xl font-bold text-foreground mb-2">Program Overview</h2>
          <p className="text-muted-foreground">
            Real-time metrics for {currentMonth}
          </p>
        </div>

        {/* Key Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Active Patients</p>
                <p className="text-3xl font-bold text-foreground mt-2">
                  {patients?.length || 0}
                </p>
              </div>
              <Users className="w-10 h-10 text-blue-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total CCMs</p>
                <p className="text-3xl font-bold text-foreground mt-2">
                  {tasks?.length || 0}
                </p>
              </div>
              <ClipboardList className="w-10 h-10 text-green-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Completed</p>
                <p className="text-3xl font-bold text-foreground mt-2">
                  {completedTasks}
                </p>
              </div>
              <CheckCircle2 className="w-10 h-10 text-green-600 opacity-50" />
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Escalations</p>
                <p className="text-3xl font-bold text-foreground mt-2">
                  {escalations?.length || 0}
                </p>
              </div>
              <AlertCircle className="w-10 h-10 text-red-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Ready for Billing</p>
                <p className="text-3xl font-bold text-foreground mt-2">
                  {billingReady || 0}
                </p>
              </div>
              <TrendingUp className="w-10 h-10 text-purple-500 opacity-50" />
            </div>
          </Card>
        </div>

        {/* Completion Progress */}
        <Card className="p-6">
          <h3 className="font-bold text-lg mb-4">Monthly Progress</h3>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between mb-2">
                <span className="text-sm font-medium">Completion Rate</span>
                <span className="text-sm font-bold text-primary">{completionPercentage}%</span>
              </div>
              <div className="w-full bg-muted rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all duration-300"
                  style={{ width: `${completionPercentage}%` }}
                />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {completedTasks} of {tasks?.length || 0} CCMs completed
            </p>
          </div>
        </Card>

        {/* Quick Actions */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-6">
            <h3 className="font-bold text-lg mb-4">Quick Actions</h3>
            <div className="space-y-2">
              <Button
                className="w-full justify-start"
                variant="outline"
                onClick={() => setLocation("/admin/patients")}
              >
                Manage Patients
              </Button>
              <Button
                className="w-full justify-start"
                variant="outline"
                onClick={() => setLocation("/admin/assignment")}
              >
                Assign Patients to Staff
              </Button>
              <Button
                className="w-full justify-start"
                variant="outline"
                onClick={() => setLocation("/admin/worklist")}
              >
                View Monthly Worklist
              </Button>
              <Button
                className="w-full justify-start"
                variant="outline"
                onClick={() => setLocation("/admin/escalations")}
              >
                Review Escalations
              </Button>
            </div>
          </Card>

          <Card className="p-6">
            <h3 className="font-bold text-lg mb-4">Pending Actions</h3>
            <div className="space-y-3">
              {escalations && escalations.length > 0 ? (
                <div className="text-sm">
                  <p className="text-destructive font-medium">
                    {escalations.length} patient(s) need provider review
                  </p>
                  <Button
                    className="mt-2 w-full"
                    onClick={() => setLocation("/admin/escalations")}
                  >
                    Review Now
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No pending escalations</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </CCMDashboardLayout>
  );
}
