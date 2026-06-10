import React, { useState } from "react";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocation } from "wouter";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Phone, AlertCircle, CheckCircle2 } from "lucide-react";

const statusColors: Record<string, string> = {
  not_started: "bg-gray-100 text-gray-800",
  assigned: "bg-blue-100 text-blue-800",
  called_no_answer: "bg-yellow-100 text-yellow-800",
  voicemail_left: "bg-yellow-100 text-yellow-800",
  in_progress: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  needs_provider_review: "bg-red-100 text-red-800",
  ready_for_billing: "bg-purple-100 text-purple-800",
  billed: "bg-green-100 text-green-800",
};

const priorityColors: Record<string, string> = {
  high: "bg-red-100 text-red-800",
  medium: "bg-yellow-100 text-yellow-800",
  low: "bg-green-100 text-green-800",
};

export default function MonthlyWorklist() {
  const [, setLocation] = useLocation();
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  // Priority filtering removed - not in current schema
  const [searchTerm, setSearchTerm] = useState("");

  const { data: tasks, isLoading } = trpc.ccmTasks.listForMonth.useQuery(currentMonth);
  const { data: patients } = trpc.patients.list.useQuery({ activeOnly: true });

  const filteredTasks = tasks?.filter((task) => {
    if (statusFilter !== "all" && task.status && task.status !== statusFilter) return false;

    const patient = patients?.find((p) => p.id === task.patientId);
    if (searchTerm && !patient?.name.toLowerCase().includes(searchTerm.toLowerCase())) {
      return false;
    }

    return true;
  });

  const getStatusIcon = (status: string) => {
    if (status === "completed") return <CheckCircle2 className="w-4 h-4 text-green-600" />;
    if (status === "needs_provider_review") return <AlertCircle className="w-4 h-4 text-red-600" />;
    if (status === "in_progress") return <Phone className="w-4 h-4 text-blue-600" />;
    return null;
  };

  return (
    <CCMDashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-3xl font-bold text-slate-900 dark:text-slate-50 mb-2">
            Monthly CCM Worklist
          </h2>
          <p className="text-slate-600 dark:text-slate-400">
            {currentMonth} • {filteredTasks?.length || 0} tasks
          </p>
        </div>

        {/* Filters */}
        <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Search Patient
              </label>
              <Input
                placeholder="Patient name..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="mt-2"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Status
              </label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="not_started">Not Started</SelectItem>
                  <SelectItem value="assigned">Assigned</SelectItem>
                  <SelectItem value="called_no_answer">Called - No Answer</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="needs_provider_review">Needs Review</SelectItem>
                  <SelectItem value="ready_for_billing">Ready for Billing</SelectItem>
                </SelectContent>
              </Select>
            </div>



            <div className="flex items-end">
              <Button
                onClick={() => {
                  setStatusFilter("all");
                  setSearchTerm("");
                }}
                variant="outline"
                className="w-full"
              >
                Clear Filters
              </Button>
            </div>
          </div>
        </Card>

        {/* Tasks Table */}
        <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <p className="text-slate-500 dark:text-slate-400">Loading tasks...</p>
            </div>
          ) : filteredTasks && filteredTasks.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Patient</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Assigned To</TableHead>
                    <TableHead>Time Spent</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTasks.map((task) => {
                    const patient = patients?.find((p) => p.id === task.patientId);
                    return (
                      <TableRow key={task.id}>
                        <TableCell className="font-medium">{patient?.name || "Unknown"}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {task.status && getStatusIcon(task.status)}
                            <Badge className={task.status ? statusColors[task.status] || "bg-gray-100" : "bg-gray-100"}>
                              {task.status?.replace(/_/g, " ") || "Unknown"}
                            </Badge>
                          </div>
                        </TableCell>

                        <TableCell>{task.assignedStaffId ? "Assigned" : "Unassigned"}</TableCell>
                        <TableCell>{task.timeSpentMinutes || 0} min</TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            onClick={() => setLocation(`/staff/workflow/${task.id}`)}
                            className="text-xs"
                          >
                            {task.status === "completed" ? "View" : "Start Call"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-slate-500 dark:text-slate-400">No tasks match your filters</p>
            </div>
          )}
        </Card>

        {/* Summary Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-600 dark:text-slate-400">Total Tasks</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-1">
              {tasks?.length || 0}
            </p>
          </Card>

          <Card className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-600 dark:text-slate-400">Completed</p>
            <p className="text-2xl font-bold text-green-600 mt-1">
              {tasks?.filter((t) => t.status === "completed").length || 0}
            </p>
          </Card>

          <Card className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-600 dark:text-slate-400">In Progress</p>
            <p className="text-2xl font-bold text-blue-600 mt-1">
              {tasks?.filter((t) => t.status === "in_progress").length || 0}
            </p>
          </Card>

          <Card className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-600 dark:text-slate-400">Needs Review</p>
            <p className="text-2xl font-bold text-red-600 mt-1">
              {tasks?.filter((t) => t.status === "needs_provider_review").length || 0}
            </p>
          </Card>
        </div>
      </div>
    </CCMDashboardLayout>
  );
}
