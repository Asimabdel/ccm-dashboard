import { useAuth } from "@/_core/hooks/useAuth";
import { CCMDashboardLayout } from "@/components/CCMDashboardLayout";
import { trpc } from "@/lib/trpc";
import { useEffect, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { toast } from "sonner";
import {
  Loader2, Play, Pause, Square, Sparkles, AlertTriangle, Save, ArrowLeft, Clock, Phone,
} from "lucide-react";
import { fmtMinutes } from "@/lib/ccm";

type Responses = {
  howFeeling: string; newSymptoms: string; medicationAdherence: string; refillsNeeded: string;
  erHospitalizationSince: string; recentSpecialistVisits: string; bloodPressureReading: string;
  bloodSugarReading: string; upcomingAppointments: string; followUpNeeded: string; patientConcerns: string;
};

const EMPTY: Responses = {
  howFeeling: "", newSymptoms: "", medicationAdherence: "", refillsNeeded: "",
  erHospitalizationSince: "", recentSpecialistVisits: "", bloodPressureReading: "",
  bloodSugarReading: "", upcomingAppointments: "", followUpNeeded: "", patientConcerns: "",
};

const SCRIPT: { key: keyof Responses; question: string; placeholder: string }[] = [
  { key: "howFeeling", question: "How have you been feeling since our last check-in?", placeholder: "General wellbeing, energy, mood…" },
  { key: "newSymptoms", question: "Any new or worsening symptoms? (chest pain, shortness of breath, dizziness, swelling)", placeholder: "Describe any new symptoms…" },
  { key: "medicationAdherence", question: "Are you taking all medications as prescribed?", placeholder: "Adherence, missed doses, side effects…" },
  { key: "refillsNeeded", question: "Do you need any prescription refills?", placeholder: "Medications needing refill…" },
  { key: "bloodPressureReading", question: "Most recent blood pressure reading?", placeholder: "e.g. 128/82" },
  { key: "bloodSugarReading", question: "Most recent blood sugar reading? (if applicable)", placeholder: "e.g. 110 mg/dL fasting" },
  { key: "erHospitalizationSince", question: "Any ER visits or hospitalizations since last contact?", placeholder: "Dates, reason, outcome…" },
  { key: "recentSpecialistVisits", question: "Any recent specialist visits?", placeholder: "Specialist, date, findings…" },
  { key: "upcomingAppointments", question: "Any upcoming appointments scheduled?", placeholder: "Provider, date…" },
  { key: "followUpNeeded", question: "What follow-up does this patient need?", placeholder: "Labs, referrals, scheduling, education…" },
  { key: "patientConcerns", question: "Any other concerns from the patient?", placeholder: "Questions, social needs, barriers…" },
];

function pad(n: number) { return n.toString().padStart(2, "0"); }

export default function CallWorkflowPage() {
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const [, params] = useRoute("/workflow/:id");
  const [, setLocation] = useLocation();
  const taskId = Number(params?.id);

  const task = trpc.worklist.getTask.useQuery(taskId, { enabled: !!user && !!taskId });
  const patientId = task.data?.patientId;
  const patient = trpc.patients.detail.useQuery(patientId!, { enabled: !!patientId });
  const existingNote = trpc.ccmNotes.getByTaskId.useQuery(taskId, { enabled: !!user && !!taskId });
  const utils = trpc.useUtils();

  const [responses, setResponses] = useState<Responses>(EMPTY);
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(false);
  const [generatedNote, setGeneratedNote] = useState("");
  const [escalate, setEscalate] = useState(false);
  const [escalationReason, setEscalationReason] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // hydrate from existing note (review mode)
  useEffect(() => {
    if (existingNote.data && !hydrated) {
      const n = existingNote.data;
      setResponses({
        howFeeling: n.howFeeling || "", newSymptoms: n.newSymptoms || "", medicationAdherence: n.medicationAdherence || "",
        refillsNeeded: n.refillsNeeded || "", erHospitalizationSince: n.erHospitalizationSince || "",
        recentSpecialistVisits: n.recentSpecialistVisits || "", bloodPressureReading: n.bloodPressureReading || "",
        bloodSugarReading: n.bloodSugarReading || "", upcomingAppointments: n.upcomingAppointments || "",
        followUpNeeded: n.followUpNeeded || "", patientConcerns: n.patientConcerns || "",
      });
      if (n.generatedNote) setGeneratedNote(n.generatedNote);
      if (n.escalationFlag) { setEscalate(true); setEscalationReason(n.escalationReason || ""); }
      if (n.timeSpentMinutes) setSeconds(n.timeSpentMinutes * 60);
      setHydrated(true);
    } else if (task.data && !existingNote.data && !hydrated && existingNote.isFetched) {
      if (task.data.timeSpentMinutes) setSeconds(task.data.timeSpentMinutes * 60);
      setHydrated(true);
    }
  }, [existingNote.data, existingNote.isFetched, task.data, hydrated]);

  useEffect(() => {
    if (running) { timer.current = setInterval(() => setSeconds((s) => s + 1), 1000); }
    else if (timer.current) { clearInterval(timer.current); }
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [running]);

  const minutes = Math.max(1, Math.round(seconds / 60));

  const genNote = trpc.ccmNotesAI.generateNote.useMutation({
    onSuccess: (r) => { setGeneratedNote(typeof r.note === "string" ? r.note : String(r.note)); toast.success("Note drafted by AI. Review and edit as needed."); },
    onError: (e) => toast.error(e.message),
  });
  const saveNote = trpc.ccmNotes.save.useMutation({
    onSuccess: () => {
      utils.worklist.forMonth.invalidate(); utils.worklist.getTask.invalidate(taskId);
      toast.success("CCM note saved.");
      setLocation("/worklist");
    },
    onError: (e) => toast.error(e.message),
  });

  if (loading || !user || task.isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-[hsl(240_10%_97%)]"><Loader2 className="animate-spin text-slate-400" /></div>;
  }
  if (!task.data) {
    return <CCMDashboardLayout title="Call Workflow"><p className="text-slate-400">Task not found.</p></CCMDashboardLayout>;
  }

  const set = (k: keyof Responses, v: string) => setResponses((r) => ({ ...r, [k]: v }));
  const p = patient.data?.patient;
  const conditions: string[] = (p?.chronicConditions as string[]) || [];

  return (
    <CCMDashboardLayout title="Guided CCM Call">
      <button onClick={() => setLocation("/worklist")} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4"><ArrowLeft size={15} /> Back to worklist</button>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left: patient + timer */}
        <div className="space-y-5">
          <div className="bg-white rounded-3xl border border-slate-100 p-6">
            <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">Patient</p>
            <h2 className="text-2xl font-bold text-slate-900">{p?.name || <Loader2 className="animate-spin inline" />}</h2>
            <p className="text-sm text-slate-500 mt-0.5">{p?.dateOfBirth ? `DOB ${new Date(p.dateOfBirth).toLocaleDateString()}` : ""} {p?.phoneNumber ? `· ${p.phoneNumber}` : ""}</p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {conditions.map((c) => <span key={c} className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-[hsl(200_60%_94%)] text-[hsl(200_80%_30%)]">{c}</span>)}
            </div>
            {p?.insurance && <p className="mt-4 text-sm text-slate-500">Insurance: <span className="text-slate-700">{p.insurance}</span></p>}
          </div>

          <div className="bg-slate-900 text-white rounded-3xl p-6 text-center">
            <div className="flex items-center justify-center gap-2 text-slate-300 text-xs uppercase tracking-wider mb-3"><Clock size={13} /> Call Timer</div>
            <div className="text-5xl font-bold tabular-nums tracking-tight">{pad(Math.floor(seconds / 60))}:{pad(seconds % 60)}</div>
            <p className="text-slate-400 text-xs mt-1">Billable: {fmtMinutes(minutes)}</p>
            <div className="flex items-center justify-center gap-2 mt-5">
              {!running ? (
                <button onClick={() => setRunning(true)} className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-2xl bg-[hsl(150_60%_45%)] font-semibold text-sm hover:brightness-110 active:scale-[0.97] transition"><Play size={15} /> Start</button>
              ) : (
                <button onClick={() => setRunning(false)} className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-2xl bg-[hsl(40_95%_55%)] font-semibold text-sm hover:brightness-110 active:scale-[0.97] transition"><Pause size={15} /> Pause</button>
              )}
              <button onClick={() => { setRunning(false); }} className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-2xl bg-white/10 font-semibold text-sm hover:bg-white/20 active:scale-[0.97] transition"><Square size={15} /> Stop</button>
            </div>
            <div className="mt-4 flex items-center justify-center gap-2 text-xs">
              <span className="text-slate-400">Manual entry:</span>
              <input type="number" min={0} value={minutes} onChange={(e) => setSeconds(Math.max(0, Number(e.target.value)) * 60)} className="w-16 px-2 py-1 rounded-lg text-slate-900 text-center" /> <span className="text-slate-400">min</span>
            </div>
          </div>
        </div>

        {/* Right: script + form */}
        <div className="lg:col-span-2 space-y-5">
          <div className="bg-white rounded-3xl border border-slate-100 p-6">
            <div className="flex items-center gap-2 mb-5"><Phone size={16} className="text-[hsl(200_100%_45%)]" /><h3 className="font-bold text-slate-900">Call Script & Documentation</h3></div>
            <div className="space-y-5">
              {SCRIPT.map((q, i) => (
                <div key={q.key}>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5"><span className="text-slate-300 mr-1.5">{i + 1}.</span>{q.question}</label>
                  <textarea value={responses[q.key]} onChange={(e) => set(q.key, e.target.value)} placeholder={q.placeholder} rows={2}
                    className="w-full px-3.5 py-2.5 rounded-2xl border border-slate-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(200_100%_60%)] focus:border-transparent" />
                </div>
              ))}
            </div>
          </div>

          {/* Escalation */}
          <div className={`rounded-3xl border p-5 transition ${escalate ? "border-rose-200 bg-rose-50/60" : "border-slate-100 bg-white"}`}>
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={escalate} onChange={(e) => setEscalate(e.target.checked)} className="accent-rose-500 w-4 h-4" />
              <AlertTriangle size={16} className={escalate ? "text-rose-500" : "text-slate-400"} />
              <span className="font-medium text-slate-800 text-sm">Flag this patient for provider review (urgent symptom / escalation)</span>
            </label>
            {escalate && (
              <textarea value={escalationReason} onChange={(e) => setEscalationReason(e.target.value)} placeholder="Reason for escalation (what should the provider review?)" rows={2}
                className="mt-3 w-full px-3.5 py-2.5 rounded-2xl border border-rose-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-rose-300" />
            )}
          </div>

          {/* AI note */}
          <div className="bg-white rounded-3xl border border-slate-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2"><Sparkles size={16} className="text-[hsl(280_60%_55%)]" /><h3 className="font-bold text-slate-900">CCM Documentation Note</h3></div>
              <button disabled={genNote.isPending} onClick={() => genNote.mutate({ patientName: p?.name || "Patient", timeSpentMinutes: minutes, responses })}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-[hsl(280_60%_55%)] text-white text-sm font-semibold hover:brightness-110 active:scale-[0.97] transition disabled:opacity-50">
                {genNote.isPending ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Generate with AI
              </button>
            </div>
            <textarea value={generatedNote} onChange={(e) => setGeneratedNote(e.target.value)} placeholder="Click 'Generate with AI' to draft a professional CCM note from the responses above, or write your own. You can edit the generated text before saving."
              rows={12} className="w-full px-4 py-3 rounded-2xl border border-slate-200 text-sm leading-relaxed font-mono focus:outline-none focus:ring-2 focus:ring-[hsl(280_60%_60%)]" />
          </div>

          <div className="flex items-center justify-end gap-3">
            <button disabled={saveNote.isPending} onClick={() => saveNote.mutate({
              ccmTaskId: taskId, patientId: patientId!, ...responses, generatedNote,
              escalationFlag: escalate, escalationReason: escalate ? escalationReason : undefined,
              timeSpentMinutes: minutes, markCompleted: false,
            })} className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-2xl border border-slate-200 text-slate-700 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50">
              <Save size={15} /> Save Draft
            </button>
            <button disabled={saveNote.isPending} onClick={() => saveNote.mutate({
              ccmTaskId: taskId, patientId: patientId!, ...responses, generatedNote,
              escalationFlag: escalate, escalationReason: escalate ? escalationReason : undefined,
              timeSpentMinutes: minutes, markCompleted: true,
            })} className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-2xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 active:scale-[0.97] transition disabled:opacity-50">
              {saveNote.isPending ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Complete & Save
            </button>
          </div>
        </div>
      </div>
    </CCMDashboardLayout>
  );
}
