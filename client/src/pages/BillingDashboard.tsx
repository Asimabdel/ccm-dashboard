import React from "react";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { DollarSign, CheckCircle2, Clock, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function BillingDashboard() {
  const { user } = useAuth();
  const currentMonth = new Date().toISOString().slice(0, 7);

  const { data: billingRecords } = trpc.billing.listForMonth.useQuery(currentMonth, {
    enabled: user?.role === "billing",
  });

  const { data: readyCount } = trpc.billing.readyCount.useQuery(currentMonth, {
    enabled: user?.role === "billing",
  });

  const readyForBilling = readyCount || 0;
  const billed = billingRecords?.filter((r) => r.billingStatus === "billed").length || 0;
  const inProgress = billingRecords?.filter((r) => r.billingStatus === "in_progress").length || 0;
  const denied = billingRecords?.filter((r) => r.billingStatus === "denied").length || 0;

  return (
    <CCMDashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-3xl font-bold text-slate-900 dark:text-slate-50 mb-2">
            Billing Dashboard
          </h2>
          <p className="text-slate-600 dark:text-slate-400">
            {currentMonth} • Billing status and claims tracking
          </p>
        </div>

        {/* Key Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Ready for Billing</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {readyForBilling}
                </p>
              </div>
              <DollarSign className="w-10 h-10 text-green-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Billed</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {billed}
                </p>
              </div>
              <CheckCircle2 className="w-10 h-10 text-green-600 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">In Progress</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {inProgress}
                </p>
              </div>
              <Clock className="w-10 h-10 text-blue-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Denied</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {denied}
                </p>
              </div>
              <AlertCircle className="w-10 h-10 text-red-500 opacity-50" />
            </div>
          </Card>
        </div>

        {/* Billing Records */}
        <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
            Billing Records
          </h3>

          {billingRecords && billingRecords.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-700">
                    <th className="text-left py-2 px-2 font-medium text-slate-700 dark:text-slate-300">
                      Patient ID
                    </th>
                    <th className="text-left py-2 px-2 font-medium text-slate-700 dark:text-slate-300">
                      Status
                    </th>
                    <th className="text-left py-2 px-2 font-medium text-slate-700 dark:text-slate-300">
                      Documentation
                    </th>
                    <th className="text-left py-2 px-2 font-medium text-slate-700 dark:text-slate-300">
                      Time Spent
                    </th>
                    <th className="text-left py-2 px-2 font-medium text-slate-700 dark:text-slate-300">
                      Date
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {billingRecords.map((record) => (
                    <tr
                      key={record.id}
                      className="border-b border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <td className="py-3 px-2 text-slate-900 dark:text-slate-50">
                        {record.patientId}
                      </td>
                      <td className="py-3 px-2">
                        <Badge
                          className={
                            record.billingStatus === "ready_for_billing"
                              ? "bg-green-100 text-green-800"
                              : record.billingStatus === "billed"
                                ? "bg-blue-100 text-blue-800"
                                : record.billingStatus === "denied"
                                  ? "bg-red-100 text-red-800"
                                  : "bg-yellow-100 text-yellow-800"
                          }
                        >
                          {record.billingStatus?.replace(/_/g, " ") || "Unknown"}
                        </Badge>
                      </td>
                      <td className="py-3 px-2 text-slate-600 dark:text-slate-400">
                        {record.documentationComplete ? "✓ Complete" : "Incomplete"}
                      </td>
                      <td className="py-3 px-2 text-slate-600 dark:text-slate-400">
                        N/A
                      </td>
                      <td className="py-3 px-2 text-slate-600 dark:text-slate-400">
                        {new Date(record.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-slate-600 dark:text-slate-400">No billing records for this month</p>
          )}
        </Card>

        {/* Billing Summary */}
        <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
            Monthly Summary
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-2">
                Total CCMs Completed
              </p>
              <p className="text-2xl font-bold text-slate-900 dark:text-slate-50">
                {billingRecords?.length || 0}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-2">
                Billing Completion Rate
              </p>
              <p className="text-2xl font-bold text-slate-900 dark:text-slate-50">
                {billingRecords && billingRecords.length > 0
                  ? Math.round(
                      ((billed + readyForBilling) / billingRecords.length) * 100
                    )
                  : 0}
                %
              </p>
            </div>
          </div>
        </Card>
      </div>
    </CCMDashboardLayout>
  );
}
