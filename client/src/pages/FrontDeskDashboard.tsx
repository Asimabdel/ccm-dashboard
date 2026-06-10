import React from "react";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Calendar, AlertCircle, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function FrontDeskDashboard() {
  const { user } = useAuth();

  // Mock follow-up data for demonstration
  const mockFollowUps = [
    { id: 1, patientId: 101, followUpType: "appointment", followUpDescription: "Cardiology follow-up", dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), completionStatus: "pending" },
    { id: 2, patientId: 102, followUpType: "lab_work", followUpDescription: "A1C test", dueDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), completionStatus: "pending" },
    { id: 3, patientId: 103, followUpType: "testing", followUpDescription: "EKG", dueDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), completionStatus: "pending" },
  ];

  const appointmentNeeded = mockFollowUps.filter((f) => f.followUpType === "appointment").length;
  const labsNeeded = mockFollowUps.filter((f) => f.followUpType === "lab_work").length;
  const testingNeeded = mockFollowUps.filter((f) => f.followUpType === "testing").length;
  const completed = 0;

  return (
    <CCMDashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-3xl font-bold text-slate-900 dark:text-slate-50 mb-2">
            Follow-Up Coordination
          </h2>
          <p className="text-slate-600 dark:text-slate-400">
            Manage patient appointments, labs, and testing follow-ups
          </p>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Appointments Needed</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {appointmentNeeded}
                </p>
              </div>
              <Calendar className="w-10 h-10 text-blue-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Labs Needed</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {labsNeeded}
                </p>
              </div>
              <AlertCircle className="w-10 h-10 text-yellow-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Testing Needed</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {testingNeeded}
                </p>
              </div>
              <AlertCircle className="w-10 h-10 text-red-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Completed</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {completed}
                </p>
              </div>
              <CheckCircle2 className="w-10 h-10 text-green-500 opacity-50" />
            </div>
          </Card>
        </div>

        {/* Pending Follow-Ups */}
        <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
            Pending Follow-Ups
          </h3>

          {mockFollowUps && mockFollowUps.length > 0 ? (
            <div className="space-y-3">
              {mockFollowUps.slice(0, 10).map((followUp: any) => {
                return (
                  <div
                    key={followUp.id}
                    className="p-4 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <p className="font-medium text-slate-900 dark:text-slate-50">
                            Patient {followUp.patientId}
                          </p>
                          <Badge
                            className={
                              followUp.followUpType === "appointment"
                                ? "bg-blue-100 text-blue-800"
                                : followUp.followUpType === "lab_work"
                                  ? "bg-yellow-100 text-yellow-800"
                                  : "bg-red-100 text-red-800"
                            }
                          >
                            {followUp.followUpType?.replace(/_/g, " ") || "Follow-up"}
                          </Badge>
                        </div>
                        <p className="text-sm text-slate-600 dark:text-slate-400 mb-1">
                          {followUp.followUpDescription || "No description"}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-500">
                          Due: {new Date(followUp.dueDate).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-slate-600 dark:text-slate-400">No pending follow-ups</p>
          )}
        </Card>

        {/* Follow-Up Categories */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <h4 className="font-bold text-slate-900 dark:text-slate-50 mb-4">Appointments</h4>
            <p className="text-3xl font-bold text-blue-600 mb-2">{appointmentNeeded}</p>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Patients needing appointment scheduling
            </p>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <h4 className="font-bold text-slate-900 dark:text-slate-50 mb-4">Lab Work</h4>
            <p className="text-3xl font-bold text-yellow-600 mb-2">{labsNeeded}</p>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Patients needing lab orders placed
            </p>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <h4 className="font-bold text-slate-900 dark:text-slate-50 mb-4">Testing</h4>
            <p className="text-3xl font-bold text-red-600 mb-2">{testingNeeded}</p>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Patients needing diagnostic testing
            </p>
          </Card>
        </div>
      </div>
    </CCMDashboardLayout>
  );
}
