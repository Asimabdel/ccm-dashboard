import React, { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Play, Pause, StopCircle, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";

interface CCMCallWorkflowProps {
  taskId: number;
  patientId: number;
  patientName: string;
}

export function CCMCallWorkflow({ taskId, patientId, patientName }: CCMCallWorkflowProps) {
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [responses, setResponses] = useState({
    howFeeling: "",
    newSymptoms: "",
    medicationAdherence: "",
    refillsNeeded: "",
    erHospitalizationSince: "",
    recentSpecialistVisits: "",
    bloodPressureReading: "",
    bloodSugarReading: "",
    upcomingAppointments: "",
    followUpNeeded: "",
    patientConcerns: "",
  });
  const [generatedNote, setGeneratedNote] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [escalationFlag, setEscalationFlag] = useState(false);
  const [escalationReason, setEscalationReason] = useState("");

  const createNote = trpc.ccmNotes.create.useMutation();
  const updateTask = trpc.ccmTasks.updateStatus.useMutation();

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (timerRunning) {
      interval = setInterval(() => {
        setTimerSeconds((s) => s + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [timerRunning]);

  const formatTime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs.toString().padStart(2, "0")}:${mins
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const handleGenerateNote = async () => {
    setIsGenerating(true);
    try {
      const noteText = `CCM Monthly Follow-Up Note

Patient: ${patientName}
Time spent: ${Math.floor(timerSeconds / 60)} minutes

Patient contacted for monthly chronic care management follow-up. Patient identity confirmed.

Health Status: ${responses.howFeeling || "Not reported"}
Symptoms: ${responses.newSymptoms || "None reported"}
Medication Adherence: ${responses.medicationAdherence || "Not discussed"}
Medications/Refills: ${responses.refillsNeeded || "No refills needed"}
Recent ER/Hospitalization: ${responses.erHospitalizationSince || "None"}
Specialist Visits: ${responses.recentSpecialistVisits || "None"}
Blood Pressure: ${responses.bloodPressureReading || "Not taken"}
Blood Sugar: ${responses.bloodSugarReading || "Not taken"}

Upcoming Appointments: ${responses.upcomingAppointments || "None scheduled"}
Follow-up Needed: ${responses.followUpNeeded || "None identified"}
Patient Concerns: ${responses.patientConcerns || "None reported"}

Patient was advised to continue current care plan and follow up as scheduled. ${escalationFlag ? `Concerns requiring provider review: ${escalationReason}` : "No urgent concerns identified."}

Total CCM time spent this month: ${Math.floor(timerSeconds / 60)} minutes.
Date: ${new Date().toLocaleDateString()}`;

      setGeneratedNote(noteText);
    } catch (error) {
      console.error("Error generating note:", error);
      setGeneratedNote("Error generating note. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSaveNote = async () => {
    try {
      await createNote.mutateAsync({
        ccmTaskId: taskId,
        patientId,
        ...responses,
        escalationFlag,
        escalationReason: escalationFlag ? escalationReason : undefined,
        timeSpentMinutes: Math.floor(timerSeconds / 60),
      });

      await updateTask.mutateAsync({
        id: taskId,
        status: "completed",
      });

      setTimerRunning(false);
      setTimerSeconds(0);
      setResponses({
        howFeeling: "",
        newSymptoms: "",
        medicationAdherence: "",
        refillsNeeded: "",
        erHospitalizationSince: "",
        recentSpecialistVisits: "",
        bloodPressureReading: "",
        bloodSugarReading: "",
        upcomingAppointments: "",
        followUpNeeded: "",
        patientConcerns: "",
      });
      setGeneratedNote("");
      setEscalationFlag(false);
      setEscalationReason("");
    } catch (error) {
      console.error("Error saving note:", error);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="p-6 bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800">
        <h3 className="font-bold text-lg mb-4">Call Script</h3>
        <p className="text-sm leading-relaxed mb-4">
          "Good afternoon, this is [Your Name] calling from [Clinic Name] for your monthly
          chronic care follow-up. I'm calling to check how you have been doing since your last
          visit and to see if you need any help with medications, appointments, labs, or any
          concerns before your next appointment."
        </p>
        <div className="space-y-2 text-sm">
          <p>Then proceed to ask:</p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>How have you been feeling since your last visit?</li>
            <li>Any new or worsening symptoms?</li>
            <li>Have you been taking your medications as prescribed?</li>
            <li>Do you need any refills?</li>
            <li>Have you checked your blood pressure or blood sugar recently?</li>
            <li>Have you gone to the ER or hospital since we last spoke?</li>
            <li>Do you have any upcoming specialist appointments?</li>
            <li>Do you need help scheduling a follow-up with our office?</li>
            <li>Is there anything you want me to send to the provider?</li>
          </ul>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg">Call Timer</h3>
          <div className="text-3xl font-mono font-bold text-primary">{formatTime(timerSeconds)}</div>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => setTimerRunning(!timerRunning)}
            className="flex items-center gap-2"
          >
            {timerRunning ? (
              <>
                <Pause size={18} /> Pause
              </>
            ) : (
              <>
                <Play size={18} /> Start
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setTimerRunning(false);
              setTimerSeconds(0);
            }}
          >
            <StopCircle size={18} /> Reset
          </Button>
        </div>
      </Card>

      <Card className="p-6">
        <h3 className="font-bold text-lg mb-4">Call Responses</h3>
        <Tabs defaultValue="health" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="health">Health Status</TabsTrigger>
            <TabsTrigger value="medications">Medications</TabsTrigger>
            <TabsTrigger value="followup">Follow-up</TabsTrigger>
          </TabsList>

          <TabsContent value="health" className="space-y-4">
            <div>
              <Label>How have you been feeling?</Label>
              <Textarea
                value={responses.howFeeling}
                onChange={(e) =>
                  setResponses({ ...responses, howFeeling: e.target.value })
                }
                placeholder="Patient's response..."
                className="mt-2"
              />
            </div>
            <div>
              <Label>Any new or worsening symptoms?</Label>
              <Textarea
                value={responses.newSymptoms}
                onChange={(e) =>
                  setResponses({ ...responses, newSymptoms: e.target.value })
                }
                placeholder="Symptoms reported..."
                className="mt-2"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Blood Pressure Reading</Label>
                <Input
                  value={responses.bloodPressureReading}
                  onChange={(e) =>
                    setResponses({
                      ...responses,
                      bloodPressureReading: e.target.value,
                    })
                  }
                  placeholder="e.g., 120/80"
                  className="mt-2"
                />
              </div>
              <div>
                <Label>Blood Sugar Reading</Label>
                <Input
                  value={responses.bloodSugarReading}
                  onChange={(e) =>
                    setResponses({
                      ...responses,
                      bloodSugarReading: e.target.value,
                    })
                  }
                  placeholder="e.g., 120 mg/dL"
                  className="mt-2"
                />
              </div>
            </div>
            <div>
              <Label>Any ER visits or hospitalizations?</Label>
              <Textarea
                value={responses.erHospitalizationSince}
                onChange={(e) =>
                  setResponses({
                    ...responses,
                    erHospitalizationSince: e.target.value,
                  })
                }
                placeholder="ER/hospitalization details..."
                className="mt-2"
              />
            </div>
          </TabsContent>

          <TabsContent value="medications" className="space-y-4">
            <div>
              <Label>Medication adherence</Label>
              <Textarea
                value={responses.medicationAdherence}
                onChange={(e) =>
                  setResponses({
                    ...responses,
                    medicationAdherence: e.target.value,
                  })
                }
                placeholder="How patient is taking medications..."
                className="mt-2"
              />
            </div>
            <div>
              <Label>Refills needed</Label>
              <Textarea
                value={responses.refillsNeeded}
                onChange={(e) =>
                  setResponses({ ...responses, refillsNeeded: e.target.value })
                }
                placeholder="List any refills needed..."
                className="mt-2"
              />
            </div>
            <div>
              <Label>Recent specialist visits</Label>
              <Textarea
                value={responses.recentSpecialistVisits}
                onChange={(e) =>
                  setResponses({
                    ...responses,
                    recentSpecialistVisits: e.target.value,
                  })
                }
                placeholder="Specialist appointments and results..."
                className="mt-2"
              />
            </div>
          </TabsContent>

          <TabsContent value="followup" className="space-y-4">
            <div>
              <Label>Upcoming appointments</Label>
              <Textarea
                value={responses.upcomingAppointments}
                onChange={(e) =>
                  setResponses({
                    ...responses,
                    upcomingAppointments: e.target.value,
                  })
                }
                placeholder="Scheduled appointments..."
                className="mt-2"
              />
            </div>
            <div>
              <Label>Follow-up needed</Label>
              <Textarea
                value={responses.followUpNeeded}
                onChange={(e) =>
                  setResponses({ ...responses, followUpNeeded: e.target.value })
                }
                placeholder="Labs, referrals, testing needed..."
                className="mt-2"
              />
            </div>
            <div>
              <Label>Patient concerns or questions for provider</Label>
              <Textarea
                value={responses.patientConcerns}
                onChange={(e) =>
                  setResponses({ ...responses, patientConcerns: e.target.value })
                }
                placeholder="Patient's concerns..."
                className="mt-2"
              />
            </div>
          </TabsContent>
        </Tabs>
      </Card>

      <Card className="p-6 border-destructive/50">
        <h3 className="font-bold text-lg mb-4">Provider Escalation</h3>
        <div className="space-y-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={escalationFlag}
              onChange={(e) => setEscalationFlag(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm">Flag for provider review</span>
          </label>
          {escalationFlag && (
            <Textarea
              value={escalationReason}
              onChange={(e) => setEscalationReason(e.target.value)}
              placeholder="Reason for escalation..."
              className="mt-2"
            />
          )}
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg">Generated CCM Note</h3>
          <Button
            onClick={handleGenerateNote}
            disabled={isGenerating}
            className="flex items-center gap-2"
          >
            {isGenerating && <Loader2 size={18} className="animate-spin" />}
            {isGenerating ? "Generating..." : "Generate Note"}
          </Button>
        </div>
        {generatedNote && (
          <div className="bg-muted p-4 rounded-lg whitespace-pre-wrap text-sm leading-relaxed">
            {generatedNote}
          </div>
        )}
      </Card>

      <div className="flex gap-2">
        <Button
          onClick={handleSaveNote}
          disabled={createNote.isPending}
          className="flex-1"
        >
          {createNote.isPending ? "Saving..." : "Save & Complete Call"}
        </Button>
      </div>
    </div>
  );
}
