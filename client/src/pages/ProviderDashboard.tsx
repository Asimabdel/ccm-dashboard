import React, { useState } from "react";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function ProviderDashboard() {
  const { user } = useAuth();
  const [selectedEscalation, setSelectedEscalation] = useState<any>(null);
  const [actionNotes, setActionNotes] = useState("");
  const [isReviewing, setIsReviewing] = useState(false);

  const { data: escalations } = trpc.escalations.listByProvider.useQuery(user?.id || 0, {
    enabled: !!user?.id,
  });

  const updateEscalation = trpc.escalations.updateStatus.useMutation({
    onSuccess: () => {
      setSelectedEscalation(null);
      setActionNotes("");
      setIsReviewing(false);
    },
  });

  const pendingCount = escalations?.filter((e) => e.escalationStatus === "pending").length || 0;
  const reviewedCount = escalations?.filter((e) => e.escalationStatus === "reviewed").length || 0;
  const actionNeededCount =
    escalations?.filter((e) => e.escalationStatus === "action_needed").length || 0;

  const handleReviewEscalation = async (status: string) => {
    if (!selectedEscalation) return;

    await updateEscalation.mutateAsync({
      id: selectedEscalation.id,
      escalationStatus: status as any,
      providerNotes: actionNotes,
      recommendedAction: actionNotes,
    });
  };

  return (
    <CCMDashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-3xl font-bold text-slate-900 dark:text-slate-50 mb-2">
            Patient Escalations
          </h2>
          <p className="text-slate-600 dark:text-slate-400">
            Review flagged patients requiring clinical attention
          </p>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Pending Review</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {pendingCount}
                </p>
              </div>
              <AlertCircle className="w-10 h-10 text-red-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Reviewed</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {reviewedCount}
                </p>
              </div>
              <CheckCircle2 className="w-10 h-10 text-green-500 opacity-50" />
            </div>
          </Card>

          <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 dark:text-slate-400">Action Needed</p>
                <p className="text-3xl font-bold text-slate-900 dark:text-slate-50 mt-2">
                  {actionNeededCount}
                </p>
              </div>
              <Clock className="w-10 h-10 text-yellow-500 opacity-50" />
            </div>
          </Card>
        </div>

        {/* Escalations List */}
        <Card className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-lg text-slate-900 dark:text-slate-50 mb-4">
            All Escalations
          </h3>

          {escalations && escalations.length > 0 ? (
            <div className="space-y-3">
              {escalations.map((escalation) => (
                <div
                  key={escalation.id}
                  className="p-4 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <p className="font-medium text-slate-900 dark:text-slate-50">
                          Patient ID: {escalation.patientId}
                        </p>
                        <Badge
                          className={
                            escalation.escalationStatus === "pending"
                              ? "bg-red-100 text-red-800"
                              : escalation.escalationStatus === "reviewed"
                                ? "bg-green-100 text-green-800"
                                : "bg-yellow-100 text-yellow-800"
                          }
                        >
                          {escalation.escalationStatus}
                        </Badge>
                      </div>
                      <p className="text-sm text-slate-600 dark:text-slate-400 mb-2">
                        Reason: {escalation.reason || "Not specified"}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-500">
                        Flagged: {new Date(escalation.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        setSelectedEscalation(escalation);
                        setIsReviewing(true);
                      }}
                      className="ml-4"
                    >
                      Review
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-slate-600 dark:text-slate-400">No escalations at this time</p>
          )}
        </Card>
      </div>

      {/* Review Dialog */}
      <Dialog open={isReviewing} onOpenChange={setIsReviewing}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Review Escalation</DialogTitle>
          </DialogHeader>

          {selectedEscalation && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Patient ID
                </p>
                <p className="text-slate-900 dark:text-slate-50">{selectedEscalation.patientId}</p>
              </div>

              <div>
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Reason</p>
                <p className="text-slate-900 dark:text-slate-50">
                  {selectedEscalation.reason || "Not specified"}
                </p>
              </div>

              <div>
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Provider Notes & Recommendations
                </label>
                <Textarea
                  value={actionNotes}
                  onChange={(e) => setActionNotes(e.target.value)}
                  placeholder="Enter your clinical assessment and recommended actions..."
                  className="mt-2"
                  rows={4}
                />
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={() => handleReviewEscalation("reviewed")}
                  disabled={updateEscalation.isPending}
                  className="flex-1"
                >
                  {updateEscalation.isPending ? "Saving..." : "Mark Reviewed"}
                </Button>
                <Button
                  onClick={() => handleReviewEscalation("action_needed")}
                  disabled={updateEscalation.isPending}
                  variant="outline"
                  className="flex-1"
                >
                  Action Needed
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </CCMDashboardLayout>
  );
}
