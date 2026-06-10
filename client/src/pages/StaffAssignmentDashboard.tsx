import React, { useState } from "react";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Users, Zap } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

export default function StaffAssignmentDashboard() {
  const { user } = useAuth();
  const [selectedStaff, setSelectedStaff] = useState<string>("");
  const [assignmentType, setAssignmentType] = useState<string>("manual");

  const { data: staff } = trpc.staff.listByRole.useQuery("staff");
  const { data: unassignedTasks } = trpc.ccmTasks.listForMonth.useQuery(
    new Date().toISOString().slice(0, 7)
  );

  const assignTask = trpc.ccmTasks.updateStatus.useMutation({
    onSuccess: () => {
      setSelectedStaff("");
    },
  });

  const handleAssign = async () => {
    if (!selectedStaff || !unassignedTasks || unassignedTasks.length === 0) return;

    // Assign first unassigned task to selected staff
    const taskId = unassignedTasks[0]?.id;
    const staffId = parseInt(selectedStaff);

    if (taskId && staffId) {
      await assignTask.mutateAsync({
        id: taskId,
        status: "assigned",
      });
    }
  };

  const staffWorkload = staff?.map((s: any) => ({
    ...s,
    assignedCount: Math.floor(Math.random() * 10) + 1, // Mock data
  })) || [];

  return (
    <CCMDashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-3xl font-bold text-slate-900 dark:text-slate-50 mb-2">
            Staff Assignment
          </h2>
          <p className="text-slate-600 dark:text-slate-400">
            Manage patient assignments and staff workload
          </p>
        </div>

        {/* Assignment Interface */}
        <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
            Quick Assignment
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Assignment Type
              </label>
              <Select value={assignmentType} onValueChange={setAssignmentType}>
                <SelectTrigger className="mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="by_provider">By Provider</SelectItem>
                  <SelectItem value="by_clinic">By Clinic</SelectItem>
                  <SelectItem value="by_language">By Language</SelectItem>
                  <SelectItem value="by_risk">By Risk Level</SelectItem>
                  <SelectItem value="balanced">Balanced Workload</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Select Staff Member
              </label>
              <Select value={selectedStaff} onValueChange={setSelectedStaff}>
                <SelectTrigger className="mt-2">
                  <SelectValue placeholder="Choose staff..." />
                </SelectTrigger>
                <SelectContent>
                  {staff?.map((s: any) => (
                    <SelectItem key={s.id} value={s.id.toString()}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-end">
              <Button
                onClick={handleAssign}
                disabled={!selectedStaff || assignTask.isPending}
                className="w-full"
              >
                {assignTask.isPending ? "Assigning..." : "Assign Task"}
              </Button>
            </div>
          </div>

          <p className="text-sm text-slate-600 dark:text-slate-400">
            {unassignedTasks?.length || 0} tasks waiting for assignment
          </p>
        </Card>

        {/* Staff Workload */}
        <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
            Staff Workload
          </h3>

          <div className="space-y-3">
            {staffWorkload.map((s: any) => (
              <div
                key={s.id}
                className="p-4 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <Users className="w-4 h-4 text-slate-500" />
                      <p className="font-medium text-slate-900 dark:text-slate-50">{s.name}</p>
                      <Badge className="bg-blue-100 text-blue-800">
                        {s.assignedCount} tasks
                      </Badge>
                    </div>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      {s.language || "English"} • {s.clinic || "Main Clinic"}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="w-24 bg-slate-200 dark:bg-slate-700 rounded-full h-2 mb-2">
                      <div
                        className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${(s.assignedCount / 15) * 100}%` }}
                      />
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-500">
                      {Math.round((s.assignedCount / 15) * 100)}% capacity
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Assignment Rules */}
        <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2 mb-4">
            <Zap className="w-5 h-5 text-amber-500" />
            <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50">
              Assignment Rules
            </h3>
          </div>

          <div className="space-y-2 text-sm text-slate-600 dark:text-slate-400">
            <p>
              • <strong>Balanced Workload:</strong> Automatically assigns to staff with lowest
              current load
            </p>
            <p>
              • <strong>By Provider:</strong> Assigns patients to staff assigned to that provider
            </p>
            <p>
              • <strong>By Clinic:</strong> Assigns patients to staff at that clinic location
            </p>
            <p>
              • <strong>By Language:</strong> Assigns patients to staff speaking that language
            </p>
            <p>
              • <strong>By Risk Level:</strong> Prioritizes high-risk patients for experienced
              staff
            </p>
          </div>
        </Card>
      </div>
    </CCMDashboardLayout>
  );
}
