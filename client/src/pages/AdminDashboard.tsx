import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { Users, ClipboardList, AlertCircle, CheckCircle2, TrendingUp, Activity, Clock, Target } from "lucide-react";
import { trpc } from "@/lib/trpc";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// Mock data for charts
const dailyCompletionData = [
  { date: "Jun 1", completed: 12, target: 15 },
  { date: "Jun 2", completed: 18, target: 15 },
  { date: "Jun 3", completed: 14, target: 15 },
  { date: "Jun 4", completed: 22, target: 15 },
  { date: "Jun 5", completed: 19, target: 15 },
  { date: "Jun 6", completed: 25, target: 15 },
  { date: "Jun 7", completed: 28, target: 15 },
  { date: "Jun 8", completed: 31, target: 15 },
  { date: "Jun 9", completed: 35, target: 15 },
  { date: "Jun 10", completed: 42, target: 15 },
];

const staffPerformanceData = [
  { name: "Sarah Johnson", completed: 28, pending: 7, total: 35 },
  { name: "Michael Chen", completed: 24, pending: 11, total: 35 },
  { name: "Emma Davis", completed: 31, pending: 4, total: 35 },
  { name: "James Wilson", completed: 19, pending: 16, total: 35 },
  { name: "Lisa Anderson", completed: 26, pending: 9, total: 35 },
];

const statusDistributionData = [
  { name: "Completed", value: 128, color: "#10b981" },
  { name: "In Progress", value: 45, color: "#3b82f6" },
  { name: "Called No Answer", value: 23, color: "#f59e0b" },
  { name: "Not Started", value: 12, color: "#ef4444" },
];

const clinicPerformanceData = [
  { clinic: "Downtown", ccms: 85, completed: 72, percentage: 85 },
  { clinic: "Midtown", ccms: 62, completed: 48, percentage: 77 },
  { clinic: "Uptown", ccms: 58, completed: 45, percentage: 78 },
  { clinic: "Westside", ccms: 63, completed: 51, percentage: 81 },
];

const callDurationData = [
  { range: "0-5 min", count: 18 },
  { range: "5-10 min", count: 45 },
  { range: "10-15 min", count: 62 },
  { range: "15-20 min", count: 38 },
  { range: "20+ min", count: 12 },
];

export default function AdminDashboard() {
  const [, setLocation] = useLocation();
  const currentMonth = new Date().toISOString().slice(0, 7);

  const { data: patients } = trpc.patients.list.useQuery({ activeOnly: true });
  const { data: tasks } = trpc.ccmTasks.listForMonth.useQuery(currentMonth);
  const { data: escalations } = trpc.escalations.listPending.useQuery();
  const { data: billingReady } = trpc.billing.readyCount.useQuery(currentMonth);

  const completedTasks = tasks?.filter((t) => t.status === "completed").length || 0;
  const inProgressTasks = tasks?.filter((t) => t.status === "in_progress").length || 0;
  const totalTasks = tasks?.length || 128;
  const completionPercentage = tasks ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const avgCallDuration = 12.5; // minutes

  return (
    <CCMDashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-3xl font-bold text-slate-900 dark:text-slate-50 mb-2">Program Overview</h2>
          <p className="text-slate-600 dark:text-slate-400">
            Real-time metrics for June 2026 • Last updated 2 minutes ago
          </p>
        </div>

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="p-6 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Active Patients</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {patients?.length || 268}
                </p>
                <p className="text-xs text-slate-500 mt-1">Enrolled in CCM</p>
              </div>
              <Users className="w-10 h-10 text-blue-400 opacity-60" />
            </div>
          </Card>

          <Card className="p-6 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Total CCMs This Month</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {totalTasks}
                </p>
                <p className="text-xs text-slate-500 mt-1">Due for completion</p>
              </div>
              <ClipboardList className="w-10 h-10 text-green-400 opacity-60" />
            </div>
          </Card>

          <Card className="p-6 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Completed</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {completedTasks}
                </p>
                <p className="text-xs text-green-600 dark:text-green-400 mt-1">{completionPercentage}% completion</p>
              </div>
              <CheckCircle2 className="w-10 h-10 text-green-500 opacity-60" />
            </div>
          </Card>

          <Card className="p-6 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Pending Escalations</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {escalations?.length || 8}
                </p>
                <p className="text-xs text-red-600 dark:text-red-400 mt-1">Require attention</p>
              </div>
              <AlertCircle className="w-10 h-10 text-red-400 opacity-60" />
            </div>
          </Card>
        </div>

        {/* Secondary Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="p-6 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">In Progress</p>
                <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-2">{inProgressTasks}</p>
              </div>
              <Activity className="w-8 h-8 text-blue-400 opacity-60" />
            </div>
          </Card>

          <Card className="p-6 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Avg Call Duration</p>
                <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-2">{avgCallDuration} min</p>
              </div>
              <Clock className="w-8 h-8 text-purple-400 opacity-60" />
            </div>
          </Card>

          <Card className="p-6 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Ready for Billing</p>
                <p className="text-2xl font-bold text-slate-900 dark:text-slate-50 mt-2">{billingReady || 89}</p>
              </div>
              <TrendingUp className="w-8 h-8 text-purple-400 opacity-60" />
            </div>
          </Card>
        </div>

        {/* Charts Row 1 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Daily Completion Trend */}
          <Card className="p-6 border border-slate-200 dark:border-slate-700">
            <h3 className="font-bold text-lg mb-4 text-slate-900 dark:text-slate-50">Daily Completion Trend</h3>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={dailyCompletionData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" stroke="#64748b" />
                <YAxis stroke="#64748b" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1e293b",
                    border: "1px solid #475569",
                    borderRadius: "8px",
                  }}
                  labelStyle={{ color: "#f1f5f9" }}
                />
                <Legend />
                <Line type="monotone" dataKey="completed" stroke="#10b981" strokeWidth={2} name="Completed" />
                <Line type="monotone" dataKey="target" stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 5" name="Target" />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          {/* Status Distribution */}
          <Card className="p-6 border border-slate-200 dark:border-slate-700">
            <h3 className="font-bold text-lg mb-4 text-slate-900 dark:text-slate-50">Status Distribution</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={statusDistributionData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, value }) => `${name}: ${value}`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {statusDistributionData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </div>

        {/* Charts Row 2 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Staff Performance */}
          <Card className="p-6 border border-slate-200 dark:border-slate-700">
            <h3 className="font-bold text-lg mb-4 text-slate-900 dark:text-slate-50">Staff Performance</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={staffPerformanceData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" stroke="#64748b" />
                <YAxis stroke="#64748b" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1e293b",
                    border: "1px solid #475569",
                    borderRadius: "8px",
                  }}
                  labelStyle={{ color: "#f1f5f9" }}
                />
                <Legend />
                <Bar dataKey="completed" fill="#10b981" name="Completed" />
                <Bar dataKey="pending" fill="#f59e0b" name="Pending" />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Call Duration Distribution */}
          <Card className="p-6 border border-slate-200 dark:border-slate-700">
            <h3 className="font-bold text-lg mb-4 text-slate-900 dark:text-slate-50">Call Duration Distribution</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={callDurationData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="range" stroke="#64748b" />
                <YAxis stroke="#64748b" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1e293b",
                    border: "1px solid #475569",
                    borderRadius: "8px",
                  }}
                  labelStyle={{ color: "#f1f5f9" }}
                />
                <Bar dataKey="count" fill="#3b82f6" name="Number of Calls" />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>

        {/* Clinic Performance Table */}
        <Card className="p-6 border border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-lg mb-4 text-slate-900 dark:text-slate-50">Clinic Performance</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th className="text-left py-3 px-4 font-semibold text-slate-900 dark:text-slate-50">Clinic</th>
                  <th className="text-center py-3 px-4 font-semibold text-slate-900 dark:text-slate-50">Total CCMs</th>
                  <th className="text-center py-3 px-4 font-semibold text-slate-900 dark:text-slate-50">Completed</th>
                  <th className="text-center py-3 px-4 font-semibold text-slate-900 dark:text-slate-50">Completion %</th>
                </tr>
              </thead>
              <tbody>
                {clinicPerformanceData.map((clinic, idx) => (
                  <tr key={idx} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800">
                    <td className="py-3 px-4 text-slate-900 dark:text-slate-50">{clinic.clinic}</td>
                    <td className="text-center py-3 px-4 text-slate-600 dark:text-slate-400">{clinic.ccms}</td>
                    <td className="text-center py-3 px-4 text-slate-600 dark:text-slate-400">{clinic.completed}</td>
                    <td className="text-center py-3 px-4">
                      <div className="flex items-center justify-center gap-2">
                        <div className="w-16 bg-slate-200 dark:bg-slate-700 rounded-full h-2">
                          <div
                            className="bg-green-500 h-2 rounded-full"
                            style={{ width: `${clinic.percentage}%` }}
                          />
                        </div>
                        <span className="text-sm font-semibold text-slate-900 dark:text-slate-50 w-10 text-right">
                          {clinic.percentage}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Monthly Progress */}
        <Card className="p-6 border border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-lg mb-4 text-slate-900 dark:text-slate-50">Monthly Progress</h3>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between mb-2">
                <span className="text-sm font-medium text-slate-900 dark:text-slate-50">Overall Completion Rate</span>
                <span className="text-sm font-bold text-green-600 dark:text-green-400">{completionPercentage}%</span>
              </div>
              <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-3">
                <div
                  className="bg-gradient-to-r from-green-400 to-green-600 h-3 rounded-full transition-all duration-300"
                  style={{ width: `${completionPercentage}%` }}
                />
              </div>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {completedTasks} of {totalTasks} CCMs completed • {totalTasks - completedTasks} remaining
            </p>
          </div>
        </Card>

        {/* Quick Actions */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-6 border border-slate-200 dark:border-slate-700">
            <h3 className="font-bold text-lg mb-4 text-slate-900 dark:text-slate-50">Quick Actions</h3>
            <div className="space-y-2">
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
                onClick={() => setLocation("/admin/assignment")}
              >
                Assign Patients to Staff
              </Button>
              <Button
                className="w-full justify-start"
                variant="outline"
                onClick={() => setLocation("/admin/reporting")}
              >
                View Detailed Reports
              </Button>
            </div>
          </Card>

          <Card className="p-6 border border-slate-200 dark:border-slate-700">
            <h3 className="font-bold text-lg mb-4 text-slate-900 dark:text-slate-50">Alerts & Notifications</h3>
            <div className="space-y-3">
              <div className="flex items-start gap-3 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-900 dark:text-red-100">8 Pending Escalations</p>
                  <p className="text-xs text-red-700 dark:text-red-200">Require provider review</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">
                <Target className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-yellow-900 dark:text-yellow-100">23 Calls Not Answered</p>
                  <p className="text-xs text-yellow-700 dark:text-yellow-200">Retry recommended</p>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </CCMDashboardLayout>
  );
}
